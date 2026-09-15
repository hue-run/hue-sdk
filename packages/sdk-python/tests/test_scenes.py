from __future__ import annotations

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from pathlib import Path
from threading import Event, Thread

import pytest
from jsonschema import Draft202012Validator
from scenes_server import scene_server

from hue_sdk import Hue
from hue_sdk.scenes import (
    ABSENT,
    Binding,
    RecordedToolError,
    Recording,
    Scenes,
    Snapshot,
    SnapshotMissError,
    SourceFile,
    canonical_json,
    request_key,
)

TRACE = "1" * 32
REPLAY_TRACE = "2" * 32


@pytest.fixture
def scene_api():
    with scene_server() as server:
        yield server


def client(server, **kwargs):
    return Scenes(server.url, "synthetic-scenes-key", capture_content=True, **kwargs)


def loaded(scenes, capture):
    result = capture.finalize()
    assert result.ok, result
    return scenes.load(result.snapshot)


def test_cross_language_golden_and_jcs_boundaries():
    fixture = Path(__file__).parents[3] / "spec/scenes/v1/fixtures.json"
    values = json.loads(fixture.read_text())
    for item in values["canonical"]:
        assert canonical_json(item["value"]).decode() == item["canonical"]
    for item in values["matching"]:
        args = item["arguments"]
        assert (
            request_key(
                args["bindingId"], args["operation"], args["contractVersion"], args["arguments"]
            )
            == item["sha256"]
        )
    schema = json.loads(fixture.with_name("schema.json").read_text())
    packaged = Path(__file__).parents[1] / "src/hue_sdk/scenes/_schema.json"
    assert json.loads(packaged.read_text()) == schema
    for item in values["schemaCases"]:
        validator = Draft202012Validator({**schema, "$ref": "#/$defs/" + item["definition"]})
        assert validator.is_valid(item["value"]) is item["valid"]
    from hue_sdk.scenes.http import http_arguments

    binding = Binding("files", kind="http", http_origin="https://example.test").wire()
    for item in values["httpBodies"]:
        if item["sha256"] is None:
            with pytest.raises(ValueError):
                http_arguments(
                    binding,
                    "POST",
                    "https://example.test/files",
                    {"content-type": item["contentType"]},
                    item["body"].encode(),
                )
        else:
            args = http_arguments(
                binding,
                "POST",
                "https://example.test/files",
                {"content-type": item["contentType"]},
                item["body"].encode(),
            )
            assert args["bodySha256"] == item["sha256"]
    assert canonical_json({"x": -0.0, "y": 1e-6, "z": 1e-7}) == (b'{"x":0,"y":0.000001,"z":1e-7}')
    assert canonical_json({"\ue000": 1, "\U00010000": 2}).decode() == '{"𐀀":2,"\ue000":1}'
    for value in (float("nan"), float("inf"), 2**53, 1e20, {"bad": object()}, "\ud800"):
        with pytest.raises(ValueError):
            canonical_json(value)


def test_capture_opt_in_is_separate_and_trace_is_inherited(scene_api):
    disabled = Scenes(scene_api.url, "synthetic-scenes-key", capture_content=False)
    with pytest.raises(ValueError):
        disabled.capture(bindings=[Binding("docs")], external_trace_id=TRACE)
    # No global tracer provider changes, even when trace content is disabled.
    scenes = client(scene_api)
    with Hue(scene_api.url, "synthetic-scenes-key", capture_content=False) as hue:
        with hue.span("agent") as span:
            with scenes.capture(bindings=[Binding("docs")]) as capture:
                assert scenes.call("docs", "fetch", {"q": "secret source"}, lambda: None) is None
        recording = loaded(scenes, capture)
        assert recording.manifest["externalTraceId"] == span.trace_id
        assert recording.manifest["capturePolicy"] == {
            "sourceContent": True,
            "redactionVersion": "1",
        }
        assert all(
            item["externalSpanId"] == span.span_id for item in recording.manifest["observations"]
        )


