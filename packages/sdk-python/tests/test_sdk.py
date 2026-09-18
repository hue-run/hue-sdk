from __future__ import annotations

import asyncio
import json
import time

import pytest
from opentelemetry import trace
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceResponse
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceResponse
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from hue_sdk import Hue, ProjectValidationError

KEY = "synthetic-local-project-key"


def attrs(span):
    return {attribute.key: attribute.value for attribute in span.attributes}


def test_actual_trace_log_correlation_and_content(receiver):
    with Hue(receiver.url + "/", KEY, capture_content=True) as hue:
        assert hue.validate_project().slug == "synthetic-sdk"
        with hue.context(session_id="conversation", user_id="observed-user"):
            with hue.span("root") as root:
                root.set_input(None)
                root.set_output("")
                with hue.model("test-model", provider="synthetic") as model:
                    model.set_input([{"role": "user", "content": "hi"}])
                    model.set_usage(input_tokens=0)
                    model.log_inference(output=None)
                with hue.tool("lookup", call_id="call-1") as tool:
                    tool.set_input({"query": "test"})
                    tool.set_output({"answer": 42})
        assert hue.force_flush()
    spans = {span.name: span for span in receiver.spans()}
    root, model, tool = spans["root"], spans["chat test-model"], spans["execute_tool lookup"]
    assert len(root.trace_id) == 16 and len(root.span_id) == 8
    assert root.trace_id == model.trace_id == tool.trace_id
    assert model.parent_span_id == root.span_id == tool.parent_span_id
    assert attrs(root)["input.value"].string_value == "null"
    assert attrs(root)["output.value"].string_value == '""'
    assert attrs(model)["gen_ai.usage.input_tokens"].int_value == 0
    assert "gen_ai.usage.output_tokens" not in attrs(model)
    assert attrs(model)["gen_ai.conversation.id"].string_value == "conversation"
    assert attrs(tool)["user.id"].string_value == "observed-user"
    assert json.loads(attrs(tool)["gen_ai.tool.call.arguments"].string_value) == {"query": "test"}
    log = receiver.logs()[0]
    assert log.trace_id == model.trace_id and log.span_id == model.span_id
    assert log.event_name == "gen_ai.client.inference.operation.details"
    assert log.body.kvlist_value.values[0].value.string_value == "null"
    for path, headers, _ in receiver.requests:
        assert path.startswith("/api/v1/")
        assert headers["Authorization"] == f"Bearer {KEY}"
        if path.endswith(("/traces", "/logs")):
            assert headers["Content-Type"] == "application/x-protobuf"


def test_metadata_only_excludes_helper_content_and_exception_text(receiver):
    def forbidden_redactor(*_args):
        raise AssertionError("Disabled content must not reach a redactor")

    with Hue(receiver.url, KEY, capture_content=False, redactor=forbidden_redactor) as hue:
        with pytest.raises(RuntimeError), hue.span("safe-name") as span:
            span.set_input("sensitive-input")
            span.set_output({"secret": "sensitive-output"})
            span.log_inference(input="sensitive-log", output="sensitive-output")
            raise RuntimeError("sensitive-exception-message")
        assert hue.force_flush()
        assert KEY not in repr(hue)
    combined = b"".join(body for _, _, body in receiver.requests)
    assert b"sensitive-" not in combined
    assert b"RuntimeError" in combined
    span = receiver.spans()[0]
    assert span.status.code == 2
    assert "input.value" not in attrs(span)
    assert receiver.logs()[0].body.WhichOneof("value") is None


def test_redaction_before_export_and_failure_does_not_leak(receiver):
    def redact(_field, value):
        if value == "fail":
            raise ValueError("sensitive-redactor-diagnostic")
        return {"email": "[redacted]"}

    with Hue(receiver.url, KEY, capture_content=True, redactor=redact) as hue:
        with hue.span("redacted") as span:
            span.set_input({"email": "person@example.test"})
            span.set_output("fail")
            assert hue.export_status.instrumentation_failures == 1
            span.log_inference(output={"email": "person@example.test"})
        assert not hue.force_flush()
    combined = b"".join(body for _, _, body in receiver.requests)
    assert b"person@example.test" not in combined
    assert b"sensitive-redactor" not in combined
    assert b"[redacted]" in combined
    assert "output.value" not in attrs(receiver.spans()[0])


