"""Provider-executed ("hosted") tool calls read from a model provider's response.

OpenAI Responses output items and Anthropic Messages content blocks describe tools the provider
ran itself, which no ``hue.tool()`` block saw. ``HueSpan.record_provider_tool_calls`` turns them
into ``execute_tool`` spans of type ``extension`` after the fact. Mirrors the TypeScript SDK's
``provider-tools.ts``.
"""

from __future__ import annotations

import ipaddress
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from .transport import MAX_CONTENT_BYTES

ABSENT: Any = object()
"""Marks arguments or a result the response did not carry, as distinct from ``None``."""
MAX_PROVIDER_ITEMS = 128
MAX_PROVIDER_DEFINITIONS = 512
MAX_PROVIDER_SERVERS = 512
_HOSTNAME_LABEL = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
_HOSTNAME = re.compile(rf"{_HOSTNAME_LABEL}(?:\.{_HOSTNAME_LABEL})*\Z")


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
        try:
            return dump(warnings=False)
        except TypeError:
            return dump()
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return list(value)
    return value


def _text(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        return None
    try:
        return value if len(value.encode("utf-16-le")) // 2 <= 256 else None
    except UnicodeEncodeError:
        return None


def _json_arguments(value: Any) -> Any:
    """MCP arguments arrive as JSON text; record the structure when it parses, else the text."""
    if not isinstance(value, str):
        return value
    # Import lazily because client.py imports this module. The shared helper stops in bounded
    # chunks as soon as the content limit is crossed, rather than walking every character.
    from .client import _utf8_byte_size

    if _utf8_byte_size(value, MAX_CONTENT_BYTES) > MAX_CONTENT_BYTES:
        return ABSENT
    try:
        return json.loads(value)
    except (ValueError, RecursionError):
        return value


def _item_type(value: Any) -> Any:
    if isinstance(value, Mapping):
        return value.get("type")
    return getattr(value, "type", None)


def _is_provider_tool_item(provider: str, value: Any) -> bool:
    kind = _item_type(value)
    if provider == "openai":
        return kind in (
            "mcp_call",
            "mcp_list_tools",
            "web_search_call",
            "file_search_call",
            "code_interpreter_call",
        )
    return kind in ("mcp_tool_use", "server_tool_use")


_ERROR_CODE = re.compile(r"^[a-z0-9_]{1,64}$")


def _error_code(value: Any) -> str:
    return value if isinstance(value, str) and _ERROR_CODE.fullmatch(value) else "error"


def _openai_item(item: Any, activity: HostedToolActivity, capture_content: bool) -> None:
    item = _data(item)
    if not isinstance(item, dict):
        return
    kind = item.get("type")
    call_id = _text(item.get("id"))
    if kind == "mcp_call":
        name = _text(item.get("name"))
        if name is None:
            activity.skipped += 1
            return
        arguments = _json_arguments(item.get("arguments")) if capture_content else ABSENT
        if capture_content and arguments is ABSENT:
            activity.skipped += 1
        activity.calls.append(
            HostedToolCall(
                name,
                call_id,
                _text(item.get("server_label")),
                arguments,
                item["output"] if capture_content and item.get("output") is not None else ABSENT,
                "mcp_error" if item.get("error") is not None else None,
            )
        )
    elif kind == "mcp_list_tools":
        server = _text(item.get("server_label"))
        tools = item.get("tools")
        if server is None or not isinstance(tools, list):
            activity.skipped += 1
            return
        definitions = []
        definition_count = min(len(tools), MAX_PROVIDER_DEFINITIONS)
        activity.skipped += len(tools) - definition_count
        for index in range(definition_count):
            try:
                tool = _data(tools[index])
            except Exception:
                activity.skipped += 1
                continue
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
            arguments = item.get("action") if capture_content else ABSENT
            result = ABSENT
        elif kind == "file_search_call":
            arguments = {"queries": item.get("queries")} if capture_content else ABSENT
            result = (
                item["results"] if capture_content and item.get("results") is not None else ABSENT
            )
        else:
            arguments = (
                {"code": item.get("code"), "container_id": item.get("container_id")}
                if capture_content
                else ABSENT
            )
            result = (
                item["outputs"] if capture_content and item.get("outputs") is not None else ABSENT
            )
        activity.calls.append(HostedToolCall(name, call_id, None, arguments, result, error_type))


def _count_truncated_provider_items(provider: str, items: Sequence[Any]) -> int:
    count = 0
    for item in items:
        try:
            if _is_provider_tool_item(provider, item):
                count += 1
        except Exception:
            # A broken provider-model ``type`` property must not prevent the bounded prefix from
            # being recorded. Count the unreadable tail item as skipped and continue.
            count += 1
    return count


def _openai_calls(items: list[Any], activity: HostedToolActivity, capture_content: bool) -> None:
    """OpenAI Responses ``output`` items. Built-in tools are named by kind, MCP calls by tool."""
    count = min(len(items), MAX_PROVIDER_ITEMS)
    activity.skipped += _count_truncated_provider_items("openai", items[count:])
    for index in range(count):
        try:
            _openai_item(items[index], activity, capture_content)
        except Exception:
            activity.skipped += 1
        # Messages, reasoning, approval requests and other items are not executed tools.


def _anthropic_calls(
    blocks: list[Any], activity: HostedToolActivity, capture_content: bool
) -> None:
    """Anthropic Messages ``content`` blocks: a use block paired with the result that names it."""
    count = min(len(blocks), MAX_PROVIDER_ITEMS)
    truncated = len(blocks) > MAX_PROVIDER_ITEMS
    activity.skipped += _count_truncated_provider_items("anthropic", blocks[count:])
    converted: list[Any] = []
    for index in range(count):
        try:
            converted.append(_data(blocks[index]))
        except Exception:
            activity.skipped += 1
            converted.append(None)
    blocks = converted
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
        try:
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
            # When the response was truncated, an unmatched use block may have its result outside
            # the bounded prefix. Do not export it as a successful call with a missing result.
            if truncated and result is None:
                activity.skipped += 1
                continue
            raw_content = result.get("content") if result is not None else None
            if result is None or not capture_content:
                content = ABSENT
            else:
                content = _data(raw_content)
            error_type = None
            if result is not None and result.get("is_error") is True:
                error_type = "mcp_error"
            else:
                error_content = raw_content if not capture_content else content
                if (
                    isinstance(error_content, Mapping)
                    and isinstance(error_content.get("type"), str)
                    and error_content["type"].endswith("_error")
                ):
                    error_type = _error_code(error_content.get("error_code"))
            activity.calls.append(
                HostedToolCall(
                    name,
                    call_id,
                    _text(block.get("server_name")) if block["type"] == "mcp_tool_use" else None,
                    block.get("input") if capture_content else ABSENT,
                    (
                        content
                        if capture_content and result is not None and "content" in result
                        else ABSENT
                    ),
                    error_type,
                )
            )
        except Exception:
            activity.skipped += 1


def hosted_tool_activity(
    provider: str, response: Any, capture_content: bool = True
) -> HostedToolActivity:
    """The hosted tool calls in a provider response.

    Reads the ``output`` items of an OpenAI Responses API response or the ``content`` blocks of an
    Anthropic Messages API response; a list is taken as those items directly. SDK response objects
    are read through ``model_dump()``. Anything else yields no calls.
    """
    activity = HostedToolActivity()
    try:
        response = _data(response)
    except Exception:
        activity.skipped += 1
        return activity
    items = (
        response
        if isinstance(response, list)
        else response.get("output" if provider == "openai" else "content")
        if isinstance(response, dict)
        else None
    )
    try:
        items = _data(items)
    except Exception:
        activity.skipped += 1
        return activity
    if not isinstance(items, list):
        return activity
    if provider == "openai":
        _openai_calls(items, activity, capture_content)
    else:
        _anthropic_calls(items, activity, capture_content)
    return activity


def hosted_server_addresses(provider: str, request: Any) -> dict[str, str]:
    """Each hosted MCP server's host by label, read from the request that produced the response.

    OpenAI: ``tools[].server_url`` by ``server_label``; Anthropic: ``mcp_servers[].url`` by
    ``name``. Nothing else in the request is read.
    """
    addresses: dict[str, str] = {}
    try:
        request = _data(request)
    except Exception:
        return addresses
    if not isinstance(request, dict):
        return addresses
    try:
        entries = _data(request.get("tools" if provider == "openai" else "mcp_servers"))
    except Exception:
        return addresses
    if not isinstance(entries, list):
        return addresses
    for index in range(min(len(entries), MAX_PROVIDER_SERVERS)):
        try:
            entry = _data(entries[index])
        except Exception:
            continue
        if not isinstance(entry, dict):
            continue
        label = _text(entry.get("server_label" if provider == "openai" else "name"))
        url = entry.get("server_url" if provider == "openai" else "url")
        if label is None or not isinstance(url, str):
            continue
        # Reject ambiguous delimiters before urlsplit can normalize them into a host. In
        # particular, encoded/fullwidth backslashes and IPv6 zone identifiers must not become
        # exported address text.
        if (
            len(url) > 8192
            or "\\" in url
            or "\x00" in url
            or "\uff3c" in url
            or ";" in url
            or "%5c" in url.lower()
            or any(character.isspace() or ord(character) < 0x20 for character in url)
        ):
            continue
        try:
            parsed = urlsplit(url)
            hostname = parsed.hostname
        except (TypeError, UnicodeError, ValueError):
            continue
        if not hostname or len(hostname) > 253 or "%" in hostname:
            continue
        if ":" in hostname:
            if not parsed.netloc.startswith("["):
                continue
            try:
                ipaddress.ip_address(hostname)
            except ValueError:
                continue
        elif not _HOSTNAME.fullmatch(hostname):
            continue
        if hostname:
            addresses[label] = hostname
    return addresses
