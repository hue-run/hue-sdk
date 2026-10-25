"""Serving paths use the real async provider client against synthetic HTTP services."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Event, Thread

import pytest
from opentelemetry import trace

from hue_sdk import create_hue_safe


@dataclass
class StreamingProvider:
    url: str = ""
    release: Event = field(default_factory=Event)
    requests: int = 0


@pytest.fixture
def streaming_provider():
    state = StreamingProvider()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            state.requests += 1
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            chunk = {
                "id": "synthetic-completion",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "synthetic-model",
                "choices": [{"index": 0, "delta": {"content": "answer"}, "finish_reason": None}],
            }
            try:
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                self.wfile.flush()
                # Keep the provider connection open so cancellation interrupts a real read.
                if not state.release.wait(5):
                    return
                chunk["choices"] = [{"index": 0, "delta": {}, "finish_reason": "stop"}]
                self.wfile.write(f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n".encode())
                self.wfile.flush()
            except OSError:
                pass  # Early stream close and task cancellation close the client socket.
            finally:
                self.close_connection = True

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    worker = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    worker.start()
    state.url = f"http://127.0.0.1:{server.server_port}/v1"
    try:
        yield state
    finally:
        state.release.set()
        server.shutdown()
        server.server_close()
        worker.join(timeout=1)


@pytest.mark.parametrize("enabled", [True, False])
@pytest.mark.parametrize("capture_content", [True, False])
@pytest.mark.parametrize("collector_outage", [True, False])
@pytest.mark.parametrize("finish", ["complete", "close", "cancel"])
def test_async_provider_stream_preserves_work_cleanup_and_context(
    receiver, streaming_provider, enabled, capture_content, collector_outage, finish, caplog
):
    openai = pytest.importorskip("openai")
    hue = create_hue_safe(
        receiver.url,
        "synthetic-hue-key",
        enabled=enabled,
        capture_content=capture_content,
        live_spans=False,
    )
    operations = []
    cleanup = []
    cancellations = []
    if collector_outage:
        receiver.reply(401, b"synthetic collector refusal")

    async def exercise():
        async with openai.AsyncOpenAI(
            api_key="synthetic-provider-key", base_url=streaming_provider.url, max_retries=0
        ) as provider:

            async def reply():
                with hue.span("request") as request:
                    request.set_input("private-prompt")
                    try:
                        with hue.tool("lookup") as tool:
                            operations.append("lookup")
                            tool.set_output("private-tool-result")
                        with hue.model("synthetic-model", provider="openai"):
                            stream = await provider.chat.completions.create(
                                model="synthetic-model",
                                messages=[{"role": "user", "content": "private-prompt"}],
                                stream=True,
                                extra_query={"private": "private-http-query"},
                            )
                            async with stream:
                                async for chunk in stream:
                                    if text := chunk.choices[0].delta.content:
                                        request.set_output(text)
                                        yield text
                    except asyncio.CancelledError as error:
                        cancellations.append(error)
                        raise
                    finally:
                        cleanup.append("closed")

            with hue.span("parent") as parent:
                if finish == "cancel":
                    first_chunk = asyncio.Event()

                    async def consume():
                        try:
                            async for text in reply():
                                assert text == "answer"
                                first_chunk.set()
                        except asyncio.CancelledError as error:
                            assert error is cancellations[0]
                            assert trace.get_current_span() is parent.otel_span
                            raise

                    task = asyncio.create_task(consume())
                    await first_chunk.wait()
                    # consume() now awaits the provider's next chunk, which the server holds.
                    task.cancel("synthetic-disconnect")
                    with pytest.raises(asyncio.CancelledError):
                        await task
                    # Python 3.10 can replace cancellation when it crosses a Task boundary.
                    # Identity across Hue's cleanup is asserted inside consume(), above.
                    assert task.cancelled()
                else:
                    iterator = reply()
                    assert await anext(iterator) == "answer"
                    if finish == "close":
                        await iterator.aclose()
                    else:
                        streaming_provider.release.set()
                        assert [text async for text in iterator] == []
                assert trace.get_current_span() is parent.otel_span
        assert trace.get_current_span() is trace.INVALID_SPAN

    async def bounded_exercise():
        # Advance and close the generator in one task so OTel context tokens keep their owner.
        await asyncio.wait_for(exercise(), timeout=3)

    try:
        asyncio.run(bounded_exercise())
        assert operations == ["lookup"]
        assert cleanup == ["closed"]
        assert streaming_provider.requests == 1
        assert hue.force_flush_safe(timeout_millis=1000) is (not enabled or not collector_outage)
    finally:
        streaming_provider.release.set()
        assert hue.shutdown_safe(timeout_millis=1000) is (not enabled or not collector_outage)
    assert "Failed to detach context" not in caplog.text
    if enabled:
        spans = receiver.spans()
        assert sorted(span.name for span in spans) == [
            "POST",
            "chat synthetic-model",
            "execute_tool lookup",
            "parent",
            "request",
        ]
        http = next(span for span in spans if span.name == "POST")
        model = next(span for span in spans if span.name == "chat synthetic-model")
        fields = {item.key: item.value for item in http.attributes}
        assert http.kind == 3
        assert http.parent_span_id == model.span_id
        assert fields["http.request.method"].string_value == "POST"
        assert fields["url.full"].string_value == streaming_provider.url + "/chat/completions"
        assert fields["http.response.status_code"].int_value == 200
        assert "input.value" not in fields and "output.value" not in fields
        exported = b"".join(body for path, _, body in receiver.requests if path.endswith("/traces"))
        assert (b"private-prompt" in exported) is capture_content
        assert b"synthetic-provider-key" not in exported
        assert b"private-http-query" not in exported
        assert b"synthetic-disconnect" not in exported
    else:
        assert not receiver.requests
