"""Media wire parity and upload/privacy behavior against a synthetic loopback receiver.

This suite is also copied outside the checkout and run against the installed wheel.
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from typing import Any

import pytest
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.trace import SpanContext, TraceFlags
from test_blobs import KEY, attrs, blobs, client, message_with_image, sha256
from test_blobs import hue_store as hue_store

from hue_sdk import Hue
from hue_sdk._blobs import BlobUploader
from hue_sdk._inline_files import (
    MediaDigestMemo,
    content_path,
    is_media_name,
    may_inline_files,
)

ATTRIBUTE = "gen_ai.input.messages"


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
            assert calls == []
            monkeypatch.setattr(inline.hashlib, "sha256", original)
        with hue.span("other trace") as span:
            span.record_file(role="input", media_type="image/png", data=data, upload=True)
        assert hue.force_flush()
    assert len(hue_store.reservations) == len(hue_store.puts) == 2
    assert blobs(hue_store.span("file"))[0]["sha256"] == digest
    assert blobs(hue_store.span("media again"))[0]["sha256"] == digest


def test_failed_media_and_explicit_upload_share_cached_outcome(hue_store):
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
    assert len(hue_store.reservations) == 1
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


def test_digest_cache_is_trace_scoped_and_charges_retained_bytes(monkeypatch):
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
    assert len(calls) == 2
    for index in range(8):
        memo.digest(str(index).encode(), "a")
        assert memo._size <= memo.limit and len(memo._entries) <= memo.capacity
    memo.digest(b"x" * 1024, "a")
    assert all(len(key[1]) < 1024 for key in memo._entries)
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
    message = message_with_image(b"private nested provider media")
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
        assert hue_store.reservations == []
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
    assert is_media_name("🎧" * 256) and is_media_name(" ")
    for name in ("", "🎧" * 257, "bad\x00", "bad\x7f", "bad\x85", "bad\ud800"):
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
    from hue_sdk._records import is_truncated_marker
    from hue_sdk.snapshots import _ValueBudget

    message = json.dumps([{"parts": [{"type": "blob", "content": "YQ==" * (1536 * 1024)}]}])
    budget = _ValueBudget()
    copied = budget.permitted(
        {ATTRIBUTE: message, "gen_ai.output.messages": message, "ai.prompt.messages": message},
        files=True,
    )
    for key in (ATTRIBUTE, "gen_ai.output.messages"):
        assert json.loads(copied[key])[0]["parts"][0]["size"] > 64 * 1024
    assert is_truncated_marker(copied["ai.prompt.messages"])