def test_live_values_errors_sanitization_and_presence(scene_api):
    scenes = client(scene_api)
    expected_error = RuntimeError("do not export this secret")
    value = {"nested": {"value": 1}}
    with scenes.capture(bindings=[Binding("docs")], external_trace_id=TRACE, input=None) as capture:
        result = scenes.call("docs", "get", {"q": "a", "api_key": "hidden"}, lambda: value)
        assert result is value
        value["nested"]["value"] = 99
        assert scenes.call("docs", "absent", {}, lambda: ABSENT) is ABSENT
        assert scenes.call("docs", "empty", {}, lambda: b"") == b""
        scenes.call("docs", "redacted", {}, lambda: {"token": "sensitive"})

        def fail():
            raise expected_error

        with pytest.raises(RuntimeError) as caught:
            scenes.call("docs", "error", {}, fail)
        assert caught.value is expected_error
    recording = loaded(scenes, capture)
    wire = b"".join(request[2] for request in scene_api.requests)
    assert all(
        secret not in wire for secret in (b"private", b"sensitive", b"hidden", b"do not export")
    )
    assert recording.manifest["input"] == {"kind": "json", "value": None}
    with recording.replay(binding_ids=["docs"], external_trace_id=REPLAY_TRACE) as replay:
        assert scenes.call("docs", "get", {"q": "a", "api_key": "changed"}, fail) == {
            "nested": {"value": 1}
        }
        assert scenes.call("docs", "absent", {}, fail) is ABSENT
        assert scenes.call("docs", "empty", {}, fail) == b""
        with pytest.raises(SnapshotMissError, match="nonportable"):
            scenes.call("docs", "redacted", {}, fail)
        with pytest.raises(RecordedToolError) as caught_recorded:
            scenes.call("docs", "error", {}, fail)
        assert caught_recorded.value.error_type == "RuntimeError"
    assert replay.delivery_ok


def test_fifo_reordering_caught_misses_and_fresh_cursors(scene_api):
    scenes = client(scene_api)
    with scenes.capture(bindings=[Binding("docs")], external_trace_id=TRACE) as capture:
        for args, value in (({"q": "a"}, 1), ({"q": "b"}, 2), ({"q": "a"}, 3)):
            scenes.call("docs", "find", args, lambda value=value: value)
    recording = loaded(scenes, capture)
    live = []
    with recording.replay(binding_ids=["docs"], external_trace_id=REPLAY_TRACE) as replay:
        assert scenes.call("docs", "find", {"q": "b"}, lambda: live.append(True)) == 2
        assert scenes.call("docs", "find", {"q": "a"}, lambda: live.append(True)) == 1
        assert scenes.call("docs", "find", {"q": "a"}, lambda: live.append(True)) == 3
        for args, reason in (({"q": "a"}, "exhausted"), ({"q": "new"}, "unrecorded")):
            with pytest.raises(SnapshotMissError) as caught:
                scenes.call("docs", "find", args, lambda: live.append(True))
            assert caught.value.reason == reason
    assert live == [] and replay.miss_count == 2
    remote = next(iter(scene_api.replays.values()))
    assert remote["state"] == "completed"
    assert [event["reason"] for event in remote["events"] if event["status"] == "miss"] == [
        "exhausted",
        "unrecorded",
    ]
    assert replay.complete()  # Idempotent diagnostics resend does not duplicate or rerun calls.
    assert len(remote["events"]) == 5
    with recording.replay(binding_ids=["docs"], external_trace_id="3" * 32):
        assert scenes.call("docs", "find", {"q": "a"}, lambda: live.append(True)) == 1


