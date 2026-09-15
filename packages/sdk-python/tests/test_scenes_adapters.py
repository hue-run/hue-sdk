from __future__ import annotations

import asyncio
import json

import httpx
import pytest
import requests
from scenes_server import scene_server

from hue_sdk.scenes import Binding, Scenes, SnapshotMissError
from hue_sdk.scenes.http import http_arguments, safe_url
from hue_sdk.scenes.httpx import AsyncSceneTransport, SceneTransport
from hue_sdk.scenes.mcp import SceneMCPClient
from hue_sdk.scenes.requests import SceneAdapter

TRACE = "1" * 32
REPLAY_TRACE = "2" * 32


@pytest.fixture
def api():
    with scene_server() as server:
        yield server


def setup(api, **kwargs):
    scenes = Scenes(api.url, "synthetic-scenes-key", capture_content=True, **kwargs)
    binding = Binding(
        "files",
        kind="http",
        http_origin=api.source_url,
        path_prefix="/files",
        headers=("x-source-version", "authorization"),
    )
    return scenes, binding


def load(scenes, capture):
    result = capture.finalize()
    assert result.ok, result
    return scenes.load(result.snapshot)


def test_http_identity_ordering_credentials_representation_and_json():
    binding = Binding("files", kind="http", http_origin="https://example.test").wire()
    url = "https://USER:PASS@EXAMPLE.test:443/files?a=1&a=2&token=secret&x=%2F#fragment"
    assert safe_url(url) == "https://example.test/files?a=1&a=2&x=%2F"
    left = http_arguments(
        binding,
        "post",
        url,
        {"Content-Type": "application/json", "Authorization": "secret", "If-Range": '"etag"'},
        b'{"b":2,"a":1}',
    )
    right = http_arguments(
        binding,
        "POST",
        safe_url(url),
        {"content-type": "application/json", "if-range": '"etag"'},
        b'{ "a":1, "b":2 }',
    )
    assert left == right
    assert "authorization" not in left["headers"]
    changed = http_arguments(
        binding,
        "POST",
        safe_url(url),
        {"content-type": "application/json", "if-range": '"other"'},
        b'{"a":1,"b":2}',
    )
    assert changed != left


def test_httpx_stream_status_and_no_live_fallback_inside_owned_scope(api):
    scenes, binding = setup(api)
    with httpx.Client(transport=SceneTransport(scenes), timeout=2) as http:
        with scenes.capture(bindings=[binding], external_trace_id=TRACE) as capture:
            with http.stream("GET", api.source_url + "/files/slow?token=secret") as response:
                assert api.slow_headers.wait(1)
                # Headers arrive while the server withholds the body: injected transport did not
                # secretly drain or clone it before returning control to the application.
                assert not response.is_stream_consumed
                api.slow_release.set()
                assert response.read() == b"observed source document"
            assert http.get(api.source_url + "/files/error").status_code == 503
            assert http.get(api.source_url + "/files/large").content == b"x" * (300 * 1024)
        recording = load(scenes, capture)
        live_before = len(api.source_hits)
        with recording.replay(binding_ids=["files"], external_trace_id=REPLAY_TRACE) as replay:
            response = http.get(api.source_url + "/files/slow?token=new-secret")
            assert response.content == b"observed source document"
            assert "set-cookie" not in response.headers
            assert http.get(api.source_url + "/files/error").status_code == 503
            assert http.get(api.source_url + "/files/large").content == b"x" * (300 * 1024)
            for method, suffix in (("GET", "/files/unrecorded"), ("POST", "/files/error")):
                with pytest.raises(SnapshotMissError, match="unrecorded"):
                    http.request(method, api.source_url + suffix)
            assert len(api.source_hits) == live_before
            # Calls outside the declared source scope remain ordinary live application traffic.
            assert http.get(api.source_url + "/outside").status_code == 200
        assert replay.miss_count == 2 and len(api.source_hits) == live_before + 1
    assert b"new-secret" not in b"".join(request[2] for request in api.requests)
    assert b"do-not-capture" not in b"".join(request[2] for request in api.requests)


