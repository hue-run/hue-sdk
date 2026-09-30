from __future__ import annotations

import asyncio
import base64
import hashlib
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


@pytest.mark.parametrize("capture_content", [True, False])
def test_model_records_system_instructions_and_tool_definitions(receiver, capture_content):
    system_instructions = [{"type": "text", "content": "Answer in one sentence."}]
    tools = [
        {
            "type": "function",
            "name": "lookup",
            "description": "Look up an order",
            "parameters": {"type": "object", "properties": {"id": {"type": "string"}}},
        }
    ]
    with Hue(receiver.url, KEY, capture_content=capture_content) as hue:
        with hue.model(
            "synthetic-model",
            provider="synthetic",
            system_instructions=system_instructions,
            tools=tools,
        ) as model:
            model.log_inference(
                system_instructions=system_instructions,
                output=[{"role": "assistant", "parts": [{"type": "text", "content": "Shipped."}]}],
            )
        # A value that is not JSON is omitted and counted; the block still runs.
        with hue.model("synthetic-model", provider="synthetic", name="invalid", tools={1j}):
            pass
        assert hue.export_status.instrumentation_failures == (1 if capture_content else 0)
        hue.force_flush()
    spans = {span.name: attrs(span) for span in receiver.spans()}
    model_attributes, invalid = spans["chat synthetic-model"], spans["invalid"]
    assert "gen_ai.tool.definitions" not in invalid
    if not capture_content:
        assert "gen_ai.system_instructions" not in model_attributes
        assert "gen_ai.tool.definitions" not in model_attributes
        assert receiver.logs() == []
        return
    assert (
        json.loads(model_attributes["gen_ai.system_instructions"].string_value)
        == system_instructions
    )
    assert json.loads(model_attributes["gen_ai.tool.definitions"].string_value) == tools
    (log,) = receiver.logs()
    body = body_of(log)
    assert set(body) == {"gen_ai.output.messages", "gen_ai.system_instructions"}
    (part,) = body["gen_ai.system_instructions"].array_value.values
    assert {entry.key: entry.value.string_value for entry in part.kvlist_value.values} == {
        "type": "text",
        "content": "Answer in one sentence.",
    }


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


HOSTED_TOOL_CALLS_FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "sdk-typescript"
    / "tests"
    / "fixtures"
    / "hosted-tool-calls.json"
)


class _Model:
    """Stands in for an SDK response object: read through ``model_dump()`` like pydantic."""

    def __init__(self, data):
        self._data = data

    def model_dump(self):
        return self._data


