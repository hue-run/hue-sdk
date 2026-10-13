"""Attachments placed in recorded values, against a synthetic loopback receiver.

The wire corpus is shared with the TypeScript SDK (``fixtures/media-parts/cases.json``).
"""

from __future__ import annotations

import base64
import json
import os
import time
from pathlib import Path
from threading import Thread
from typing import Any

import pytest
from test_blobs import MIB, attrs, blobs, client, listed, sha256
from test_blobs import hue_store as hue_store

from hue_sdk import Attachment, Hue
from hue_sdk._attachment import PathFile, file_source
from hue_sdk._blobs import BlobUploader

CORPUS = json.loads((Path(__file__).parent / "fixtures/media-parts/cases.json").read_text())[
    "attachments"
]


def build(value: Any, made: dict[str, Attachment]) -> Any:
    """The case's value with each ``{"$attachment": name}`` placeholder replaced by one
    attachment per file, the same instance wherever the file appears."""
    if isinstance(value, list):
        return [build(item, made) for item in value]
    if isinstance(value, dict):
        named = value.get("$attachment")
        if named is not None:
            spec = CORPUS["files"][named]
            if named not in made:
                made[named] = Attachment(
                    base64.b64decode(spec["data"]),
                    content_type=spec["content_type"],
                    name=spec.get("name"),
                )
            return made[named]
        return {key: build(item, made) for key, item in value.items()}
    return value


def record(hue: Any, case: dict[str, Any]) -> None:
    value = build(case["value"], {})
    helper = case["helper"]
    if helper == "model":
        with hue.model("synthetic-model", provider="synthetic", name=case["id"]) as span:
            span.set_input(value)
    elif helper == "metadata":
        with hue.span(case["id"], attributes={"metadata": value}):
            pass
    else:
        with hue.span(case["id"]) as span:
            if helper == "input":
                span.set_input(value)
            elif helper == "output":
                span.set_output(value)
            else:
                span.log_inference(input=value)


def any_value(value: Any) -> Any:
    """An OTLP ``AnyValue`` as JSON."""
    kind = value.WhichOneof("value")
    if kind == "kvlist_value":
        return {item.key: any_value(item.value) for item in value.kvlist_value.values}
    if kind == "array_value":
        return [any_value(item) for item in value.array_value.values]
    if kind is None:
        return None
    return getattr(value, kind)


def entries(record: Any) -> list[str]:
    value = attrs(record).get("hue.blobs")
    return [item.string_value for item in value.array_value.values] if value else []


def test_shared_attachment_wire_success(hue_store):
    run_corpus(hue_store, success=True)


def test_shared_attachment_wire_failure(hue_store):
    hue_store.reserve = lambda _: (403, {}, True)
    run_corpus(hue_store, success=False)


def run_corpus(hue_store, *, success: bool) -> None:
    cases = CORPUS["cases"]
    expected = sum(len(case["entries"]) for case in cases)
    with client(hue_store) as hue:
        for case in cases:
            record(hue, case)
        assert hue.force_flush(timeout_millis=30_000)
        status = hue.export_status
        assert status.instrumentation_failures == 0
        assert status.uploaded_values == (expected if success else 0)
        assert status.upload_fallbacks == (0 if success else expected)
        for case in cases:
            span = hue_store.span(case["id"])
            carrier = span
            if case["helper"] == "log":
                (carrier,) = [log for log in hue_store.logs if log.trace_id == span.trace_id]
                assert any_value(carrier.body) == case["recorded"], case["id"]
            else:
                text = attrs(span)[case["attribute"]].string_value
                assert text == json.dumps(
                    case["recorded"], ensure_ascii=False, separators=(",", ":")
                ), case["id"]
            assert entries(carrier) == (case["entries"] if success else []), case["id"]
    if success:
        # The same file twice in one trace is stored once.
        stored = {(item["traceId"], item["sha256"]) for item in hue_store.reservations}
        assert len(hue_store.puts) == len(stored)
    else:
        assert hue_store.puts == []


