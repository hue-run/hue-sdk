from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from hue_sdk._provider_tools import (
    ABSENT,
    _error_code,
    hosted_server_addresses,
    hosted_tool_activity,
    provider_error_description,
)
from hue_sdk._tool_definitions import (
    _scrub_credential_text_unbounded,
    scrub_credential_text,
    tool_catalog_summary,
)

ERROR_TEXT_FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "sdk-typescript"
    / "tests"
    / "fixtures"
    / "provider-error-text.json"
)
LISTING_DIGEST_FIXTURE = ERROR_TEXT_FIXTURE.with_name("provider-tool-listing.json")
PLANTED_SECRETS_FIXTURE = ERROR_TEXT_FIXTURE.with_name("planted-secrets.json")
# The provider items one response is read for; later items are counted as skipped.
ITEMS = 1024


def test_provider_calls_are_bounded_and_oversized_arguments_are_not_parsed():
    # Over the 1 MiB value cap, so it is not parsed.
    oversized = '{"value":"' + ("x" * 1_100_000) + '"}'
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
    # The malformed first item is counted within the parse cap, so one fewer valid call remains;
    # it and the oversized arguments are skipped with every item past the cap.
    assert len(activity.calls) == ITEMS - 1
    assert activity.calls[0].arguments is ABSENT
    assert activity.skipped == 2_002 - ITEMS + 2


def test_oversized_mcp_arguments_are_counted_as_skipped():
    activity = hosted_tool_activity(
        "openai",
        {
            "output": [
                {
                    "type": "mcp_call",
                    "id": "oversized",
                    "name": "tool",
                    "arguments": "x" * 1_048_577,
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
                    for index in range(ITEMS - 1)
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
                    for index in range(ITEMS)
                ),
                _RaisingType(),
            ]
        },
    )
    assert len(activity.calls) == ITEMS
    assert activity.skipped == 1


