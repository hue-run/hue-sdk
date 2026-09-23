"""Provider-executed ("hosted") tool calls read from a model provider's response.

OpenAI Responses output items and Anthropic Messages content blocks describe tools the provider
ran itself, which no ``hue.tool()`` block saw. ``HueSpan.record_provider_tool_calls`` turns them
into ``execute_tool`` spans of type ``extension`` after the fact. Mirrors the TypeScript SDK's
``provider-tools.ts``.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

ABSENT: Any = object()
"""Marks arguments or a result the response did not carry, as distinct from ``None``."""


@dataclass
class HostedToolCall:
    name: str
    call_id: str | None = None
    # The provider's label (OpenAI ``server_label``) or name (Anthropic ``server_name``).
    server: str | None = None
    arguments: Any = ABSENT
    result: Any = ABSENT
    # Low-cardinality failure marker for ``error.type``; ``None`` when the call succeeded.
    error_type: str | None = None


@dataclass
class HostedToolListing:
    server: str
    # Tool definitions in the OpenTelemetry GenAI shape (``type``, ``name``, ``description``,
    # ``parameters``).
    definitions: list[dict[str, Any]]
    error_type: str | None = None


@dataclass
class HostedToolActivity:
    calls: list[HostedToolCall] = field(default_factory=list)
    listings: list[HostedToolListing] = field(default_factory=list)
    # Items that looked like hosted calls but could not be read.
    skipped: int = 0


def hosted_tool_provider(value: Any) -> str | None:
    """The provider a ``model()`` block named, when this module can read its responses."""
    provider = value.lower() if isinstance(value, str) else None
    return provider if provider in ("openai", "anthropic") else None


def _data(value: Any) -> Any:
    """Plain data for a response or item: SDK models are dumped, mappings and sequences copied."""
    dump = getattr(value, "model_dump", None)
    if callable(dump) and not isinstance(value, (Mapping, str, bytes)):
        return dump()
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return list(value)
    return value


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value.strip() and len(value) <= 256 else None


def _json_arguments(value: Any) -> Any:
    """MCP arguments arrive as JSON text; record the structure when it parses, else the text."""
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except ValueError:
        return value


def _openai_calls(items: list[Any], activity: HostedToolActivity) -> None:
    """OpenAI Responses ``output`` items. Built-in tools are named by kind, MCP calls by tool."""
    for item in items:
        item = _data(item)
        if not isinstance(item, dict):
            continue
        kind = item.get("type")
        call_id = _text(item.get("id"))
        if kind == "mcp_call":
            name = _text(item.get("name"))
            if name is None:
                activity.skipped += 1
                continue
            activity.calls.append(
                HostedToolCall(
                    name,
                    call_id,
                    _text(item.get("server_label")),
                    _json_arguments(item.get("arguments")),
                    item["output"] if item.get("output") is not None else ABSENT,
                    "mcp_error" if item.get("error") is not None else None,
                )
            )
        elif kind == "mcp_list_tools":
            server = _text(item.get("server_label"))
            tools = item.get("tools")
            if server is None or not isinstance(tools, list):
                activity.skipped += 1
                continue
            definitions = []
            for tool in tools:
                tool = _data(tool)
                if not isinstance(tool, dict):
                    continue
                definition: dict[str, Any] = {"type": "function"}
                for source, target in (
                    ("name", "name"),
                    ("description", "description"),
                    ("input_schema", "parameters"),
                    ("annotations", "annotations"),
                ):
                    if source in tool and tool[source] is not None:
                        definition[target] = tool[source]
                definitions.append(definition)
            activity.listings.append(
                HostedToolListing(
                    server, definitions, "mcp_error" if item.get("error") is not None else None
                )
            )
        elif kind in ("web_search_call", "file_search_call", "code_interpreter_call"):
            name = kind[: -len("_call")]
            error_type = "failed" if item.get("status") == "failed" else None
            if kind == "web_search_call":
                arguments, result = item.get("action"), ABSENT
            elif kind == "file_search_call":
                arguments = {"queries": item.get("queries")}
                result = item["results"] if item.get("results") is not None else ABSENT
            else:
                arguments = {"code": item.get("code"), "container_id": item.get("container_id")}
                result = item["outputs"] if item.get("outputs") is not None else ABSENT
            activity.calls.append(
                HostedToolCall(name, call_id, None, arguments, result, error_type)
            )
        # Messages, reasoning, approval requests and other items are not executed tools.


def _anthropic_calls(blocks: list[Any], activity: HostedToolActivity) -> None:
    """Anthropic Messages ``content`` blocks: a use block paired with the result that names it."""
    blocks = [_data(block) for block in blocks]
    results: dict[str, dict[str, Any]] = {}
    for block in blocks:
        if (
            isinstance(block, dict)
            and isinstance(block.get("type"), str)
            and block["type"].endswith("_tool_result")
            and isinstance(block.get("tool_use_id"), str)
        ):
            results[block["tool_use_id"]] = block
    for block in blocks:
        if not isinstance(block, dict) or block.get("type") not in (
            "mcp_tool_use",
            "server_tool_use",
        ):
            continue
        name = _text(block.get("name"))
        call_id = _text(block.get("id"))
        if name is None:
            activity.skipped += 1
            continue
        result = results.get(call_id) if call_id is not None else None
        content = _data(result.get("content")) if result is not None else ABSENT
        error_type = None
        if result is not None and result.get("is_error") is True:
            error_type = "mcp_error"
        elif (
            isinstance(content, dict)
            and isinstance(content.get("type"), str)
            and content["type"].endswith("_error")
        ):
            error_type = _text(content.get("error_code")) or "error"
        activity.calls.append(
            HostedToolCall(
                name,
                call_id,
                _text(block.get("server_name")) if block["type"] == "mcp_tool_use" else None,
                block.get("input"),
                content if result is not None and "content" in result else ABSENT,
                error_type,
            )
        )


def hosted_tool_activity(provider: str, response: Any) -> HostedToolActivity:
    """The hosted tool calls in a provider response.

    Reads the ``output`` items of an OpenAI Responses API response or the ``content`` blocks of an
    Anthropic Messages API response; a list is taken as those items directly. SDK response objects
    are read through ``model_dump()``. Anything else yields no calls.
    """
    activity = HostedToolActivity()
    response = _data(response)
    items = (
        response
        if isinstance(response, list)
        else response.get("output" if provider == "openai" else "content")
        if isinstance(response, dict)
        else None
    )
    items = _data(items)
    if not isinstance(items, list):
        return activity
    if provider == "openai":
        _openai_calls(items, activity)
    else:
        _anthropic_calls(items, activity)
    return activity


def hosted_server_addresses(provider: str, request: Any) -> dict[str, str]:
    """Each hosted MCP server's host by label, read from the request that produced the response.

    OpenAI: ``tools[].server_url`` by ``server_label``; Anthropic: ``mcp_servers[].url`` by
    ``name``. Nothing else in the request is read.
    """
    addresses: dict[str, str] = {}
    request = _data(request)
    if not isinstance(request, dict):
        return addresses
    entries = _data(request.get("tools" if provider == "openai" else "mcp_servers"))
    if not isinstance(entries, list):
        return addresses
    for entry in entries:
        entry = _data(entry)
        if not isinstance(entry, dict):
            continue
        label = _text(entry.get("server_label" if provider == "openai" else "name"))
        url = entry.get("server_url" if provider == "openai" else "url")
        if label is None or not isinstance(url, str):
            continue
        try:
            hostname = urlsplit(url).hostname
        except ValueError:
            continue
        if hostname:
            addresses[label] = hostname
    return addresses
