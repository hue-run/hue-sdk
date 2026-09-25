"""Provider-executed tool spans as they reach Hue.

The call position, the metadata-only catalog summary on ``tools/list``, the provider's error text
on a failed MCP call and ``server.address``, mirroring the TypeScript SDK's
``provider-tool-spans.test.ts``.
"""

from __future__ import annotations

import json
import time

import pytest

from hue_sdk import Hue
from hue_sdk._provider_tools import hosted_tool_activity
from hue_sdk._tool_definitions import with_tool_catalog_summary

KEY = "synthetic-provider-span-key"
DEFINITIONS = [
    {
        "name": "search_threads",
        "description": "private description marker",
        "input_schema": {
            "type": "object",
            "properties": {"private_schema_marker": {"type": "string"}},
        },
    },
    {"name": "create_draft", "input_schema": {"type": "object"}},
]
ERROR_TEXT = (
    "Upstream rejected Authorization: Bearer synthetic-bearer-secret at "
    "https://synthetic-user:synthetic-pass@mcp_server.internal:8443/mcp"
    "?key=synthetic-query-secret"
)
OPENAI_RESPONSE = {
    "output": [
        {"type": "reasoning", "summary": []},
        {"type": "mcp_list_tools", "server_label": "gmail", "tools": DEFINITIONS},
        {
            "type": "mcp_call",
            "id": "mcp-1",
            "name": "search_threads",
            "server_label": "gmail",
            "arguments": "{}",
        },
        {"type": "message", "content": []},
        {
            "type": "mcp_call",
            "id": "mcp-2",
            "name": "create_draft",
            "server_label": "gmail",
            "arguments": "{}",
            "output": None,
            "error": ERROR_TEXT,
        },
        {"type": "web_search_call", "id": "ws-1", "action": {"query": "q"}},
    ]
}
OPENAI_REQUEST = {
    "tools": [{"type": "mcp", "server_label": "gmail", "server_url": "http://mcp_server:8080/sse"}]
}
ANTHROPIC_RESPONSE = {
    "content": [
        {"type": "text", "text": "Looking"},
        {"type": "server_tool_use", "id": "srv-1", "name": "web_search", "input": {}},
        {"type": "web_search_tool_result", "tool_use_id": "srv-1", "content": []},
        {
            "type": "mcp_tool_use",
            "id": "mcp-3",
            "name": "post",
            "server_name": "slack",
            "input": {},
        },
        {"type": "mcp_tool_result", "tool_use_id": "mcp-3", "content": []},
    ]
}


def attrs(span):
    return {attribute.key: attribute.value for attribute in span.attributes}


def record(receiver, capture_content, redactor=None):
    with Hue(receiver.url, KEY, capture_content=capture_content, redactor=redactor) as hue:
        with hue.model("synthetic-model", provider="openai") as span:
            span.record_provider_tool_calls(OPENAI_RESPONSE, request=OPENAI_REQUEST)
            span.record_provider_tool_calls(ANTHROPIC_RESPONSE, provider="anthropic")
        hue.force_flush()
        assert hue.export_status.instrumentation_failures == 0
    spans = receiver.spans()
    raw = b" ".join(body for _, _, body in receiver.requests)
    return spans, raw


def named(spans, name):
    return [span for span in spans if span.name == name]


@pytest.mark.parametrize("capture_content", [True, False])
def test_each_call_records_its_position_in_the_response(receiver, capture_content):
    spans, _ = record(receiver, capture_content)

    def position(name):
        return [attrs(span)["hue.tool.call.position"].int_value for span in named(spans, name)]

    assert position("execute_tool search_threads") == [2]
    assert position("execute_tool create_draft") == [4]
    assert position("execute_tool web_search") == [5, 1]
    assert position("execute_tool post") == [3]


def test_metadata_only_listing_carries_names_and_the_digest_content_export_would_summarize(
    receiver,
):
    content_spans, content_raw = record(receiver, True)
    receiver.requests.clear()
    metadata_spans, metadata_raw = record(receiver, False)
    captured = attrs(named(content_spans, "tools/list")[0])
    summarized = attrs(named(metadata_spans, "tools/list")[0])
    # Content capture is unchanged: the definitions themselves, no summary.
    exported = captured["gen_ai.tool.definitions"].string_value
    assert "hue.tool.names" not in captured
    # Metadata-only: the summary #90 gives any record's definitions, and nothing more.
    expected = with_tool_catalog_summary({"gen_ai.tool.definitions": exported})
    assert [value.string_value for value in summarized["hue.tool.names"].array_value.values] == [
        "search_threads",
        "create_draft",
    ]
    assert (
        summarized["hue.tool.definitions.sha256"].string_value
        == expected["hue.tool.definitions.sha256"]
    )
    assert "gen_ai.tool.definitions" not in summarized
    for marker in (b"private description marker", b"private_schema_marker"):
        assert marker in content_raw
        assert marker not in metadata_raw


