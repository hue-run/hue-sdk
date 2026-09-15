"""Optional adapter compatibility against a synthetic provider served over HTTP."""

from __future__ import annotations

import json

import pytest

from hue_sdk import Hue


@pytest.mark.parametrize("capture_content", [True, False])
def test_openinference_official_openai_stream_exports_to_hue(receiver, capture_content):
    openai = pytest.importorskip("openai")
    instrumentation = pytest.importorskip("openinference.instrumentation")
    adapter = pytest.importorskip("openinference.instrumentation.openai")
    chunks = [
        {
            "id": "synthetic-completion",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "synthetic-model",
            "choices": [
                {
                    "index": 0,
                    "delta": {"role": "assistant", "content": "private-answer"},
                    "finish_reason": None,
                }
            ],
        },
        {
            "id": "synthetic-completion",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "synthetic-model",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        },
        {
            "id": "synthetic-completion",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "synthetic-model",
            "choices": [],
            "usage": {"prompt_tokens": 8, "completion_tokens": 3, "total_tokens": 11},
        },
    ]
    body = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks) + "data: [DONE]\n\n"
    receiver.reply(200, body.encode(), **{"Content-Type": "text/event-stream"})
    instrumentor = adapter.OpenAIInstrumentor()
    with Hue(receiver.url, "synthetic-hue-key", capture_content=capture_content) as hue:
        # External instrumentation owns its privacy settings independently of Hue helpers.
        instrumentor.instrument(
            tracer_provider=hue.tracer_provider,
            config=instrumentation.TraceConfig(
                hide_inputs=not capture_content,
                hide_outputs=not capture_content,
                hide_input_messages=not capture_content,
                hide_output_messages=not capture_content,
                enable_genai_semconv=True,
            ),
        )
        try:
            with openai.OpenAI(
                api_key="synthetic-provider-key", base_url=receiver.url + "/v1"
            ) as provider:
                with hue.span("external-instrumentation"):
                    with provider.chat.completions.create(
                        model="synthetic-model",
                        messages=[{"role": "user", "content": "private-prompt"}],
                        stream=True,
                        stream_options={"include_usage": True},
                    ) as stream:
                        received = list(stream)
                        assert received[0].choices[0].delta.content == "private-answer"
            assert hue.force_flush()
        finally:
            instrumentor.uninstrument()
    spans = receiver.spans()
    assert len(spans) == 2
    root = next(span for span in spans if span.name == "external-instrumentation")
    generated = next(span for span in spans if span.name != "external-instrumentation")
    assert generated.parent_span_id == root.span_id and generated.trace_id == root.trace_id
    attributes = {item.key: item.value for item in generated.attributes}
    assert attributes["gen_ai.request.model"].string_value == "synthetic-model"
    assert attributes["gen_ai.usage.input_tokens"].int_value == 8
    assert attributes["gen_ai.usage.output_tokens"].int_value == 3
    telemetry = b"".join(data for path, _, data in receiver.requests if path.endswith("/traces"))
    if capture_content:
        assert b"private-prompt" in telemetry and b"private-answer" in telemetry
    else:
        assert b"private-prompt" not in telemetry and b"private-answer" not in telemetry
