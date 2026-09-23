from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path

import pytest
from opentelemetry import trace
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import (
    ExportLogsServiceRequest,
    ExportLogsServiceResponse,
)
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
    ExportTraceServiceResponse,
)
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import (
    LogRecordExporter,
    LogRecordExportResult,
    SimpleLogRecordProcessor,
)
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from hue_sdk import Hue, ProjectValidationError

KEY = "synthetic-local-project-key"


def attrs(span):
    return {attribute.key: attribute.value for attribute in span.attributes}


def body_of(log):
    return {entry.key: entry.value for entry in log.body.kvlist_value.values}


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
    (field,) = log.body.kvlist_value.values
    assert field.key == "gen_ai.output.messages" and field.value.WhichOneof("value") is None
    assert attrs(log)["gen_ai.operation.name"].string_value == "chat"
    assert attrs(log)["gen_ai.provider.name"].string_value == "synthetic"
    assert attrs(log)["gen_ai.request.model"].string_value == "test-model"
    assert attrs(log)["gen_ai.conversation.id"].string_value == "conversation"
    assert "hue.capture_content" not in attrs(log)
    for path, headers, _ in receiver.requests:
        assert path.startswith("/api/v1/")
        assert headers["Authorization"] == f"Bearer {KEY}"
        if path.endswith(("/traces", "/logs")):
            assert headers["Content-Type"] == "application/x-protobuf"


def test_tool_records_the_mcp_server_that_handled_the_call(receiver):
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.tool("get_thread", mcp={"name": "gmail", "version": "1.2.3"}):
            pass
        with hue.tool("get_thread", mcp={"name": ""}):
            pass
        assert hue.export_status.instrumentation_failures == 1
        hue.force_flush()
    labeled, unlabeled = [
        span for span in receiver.spans() if span.name == "execute_tool get_thread"
    ]
    assert attrs(labeled)["mcp.server.name"].string_value == "gmail"
    assert attrs(labeled)["mcp.server.version"].string_value == "1.2.3"
    assert "mcp.server.name" not in attrs(unlabeled)


def test_tool_records_the_hue_provider_and_surface(receiver):
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.tool(
            "labeled",
            mcp={"name": "gmail", "provider": "google.gmail", "surface": "google.gmail/mcp"},
        ):
            pass
        with hue.tool("blank", mcp={"name": "gmail", "provider": " ", "surface": ""}):
            pass
        with hue.tool(
            "invalid",
            mcp={"name": "gmail", "provider": "google\x00gmail", "surface": "\ud800", "version": 3},
        ):
            pass
        with hue.tool("oversized", mcp={"provider": "p" * 257, "surface": "s" * 256}):
            pass
        assert hue.export_status.instrumentation_failures == 6
        hue.force_flush()
    spans = {span.name.removeprefix("execute_tool "): attrs(span) for span in receiver.spans()}
    assert spans["labeled"]["hue.mcp.provider"].string_value == "google.gmail"
    assert spans["labeled"]["hue.mcp.surface"].string_value == "google.gmail/mcp"
    assert spans["labeled"]["mcp.server.name"].string_value == "gmail"
    for name in ("blank", "invalid"):
        assert spans[name]["mcp.server.name"].string_value == "gmail"
        assert "mcp.server.version" not in spans[name]
        assert "hue.mcp.provider" not in spans[name]
        assert "hue.mcp.surface" not in spans[name]
    assert "hue.mcp.provider" not in spans["oversized"]
    assert spans["oversized"]["hue.mcp.surface"].string_value == "s" * 256


def test_tool_source_labels_use_utf16_length_like_typescript_and_fern(receiver):
    accepted = "😀" * 128  # 256 UTF-16 code units: the inclusive limit.
    rejected = "😀" * 129
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.tool("accepted", mcp={"provider": accepted, "surface": accepted}):
            pass
        with hue.tool("rejected", mcp={"provider": rejected, "surface": rejected}):
            pass
        assert hue.export_status.instrumentation_failures == 2
        hue.force_flush()
    spans = {span.name.removeprefix("execute_tool "): attrs(span) for span in receiver.spans()}
    assert spans["accepted"]["hue.mcp.provider"].string_value == accepted
    assert spans["accepted"]["hue.mcp.surface"].string_value == accepted
    assert "hue.mcp.provider" not in spans["rejected"]
    assert "hue.mcp.surface" not in spans["rejected"]


