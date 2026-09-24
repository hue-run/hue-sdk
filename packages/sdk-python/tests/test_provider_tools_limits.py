from __future__ import annotations

from hue_sdk._provider_tools import ABSENT, hosted_tool_activity


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
    assert activity.skipped > 1_800


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
