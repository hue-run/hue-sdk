from __future__ import annotations

from hue_sdk._provider_tools import ABSENT, hosted_server_addresses, hosted_tool_activity


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
    assert activity.skipped == 1_875


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
                    "arguments": "[" * 1000 + "]" * 1000,
                },
                {"type": "mcp_call", "id": "valid", "name": "valid", "arguments": "{}"},
            ]
        },
    )
    assert [call.name for call in activity.calls] == ["deep", "valid"]
    assert activity.calls[0].arguments != ABSENT


def test_provider_server_addresses_reject_unsafe_urls():
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
            ]
        },
    ) == {"ok": "mcp.example.test"}