def test_budget_and_sanitizer_failures_leave_application_untouched(scene_api):
    def bad_sanitizer(_field, _value):
        raise RuntimeError("private sanitizer exception")

    scenes = client(scene_api, sanitizer=bad_sanitizer, max_records=1, max_buffer_bytes=512)
    error = ValueError("original")
    with scenes.capture(bindings=[Binding("docs")], external_trace_id=TRACE) as capture:
        assert scenes.call("docs", "get", {}, lambda: "live") == "live"

        def fail():
            raise error

        with pytest.raises(ValueError) as caught:
            scenes.call("docs", "get", {}, fail)
        assert caught.value is error
    result = capture.finalize()
    assert result.ok and result.dropped > 0 and result.pending == 0
    assert b"private sanitizer exception" not in b"".join(r[2] for r in scene_api.requests)


def test_tools_nested_capture_and_selection_conflict(scene_api):
    scenes = client(scene_api)
    hits = []

    @scenes.tool("inner")
    def read_doc(query="default"):
        hits.append(query)
        return {"content": query}

    @scenes.tool("outer")
    def retrieve(query):
        return read_doc(query)

    with scenes.capture(
        bindings=[Binding("outer"), Binding("inner")], external_trace_id=TRACE
    ) as capture:
        retrieve("observed")
    recording = loaded(scenes, capture)
    with pytest.raises(SnapshotMissError) as caught:
        recording.replay(binding_ids=["outer", "inner"], external_trace_id=REPLAY_TRACE)
    assert caught.value.reason == "overlapping_bindings"
    with recording.replay(binding_ids=["outer"], external_trace_id=REPLAY_TRACE):
        assert retrieve("observed") == {"content": "observed"}
    assert hits == ["observed"]
    with recording.replay(binding_ids=["inner"], external_trace_id="3" * 32):
        assert retrieve("observed") == {"content": "observed"}
    assert hits == ["observed"]


def test_async_context_inheritance_parallel_ambiguity_and_cancellation(scene_api):
    scenes = client(scene_api)
    error = asyncio.CancelledError("cancelled by caller")

    async def exercise():
        gate = asyncio.Event()
        entered = 0

        @scenes.tool("docs", "read", arguments=lambda value: {"q": "same"})
        async def read(value):
            nonlocal entered
            entered += 1
            if entered == 2:
                gate.set()
            await gate.wait()
            return value

        async def cancel():
            raise error

        async with scenes.capture(bindings=[Binding("docs")], external_trace_id=TRACE) as capture:
            assert await asyncio.gather(read(1), read(2)) == [1, 2]
            assert await asyncio.to_thread(scenes.call, "docs", "thread", {}, lambda: "inherited")
            with pytest.raises(asyncio.CancelledError) as caught:
                await scenes.acall("docs", "cancel", {}, cancel)
            assert caught.value is error
        result = await capture.afinalize()
        recording = await scenes.aload(result.snapshot)
        async with recording.replay(binding_ids=["docs"], external_trace_id=REPLAY_TRACE):
            with pytest.raises(SnapshotMissError) as caught_miss:
                await read(1)
            assert caught_miss.value.reason == "ambiguous"
            assert await asyncio.to_thread(scenes.call, "docs", "thread", {}, lambda: "live") == (
                "inherited"
            )
            with pytest.raises(SnapshotMissError) as cancelled:
                await scenes.acall("docs", "cancel", {}, cancel)
            assert cancelled.value.reason == "incomplete"
        return recording

    recording = asyncio.run(exercise())
    assert len(recording.manifest["observations"]) == 8