def test_context_is_task_local_and_w3c_context_propagates(receiver):
    with Hue(receiver.url, KEY, capture_content=False) as hue:

        async def task(label):
            with hue.context(session_id=label):
                await asyncio.sleep(0)
                with hue.span(label):
                    headers = {}
                    hue.inject(headers)
                    assert "Authorization" not in headers
                    with hue.span(label + "-child", parent_context=hue.extract(headers)):
                        pass

        async def both():
            await asyncio.gather(task("one"), task("two"))

        asyncio.run(both())
        with hue.span("outside"):
            pass
        assert hue.force_flush()
    spans = {span.name: span for span in receiver.spans()}
    for label in ("one", "two"):
        assert attrs(spans[label])["gen_ai.conversation.id"].string_value == label
        assert attrs(spans[label + "-child"])["gen_ai.conversation.id"].string_value == label
        assert spans[label + "-child"].parent_span_id == spans[label].span_id
    assert "gen_ai.conversation.id" not in attrs(spans["outside"])


def test_borrowed_provider_and_existing_processors_survive_shutdown(receiver):
    global_provider = trace.get_tracer_provider()
    provider = TracerProvider(shutdown_on_exit=False)
    memory = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(memory))
    hue = Hue(receiver.url, KEY, capture_content=False, tracer_provider=provider)
    with provider.get_tracer("external-instrumentation").start_as_current_span("external-parent"):
        with hue.span("helper-child"):
            pass
    assert hue.shutdown()
    assert trace.get_tracer_provider() is global_provider
    with provider.get_tracer("still-usable").start_as_current_span("after-hue-shutdown"):
        pass
    assert len(memory.get_finished_spans()) == 3
    assert len(receiver.spans()) == 2
    assert hue.export_status.dropped_trace_records == 1
    assert not hue.shutdown()
    with hue.span("too-late") as span:
        span.set_output("safe-noop")
    provider.shutdown()


def test_context_exit_flushes_buffered_correlated_logs_without_explicit_flush(receiver):
    with Hue(receiver.url, KEY, capture_content=True) as hue:
        with hue.span("buffered-log") as span:
            span.log_inference(output="completed")
            trace_id, span_id = span.trace_id, span.span_id
    assert len(receiver.spans()) == len(receiver.logs()) == 1
    log = receiver.logs()[0]
    assert log.trace_id.hex() == trace_id and log.span_id.hex() == span_id


def test_slow_export_has_bounded_flush_shutdown_and_keeps_buffered_logs(receiver):
    receiver.delay_seconds = 0.3
    hue = Hue(receiver.url, KEY, capture_content=True)
    try:
        with hue.span("slow-export") as span:
            span.log_inference(output="still-buffered")
        for operation in (hue.force_flush, hue.force_flush, hue.shutdown, hue.shutdown):
            started = time.monotonic()
            assert not operation(timeout_millis=10)
            assert time.monotonic() - started < 0.2
        assert hue.shutdown(timeout_millis=5000)
        assert len(receiver.spans()) == len(receiver.logs()) == 1
        assert not hue.force_flush()
    finally:
        hue.shutdown()


def test_bad_provider_rejected_before_starting_processors(receiver):
    with pytest.raises(TypeError, match="SDK TracerProvider"):
        Hue(receiver.url, KEY, capture_content=False, tracer_provider=object())


def test_warning_only_partial_success_does_not_report_rejection(receiver):
    response = ExportTraceServiceResponse()
    response.partial_success.error_message = "Non-fatal warning"
    receiver.reply(200, response.SerializeToString())
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.span("warning-only"):
            pass
        assert hue.force_flush()


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com",
        "http://localhost.evil.test",
        "ftp://localhost",
        "https://user:password@example.com",
        "https://example.com?key=private",
        "https://example.com/#private",
        "https://example.com/api/v1",
        "https://",
        "https://example.com:bad",
        "https://example.com/\\evil",
        " https://example.com",
    ],
)
def test_unsafe_base_urls_rejected_without_echoing_values(url):
    with pytest.raises(ValueError) as error:
        Hue(url, KEY, capture_content=False)
    assert "private" not in str(error.value)
    assert "password" not in str(error.value)


def test_capture_choice_and_valid_json_are_required(receiver):
    with pytest.raises(TypeError):
        Hue(receiver.url, KEY)
    with pytest.raises(TypeError):
        Hue(receiver.url, KEY, capture_content="yes")
    with Hue(receiver.url, KEY, capture_content=True) as hue:
        with hue.span("invalid") as span:
            span.set_input(float("nan"))
            span.set_output("x" * 262_144)
            span.set_usage(input_tokens=-1)
            span.set_usage(output_tokens=True)
        assert not hue.force_flush()
        assert hue.export_status.instrumentation_failures == 4
    assert not attrs(receiver.spans()[0])


@pytest.mark.parametrize("status", [401, 403, 404, 429, 500])
def test_project_errors_retain_status_without_echoing_response(receiver, status):
    receiver.reply(status, b"secret-server-message")
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with pytest.raises(ProjectValidationError, match=f"HTTP {status}") as error:
            hue.validate_project()
        assert KEY not in str(error.value) and "secret" not in str(error.value)