@pytest.mark.parametrize("capture_content", [True, False])
def test_record_provider_tool_calls_records_hosted_calls_as_extension_spans(
    receiver, capture_content
):
    if not HOSTED_TOOL_CALLS_FIXTURE.is_file():
        pytest.skip("Shared fixtures are not part of this checkout")
    fixture = json.loads(HOSTED_TOOL_CALLS_FIXTURE.read_text(encoding="utf-8"))
    with Hue(receiver.url, KEY, capture_content=capture_content) as hue:
        with hue.context(session_id="hosted-session"):
            with hue.model("synthetic-model", provider="openai") as span:
                span.record_provider_tool_calls(
                    _Model(fixture["openai"]["response"]),
                    request=fixture["openai"]["request"],
                    servers={
                        "gmail": {
                            "name": None,
                            "version": "2.0",
                            "provider": "google.gmail",
                            "surface": "google.gmail/mcp",
                        }
                    },
                )
        with hue.model("synthetic-model", provider="anthropic", name="anthropic-call") as span:
            span.record_provider_tool_calls(
                fixture["anthropic"]["response"], request=fixture["anthropic"]["request"]
            )
        # Outside a model() block the provider is unknown: counted, nothing recorded.
        with hue.span("plain") as span:
            span.record_provider_tool_calls(fixture["openai"]["response"])
        assert hue.export_status.instrumentation_failures == 1
        hue.force_flush()
    spans = receiver.spans()
    by_name = {span.name: span for span in spans}

    def children(parent_name):
        parent = by_name[parent_name]
        return [span for span in spans if span.parent_span_id == parent.span_id]

    openai = children("chat synthetic-model")
    assert [span.name for span in openai] == [
        "execute_tool search_threads",
        "execute_tool create_draft",
        "execute_tool web_search",
        "execute_tool file_search",
        "execute_tool code_interpreter",
        "tools/list",
    ]
    named = {span.name: span for span in openai}

    def text(span, key):
        value = attrs(span).get(key)
        return None if value is None else value.string_value

    def loads(span, key):
        value = text(span, key)
        return None if value is None else json.loads(value)

    listing = named["tools/list"]
    assert text(listing, "mcp.method.name") == "tools/list"
    assert text(listing, "mcp.server.name") == "gmail"
    assert text(listing, "mcp.server.version") == "2.0"
    assert text(listing, "hue.mcp.provider") == "google.gmail"
    assert text(listing, "hue.mcp.surface") == "google.gmail/mcp"
    assert text(listing, "server.address") == "mcp.example.test"
    search = named["execute_tool search_threads"]
    assert text(search, "gen_ai.operation.name") == "execute_tool"
    assert text(search, "gen_ai.tool.type") == "extension"
    assert text(search, "gen_ai.tool.call.id") == "mcp_1"
    assert text(search, "mcp.server.name") == "gmail"
    assert text(search, "server.address") == "mcp.example.test"
    assert text(search, "gen_ai.conversation.id") == "hosted-session"
    assert search.status.code == 0
    draft = named["execute_tool create_draft"]
    assert text(draft, "error.type") == "mcp_error" and draft.status.code == 2
    assert text(named["execute_tool web_search"], "gen_ai.tool.call.id") == "ws_1"
    assert text(named["execute_tool web_search"], "mcp.server.name") is None
    assert text(named["execute_tool file_search"], "error.type") == "failed"
    assert named["execute_tool file_search"].status.code == 2
    assert text(named["execute_tool code_interpreter"], "error.type") is None
    anthropic = {span.name: span for span in children("anthropic-call")}
    assert list(anthropic) == [
        "execute_tool web_search",
        "execute_tool post_message",
        "execute_tool code_execution",
    ]
    post = anthropic["execute_tool post_message"]
    assert text(post, "mcp.server.name") == "slack"
    assert text(post, "server.address") == "mcp.example.test"
    assert text(post, "gen_ai.tool.call.id") == "mcptoolu_1"
    assert text(post, "error.type") == "mcp_error" and post.status.code == 2
    assert text(anthropic["execute_tool code_execution"], "error.type") == "unavailable"
    assert anthropic["execute_tool code_execution"].status.code == 2
    assert anthropic["execute_tool web_search"].status.code == 0
    assert children("plain") == []
    telemetry = b"".join(data for path, _, data in receiver.requests if path.endswith("/traces"))
    # The request's credentials are never read, whatever the mode.
    assert b"synthetic-oauth-token" not in telemetry
    if not capture_content:
        for span in [*openai, *anthropic.values()]:
            for key in (
                "gen_ai.tool.call.arguments",
                "gen_ai.tool.call.result",
                "gen_ai.tool.definitions",
            ):
                assert text(span, key) is None
        assert b"from:maya" not in telemetry and b"Create a draft" not in telemetry
        return
    assert loads(listing, "gen_ai.tool.definitions") == [
        {
            "type": "function",
            "name": "create_draft",
            "description": "Create a draft",
            "parameters": {"type": "object", "properties": {"to": {"type": "string"}}},
        },
        {"type": "function", "name": "search_threads", "parameters": {"type": "object"}},
    ]
    # MCP arguments arrive as JSON text and are recorded as the structure they encode.
    assert loads(search, "gen_ai.tool.call.arguments") == {"query": "from:maya"}
    assert loads(search, "gen_ai.tool.call.result") == '{"threads":[{"id":"t1"}]}'
    assert loads(draft, "gen_ai.tool.call.arguments") == {"to": "maya@example.test"}
    assert text(draft, "gen_ai.tool.call.result") is None
    assert loads(named["execute_tool web_search"], "gen_ai.tool.call.arguments") == {
        "type": "search",
        "query": "renewal terms",
    }
    assert loads(named["execute_tool file_search"], "gen_ai.tool.call.arguments") == {
        "queries": ["contract"]
    }
    assert loads(named["execute_tool code_interpreter"], "gen_ai.tool.call.arguments") == {
        "code": "print(1)",
        "container_id": "cntr_1",
    }
    assert loads(named["execute_tool code_interpreter"], "gen_ai.tool.call.result") == [
        {"type": "logs", "logs": "1\n"}
    ]
    assert loads(anthropic["execute_tool web_search"], "gen_ai.tool.call.result") == [
        {"type": "web_search_result", "url": "https://example.test/terms", "title": "Terms"}
    ]
    assert loads(post, "gen_ai.tool.call.arguments") == {"channel": "C1", "text": "Update posted"}
    assert loads(anthropic["execute_tool code_execution"], "gen_ai.tool.call.result") == {
        "type": "code_execution_tool_result_error",
        "error_code": "unavailable",
    }