def test_a_path_reads_the_same_bytes_as_data_and_every_string_form_decodes(tmp_path):
    data = base64.b64decode(CORPUS["files"]["pixel"]["data"])
    path = tmp_path / "pixel.png"
    path.write_bytes(data)
    encoded = CORPUS["files"]["pixel"]["data"]
    for attachment in (
        Attachment(path=path, content_type="image/png"),
        Attachment(path=str(path), content_type="image/png"),
        Attachment(data, content_type="image/png"),
        Attachment(bytearray(data), content_type="image/png"),
        Attachment(memoryview(data), content_type="image/png"),
        Attachment(encoded, content_type="image/png"),
        Attachment(f"data:image/png;base64,{encoded}", content_type="image/png"),
    ):
        assert attachment.sha256 == sha256(data)
        assert attachment.size == len(data)
    # The bytes are copied when the attachment is made.
    buffer = bytearray(data)
    made = Attachment(buffer, content_type="image/png")
    buffer[:] = bytes(len(buffer))
    assert made.sha256 == sha256(data)
    for invalid in (
        Attachment(content_type="image/png"),
        Attachment(data, path=path, content_type="image/png"),
        Attachment(path=tmp_path / "missing.png", content_type="image/png"),
        Attachment("not base64!", content_type="image/png"),
        Attachment(data, content_type="image png"),
        Attachment(bytes(25 * 1024 * 1024 + 1), content_type="image/png"),
    ):
        assert invalid.sha256 is None
    assert Attachment(data, content_type="image/png", name="a\tb").name is None


def test_an_invalid_attachment_records_null_and_an_invalid_name_is_omitted_both_counted(
    hue_store,
):
    data = base64.b64decode(CORPUS["files"]["pixel"]["data"])
    with client(hue_store) as hue:
        with hue.span(
            "invalid",
            attributes={"metadata": Attachment(content_type="image/png"), "plain": "kept"},
        ) as span:
            span.set_input(
                {
                    "bad": Attachment(data, content_type="not a type"),
                    "unnamed": Attachment(data, content_type="image/png", name="bad\nname"),
                }
            )
            span.set_output("kept")
        # Instrumentation issues fail the flush; the span is exported whole all the same.
        assert not hue.force_flush(timeout_millis=30_000)
        assert hue.export_status.instrumentation_failures == 3
        assert hue.export_status.failed_trace_batches == 0
    span = hue_store.span("invalid")
    assert json.loads(attrs(span)["input.value"].string_value) == {
        "bad": None,
        "unnamed": {
            "type": "blob",
            "mime_type": "image/png",
            "modality": "image",
            "sha256": sha256(data),
            "size": len(data),
        },
    }
    assert attrs(span)["output.value"].string_value == '"kept"'
    assert attrs(span)["plain"].string_value == "kept"
    assert "metadata" not in attrs(span)
    assert [entry["key"] for entry in blobs(span)] == ["input.value#/unnamed"]


def test_without_content_capture_a_metadata_attachment_is_its_digest_part_and_no_bytes_leave(
    hue_store,
):
    data = base64.b64decode(CORPUS["files"]["report"]["data"])
    attachment = Attachment(data, content_type="application/pdf", name="report.pdf")
    with Hue(hue_store.url, "synthetic", capture_content=False, live_spans=False) as hue:
        with hue.span("metadata only", attributes={"metadata": {"report": attachment}}) as span:
            span.set_input({"report": attachment})
            span.log_inference(input=[attachment])
            span.set_attribute("metadata.extra", attachment)
        assert hue.force_flush(timeout_millis=30_000)
        assert hue.export_status.upload_fallbacks == 0
    span = hue_store.span("metadata only")
    part = {
        "type": "blob",
        "mime_type": "application/pdf",
        "modality": "document",
        "sha256": sha256(data),
        "size": len(data),
    }
    assert json.loads(attrs(span)["metadata"].string_value) == {"report": part}
    assert json.loads(attrs(span)["metadata.extra"].string_value) == part
    assert "input.value" not in attrs(span)
    assert "hue.blobs" not in attrs(span)
    assert hue_store.logs == []
    assert hue_store.reservations == []


def test_an_attachment_the_redactor_removes_replaces_or_nests_too_deep_is_not_uploaded(
    hue_store,
):
    data = base64.b64decode(CORPUS["files"]["pixel"]["data"])
    attachment = Attachment(data, content_type="image/png")
    deep: Any = attachment
    for _ in range(11):
        deep = [deep]

    def redactor(key: str, value: Any) -> Any:
        return "[redacted]" if key == "output.value" else value

    with client(hue_store, redactor=redactor) as hue:
        with hue.span("redacted") as span:
            span.set_output([attachment])
            span.set_input({"first": attachment})
            # Setting the value again replaces the attachments it held.
            span.set_input("no file now")
        with hue.span("deep") as span:
            span.set_input(deep)
        assert hue.force_flush(timeout_millis=30_000)
        # Only the part past Hue's reading depth is reported: it kept its digest.
        assert hue.export_status.upload_fallbacks == 1
    assert hue_store.reservations == []
    assert "hue.blobs" not in attrs(hue_store.span("redacted"))
    assert attrs(hue_store.span("redacted"))["output.value"].string_value == '"[redacted]"'
    assert sha256(data) in attrs(hue_store.span("deep"))["input.value"].string_value