def test_project_redirect_is_not_followed(receiver):
    receiver.reply(307, Location=receiver.url + "/stolen-key")
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with pytest.raises(ProjectValidationError):
            hue.validate_project()
    assert [path for path, _, _ in receiver.requests] == ["/api/v1/projects/current"]


@pytest.mark.parametrize("signal", ["traces", "logs"])
def test_partial_rejection_is_failure_without_replaying_accepted_records(receiver, signal):
    response = ExportTraceServiceResponse() if signal == "traces" else ExportLogsServiceResponse()
    if signal == "traces":
        response.partial_success.rejected_spans = 1
    else:
        response.partial_success.rejected_log_records = 1
    response.partial_success.error_message = "secret-customer-data"
    receiver.reply(200, response.SerializeToString())
    with Hue(receiver.url, KEY, capture_content=True) as hue:
        with hue.span("partial") as span:
            if signal == "logs":
                span.log_inference(output="hello")
                # Flush the log while the span is still open, making response order explicit.
                assert not hue.force_flush()
        assert not hue.force_flush()
        status = hue.export_status
        assert (
            status.failed_trace_batches if signal == "traces" else status.failed_log_batches
        ) == 1
    assert len([path for path, _, _ in receiver.requests if path.endswith("/" + signal)]) == 1


@pytest.mark.parametrize("status,body", [(401, b""), (413, b""), (201, b""), (200, b"invalid")])
def test_otlp_http_and_malformed_responses_report_failure(receiver, status, body):
    receiver.reply(status, body)
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.span("rejected"):
            pass
        assert not hue.force_flush()
        assert hue.export_status.failed_trace_batches == 1
    assert len(receiver.requests) == 1


def test_otlp_redirect_does_not_send_key_to_new_path(receiver):
    receiver.reply(307, Location=receiver.url + "/stolen-key")
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.span("redirect"):
            pass
        assert not hue.force_flush()
    assert [path for path, _, _ in receiver.requests] == ["/api/v1/otlp/v1/traces"]


def test_standard_exporter_retries_transient_response(receiver):
    receiver.reply(503)
    with Hue(receiver.url, KEY, capture_content=False, export_timeout_seconds=5) as hue:
        with hue.span("retry"):
            pass
        assert hue.force_flush()
    assert len(receiver.requests) == 2
    assert receiver.requests[0][2] == receiver.requests[1][2]


def test_encoded_batches_are_split_and_single_oversize_is_visible(receiver):
    with Hue(receiver.url, KEY, capture_content=True) as hue:
        for index in range(8):
            with hue.span(f"large-{index}") as span:
                span.set_input("x" * 200_000)
                span.log_inference(output="y" * 200_000)
        assert hue.force_flush()
        assert len(receiver.spans()) == len(receiver.logs()) == 8
        assert all(len(body) <= 1_048_576 for _, _, body in receiver.requests)
        assert len(receiver.requests) >= 4
        with hue.span("too-large-custom-record") as span:
            # Caller-controlled arbitrary attributes are not silently truncated by Hue.
            span.set_attribute("custom.content", "z" * 1_048_576)
        assert not hue.force_flush()
        assert hue.export_status.failed_trace_batches == 1
    assert len(receiver.spans()) == 8


@pytest.mark.parametrize("capture_content", [True, False])
def test_export_strips_recognized_content_from_borrowed_provider_spans(receiver, capture_content):
    from hue_sdk.snapshots import CONTENT_PREFIXES

    provider = TracerProvider()
    with Hue(receiver.url, KEY, capture_content=capture_content, tracer_provider=provider) as hue:
        span = provider.get_tracer("third-party").start_span("external")
        for prefix in CONTENT_PREFIXES:
            span.set_attribute(prefix, "private-value")
            span.set_attribute(f"{prefix}.0.content", "private-value")
        span.set_attribute("gen_ai.request.model", "synthetic-model")
        span.add_event("gen_ai.user.message", {"content": "private-value"})
        span.set_status(trace.Status(trace.StatusCode.ERROR, "private description"))
        span.end()
        assert hue.force_flush()
    (exported,) = receiver.spans()
    keys = {attribute.key for attribute in exported.attributes}
    content = {
        key
        for key in keys
        if any(key == prefix or key.startswith(prefix + ".") for prefix in CONTENT_PREFIXES)
    }
    assert "gen_ai.request.model" in keys
    assert len(content) == (2 * len(CONTENT_PREFIXES) if capture_content else 0)
    assert any(event.name == "gen_ai.user.message" for event in exported.events) is capture_content
    assert (exported.status.message == "private description") is capture_content
    telemetry = b"".join(data for path, _, data in receiver.requests if path.endswith("/traces"))
    assert (b"private" in telemetry) is capture_content
