"""Media wire parity and upload/privacy behavior against a synthetic loopback receiver.

This suite is also copied outside the checkout and run against the installed wheel.
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from threading import Event, Lock
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
from test_blobs import KEY, attrs, blobs, client, listed, message_with_image, sha256
from test_blobs import hue_store as hue_store

from hue_sdk import Hue
from hue_sdk._blobs import (
    BlobUploader,
    ExplicitFile,
    Held,
    HeldValues,
    Uploads,
    attach_held,
    held_of,
    held_size,
)
from hue_sdk._inline_files import (
    INLINE_FILE_TEXT_PER_RECORD,
    MAX_INLINE_FILE_TEXT,
    MediaDigestMemo,
    content_path,
    is_media_name,
    may_inline_files,
    utf16_size,
)
from hue_sdk._limits import cut_utf8
from hue_sdk._records import replace_span
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


def entries(record: Any) -> list[str]:
    value = attrs(record).get("hue.blobs")
    return [item.string_value for item in value.array_value.values] if value else []


@pytest.mark.parametrize("outcome", ["success", "failure"])
def test_shared_media_wire_corpus(hue_store, outcome):
    cases = json.loads((Path(__file__).parent / "fixtures/media-parts/cases.json").read_text())[
        "fixtures"
    ]
    if outcome == "failure":
        hue_store.reserve = lambda _: (409, {}, True)
    with client(hue_store, max_queue_size=512) as hue:
        for case in cases:
            with hue.span(case["id"]) as span:
                span.set_attribute(
                    case["attribute"], json.dumps(case["messages"], ensure_ascii=False)
                )
        assert hue.force_flush(timeout_millis=30_000)
        for case in cases:
            record = hue_store.span(case["id"])
            assert (
                json.loads(attrs(record)[case["attribute"]].string_value)
                == case[outcome]["messages"]
            ), case["id"]
            assert entries(record) == case[outcome]["entries"], case["id"]
    assert all(put["status"] == 200 for put in hue_store.puts)
    if outcome == "failure":
        assert hue_store.puts == []


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
    assert uploads.memo._entries == uploads.uploader._outcomes == {}


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
    assert len(hue_store.reservations) == 2
    assert hue_store.puts == []
    assert entries(hue_store.span("media")) == entries(hue_store.span("file")) == []
    assert len(hue_store.span("file").events) == 1


def test_inflight_upload_reused_and_outcomes_bounded_and_cleared(hue_store):
    uploader = BlobUploader(hue_store.url, {"Authorization": f"Bearer {KEY}"}, 2)
    started, release = Event(), Event()
    data = b"synthetic concurrent media"
    original = uploader._store

    def delayed(*args):
        started.set()
        assert release.wait(3)
        return original(*args)

    uploader._store = delayed
    trace = "1" * 32
    with ThreadPoolExecutor(max_workers=2) as pool:
        args = (trace, "first", data, "image/png", (sha256(data), len(data)), time.monotonic() + 5)
        first = pool.submit(uploader.store, *args, lambda _: False)
        assert started.wait(2)
        second = pool.submit(uploader.store, *args, lambda _: False)
        release.set()
        assert first.result().ok and second.result().ok
    assert len(hue_store.reservations) == 1
    uploader._store = original
    uploader._outcome_limit = 2
    hue_store.reserve = lambda _: (409, {}, True)
    for index in range(4):
        value = str(index).encode()
        uploader.store(
            trace,
            "next",
            value,
            "image/png",
            (sha256(value), len(value)),
            time.monotonic() + 2,
            lambda _: False,
        )
        assert len(uploader._outcomes) <= 2
    uploader.close()
    assert uploader._outcomes == {}


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


def test_only_own_message_attributes_upload(hue_store):
    data = b"private nested provider media"
    message = message_with_image(data)
    provider = TracerProvider(
        resource=Resource.create({ATTRIBUTE: message}), shutdown_on_exit=False
    )
    context = SpanContext(1, 2, False, TraceFlags(TraceFlags.SAMPLED))
    try:
        with client(hue_store, tracer_provider=provider) as hue:
            with hue.span("ownership") as span:
                span.set_attribute("custom.message", message)
                span.otel_span.add_event("provider.event", {ATTRIBUTE: message})
                span.otel_span.add_link(context, {ATTRIBUTE: message})
                span.log_inference(input=json.loads(message))
                hue._logger.emit(body=message, attributes={ATTRIBUTE: message})
            assert hue.force_flush()
        record = hue_store.span("ownership")
        assert attrs(record)["custom.message"].string_value == message
        assert attrs(record.events[0])[ATTRIBUTE].string_value == message
        assert attrs(record.links[0])[ATTRIBUTE].string_value == message
        assert len(hue_store.logs) == 2
        (log,) = [log for log in hue_store.logs if log.body.string_value == message]
        assert attrs(log)[ATTRIBUTE].string_value == message
        assert entries(record) == [] and all(entries(log) == [] for log in hue_store.logs)
        assert hue_store.reservations == hue_store.puts == hue_store.completions == []
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
    hue_store.reserve = lambda _: (409, {}, True)
    with client(hue_store) as hue:
        with hue.span("refused oversized") as span:
            span.set_attribute(ATTRIBUTE, oversized_message)
        assert hue.force_flush(timeout_millis=30_000)
        assert hue.export_status.ok and hue.export_status.upload_fallbacks == 1
        assert hue.export_status.uploaded_values == 0
        assert hue._uploads.held.held == 0
    record = hue_store.span("refused oversized")
    assert bool(attrs(record)[ATTRIBUTE].string_value == cut_utf8(oversized_message, 1024 * 1024))
    assert listed(record) == [ATTRIBUTE] and entries(record) == []
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
        copied = snapshot_span(
            external_span(
                attributes={
                    case["attribute"]: json.dumps(case["messages"], ensure_ascii=False),
                }
            )
        )
        assert json.loads(copied.attributes[case["attribute"]]) == case["failure"]["messages"], (
            case["id"]
        )
        assert "hue.blobs" not in copied.attributes, case["id"]


@pytest.mark.parametrize("boundary", ["network", "server", "auth", "rate", "put"])
def test_transient_upload_pause_evicts_failure_and_recovers(
    uploads, hue_store, monkeypatch, boundary
):
    import hue_sdk._blobs as blob_module

    clock = [time.monotonic()]
    monkeypatch.setattr(blob_module, "monotonic", lambda: clock[0])
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

    def store():
        return uploader.store(
            "1" * 32,
            ATTRIBUTE,
            data,
            "image/png",
            (sha256(data), len(data)),
            clock[0] + 5,
            lambda _: False,
        )

    assert not store().ok
    assert uploader._outcomes == {} and uploader.available()
    assert uploader._paused_until > clock[0]
    requests = len(hue_store.reservations), len(hue_store.puts), len(calls)
    assert not store().ok
    assert requests == (len(hue_store.reservations), len(hue_store.puts), len(calls))
    clock[0] = uploader._paused_until + 1
    monkeypatch.setattr(uploader, "_request", original)
    hue_store.reserve = lambda _: None
    hue_store.put = lambda _: 200
    assert store().ok
    assert hue_store.objects[f"{'1' * 32}/{sha256(data)}"] == (data, "image/png")
    reservations = len(hue_store.reservations)
    assert store().ok and len(hue_store.reservations) == reservations


@pytest.mark.parametrize("status", [400, 409, 413])
def test_content_local_upload_refusal_does_not_pause_next_value(uploads, hue_store, status):
    hue_store.reserve = lambda n: (status, {}, True) if n == 1 else None
    for index, data in enumerate((b"refused", b"accepted")):
        outcome = uploads.uploader.store(
            "1" * 32,
            ATTRIBUTE,
            data,
            "image/png",
            (sha256(data), len(data)),
            time.monotonic() + 5,
            lambda _: False,
        )
        assert outcome.ok == bool(index)
        assert uploads.uploader._paused_until == 0
    assert len(hue_store.reservations) == 2 and len(hue_store.puts) == 1


def test_zero_byte_upload_and_helper_keep_metadata_without_requests(uploads, hue_store):
    outcome = uploads.uploader.store(
        "1" * 32,
        ATTRIBUTE,
        b"",
        "image/png",
        (sha256(b""), 0),
        time.monotonic() + 5,
        lambda _: False,
    )
    assert not outcome.ok and uploads.uploader._outcomes == {}
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
    outcome = uploads.uploader.store(
        "1" * 32,
        ATTRIBUTE,
        b"gif",
        "image/gif",
        (sha256(b"gif"), 3),
        time.monotonic() + 5,
        lambda _: False,
    )
    assert outcome.ok and outcome.content_type == "image/gif"
    assert len(hue_store.reservations) == 1
    assert hue_store.puts == hue_store.completions == []


@pytest.mark.parametrize("boundary", ["network", "server", "rate"])
def test_completion_failure_preserves_receipt_and_pauses_other_uploads(
    uploads, hue_store, monkeypatch, boundary
):
    import hue_sdk._blobs as blob_module

    clock = [time.monotonic()]
    monkeypatch.setattr(blob_module, "monotonic", lambda: clock[0])
    original = uploads.uploader._request

    def request(method, url, *args):
        if url.endswith("/complete"):
            if boundary == "network":
                return None
            reply = original(method, url, *args)
            reply.status = 503 if boundary == "server" else 429
            return reply
        return original(method, url, *args)

    monkeypatch.setattr(uploads.uploader, "_request", request)

    def store(data):
        return uploads.uploader.store(
            "1" * 32,
            ATTRIBUTE,
            data,
            "image/png",
            (sha256(data), len(data)),
            clock[0] + 5,
            lambda _: False,
        )

    assert store(b"first").ok
    assert uploads.uploader._paused_until > clock[0]
    assert store(b"first").ok
    assert not store(b"second").ok and len(hue_store.reservations) == 1
    clock[0] = uploads.uploader._paused_until + 1
    monkeypatch.setattr(uploads.uploader, "_request", original)
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


def test_helpers_across_spans_share_concurrent_upload_budget(hue_store, monkeypatch):
    import hue_sdk.transport as transport

    budget_seconds = 1.5
    put_delay_seconds = 0.3
    monkeypatch.setattr(transport, "upload_budget_seconds", lambda _: budget_seconds)
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
        started = time.monotonic()
        assert exporter.export([span for span, _ in staged]) is SpanExportResult.SUCCESS
        elapsed = time.monotonic() - started
        assert elapsed < budget_seconds
        assert 1 < peak <= 4 and active == 0
        assert reservation_admissions == [set(range(9))] * 8
        assert hue.export_status.uploaded_values == 8
        assert hue.export_status.upload_fallbacks == 1
        assert all(held.files == [] and held.values == held.digests == {} for _, held in staged)
        assert released_sizes == [held.size for _, held in staged]
        assert hue._uploads.held.held == 0
        for _, held in staged:
            held.release()
        assert released_sizes == [held.size for _, held in staged]
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
        assert hue.export_status.uploaded_values == 1
        assert hue.export_status.upload_fallbacks == 0
        assert held.files == [] and hue._uploads.held.held == 0
    assert len(hue_store.reservations) == len(hue_store.puts) == len(hue_store.completions) == 1


def test_real_helper_fit_rechecks_longer_receiver_mime_before_final_delivery(hue_store):
    file = helper(b"existing object media", name="fitting.png")
    content_type = "application/" + "x" * 243
    hue_store.reserve = lambda _: (
        200,
        {},
        json.dumps({"status": "exists", "ref": {"content_type": content_type}}).encode(),
    )
    with client(hue_store) as hue:
        exporter = hue._span_exporter
        span, held = staged_helpers(hue, [file])
        provisional = replace_span(span, attributes={"hue.blobs": [exporter._file_entry(file)]})
        decoded_bytes = exporter._encode([provisional]).ByteSize()
        exporter._limits._current = replace(
            exporter._limits.current, decoded_bytes=decoded_bytes + 64
        )
        fitted = exporter._fit(provisional)
        assert fitted is not None and fitted[1] == decoded_bytes
        assert exporter.export([span]) is SpanExportResult.FAILURE
        status = hue.export_status
        # Acknowledged uploads and span delivery are separate; delivery is not atomic.
        assert status.uploaded_values == 1 and status.upload_fallbacks == 0
        assert status.failed_trace_batches == 1
        dropped = [issue for issue in hue.export_issues() if issue.kind == "dropped"]
        assert len(dropped) == 1 and dropped[0].count == 1
        assert held.files == [] and hue._uploads.held.held == 0
    assert hue_store.spans == []
    assert len(hue_store.reservations) == 1
    assert hue_store.puts == hue_store.completions == []


def test_helper_provisional_fit_preserves_baseline_and_counts_mixed_results(hue_store):
    first, second = helper(b"first"), helper(b"second", timestamp=2)
    hue_store.reserve = lambda n: (400, {}, True) if n == 2 else None
    baseline = json.dumps(
        {"key": "existing", "sha256": sha256(b"old"), "size": 3, "content_type": "image/png"}
    )
    with client(hue_store) as hue:
        span, held = staged_helpers(hue, [first, second], attributes={"hue.blobs": [baseline]})
        (record,) = hue._span_exporter._place_held([span])
        references = list(record.attributes["hue.blobs"])
        assert references[0] == baseline and len(references) == 2
        # Concurrent helpers can reach the receiver in either order. It acknowledges
        # the first reservation and refuses the second.
        assert json.loads(references[1])["sha256"] == hue_store.reservations[0]["sha256"]
        assert len(record.events) == 2
        assert hue.export_status.uploaded_values == hue.export_status.upload_fallbacks == 1
        assert held.files == [] and hue._uploads.held.held == 0
    assert len(hue_store.reservations) == 2 and len(hue_store.puts) == 1


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
        (record,) = hue._span_exporter._place_held([copied])
        refs = [json.loads(item) for item in record.attributes["hue.blobs"]]
        assert any(item["key"] == "gen_ai.output.messages#/0/parts/1" for item in refs)
        assert any(
            item["key"] == "ai.prompt.messages" and item["sha256"] == sha256(skipped)
            for item in refs
        )
        assert hue._uploads.held.held == 0
    assert hue_store.objects[f"{'0' * 31}1/{sha256(skipped)}"] == (
        skipped.encode(),
        "application/json",
    )


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
