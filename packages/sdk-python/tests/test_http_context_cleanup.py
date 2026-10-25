from __future__ import annotations

import asyncio

import pytest
from opentelemetry import trace

from hue_sdk import Hue
from hue_sdk._http_capture import client_scope


def scope(hue, kind):
    if kind == "model":
        return hue.model("synthetic-model", provider="synthetic")
    if kind == "tool":
        return hue.tool("synthetic-tool")
    return hue.span("synthetic-stream")


def context_state(hue):
    return (
        trace.get_current_span(),
        client_scope.get(),
        hue._http_parent.get(),
        hue._http_model_scope.get(),
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