def test_broken_anthropic_tail_item_does_not_discard_bounded_prefix():
    activity = hosted_tool_activity(
        "anthropic",
        {
            "content": [
                *[
                    item
                    for index in range(ITEMS // 2)
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
    assert len(activity.calls) == ITEMS // 2
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
    for case in json.loads(ERROR_TEXT_FIXTURE.read_text(encoding="utf-8"))["cases"]:
        assert provider_error_description(case["input"]) == case["expected"]
    assert provider_error_description("x" * 1_100) == "x" * 1_024 + "\u2026"
    assert provider_error_description("x" * 1_024) == "x" * 1_024
    # Scrubbed before the cut: the 1,024th code point falls inside ``[redacted]``, never inside a
    # credential, where cutting first would leave its start to be scrubbed on its own.
    assert (
        provider_error_description("a" * 1_015 + " token=synthetic-secret-value")
        == "a" * 1_015 + " token=[r\u2026"
    )
    assert (
        provider_error_description("a" * 1_010 + ' password="synthetic two words"')
        == "a" * 1_010 + ' password="[re\u2026'
    )
    assert len(provider_error_description("\U0001f600" * 1_030)) == 1_025


@pytest.mark.parametrize(
    ("kept", "rest", "exported"),
    [
        ('password="synthetic-first synth', 'etic-second"', 'password="[redacted]'),
        ("https://synthetic-us", "er:synthetic-pass@mcp.example.test/", "[redacted]"),
        ("see hue_sk_syn", "thetic0123456789", "see [redacted]"),
        ('headers={"Authorization": "Bot synth', 'etic"}', "headers=[redacted]"),
        # Text the cut does not interrupt keeps its words.
        (
            "see https://mcp.example.test/sse next ",
            "words",
            "see https://mcp.example.test/sse next ",
        ),
    ],
)
def test_what_the_scan_cuts_through_is_redacted_to_the_cut_as_in_the_typescript_sdk(
    kept: str, rest: str, exported: str
):
    # The long value before it is scrubbed to ``[redacted]``, so the text at the 16,384-code-point
    # cut is exported; ``kept`` ends at the cut and ``rest`` is past it.
    lead = "token=" + "x" * 16_000 + " "
    filler = "y" * (16_384 - len(lead) - len(kept) - 1)
    assert (
        provider_error_description(f"{lead}{filler} {kept}{rest}")
        == f"token=[redacted] {filler} {exported}\u2026"
    )


def test_an_escaped_space_ends_a_credential_so_a_run_of_them_scrubs_in_linear_time():
    # Each ``Bearer%20`` starts a credential; were ``%20`` part of one, each would run to the end.
    started = time.perf_counter()
    scrubbed = _scrub_credential_text_unbounded("Bearer%20" * 111_112)
    assert scrubbed.startswith("Bearer%20[redacted]%20[redacted]%20")
    assert "Bearer%20Bearer" not in scrubbed
    assert time.perf_counter() - started < 10


def test_a_bracketed_value_full_of_escaped_quotes_scrubs_in_linear_time():
    # A string between backslash-escaped quotes that a bare quote ends is read once, not again
    # from each escaped quote inside it.
    started = time.perf_counter()
    text = 'token: [\\"' + '\\\\\\"' * 50_000 + '"'
    assert _scrub_credential_text_unbounded(text) == "token: [redacted]"
    assert time.perf_counter() - started < 10


def test_a_url_of_500_000_escaped_values_is_read_to_its_end():
    # A URL is read a piece at a time, as in the TypeScript SDK, where one repeated pattern made
    # Bun's regular expression engine match nothing on a URL this long.
    started = time.perf_counter()
    scrubbed = _scrub_credential_text_unbounded(
        "see https://h.example.test/?sig=synthetic-sig" + '&a=\\"x\\"' * 500_000
    )
    assert scrubbed.startswith("see https://h.example.test/?sig=%5Bredacted%5D&a=%5Bredacted%5D")
    assert "synthetic-sig" not in scrubbed
    assert time.perf_counter() - started < 30


def test_a_query_full_of_question_marks_is_read_once_for_names_holding_a_url():
    # A name starts at the query's ``?`` or an ``&``; were every ``?`` a start, each would be read
    # to the end of the query.
    started = time.perf_counter()
    assert "https://h.example.test/?" in _scrub_credential_text_unbounded(
        "https://h.example.test/?" + "?" * 100_000
    )
    assert time.perf_counter() - started < 10


def test_a_text_longer_than_16_384_code_points_is_scrubbed_to_there_and_cut():
    # As in the TypeScript SDK, where an escaped value this long in a URL is past what Bun's
    # regular expression engine reads.
    scrubbed = scrub_credential_text(
        'see https://h.example.test/?t=\\"synthetic-long-value' + "b" * 200_000
    )
    assert "synthetic-long-value" not in scrubbed
    assert scrubbed.endswith("…")
    assert len(scrubbed) < 16_384


def test_a_scheme_that_a_cut_text_ends_in_or_right_after_is_replaced_whole():
    for end in ("wss://", "wss:/", "wss:", "ws"):
        assert scrub_credential_text(f"see x>synthetic-cut-glue-{end}", True) == "see x>[redacted]"
    # The 16,384-code-point cut falls inside the ``://``.
    text = "a " * 8_179 + "synthetic-cap-glue-redis://h?x=1"
    assert scrub_credential_text(text) == "a " * 8_179 + "[redacted]…"


def test_a_run_of_authorization_values_inside_each_others_first_word_is_read_once():
    # Each value starting inside the one before's first word ends where that one does; were each
    # read again to the end, 20,000 of them would take seconds.
    started = time.perf_counter()
    for value in ("Authorization=>%5Bredacted%5D\\", "Authorization=%5Bredacted%5D&"):
        assert "%5Bredacted%5D" not in _scrub_credential_text_unbounded(value * 20_000)
    assert time.perf_counter() - started < 3


def test_a_run_of_backslashes_in_a_value_that_does_not_close_is_read_once():
    # Each run can be read only one way; were it two, 80 backslashes would take seconds and 200
    # would not finish.
    for count in (80, 200):
        started = time.perf_counter()
        provider_error_description('{"error": "token=\\"' + "\\" * count + '"x"}')
        _scrub_credential_text_unbounded('token: [\\"' + "\\" * count + '"x')
        assert time.perf_counter() - started < 0.1
    started = time.perf_counter()
    for value in ('token=\\"', 'token: [\\"', '?t=\\"'):
        _scrub_credential_text_unbounded(value + "\\" * 200_000 + "x\n")
    assert time.perf_counter() - started < 10


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


def test_every_secret_planted_in_the_shared_corpus_is_redacted_alone_or_all_at_once():
    # The TypeScript suite checks the same corpus; ``planted-secrets.py`` regenerates it from its
    # seed.
    cases = json.loads(PLANTED_SECRETS_FIXTURE.read_text(encoding="utf-8"))["cases"]
    started = time.perf_counter()
    leaked = [
        secret
        for case in cases
        for secret in case["secrets"]
        if secret in scrub_credential_text(case["input"])
    ]
    assert leaked == []
    # The whole corpus as one text: every secret still redacted, in time linear in its length.
    whole = _scrub_credential_text_unbounded("\n".join(case["input"] for case in cases))
    assert [secret for case in cases for secret in case["secrets"] if secret in whole] == []
    assert time.perf_counter() - started < 10