def test_async_stream_is_pull_only_and_partial_revision_stays_immutable(scene_api):
    scenes = client(scene_api)
    pulls = []

    @scenes.tool("docs")
    async def documents():
        for item in (None, {"content": 1}, b"bytes"):
            pulls.append(item)
            yield item

    async def exercise():
        with scenes.capture(bindings=[Binding("docs")], external_trace_id=TRACE) as capture:
            stream = documents()
            assert pulls == []
            assert await anext_310(stream) is None
            initial = await capture.afinalize()
            assert initial.pending == 1
            assert [value async for value in stream] == [{"content": 1}, b"bytes"]
        final = await capture.afinalize()
        first = await scenes.aload(initial.snapshot)
        last = await scenes.aload(final.snapshot)
        assert first.snapshot.revision != last.snapshot.revision
        async with first.replay(binding_ids=["docs"], external_trace_id=REPLAY_TRACE):
            with pytest.raises(SnapshotMissError) as caught:
                documents()
            assert caught.value.reason == "incomplete"
        async with last.replay(binding_ids=["docs"], external_trace_id="3" * 32):
            assert [value async for value in documents()] == [None, {"content": 1}, b"bytes"]

    asyncio.run(exercise())
    assert pulls == [None, {"content": 1}, b"bytes"]


async def anext_310(iterator):
    return await iterator.__anext__()


def test_large_payload_sources_hashes_and_load_integrity(scene_api, tmp_path):
    scenes = client(scene_api)
    binary = b"source\x00" * 50000
    source_path = tmp_path / "observed.pdf"
    source_path.write_bytes(b"synthetic document")
    with scenes.capture(bindings=[Binding("docs")], external_trace_id=TRACE) as capture:
        assert capture.add_source(SourceFile.from_path(source_path, mime_type="application/pdf"))
        assert capture.add_source(
            SourceFile("reference", uri="https://files.test/doc?token=secret")
        )
        scenes.call("docs", "read", {}, lambda: binary)
    recording = loaded(scenes, capture)
    assert len(scene_api.artifacts) == 2
    assert all(
        artifact["purpose"] in {"source", "scene_payload"}
        for artifact in scene_api.artifacts.values()
    )
    assert recording.manifest["sources"][1]["content"] == "reference_only"
    with recording.replay(binding_ids=["docs"], external_trace_id=REPLAY_TRACE):
        assert scenes.call("docs", "read", {}, lambda: b"live") == binary
    scene_api.corrupt_download = True
    with recording.replay(binding_ids=["docs"], external_trace_id="3" * 32):
        with pytest.raises(SnapshotMissError) as caught:
            scenes.call("docs", "read", {}, lambda: b"live")
        assert caught.value.reason == "integrity"
    manifest = recording.manifest
    manifest["observations"] = []
    with pytest.raises(SnapshotMissError, match="integrity"):
        Recording(manifest, recording.snapshot.digest)
    wrong = Snapshot(recording.snapshot.scene_id, recording.snapshot.revision, "0" * 64)
    with pytest.raises(SnapshotMissError, match="integrity"):
        scenes.load(wrong)


def test_failed_ack_retry_and_artifact_verification(scene_api):
    scenes = client(scene_api)
    with scenes.capture(bindings=[Binding("docs")], external_trace_id=TRACE) as capture:
        scenes.call("docs", "read", {}, lambda: {"content": "recorded"})
    scene_api.reject_observation_once = True
    assert not capture.finalize().ok
    recording = loaded(scenes, capture)
    assert len(recording.manifest["observations"]) == 2
    other = scenes.capture(bindings=[Binding("docs")], external_trace_id="4" * 32)
    with other:
        scenes.call("docs", "bytes", {}, lambda: b"x" * 300000)
    scene_api.bad_verified_hash = True
    assert not other.finalize().ok


def test_same_result_parallel_calls_consume_atomically(scene_api):
    scenes = client(scene_api)
    with scenes.capture(bindings=[Binding("docs")], external_trace_id=TRACE) as capture:
        for _ in range(40):
            scenes.call("docs", "read", {}, lambda: "observed")
    recording = loaded(scenes, capture)
    with recording.replay(binding_ids=["docs"], external_trace_id=REPLAY_TRACE) as replay:
        with ThreadPoolExecutor(max_workers=8) as workers:
            results = list(workers.map(lambda _: replay.dispatch("docs", "read", {}), range(40)))
        assert results == ["observed"] * 40
        with pytest.raises(SnapshotMissError, match="exhausted"):
            replay.dispatch("docs", "read", {})