def test_setup_credentials_record_the_digest_part_and_upload_nothing(hue_store):
    with client(hue_store, api_key="hue_setup_synthetic") as hue:
        with hue.span("setup") as span:
            span.set_input([Attachment(b"abcd", content_type="text/plain")])
        assert hue.force_flush(timeout_millis=30_000)
        assert hue.export_status.upload_fallbacks == 0
    assert hue_store.reservations == []


def test_an_attachment_in_a_value_that_uploads_whole_is_still_uploaded_and_listed(hue_store):
    # With its file as the digest part, the value is still over the 1 MiB value limit: it uploads
    # whole and keeps its first 16 KiB inline. The attachment's bytes are stored and listed all the
    # same, so they can be read by digest, though no reader places the part in the value's inline
    # prefix.
    data = base64.b64decode(CORPUS["files"]["pixel"]["data"])
    pixel = Attachment(data, content_type="image/png", name="pixel.png")
    with client(hue_store) as hue:
        with hue.span("uploads whole") as span:
            trace_id = span.trace_id
            span.set_input({"notes": "n" * (2 * MIB), "image": pixel})
        assert hue.force_flush(timeout_millis=30_000)
        status = hue.export_status
        assert (status.uploaded_values, status.upload_fallbacks) == (2, 0)
    record = hue_store.span("uploads whole")
    assert listed(record) == ["input.value"]
    assert [entry["key"] for entry in blobs(record)] == ["input.value", "input.value#/image"]
    assert blobs(record)[1] == {
        "key": "input.value#/image",
        "sha256": sha256(data),
        "size": len(data),
        "content_type": "image/png",
        "name": "pixel.png",
    }
    assert hue_store.objects[f"{trace_id}/{sha256(data)}"][0] == data


PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR2kAAAAASUVORK5CYII="
)
PDF = b"%PDF-1.4\n%synthetic attachment\n%%EOF\n"
IMAGE_PART = {"type": "blob", "modality": "image", "mime_type": "image/png"}
PDF_PART = {
    "type": "blob",
    "mime_type": "application/pdf",
    "modality": "document",
    "sha256": sha256(PDF),
    "size": len(PDF),
    "name": "terms.pdf",
}


def log_attachment_and_inline_media(hue_store, *, success: bool) -> None:
    with client(hue_store) as hue:
        with hue.model("synthetic-model", provider="openai") as span:
            span.log_inference(
                input=[
                    {
                        "role": "user",
                        "parts": [
                            {**IMAGE_PART, "content": base64.b64encode(PNG).decode()},
                            Attachment(PDF, content_type="application/pdf", name="terms.pdf"),
                        ],
                    }
                ]
            )
            trace_id = format(span.otel_span.get_span_context().trace_id, "032x")
        assert hue.force_flush(timeout_millis=30_000)
        status = hue.export_status
    (log,) = hue_store.logs
    parts = any_value(log.body)["gen_ai.input.messages"][0]["parts"]
    # The attachment is its digest part either way; the small image is placed only once it
    # uploads, and otherwise stays inline as before.
    assert parts[1] == PDF_PART
    assert parts[0] == (
        {**IMAGE_PART, "sha256": sha256(PNG), "size": len(PNG)}
        if success
        else {**IMAGE_PART, "content": base64.b64encode(PNG).decode()}
    )
    # Each file is reserved at most once, by the one step that places a log record's files (a
    # refused reservation pauses uploads, so a second file may not be asked for).
    keys = [item["key"] for item in hue_store.reservations]
    expected = ["body#/gen_ai.input.messages/0/parts/0", "body#/gen_ai.input.messages/0/parts/1"]
    assert sorted(keys) == expected if success else len(set(keys)) == len(keys) <= 2
    assert set(keys) <= set(expected)
    assert all(item["traceId"] == trace_id for item in hue_store.reservations)
    if success:
        assert [json.loads(entry) for entry in entries(log)] == [
            {
                "key": "body#/gen_ai.input.messages/0/parts/0",
                "sha256": sha256(PNG),
                "size": len(PNG),
                "content_type": "image/png",
            },
            {
                "key": "body#/gen_ai.input.messages/0/parts/1",
                "sha256": sha256(PDF),
                "size": len(PDF),
                "content_type": "application/pdf",
                "name": "terms.pdf",
            },
        ]
        assert len(hue_store.puts) == 2
        assert (status.uploaded_values, status.upload_fallbacks) == (2, 0)
    else:
        assert entries(log) == []
        assert (status.uploaded_values, status.upload_fallbacks) == (0, 2)


