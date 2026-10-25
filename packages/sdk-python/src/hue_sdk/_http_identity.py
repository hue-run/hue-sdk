"""HTTP URL credential filtering for Hue's own spans and redacted export copies."""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from typing import Any
from urllib.parse import unquote, urlsplit, urlunsplit

from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.trace import SpanKind

from ._http_bounds import SpanBounds, limits_for
from ._records import replace_span
from ._tool_definitions import REDACTED, _scrub_credential_text_unbounded

_CREDENTIAL_LABELS = frozenset(
    {
        "token",
        "accesstoken",
        "refreshtoken",
        "apikey",
        "xapikey",
        "clientsecret",
        "password",
        "secret",
        "authorization",
        "authtoken",
    }
)
_BOT_CAPABILITY = re.compile(r"bot[0-9]+:[A-Za-z0-9_-]+\Z", re.ASCII)
_TENANT_ID = re.compile(r"T[A-Za-z0-9]+\Z", re.ASCII)
_HOOK_ID = re.compile(r"B[A-Za-z0-9]+\Z", re.ASCII)
_OPAQUE_CAPABILITY = re.compile(r"[A-Za-z0-9_-]+\Z", re.ASCII)
_METHOD = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}\Z", re.ASCII)
_URL_KEYS = ("url.full", "http.url")
_PATH_KEYS = ("http.target", "url.path")
_URI_KEYS = (*_URL_KEYS, *_PATH_KEYS, "url.query")


def _accepted_length(
    attributes: Mapping[str, Any], keys: tuple[str, ...] | list[str], bounds: SpanBounds | None
) -> int | None:
    if not keys:
        return None
    if bounds is not None:
        return bounds.value_length
    # Unknown SDK policy cannot authorize widening a value beyond what the source accepted.
    return min(len(attributes[key]) if isinstance(attributes[key], str) else 0 for key in keys)


def _within_length(value: str, limit: int | None) -> str:
    if limit is not None and len(value) > limit:
        raise ValueError("HTTP URI exceeds the source attribute limit")
    return value


def _safe_path(path: str) -> str:
    raw = path.split("/")
    decoded = [unquote(segment) for segment in raw]
    parts: list[str] = []
    owners: list[int] = []
    for owner, segment in enumerate(decoded):
        # Read encoded slashes for recognition without changing ordinary encoded IDs.
        pieces = segment.split("/")
        parts.extend(pieces)
        owners.extend([owner] * len(pieces))
    terminal = len(parts) - 1
    while terminal and not parts[terminal]:
        terminal -= 1
    pending_credential = False
    redacted_owners: set[int] = set()
    for index, part in enumerate(parts):
        owner = owners[index]
        if owner in redacted_owners:
            continue
        if pending_credential and part:
            replacement = REDACTED
            pending_credential = False
        else:
            if _BOT_CAPABILITY.fullmatch(part):
                replacement = "bot" + REDACTED
            elif _scrub_credential_text_unbounded(part) != part:
                replacement = REDACTED
            else:
                replacement = part
            if part.lower().replace("-", "").replace("_", "") in _CREDENTIAL_LABELS:
                pending_credential = True
        if (
            index == terminal
            and index >= 3
            and parts[index - 3].lower() == "services"
            and _TENANT_ID.fullmatch(parts[index - 2])
            and _HOOK_ID.fullmatch(parts[index - 1])
            and _OPAQUE_CAPABILITY.fullmatch(part)
        ):
            replacement = REDACTED
        if replacement != part:
            if "/" in decoded[owner]:
                raw[owner] = REDACTED
                redacted_owners.add(owner)
            else:
                raw[owner] = replacement
    return "/".join(raw)


def sanitize_http_url(raw: str) -> str:
    """Remove URL credentials while retaining unchanged path and encoded identifier spelling."""
    if not isinstance(raw, str) or re.search(r"[\x00-\x20\x7f\\]", raw):
        raise ValueError("Invalid HTTP URL")
    parsed = urlsplit(raw)
    host = parsed.hostname
    if parsed.scheme not in {"http", "https"} or not host:
        raise ValueError("Invalid HTTP URL")
    port = parsed.port
    netloc = f"[{host}]" if ":" in host else host
    if port is not None:
        netloc += f":{port}"
    return urlunsplit((parsed.scheme, netloc, _safe_path(parsed.path or "/"), "", ""))


def _path_answer(raw: str, canonical: str | None) -> tuple[str | None, str]:
    """A path hook can replace its path or explicitly supply another absolute HTTP URL."""
    if not isinstance(raw, str) or re.search(r"[\x00-\x20\x7f\\]", raw):
        raise ValueError("Invalid HTTP path")
    parsed = urlsplit(raw)
    if parsed.scheme:
        rewritten = sanitize_http_url(raw)
        return (rewritten if canonical is not None else None), urlsplit(rewritten).path
    path = raw.split("?", 1)[0].split("#", 1)[0] or "/"
    path = _safe_path(path if path.startswith("/") else "/" + path)
    if canonical is not None:
        origin = urlsplit(canonical)
        canonical = urlunsplit((origin.scheme, origin.netloc, path, "", ""))
    return canonical, path