def test_httpx_early_close_and_response_limit_are_explicit_incomplete(api):
    scenes, binding = setup(api, max_buffer_bytes=200000)
    with httpx.Client(transport=SceneTransport(scenes)) as http:
        with scenes.capture(bindings=[binding], external_trace_id=TRACE) as capture:
            with http.stream("GET", api.source_url + "/files/slow"):
                api.slow_release.set()
            assert len(http.get(api.source_url + "/files/large").content) == 300 * 1024
        recording = load(scenes, capture)
        finishes = [
            item for item in recording.manifest["observations"] if item["phase"] == "finish"
        ]
        assert {item["omissionReason"] for item in finishes} == {"body_not_consumed", "body_limit"}
        hits = len(api.source_hits)
        with recording.replay(binding_ids=["files"], external_trace_id=REPLAY_TRACE):
            for suffix in ("slow", "large"):
                with pytest.raises(SnapshotMissError, match="incomplete"):
                    http.get(api.source_url + "/files/" + suffix)
        assert len(api.source_hits) == hits


def test_async_httpx_capture_and_replay_preserve_requests(api):
    scenes, binding = setup(api)

    async def exercise():
        async with httpx.AsyncClient(transport=AsyncSceneTransport(scenes)) as http:
            async with scenes.capture(bindings=[binding], external_trace_id=TRACE) as capture:
                response = await http.post(api.source_url + "/files/json", json={"b": 2, "a": 1})
                expected = response.json()
                async with http.stream("GET", api.source_url + "/files/gzip") as compressed:
                    assert await compressed.aread() == b"observed source document"
            result = await capture.afinalize()
            assert result.ok
            recording = await scenes.aload(result.snapshot)
            hits = len(api.source_hits)
            async with recording.replay(binding_ids=["files"], external_trace_id=REPLAY_TRACE):
                response = await http.post(api.source_url + "/files/json", json={"a": 1, "b": 2})
                assert response.json() == expected
                assert (await http.get(api.source_url + "/files/gzip")).content == (
                    b"observed source document"
                )
                with pytest.raises(SnapshotMissError, match="unrecorded"):
                    await http.get(api.source_url + "/files/new")
            assert len(api.source_hits) == hits

    asyncio.run(exercise())


def test_requests_adapter_preserves_lazy_consumption_and_gzip(api):
    scenes, binding = setup(api)
    with requests.Session() as http:
        http.mount("http://", SceneAdapter(scenes))
        with scenes.capture(bindings=[binding], external_trace_id=TRACE) as capture:
            response = http.get(api.source_url + "/files/slow", stream=True, timeout=2)
            assert api.slow_headers.wait(1)
            api.slow_release.set()
            assert response.content == b"observed source document"
            response.close()
            assert http.get(api.source_url + "/files/gzip").content == b"observed source document"
            assert http.get(api.source_url + "/files/error").status_code == 503
        recording = load(scenes, capture)
        hits = len(api.source_hits)
        with recording.replay(binding_ids=["files"], external_trace_id=REPLAY_TRACE):
            assert http.get(api.source_url + "/files/slow").content == b"observed source document"
            assert http.get(api.source_url + "/files/gzip").content == b"observed source document"
            assert http.get(api.source_url + "/files/error").status_code == 503
            with pytest.raises(SnapshotMissError, match="unrecorded"):
                http.delete(api.source_url + "/files/slow")
        assert len(api.source_hits) == hits


def test_multipart_requests_are_nonportable_and_cannot_fall_through(api):
    scenes, binding = setup(api)
    with httpx.Client(transport=SceneTransport(scenes)) as http:
        with scenes.capture(bindings=[binding], external_trace_id=TRACE) as capture:
            assert (
                http.post(
                    api.source_url + "/files/json", files={"source": ("doc.txt", b"document")}
                ).status_code
                == 200
            )
        recording = load(scenes, capture)
        hits = len(api.source_hits)
        with recording.replay(binding_ids=["files"], external_trace_id=REPLAY_TRACE):
            with pytest.raises(SnapshotMissError, match="nonportable"):
                http.post(
                    api.source_url + "/files/json", files={"source": ("doc.txt", b"document")}
                )
        assert len(api.source_hits) == hits