def test_disabled_client_does_not_count_invalid_mcp(receiver):
    hue = Hue(receiver.url, KEY, capture_content=False, enabled=False)
    with hue.tool("get_thread", mcp={"name": ""}):
        pass
    with hue.tool("get_thread", mcp="gmail"):
        pass
    assert hue.export_status.instrumentation_failures == 0
    assert hue.shutdown()


def test_inference_log_carries_request_metadata_and_a_structured_body(receiver):
    with Hue(receiver.url, KEY, capture_content=True) as hue:
        with hue.context(session_id="session-attributes"), hue.span("request") as root:
            with hue.model(
                "synthetic-model", provider="synthetic", operation="generate_content"
            ) as model:
                model.log_inference(
                    output=[{"role": "assistant", "parts": [{"type": "text", "content": "hi"}]}]
                )
                with hue.tool("lookup") as tool:
                    tool.log_inference(output="nested")  # Inherited through the task-local scope.
                model.log_inference(output="override", model="explicit-model")
                model.log_inference()  # No fields: an empty structured body, attributes intact.
            model.log_inference(output="after")  # The helper keeps its metadata after the block.
            root.log_inference(
                output="plain", operation="chat", provider="caller", model="caller-model"
            )
            root.log_inference(output="bare")
            assert hue.export_status.instrumentation_failures == 0
            root.log_inference(output="invalid", model="")
            assert hue.export_status.instrumentation_failures == 1
        assert not hue.force_flush()  # The counted label failure, not a delivery problem.
        status = hue.export_status
        assert status.failed_log_batches == status.dropped_log_records == 0
    spans = {span.name: span for span in receiver.spans()}
    logs = receiver.logs()
    assert len(logs) == 8
    structured, nested, override, empty, after, plain, bare, invalid = logs
    assert [body_of(log)["gen_ai.output.messages"].string_value for log in logs[4:]] == [
        "after",
        "plain",
        "bare",
        "invalid",
    ]
    for log in (structured, nested, empty, after):
        assert attrs(log)["gen_ai.operation.name"].string_value == "generate_content"
        assert attrs(log)["gen_ai.provider.name"].string_value == "synthetic"
        assert attrs(log)["gen_ai.request.model"].string_value == "synthetic-model"
        assert attrs(log)["gen_ai.conversation.id"].string_value == "session-attributes"
    assert structured.span_id == after.span_id == spans["generate_content synthetic-model"].span_id
    (message,) = body_of(structured)["gen_ai.output.messages"].array_value.values
    fields = {entry.key: entry.value for entry in message.kvlist_value.values}
    assert fields["role"].string_value == "assistant"
    (part,) = fields["parts"].array_value.values
    part_fields = {entry.key: entry.value for entry in part.kvlist_value.values}
    assert part_fields["type"].string_value == "text"
    assert part_fields["content"].string_value == "hi"
    assert nested.span_id == spans["execute_tool lookup"].span_id
    assert body_of(nested)["gen_ai.output.messages"].string_value == "nested"
    assert body_of(override)["gen_ai.output.messages"].string_value == "override"
    assert attrs(override)["gen_ai.request.model"].string_value == "explicit-model"
    assert attrs(override)["gen_ai.operation.name"].string_value == "generate_content"
    assert attrs(override)["gen_ai.provider.name"].string_value == "synthetic"
    assert empty.body.WhichOneof("value") == "kvlist_value" and not empty.body.kvlist_value.values
    assert plain.span_id == spans["request"].span_id
    assert attrs(plain)["gen_ai.operation.name"].string_value == "chat"
    assert attrs(plain)["gen_ai.provider.name"].string_value == "caller"
    assert attrs(plain)["gen_ai.request.model"].string_value == "caller-model"
    assert attrs(plain)["gen_ai.conversation.id"].string_value == "session-attributes"
    assert [attribute.key for attribute in bare.attributes] == ["gen_ai.conversation.id"]
    assert set(attrs(invalid)) == {"gen_ai.conversation.id"}
    assert all("hue.capture_content" not in attrs(log) for log in logs)