def test_a_log_records_attachment_and_inline_media_upload_together_once_each(hue_store):
    log_attachment_and_inline_media(hue_store, success=True)


def test_a_log_records_attachment_and_inline_media_fall_back_together(hue_store):
    hue_store.reserve = lambda _: (403, {}, True)
    log_attachment_and_inline_media(hue_store, success=False)


def test_a_log_records_message_file_not_uploaded_keeps_the_nested_rule(hue_store):
    hue_store.reserve = lambda _: (403, {}, True)
    large = bytes(index * 7 % 256 for index in range(100 * 1024))
    messages = json.dumps(
        [
            {
                "role": "user",
                "parts": [
                    {**IMAGE_PART, "content": base64.b64encode(PNG).decode()},
                    {**IMAGE_PART, "content": base64.b64encode(large).decode()},
                ],
            }
        ]
    )
    with client(hue_store) as hue:
        with hue.span("log fallback"):
            hue._logger.emit(body="log fallback", attributes={"gen_ai.input.messages": messages})
        assert hue.force_flush(timeout_millis=30_000)
        status = hue.export_status
    (log,) = hue_store.logs
    # Both uploads were refused: the small image stays inline and the large one is its digest,
    # as a log record's messages were before log records uploaded.
    assert json.loads(attrs(log)["gen_ai.input.messages"].string_value)[0]["parts"] == [
        {**IMAGE_PART, "content": base64.b64encode(PNG).decode()},
        {**IMAGE_PART, "sha256": sha256(large), "size": len(large)},
    ]
    assert entries(log) == []
    assert 1 <= len(hue_store.reservations) <= 2
    assert status.upload_fallbacks == 2


def test_a_log_record_lost_while_it_is_copied_counts_its_attachments(hue_store, monkeypatch):
    from hue_sdk import snapshots

    def fail(self: Any, scope: Any) -> Any:
        raise ValueError("synthetic copy failure")

    with client(hue_store) as hue:
        with hue.model("synthetic-model", provider="openai") as span:
            monkeypatch.setattr(snapshots._ValueBudget, "scope", fail)
            span.log_inference(
                input=[{"role": "user", "parts": [Attachment(PDF, content_type="application/pdf")]}]
            )
            monkeypatch.undo()
        hue.force_flush(timeout_millis=30_000)
        status = hue.export_status
    # The record was dropped while it was copied: its attachment is counted as not uploaded and
    # the bytes it held are released.
    assert hue_store.logs == []
    assert hue_store.reservations == []
    assert status.upload_fallbacks == 1
    assert hue._uploads is not None and hue._uploads.held.held == 0


def test_span_attributes_opentelemetry_cannot_hold_are_recorded_as_json_text(hue_store):
    with client(hue_store) as hue:
        with hue.span(
            "json attributes",
            attributes={
                "metadata": {"customer": "acme", "plan": {"seats": 3}},
                "records": [{"id": 1}, {"id": 2}],
                "mixed": [1, "two"],
                "tags": ["a", "b"],
                "count": 2,
            },
        ) as span:
            span.set_attribute("later", {"step": "review"})
        assert hue.force_flush(timeout_millis=30_000)
        status = hue.export_status
    recorded = attrs(hue_store.span("json attributes"))
    assert recorded["metadata"].string_value == '{"customer":"acme","plan":{"seats":3}}'
    assert recorded["records"].string_value == '[{"id":1},{"id":2}]'
    assert recorded["mixed"].string_value == '[1,"two"]'
    assert recorded["later"].string_value == '{"step":"review"}'
    # Values OpenTelemetry holds stay as they are.
    assert [item.string_value for item in recorded["tags"].array_value.values] == ["a", "b"]
    assert recorded["count"].int_value == 2
    assert hue_store.reservations == []
    assert status.instrumentation_failures == 0