def test_failed_mcp_call_exports_scrubbed_error_text_only_under_content_capture(receiver):
    content_spans, content_raw = record(receiver, True)
    receiver.requests.clear()
    metadata_spans, metadata_raw = record(receiver, False)
    failed = named(content_spans, "execute_tool create_draft")[0]
    assert attrs(failed)["error.type"].string_value == "mcp_error"
    assert failed.status.code == 2
    assert failed.status.message == (
        "Upstream rejected Authorization: [redacted] at "
        "https://mcp_server.internal:8443/mcp?key=%5Bredacted%5D"
    )
    for secret in (b"synthetic-bearer-secret", b"synthetic-query-secret", b"synthetic-pass"):
        assert secret not in content_raw
    type_only = named(metadata_spans, "execute_tool create_draft")[0]
    assert attrs(type_only)["error.type"].string_value == "mcp_error"
    assert type_only.status.code == 2 and type_only.status.message == ""
    assert b"Upstream rejected" not in metadata_raw


def test_the_redactor_sees_the_error_text_as_status_message(receiver):
    seen = []

    def redactor(field, value):
        seen.append(field)
        return (
            value.replace("Upstream", "[customer-redacted]") if field == "status.message" else value
        )

    spans, _ = record(receiver, True, redactor)
    failed = named(spans, "execute_tool create_draft")[0]
    assert "status.message" in seen
    assert failed.status.message.startswith("[customer-redacted] rejected")


def test_a_redactor_returning_oversized_status_text_omits_it_as_an_issue(receiver):
    # 100,000 emoji: under the 256 KiB bound in characters, about 400 KB of UTF-8.
    def redactor(field, value):
        return "\U0001f600" * 100_000 if field == "status.message" else value

    with Hue(receiver.url, KEY, capture_content=True, redactor=redactor) as hue:
        with hue.model("synthetic-model", provider="openai") as span:
            span.record_provider_tool_calls(OPENAI_RESPONSE, request=OPENAI_REQUEST)
        hue.force_flush()
        assert hue.export_status.instrumentation_failures == 1
    failed = named(receiver.spans(), "execute_tool create_draft")[0]
    assert failed.status.code == 2 and failed.status.message == ""


def test_a_large_metadata_only_catalog_keeps_its_summary(receiver):
    # About 420 KB of definitions: over one content field's 256 KiB, within one export request.
    tools = [
        {"name": f"tool_{index}", "description": "d" * 1_300, "input_schema": {"type": "object"}}
        for index in range(300)
    ]
    response = {"output": [{"type": "mcp_list_tools", "server_label": "big", "tools": tools}]}
    with Hue(receiver.url, KEY, capture_content=False) as hue:
        with hue.model("synthetic-model", provider="openai") as span:
            span.record_provider_tool_calls(response)
        hue.force_flush()
        assert hue.export_status.instrumentation_failures == 0
    listing = attrs(named(receiver.spans(), "tools/list")[0])
    [parsed] = hosted_tool_activity("openai", response).listings
    expected = with_tool_catalog_summary(
        {"gen_ai.tool.definitions": json.dumps(parsed.definitions)}
    )
    names = [value.string_value for value in listing["hue.tool.names"].array_value.values]
    assert names == [f"tool_{index}" for index in range(300)]
    assert (
        listing["hue.tool.definitions.sha256"].string_value
        == expected["hue.tool.definitions.sha256"]
    )


def test_128_failed_mcp_calls_with_adversarial_error_text_are_recorded_in_bounded_time(receiver):
    # A run that made the URL pattern's scheme quadratic, filling the 16,384-character window
    # error text is scrubbed in, from every call a response can carry.
    output = [
        {
            "type": "mcp_call",
            "id": f"mcp-{index}",
            "name": "search",
            "server_label": "gmail",
            "arguments": "{}",
            "error": "a." * 8_192,
        }
        for index in range(128)
    ]
    with Hue(receiver.url, KEY, capture_content=True) as hue:
        with hue.model("synthetic-model", provider="openai") as span:
            started = time.perf_counter()
            span.record_provider_tool_calls({"output": output})
            elapsed = time.perf_counter() - started
        hue.force_flush()
        assert hue.export_status.instrumentation_failures == 0
    # Quadratic, this took over a minute in CPython; linear, it takes about a second.
    assert elapsed < 10
    failed = named(receiver.spans(), "execute_tool search")
    assert len(failed) == 128
    assert all(len(span.status.message) <= 1_025 for span in failed)


def test_server_address_keeps_an_underscore_in_the_mcp_server_host(receiver):
    spans, _ = record(receiver, False)
    search = named(spans, "execute_tool search_threads")[0]
    assert attrs(search)["server.address"].string_value == "mcp_server"
