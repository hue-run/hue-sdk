"""Scoped HTTP request identities and bounded response tees; never eager-read a body."""

from __future__ import annotations

import json
import re
import zlib
from email.message import Message
from pathlib import PurePosixPath
from urllib.parse import unquote_plus, urlsplit, urlunsplit

from . import _payload
from ._json import canonical_json, clean_json, credential_key, sha256
from .client import Capture, Scenes
from .types import MAX_ARTIFACT_BYTES, SnapshotMissError, SourceFile

REPRESENTATION_HEADERS = frozenset(
    {
        "accept",
        "content-type",
        "range",
        "if-match",
        "if-none-match",
        "if-modified-since",
        "if-unmodified-since",
        "if-range",
    }
)


def is_json_media_type(content_type: str) -> bool:
    media_type = content_type.split(";", 1)[0].strip().lower()
    token = r"[!#$%&'*+\-.^_`|~0-9a-z]+"
    return (
        media_type == "application/json"
        or re.fullmatch(token + "/" + token + r"\+json", media_type) is not None
    )


def parse_http_json(body: bytes):
    """JSON on the wire is UTF-8, with only an optional UTF-8 BOM accepted."""
    return json.loads(body.decode("utf-8-sig", errors="strict"))


def safe_url(url: str) -> str:
    parts = urlsplit(url)
    hostname = parts.hostname
    if hostname is None:
        # Opaque source URIs (e.g. an MCP resource identifier) are retained only without query.
        return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    hostname = hostname.lower()
    if ":" in hostname:
        hostname = "[" + hostname + "]"
    port = parts.port
    default_port = 443 if parts.scheme.lower() == "https" else 80
    authority = hostname + (f":{port}" if port is not None and port != default_port else "")
    query = "&".join(
        part
        for part in parts.query.split("&")
        if not credential_key(unquote_plus(part.partition("=")[0]))
    )
    return urlunsplit((parts.scheme.lower(), authority, parts.path or "/", query, ""))


def response_headers(headers) -> dict[str, str]:
    return {
        str(key).lower(): str(value)
        for key, value in headers.items()
        if not credential_key(str(key))
    }


def owned_binding(scenes: Scenes, url: str):
    active = scenes._active.get()
    if active is None:
        return None, None
    parsed = urlsplit(safe_url(url))
    origin = urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
    matches = [
        binding
        for binding in active.selected.values()
        if binding.get("kind") == "http"
        and binding.get("http", {}).get("origin") == origin
        and parsed.path.startswith(binding["http"]["pathPrefix"])
    ]
    if len(matches) > 1:
        if not isinstance(active, Capture):
            raise SnapshotMissError("overlapping_bindings")
        # An explicitly narrower scope owns capture when both are present; replay rejects overlap.
        matches.sort(key=lambda binding: len(binding["http"]["pathPrefix"]), reverse=True)
    return active, matches[0] if matches else None


def http_arguments(binding, method: str, url: str, headers, body: bytes | None):
    normalized_headers = {str(key).lower(): str(value) for key, value in headers.items()}
    selected = REPRESENTATION_HEADERS | {
        name.lower() for name in binding["http"].get("headers", [])
    }
    selected_headers = {
        key: value
        for key, value in normalized_headers.items()
        if key in selected and not credential_key(key)
    }
    if body is None or "multipart/" in normalized_headers.get("content-type", "").lower():
        raise ValueError("Streamed and multipart source request bodies are not portable.")
    if body and is_json_media_type(normalized_headers.get("content-type", "")):
        body = canonical_json(clean_json(parse_http_json(body)))
    return {
        "method": method.upper(),
        "url": safe_url(url),
        "headers": selected_headers,
        "bodySha256": sha256(body),
    }


def decoded_http_body(body: bytes, headers: dict[str, str]) -> bytes:
    """Bounded standard compression codecs; unsupported encodings fail closed."""
    encodings = headers.get("content-encoding", "").lower().split(",")
    for encoding in reversed(encodings):
        encoding = encoding.strip()
        if encoding in {"", "identity"}:
            continue
        if encoding not in {"gzip", "deflate"}:
            raise SnapshotMissError("nonportable")
        options = (31,) if encoding == "gzip" else (zlib.MAX_WBITS, -zlib.MAX_WBITS)
        decoded = None
        for window in options:
            try:
                decompressor = zlib.decompressobj(window)
                decoded = decompressor.decompress(body, MAX_ARTIFACT_BYTES + 1)
                if len(decoded) > MAX_ARTIFACT_BYTES or decompressor.unconsumed_tail:
                    raise SnapshotMissError("nonportable")
                if not decompressor.eof or decompressor.unused_data:
                    raise SnapshotMissError("nonportable")
                break
            except zlib.error:
                continue
        if decoded is None:
            raise SnapshotMissError("nonportable")
        body = decoded
    return body


