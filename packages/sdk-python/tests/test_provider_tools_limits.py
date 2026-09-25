from __future__ import annotations

import json
from pathlib import Path

import pytest

from hue_sdk._provider_tools import (
    ABSENT,
    _error_code,
    hosted_server_addresses,
    hosted_tool_activity,
    provider_error_description,
)
from hue_sdk._tool_definitions import tool_catalog_summary

ERROR_TEXT_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "sdk-typescript"
    / "tests"
    / "fixtures"
    / "provider-error-text.json"
)
LISTING_DIGEST_FIXTURE = ERROR_TEXT_FIXTURE.with_name("provider-tool-listing.json")


def test_provider_calls_are_bounded_and_oversized_arguments_are_not_parsed():
    oversized = '{"value":"' + ("x" * 300_000) + '"}'
    activity = hosted_tool_activity(
        "openai",
        {
            "output": [
                {"type": "mcp_call", "id": "\x00", "name": "\ud800", "server_label": "\ud800"},
                {"type": "mcp_call", "id": "call-1", "name": "tool", "arguments": oversized},
                *(
                    {
                        "type": "mcp_call",
                        "id": f"call-{index + 2}",
                        "name": "tool",
                        "arguments": "{}",
                    }
                    for index in range(2_000)
                ),
            ]
        },
    )
    # The malformed first item is counted within the 128-item parse cap, so 127 valid calls remain.
    assert len(activity.calls) == 127
    assert activity.calls[0].arguments is ABSENT
    assert activity.skipped == 1_876


def test_oversized_mcp_arguments_are_counted_as_skipped():
    activity = hosted_tool_activity(
        "openai",
        {
            "output": [
                {
                    "type": "mcp_call",
                    "id": "oversized",
                    "name": "tool",
                    "arguments": "x" * 262_145,
                }
            ]
        },
    )
    assert len(activity.calls) == 1
    assert activity.calls[0].arguments is ABSENT
    assert activity.skipped == 1


def test_unpaired_surrogate_arguments_keep_the_call():
    arguments = '{"value":"\ud800"}'
    activity = hosted_tool_activity(
        "openai",
        {"output": [{"type": "mcp_call", "name": "tool", "arguments": arguments}]},
    )
    assert len(activity.calls) == 1
    assert activity.calls[0].arguments == arguments
    assert activity.skipped == 0


def test_provider_tool_definitions_are_bounded_per_listing():
    activity = hosted_tool_activity(
        "openai",
        {
            "output": [
                {
                    "type": "mcp_list_tools",
                    "server_label": "synthetic",
                    "tools": [{"name": f"tool-{index}"} for index in range(2_000)],
                }
            ]
        },
    )
    assert len(activity.listings[0].definitions) == 512
    assert activity.skipped == 1_488


def test_anthropic_use_without_bounded_result_is_skipped():
    activity = hosted_tool_activity(
        "anthropic",
        {
            "content": [
                {"type": "mcp_tool_use", "id": "call-0", "name": "tool", "input": {}},
                *(
                    {
                        "type": "mcp_tool_result",
                        "tool_use_id": f"result-{index}",
                        "content": {"type": "text", "text": "ok"},
                    }
                    for index in range(127)
                ),
                {
                    "type": "mcp_tool_result",
                    "tool_use_id": "call-0",
                    "content": {"type": "text", "text": "ok"},
                },
            ]
        },
    )
    assert activity.calls == []
    assert activity.skipped == 1


def test_deep_arguments_do_not_drop_sibling_calls():
    activity = hosted_tool_activity(
        "openai",
        {
            "output": [
                {
                    "type": "mcp_call",
                    "id": "deep",
                    "name": "deep",
                    "arguments": "[" * 100_000 + "]" * 100_000,
                },
                {"type": "mcp_call", "id": "valid", "name": "valid", "arguments": "{}"},
            ]
        },
    )
    assert [call.name for call in activity.calls] == ["deep", "valid"]
    assert activity.calls[0].arguments != ABSENT