def test_nested_model_scopes_restore_the_outer_request_metadata(receiver):
    with Hue(receiver.url, KEY, capture_content=True) as hue:
        with hue.model("outer", provider="p") as outer:
            with hue.model("inner", provider="q") as inner:
                inner.log_inference(output="inner")
            with hue.span("sibling") as sibling:
                sibling.log_inference(output="sibling")  # Created after inner exited: outer again.
            outer.log_inference(output="outer")
        with hue.span("outside") as outside:
            outside.log_inference(output="outside")  # No scope, no session: no attributes.
        assert hue.export_status.instrumentation_failures == 0
        assert hue.force_flush()
    inner_log, sibling_log, outer_log, outside_log = receiver.logs()
    assert attrs(inner_log)["gen_ai.request.model"].string_value == "inner"
    assert attrs(inner_log)["gen_ai.provider.name"].string_value == "q"
    assert attrs(sibling_log)["gen_ai.request.model"].string_value == "outer"
    assert attrs(outer_log)["gen_ai.request.model"].string_value == "outer"
    assert attrs(outer_log)["gen_ai.provider.name"].string_value == "p"
    assert list(outside_log.attributes) == []


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
        assert hue.export_status.instrumentation_failures == 0
        assert KEY not in repr(hue)
    combined = b"".join(body for _, _, body in receiver.requests)
    assert b"sensitive-" not in combined
    assert b"RuntimeError" in combined
    span = receiver.spans()[0]
    assert span.status.code == 2
    assert "input.value" not in attrs(span)
    assert receiver.logs() == []
    assert not any(path.endswith("/logs") for path, _, _ in receiver.requests)


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


def wire_resources(receiver):
    """service.name of the resource each OTLP request carried, per signal."""
    resources = {}
    for path, _, body in receiver.requests:
        if path.endswith("/traces"):
            resources["traces"] = ExportTraceServiceRequest.FromString(body).resource_spans[0]
        elif path.endswith("/logs"):
            resources["logs"] = ExportLogsServiceRequest.FromString(body).resource_logs[0]
    return {signal: group.resource for signal, group in resources.items()}


def test_attach_mode_logs_share_the_borrowed_tracer_provider_resource(receiver):
    provider = TracerProvider(
        resource=Resource.create({"service.name": "my-app"}), shutdown_on_exit=False
    )
    with Hue(
        receiver.url, KEY, capture_content=True, tracer_provider=provider, service_name="ignored"
    ) as hue:
        assert isinstance(hue.logger_provider, LoggerProvider)
        assert hue.logger_provider.resource == provider.resource
        with hue.span("attached") as span:
            span.log_inference(output="correlated")
        assert hue.force_flush()
    resources = wire_resources(receiver)
    assert {
        signal: attrs(resource)["service.name"].string_value
        for signal, resource in resources.items()
    } == {
        "traces": "my-app",
        "logs": "my-app",
    }
    assert resources["traces"] == resources["logs"]
    provider.shutdown()


class MemoryLogExporter(LogRecordExporter):
    def __init__(self):
        self.records = []

    def export(self, batch):
        self.records.extend(batch)
        return LogRecordExportResult.SUCCESS

    def shutdown(self):
        pass

    def force_flush(self, timeout_millis=30_000):
        return True


def test_borrowed_logger_provider_shares_resource_and_survives_shutdown(receiver):
    with pytest.raises(TypeError, match="SDK LoggerProvider"):
        Hue(receiver.url, KEY, capture_content=False, logger_provider=object())
    memory = MemoryLogExporter()
    logger_provider = LoggerProvider(
        resource=Resource.create({"service.name": "logs-app"}), shutdown_on_exit=False
    )
    logger_provider.add_log_record_processor(SimpleLogRecordProcessor(memory))
    hue = Hue(receiver.url, KEY, capture_content=True, logger_provider=logger_provider)
    assert hue.logger_provider is logger_provider
    assert isinstance(hue.tracer_provider, TracerProvider)
    assert hue.tracer_provider.resource == logger_provider.resource
    with hue.span("borrowed-logs") as span:
        span.log_inference(output="correlated")
    assert hue.shutdown()
    resources = wire_resources(receiver)
    assert attrs(resources["traces"])["service.name"].string_value == "logs-app"
    assert resources["traces"] == resources["logs"]
    # The borrowed provider and its other processors stay usable; Hue counts the late record.
    logger_provider.get_logger("still-usable").emit(body="after-hue-shutdown")
    assert len(memory.records) == 2
    assert len(receiver.logs()) == 1
    assert hue.export_status.dropped_log_records == 1
    logger_provider.shutdown()


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
        assert all(int(h["X-Wire-Bytes"]) <= 1_048_576 for _, h, _ in receiver.requests)
        assert len(receiver.requests) >= 4
        with hue.span("too-large-custom-record") as span:
            # Caller-controlled arbitrary attributes are not silently truncated by Hue.
            span.set_attribute("custom.content", "z" * 1_048_576)
        assert not hue.force_flush()
        assert hue.export_status.failed_trace_batches == 1
    assert len(receiver.spans()) == 8


