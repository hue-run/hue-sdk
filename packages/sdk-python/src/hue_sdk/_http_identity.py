"""HTTP URL credential filtering for Hue's own spans and redacted export copies."""

from __future__ import annotations

import re
from collections.abc import Callable
from urllib.parse import unquote, urlsplit, urlunsplit

from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.trace import SpanKind

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


def safe_http_span(
    span: ReadableSpan, redact: Callable[[str, str], str | None] | None = None
) -> ReadableSpan:
    """Sanitize HTTP identity in Hue's copy, including both URL conventions and span names."""
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
    try:
        urls: dict[str, str] = {}
        for key in keys:
            raw = attributes[key]
            if not isinstance(raw, str):
                raise ValueError("Invalid HTTP URL")
            urls[key] = sanitize_http_url(raw)
        canonical: str | None = urls.get("url.full", urls[keys[0]]) if keys else None
        if canonical is not None:
            if redact is not None:
                for field in ("url.full", "http.url") if "http.url" in urls else ("url.full",):
                    rewritten = redact(field, canonical)
                    if rewritten is None:
                        raise ValueError("HTTP URL omitted by redactor")
                    canonical = sanitize_http_url(rewritten)
            path = urlsplit(canonical).path
        elif paths:
            for key in paths:
                raw_path = attributes[key]
                if not isinstance(raw_path, str):
                    raise ValueError("Invalid HTTP path")
                _path_answer(raw_path, None)
            raw_path = attributes.get("url.path", attributes[paths[0]])
            if not isinstance(raw_path, str):
                raise ValueError("Invalid HTTP path")
            _, path = _path_answer(raw_path, None)
        else:
            path = "/"
        if redact is not None:
            for field in paths:
                rewritten = redact(field, path)
                if rewritten is None:
                    raise ValueError("HTTP path omitted by redactor")
                canonical, path = _path_answer(rewritten, canonical)
        for key in keys:
            copied[key] = canonical
        for key in paths:
            copied[key] = path
    except Exception:
        # No URI convention can fall back to the original credential-bearing value.
        for key in _URI_KEYS:
            copied.pop(key, None)
    return replace_span(span, name=name, attributes=copied)