def test_mcp_tools_resources_and_protocol_misses_preserve_live_objects(api):
    scenes, _binding = setup(api)
    operations = ({"name": "search", "inputSchema": {"type": "object"}},)
    calls = []

    class Result:
        def __init__(self, value):
            self.value = value

        def model_dump(self, **_kwargs):
            return self.value

    class Session:
        async def call_tool(self, name, arguments=None):
            async with httpx.AsyncClient() as http:
                response = await http.get(api.source_url + "/files/json")
            calls.append(name)
            return Result({"content": [{"type": "text", "text": response.text}], "isError": False})

        async def list_tools(self):
            return Result({"tools": list(operations)})

        async def read_resource(self, uri):
            return Result({"contents": [{"uri": uri, "text": "observed resource"}]})

    async def exercise():
        mcp = SceneMCPClient(scenes, "mcp-docs", Session())
        binding = Binding("mcp-docs", kind="mcp", operations=operations)
        async with scenes.capture(bindings=[binding], external_trace_id=TRACE) as capture:
            live = await mcp.call_tool("search", {"q": "observed"})
            assert isinstance(live, Result)
            assert isinstance(await mcp.list_tools(), Result)
            assert isinstance(await mcp.read_resource("docs://1"), Result)
        result = await capture.afinalize()
        recording = await scenes.aload(result.snapshot)
        async with recording.replay(
            binding_ids=["mcp-docs"], external_trace_id=REPLAY_TRACE
        ) as replay:
            assert await mcp.call_tool("search", {"q": "observed"}) == live.value
            assert await mcp.list_tools() == {"tools": list(operations)}
            assert (await mcp.read_resource("docs://1"))["contents"][0][
                "text"
            ] == "observed resource"
            miss = await mcp.call_tool("search", {"q": "new"})
            assert miss["isError"] and "HUE_SNAPSHOT_MISS" in json.dumps(miss)
        assert replay.miss_count == 1

    asyncio.run(exercise())
    assert calls == ["search"] and len(api.source_hits) == 1


def test_http_credentials_are_filtered_before_digest_and_capture_queue(api):
    scenes, binding = setup(api)
    headers = {"content-type": "application/json"}
    left = http_arguments(
        binding.wire(),
        "POST",
        api.source_url + "/files/json",
        headers,
        b'{"q":"same","access_token":"first"}',
    )
    right = http_arguments(
        binding.wire(),
        "POST",
        api.source_url + "/files/json",
        headers,
        b'{"access_token":"second","q":"same"}',
    )
    assert left == right
    with httpx.Client(transport=SceneTransport(scenes)) as http:
        with scenes.capture(bindings=[binding], external_trace_id=TRACE) as capture:
            for suffix in ("secrets", "secrets-gzip"):
                assert http.get(api.source_url + "/files/" + suffix).json()["access_token"] == (
                    "source-token"
                )
        recording = load(scenes, capture)
        assert b"source-token" not in b"".join(request[2] for request in api.requests)
        with recording.replay(binding_ids=["files"], external_trace_id=REPLAY_TRACE):
            for suffix in ("secrets", "secrets-gzip"):
                with pytest.raises(SnapshotMissError, match="nonportable"):
                    http.get(api.source_url + "/files/" + suffix)


def test_httpx_recording_replays_compressed_body_in_requests_and_links_source_file(api):
    scenes, binding = setup(api)
    with httpx.Client(transport=SceneTransport(scenes)) as http:
        with scenes.capture(bindings=[binding], external_trace_id=TRACE) as capture:
            assert http.get(api.source_url + "/files/gzip").content == b"observed source document"
            assert http.get(api.source_url + "/files/document.pdf").content.startswith(b"%PDF")
    recording = load(scenes, capture)
    finishes = [item for item in recording.manifest["observations"] if item["phase"] == "finish"]
    document = finishes[1]
    assert document["sources"][0]["relation"] == "tool_source"
    assert document["sources"][0]["artifactId"] == document["result"]["body"]["ref"]["artifactId"]
    assert len(api.artifacts) == 1
    hits = len(api.source_hits)
    with requests.Session() as http:
        http.mount("http://", SceneAdapter(scenes))
        with recording.replay(binding_ids=["files"], external_trace_id=REPLAY_TRACE):
            assert http.get(api.source_url + "/files/gzip").content == b"observed source document"
            assert http.get(api.source_url + "/files/document.pdf").content.startswith(b"%PDF")
    assert len(api.source_hits) == hits