def test_bytes_over_25_mib_are_refused_before_they_are_copied():
    import tracemalloc

    large = bytearray(25 * 1024 * 1024 + 1)
    tracemalloc.start()
    try:
        for data in (large, memoryview(large)):
            attachment = Attachment(data, content_type="application/pdf")
            assert attachment.sha256 is None
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    # Refusing the bytes allocates nothing near their size.
    assert peak < 1024 * 1024


def test_a_log_bodys_inline_media_take_hue_blobs_places_before_its_attachments(hue_store):
    images = [bytes([0x89, 0x50, 0x4E, 0x47, index & 255, index >> 8]) for index in range(66)]
    with client(hue_store) as hue:
        with hue.model("synthetic-model", provider="openai") as span:
            span.log_inference(
                input=[
                    {
                        "role": "user",
                        "parts": [
                            *(
                                {
                                    "type": "blob",
                                    "mime_type": "image/png",
                                    "content": base64.b64encode(data).decode(),
                                }
                                for data in images
                            ),
                            Attachment(b"%PDF-1.4 extra", content_type="application/pdf"),
                        ],
                    }
                ]
            )
        assert hue.force_flush(timeout_millis=30_000)
        status = hue.export_status
    (log,) = hue_store.logs
    # As on a span: the 64 places go to the inline media in reading order; the attachment and the
    # inline media past them stay as they are, counted as not uploaded.
    assert [json.loads(entry)["key"] for entry in entries(log)] == [
        f"body#/gen_ai.input.messages/0/parts/{index}" for index in range(64)
    ]
    assert status.upload_fallbacks == 3


def sparse_file(path: Path, size: int, head: bytes = b"RIFF\0\0\0\0WAVE") -> Path:
    """A sparse file of ``size`` bytes starting with ``head`` (removed with ``tmp_path``)."""
    with open(path, "wb") as file:
        file.write(head)
        file.truncate(size)
    return path


def test_an_attachment_of_a_30_mib_file_uploads_from_disk_never_held_in_memory(hue_store, tmp_path):
    import tracemalloc

    path = sparse_file(tmp_path / "recording.wav", 30 * MIB)
    data = path.read_bytes()
    tracemalloc.start()
    try:
        attachment = Attachment(path=path, content_type="audio/wav", name="call.wav")
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    # Hashed a slice at a time: the file is never read whole into memory.
    assert peak < 4 * MIB
    assert (attachment.sha256, attachment.size) == (sha256(data), 30 * MIB)
    with client(hue_store) as hue:
        with hue.span("path attachment") as span:
            span.set_input({"recording": attachment})
        assert hue.force_flush(timeout_millis=60_000)
        status = hue.export_status
    assert (status.uploaded_values, status.upload_fallbacks) == (1, 0)
    assert status.instrumentation_failures == 0
    record = hue_store.span("path attachment")
    assert json.loads(attrs(record)["input.value"].string_value) == {
        "recording": {
            "type": "blob",
            "mime_type": "audio/wav",
            "modality": "audio",
            "sha256": sha256(data),
            "size": 30 * MIB,
            "name": "call.wav",
        }
    }
    assert blobs(record) == [
        {
            "key": "input.value#/recording",
            "sha256": sha256(data),
            "size": 30 * MIB,
            "content_type": "audio/wav",
            "name": "call.wav",
        }
    ]
    assert hue_store.objects[f"{record.trace_id.hex()}/{sha256(data)}"][0] == data


def test_record_file_uploads_a_30_mib_file_given_by_path(hue_store, tmp_path):
    path = sparse_file(tmp_path / "recording.wav", 30 * MIB)
    data = path.read_bytes()
    with client(hue_store) as hue:
        with hue.span("record path") as span:
            span.record_file(
                role="input", media_type="audio/wav", path=path, upload=True, name="call.wav"
            )
        assert hue.force_flush(timeout_millis=60_000)
        status = hue.export_status
    assert (status.uploaded_values, status.instrumentation_failures) == (1, 0)
    record = hue_store.span("record path")
    (event,) = [event for event in record.events if event.name == "hue.file"]
    assert {item.key: item.value for item in event.attributes}["hue.file.size"].int_value == (
        30 * MIB
    )
    assert blobs(record) == [
        {
            "key": f"event:hue.file:{sha256(data)}",
            "sha256": sha256(data),
            "size": 30 * MIB,
            "content_type": "audio/wav",
            "name": "call.wav",
        }
    ]
    assert hue_store.objects[f"{record.trace_id.hex()}/{sha256(data)}"][0] == data


