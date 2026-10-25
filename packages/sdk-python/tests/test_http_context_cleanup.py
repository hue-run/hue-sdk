from __future__ import annotations

import asyncio
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest
import requests
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from hue_sdk import Hue
from hue_sdk._http_scope import model_for, scope_for


def scope(hue, kind):
    if kind == "model":
        return hue.model("synthetic-model", provider="synthetic")
    if kind == "tool":
        return hue.tool("synthetic-tool")
    return hue.span("synthetic-stream")


def context_state(hue):
    frame = scope_for()
    return (
        trace.get_current_span(),
        frame,
        frame.client if frame is not None else None,
        frame.span if frame is not None else None,
        model_for(hue),
    )


@pytest.mark.parametrize("kind", ("span", "tool", "model"))
@pytest.mark.parametrize("enabled", (False, True))
@pytest.mark.parametrize("other_task", (False, True))
def test_async_generator_close_preserves_cleanup(receiver, kind, enabled, other_task):
    parent = trace.get_current_span()
    with Hue(receiver.url, "synthetic-cleanup-key", enabled=enabled, live_spans=False) as hue:

        async def run():
            before = trace.get_current_span()

            async def response():
                with scope(hue, kind):
                    yield b"synthetic-chunk"

            generator = response()
            assert await anext(generator) == b"synthetic-chunk"
            if other_task:

                async def close():
                    with hue.tool("cleanup-task"):
                        before_cleanup = context_state(hue)
                        await generator.aclose()
                        assert context_state(hue) == before_cleanup

                await asyncio.create_task(close())
            else:
                await generator.aclose()
                assert trace.get_current_span() is before

        asyncio.run(run())
        assert trace.get_current_span() is parent
        flushed = hue.force_flush()
        assert hue.export_status.failed_trace_batches == 0
        assert hue.export_status.queued_trace_records == 0
        if not other_task:
            assert flushed
    assert len(receiver.spans()) == int(enabled) * (2 if other_task else 1)


@pytest.mark.parametrize("kind", ("span", "tool", "model"))
@pytest.mark.parametrize("enabled", (False, True))
def test_cross_task_generator_error_preserves_original_exception(receiver, kind, enabled):
    error = RuntimeError("synthetic-disconnect")
    with Hue(receiver.url, "synthetic-cleanup-key", enabled=enabled, live_spans=False) as hue:

        async def run():
            async def response():
                with scope(hue, kind):
                    yield b"synthetic-chunk"

            generator = response()
            assert await anext(generator) == b"synthetic-chunk"

            async def close():
                with hue.tool("cleanup-task"):
                    before_cleanup = context_state(hue)
                    with pytest.raises(RuntimeError) as caught:
                        await generator.athrow(error)
                    assert caught.value is error
                    assert context_state(hue) == before_cleanup

            await asyncio.create_task(close())

        asyncio.run(run())
        hue.force_flush()
        assert hue.export_status.failed_trace_batches == 0
        assert hue.export_status.queued_trace_records == 0
    assert len(receiver.spans()) == int(enabled) * 2


@pytest.fixture
def http_app():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = b'{"ok":true,"id":"synthetic-context-item"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(5)