def test_provider_tool_recorder_uses_span_metadata_after_model_scope_exits(receiver):
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.model("synthetic-model", provider="openai") as span:
            pass
        span.record_provider_tool_calls({"output": []})
        assert hue.export_status.instrumentation_failures == 0


def test_harmless_truncated_response_stays_exportable(receiver):
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.model("synthetic-model", provider="openai") as span:
            span.record_provider_tool_calls(
                {"output": [{"type": "message", "content": []} for _ in range(200)]}
            )
        assert hue.export_status.instrumentation_failures == 0
        assert hue.force_flush()


def test_context_records_the_workspace_on_nested_helpers(receiver):
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.context(workspace_id="workspace-1", user_id="user-1"):
            with hue.span("request"):
                with hue.model("synthetic-model", provider="synthetic"):
                    pass
                with hue.tool("lookup"):
                    pass
                with hue.context(workspace_id="workspace-2"), hue.span("other-workspace"):
                    pass
        with hue.span("unscoped"):
            pass
        assert hue.force_flush()
    spans = {span.name: attrs(span) for span in receiver.spans()}
    for name in ("request", "chat synthetic-model", "execute_tool lookup"):
        assert spans[name]["hue.workspace.id"].string_value == "workspace-1"
        assert spans[name]["user.id"].string_value == "user-1"
    assert spans["other-workspace"]["hue.workspace.id"].string_value == "workspace-2"
    assert spans["other-workspace"]["user.id"].string_value == "user-1"
    assert "hue.workspace.id" not in spans["unscoped"]


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


@pytest.mark.parametrize("capture_content", [True, False])
def test_record_file_links_a_file_by_content_hash_without_exporting_it(receiver, capture_content):
    body = "synthetic-file-body"
    digest = hashlib.sha256(body.encode()).hexdigest()
    pdf = "AB" * 32
    with Hue(receiver.url, KEY, capture_content=capture_content) as hue:
        with hue.span("request") as span:
            span.record_file(
                role="input", media_type="text/plain", data=body.encode(), name="notes.txt"
            )
            span.record_file(
                role="output", media_type="application/pdf", sha256=pdf, byte_size=2048
            )
            # A str is hashed as UTF-8; a blank name is omitted (and counted when captured).
            span.record_file(role="attachment", media_type="text/plain", data=body, name=" ")
            # Each of these is omitted and counted; the block keeps running.
            span.record_file(role="draft", media_type="text/plain", data=body)
            span.record_file(role="input", media_type="text/plain", sha256="not-a-digest")
            span.record_file(role="input", media_type="text/plain", data=body, sha256="0" * 64)
            span.record_file(role="input", media_type="text/plain", sha256=digest, byte_size=-1)
            span.record_file(role="input", media_type="text/plain", sha256=digest, byte_size=2**63)
            span.record_file(role="input", media_type="", sha256=digest)
        assert hue.export_status.instrumentation_failures == (7 if capture_content else 6)
        hue.force_flush()
    (request,) = receiver.spans()
    files = [
        {item.key: item.value.string_value or item.value.int_value for item in event.attributes}
        for event in request.events
        if event.name == "hue.file"
    ]
    assert files == [
        {
            "hue.file.sha256": digest,
            "hue.file.role": "input",
            "hue.file.media_type": "text/plain",
            "hue.file.size": len(body),
            **({"hue.file.name": "notes.txt"} if capture_content else {}),
        },
        {
            "hue.file.sha256": pdf.lower(),
            "hue.file.role": "output",
            "hue.file.media_type": "application/pdf",
            "hue.file.size": 2048,
        },
        {
            "hue.file.sha256": digest,
            "hue.file.role": "attachment",
            "hue.file.media_type": "text/plain",
            "hue.file.size": len(body),
        },
    ]
    telemetry = b"".join(data for path, _, data in receiver.requests if path.endswith("/traces"))
    assert body.encode() not in telemetry


def test_record_file_on_an_ended_span_counts_once_without_hashing(receiver, monkeypatch):
    import hue_sdk.client as client_module

    hashed: list[bytes] = []
    real_sha256 = hashlib.sha256

    def counting(data=b"", *args, **kwargs):
        hashed.append(bytes(data))
        return real_sha256(data, *args, **kwargs)

    with Hue(receiver.url, KEY, capture_content=True) as hue:
        with hue.span("request") as span:
            pass
        monkeypatch.setattr(client_module.hashlib, "sha256", counting)
        # The span has ended: one counted omission, and the bytes are never hashed.
        span.record_file(role="input", media_type="text/plain", data=b"bytes", name=" ")
        assert hue.export_status.instrumentation_failures == 1
        assert hashed == []
        hue.force_flush()
    (request,) = receiver.spans()
    assert [event.name for event in request.events] == []