def _redacted_url(
    raw: str,
    fields: tuple[str, ...],
    redact: Callable[[str, str], str | None] | None,
    limit: int | None = None,
) -> str:
    safe = _within_length(sanitize_http_url(raw), limit)
    if redact is not None:
        for field in fields:
            rewritten = redact(field, safe)
            if rewritten is None:
                raise ValueError("HTTP URL omitted by redactor")
            safe = _within_length(sanitize_http_url(rewritten), limit)
    return safe


def _resource_name_attributes(
    attributes: Mapping[str, Any],
    redact: Callable[[str, str], str | None] | None,
    *,
    bounds: SpanBounds | None = None,
) -> Mapping[str, Any]:
    value = attributes.get("resource.name")
    if not isinstance(value, str) or not re.match(r"https?://", value.strip(), re.IGNORECASE):
        return attributes
    copied = dict(attributes)
    try:
        copied["resource.name"] = _redacted_url(
            value,
            ("url.full", "resource.name"),
            redact,
            _accepted_length(attributes, ("resource.name",), bounds),
        )
    except Exception:
        copied.pop("resource.name", None)
    return copied


def safe_http_resource(
    resource: Resource | None, redact: Callable[[str, str], str | None] | None = None
) -> Resource | None:
    """Filter a URL-valued resource name without changing ordinary service labels."""
    if resource is None:
        return None
    attributes = _resource_name_attributes(resource.attributes, redact, bounds=limits_for(resource))
    return (
        resource
        if attributes is resource.attributes
        else Resource(attributes, schema_url=resource.schema_url)
    )


def safe_http_span(
    span: ReadableSpan, redact: Callable[[str, str], str | None] | None = None
) -> ReadableSpan:
    """Sanitize HTTP identity in Hue's copy, including both URL conventions and span names."""
    attributes = span.attributes or {}
    bounds = limits_for(span)
    resource = safe_http_resource(span.resource, redact)
    safe_attributes = _resource_name_attributes(attributes, redact, bounds=bounds)
    if resource is not span.resource or safe_attributes is not attributes:
        span = replace_span(span, resource=resource, attributes=safe_attributes)
        attributes = span.attributes or {}
    method = attributes.get("http.request.method", attributes.get("http.method"))
    keys = [key for key in _URL_KEYS if key in attributes]
    if span.kind != SpanKind.CLIENT or not isinstance(method, str):
        return span
    valid_method = _METHOD.fullmatch(method)
    name = method.upper() if valid_method else "HTTP"
    paths = [key for key in _PATH_KEYS if key in attributes]
    if not keys and not paths and "url.query" not in attributes:
        return replace_span(span, name=name) if valid_method else span
    copied = dict(attributes)
    copied.pop("url.query", None)
    url_length = _accepted_length(attributes, keys, bounds)
    path_length = _accepted_length(attributes, paths, bounds)
    try:
        urls: dict[str, str] = {}
        for key in keys:
            raw = attributes[key]
            if not isinstance(raw, str):
                raise ValueError("Invalid HTTP URL")
            urls[key] = _within_length(sanitize_http_url(raw), url_length)
        canonical: str | None = urls.get("url.full", urls[keys[0]]) if keys else None
        if canonical is not None:
            fields = ("url.full", "http.url") if "http.url" in urls else ("url.full",)
            canonical = _redacted_url(canonical, fields, redact, url_length)
            path = _within_length(urlsplit(canonical).path, path_length)
        elif paths:
            for key in paths:
                raw_path = attributes[key]
                if not isinstance(raw_path, str):
                    raise ValueError("Invalid HTTP path")
                _within_length(_path_answer(raw_path, None)[1], path_length)
            raw_path = attributes.get("url.path", attributes[paths[0]])
            if not isinstance(raw_path, str):
                raise ValueError("Invalid HTTP path")
            _, path = _path_answer(raw_path, None)
            _within_length(path, path_length)
        else:
            path = "/"
        if redact is not None:
            for field in paths:
                rewritten = redact(field, path)
                if rewritten is None:
                    raise ValueError("HTTP path omitted by redactor")
                canonical, path = _path_answer(rewritten, canonical)
                _within_length(path, path_length)
                if canonical is not None:
                    _within_length(canonical, url_length)
        for key in keys:
            copied[key] = canonical
        for key in paths:
            copied[key] = path
    except Exception:
        # No URI convention can fall back to the original credential-bearing value.
        for key in _URI_KEYS:
            copied.pop(key, None)
    return replace_span(span, name=name, attributes=copied)