def test_provider_server_addresses_reject_unsafe_urls():
    host_253 = ".".join(("a" * 63, "b" * 63, "c" * 63, "d" * 61))
    host_255 = ".".join(("a" * 63,) * 4)
    assert hosted_server_addresses(
        "openai",
        {
            "tools": [
                {
                    "server_label": "backslash",
                    "server_url": "https://mcp.example.test\\sk-live-secret/sse",
                },
                {"server_label": "nul", "server_url": "https://mcp.example.test/\x00/sse"},
                {"server_label": "ok", "server_url": "https://mcp.example.test/sse"},
                {"server_label": "path-semi", "server_url": "https://mcp.example.test/sse;v=1"},
                {"server_label": "idn", "server_url": "https://münchen.example/sse"},
                {"server_label": "absolute", "server_url": "https://mcp.example.test./sse"},
                {"server_label": "max", "server_url": f"https://{host_253}/sse"},
                {"server_label": "too-long", "server_url": f"https://{host_255}/sse"},
            ]
        },
    ) == {
        "ok": "mcp.example.test",
        "path-semi": "mcp.example.test",
        "idn": "xn--mnchen-3ya.example",
        "absolute": "mcp.example.test.",
        "max": host_253,
    }


@pytest.mark.parametrize(
    "url",
    [
        "https://mcp.example.test%5Csk-live-secret/sse",
        "https://mcp.example.test\uff3csk-live-secret/sse",
        "https://mcp.example.test;sk-live-secret/sse",
        "https://mcp.example.test /sse",
        "https://mcp.example.test\u200b/sse",
        "https://[fe80::1%25eth0]/sse",
        "https://[v1.sk-live-secret]/sse",
        "https://" + ("a" * 254) + ".test/sse",
        "https://mcp.example.test\ud800/sse",
    ],
)
def test_provider_server_addresses_reject_ambiguous_or_invalid_hosts(url):
    assert (
        hosted_server_addresses(
            "openai", {"tools": [{"server_label": "unsafe", "server_url": url}]}
        )
        == {}
    )


class _RaisingType:
    @property
    def type(self):
        raise RuntimeError("synthetic type failure")


def test_broken_tail_item_does_not_discard_bounded_prefix():
    activity = hosted_tool_activity(
        "openai",
        {
            "output": [
                *(
                    {"type": "mcp_call", "id": f"call-{index}", "name": "tool"}
                    for index in range(128)
                ),
                _RaisingType(),
            ]
        },
    )
    assert len(activity.calls) == 128
    assert activity.skipped == 1


def test_broken_anthropic_tail_item_does_not_discard_bounded_prefix():
    activity = hosted_tool_activity(
        "anthropic",
        {
            "content": [
                *[
                    item
                    for index in range(64)
                    for item in (
                        {"type": "server_tool_use", "id": f"call-{index}", "name": "tool"},
                        {
                            "type": "server_tool_result",
                            "tool_use_id": f"call-{index}",
                            "content": {"type": "text", "text": "ok"},
                        },
                    )
                ],
                _RaisingType(),
            ]
        },
    )
    assert len(activity.calls) == 64
    assert activity.skipped == 1


@pytest.mark.parametrize("value", ["UPPER", "a" * 65, "ok\n", "bad-code"])
def test_error_codes_are_bounded(value):
    assert _error_code(value) == "error"


class _WarningsModel:
    def __init__(self):
        self.warning_argument = None

    def model_dump(self, *, warnings):
        self.warning_argument = warnings
        return {"output": [{"type": "mcp_call", "name": "tool", "arguments": "{}"}]}


def test_model_dump_disables_content_warnings():
    response = _WarningsModel()
    activity = hosted_tool_activity("openai", response, capture_content=False)
    assert response.warning_argument is False
    assert len(activity.calls) == 1


class _PydanticV1Model:
    def model_dump(self, **kwargs):
        if "warnings" in kwargs:
            raise ValueError("warnings is only supported in Pydantic v2")
        return {"output": [{"type": "mcp_call", "name": "tool", "arguments": "{}"}]}


def test_model_dump_falls_back_for_pydantic_v1():
    activity = hosted_tool_activity("openai", _PydanticV1Model(), capture_content=False)
    assert len(activity.calls) == 1