def test_record_file_rejects_oversized_data_before_hashing_or_exporting(receiver, monkeypatch):
    from hue_sdk.client import _MAX_FILE_DATA_BYTES

    hashed: list[bytes] = []
    real_sha256 = hashlib.sha256

    def counting(data=b"", *args, **kwargs):
        hashed.append(bytes(data))
        return real_sha256(data, *args, **kwargs)

    with Hue(receiver.url, KEY, capture_content=True) as hue:
        with hue.span("request") as span:
            monkeypatch.setattr("hue_sdk.client.hashlib.sha256", counting)
            span.record_file(
                role="input",
                media_type="application/octet-stream",
                data=bytes(_MAX_FILE_DATA_BYTES + 1),
            )
            span.record_file(
                role="input",
                media_type="text/plain",
                data="x" * (_MAX_FILE_DATA_BYTES + 1),
            )
            assert hue.export_status.instrumentation_failures == 2
            assert hashed == []
        hue.force_flush()
    (request,) = receiver.spans()
    assert [event.name for event in request.events] == []


@pytest.mark.parametrize("workspace_id", [123, "", "\x00bad", "\ud800", "😀" * 2049])
def test_context_rejects_invalid_workspace_identifiers(receiver, workspace_id):
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.context(workspace_id=workspace_id):
            with hue.span("request"):
                pass
        assert hue.export_status.instrumentation_failures == 1
        hue.force_flush()
    span = next(span for span in receiver.spans() if span.name == "request")
    assert "hue.workspace.id" not in attrs(span)


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
    typescript = Path(__file__).resolve().parents[2] / "sdk-typescript" / "src" / "privacy.ts"
    if not typescript.is_file():
        pytest.skip("TypeScript source is not part of this checkout")
    block = re.search(r"export const contentPrefixes = \[(.*?)\];", typescript.read_text(), re.S)
    assert block is not None
    assert tuple(re.findall(r'"([^"]+)"', block.group(1))) == CONTENT_PREFIXES


def test_large_inline_files_in_messages_export_as_their_digest(receiver):
    image = bytes((index * 7) % 256 for index in range(100 * 1024))
    image_base64 = base64.b64encode(image).decode()
    image_digest = hashlib.sha256(image).hexdigest()
    # Beyond the 1 MiB snapshot budget: dropped whole before, exported as a digest now.
    document = bytes((index * 13) % 256 for index in range(2 * 1024 * 1024))
    document_digest = hashlib.sha256(document).hexdigest()
    text = "line\n" * 20000 + "end"
    provider = TracerProvider()
    with Hue(receiver.url, KEY, capture_content=True, tracer_provider=provider) as hue:
        span = provider.get_tracer("third-party").start_span("external")
        span.set_attribute(
            "gen_ai.input.messages",
            json.dumps(
                [
                    {
                        "role": "user",
                        "parts": [
                            {"type": "text", "content": "Summarize the contract"},
                            {
                                "type": "blob",
                                "modality": "document",
                                "mime_type": "application/pdf",
                                "content": base64.b64encode(document).decode(),
                            },
                            {"type": "blob", "modality": "text", "content": "c21hbGw="},
                        ],
                    }
                ]
            ),
        )
        # AI SDK 6 file parts: a data: URL is decoded, text content is hashed as UTF-8.
        span.set_attribute(
            "ai.prompt.messages",
            json.dumps(
                [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "file",
                                "mediaType": "image/png",
                                "filename": "chart.png",
                                "data": f"data:image/png;base64,{image_base64}",
                            },
                            {"type": "file", "mediaType": "text/plain", "data": text},
                        ],
                    }
                ]
            ),
        )
        # Not a message attribute: left alone even though it carries the same part.
        span.set_attribute(
            "input.value", json.dumps({"parts": [{"type": "blob", "content": image_base64}]})
        )
        span.end()
        assert hue.force_flush()
    (exported,) = receiver.spans()
    values = attrs(exported)
    (message,) = json.loads(values["gen_ai.input.messages"].string_value)
    assert message["parts"] == [
        {"type": "text", "content": "Summarize the contract"},
        {
            "type": "blob",
            "modality": "document",
            "mime_type": "application/pdf",
            "sha256": document_digest,
            "size": len(document),
        },
        {"type": "blob", "modality": "text", "content": "c21hbGw="},
    ]
    (prompt,) = json.loads(values["ai.prompt.messages"].string_value)
    assert prompt["content"] == [
        {
            "type": "file",
            "mediaType": "image/png",
            "filename": "chart.png",
            "sha256": image_digest,
            "size": len(image),
        },
        {
            "type": "file",
            "mediaType": "text/plain",
            "sha256": hashlib.sha256(text.encode()).hexdigest(),
            "size": len(text.encode()),
        },
    ]
    assert image_base64 in values["input.value"].string_value
    telemetry = b"".join(data for path, _, data in receiver.requests if path.endswith("/traces"))
    assert base64.b64encode(document)[:64] not in telemetry


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