def test_contract_mismatch_and_modified_selection_cannot_enable_live_fallback(scene_api):
    scenes = client(scene_api)
    calls = []
    with scenes.capture(bindings=[Binding("docs")], external_trace_id=TRACE) as capture:
        scenes.call("docs", "read", {"key": "one"}, lambda: 1)
    recording = loaded(scenes, capture)
    with recording.replay(binding_ids=["docs"], external_trace_id=REPLAY_TRACE) as replay:
        replay.selected.clear()
        with pytest.raises(SnapshotMissError, match="incompatible"):
            scenes.call(
                "docs", "read", {"key": "one"}, lambda: calls.append(True), contract_version="2"
            )
        with pytest.raises(SnapshotMissError, match="unrecorded"):
            scenes.call("docs", "read", {"key": "two"}, lambda: calls.append(True))
        assert scenes.call("docs", "read", {"key": "one"}, lambda: calls.append(True)) == 1
    assert calls == []


def test_independent_producer_different_outcomes_are_ambiguous(scene_api):
    scenes = client(scene_api)
    with scenes.capture(bindings=[Binding("docs")], external_trace_id=TRACE) as capture:
        scenes.call("docs", "read", {}, lambda: 1)
        scenes.call("docs", "read", {}, lambda: 2)
    manifest = loaded(scenes, capture).manifest
    for observation in manifest["observations"][2:]:
        observation["producerId"] = "other-producer"
    recording = Recording(manifest, sha256(canonical_json(manifest)).hexdigest())
    with recording.replay(binding_ids=["docs"], external_trace_id=REPLAY_TRACE) as replay:
        with pytest.raises(SnapshotMissError, match="ambiguous"):
            replay.dispatch("docs", "read", {})


def test_completion_waits_for_inflight_blob_and_exports_its_event(scene_api):
    scenes = client(scene_api)
    with scenes.capture(bindings=[Binding("docs")], external_trace_id=TRACE) as capture:
        scenes.call("docs", "read", {}, lambda: b"x" * 300000)
    source = loaded(scenes, capture)
    entered, release, completed = Event(), Event(), Event()

    def artifact_loader(_ref):
        entered.set()
        assert release.wait(2)
        return b"x" * 300000

    recording = Recording(
        source.manifest, source.snapshot.digest, scenes=scenes, artifact_loader=artifact_loader
    )
    with recording.replay(binding_ids=["docs"], external_trace_id=REPLAY_TRACE) as replay:
        worker = Thread(target=lambda: replay.dispatch("docs", "read", {}))
        worker.start()
        assert entered.wait(1)
        completion = Thread(target=lambda: (replay.complete(state="interrupted"), completed.set()))
        completion.start()
        assert not completed.wait(0.05)
        release.set()
        worker.join(2)
        completion.join(2)
        assert completed.is_set() and replay.delivery_ok
    remote = next(iter(scene_api.replays.values()))
    assert remote["state"] == "interrupted" and remote["events"][0]["status"] == "matched"


def test_25_mib_blob_round_trip_and_larger_live_result_is_omitted(scene_api):
    scenes = client(scene_api)
    content = b"d" * (25 * 1024 * 1024)
    with scenes.capture(bindings=[Binding("docs")], external_trace_id=TRACE) as capture:
        assert scenes.call("docs", "read", {}, lambda: content) is content
        oversized = content + b"!"
        assert scenes.call("docs", "large", {}, lambda: oversized) is oversized
    recording = loaded(scenes, capture)
    with recording.replay(binding_ids=["docs"], external_trace_id=REPLAY_TRACE):
        assert scenes.call("docs", "read", {}, lambda: b"live") == content
        with pytest.raises(SnapshotMissError, match="nonportable"):
            scenes.call("docs", "large", {}, lambda: b"live")
    assert [artifact["byteSize"] for artifact in scene_api.artifacts.values()] == [len(content)]