def test_content_prefixes_list_every_recognized_key_identically_to_typescript():
    from hue_sdk.snapshots import CONTENT_PREFIXES

    assert CONTENT_PREFIXES == (
        "gen_ai.input.messages",
        "gen_ai.output.messages",
        "gen_ai.system_instructions",
        "gen_ai.prompt",
        "gen_ai.completion",
        "gen_ai.tool.call.arguments",
        "gen_ai.tool.call.result",
        "gen_ai.tool.definitions",
        "gen_ai.event.content",
        "llm.input_messages",
        "llm.output_messages",
        "llm.prompts",
        "llm.completions",
        "llm.invocation_parameters",
        "llm.prompt_template.template",
        "llm.prompt_template.variables",
        "llm.tools",
        "llm.function_call",
        "llm.choices",
        "input.value",
        "output.value",
        "input.images",
        "output.images",
        "retrieval.documents",
        "embedding.embeddings",
        "reranker.query",
        "reranker.input_documents",
        "reranker.output_documents",
        "ai.prompt",
        "ai.response.text",
        "ai.response.object",
        "ai.response.reasoning",
        "ai.response.files",
        "ai.response.toolCalls",
        "ai.response.body",
        "ai.toolCall.args",
        "ai.toolCall.result",
        "ai.value",
        "ai.values",
        "ai.embedding",
        "ai.embeddings",
        "traceloop.entity.input",
        "traceloop.entity.output",
        "tool.parameters",
        "exception.message",
        "exception.stacktrace",
    )
    typescript = (
        Path(__file__).resolve().parents[3] / "packages" / "sdk-typescript" / "src" / "privacy.ts"
    )
    if not typescript.is_file():
        pytest.skip("TypeScript source is not part of this checkout")
    block = re.search(r"export const contentPrefixes = \[(.*?)\];", typescript.read_text(), re.S)
    assert block is not None
    assert tuple(re.findall(r'"([^"]+)"', block.group(1))) == CONTENT_PREFIXES


def test_export_replaces_hosted_tool_credentials_in_tool_definitions(receiver):
    hosted_mcp = {
        "type": "mcp",
        "server_label": "gmail",
        "server_url": "https://mcp.example.test/gmail",
        "authorization": "synthetic-oauth-token",
        "headers": {"X-Api-Key": "synthetic-header-secret"},
        "require_approval": "never",
    }
    # A function tool whose parameters are named like credentials: parameter schemas are kept.
    fetch_page = json.dumps(
        {
            "type": "function",
            "name": "fetch_page",
            "parameters": {
                "type": "object",
                "properties": {"headers": {"type": "object"}, "api_key": {"type": "string"}},
                "required": ["headers"],
            },
        }
    )
    provider = TracerProvider()
    with Hue(receiver.url, KEY, capture_content=True, tracer_provider=provider) as hue:
        span = provider.get_tracer("third-party").start_span("external")
        span.set_attribute("llm.tools.0.tool.json_schema", json.dumps(hosted_mcp))
        span.set_attribute("llm.tools.1.tool.json_schema", fetch_page)
        span.set_attribute(
            "gen_ai.tool.definitions",
            json.dumps(
                [
                    {
                        "type": "provider",
                        "name": "gmail",
                        "id": "openai.mcp",
                        "args": {"serverLabel": "gmail", "authorization": "synthetic-oauth-token"},
                    }
                ]
            ),
        )
        span.set_attribute(
            "llm.invocation_parameters",
            json.dumps(
                {
                    "max_tokens": 100,
                    "mcp_servers": [
                        {
                            "type": "url",
                            "url": "https://mcp.example.test/slack",
                            "name": "slack",
                            "authorization_token": "synthetic-oauth-token",
                        }
                    ],
                }
            ),
        )
        span.set_attribute("ai.prompt.tools", ["not JSON: authorization"])
        span.set_attribute("output.value", "The authorization field was set.")
        span.end()
        assert hue.force_flush()
    (exported,) = receiver.spans()
    values = attrs(exported)
    assert json.loads(values["llm.tools.0.tool.json_schema"].string_value) == {
        **hosted_mcp,
        "authorization": "[redacted]",
        "headers": "[redacted]",
    }
    assert values["llm.tools.1.tool.json_schema"].string_value == fetch_page
    assert json.loads(values["gen_ai.tool.definitions"].string_value)[0]["args"] == {
        "serverLabel": "gmail",
        "authorization": "[redacted]",
    }
    parameters = json.loads(values["llm.invocation_parameters"].string_value)
    assert parameters["mcp_servers"][0]["authorization_token"] == "[redacted]"
    assert parameters["max_tokens"] == 100
    assert values["ai.prompt.tools"].array_value.values[0].string_value == (
        "not JSON: authorization"
    )
    assert values["output.value"].string_value == "The authorization field was set."
    telemetry = b"".join(data for path, _, data in receiver.requests if path.endswith("/traces"))
    assert b"synthetic-oauth-token" not in telemetry
    assert b"synthetic-header-secret" not in telemetry