TOOL_DEFINITIONS_FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "sdk-typescript"
    / "tests"
    / "fixtures"
    / "tool-definitions.json"
)


def test_tool_catalog_digest_is_identical_to_typescript(receiver):
    if not TOOL_DEFINITIONS_FIXTURE.is_file():
        pytest.skip("TypeScript fixtures are not part of this checkout")
    fixture = json.loads(TOOL_DEFINITIONS_FIXTURE.read_text(encoding="utf-8"))
    provider = TracerProvider()
    with Hue(receiver.url, KEY, capture_content=False, tracer_provider=provider) as hue:
        span = provider.get_tracer("third-party").start_span("fixture")
        span.set_attribute("gen_ai.tool.definitions", json.dumps(fixture["definitions"]))
        span.end()
        assert hue.force_flush()
    (exported,) = receiver.spans()
    values = attrs(exported)
    assert [item.string_value for item in values["hue.tool.names"].array_value.values] == (
        fixture["names"]
    )
    assert values["hue.tool.definitions.sha256"].string_value == fixture["sha256"]
    assert "gen_ai.tool.definitions" not in values


@pytest.mark.parametrize("capture_content", [True, False])
def test_metadata_only_export_summarizes_the_tool_definitions_it_removes(
    receiver, capture_content, monkeypatch
):
    from hue_sdk import _tool_definitions

    parsed: list[int] = []
    original = _tool_definitions._parse
    monkeypatch.setattr(
        _tool_definitions,
        "_parse",
        lambda text, **options: parsed.append(len(text)) or original(text, **options),
    )
    definitions = [
        {
            "type": "provider",
            "name": "gmail",
            "id": "openai.mcp",
            "args": {"serverLabel": "gmail", "authorization": "synthetic-oauth-token"},
        },
        {"type": "function", "name": "fetch_page", "description": "Fetch a page"},
    ]
    rotated = json.loads(json.dumps(definitions))
    rotated[0]["args"]["authorization"] = "rotated-oauth-token"
    provider = TracerProvider()
    tracer = provider.get_tracer("third-party")

    def record(name, attributes):
        span = tracer.start_span(name)
        for key, value in attributes.items():
            span.set_attribute(key, value)
        span.end()

    with Hue(receiver.url, KEY, capture_content=capture_content, tracer_provider=provider) as hue:
        record("definitions", {"gen_ai.tool.definitions": json.dumps(definitions)})
        # Rotated credentials, reordered keys and whitespace describe the same catalog.
        record(
            "rotated",
            {"gen_ai.tool.definitions": json.dumps(rotated, indent=2, sort_keys=True)},
        )
        # OpenInference numbers each tool; index 10 sorts after 9.
        record(
            "openinference",
            {
                f"llm.tools.{index}.tool.json_schema": json.dumps(
                    {"type": "function", "function": {"name": f"tool_{index}"}}
                )
                for index in (10, 2, 0, 9, 1, 3, 4, 5, 6, 7, 8)
            },
        )
        record(
            "ai-sdk-6", {"ai.prompt.tools": [json.dumps({"type": "function", "name": "lookup"})]}
        )
        record("not-json", {"gen_ai.tool.definitions": "not JSON"})
        if not capture_content:
            # Longer than one export request: removed without being parsed or summarized.
            oversized = [{"type": "function", "name": "big", "description": "x" * 1_100_000}]
            record("oversized", {"gen_ai.tool.definitions": json.dumps(oversized)})
        record(
            "preset",
            {
                "gen_ai.tool.definitions": json.dumps([{"type": "function", "name": "lookup"}]),
                "hue.tool.names": ["application-set"],
            },
        )
        assert hue.force_flush()
    spans = {span.name: attrs(span) for span in receiver.spans()}

    def names(name):
        value = spans[name].get("hue.tool.names")
        return None if value is None else [item.string_value for item in value.array_value.values]

    def digest(name):
        value = spans[name].get("hue.tool.definitions.sha256")
        return None if value is None else value.string_value

    telemetry = b"".join(data for path, _, data in receiver.requests if path.endswith("/traces"))
    assert b"synthetic-oauth-token" not in telemetry
    assert names("preset") == ["application-set"]
    if capture_content:
        # Content mode exports the scrubbed definitions themselves and adds no summary.
        assert all(digest(name) is None for name in ("definitions", "openinference", "ai-sdk-6"))
        return
    assert names("definitions") == ["gmail", "fetch_page"]
    assert re.fullmatch(r"[0-9a-f]{64}", digest("definitions") or "")
    assert digest("rotated") == digest("definitions")
    assert names("openinference") == [f"tool_{index}" for index in range(11)]
    assert names("ai-sdk-6") == ["lookup"]
    assert digest("not-json") is None and names("not-json") is None
    assert digest("oversized") is None and names("oversized") is None
    assert max(parsed) < 1_000_000
    assert re.fullmatch(r"[0-9a-f]{64}", digest("preset") or "")
    for values in spans.values():
        assert not any(key.startswith("llm.tools.") for key in values)
        assert "gen_ai.tool.definitions" not in values and "ai.prompt.tools" not in values
    assert b"Fetch a page" not in telemetry


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