class ResponseCapture:
    def __init__(
        self,
        call,
        status: int,
        headers,
        url: str,
        status_text: str = "",
        request_method: str = "GET",
    ):
        self.call = call
        self.request_method = request_method
        self.metadata = {
            "kind": "http",
            "status": status,
            "headers": response_headers(headers),
            "url": safe_url(url),
            "statusText": status_text,
        }
        self._body = bytearray()
        self._reserved = 0
        self._omission = None
        self._done = False

    def append(self, chunk: bytes) -> None:
        if self._done or self._omission:
            return
        scenes = self.call.capture.scenes
        if len(self._body) + len(chunk) > MAX_ARTIFACT_BYTES or not scenes._reserve(len(chunk)):
            self._omission = "body_limit"
            scenes._release(self._reserved)
            self._reserved = 0
            self._body.clear()
            return
        self._reserved += len(chunk)
        self._body.extend(chunk)

    def finish(
        self, *, incomplete: bool = False, error: BaseException | None = None, decoded: bool = False
    ) -> None:
        if self._done:
            return
        self._done = True
        scenes = self.call.capture.scenes
        scenes._release(self._reserved)
        self._reserved = 0
        omission = self._omission or ("body_not_consumed" if incomplete else None)
        try:
            if error is not None or omission:
                partial = None
                if self._body and not is_json_media_type(
                    self.metadata["headers"].get("content-type", "")
                ):
                    partial = {**self.metadata, "body": _payload.encode(bytes(self._body))}
                self.call.finish(
                    error=error, payload=partial, omission=omission or "body_interrupted"
                )
            else:
                body = scenes._clean("http_body", bytes(self._body))
                if not isinstance(body, bytes):
                    raise ValueError()
                if body != self._body:
                    self.call.finish(omission="redacted_body")
                    return
                if is_json_media_type(self.metadata["headers"].get("content-type", "")) and (
                    self.request_method != "HEAD" and self.metadata["status"] not in {204, 205, 304}
                ):
                    json_bytes = (
                        body if decoded else decoded_http_body(body, self.metadata["headers"])
                    )
                    value = parse_http_json(json_bytes)
                    if canonical_json(value) != canonical_json(scenes._clean("http_json", value)):
                        self.call.finish(omission="redacted_body")
                        return
                headers = self.metadata["headers"]
                if decoded and body and headers.get("content-encoding"):
                    headers.pop("content-encoding", None)
                    headers.pop("content-length", None)
                headers.pop("transfer-encoding", None)
                payload = _payload.encode(body)
                sources = []
                mime_type = headers.get("content-type", "").split(";")[0].lower().strip()
                document_types = {
                    "application/pdf",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                }
                disposition = headers.get("content-disposition", "")
                if self.request_method != "HEAD" and (
                    mime_type in document_types or disposition.lower().startswith("attachment")
                ):
                    message = Message()
                    message["content-disposition"] = disposition
                    name = (
                        message.get_filename()
                        or PurePosixPath(urlsplit(self.metadata["url"]).path).name
                        or "observed-source"
                    )
                    name = name.replace("\\", "/").rsplit("/", 1)[-1]
                    source_bytes = decoded_http_body(body, headers)
                    sources = [
                        SourceFile(
                            name,
                            source_bytes,
                            mime_type or "application/octet-stream",
                            "tool_source",
                            self.metadata["url"],
                        )
                    ]
                    if source_bytes == body:
                        payload = {
                            "kind": "blob",
                            "ref": _payload.Blob(
                                body, "bytes", sources[0].mime_type, name, "source"
                            ),
                        }
                self.call.finish(payload={**self.metadata, "body": payload}, sources=sources)
        except BaseException:
            self.call.finish(omission="nonportable_body")
        finally:
            self._body.clear()