@pytest.mark.parametrize("kind", ("span", "tool", "model"))
@pytest.mark.parametrize("other_task", (False, True))
@pytest.mark.parametrize("throws", (False, True))
def test_closed_generator_scope_does_not_disable_later_http_capture(
    receiver, http_app, kind, other_task, throws
):
    with Hue(receiver.url, "synthetic-first-key", live_spans=False) as first:

        async def run():
            async def response():
                with scope(first, kind):
                    yield b"synthetic-chunk"

            generator = response()
            assert await anext(generator) == b"synthetic-chunk"

            async def close():
                if throws:
                    error = RuntimeError("synthetic-disconnect")
                    with pytest.raises(RuntimeError) as caught:
                        await generator.athrow(error)
                    assert caught.value is error
                else:
                    await generator.aclose()

            if other_task:
                await asyncio.create_task(close())
            else:
                await close()
            assert scope_for() is None
            assert model_for(first) is None
            assert requests.get(http_app + "/after-close?phase=origin").json() == {
                "ok": True,
                "id": "synthetic-context-item",
            }
            first.force_flush()
            first.shutdown_safe()
            with Hue(receiver.url, "synthetic-second-key", live_spans=False) as second:
                assert requests.get(http_app + "/fresh-client?phase=fresh").json() == {
                    "ok": True,
                    "id": "synthetic-context-item",
                }
                assert second.force_flush()

        asyncio.run(run())
    calls = []
    for span in receiver.spans():
        fields = {item.key: item.value.string_value for item in span.attributes}
        if fields.get("http.request.method"):
            calls.append((span, fields))
    assert len(calls) == 2
    for path, phase in (("/after-close", "origin"), ("/fresh-client", "fresh")):
        ((span, fields),) = [call for call in calls if call[1]["url.full"] == http_app + path]
        assert not span.parent_span_id
        assert json.loads(fields["input.value"]) == {"phase": phase}
        assert json.loads(fields["output.value"]) == {"ok": True, "id": "synthetic-context-item"}


@pytest.mark.parametrize(
    ("resume", "close_first"), (("task", True), ("callback", True), ("task", False))
)
def test_detached_work_keeps_original_client_ownership(receiver, http_app, resume, close_first):
    providers = [TracerProvider(shutdown_on_exit=False) for _ in range(2)]
    exported = [InMemorySpanExporter() for _ in providers]
    for provider, exporter in zip(providers, exported, strict=True):
        provider.add_span_processor(SimpleSpanProcessor(exporter))
    try:
        with Hue(
            receiver.url, "synthetic-first-key", tracer_provider=providers[0], live_spans=False
        ) as first:

            async def run():
                def work():
                    assert requests.get(http_app + "/detached").content == (
                        b'{"ok":true,"id":"synthetic-context-item"}'
                    )
                    assert not exported[1].get_finished_spans()
                    with second.tool("explicit-b"):
                        assert requests.get(http_app + "/explicit-b").content == (
                            b'{"ok":true,"id":"synthetic-context-item"}'
                        )

                async def detached():
                    work()

                loop = asyncio.get_running_loop()
                with first.tool("owned-work") as owner:
                    if resume == "task":
                        resumed = asyncio.create_task(detached())
                    else:
                        resumed = loop.create_future()

                        def callback():
                            try:
                                work()
                            except BaseException as error:
                                resumed.set_exception(error)
                            else:
                                resumed.set_result(None)

                        loop.call_soon(callback)
                if close_first:
                    assert first.shutdown_safe()
                with Hue(
                    receiver.url,
                    "synthetic-second-key",
                    tracer_provider=providers[1],
                    live_spans=False,
                ) as second:
                    await resumed
                    assert second.force_flush()
                if not close_first:
                    assert first.force_flush()
                a_spans = exported[0].get_finished_spans()
                b_spans = exported[1].get_finished_spans()
                assert len(a_spans) == (1 if close_first else 2)
                assert len(b_spans) == 2
                b_calls = [span for span in b_spans if "http.request.method" in span.attributes]
                assert len(b_calls) == 1
                assert b_calls[0].attributes["url.full"] == http_app + "/explicit-b"
                if not close_first:
                    (call,) = [span for span in a_spans if "http.request.method" in span.attributes]
                    assert call.attributes["url.full"] == http_app + "/detached"
                    assert call.parent.span_id == int(owner.span_id, 16)
                    assert json.loads(call.attributes["output.value"]) == {
                        "ok": True,
                        "id": "synthetic-context-item",
                    }

            asyncio.run(run())
    finally:
        for provider in providers:
            provider.shutdown()