@pytest.mark.parametrize("change", ["changed", "removed", "replaced by a named pipe"])
def test_a_file_changed_after_it_was_recorded_is_not_uploaded_and_is_counted(
    hue_store, tmp_path, change
):
    path = sparse_file(tmp_path / "recording.wav", 30 * MIB)
    with client(hue_store) as hue:
        with hue.span(change) as span:
            span.set_input({"recording": Attachment(path=path, content_type="audio/wav")})
            span.record_file(role="input", media_type="audio/wav", path=path, upload=True)
            if change == "removed":
                path.unlink()
            elif change == "replaced by a named pipe":
                # Opened without waiting for a writer, and refused as no regular file.
                path.unlink()
                os.mkfifo(path)
            else:
                # One byte in the middle: the size is the same, the SHA-256 is not.
                with open(path, "r+b") as file:
                    file.seek(20 * MIB)
                    file.write(b"X")
        assert hue.force_flush(timeout_millis=60_000)
        status = hue.export_status
        issues = hue.export_issues()
    # The attachment and the recorded file each read the file again and find it changed.
    assert (status.uploaded_values, status.upload_fallbacks) == (0, 2)
    record = hue_store.span(change)
    assert blobs(record) == []
    # The part keeps the digest it was recorded with.
    assert json.loads(attrs(record)["input.value"].string_value)["recording"]["size"] == 30 * MIB
    # Nothing was stored or completed, and no complete body of other bytes reached the store.
    assert hue_store.objects == {}
    assert hue_store.completions == []
    assert [
        put for put in hue_store.puts if put["status"] == 200 and put["bytes"] == 30 * MIB
    ] == []
    assert any("could not be uploaded" in issue.message for issue in issues)


def test_a_file_that_changed_does_not_fail_another_reference_to_its_recorded_bytes(
    hue_store, tmp_path
):
    path = sparse_file(tmp_path / "recording.wav", 30 * MIB)
    data = path.read_bytes()
    digest = (sha256(data), len(data))
    source = file_source(PathFile(str(path), len(data), digest[0]))
    with open(path, "r+b") as file:
        file.seek(20 * MIB)
        file.write(b"X")
    uploader = BlobUploader(hue_store.url, {"Authorization": "Bearer synthetic"}, 10)
    trace_id = "0123456789abcdef0123456789abcdef"
    deadline = time.monotonic() + 60
    outcomes: dict[str, Any] = {}

    def changed() -> None:
        outcomes["changed"] = uploader.store(
            trace_id, "input.value#/a", source, "audio/wav", digest, deadline, lambda _: False
        )

    # The changed file's upload starts first; the same bytes held in memory wait for it, and
    # then upload themselves rather than take its failure.
    thread = Thread(target=changed)
    thread.start()
    while (trace_id, digest[0]) not in uploader._outcomes and thread.is_alive():
        time.sleep(0.001)
    held = uploader.store(
        trace_id, "input.value#/b", data, "audio/wav", digest, deadline, lambda _: False
    )
    thread.join(60)
    assert (outcomes["changed"].ok, outcomes["changed"].reason) == (False, "failed")
    assert (held.ok, held.content_type) == (True, "audio/wav")
    assert hue_store.objects[f"{trace_id}/{digest[0]}"][0] == data


def test_bytes_over_25_mib_and_a_file_over_the_1_gb_upload_limit_are_still_refused(
    hue_store, tmp_path
):
    path = sparse_file(tmp_path / "huge.wav", 1_000_000_001)
    assert Attachment(path=path, content_type="audio/wav").sha256 is None
    assert Attachment(bytes(25 * MIB + 1), content_type="audio/wav").sha256 is None
    with client(hue_store) as hue:
        with hue.span("refused") as span:
            span.record_file(role="input", media_type="audio/wav", path=path, upload=True)
            span.record_file(
                role="input", media_type="audio/wav", data=bytes(25 * MIB + 1), upload=True
            )
            span.record_file(role="input", media_type="audio/wav", data=b"x", path=path)
        # Instrumentation issues fail the flush; the span is exported all the same.
        assert not hue.force_flush(timeout_millis=30_000)
        assert hue.export_status.instrumentation_failures == 3
    assert [event.name for event in hue_store.span("refused").events] == []
    assert hue_store.reservations == []