_USAGE_KEYS = (
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.cache_read.input_tokens",
    "gen_ai.usage.cache_creation.input_tokens",
    "gen_ai.usage.reasoning.output_tokens",
)


@pytest.mark.parametrize(
    ("usage", "failures", "recorded"),
    [
        pytest.param(
            {
                "input_tokens": 1100,
                "output_tokens": 20,
                "cache_read_tokens": 1000,
                "cache_write_tokens": 50,
                "reasoning_tokens": 5,
            },
            0,
            {
                "gen_ai.usage.input_tokens": 1100,
                "gen_ai.usage.output_tokens": 20,
                "gen_ai.usage.cache_read.input_tokens": 1000,
                "gen_ai.usage.cache_creation.input_tokens": 50,
                "gen_ai.usage.reasoning.output_tokens": 5,
            },
            id="every count when the input includes its cache counts",
        ),
        pytest.param(
            {"input_tokens": 1000, "cache_read_tokens": 900, "cache_write_tokens": 100},
            0,
            {
                "gen_ai.usage.input_tokens": 1000,
                "gen_ai.usage.cache_read.input_tokens": 900,
                "gen_ai.usage.cache_creation.input_tokens": 100,
            },
            id="an input equal to its cache counts",
        ),
        pytest.param(
            {"input_tokens": 1100, "cache_read_tokens": 1000},
            0,
            {"gen_ai.usage.input_tokens": 1100, "gen_ai.usage.cache_read.input_tokens": 1000},
            id="an inclusive input",
        ),
        pytest.param(
            {
                "input_tokens": 100,
                "cache_read_tokens": 1000,
                "output_tokens": 10,
                "reasoning_tokens": 4,
            },
            1,
            {"gen_ai.usage.output_tokens": 10, "gen_ai.usage.reasoning.output_tokens": 4},
            id="an input smaller than its cache counts is refused, output kept",
        ),
        pytest.param(
            {
                "input_tokens": 100,
                "cache_read_tokens": 60,
                "cache_write_tokens": 60,
                "output_tokens": 1,
            },
            1,
            {"gen_ai.usage.output_tokens": 1},
            id="an input smaller than cache reads plus writes is refused",
        ),
        pytest.param(
            {"cache_read_tokens": 30, "cache_write_tokens": 7, "output_tokens": 3},
            0,
            {
                "gen_ai.usage.cache_read.input_tokens": 30,
                "gen_ai.usage.cache_creation.input_tokens": 7,
                "gen_ai.usage.output_tokens": 3,
            },
            id="cache counts without an input count",
        ),
        pytest.param(
            {
                "input_tokens": 12,
                "cache_read_tokens": None,
                "cache_write_tokens": None,
                "reasoning_tokens": None,
            },
            0,
            {"gen_ai.usage.input_tokens": 12},
            id="None counts are absent without a failure",
        ),
        pytest.param(
            {
                "input_tokens": 5,
                "output_tokens": 6,
                "cache_read_tokens": -1,
                "cache_write_tokens": True,
                "reasoning_tokens": 1.5,
            },
            3,
            {"gen_ai.usage.input_tokens": 5, "gen_ai.usage.output_tokens": 6},
            id="each invalid cache or reasoning count is omitted and counted",
        ),
        pytest.param(
            {"input_tokens": 5, "cache_read_tokens": 2, "cache_write_tokens": "9"},
            1,
            {"gen_ai.usage.input_tokens": 5, "gen_ai.usage.cache_read.input_tokens": 2},
            id="the input is checked against valid cache counts only",
        ),
    ],
)
def test_set_usage_records_cache_and_reasoning_counts(receiver, usage, failures, recorded):
    with Hue(receiver.url, KEY, capture_content=False, live_spans=False) as hue:
        with hue.model("synthetic-model", provider="synthetic") as model:
            model.set_usage(**usage)
        assert hue.force_flush() is (failures == 0)
        assert hue.export_status.instrumentation_failures == failures
    (span,) = [span for span in receiver.spans() if span.name == "chat synthetic-model"]
    values = attrs(span)
    assert {key: values[key].int_value for key in _USAGE_KEYS if key in values} == recorded


