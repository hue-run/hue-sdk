"""Explicit HTTP routing evidence for tool spans; never makes a request."""

from __future__ import annotations

import re
from typing import Literal, TypedDict
from urllib.parse import unquote, urlsplit, urlunsplit

from ._tool_definitions import _is_credential_key


class _RequiredEndpoint(TypedDict):
    url: str
    source: Literal["request", "client_config", "receipt"]


class ToolEndpoint(_RequiredEndpoint, total=False):
    """Actual HTTP(S) URL and provenance, with optional non-secret query capture and method."""

    method: str
    capture_query_parameters: list[str]


def tool_endpoint_attributes(endpoint: ToolEndpoint) -> dict[str, str]:
    raw = endpoint["url"]
    if (
        not isinstance(raw, str)
        or len(raw) > 8192
        or re.search(r"[\s\\\x00-\x1f\x7f]", raw)
        or re.search(r"%(?![0-9a-f]{2})", raw, re.I)
        or endpoint["source"] not in ("request", "client_config", "receipt")
    ):
        raise ValueError("Invalid tool endpoint evidence")
    url = urlsplit(raw)
    if url.scheme not in ("http", "https") or not url.hostname:
        raise ValueError("Invalid tool endpoint protocol")
    # Accessing port validates it without changing the supplied endpoint.
    _ = url.port
    names = endpoint.get("capture_query_parameters", [])
    if (
        not isinstance(names, list)
        or len(names) > 32
        or any(
            not isinstance(name, str)
            or not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_.-]{0,63}", name)
            or _is_credential_key(name)
            for name in names
        )
    ):
        raise ValueError("Invalid tool endpoint query allowlist")
    # Preserve raw pairs, duplicates and empty values; downstream readers decide availability.
    query = "&".join(
        pair
        for pair in url.query.split("&")
        if unquote(pair.split("=", 1)[0].replace("+", " "), errors="strict") in names
    )
    attributes = {
        "url.full": urlunsplit(
            (url.scheme, url.netloc.rsplit("@", 1)[-1], url.path or "/", query, "")
        ),
        "hue.tool.endpoint.source": endpoint["source"],
    }
    if "method" in endpoint:
        method = endpoint["method"]
        if not isinstance(method, str) or not re.fullmatch(
            r"[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}", method
        ):
            raise ValueError("Invalid tool endpoint method")
        attributes["http.request.method"] = method
    return attributes