def test_capture_hook_cancellation_and_async_context_isolation(scene_api):
    def sanitizer(field, value):
        if field == "result":
            raise asyncio.CancelledError("hook cancellation")
        return value

    scenes = client(scene_api, sanitizer=sanitizer)

    async def one(trace_value, value):
        async with scenes.capture(
            bindings=[Binding("docs")], external_trace_id=trace_value
        ) as capture:
            await asyncio.sleep(0)

            async def source():
                return value

            assert await scenes.acall("docs", "read", {}, source) == value
        return await capture.afinalize()

    async def exercise():
        return await asyncio.gather(one(TRACE, 1), one(REPLAY_TRACE, 2))

    results = asyncio.run(exercise())
    assert all(result.ok for result in results)
    assert results[0].snapshot.scene_id != results[1].snapshot.scene_id
    for result in results:
        assert len(scenes.load(result.snapshot).manifest["observations"]) == 2


def test_finalization_refreshes_concurrent_revision_and_reuses_successful_pin(scene_api):
    scenes = client(scene_api)
    with scenes.capture(bindings=[Binding("docs")], external_trace_id=TRACE) as capture:
        scenes.call("docs", "read", {}, lambda: "observed")
    scene_api.conflict_finalize_once = True
    first = capture.finalize()
    assert first.ok
    assert capture.finalize().snapshot == first.snapshot


def test_argument_evidence_is_verified_and_blob_storage_ids_do_not_create_ambiguity(scene_api):
    scenes = client(scene_api)
    content = b"x" * 300000
    with scenes.capture(bindings=[Binding("docs")], external_trace_id=TRACE) as capture:
        scenes.call("docs", "read", {"q": "observed"}, lambda: content)
        scenes.call("docs", "read", {"q": "observed"}, lambda: content)
    manifest = loaded(scenes, capture).manifest
    observations = manifest["observations"]
    observations[1]["sequence"], observations[2]["sequence"] = 3, 2
    observations[3]["result"]["ref"]["artifactId"] = "another-artifact-same-bytes"
    recording = Recording(
        manifest, sha256(canonical_json(manifest)).hexdigest(), artifact_loader=lambda _ref: content
    )
    with recording.replay(binding_ids=["docs"], external_trace_id=REPLAY_TRACE) as replay:
        assert replay.dispatch("docs", "read", {"q": "observed"}) == content
        assert replay.dispatch("docs", "read", {"q": "observed"}) == content
    observations[0]["arguments"]["value"] = {"q": "altered-evidence"}
    corrupt = Recording(
        manifest, sha256(canonical_json(manifest)).hexdigest(), artifact_loader=lambda _ref: content
    )
    with corrupt.replay(binding_ids=["docs"], external_trace_id="3" * 32) as replay:
        with pytest.raises(SnapshotMissError, match="integrity"):
            replay.dispatch("docs", "read", {"q": "observed"})


def test_stream_failure_keeps_observed_items_and_original_exception(scene_api):
    scenes = client(scene_api)
    error = RuntimeError("original stream error")

    @scenes.tool("docs")
    async def stream():
        yield {"content": "observed before failure"}
        raise error

    async def exercise():
        with scenes.capture(bindings=[Binding("docs")], external_trace_id=TRACE) as capture:
            items = stream()
            assert await items.__anext__() == {"content": "observed before failure"}
            with pytest.raises(RuntimeError) as caught:
                await items.__anext__()
            assert caught.value is error
        result = await capture.afinalize()
        recording = await scenes.aload(result.snapshot)
        finish = recording.manifest["observations"][1]
        assert finish["result"]["items"][0]["value"] == {"content": "observed before failure"}
        assert not finish["replayable"]
        async with recording.replay(binding_ids=["docs"], external_trace_id=REPLAY_TRACE):
            with pytest.raises(SnapshotMissError, match="incomplete"):
                stream()

    asyncio.run(exercise())