def test_set_usage_records_nothing_on_a_disabled_client():
    hue = Hue(enabled=False, capture_content=False)
    with hue.span("request") as span:
        span.set_usage(input_tokens=1, cache_read_tokens=5, reasoning_tokens=-1)
    assert hue.export_status.instrumentation_failures == 0


def test_begin_model_starts_a_model_span_that_ends_only_through_end(receiver):
    with Hue(receiver.url, KEY, capture_content=True, live_spans=False) as hue:
        with hue.context(session_id="session-1", user_id="user-1"):
            with hue.span("request"):
                call = hue._begin_model(
                    "synthetic-model",
                    provider="synthetic",
                    attributes={"gen_ai.request.max_tokens": 64, "gen_ai.request.model": "x"},
                )
        assert call is not None
        assert hue.force_flush()
        # The model span outlives the block that started it.
        assert [span.name for span in receiver.spans()] == ["request"]
        call.handle.set_input([{"role": "user", "parts": [{"type": "text", "content": "hi"}]}])
        call.handle.set_usage(input_tokens=3, output_tokens=2, cache_read_tokens=None)
        call.end()
        call.end(RuntimeError("ignored after the first end"))
        assert hue.force_flush()
    spans = {span.name: span for span in receiver.spans()}
    root, model = spans["request"], spans["chat synthetic-model"]
    assert model.parent_span_id == root.span_id and model.trace_id == root.trace_id
    assert model.kind == 3  # SPAN_KIND_CLIENT
    values = attrs(model)
    assert values["gen_ai.operation.name"].string_value == "chat"
    assert values["gen_ai.request.model"].string_value == "synthetic-model"
    assert values["gen_ai.provider.name"].string_value == "synthetic"
    assert values["gen_ai.request.max_tokens"].int_value == 64
    assert values["gen_ai.conversation.id"].string_value == "session-1"
    assert values["user.id"].string_value == "user-1"
    assert values["gen_ai.usage.input_tokens"].int_value == 3
    assert "error.type" not in values
    assert json.loads(values["gen_ai.input.messages"].string_value) == [
        {"role": "user", "parts": [{"type": "text", "content": "hi"}]}
    ]
    assert model.end_time_unix_nano >= model.start_time_unix_nano


def test_begin_model_activate_restores_the_call_time_scope(receiver):
    with Hue(receiver.url, KEY, capture_content=False, live_spans=False) as hue:
        with hue.context(session_id="s1", workspace_id="w1"):
            with hue.span("first"):
                call = hue._begin_model("m", provider="openai")
        assert call is not None
        with hue.context(session_id="s2"):
            with hue.span("second"):
                with call.activate():
                    assert trace.get_current_span() is call.handle.otel_span
                    with hue.tool("lookup"):
                        pass
                assert trace.get_current_span() is not call.handle.otel_span
            assert hue._context_attributes.get() == {"gen_ai.conversation.id": "s2"}
        call.end()
        assert hue.force_flush()
    spans = {span.name: span for span in receiver.spans()}
    model, child = spans["chat m"], spans["execute_tool lookup"]
    assert child.parent_span_id == model.span_id
    assert attrs(child)["gen_ai.conversation.id"].string_value == "s1"
    assert attrs(child)["hue.workspace.id"].string_value == "w1"


def test_begin_model_activate_passes_exceptions_through(receiver):
    with Hue(receiver.url, KEY, capture_content=False, live_spans=False) as hue:
        call = hue._begin_model("m", provider="synthetic")
        assert call is not None
        failure = ValueError("provider failure")
        with pytest.raises(ValueError) as raised:
            with call.activate():
                raise failure
        assert raised.value is failure
        call.end(failure)
        assert hue.force_flush()
    (model,) = receiver.spans()
    assert attrs(model)["error.type"].string_value == "builtins.ValueError"
    assert model.status.code == 2
    assert b"provider failure" not in b"".join(body for _, _, body in receiver.requests)