def test_each_call_carries_its_items_position_in_the_response():
    openai = hosted_tool_activity(
        "openai",
        {
            "output": [
                {"type": "reasoning", "summary": []},
                {"type": "mcp_list_tools", "server_label": "gmail", "tools": []},
                {"type": "mcp_call", "id": "mcp-1", "name": "search", "server_label": "gmail"},
                {"type": "message", "content": []},
                {"type": "web_search_call", "id": "ws-1", "action": {}},
                {"type": "mcp_call", "id": "mcp-2", "name": "create", "server_label": "gmail"},
            ]
        },
    )
    assert [(call.call_id, call.position) for call in openai.calls] == [
        ("mcp-1", 2),
        ("ws-1", 4),
        ("mcp-2", 5),
    ]
    anthropic = hosted_tool_activity(
        "anthropic",
        {
            "content": [
                {"type": "text", "text": "Looking"},
                {"type": "server_tool_use", "id": "srv-1", "name": "web_search", "input": {}},
                {"type": "web_search_tool_result", "tool_use_id": "srv-1", "content": []},
                {"type": "mcp_tool_use", "id": "mcp-1", "name": "post", "server_name": "slack"},
                {"type": "mcp_tool_result", "tool_use_id": "mcp-1", "content": []},
            ]
        },
    )
    assert [(call.call_id, call.position) for call in anthropic.calls] == [
        ("srv-1", 1),
        ("mcp-1", 3),
    ]


class _UnreadableModel:
    """An SDK response object that cannot be dumped."""

    def model_dump(self, **_options):
        raise RuntimeError("synthetic dump failure")


def test_an_unreadable_prefix_item_keeps_the_positions_of_the_others():
    activity = hosted_tool_activity(
        "openai",
        {"output": [_UnreadableModel(), {"type": "mcp_call", "id": "a", "name": "tool"}]},
    )
    assert [(call.call_id, call.position) for call in activity.calls] == [("a", 1)]
    assert activity.skipped == 1


@pytest.mark.parametrize("capture_content", [True, False])
def test_failed_mcp_call_error_text_is_read_only_under_content_capture(capture_content):
    activity = hosted_tool_activity(
        "openai",
        {
            "output": [
                {"type": "mcp_call", "id": "a", "name": "tool", "error": "Rate limited"},
                {"type": "mcp_call", "id": "b", "name": "tool", "error": {"message": "Denied"}},
                {"type": "mcp_call", "id": "c", "name": "tool", "error": {"code": 500}},
                {"type": "mcp_call", "id": "d", "name": "tool", "error": "   "},
            ]
        },
        capture_content,
    )
    assert [(call.error_type, call.error_text) for call in activity.calls] == [
        ("mcp_error", "Rate limited" if capture_content else None),
        ("mcp_error", "Denied" if capture_content else None),
        ("mcp_error", None),
        ("mcp_error", None),
    ]


def test_error_text_is_scrubbed_and_bounded_identically_to_the_typescript_sdk():
    if not ERROR_TEXT_FIXTURE.is_file():
        pytest.skip("Shared fixtures are not part of this checkout")
    for case in json.loads(ERROR_TEXT_FIXTURE.read_text(encoding="utf-8"))["cases"]:
        assert provider_error_description(case["input"]) == case["expected"]
    assert provider_error_description("x" * 1_100) == "x" * 1_024 + "\u2026"
    assert provider_error_description("x" * 1_024) == "x" * 1_024
    # Scrubbed before the cut: a credential that straddles the bound never shows a prefix.
    straddling = provider_error_description("a" * 1_015 + " token=synthetic-secret-value")
    assert "synthetic" not in straddling and straddling.endswith("\u2026")
    assert len(provider_error_description("\U0001f600" * 1_030)) == 1_025


def test_server_address_keeps_an_underscore_in_a_host_name():
    # WHATWG URL parsing, and so the TypeScript SDK, keeps underscores: they are legal in DNS
    # labels and name real servers, such as Docker Compose services and internal hosts.
    assert hosted_server_addresses(
        "openai",
        {
            "tools": [
                {"server_label": "compose", "server_url": "http://mcp_server:8080/sse"},
                {
                    "server_label": "internal",
                    "server_url": "https://mcp_gateway.internal.example/mcp",
                },
            ]
        },
    ) == {"compose": "mcp_server", "internal": "mcp_gateway.internal.example"}


def test_a_listing_s_null_fields_are_left_out_so_both_sdks_digest_its_catalog_alike():
    # The TypeScript suite reads the same fixture and checks the same names and digest.
    fixture = json.loads(LISTING_DIGEST_FIXTURE.read_text(encoding="utf-8"))
    [listing] = hosted_tool_activity("openai", fixture["response"]).listings
    for definition in listing.definitions:
        assert None not in definition.values()
    assert tool_catalog_summary(json.dumps(listing.definitions)) == fixture["expected"]
