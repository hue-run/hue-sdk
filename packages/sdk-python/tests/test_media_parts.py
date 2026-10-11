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
from opentelemetry._logs import LogRecord
from opentelemetry.sdk._logs import ReadWriteLogRecord
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import Event as SpanEvent
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.util.instrumentation import InstrumentationScope
from opentelemetry.trace import Link, SpanContext, TraceFlags
from test_blobs import KEY, attrs, blobs, client, listed, message_with_image, sha256
from test_blobs import hue_store as hue_store

from hue_sdk import Hue
from hue_sdk._blobs import BlobUploader, HeldValues, Uploads, held_of, held_size
from hue_sdk._inline_files import (
    INLINE_FILE_TEXT_PER_RECORD,
    MAX_INLINE_FILE_TEXT,
    MediaDigestMemo,
    content_path,
    is_media_name,
    may_inline_files,
)
from hue_sdk._limits import cut_utf8
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
    messages[0]["parts"][0]["content"] = "é" * (MAX_INLINE_FILE_TEXT // 2 + 128 * 1024)
    value = json.dumps(messages, ensure_ascii=False)
    assert len(value) < MAX_INLINE_FILE_TEXT < len(value.encode("utf-8"))
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
        assert_image_digest(attrs(record.events[0])[ATTRIBUTE].string_value, data)
        assert_image_digest(attrs(record.links[0])[ATTRIBUTE].string_value, data)
        assert len(hue_store.logs) == 2
        (log,) = [log for log in hue_store.logs if log.body.string_value == message]
        assert_image_digest(attrs(log)[ATTRIBUTE].string_value, data)
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
def test_nested_media_digests_before_value_and_record_admission(
    hue_store, uploads, monkeypatch, location
):
    import hue_sdk.snapshots as snapshots

    data = b"nested admission" * 512
    message = message_with_image(data)
    assert len(message.encode()) > 4096
    inspected = []
    original = snapshots.hash_inline_files_counted

    def inspect(key, value, memo=None, receipts=None, trace_id=""):
        inspected.append((memo, receipts))
        return original(key, value, memo, receipts, trace_id)

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
        assert "hue.truncated" not in copied.log_record.attributes
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
        assert "hue.truncated" not in copied.attributes
        if location == "resource":
            value = copied.resource.attributes[ATTRIBUTE]
        else:
            items = copied.events if location == "event" else copied.links
            assert len(items) == 1
            value = items[0].attributes[ATTRIBUTE]
    assert_image_digest(value, data)
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
        for data in (b"resource bytes", b"event bytes of another size", b"link"):
            copied = budget.permitted({ATTRIBUTE: message_with_image(data)}, files=True)
            assert_image_digest(copied[ATTRIBUTE], data)
            assert budget.held.digests == receipts
            assert (list(uploads.memo._entries.items()), uploads.memo._size) == memo
    finally:
        budget.held.release()


def test_identical_nested_media_never_calls_upload_memo(uploads, monkeypatch):
    import hue_sdk.snapshots as snapshots

    message = message_with_image(b"same bytes")
    budget = _ValueBudget(hold=Hold(uploads.held, 1024, uploads=uploads), trace_id="1" * 32)
    try:
        budget.copied_attributes({ATTRIBUTE: message}, own=True)
        calls, inspected = [], []
        original_digest = uploads.memo.digest
        original_inspect = snapshots.hash_inline_files_counted

        def digest(*args):
            calls.append(args)
            return original_digest(*args)

        def inspect(key, value, memo=None, receipts=None, trace_id=""):
            inspected.append((memo, receipts))
            return original_inspect(key, value, memo, receipts, trace_id)

        monkeypatch.setattr(uploads.memo, "digest", digest)
        monkeypatch.setattr(snapshots, "hash_inline_files_counted", inspect)
        copied = budget.permitted({ATTRIBUTE: message}, files=True)
        assert_image_digest(copied[ATTRIBUTE], b"same bytes")
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
        assert_image_digest(resource_value, b"different resource bytes")
        record = hue_store.span("collision")
        assert_image_digest(attrs(record.events[0])[ATTRIBUTE].string_value, b"different event")
        assert_image_digest(attrs(record.links[0])[ATTRIBUTE].string_value, b"link")
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