def test_oversized_tool_definition_is_dropped_without_being_parsed(receiver, monkeypatch):
    from hue_sdk import _tool_definitions

    parsed: list[int] = []
    original = _tool_definitions._parse
    monkeypatch.setattr(
        _tool_definitions, "_parse", lambda text: parsed.append(len(text)) or original(text)
    )
    provider = TracerProvider()
    with Hue(receiver.url, KEY, capture_content=True, tracer_provider=provider) as hue:
        tracer = provider.get_tracer("third-party")
        oversized = tracer.start_span("oversized")
        # Larger than one export request: admission drops the record before the scrub runs.
        oversized.set_attribute("input.value", json.dumps({"tools": [], "input": "x" * 1_100_000}))
        oversized.end()
        small = tracer.start_span("small")
        small.set_attribute("input.value", json.dumps({"tools": [{"authorization": "secret"}]}))
        small.end()
        assert not hue.force_flush()
        assert hue.export_status.dropped_trace_records == 1
    assert [span.name for span in receiver.spans()] == ["small"]
    assert parsed and max(parsed) < 1_000


def test_tool_definition_too_deeply_nested_to_inspect_drops_its_record(receiver):
    provider = TracerProvider()
    with Hue(receiver.url, KEY, capture_content=True, tracer_provider=provider) as hue:
        span = provider.get_tracer("third-party").start_span("deep")
        span.set_attribute(
            "gen_ai.tool.definitions",
            '{"a":' * 300 + '{"authorization":"synthetic-oauth-token"}' + "}" * 300,
        )
        span.end()
        assert not hue.force_flush()
        assert hue.export_status.dropped_trace_records == 1
    assert receiver.spans() == []


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
        # An OpenInference retriever span: document text is content, the score is metadata.
        retriever = provider.get_tracer("third-party").start_span("retrieve")
        retriever.set_attribute("openinference.span.kind", "RETRIEVER")
        retriever.set_attribute("retrieval.documents.0.document.content", "private-value")
        retriever.set_attribute("retrieval.documents.0.document.score", 0.42)
        retriever.set_attribute("ai.response.reasoning", "private-value")
        retriever.set_attribute("ai.response.finishReason", "stop")
        retriever.end()
        assert hue.force_flush()
    spans = {span.name: span for span in receiver.spans()}
    exported, retrieved = spans["external"], spans["retrieve"]
    retrieved_keys = {attribute.key for attribute in retrieved.attributes}
    assert {"openinference.span.kind", "ai.response.finishReason"} <= retrieved_keys
    assert ("retrieval.documents.0.document.content" in retrieved_keys) is capture_content
    assert ("retrieval.documents.0.document.score" in retrieved_keys) is capture_content
    assert ("ai.response.reasoning" in retrieved_keys) is capture_content
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
