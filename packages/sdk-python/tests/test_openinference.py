"""Optional adapter compatibility against a synthetic provider served over HTTP."""

from __future__ import annotations

import json

import pytest

from hue_sdk import Hue


@pytest.mark.parametrize(
    ("capture_content", "instrumentor_hides"),
    [(True, True), (False, True), (False, False)],
)
def test_openinference_official_openai_stream_exports_to_hue(
    receiver, capture_content, instrumentor_hides
):
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
        # External instrumentation owns its privacy settings; when it does not hide content,
        # Hue's export path still strips the recognized content attributes in metadata-only mode.
        hide = instrumentor_hides and not capture_content
        instrumentor.instrument(
            tracer_provider=hue.tracer_provider,
            config=instrumentation.TraceConfig(
                hide_inputs=hide,
                hide_outputs=hide,
                hide_input_messages=hide,
                hide_output_messages=hide,
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


@pytest.mark.parametrize("capture_content", [True, False])
def test_openinference_responses_hosted_mcp_tool_exports_without_credentials(
    receiver, capture_content
):
    openai = pytest.importorskip("openai")
    instrumentation = pytest.importorskip("openinference.instrumentation")
    adapter = pytest.importorskip("openinference.instrumentation.openai")
    hosted_mcp = {
        "type": "mcp",
        "server_label": "gmail",
        "server_url": "https://mcp.example.test/gmail",
        "authorization": "synthetic-oauth-token",
        "headers": {"X-Api-Key": "synthetic-header-secret"},
        "require_approval": "never",
    }
    response = {
        "id": "resp_synthetic",
        "object": "response",
        "created_at": 1,
        "model": "synthetic-model",
        "status": "completed",
        "output": [
            {
                "type": "message",
                "id": "msg_synthetic",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": "Draft ready", "annotations": []}],
            }
        ],
        "tools": [hosted_mcp],
        "parallel_tool_calls": True,
        "tool_choice": "auto",
    }
    receiver.reply(200, json.dumps(response).encode(), **{"Content-Type": "application/json"})
    instrumentor = adapter.OpenAIInstrumentor()
    with Hue(receiver.url, "synthetic-hue-key", capture_content=capture_content) as hue:
        instrumentor.instrument(
            tracer_provider=hue.tracer_provider,
            config=instrumentation.TraceConfig(enable_genai_semconv=True),
        )
        try:
            with openai.OpenAI(
                api_key="synthetic-provider-key", base_url=receiver.url + "/v1"
            ) as provider:
                result = provider.responses.create(
                    model="synthetic-model", input="Synthetic prompt", tools=[hosted_mcp]
                )
                assert result.output_text == "Draft ready"
            assert hue.force_flush()
        finally:
            instrumentor.uninstrument()
    (span,) = receiver.spans()
    attributes = {item.key: item.value.string_value for item in span.attributes}
    telemetry = b"".join(data for path, _, data in receiver.requests if path.endswith("/traces"))
    assert b"synthetic-oauth-token" not in telemetry
    assert b"synthetic-header-secret" not in telemetry
    if not capture_content:
        assert "llm.tools.0.tool.json_schema" not in attributes
        return
    # The response echoes the tool with every field, so compare the fields that were sent.
    schema = json.loads(attributes["llm.tools.0.tool.json_schema"])
    assert schema["authorization"] == schema["headers"] == "[redacted]"
    assert schema["server_label"] == "gmail"
    assert schema["server_url"] == "https://mcp.example.test/gmail"
    # OpenInference also records the raw request; only its tool entries change.
    request = json.loads(attributes["input.value"])
    assert request["input"] == "Synthetic prompt"
    assert request["tools"][0]["authorization"] == "[redacted]"
    assert request["tools"][0]["server_url"] == "https://mcp.example.test/gmail"