def test_begin_model_ends_at_an_explicit_time(receiver):
    with Hue(receiver.url, KEY, capture_content=False, live_spans=False) as hue:
        call = hue._begin_model("m", provider="synthetic")
        assert call is not None
        started = call.last_activity_ns
        time.sleep(0.02)
        call.touch()
        touched = call.last_activity_ns
        time.sleep(0.02)
        call.end(end_time=call.last_activity_ns)
        assert hue.force_flush()
    (model,) = receiver.spans()
    assert model.start_time_unix_nano == started
    assert model.end_time_unix_nano == touched
    assert touched - started >= 15_000_000


def test_begin_model_returns_none_for_a_disabled_or_closed_client(receiver):
    disabled = Hue(enabled=False, capture_content=False)
    assert disabled._begin_model("m", provider="") is None
    assert disabled.export_status.instrumentation_failures == 0
    closed = Hue(receiver.url, KEY, capture_content=False)
    assert closed.shutdown()
    assert closed._begin_model("m", provider="synthetic") is None
    assert closed.export_status.instrumentation_failures == 0


def test_begin_model_validates_labels_as_model_does(receiver):
    with Hue(receiver.url, KEY, capture_content=False, live_spans=False) as hue:
        call = hue._begin_model(None, provider=3, name=b"x")
        assert call is not None
        call.end()
        assert not hue.force_flush()
        assert hue.export_status.instrumentation_failures == 3
    (model,) = receiver.spans()
    assert model.name == "chat unknown"
    assert attrs(model)["gen_ai.provider.name"].string_value == "unknown"


class _Stream:
    """Stands in for a provider stream: collected only by the cyclic collector, like the SDK's."""

    def __init__(self) -> None:
        self.cycle = self


def test_an_abandoned_call_is_queued_in_gc_and_ended_at_the_next_drain(receiver):
    import gc

    collecting = False
    ended_during_gc: list[bool] = []

    def watch(phase: str, _info: dict[str, int]) -> None:
        nonlocal collecting
        collecting = phase == "start"

    class Recorder(SimpleSpanProcessor):
        def on_end(self, span):
            ended_during_gc.append(collecting)
            super().on_end(span)

    memory = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(Recorder(memory))
    hue = Hue(receiver.url, KEY, capture_content=False, tracer_provider=provider, live_spans=False)
    gc.callbacks.append(watch)
    try:
        call = hue._begin_model("abandoned", provider="synthetic")
        kept = hue._begin_model("kept", provider="synthetic")
        assert call is not None and kept is not None
        stream, other = _Stream(), _Stream()
        call.end_when_collected(stream)
        kept.end_when_collected(other)
        time.sleep(0.01)
        call.touch()
        last = call.last_activity_ns
        # A call that ends normally cancels its finalizer.
        kept.end()
        del stream, other
        gc.collect()
        # The finalizer only queued the call: no span ended inside garbage collection.
        assert list(hue._abandoned) == [call]
        assert call.handle.otel_span.is_recording()
        assert ended_during_gc == [False]
        time.sleep(0.01)
        assert hue.force_flush()
        assert not hue._abandoned
        spans = {span.name: span for span in memory.get_finished_spans()}
        assert spans["chat abandoned"].end_time == last
        assert ended_during_gc == [False, False]
        # A later _begin_model drains too.
        again = hue._begin_model("again", provider="synthetic")
        assert again is not None
        again.end_when_collected(_Stream())
        gc.collect()
        assert list(hue._abandoned) == [again]
        assert hue._begin_model("next", provider="synthetic") is not None
        assert not hue._abandoned
        assert "chat again" in {span.name for span in memory.get_finished_spans()}
    finally:
        gc.callbacks.remove(watch)
        assert hue.shutdown()
    assert ended_during_gc and not any(ended_during_gc)


def test_shutdown_ends_abandoned_calls_before_it_stops_accepting_spans(receiver):
    import gc

    hue = Hue(receiver.url, KEY, capture_content=False, live_spans=False)
    call = hue._begin_model("abandoned", provider="synthetic")
    assert call is not None
    call.end_when_collected(_Stream())
    gc.collect()
    assert list(hue._abandoned) == [call]
    stop_accepting = hue._span_processor.stop_accepting
    seen: list[tuple[bool, int]] = []

    def observed() -> None:
        # The drain runs after the client is closed to new calls and right before this.
        seen.append((hue._closed, len(hue._abandoned)))
        stop_accepting()

    hue._span_processor.stop_accepting = observed
    assert hue.shutdown()
    assert seen and set(seen) == {(True, 0)}
    assert [span.name for span in receiver.spans()] == ["chat abandoned"]
    # A closed client starts no new model call, so none can be abandoned after the drain.
    assert hue._begin_model("late", provider="synthetic") is None
