"""Media wire parity and upload/privacy behavior against a synthetic loopback receiver.

This suite is also copied outside the checkout and run against the installed wheel.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import time
from dataclasses import replace
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from threading import Lock
from types import SimpleNamespace
from typing import Any

import pytest
from opentelemetry._logs import LogRecord
from opentelemetry.sdk._logs import ReadWriteLogRecord
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import Event as SpanEvent
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SpanExportResult
from opentelemetry.sdk.util.instrumentation import InstrumentationScope
from opentelemetry.trace import Link, SpanContext, TraceFlags
from test_blobs import (
    KEY,
    attrs,
    blobs,
    client,
    eventually,
    listed,
    message_with_image,
    settled,
    sha256,
)
from test_blobs import hue_store as hue_store

from hue_sdk import Hue
from hue_sdk._blobs import (
    BlobUploader,
    ExplicitFile,
    Held,
    HeldValues,
    UploadGroup,
    Uploads,
    attach_held,
    held_of,
    held_size,
    put_seconds,
)
from hue_sdk._inline_files import (
    INLINE_FILE_TEXT_PER_RECORD,
    MAX_INLINE_FILE_TEXT,
    MediaDigestMemo,
    content_path,
    dumps_message,
    is_media_name,
    may_inline_files,
    utf16_size,
)
from hue_sdk._limits import cut_utf8
from hue_sdk._records import replace_span
from hue_sdk.evals import rehydrate_media
from hue_sdk.snapshots import Hold, _ValueBudget, snapshot_log, snapshot_span

ATTRIBUTE = "gen_ai.input.messages"


def assert_image_digest(message: str, data: bytes) -> None:
    part = json.loads(message)[0]["parts"][1]
    assert part == {
        "type": "blob",
        "modality": "image",
        "mime_type": "image/png",
        "sha256": sha256(data),
        "size": len(data),
    }


def external_span(**kwargs: Any) -> ReadableSpan:
    return ReadableSpan(
        name="external",
        context=SpanContext(1, 2, False, TraceFlags(TraceFlags.SAMPLED)),
        start_time=1,
        end_time=2,
        **kwargs,
    )


@pytest.fixture(scope="module")
def oversized_message() -> str:
    messages = json.loads(message_with_image(b"tiny"))
    messages[0]["parts"][0]["content"] = "é" * (MAX_INLINE_FILE_TEXT + 128 * 1024)
    value = json.dumps(messages, ensure_ascii=False)
    assert MAX_INLINE_FILE_TEXT < len(value) < len(value.encode("utf-8"))
    return value


@pytest.fixture
def uploads(hue_store):
    value = Uploads(hue_store.url, {"Authorization": f"Bearer {KEY}"}, 2)
    try:
        yield value
    finally:
        value.close()


def json_of(value: Any) -> Any:
    """An OTLP value as the JSON it carries (a kvlist as an object)."""
    kind = value.WhichOneof("value")
    if kind is None:
        return None
    if kind == "kvlist_value":
        return {item.key: json_of(item.value) for item in value.kvlist_value.values}
    if kind == "array_value":
        return [json_of(item) for item in value.array_value.values]
    return getattr(value, kind)


def corpus_text(case: dict[str, Any]) -> str:
    """A corpus case's attribute text: its raw ``value``, or its ``messages`` as JSON written as
    the TypeScript suite writes them (``JSON.stringify``), so both SDKs read the same bytes."""
    return case["value"] if "value" in case else dumps_message(case["messages"])


def entries(record: Any) -> list[str]:
    value = attrs(record).get("hue.blobs")
    return [item.string_value for item in value.array_value.values] if value else []


# ``failure``: uploads refused before export (a full upload queue), which keep the corpus'
# fallback forms; ``after_export``: uploads that fail after their record was exported (the
# reservation is refused), whose records keep the success forms and entries.
OUTCOMES = ["success", "failure", "after_export"]


def corpus_outcome(hue: Hue, hue_store: Any, outcome: str) -> str:
    """Sets the client and store up for ``outcome``; the corpus column its records match."""
    if outcome == "failure":
        assert hue._uploads is not None
        hue._uploads.uploader._queue_limit = 0
    elif outcome == "after_export":
        hue_store.reserve = lambda _: (409, {}, True)
    return "failure" if outcome == "failure" else "success"


@pytest.mark.parametrize("outcome", OUTCOMES)
def test_shared_media_wire_corpus(hue_store, outcome):
    cases = json.loads((Path(__file__).parent / "fixtures/media-parts/cases.json").read_text())[
        "fixtures"
    ]
    with client(hue_store, max_queue_size=512) as hue:
        column = corpus_outcome(hue, hue_store, outcome)
        for case in cases:
            with hue.span(case["id"]) as span:
                span.set_attribute(case["attribute"], corpus_text(case))
        assert hue.force_flush(timeout_millis=30_000)
        for case in cases:
            record = hue_store.span(case["id"])
            exported = attrs(record)[case["attribute"]].string_value
            if "value" in case:
                assert exported == case[column]["value"], case["id"]
            else:
                assert json.loads(exported) == case[column]["messages"], case["id"]
            assert entries(record) == case[column]["entries"], case["id"]
        expected = sum(len(case["success"]["entries"]) for case in cases)
        status = hue.export_status
        assert (status.uploaded_values, status.upload_fallbacks) == (
            (expected, 0) if outcome == "success" else (0, expected)
        )
    assert all(put["status"] == 200 for put in hue_store.puts)
    if outcome != "success":
        assert hue_store.puts == [] and hue_store.objects == {}
    if outcome == "failure":
        assert hue_store.reservations == []


@pytest.mark.parametrize("outcome", OUTCOMES)
def test_shared_log_media_wire_corpus(hue_store, outcome):
    cases = json.loads((Path(__file__).parent / "fixtures/media-parts/cases.json").read_text())[
        "logs"
    ]
    traces = {}
    with client(hue_store) as hue:
        column = corpus_outcome(hue, hue_store, outcome)
        for case in cases:
            with hue.span(case["id"]) as span:
                traces[case["id"]] = span.trace_id
                messages = {key: case[key] for key in ("input", "output") if key in case}
                span.log_inference(
                    **messages, operation="chat", provider="openai", model=case["id"]
                )
        assert hue.force_flush(timeout_millis=30_000)
        uploaded, fallbacks = hue._span_exporter.uploads
    expected = sum(len(case["success"]["entries"]) for case in cases)
    assert (uploaded, fallbacks) == ((expected, 0) if outcome == "success" else (0, expected))
    for case in cases:
        (log,) = [
            log
            for log in hue_store.logs
            if attrs(log)["gen_ai.request.model"].string_value == case["id"]
        ]
        assert log.trace_id.hex() == traces[case["id"]]
        assert json_of(log.body) == case[column]["body"], case["id"]
        assert entries(log) == case[column]["entries"], case["id"]
        assert entries(hue_store.span(case["id"])) == []
        # Each file's bytes are stored under the log record's own trace.
        for entry in case[column]["entries"] if outcome == "success" else ():
            digest = json.loads(entry)["sha256"]
            assert sha256(hue_store.objects[f"{traces[case['id']]}/{digest}"][0]) == digest
    if outcome != "success":
        assert hue_store.puts == [] and hue_store.objects == {}
    if outcome == "failure":
        assert hue_store.reservations == []


def test_a_resolved_text_file_over_64_kib_records_again_as_the_same_file(hue_store):
    notes = b"Quarterly notes, line 1\n" * 3000
    digest = sha256(notes)
    recorded = [
        {
            "role": "user",
            "parts": [
                {
                    "type": "blob",
                    "mime_type": "text/plain",
                    "name": "notes.txt",
                    "sha256": digest,
                    "size": 72_000,
                }
            ],
        }
    ]
    # The bytes are written back as Hue and the GenAI conventions read a ``blob`` part: base64.
    resolved = rehydrate_media(recorded, [SimpleNamespace(sha256=digest, data=notes)])
    assert resolved.failures == []
    assert resolved.value[0]["parts"][0]["content"] == base64.b64encode(notes).decode()
    with client(hue_store) as hue:
        with hue.span("resolved again") as span:
            span.set_attribute(ATTRIBUTE, json.dumps(resolved.value))
        assert hue.force_flush()
        status = hue.export_status
        assert (status.uploaded_values, status.upload_fallbacks) == (1, 0)
    record = hue_store.span("resolved again")
    assert json.loads(attrs(record)[ATTRIBUTE].string_value) == recorded
    assert blobs(record) == [
        {
            "key": f"{ATTRIBUTE}#/0/parts/0",
            "sha256": digest,
            "size": 72_000,
            "content_type": "text/plain",
            "name": "notes.txt",
        }
    ]
    assert [data for data, _ in hue_store.objects.values()] == [notes]


def test_metadata_only_inspects_and_uploads_nothing(hue_store):
    url = "data:image/png;base64," + base64.b64encode(b"metadata-only image").decode()
    with Hue(hue_store.url, KEY, capture_content=False, live_spans=False) as hue:
        with hue.span("metadata only") as span:
            span.set_attribute("metadata", url)
            span.set_attribute("input.value", json.dumps({"image": url}))
            span.log_inference(input=[{"role": "user", "content": url}])
        assert hue.force_flush()
    record = hue_store.span("metadata only")
    assert attrs(record)["metadata"].string_value == url
    assert "input.value" not in attrs(record)
    assert entries(record) == []
    assert hue_store.logs == []
    assert hue_store.reservations == []


def test_value_past_the_inspection_limit_has_its_media_read_in_place(hue_store):
    image = bytes(6 * 1024 * 1024 + 1)
    url = "data:image/png;base64," + base64.b64encode(image).decode()
    with client(hue_store) as hue:
        with hue.span("over inspection") as span:
            span.set_attribute("input.value", json.dumps({"image": url}))
        assert hue.force_flush(timeout_millis=30_000)
    record = hue_store.span("over inspection")
    # Over 8 Mi code units of text: its image is read in place and uploaded as a file, where
    # 0.11.1 uploaded the whole value as text.
    assert [(entry["key"], entry["content_type"]) for entry in blobs(record)] == [
        ("input.value#/image", "image/png")
    ]
    assert json.loads(attrs(record)["input.value"].string_value) == {
        "image": {
            "type": "blob",
            "mime_type": "image/png",
            "modality": "image",
            "sha256": sha256(image),
            "size": len(image),
        }
    }
    assert listed(record) == []


def test_deprecated_genai_event_keys_its_message_parts_from_the_body(hue_store):
    data = b"deprecated event image"
    url = "data:image/png;base64," + base64.b64encode(data).decode()
    with client(hue_store) as hue:
        with hue.span("event"):
            hue._logger.emit(
                event_name="gen_ai.user.message",
                body={
                    "content": [
                        {"type": "text", "text": "Look."},
                        {"type": "image_url", "image_url": {"url": url}},
                    ]
                },
            )
        assert hue.force_flush()
    (log,) = hue_store.logs
    assert json_of(log.body) == {
        "content": [
            {"type": "text", "text": "Look."},
            {"type": "image_url", "image_url": {}, "sha256": sha256(data), "size": len(data)},
        ]
    }
    assert [entry["key"] for entry in blobs(log)] == ["body#/content/1"]


def test_a_log_bodys_file_the_queue_cut_is_exported_cut_and_never_uploaded(hue_store):
    """Over the per-attribute inspection limit, the base64 is not held whole: the queue cuts it,
    and its cut (a multiple of four characters) still reads as base64, which must not upload."""
    data = "A" * (8 * 1024 * 1024 + 4)
    with client(hue_store) as hue:
        with hue.span("cut log body"):
            hue._logger.emit(
                event_name="gen_ai.user.message",
                body={
                    "content": [
                        {
                            "type": "image",
                            "source": {"type": "base64", "media_type": "image/png", "data": data},
                        }
                    ]
                },
            )
        assert hue.force_flush(timeout_millis=30_000)
        status = hue.export_status
    (log,) = hue_store.logs
    # Cut, the body is still over the value limit: it is replaced by the receiver's marker, as
    # before log records uploaded, and nothing of the image is stored or listed.
    assert "sha256" not in json.dumps(json_of(log.body))
    assert listed(log) == ["body"]
    assert blobs(log) == []
    assert hue_store.reservations == []
    assert status.uploaded_values == 0


def test_inference_log_over_the_cap_is_recorded_when_its_files_account_for_it(hue_store):
    image = os.urandom(2 * 1024 * 1024)
    part = {"type": "blob", "mime_type": "image/png", "content": base64.b64encode(image).decode()}
    with client(hue_store) as hue:
        with hue.span("large inference log") as span:
            span.log_inference(input=[{"role": "user", "parts": [part]}])
            # Text past the cap with no file to upload is omitted, as before.
            span.log_inference(input=[{"role": "user", "content": "t" * (2 * 1024 * 1024)}])
        hue.force_flush(timeout_millis=30_000)
        assert hue.export_status.instrumentation_failures == 1
    (log,) = hue_store.logs
    assert json_of(log.body) == {
        "gen_ai.input.messages": [
            {
                "role": "user",
                "parts": [
                    {
                        "type": "blob",
                        "mime_type": "image/png",
                        "sha256": sha256(image),
                        "size": len(image),
                    }
                ],
            }
        ]
    }
    assert [entry["key"] for entry in blobs(log)] == ["body#/gen_ai.input.messages/0/parts/0"]
    assert listed(log) == []


def test_explicit_upload_preserves_event_and_uses_exact_entry(hue_store):
    data = b"synthetic explicit file"
    name = "資料-🎧.pdf"
    digest = sha256(data)
    with client(hue_store) as hue:
        uploads = hue._uploads
        assert uploads is not None
        with hue.span("default") as span:
            span.record_file(role="input", media_type="application/pdf", data=data)
        assert hue.force_flush()
        assert uploads.memo._entries == {}
        assert hue_store.reservations == []
        with hue.span("explicit") as span:
            trace_id = span.trace_id
            span.record_file(
                role="output", media_type="application/pdf", data=data, name=name, upload=True
            )
        assert hue.force_flush()
        assert hue.export_status.uploaded_values == 1
        assert uploads.held.held == 0
        assert uploads.uploader._jobs == {}
    record = hue_store.span("explicit")
    assert entries(record) == [
        json.dumps(
            {
                "key": f"event:hue.file:{digest}",
                "sha256": digest,
                "size": len(data),
                "content_type": "application/pdf",
                "name": name,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
    ]
    assert len(record.events) == 1 and record.events[0].name == "hue.file"
    event = attrs(record.events[0])
    assert event["hue.file.sha256"].string_value == digest
    assert event["hue.file.size"].int_value == len(data)
    assert event["hue.file.name"].string_value == name
    assert hue_store.objects[f"{trace_id}/{digest}"] == (data, "application/pdf")
    assert len(hue_store.reservations) == len(hue_store.puts) == len(hue_store.completions) == 1
    assert uploads.memo._entries == uploads.uploader._jobs == {}
    assert not uploads.uploader._stored


def test_media_and_explicit_files_share_trace_digest_and_reservation(hue_store, monkeypatch):
    data = b"synthetic repeated media"
    digest = sha256(data)
    import hue_sdk._inline_files as inline

    original = hashlib.sha256
    calls = []

    def counted(value=b"", *args, **kwargs):
        if value == data:
            calls.append(value)
        return original(value, *args, **kwargs)

    with client(hue_store) as hue:
        with hue.span("parent"):
            with hue.span("media") as span:
                span.set_attribute(ATTRIBUTE, message_with_image(data))
            assert hue.force_flush()
            monkeypatch.setattr(inline.hashlib, "sha256", counted)
            with hue.span("file") as span:
                span.record_file(role="input", media_type="image/png", data=data, upload=True)
            assert hue.force_flush()
            with hue.span("media again") as span:
                span.set_attribute(ATTRIBUTE, message_with_image(data))
            assert hue.force_flush()
            assert len(calls) == 2
            monkeypatch.setattr(inline.hashlib, "sha256", original)
        with hue.span("other trace") as span:
            span.record_file(role="input", media_type="image/png", data=data, upload=True)
        assert hue.force_flush()
    assert len(hue_store.reservations) == len(hue_store.puts) == 2
    assert blobs(hue_store.span("file"))[0]["sha256"] == digest
    assert blobs(hue_store.span("media again"))[0]["sha256"] == digest


def test_failed_media_outcome_is_evicted_for_explicit_retry(hue_store):
    data = b"synthetic refused media"
    hue_store.reserve = lambda _: (409, {}, True)
    with client(hue_store) as hue:
        with hue.span("parent"):
            with hue.span("media") as span:
                span.set_attribute(ATTRIBUTE, message_with_image(data))
            assert hue.force_flush()
            with hue.span("file") as span:
                span.record_file(role="input", media_type="image/png", data=data, upload=True)
            assert hue.force_flush()
        assert hue.force_flush()
        assert hue.export_status.upload_fallbacks == 2
    # The failed identity is forgotten, so the file's reference reserves the same bytes again.
    assert len(hue_store.reservations) == 2
    assert hue_store.puts == []
    # Each record carries the entry it was exported with; Hue reads both as missing.
    assert [entry["sha256"] for entry in blobs(hue_store.span("media"))] == [sha256(data)]
    assert [entry["sha256"] for entry in blobs(hue_store.span("file"))] == [sha256(data)]
    assert len(hue_store.span("file").events) == 1


def test_a_pending_upload_is_shared_and_stored_identities_are_bounded_and_cleared(
    hue_store, monkeypatch
):
    import hue_sdk._blobs as blob_module

    uploader = BlobUploader(hue_store.url, {"Authorization": f"Bearer {KEY}"}, 2)
    hue_store.put = lambda _: "gate"
    data = b"synthetic concurrent media"
    trace = "1" * 32
    digest = (sha256(data), len(data))
    group = UploadGroup()
    first = uploader.submit(trace, "first", data, "image/png", digest, group)
    assert eventually(lambda: hue_store.puts, 5)
    # A second reference while the first is held at the store shares its upload.
    second = uploader.submit(trace, "second", data, "image/png", digest, group)
    assert first.ok and second.ok
    assert len(uploader._jobs) == 1
    hue_store.gate.set()
    assert uploader.wait_idle(time.monotonic() + 10)
    assert len(hue_store.reservations) == len(hue_store.puts) == 1
    assert list(uploader._stored) == [(trace, digest[0])]
    hue_store.put = lambda _: 200
    monkeypatch.setattr(blob_module, "_STORED_LIMIT", 2)
    for index in range(4):
        value = str(index).encode()
        assert uploader.submit(
            trace, "next", value, "image/png", (sha256(value), len(value)), group
        ).ok
        assert uploader.wait_idle(time.monotonic() + 10)
        assert len(uploader._stored) <= 2
    uploader.close()
    assert uploader._jobs == {} and not uploader._queue and not uploader._stored


def test_digest_cache_is_trace_scoped_and_retains_only_digest_keys(monkeypatch):
    import hue_sdk._inline_files as inline

    original = hashlib.sha256
    calls = []

    def counted(value):
        calls.append(value)
        return original(value)

    monkeypatch.setattr(inline.hashlib, "sha256", counted)
    memo = MediaDigestMemo(limit=512, capacity=2)
    assert memo.digest(b"one", "a") == memo.digest(b"one", "a")
    memo.digest(b"one", "b")
    assert len(calls) == 3
    assert set(memo._entries) == {("a", sha256(b"one")), ("b", sha256(b"one"))}
    for index in range(8):
        memo.digest(str(index).encode(), "a")
        assert memo._size <= memo.limit and len(memo._entries) <= memo.capacity
    memo.digest(b"x" * 1024, "a")
    assert all(
        isinstance(trace, str) and isinstance(digest, str) and len(digest) == 64
        for trace, digest in memo._entries
    )
    assert all(
        isinstance(digest, str) and isinstance(size, int) for digest, size in memo._entries.values()
    )
    memo.clear()
    assert memo._entries == {} and memo._size == 0


@pytest.mark.parametrize("capture,credential", [(False, KEY), (True, "hue_setup_synthetic")])
def test_disabled_capture_and_setup_never_upload(hue_store, capture, credential):
    data = b"private media bytes"
    with Hue(hue_store.url, credential, capture_content=capture, live_spans=False) as hue:
        with hue.span("private") as span:
            span.set_attribute(ATTRIBUTE, message_with_image(data))
            span.record_file(
                role="input", media_type="image/png", data=data, name="private.png", upload=True
            )
        assert hue.force_flush()
        assert hue._uploads is None
    assert hue_store.reservations == hue_store.puts == []
    assert entries(hue_store.span("private")) == []
    events = hue_store.span("private").events
    assert len(events) == 1 and events[0].name == "hue.file"
    if not capture:
        assert ATTRIBUTE not in attrs(hue_store.span("private"))
        assert "hue.file.name" not in attrs(events[0])


def test_own_inspected_attributes_and_correlated_logs_upload(hue_store):
    data = b"private nested provider media"
    message = message_with_image(data)
    provider = TracerProvider(
        resource=Resource.create({ATTRIBUTE: message}), shutdown_on_exit=False
    )
    context = SpanContext(1, 2, False, TraceFlags(TraceFlags.SAMPLED))
    try:
        with client(hue_store, tracer_provider=provider) as hue:
            with hue.span("ownership") as span:
                trace_id = span.trace_id
                span.set_attribute("custom.message", message)
                span.otel_span.add_event("provider.event", {ATTRIBUTE: message})
                span.otel_span.add_link(context, {ATTRIBUTE: message})
                span.log_inference(input=json.loads(message))
                hue._logger.emit(body=message, attributes={ATTRIBUTE: message})
            assert hue.force_flush()
        record = hue_store.span("ownership")
        # A span's attribute Hue reads no files from, its events, links and resource keep their
        # media as recorded.
        assert attrs(record)["custom.message"].string_value == message
        assert attrs(record.events[0])[ATTRIBUTE].string_value == message
        assert attrs(record.links[0])[ATTRIBUTE].string_value == message
        assert entries(record) == []
        assert len(hue_store.logs) == 2
        # A correlated log record's inspected attribute uploads its file under the log's trace;
        # its body, JSON text rather than a structure, stays as recorded.
        (emitted,) = [log for log in hue_store.logs if log.body.string_value == message]
        assert_image_digest(attrs(emitted)[ATTRIBUTE].string_value, data)
        assert [entry["key"] for entry in blobs(emitted)] == [f"{ATTRIBUTE}#/0/parts/1"]
        # The inference log's structured body uploads its file, keyed into the body.
        (inference,) = [log for log in hue_store.logs if log is not emitted]
        assert json_of(inference.body)[ATTRIBUTE][0]["parts"][1] == {
            "type": "blob",
            "modality": "image",
            "mime_type": "image/png",
            "sha256": sha256(data),
            "size": len(data),
        }
        assert [entry["key"] for entry in blobs(inference)] == [f"body#/{ATTRIBUTE}/0/parts/1"]
        assert {inference.trace_id.hex(), emitted.trace_id.hex()} == {trace_id}
        assert set(hue_store.objects) == {f"{trace_id}/{sha256(data)}"}
    finally:
        provider.shutdown()


def test_explicit_upload_missing_bytes_mismatch_and_64_entry_limit(hue_store):
    with client(hue_store, export_timeout_seconds=60) as hue:
        with hue.span("invalid") as span:
            span.record_file(role="input", media_type="image/png", sha256="0" * 64, upload=True)
            span.record_file(
                role="input", media_type="image/png", data=b"x", byte_size=2, upload=True
            )
            for index in range(65):
                span.record_file(
                    role="output", media_type="image/png", data=str(index).encode(), upload=True
                )
        assert not hue.force_flush(timeout_millis=60_000)
        assert hue.export_status.instrumentation_failures == 3
    record = hue_store.span("invalid")
    assert len(entries(record)) == 64
    assert len([event for event in record.events if event.name == "hue.file"]) == 66
    assert len(hue_store.reservations) == 64


@pytest.mark.parametrize("mime", ["text/plain", "application/yaml", "application/x-yaml"])
def test_declared_text_stays_utf8_and_decoded_threshold_controls_upload(hue_store, mime):
    small = [{"parts": [{"type": "blob", "mime_type": mime, "content": "YWJj"}]}]
    at_limit = b"a" * (64 * 1024)
    over_limit = at_limit + b"z"
    with client(hue_store) as hue:
        for name, data in (("limit", at_limit), ("over", over_limit)):
            messages = [
                {
                    "parts": [
                        {
                            "type": "blob",
                            "content": f"data:{mime};base64,{base64.b64encode(data).decode()}",
                        }
                    ]
                }
            ]
            with hue.span(name) as span:
                span.set_attribute(ATTRIBUTE, json.dumps(messages))
        with hue.span("raw") as span:
            span.set_attribute(ATTRIBUTE, json.dumps(small))
        assert hue.force_flush()
    assert entries(hue_store.span("limit")) == entries(hue_store.span("raw")) == []
    assert json.loads(attrs(hue_store.span("raw"))[ATTRIBUTE].string_value) == small
    entry = blobs(hue_store.span("over"))[0]
    assert entry["key"] == f"{ATTRIBUTE}#/0/parts/0/content"
    assert entry["size"] == len(over_limit) and entry["content_type"] == mime
    part = json.loads(attrs(hue_store.span("over"))[ATTRIBUTE].string_value)[0]["parts"][0]
    assert len(part["content"].encode()) == 16 * 1024
    assert len(hue_store.reservations) == 1


def test_unicode_names_and_conservative_media_prefilter():
    assert is_media_name("🎧" * 128) and is_media_name("é" * 256)
    assert is_media_name("bad\x85")
    assert is_media_name("\x85")
    assert not is_media_name("\ufeff")
    for name in ("", " ", "🎧" * 129, "é" * 257, "bad\x00", "bad\x7f", "bad\ud800"):
        assert not is_media_name(name)
    for marker in (
        "blob",
        "file",
        "image",
        "input_audio",
        "media",
        "inlineData",
        "inline_data",
        "document",
        "\\u",
    ):
        assert may_inline_files(ATTRIBUTE, f'{{"{marker}":{{}}}}')
    assert not may_inline_files(ATTRIBUTE, '[{"role":"user","content":"hello"}]')
    assert not may_inline_files("event:messages", '{"type":"blob"}')


def test_escaped_provider_type_is_inspected_from_recorded_json(hue_store):
    message = (
        '[{"parts":[{"type":"\\u0062\\u006c\\u006f\\u0062",'
        '"mime_type":"application/octet-stream","content":"eA=="}]}]'
    )
    with client(hue_store) as hue:
        with hue.span("escaped") as span:
            span.set_attribute(ATTRIBUTE, message)
        assert hue.force_flush()
    part = json.loads(attrs(hue_store.span("escaped"))[ATTRIBUTE].string_value)[0]["parts"][0]
    assert part == {
        "type": "blob",
        "mime_type": "application/octet-stream",
        "sha256": sha256(b"x"),
        "size": 1,
    }
    assert len(hue_store.reservations) == 1


def test_content_path_describes_nested_provider_metadata():
    part = {
        "type": "document",
        "title": "資料.pdf",
        "source": {"type": "base64", "media_type": "application/pdf", "data": "eA=="},
    }
    file = content_path(part, "/0/content/1")
    assert file is not None
    assert file.part is part and file.owner is part["source"]
    assert file.key == "data" and file.content == "eA==" and file.base64
    assert file.pointer == "/0/content/1/source/data" and file.part_pointer == "/0/content/1"
    assert file.content_type == "application/pdf" and file.name == "資料.pdf"


def test_media_inspection_budget_allows_two_six_mib_message_attributes():
    message = json.dumps([{"parts": [{"type": "blob", "content": "YQ==" * (1536 * 1024)}]}])
    budget = _ValueBudget()
    copied = budget.permitted(
        {ATTRIBUTE: message, "gen_ai.output.messages": message, "ai.prompt.messages": message},
        files=True,
    )
    for key in (ATTRIBUTE, "gen_ai.output.messages"):
        assert json.loads(copied[key])[0]["parts"][0]["size"] > 64 * 1024
    assert bool(copied["ai.prompt.messages"] is message)
    assert budget.media_remaining == INLINE_FILE_TEXT_PER_RECORD - 2 * len(message.encode())


@pytest.mark.parametrize("skip", ["value", "record"])
def test_media_inspection_skip_preserves_original_and_state(uploads, oversized_message, skip):
    message = oversized_message if skip == "value" else message_with_image(b"small")
    budget = _ValueBudget(hold=Hold(uploads.held, 128, uploads=uploads), trace_id="1" * 32)
    if skip == "record":
        budget.media_remaining = 0
    budget.held.digests[ATTRIBUTE] = {"/existing": (sha256(b"existing"), 8)}
    uploads.memo.digest(b"existing", budget.trace_id)
    receipts = {key: dict(value) for key, value in budget.held.digests.items()}
    memo = list(uploads.memo._entries.items()), uploads.memo._size
    allowance = budget.media_remaining
    copied, files = budget._media(ATTRIBUTE, message)
    assert bool(copied is message)
    assert files == 0 and budget.media_remaining == allowance
    assert budget.held.digests == receipts
    assert (list(uploads.memo._entries.items()), uploads.memo._size) == memo


@pytest.mark.parametrize("skip", ["value", "record"])
def test_media_inspection_skip_holds_original_and_charges_size(oversized_message, skip):
    message = oversized_message if skip == "value" else message_with_image(b"small")
    held_budget = HeldValues()
    budget = _ValueBudget(value_bytes=128, hold=Hold(held_budget, 128))
    if skip == "record":
        budget.media_remaining = 0
    allowance = budget.media_remaining
    try:
        budget.copied_attributes({ATTRIBUTE: message}, own=True)
        assert budget.held.values[ATTRIBUTE] is message
        assert budget.held.size == held_budget.held == held_size(message)
        assert budget.held.digests == {} and budget.held.cut == budget.truncated == []
        assert budget.media_remaining == allowance
    finally:
        budget.held.release()
    assert held_budget.held == 0


@pytest.mark.parametrize("skip", ["value", "record"])
@pytest.mark.parametrize("unavailable", ["inactive", "rejected"])
def test_media_inspection_skip_cuts_once_when_hold_unavailable(
    oversized_message, skip, unavailable
):
    message = oversized_message if skip == "value" else message_with_image(b"small")
    held_budget = HeldValues(limit=128)
    if unavailable == "rejected":
        assert held_budget.reserve(128)
    charged = held_budget.held
    budget = _ValueBudget(
        value_bytes=128, hold=Hold(held_budget, 128, active=unavailable != "inactive")
    )
    if skip == "record":
        budget.media_remaining = 0
    copied = budget.copied_attributes({ATTRIBUTE: message}, own=True)
    assert copied[ATTRIBUTE] == cut_utf8(message, 128)
    assert budget.truncated == budget.held.cut == [ATTRIBUTE]
    assert budget.held.values == budget.held.digests == {} and budget.held.size == 0
    assert held_budget.held == charged


def test_oversized_media_uploads_whole_original_utf8(hue_store, oversized_message):
    data = oversized_message.encode("utf-8")
    digest = sha256(data)
    with client(hue_store) as hue:
        with hue.span("oversized") as span:
            trace_id = span.trace_id
            span.set_attribute(ATTRIBUTE, oversized_message)
        assert hue.force_flush(timeout_millis=30_000)
        assert hue.export_status.ok and hue.export_status.uploaded_values == 1
        assert hue.export_status.upload_fallbacks == 0
        assert hue._uploads.held.held == 0
    assert hue_store.objects[f"{trace_id}/{digest}"] == (data, "application/json")
    assert blobs(hue_store.span("oversized")) == [
        {"key": ATTRIBUTE, "sha256": digest, "size": len(data), "content_type": "application/json"}
    ]
    assert len(hue_store.reservations) == len(hue_store.puts) == len(hue_store.completions) == 1
    request = hue_store.reservations[0]
    assert request["sha256"] == digest and request["byteSize"] == len(data)
    assert hue_store.completions[0] == {"traceId": trace_id, "sha256": digest}
    assert hue_store.puts[0]["status"] == 200 and hue_store.puts[0]["bytes"] == len(data)


def test_oversized_media_refusal_acknowledges_one_fallback(hue_store, oversized_message):
    with client(hue_store) as hue:
        # Refused before export: the upload queue is full.
        hue._uploads.uploader._queue_limit = 0
        with hue.span("refused oversized") as span:
            span.set_attribute(ATTRIBUTE, oversized_message)
        assert hue.force_flush(timeout_millis=30_000)
        assert hue.export_status.ok and hue.export_status.upload_fallbacks == 1
        assert hue.export_status.uploaded_values == 0
        assert hue._uploads.held.held == 0
    record = hue_store.span("refused oversized")
    assert bool(attrs(record)[ATTRIBUTE].string_value == cut_utf8(oversized_message, 1024 * 1024))
    assert listed(record) == [ATTRIBUTE] and entries(record) == []
    assert hue_store.reservations == hue_store.puts == hue_store.completions == []


def test_oversized_media_refused_after_export_acknowledges_one_fallback(
    hue_store, oversized_message
):
    hue_store.reserve = lambda _: (409, {}, True)
    with client(hue_store) as hue:
        with hue.span("refused oversized") as span:
            span.set_attribute(ATTRIBUTE, oversized_message)
        assert hue.force_flush(timeout_millis=30_000)
        assert hue.export_status.ok and hue.export_status.upload_fallbacks == 1
        assert hue.export_status.uploaded_values == 0
        assert hue._uploads.held.held == 0
    record = hue_store.span("refused oversized")
    # Listed when exported: its 16 KiB prefix and its entry, which Hue reads as missing.
    assert bool(attrs(record)[ATTRIBUTE].string_value == cut_utf8(oversized_message, 16 * 1024))
    assert listed(record) == [ATTRIBUTE]
    assert [entry["sha256"] for entry in blobs(record)] == [sha256(oversized_message)]
    assert len(hue_store.reservations) == 1
    assert hue_store.puts == hue_store.completions == []


@pytest.mark.parametrize("location", ["resource", "event", "link", "log"])
def test_nested_media_uses_ordinary_value_and_record_admission(
    hue_store, uploads, monkeypatch, location
):
    import hue_sdk.snapshots as snapshots

    data = b"nested admission" * 512
    message = message_with_image(data)
    assert len(message.encode()) > 4096
    inspected = []
    original = snapshots.hash_inline_files_counted

    def inspect(key, value, memo=None, receipts=None, trace_id="", **kwargs):
        inspected.append((memo, receipts))
        return original(key, value, memo, receipts, trace_id, **kwargs)

    monkeypatch.setattr(snapshots, "hash_inline_files_counted", inspect)
    options = {
        "value_bytes": 512,
        "record_bytes": 4096,
        "hold": Hold(uploads.held, 512, uploads=uploads),
    }
    if location == "log":
        copied = snapshot_log(
            ReadWriteLogRecord(
                LogRecord(body="body", attributes={ATTRIBUTE: message}), Resource({})
            ),
            **options,
        )
        value = copied.log_record.attributes[ATTRIBUTE]
        assert copied.log_record.attributes["hue.truncated"] == (ATTRIBUTE,)
        assert copied.dropped_attributes == 0
    else:
        context = SpanContext(1, 3, False, TraceFlags(TraceFlags.SAMPLED))
        fields = {
            "resource": {"resource": Resource({ATTRIBUTE: message})},
            "event": {"events": (SpanEvent("provider.event", {ATTRIBUTE: message}, 1),)},
            "link": {"links": (Link(context, {ATTRIBUTE: message}),)},
        }
        copied = snapshot_span(external_span(**fields[location]), **options)
        assert copied.dropped_events == copied.dropped_links == 0
        assert copied.attributes["hue.truncated"] == (
            {"resource": "resource.", "event": "event:provider.event:", "link": "link:"}[location]
            + ATTRIBUTE,
        )
        if location == "resource":
            value = copied.resource.attributes[ATTRIBUTE]
        else:
            items = copied.events if location == "event" else copied.links
            assert len(items) == 1
            value = items[0].attributes[ATTRIBUTE]
    assert value == cut_utf8(message, 512)
    assert inspected == [(None, None)]
    assert held_of(copied) is None and uploads.held.held == 0
    assert uploads.memo._entries == {} and uploads.memo._size == 0
    assert "hue.blobs" not in (
        copied.log_record.attributes if location == "log" else copied.attributes
    )
    assert hue_store.reservations == hue_store.puts == hue_store.completions == []


def test_stateless_media_inspection_preserves_own_receipts_and_memo(uploads):
    budget = _ValueBudget(hold=Hold(uploads.held, 1024, uploads=uploads), trace_id="1" * 32)
    own = message_with_image(b"own bytes")
    try:
        budget.copied_attributes({ATTRIBUTE: own}, own=True)
        uploads.memo.digest(b"older memo entry", budget.trace_id)
        receipts = {key: dict(value) for key, value in budget.held.digests.items()}
        memo = list(uploads.memo._entries.items()), uploads.memo._size
        for data in (b"resource bytes", b"event bytes of another size", b"link", b"x" * 65537):
            message = message_with_image(data)
            copied = budget.permitted({ATTRIBUTE: message}, files=True, nested=True)
            if len(data) <= 65536:
                assert copied[ATTRIBUTE] == message
            else:
                assert_image_digest(copied[ATTRIBUTE], data)
            assert budget.held.digests == receipts
            assert (list(uploads.memo._entries.items()), uploads.memo._size) == memo
    finally:
        budget.held.release()


def test_identical_nested_media_never_calls_upload_memo(uploads, monkeypatch):
    import hue_sdk.snapshots as snapshots

    data = b"same bytes" * 8192
    message = message_with_image(data)
    budget = _ValueBudget(hold=Hold(uploads.held, 1024, uploads=uploads), trace_id="1" * 32)
    try:
        budget.copied_attributes({ATTRIBUTE: message}, own=True)
        calls, inspected = [], []
        original_digest = uploads.memo.digest
        original_inspect = snapshots.hash_inline_files_counted

        def digest(*args):
            calls.append(args)
            return original_digest(*args)

        def inspect(key, value, memo=None, receipts=None, trace_id="", **kwargs):
            inspected.append((memo, receipts))
            return original_inspect(key, value, memo, receipts, trace_id, **kwargs)

        monkeypatch.setattr(uploads.memo, "digest", digest)
        monkeypatch.setattr(snapshots, "hash_inline_files_counted", inspect)
        copied = budget.permitted({ATTRIBUTE: message}, files=True, nested=True)
        assert_image_digest(copied[ATTRIBUTE], data)
        assert calls == []
        assert inspected == [(None, None)]
    finally:
        budget.held.release()


def test_nested_media_same_pointer_preserves_own_upload(hue_store, monkeypatch):
    data = b"own media receipt"
    provider = TracerProvider(
        resource=Resource({ATTRIBUTE: message_with_image(b"different resource bytes")}),
        shutdown_on_exit=False,
    )
    observations = []
    original = _ValueBudget.resource

    def resource(budget, value):
        receipts = {key: dict(item) for key, item in budget.held.digests.items()}
        memo = budget.hold.uploads.memo if budget.hold and budget.hold.uploads else None
        before = (list(memo._entries.items()), memo._size) if memo else None
        copied = original(budget, value)
        if receipts:
            observations.append((receipts, before, copied.attributes[ATTRIBUTE]))
        return copied

    monkeypatch.setattr(_ValueBudget, "resource", resource)
    try:
        with client(hue_store, tracer_provider=provider) as hue:
            snapshots = []
            processor_type = type(hue._span_processor)
            original_copy = processor_type._copy

            def copy_span(*args, **kwargs):
                copied = original_copy(*args, **kwargs)
                if held_of(copied):
                    held = held_of(copied)
                    memo = hue._uploads.memo
                    snapshots.append(
                        (dict(held.digests[ATTRIBUTE]), list(memo._entries.items()), memo._size)
                    )
                return copied

            monkeypatch.setattr(processor_type, "_copy", staticmethod(copy_span))
            with hue.span("collision") as span:
                trace_id = span.trace_id
                span.set_attribute(ATTRIBUTE, message_with_image(data))
                span.otel_span.add_event(
                    "provider.event", {ATTRIBUTE: message_with_image(b"different event")}
                )
                span.otel_span.add_link(
                    SpanContext(1, 3, False), {ATTRIBUTE: message_with_image(b"link")}
                )
            assert hue.force_flush()
        assert len(observations) == len(snapshots) == 1
        receipts, before, resource_value = observations[0]
        assert receipts[ATTRIBUTE] == {"/0/parts/1/content": (sha256(data), len(data))}
        assert snapshots[0] == (receipts[ATTRIBUTE], *before)
        assert resource_value == message_with_image(b"different resource bytes")
        record = hue_store.span("collision")
        assert attrs(record.events[0])[ATTRIBUTE].string_value == message_with_image(
            b"different event"
        )
        assert attrs(record.links[0])[ATTRIBUTE].string_value == message_with_image(b"link")
        assert blobs(record) == [
            {
                "key": f"{ATTRIBUTE}#/0/parts/1",
                "sha256": sha256(data),
                "size": len(data),
                "content_type": "image/png",
            }
        ]
        assert hue_store.objects[f"{trace_id}/{sha256(data)}"] == (data, "image/png")
        assert len(hue_store.reservations) == len(hue_store.puts) == len(hue_store.completions) == 1
        assert hue_store.completions[0] == {"traceId": trace_id, "sha256": sha256(data)}
        assert hue_store.reservations[0]["sha256"] == sha256(data)
        assert hue_store.reservations[0]["byteSize"] == len(data)
        assert hue_store.puts[0]["status"] == 200 and hue_store.puts[0]["bytes"] == len(data)
    finally:
        provider.shutdown()


def test_capture_off_filters_own_nested_and_log_media_before_inspection(uploads, monkeypatch):
    import hue_sdk.snapshots as snapshots

    message = message_with_image(b"filtered content")
    calls = []

    def forbidden(*args, **kwargs):
        calls.append(args)
        raise AssertionError("Filtered media reached inspection")

    monkeypatch.setattr(snapshots, "hash_inline_files_counted", forbidden)
    hold = Hold(uploads.held, 128, uploads=uploads)
    context = SpanContext(1, 3, False)
    copied = snapshot_span(
        external_span(
            attributes={ATTRIBUTE: message, "metadata": "kept"},
            resource=Resource({ATTRIBUTE: message}),
            events=(SpanEvent("provider.event", {ATTRIBUTE: message}, 1),),
            links=(Link(context, {ATTRIBUTE: message}),),
        ),
        capture_content=False,
        hold=hold,
    )
    log = snapshot_log(
        ReadWriteLogRecord(
            LogRecord(body=message, attributes={ATTRIBUTE: message}), Resource({ATTRIBUTE: message})
        ),
        capture_content=False,
        hold=hold,
    )
    assert dict(copied.attributes) == {"metadata": "kept"}
    assert ATTRIBUTE not in copied.resource.attributes
    assert all(ATTRIBUTE not in item.attributes for item in (*copied.events, *copied.links))
    assert log.log_record.body is None
    assert ATTRIBUTE not in log.log_record.attributes and ATTRIBUTE not in log.resource.attributes
    assert calls == [] and held_of(copied) is held_of(log) is None
    assert uploads.memo._entries == {} and uploads.memo._size == uploads.held.held == 0


@pytest.mark.parametrize("record", ["span", "log"])
def test_scope_media_and_log_body_keep_ordinary_copying(record):
    message = message_with_image(b"ordinary copying" * 128)
    scope = InstrumentationScope("provider", attributes={ATTRIBUTE: message})
    if record == "span":
        copied = snapshot_span(external_span(instrumentation_scope=scope), value_bytes=128)
    else:
        copied = snapshot_log(
            ReadWriteLogRecord(LogRecord(body=message), Resource({}), scope), value_bytes=128
        )
        assert copied.log_record.body == cut_utf8(message, 128)
        assert copied.log_record.attributes["hue.truncated"] == ("body",)
    assert copied.instrumentation_scope.attributes[ATTRIBUTE] is message
    assert copied.instrumentation_scope is not scope


def test_shared_media_corpus_admission_without_hold():
    cases = json.loads((Path(__file__).parent / "fixtures/media-parts/cases.json").read_text())[
        "fixtures"
    ]
    for case in cases:
        copied = snapshot_span(external_span(attributes={case["attribute"]: corpus_text(case)}))
        if "value" in case:
            assert copied.attributes[case["attribute"]] == case["failure"]["value"], case["id"]
        else:
            assert (
                json.loads(copied.attributes[case["attribute"]]) == case["failure"]["messages"]
            ), case["id"]
        assert "hue.blobs" not in copied.attributes, case["id"]


@pytest.mark.parametrize("boundary", ["network", "server", "auth", "rate", "put"])
def test_transient_upload_failures_are_retried_with_backoff_and_never_pause(
    uploads, hue_store, monkeypatch, boundary
):
    import hue_sdk._blobs as blob_module

    monkeypatch.setattr(blob_module, "_RETRY_DELAY_SECONDS", 0)
    uploader = uploads.uploader
    original = uploader._request
    calls = []

    def request(method, url, *args):
        if boundary == "network" and url.endswith("/blobs"):
            calls.append(url)
            return None
        return original(method, url, *args)

    monkeypatch.setattr(uploader, "_request", request)
    status = {"server": 503, "auth": 403, "rate": 429}.get(boundary)
    if status:
        hue_store.reserve = lambda _: (status, {"Retry-After": "0"}, True)
    if boundary == "put":
        hue_store.put = lambda _: 503
    data = b"retry identical bytes"

    def store(value: bytes = data):
        return uploader.store("1" * 32, ATTRIBUTE, value, "image/png", (sha256(value), len(value)))

    assert not store().ok
    # The failing request was tried three times, a refusal about the request once.
    failing = {
        "network": len(calls),
        "server": len(hue_store.reservations),
        "auth": len(hue_store.reservations),
        "rate": len(hue_store.reservations),
        "put": len(hue_store.puts),
    }[boundary]
    assert failing == (1 if boundary == "auth" else 3)
    assert not hasattr(uploader, "_paused_until") and uploader.available()
    # Nothing pauses: other bytes are reserved at once.
    monkeypatch.setattr(uploader, "_request", original)
    hue_store.reserve = lambda _: None
    hue_store.put = lambda _: 200
    reservations = len(hue_store.reservations)
    assert store(b"other bytes").ok
    assert len(hue_store.reservations) == reservations + 1
    assert store().ok
    assert hue_store.objects[f"{'1' * 32}/{sha256(data)}"] == (data, "image/png")


@pytest.mark.parametrize("status", [400, 409, 413])
def test_content_local_upload_refusal_does_not_pause_next_value(uploads, hue_store, status):
    hue_store.reserve = lambda n: (status, {}, True) if n == 1 else None
    for index, data in enumerate((b"refused", b"accepted")):
        outcome = uploads.uploader.store(
            "1" * 32, ATTRIBUTE, data, "image/png", (sha256(data), len(data))
        )
        assert outcome.ok == bool(index)
    assert len(hue_store.reservations) == 2 and len(hue_store.puts) == 1


def test_zero_byte_upload_and_helper_keep_metadata_without_requests(uploads, hue_store):
    outcome = uploads.uploader.submit(
        "1" * 32, ATTRIBUTE, b"", "image/png", (sha256(b""), 0), UploadGroup()
    )
    assert (outcome.ok, outcome.reason) == (False, "failed") and uploads.uploader._jobs == {}
    with client(hue_store) as hue:
        with hue.span("empty helper") as span:
            span.record_file(role="input", media_type="image/png", data=b"", upload=True)
        assert hue.force_flush()
        assert hue.export_status.uploaded_values == hue.export_status.upload_fallbacks == 0
        assert hue.export_status.instrumentation_failures == 0
        assert hue._uploads.held.held == 0
    (event,) = hue_store.span("empty helper").events
    assert attrs(event)["hue.file.sha256"].string_value == sha256(b"")
    assert attrs(event)["hue.file.size"].int_value == 0
    assert entries(hue_store.span("empty helper")) == []
    assert hue_store.reservations == hue_store.puts == hue_store.completions == []


def test_existing_409_upload_ref_is_accepted_without_put(uploads, hue_store):
    hue_store.reserve = lambda _: (
        409,
        {},
        json.dumps(
            {
                "status": "exists",
                "ref": {"content_type": "image/gif"},
            }
        ).encode(),
    )
    outcome = uploads.uploader.store("1" * 32, ATTRIBUTE, b"gif", "image/gif", (sha256(b"gif"), 3))
    assert outcome.ok and outcome.content_type == "image/gif"
    assert len(hue_store.reservations) == 1
    assert hue_store.puts == hue_store.completions == []


@pytest.mark.parametrize("boundary", ["network", "server", "rate"])
def test_completion_failure_is_retried_and_never_fails_or_pauses_uploads(
    uploads, hue_store, monkeypatch, boundary
):
    import hue_sdk._blobs as blob_module

    monkeypatch.setattr(blob_module, "_RETRY_DELAY_SECONDS", 0)
    original = uploads.uploader._request
    completions = []

    def request(method, url, *args):
        if url.endswith("/complete"):
            completions.append(url)
            if boundary == "network":
                return None
            reply = original(method, url, *args)
            reply.status = 503 if boundary == "server" else 429
            return reply
        return original(method, url, *args)

    monkeypatch.setattr(uploads.uploader, "_request", request)

    def store(data):
        group = UploadGroup()
        outcome = uploads.uploader.submit(
            "1" * 32, ATTRIBUTE, data, "image/png", (sha256(data), len(data)), group
        )
        group.seal()
        # The upload settles once its bytes are stored and its completion was sent once.
        assert uploads.uploader.wait_idle(time.monotonic() + 5)
        return outcome

    # Completion is for Hue's accounting: tried three times in the background, and the value is
    # stored either way.
    assert store(b"first").ok
    assert hue_store.objects[f"{'1' * 32}/{sha256(b'first')}"] == (b"first", "image/png")
    assert eventually(lambda: len(completions) == 3, 5)
    time.sleep(0.2)
    assert len(completions) == 3
    # Nothing pauses: the next value is reserved at once.
    assert store(b"second").ok and len(hue_store.reservations) == 2


@pytest.mark.parametrize(
    "name,valid",
    [
        ("🎧" * 128, True),
        ("é" * 256, True),
        ("ok\x85", True),
        ("🎧" * 129, False),
        ("é" * 257, False),
        (" ", False),
        ("bad\x00", False),
        ("bad\x7f", False),
        ("bad\ud800", False),
    ],
)
def test_helper_name_validation_uses_utf16_and_preserves_upload(hue_store, name, valid):
    with client(hue_store) as hue:
        with hue.span("named helper") as span:
            span.record_file(
                role="input", media_type="image/png", data=b"name", name=name, upload=True
            )
        assert hue.force_flush() == valid
        assert hue.export_status.uploaded_values == 1
        assert hue.export_status.instrumentation_failures == int(not valid)
        assert hue._uploads.held.held == 0
    (entry,) = blobs(hue_store.span("named helper"))
    event = attrs(hue_store.span("named helper").events[0])
    assert entry.get("name") == (name if valid else None)
    assert ("hue.file.name" in event) == valid
    assert len(hue_store.reservations) == 1


@pytest.mark.parametrize(
    "part,pointer,mime,name,digested",
    [
        (
            {
                "inlineData": None,
                "inline_data": {"mimeType": None, "mime_type": "image/png", "data": "eA=="},
            },
            "/inline_data/data",
            "image/png",
            None,
            {"inlineData": None, "inline_data": {"mimeType": None, "mime_type": "image/png"}},
        ),
        (
            {
                "image": None,
                "document": {"format": "pdf", "name": "source.pdf", "source": {"bytes": "eA=="}},
            },
            "/document/source/bytes",
            "application/pdf",
            "source.pdf",
            {"image": None, "document": {"format": "pdf", "name": "source.pdf", "source": {}}},
        ),
        (
            {
                "type": "blob",
                "mime_type": None,
                "mimeType": "image/png",
                "name": None,
                "filename": "source.png",
                "content": "eA==",
            },
            "/content",
            "image/png",
            "source.png",
            {
                "type": "blob",
                "mime_type": None,
                "mimeType": "image/png",
                "name": None,
                "filename": "source.png",
            },
        ),
        (
            {"image": {"format": "gif", "source": {"bytes": "eA=="}}},
            "/image/source/bytes",
            "image/gif",
            None,
            {"image": {"format": "gif", "source": {}}},
        ),
    ],
)
def test_provider_none_alternates_survive_admission_and_upload(
    hue_store, part, pointer, mime, name, digested
):
    file = content_path(part)
    assert file is not None and (file.pointer, file.content_type, file.name) == (
        pointer,
        mime,
        name,
    )
    message = json.dumps([{"parts": [part]}])
    copied = snapshot_span(external_span(attributes={ATTRIBUTE: message}))
    assert json.loads(copied.attributes[ATTRIBUTE])[0]["parts"][0] == {
        **digested,
        "sha256": sha256(b"x"),
        "size": 1,
    }
    with client(hue_store) as hue:
        with hue.span("alternate") as span:
            span.set_attribute(ATTRIBUTE, message)
        assert hue.force_flush()
    (entry,) = blobs(hue_store.span("alternate"))
    assert entry["key"] == ATTRIBUTE + "#/0/parts/0"
    assert entry["content_type"] == mime and entry.get("name") == name


def staged_helpers(hue, files, *, events=None, attributes=None):
    if events is None:
        events = [
            SpanEvent(
                "hue.file",
                {
                    "hue.file.sha256": file.digest[0],
                    "hue.file.size": file.digest[1],
                    "hue.file.media_type": file.content_type,
                    "hue.file.role": file.role,
                    **({"hue.file.name": file.name} if file.name is not None else {}),
                },
                file.timestamp,
            )
            for file in files
        ]
    size = sum(held_size(file.data) + 1024 for file in files)
    assert hue._uploads.held.reserve(size)
    held = Held(files=list(files), size=size, budget=hue._uploads.held, inspected=set())
    span = external_span(events=events, attributes=attributes or {})
    attach_held(span, held)
    return span, held


def helper(data=b"helper", *, name="original.png", timestamp=1):
    return ExplicitFile(data, (sha256(data), len(data)), "image/png", name, timestamp=timestamp)


def test_helpers_across_spans_upload_in_the_background_four_at_a_time(hue_store, monkeypatch):
    put_delay_seconds = 0.3
    lock = Lock()
    active = peak = 0
    original_headers = BaseHTTPRequestHandler.end_headers

    def delayed_headers(handler):
        nonlocal active, peak
        if handler.command != "PUT":
            return original_headers(handler)
        with lock:
            active += 1
            peak = max(peak, active)
        try:
            time.sleep(put_delay_seconds)
            return original_headers(handler)
        finally:
            with lock:
                active -= 1

    monkeypatch.setattr(BaseHTTPRequestHandler, "end_headers", delayed_headers)
    files = [helper(f"concurrent helper {index}".encode()) for index in range(9)]
    with client(hue_store) as hue:
        exporter = hue._span_exporter
        staged = [
            staged_helpers(hue, [file], attributes={"case": index})
            for index, file in enumerate(files)
        ]
        admitted_spans = set()
        reservation_admissions = []
        released_sizes = []
        original_fit = exporter._fit
        original_release = hue._uploads.held.release

        def fit(record):
            index = record.attributes["case"]
            admitted_spans.add(index)
            if index == 8:
                record = replace_span(record, events=[])
            return original_fit(record)

        def reserve(_):
            reservation_admissions.append(set(admitted_spans))
            return None

        def release(size):
            released_sizes.append(size)
            original_release(size)

        monkeypatch.setattr(exporter, "_fit", fit)
        monkeypatch.setattr(hue._uploads.held, "release", release)
        hue_store.reserve = reserve
        assert exporter.export([span for span, _ in staged]) is SpanExportResult.SUCCESS
        # The spans were sent before any 0.3 s PUT finished: no upload was completed yet.
        assert hue_store.completions == []
        assert len(hue_store.spans) == 9
        assert settled(hue)
        assert 1 < peak <= 4 and active == 0
        # Every span was fitted before any helper file was submitted.
        assert reservation_admissions == [set(range(9))] * 8
        assert hue.export_status.uploaded_values == 8
        assert hue.export_status.upload_fallbacks == 1
        assert all(held.files == [] and held.values == held.digests == {} for _, held in staged)
        # Each record's charge goes once its own upload settles, in whatever order they finish.
        assert sorted(released_sizes) == sorted(held.size for _, held in staged)
        assert hue._uploads.held.held == 0
        for _, held in staged:
            held.release()
        assert sorted(released_sizes) == sorted(held.size for _, held in staged)
        assert hue._uploads.held.held == 0
    assert len(hue_store.reservations) == len(hue_store.puts) == len(hue_store.completions) == 8
    assert {request["sha256"] for request in hue_store.reservations} == {
        file.digest[0] for file in files[:8]
    }
    assert len(hue_store.spans) == 9
    for record in hue_store.spans:
        index = attrs(record)["case"].int_value
        assert entries(record) == ([exporter._file_entry(files[index])] if index < 8 else [])
        assert len(record.events) == (1 if index < 8 else 0)


def test_repeated_helpers_share_one_upload_without_holding_new_files_back(hue_store, monkeypatch):
    """Eight spans each record four copies of their own file. The copies share their file's
    pending upload, so the eight uploads run four at a time in the background, each once, and
    the export waits for none of them."""
    lock = Lock()
    active = peak = 0
    original_headers = BaseHTTPRequestHandler.end_headers

    def delayed_headers(handler):
        nonlocal active, peak
        if handler.command != "PUT":
            return original_headers(handler)
        with lock:
            active += 1
            peak = max(peak, active)
        try:
            time.sleep(0.3)
            return original_headers(handler)
        finally:
            with lock:
                active -= 1

    monkeypatch.setattr(BaseHTTPRequestHandler, "end_headers", delayed_headers)
    data = [f"repeated helper {index}".encode() for index in range(8)]
    with client(hue_store) as hue:
        exporter = hue._span_exporter
        staged = [
            staged_helpers(
                hue,
                [helper(item, timestamp=copy) for copy in range(1, 5)],
                attributes={"case": index},
            )
            for index, item in enumerate(data)
        ]
        assert exporter.export([span for span, _ in staged]) is SpanExportResult.SUCCESS
        assert hue_store.completions == []
        assert settled(hue)
        assert 1 < peak <= 4 and active == 0
        assert hue.export_status.uploaded_values == 32
        assert hue.export_status.upload_fallbacks == 0
    assert len(hue_store.reservations) == len(hue_store.puts) == 8
    assert sorted(request["sha256"] for request in hue_store.reservations) == sorted(
        sha256(item) for item in data
    )
    for record in hue_store.spans:
        item = data[attrs(record)["case"].int_value]
        assert entries(record) == [exporter._file_entry(helper(item))] * 4


@pytest.mark.parametrize(
    "mismatch", ["missing", "event_name", "timestamp", "sha256", "size", "media_type", "role"]
)
def test_helper_upload_requires_surviving_matching_event(hue_store, mismatch):
    file = helper()
    fields = {
        "hue.file.sha256": file.digest[0],
        "hue.file.size": file.digest[1],
        "hue.file.media_type": file.content_type,
        "hue.file.role": file.role,
    }
    if mismatch in ("sha256", "size", "media_type", "role"):
        fields["hue.file." + mismatch] = 99 if mismatch == "size" else "different"
    event = SpanEvent(
        "other" if mismatch == "event_name" else "hue.file",
        fields,
        2 if mismatch == "timestamp" else 1,
    )
    with client(hue_store) as hue:
        span, held = staged_helpers(hue, [file], events=[] if mismatch == "missing" else [event])
        (record,) = hue._span_exporter._place_held([span])
        assert "hue.blobs" not in record.attributes
        assert hue.export_status.upload_fallbacks == 1 and hue.export_status.uploaded_values == 0
        assert held.files == [] and hue._uploads.held.held == 0
        held.release()
        assert hue._uploads.held.held == 0
    assert hue_store.reservations == []


@pytest.mark.parametrize("name", ["surviving.png", "🎧" * 129, "bad\x00"])
def test_duplicate_helpers_consume_one_event_and_use_surviving_name(hue_store, name):
    file = helper()
    with client(hue_store) as hue:
        event = SpanEvent(
            "hue.file",
            {
                "hue.file.sha256": file.digest[0],
                "hue.file.size": file.digest[1],
                "hue.file.media_type": file.content_type,
                "hue.file.role": file.role,
                "hue.file.name": name,
            },
            1,
        )
        span, held = staged_helpers(hue, [file, file], events=[event])
        (record,) = hue._span_exporter._place_held([span])
        (entry,) = [json.loads(item) for item in record.attributes["hue.blobs"]]
        assert entry.get("name") == (name if is_media_name(name) else None)
        assert settled(hue)
        assert hue.export_status.uploaded_values == hue.export_status.upload_fallbacks == 1
        assert held.files == [] and hue._uploads.held.held == 0
    assert len(hue_store.reservations) == len(hue_store.puts) == 1


@pytest.mark.parametrize("boundary", ["record", "event", "reference", "baseline", "slots"])
def test_provisional_helper_admission_rejects_before_upload(hue_store, monkeypatch, boundary):
    file = helper()
    with client(hue_store) as hue:
        exporter = hue._span_exporter
        baseline = [exporter._file_entry(file)] if boundary == "baseline" else []
        if boundary == "slots":
            baseline = [
                json.dumps(
                    {
                        "key": f"existing:{n}",
                        "sha256": sha256(str(n)),
                        "size": 1,
                        "content_type": "image/png",
                    }
                )
                for n in range(64)
            ]
        span, held = staged_helpers(
            hue, [file], attributes={"hue.blobs": baseline} if baseline else {}
        )

        def fit(record):
            if boundary == "record":
                return None
            if boundary == "event":
                return replace_span(record, events=[]), 0
            return replace_span(record, attributes={"hue.blobs": baseline}), 0

        monkeypatch.setattr(exporter, "_fit", fit)
        (record,) = exporter._place_held([span])
        assert list(record.attributes.get("hue.blobs", [])) == baseline
        assert hue.export_status.upload_fallbacks == 1 and hue.export_status.uploaded_values == 0
        assert held.files == [] and hue._uploads.held.held == 0
    assert hue_store.reservations == hue_store.puts == []


def test_real_helper_request_budget_rejects_before_upload(hue_store):
    with client(hue_store) as hue:
        exporter = hue._span_exporter
        exporter._limits._current = replace(exporter._limits.current, decoded_bytes=2048)
        span, held = staged_helpers(
            hue, [helper(b"unfittable media")], attributes={"custom.metadata": "X" * 4096}
        )
        assert exporter.export([span]) is SpanExportResult.FAILURE
        status = hue.export_status
        assert status.failed_trace_batches == 1
        dropped = [issue for issue in hue.export_issues() if issue.kind == "dropped"]
        assert len(dropped) == 1 and dropped[0].count == 1
        assert status.uploaded_values == 0 and status.upload_fallbacks == 1
        warnings = [issue for issue in hue.export_issues() if issue.kind == "warning"]
        assert len(warnings) == 1 and warnings[0].count == 1
        assert held.files == [] and hue._uploads.held.held == 0
    assert hue_store.spans == []
    assert hue_store.reservations == hue_store.puts == hue_store.completions == []


def test_real_fit_identical_surviving_helpers_keep_two_references_with_one_upload(hue_store):
    file = helper(b"identical helper media", name="same.png")
    with client(hue_store) as hue:
        exporter = hue._span_exporter
        span, held = staged_helpers(hue, [file, file])
        assert exporter.export([span]) is SpanExportResult.SUCCESS
        received = hue_store.span("external")
        assert len(received.events) == 2 and received.events[0] == received.events[1]
        assert entries(received) == [exporter._file_entry(file)] * 2
        assert settled(hue)
        assert hue.export_status.uploaded_values == 2
        assert hue.export_status.upload_fallbacks == 0
        assert held.files == [] and hue._uploads.held.held == 0
    assert len(hue_store.reservations) == len(hue_store.puts) == len(hue_store.completions) == 1


def test_real_helper_fit_preserves_identical_baseline_reference_while_shedding(hue_store):
    file = helper(b"baseline collision media", name="collision.png")
    with client(hue_store) as hue:
        exporter = hue._span_exporter
        exporter._limits._current = replace(exporter._limits.current, decoded_bytes=2048)
        baseline = exporter._file_entry(file)
        span, held = staged_helpers(
            hue,
            [file],
            attributes={"hue.blobs": [baseline], "gen_ai.prompt": "X" * 8192},
        )
        assert exporter.export([span]) is SpanExportResult.SUCCESS
        received = hue_store.span("external")
        assert entries(received) == [baseline, baseline]
        assert "gen_ai.prompt" in listed(received)
        assert settled(hue)
        assert hue.export_status.uploaded_values == 1
        assert hue.export_status.upload_fallbacks == 0
        assert held.files == [] and hue._uploads.held.held == 0
    assert len(hue_store.reservations) == len(hue_store.puts) == len(hue_store.completions) == 1


def test_entries_carry_the_sdks_content_type_not_the_reservations(hue_store):
    file = helper(b"existing object media", name="fitting.png")
    # Hue already stores the bytes, reserved earlier under another media type: the entry keeps
    # the SDK's own, which readers serve the file as, so the record exported is the one fitted.
    hue_store.reserve = lambda _: (
        200,
        {},
        json.dumps(
            {"status": "exists", "ref": {"content_type": "application/octet-stream"}}
        ).encode(),
    )
    with client(hue_store) as hue:
        exporter = hue._span_exporter
        span, held = staged_helpers(hue, [file])
        provisional = replace_span(span, attributes={"hue.blobs": [exporter._file_entry(file)]})
        decoded_bytes = exporter._encode([provisional]).ByteSize()
        exporter._limits._current = replace(
            exporter._limits.current, decoded_bytes=decoded_bytes + 8
        )
        assert exporter.export([span]) is SpanExportResult.SUCCESS
        assert settled(hue)
        status = hue.export_status
        assert status.uploaded_values == 1 and status.upload_fallbacks == 0
        assert status.failed_trace_batches == 0
        assert held.files == [] and hue._uploads.held.held == 0
    received = hue_store.span("external")
    assert entries(received) == [exporter._file_entry(file)]
    assert blobs(received)[0]["content_type"] == "image/png"
    assert len(hue_store.reservations) == 1
    assert hue_store.puts == hue_store.completions == []


def test_helper_provisional_fit_preserves_baseline_and_counts_mixed_results(hue_store):
    first, second = helper(b"first"), helper(b"second", timestamp=2)
    # The first file's upload is held at the store, so the one place in the upload queue is
    # taken when the second is submitted: it is refused before export.
    hue_store.put = lambda _: "gate"
    baseline = json.dumps(
        {"key": "existing", "sha256": sha256(b"old"), "size": 3, "content_type": "image/png"}
    )
    with client(hue_store) as hue:
        hue._uploads.uploader._queue_limit = 1
        span, held = staged_helpers(hue, [first, second], attributes={"hue.blobs": [baseline]})
        (record,) = hue._span_exporter._place_held([span])
        references = list(record.attributes["hue.blobs"])
        assert references == [baseline, hue._span_exporter._file_entry(first)]
        assert len(record.events) == 2
        hue_store.gate.set()
        assert settled(hue)
        assert hue.export_status.uploaded_values == hue.export_status.upload_fallbacks == 1
        assert held.files == [] and hue._uploads.held.held == 0
    assert len(hue_store.reservations) == 1 and len(hue_store.puts) == 1


def test_inspection_allowance_from_unheld_value_limits_export_eligibility(hue_store, monkeypatch):
    import hue_sdk.snapshots as snapshots

    small = json.dumps(
        [{"parts": [{"type": "blob", "mime_type": "text/plain", "content": "é" * 100}]}],
        ensure_ascii=False,
    )
    first, skipped = message_with_image(b"first"), message_with_image(b"skipped" * 160_000)
    allowance = utf16_size(small, MAX_INLINE_FILE_TEXT) + len(first)
    monkeypatch.setattr(snapshots, "INLINE_FILE_TEXT_PER_RECORD", allowance)
    with client(hue_store) as hue:
        copied = snapshot_span(
            external_span(
                attributes={
                    ATTRIBUTE: small,
                    "gen_ai.output.messages": first,
                    "ai.prompt.messages": skipped,
                }
            ),
            value_bytes=512,
            hold=Hold(hue._uploads.held, 512, uploads=hue._uploads),
        )
        held = held_of(copied)
        assert held is not None
        assert held.inspected == {ATTRIBUTE, "gen_ai.output.messages"}
        assert ATTRIBUTE not in held.values and copied.attributes[ATTRIBUTE] == small
        assert "ai.prompt.messages" not in held.digests
        # Past the record's allowance, export reads its media in place.
        assert held.large == {"ai.prompt.messages"}
        (record,) = hue._span_exporter._place_held([copied])
        refs = [json.loads(item) for item in record.attributes["hue.blobs"]]
        assert any(item["key"] == "gen_ai.output.messages#/0/parts/1" for item in refs)
        assert any(
            item["key"] == "ai.prompt.messages#/0/parts/1"
            and item["sha256"] == sha256(b"skipped" * 160_000)
            for item in refs
        )
        assert settled(hue)
        assert hue._uploads.held.held == 0
    assert hue_store.objects[f"{'0' * 31}1/{sha256(b'skipped' * 160_000)}"] == (
        b"skipped" * 160_000,
        "image/png",
    )


def test_large_nested_media_exports_as_its_digest(hue_store):
    """As in 0.9: a 100 KiB image in an event, link, log record or resource exports as its
    digest instead of 136 KB of base64. The span's own copy uploads, and since 0.11 so does a
    correlated log record's, listed in the log record's own ``hue.blobs``; the event, link and
    resource never upload."""
    data = bytes(index * 7 % 256 for index in range(100 * 1024))
    message = message_with_image(data)
    context = SpanContext(1, 2, False, TraceFlags(TraceFlags.SAMPLED))
    with client(hue_store) as hue:
        with hue.span("large nested") as span:
            span.set_attribute(ATTRIBUTE, message)
            span.otel_span.add_event("provider.event", {ATTRIBUTE: message})
            span.otel_span.add_link(context, {ATTRIBUTE: message})
            hue._logger.emit(body="large nested", attributes={ATTRIBUTE: message})
        assert hue.force_flush()
    record = hue_store.span("large nested")
    (log,) = [log for log in hue_store.logs if log.body.string_value == "large nested"]
    for copied in (record, record.events[0], record.links[0], log):
        assert_image_digest(attrs(copied)[ATTRIBUTE].string_value, data)
    assert blobs(record) == [
        {
            "key": f"{ATTRIBUTE}#/0/parts/1",
            "sha256": sha256(data),
            "size": len(data),
            "content_type": "image/png",
        }
    ]
    assert listed(record) == []
    assert [json.loads(entry) for entry in entries(log)] == blobs(record)
    # The log record's copy of the same bytes in the trace shares the span's upload.
    assert [request["key"] for request in hue_store.reservations] == [f"{ATTRIBUTE}#/0/parts/1"]
    resource = snapshot_span(
        external_span(resource=Resource({ATTRIBUTE: message})), value_bytes=64 * 1024
    ).resource
    assert_image_digest(resource.attributes[ATTRIBUTE], data)


def test_requested_uploads_of_spans_dropped_at_the_queue_are_counted(hue_store):
    # The first span's export is held, so the one-record queue is full while six more end.
    hue_store.release_traces.clear()
    try:
        with client(hue_store, max_queue_size=1) as hue:
            with hue.span("queued"):
                pass
            assert hue_store.traces_received.wait(10)
            for index in range(6):
                with hue.span(f"dropped {index}") as span:
                    span.record_file(
                        role="input",
                        media_type="image/png",
                        data=f"dropped {index}".encode(),
                        upload=True,
                    )
            status = hue.export_status
            assert status.dropped_trace_records == 6
            assert status.upload_fallbacks == 6
            assert hue._uploads is not None and hue._uploads._staged == {}
            assert hue._uploads.held.held == 0
            hue_store.release_traces.set()
            # Not ok: six records were dropped.
            assert not hue.force_flush()
    finally:
        hue_store.release_traces.set()
    assert [span.name for span in hue_store.spans] == ["queued"]
    assert hue_store.reservations == []


def _filler_message(filler: str, image: bytes | None = None) -> str:
    parts: list[dict[str, Any]] = [{"type": "text", "content": filler}]
    if image is not None:
        parts.append(
            {
                "type": "blob",
                "modality": "image",
                "mime_type": "image/png",
                "content": base64.b64encode(image).decode(),
            }
        )
    return json.dumps([{"role": "user", "parts": parts}], ensure_ascii=False)


def test_per_record_inspection_counts_utf16_code_units(hue_store):
    # Each message is about 3.5 M code units but 7 MB of UTF-8: three fit the 16 MiB per-record
    # bound only in code units, as the TypeScript SDK counts them, so the last image is found.
    # "image" makes every message a candidate for inspection, charged to the record's bound.
    filler = "Describe this image. " + "é" * 3_500_000
    image = bytes([7]) * 4096
    with client(hue_store) as hue:
        with hue.span("utf-16 inspection") as span:
            span.set_attribute("gen_ai.input.messages", _filler_message(filler))
            span.set_attribute("gen_ai.output.messages", _filler_message(filler))
            span.set_attribute("ai.prompt.messages", _filler_message(filler, image))
        assert hue.force_flush(timeout_millis=60_000)
    found = blobs(hue_store.span("utf-16 inspection"))
    assert [entry["key"] for entry in found] == [
        "gen_ai.input.messages",
        "gen_ai.output.messages",
        "ai.prompt.messages#/0/parts/1",
        "ai.prompt.messages",
    ]
    assert found[2]["sha256"] == sha256(image)


def test_a_message_of_8_mi_code_units_is_inspected_even_when_its_utf8_is_longer(hue_store):
    image = bytes([9]) * 4096
    messages: list[dict[str, Any]] = [
        {
            "role": "user",
            "parts": [
                {
                    "type": "blob",
                    "mime_type": "image/png",
                    "content": base64.b64encode(image).decode(),
                }
            ],
            "padding": "",
        }
    ]
    length = len(json.dumps(messages, ensure_ascii=False, separators=(",", ":")))
    messages[0]["padding"] = "é" * (MAX_INLINE_FILE_TEXT - length)
    value = json.dumps(messages, ensure_ascii=False, separators=(",", ":"))
    assert len(value) == MAX_INLINE_FILE_TEXT < len(value.encode())
    with client(hue_store) as hue:
        with hue.span("utf-16 message bound") as span:
            span.set_attribute(ATTRIBUTE, value)
        assert hue.force_flush(timeout_millis=60_000)
    found = blobs(hue_store.span("utf-16 message bound"))
    assert [entry["key"] for entry in found] == [f"{ATTRIBUTE}#/0/parts/0", ATTRIBUTE]
    assert found[0]["sha256"] == sha256(image)


def test_input_value_declared_text_plain_stays_literal_text(hue_store):
    data = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR2kAAAAASUVORK5CYII="
    )
    value = json.dumps({"image": "data:image/png;base64," + base64.b64encode(data).decode()})
    with client(hue_store) as hue:
        with hue.span("literal") as span:
            span.set_attribute("input.mime_type", "text/plain")
            span.set_attribute("input.value", value)
            span.set_attribute("output.mime_type", "application/json")
            span.set_attribute("output.value", value)
        assert hue.force_flush(timeout_millis=30_000)
    record = hue_store.span("literal")
    # OpenInference's text/plain value is literal text to Hue, so it is left as recorded.
    assert attrs(record)["input.value"].string_value == value
    assert [entry["key"] for entry in blobs(record)] == ["output.value#/image"]


def test_a_blob_key_over_256_utf16_units_is_not_reserved(hue_store):
    # 130 emoji are 130 code points but 260 UTF-16 units, past the key limit Hue counts in units.
    data = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR2kAAAAASUVORK5CYII="
    )
    url = "data:image/png;base64," + base64.b64encode(data).decode()
    value = json.dumps({"\U0001f600" * 130: url}, ensure_ascii=False)
    with client(hue_store) as hue:
        with hue.span("long key") as span:
            span.set_attribute("input.value", value)
        assert hue.force_flush(timeout_millis=30_000)
        status = hue.export_status
    record = hue_store.span("long key")
    assert attrs(record)["input.value"].string_value == value
    assert hue_store.reservations == []
    assert status.upload_fallbacks == 1


def test_a_text_plain_input_value_over_the_cap_still_uploads_whole(hue_store):
    data = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR2kAAAAASUVORK5CYII="
    )
    value = json.dumps(
        {
            "image": "data:image/png;base64," + base64.b64encode(data).decode(),
            "text": "x" * (2 * 1024 * 1024),
        }
    )
    with client(hue_store) as hue:
        with hue.span("literal whole") as span:
            span.set_attribute("input.mime_type", "text/plain")
            span.set_attribute("input.value", value)
            trace_id = format(span.otel_span.get_span_context().trace_id, "032x")
        assert hue.force_flush(timeout_millis=30_000)
    record = hue_store.span("literal whole")
    # Uploaded whole as any value over the cap is, its image left in the text.
    assert blobs(record) == [
        {
            "key": "input.value",
            "sha256": sha256(value.encode()),
            "size": len(value.encode()),
            "content_type": "application/json",
        }
    ]
    assert hue_store.objects[f"{trace_id}/{sha256(value.encode())}"][0] == value.encode()
    assert listed(record) == ["input.value"]


LARGE = json.loads((Path(__file__).parent / "fixtures/media-parts/cases.json").read_text())["large"]


def large_file(name: str) -> bytes:
    spec = LARGE["files"][name]
    seed = base64.b64decode(spec["seed"])
    return (seed * (spec["size"] // len(seed) + 1))[: spec["size"]]


def large_text(case: dict[str, Any]) -> str:
    """A large case's attribute text: ``$file`` replaced by the file as the case writes it, the
    messages written as the TypeScript suite writes them (``JSON.stringify``)."""
    data = base64.b64encode(large_file(case["file"])).decode()
    if case["form"] != "base64":
        data = f"data:{LARGE['files'][case['file']]['content_type']};base64,{data}"

    def fill(value: Any) -> Any:
        if value == "$file":
            return data
        if isinstance(value, list):
            return [fill(item) for item in value]
        if isinstance(value, dict):
            return {key: fill(item) for key, item in value.items()}
        return value

    return data if "value" in case else dumps_message(fill(case["messages"]))


@pytest.mark.parametrize("outcome", OUTCOMES)
@pytest.mark.parametrize("case", LARGE["cases"], ids=[case["id"] for case in LARGE["cases"]])
def test_shared_large_media_wire_corpus(hue_store, case, outcome):
    text = large_text(case)
    # Past the per-attribute bound: 0.11.1 uploaded such a value whole, its file unread.
    assert utf16_size(text, MAX_INLINE_FILE_TEXT) > MAX_INLINE_FILE_TEXT
    with client(hue_store) as hue:
        column = corpus_outcome(hue, hue_store, outcome)
        with hue.span(case["id"]) as span:
            span.set_attribute(case["attribute"], text)
        assert hue.force_flush(timeout_millis=60_000)
        status = hue.export_status
    record = hue_store.span(case["id"])
    exported = attrs(record)[case["attribute"]].string_value
    expected = case[column]
    assert entries(record) == expected["entries"]
    if expected.get("truncated"):
        # Not a recorded message: the file keeps its bytes, and the value is cut as before.
        assert listed(record) == [case["attribute"]]
        assert text.startswith(exported)
    elif "value" in expected:
        assert exported == expected["value"]
    else:
        assert json.loads(exported) == expected["messages"]
    if outcome == "success":
        assert status.upload_fallbacks == 0
        (entry,) = [json.loads(item) for item in expected["entries"]]
        stored = hue_store.objects[f"{record.trace_id.hex()}/{entry['sha256']}"]
        assert stored[0] == large_file(case["file"])
    else:
        assert status.uploaded_values == 0 and hue_store.objects == {}
    if outcome == "after_export":
        assert status.upload_fallbacks == len(expected["entries"])
    if outcome == "failure":
        assert status.upload_fallbacks >= 1 and hue_store.reservations == []


def test_a_model_calls_10_mb_audio_part_is_read_in_place_its_memory_bounded(hue_store, monkeypatch):
    import binascii

    import hue_sdk._inline_files as inline_files
    import hue_sdk._large_media as large_media

    audio = large_file("wav")
    audio += audio[: 4 * 1024 * 1024]
    messages = [
        {
            "role": "user",
            "parts": [
                {"type": "text", "content": "Transcribe this call."},
                {
                    "type": "blob",
                    "modality": "audio",
                    "mime_type": "audio/wav",
                    "content": base64.b64encode(audio).decode(),
                },
            ],
        }
    ]
    largest = {"parse": 0, "decode": 0}

    def spy(name: str, function: Any) -> Any:
        def call(value: Any, *args: Any, **kwargs: Any) -> Any:
            largest[name] = max(largest[name], len(value))
            return function(value, *args, **kwargs)

        return call

    with client(hue_store) as hue:
        with hue.model("gpt-audio", provider="openai") as span:
            span.set_input(messages)
        for module in (inline_files, large_media):
            monkeypatch.setattr(module, "loads_message", spy("parse", module.loads_message))
        monkeypatch.setattr(json, "loads", spy("parse", json.loads))
        monkeypatch.setattr(binascii, "a2b_base64", spy("decode", binascii.a2b_base64))
        monkeypatch.setattr(base64, "b64decode", spy("decode", base64.b64decode))
        assert hue.force_flush(timeout_millis=60_000)
        monkeypatch.undo()
        status = hue.export_status
    assert (status.uploaded_values, status.upload_fallbacks) == (1, 0)
    # The message is never parsed whole, nor its file decoded whole: only the JSON around it and
    # 1 MiB slices of its base64.
    assert largest["parse"] < 64 * 1024, largest
    assert 0 < largest["decode"] <= 1024 * 1024, largest
    record = hue_store.span("chat gpt-audio")
    assert json.loads(attrs(record)["gen_ai.input.messages"].string_value) == [
        {
            "role": "user",
            "parts": [
                {"type": "text", "content": "Transcribe this call."},
                {
                    "type": "blob",
                    "modality": "audio",
                    "mime_type": "audio/wav",
                    "sha256": sha256(audio),
                    "size": len(audio),
                },
            ],
        }
    ]
    assert blobs(record) == [
        {
            "key": "gen_ai.input.messages#/0/parts/1",
            "sha256": sha256(audio),
            "size": len(audio),
            "content_type": "audio/wav",
        }
    ]
    assert listed(record) == []


def test_a_message_past_the_records_inspection_allowance_is_read_in_place_too(hue_store):
    # Three messages of 6 Mi code units: the third is past the record's 16 Mi allowance.
    images = [bytes([seed]) * 4_700_000 for seed in (1, 2, 3)]
    keys = ["gen_ai.input.messages", "gen_ai.output.messages", "ai.prompt.messages"]
    with client(hue_store) as hue:
        with hue.span("allowance") as span:
            for key, image in zip(keys, images, strict=True):
                span.set_attribute(key, message_with_image(image))
        assert hue.force_flush(timeout_millis=60_000)
        assert hue.export_status.upload_fallbacks == 0
    record = hue_store.span("allowance")
    assert [(entry["key"], entry["sha256"]) for entry in blobs(record)] == [
        (f"{key}#/0/parts/1", sha256(image)) for key, image in zip(keys, images, strict=True)
    ]
    assert listed(record) == []


def test_a_percent_escaped_data_url_past_the_bounds_is_not_read_in_place(hue_store):
    # 3 Mi escapes of 3 characters each: 9 Mi code units, past the per-attribute bound.
    block = "".join(f"%{byte:02x}" for byte in range(256))
    messages = dumps_message(
        [
            {
                "role": "user",
                "parts": [
                    {
                        "type": "blob",
                        "modality": "audio",
                        "mime_type": "audio/wav",
                        "content": "data:audio/wav," + block * (3 * 1024 * 1024 // 256),
                    }
                ],
            }
        ]
    )
    with client(hue_store) as hue:
        with hue.span("percent") as span:
            span.set_attribute("gen_ai.input.messages", messages)
        assert hue.force_flush(timeout_millis=60_000)
        assert hue.export_status.upload_fallbacks == 0
    record = hue_store.span("percent")
    # As 0.11.1 stored it: the whole value, its first 16 KiB inline.
    assert [(entry["key"], entry["content_type"]) for entry in blobs(record)] == [
        ("gen_ai.input.messages", "application/json")
    ]
    assert hue_store.objects[f"{record.trace_id.hex()}/{sha256(messages)}"][0] == (
        messages.encode()
    )


def test_a_value_whose_json_around_its_files_is_past_the_bound_uploads_whole(hue_store):
    # A text part of 9 Mi code units with escapes (newlines) is parsed, not read in place.
    messages = dumps_message(
        [
            {
                "role": "user",
                "parts": [
                    {"type": "text", "content": "line\n" * (9 * 1024 * 1024 // 5)},
                    {
                        "type": "blob",
                        "modality": "image",
                        "mime_type": "image/png",
                        "content": "iVBORw0KGgo=",
                    },
                ],
            }
        ]
    )
    with client(hue_store) as hue:
        with hue.span("over the bound") as span:
            span.set_attribute("gen_ai.input.messages", messages)
        assert hue.force_flush(timeout_millis=60_000)
    record = hue_store.span("over the bound")
    assert [(entry["key"], entry["content_type"]) for entry in blobs(record)] == [
        ("gen_ai.input.messages", "application/json")
    ]
    assert listed(record) == ["gen_ai.input.messages"]


@pytest.mark.parametrize(
    "answer,attempts",
    [
        (None, 3),
        (503, 3),
        (408, 3),
        (429, 3),
        (400, 1),
        (401, 1),
        (403, 1),
        (413, 1),
        (404, 1),
    ],
    ids=["no answer", "503", "408", "429", "400", "401", "403", "413", "Hue's 404"],
)
def test_reservations_retry_transient_answers_and_give_up_on_client_errors(
    uploads, hue_store, monkeypatch, answer, attempts
):
    import hue_sdk._blobs as blob_module

    monkeypatch.setattr(blob_module, "_RETRY_DELAY_SECONDS", 0)
    uploader = uploads.uploader
    unanswered = []
    if answer is None:
        original = uploader._request

        def request(method, url, *args):
            if url.endswith("/blobs"):
                unanswered.append(url)
                return None
            return original(method, url, *args)

        monkeypatch.setattr(uploader, "_request", request)
    else:
        # Hue's JSON error, so a 404 is an archived project rather than a missing route.
        hue_store.reserve = lambda _: (answer, {}, True)
    data = b"reserved again or not"
    outcome = uploader.store("1" * 32, ATTRIBUTE, data, "image/png", (sha256(data), len(data)))
    assert (outcome.ok, outcome.reason) == (False, "too_large" if answer == 413 else "failed")
    assert len(unanswered) + len(hue_store.reservations) == attempts
    assert hue_store.puts == []
    # Nothing was learned or paused.
    assert uploader.available() and uploader.refusal() is None


def test_a_reservations_retry_after_is_waited_for_at_most_60_seconds(uploads, hue_store):
    uploader = uploads.uploader
    data = b"rate limited"
    digest = (sha256(data), len(data))
    waits: list[float] = []
    real_wait = uploader._wait
    uploader._wait = lambda seconds: waits.append(seconds) or True  # type: ignore[method-assign]
    hue_store.reserve = lambda _: (503, {"Retry-After": "120"}, True)
    assert not uploader.store("1" * 32, ATTRIBUTE, data, "image/png", digest).ok
    assert waits == [60.0, 60.0] and len(hue_store.reservations) == 3
    # A Retry-After within the cap is waited out, then the reservation is tried again.
    uploader._wait = real_wait  # type: ignore[method-assign]
    reserved: list[float] = []

    def reserve(index: int) -> Any:
        reserved.append(time.monotonic())
        return (503, {"Retry-After": "1"}, True) if index == 4 else None

    hue_store.reserve = reserve
    assert uploader.store("1" * 32, ATTRIBUTE, data, "image/png", digest).ok
    assert len(reserved) == 2 and reserved[1] - reserved[0] >= 0.9


def test_put_deadline_scales_with_size():
    assert put_seconds(2 * 1024 * 1024, 10) == 60
    assert put_seconds(1_000_000_000, 10) == pytest.approx(1_000_000_000 / (1024 * 1024))
    assert put_seconds(1_000_000_000, 10) == pytest.approx(953.67, abs=0.01)


def test_a_log_record_is_sent_while_its_media_upload_is_stalled(hue_store):
    hue_store.put = lambda _: "gate"
    data = os.urandom(4096)
    part = {"type": "blob", "mime_type": "image/png", "content": base64.b64encode(data).decode()}
    with client(hue_store) as hue:
        with hue.model("synthetic-model", provider="openai") as span:
            trace_id = span.trace_id
            span.log_inference(input=[{"role": "user", "parts": [part]}])
        # The log record reaches Hue, its file listed, while the file's PUT is held.
        assert eventually(lambda: hue_store.logs, 5)
        assert eventually(lambda: hue_store.puts, 5)
        assert hue_store.objects == {}
        (log,) = hue_store.logs
        assert [entry["key"] for entry in blobs(log)] == ["body#/gen_ai.input.messages/0/parts/0"]
        assert json_of(log.body)["gen_ai.input.messages"][0]["parts"][0] == {
            "type": "blob",
            "mime_type": "image/png",
            "sha256": sha256(data),
            "size": len(data),
        }
        hue_store.gate.set()
        assert hue.force_flush()
        assert hue.export_status.uploaded_values == 1
    assert hue_store.objects[f"{trace_id}/{sha256(data)}"] == (data, "image/png")


def test_a_log_body_file_under_the_cap_is_charged_while_its_upload_keeps_it(hue_store):
    from hue_sdk._blobs import FALLBACK_MESSAGES

    hue_store.put = lambda _: "gate"
    # Each image's base64 is under the value cap, so its queued record holds nothing apart; its
    # upload keeps the decoded bytes.
    first, second = os.urandom(600 * 1024), os.urandom(600 * 1024)
    with client(hue_store) as hue:
        uploads = hue._uploads
        assert uploads is not None
        # Room for one image's bytes, not for two.
        uploads.held._limit = held_size(first) * 3 // 2
        for name, data in (("first", first), ("second", second)):
            part = {
                "type": "blob",
                "mime_type": "image/png",
                "content": base64.b64encode(data).decode(),
            }
            with hue.model(name, provider="openai") as span:
                span.log_inference(input=[{"role": "user", "parts": [part]}])
        assert eventually(lambda: len(hue_store.logs) == 2, 5)
        assert eventually(lambda: hue_store.puts, 5)
        # The pending upload's bytes stay charged while the store holds its PUT.
        assert uploads.held.held == held_size(first)
        with uploads.uploader._lock:
            kept = [source for job in uploads.uploader._jobs.values() for source in job.sources]
        assert kept == [first]
        # The second record is sent at once all the same, its file kept inline.
        held_log, inline_log = hue_store.logs
        assert len(blobs(held_log)) == 1 and blobs(inline_log) == []
        assert json_of(inline_log.body)["gen_ai.input.messages"][0]["parts"][0] == {
            "type": "blob",
            "mime_type": "image/png",
            "content": base64.b64encode(second).decode(),
        }
        assert [
            issue.count
            for issue in hue.export_issues()
            if issue.message == FALLBACK_MESSAGES["budget"]
        ] == [1]
        hue_store.gate.set()
        assert hue.force_flush()
        assert uploads.held.held == 0
        assert hue.export_status.uploaded_values == 1
