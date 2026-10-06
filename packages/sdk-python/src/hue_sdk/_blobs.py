"""Values larger than Hue's inline limit, uploaded apart from their span.

The exporter uploads such a value's bytes straight to the project's evidence store through a
presigned PUT that Hue answers at ``POST /api/v1/otlp/blobs``, keeps the value's first 16 KiB in
the attribute it replaced, and lists the value in the span attribute ``hue.blobs``. A value that
cannot be uploaded is exported as it was before uploads existed: cut to the inline limit and
listed under ``hue.truncated`` (an inline file as its digest), reported as a warning and counted.
Mirrors the TypeScript SDK's ``blobs.ts``.
"""

from __future__ import annotations

import hashlib
import io
import ipaddress
import json
import re
import sys
import weakref
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
from threading import Event, Lock, Semaphore, Thread
from time import monotonic, time
from typing import Any
from urllib.parse import urlsplit

import requests
from opentelemetry.context import attach, detach

from ._inline_files import (
    INLINE_FILE_LIMIT,
    MAX_INLINE_FILE_TEXT,
    InlineFile,
    digest_part,
    dumps_message,
    hash_inline_files,
    inline_file,
    large_inline_file_parts,
    may_inline_files,
    utf8_size,
)
from ._limits import TRUNCATED_KEY, cut_utf8, over_utf8
from ._otel_compat import export_context
from ._records import truncated_marker, with_truncated_keys
from ._tool_definitions import scrub_tool_credentials

# The span attribute listing the values the SDK uploaded apart from the span: one compact JSON
# object per value, ``{"key", "sha256", "size", "content_type"}``, as Hue reads it.
BLOBS_KEY = "hue.blobs"
# The largest value one upload may hold (``Hue-Max-Blob-Bytes``); a larger value is cut inline.
MAX_BLOB_BYTES = 1_000_000_000
# What an uploaded value keeps inline: its first 16 KiB, the receiver's search excerpt.
BLOB_PREFIX_BYTES = 16 * 1024
# The entries one record's ``hue.blobs`` may list; Hue reads no more.
MAX_BLOB_ENTRIES = 64
_MAX_BLOB_KEY_LENGTH = 256
# The values over the inline limit queued spans may hold whole for upload at once, charged apart
# from ``max_queue_bytes`` (as the interpreter holds them). A value the budget cannot hold is cut
# when it is queued, as before uploads existed; a single value larger than the whole budget is
# held while nothing else is.
MAX_HELD_BLOB_BYTES = 128 * 1024 * 1024
# Uploads in flight at once for one exporter.
UPLOAD_CONCURRENCY = 4
# How long a receiver without the upload route is believed to stay without it.
UNSUPPORTED_PAUSE_SECONDS = 600.0
# How long uploads pause after one failed for a transient reason (a 5xx, the network, a timeout),
# so an unavailable store meets no retry storm: values fall back to the inline cut.
FAILURE_PAUSE_SECONDS = 30.0
_MAX_JSON_RESPONSE_BYTES = 64 * 1024
_MAX_ERROR_RESPONSE_BYTES = 4096
# Text is encoded to UTF-8 a slice at a time to hash and upload it: no full copy is held.
_TEXT_CHUNK_CHARS = 1 << 20
_RETRY_DELAY_SECONDS = 1.0
# The longest Retry-After a transient refusal of a reservation is waited for.
_MAX_TRANSIENT_WAIT_SECONDS = 5.0


def upload_budget_seconds(timeout: float) -> float:
    """How long one export may spend uploading its values, on top of its requests."""
    return timeout * 6


# Why a value over the inline limit was exported cut instead of uploaded, and the fixed
# description an export issue reports for it.
FALLBACK_MESSAGES = {
    "unsupported": (
        "This Hue server does not accept uploaded values; values over its inline limit were "
        "exported cut to it (inline files as their digest)"
    ),
    "failed": (
        "Values over Hue's inline limit could not be uploaded; they were exported cut to it "
        "(inline files as their digest)"
    ),
    "too_large": "Values over Hue's 1 GB upload limit were exported cut to the inline limit",
    "budget": (
        "Values over Hue's inline limit did not fit the SDK's upload budget; they were exported "
        "cut to it (inline files as their digest)"
    ),
}

# A media type Hue accepts for a value: ``type/subtype`` with optional parameters, 3 to 255
# printable ASCII characters.
_CONTENT_TYPE = re.compile(
    r"[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9!#$&^_.+-]+(?: *;[ -~]*)?\Z"
)
_HEADER_NAME = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+\Z")
_HEADER_VALUE = re.compile(r"[\t\x20-\x7e\x80-\xff]*\Z")
_TRACE_ID = re.compile(r"[0-9a-f]{32}\Z")


def is_blob_content_type(value: Any) -> bool:
    return isinstance(value, str) and 3 <= len(value) <= 255 and bool(_CONTENT_TYPE.match(value))


def _is_blob_key(key: str) -> bool:
    return 1 <= len(key) <= _MAX_BLOB_KEY_LENGTH and not any(
        ord(char) < 0x20 or ord(char) == 0x7F for char in key
    )


def text_content_type(text: str) -> str:
    """The media type an uploaded text is stored under: JSON when it reads as a JSON object or
    array (a structured value's text), plain UTF-8 text otherwise. Both are previewed as text."""
    head = text[:256].lstrip()
    tail = text[-256:].rstrip()
    if (head.startswith("{") and tail.endswith("}")) or (
        head.startswith("[") and tail.endswith("]")
    ):
        return "application/json"
    return "text/plain; charset=utf-8"


def _file_content_type(part: Mapping[str, Any], file: InlineFile) -> str:
    """The media type an inline file is stored under: the part's own, its data: URL's, or else
    bytes, or UTF-8 text for content that was not encoded."""
    for name in ("mime_type", "mimeType", "mediaType", "media_type"):
        if is_blob_content_type(part.get(name)):
            return str(part[name])
    if is_blob_content_type(file.url_media_type):
        return str(file.url_media_type)
    return "application/octet-stream" if file.decoded else "text/plain; charset=utf-8"


def blob_prefix(value: str | bytes) -> str | bytes:
    """What an uploaded value keeps inline: its first 16 KiB, text cut back to a character."""
    if isinstance(value, bytes):
        return value[:BLOB_PREFIX_BYTES]
    return cut_utf8(value, BLOB_PREFIX_BYTES)


def _chunks(value: str | bytes) -> Iterator[bytes]:
    """The bytes an upload of ``value`` carries, a slice at a time."""
    if isinstance(value, bytes):
        view = memoryview(value)
        for start in range(0, len(value), _TEXT_CHUNK_CHARS):
            yield view[start : start + _TEXT_CHUNK_CHARS].tobytes()
        return
    for start in range(0, len(value), _TEXT_CHUNK_CHARS):
        yield value[start : start + _TEXT_CHUNK_CHARS].encode("utf-8")


def digest_of(value: str | bytes) -> tuple[str, int]:
    """The SHA-256 (lowercase hex) and byte size of what an upload of ``value`` carries. A lone
    surrogate raises ``UnicodeEncodeError``, as encoding the value whole would."""
    if isinstance(value, bytes):
        return hashlib.sha256(value).hexdigest(), len(value)
    digest = hashlib.sha256()
    size = 0
    for chunk in _chunks(value):
        digest.update(chunk)
        size += len(chunk)
    return digest.hexdigest(), size


class _Body(io.RawIOBase):
    """A value's upload body, read a slice at a time, its length known before it is sent. Past
    ``deadline``, or once ``stopped`` answers true, a read raises: the upload ends there instead
    of holding the value and an upload slot after its export has moved on."""

    def __init__(
        self, value: str | bytes, size: int, deadline: float, stopped: Callable[[], bool]
    ) -> None:
        super().__init__()
        self._chunks = _chunks(value)
        self._size = size
        self._pending = b""
        self._offset = 0
        self._deadline = deadline
        self._stopped = stopped
        self._position = 0

    def __len__(self) -> int:
        return self._size

    def tell(self) -> int:
        # Without a position, an HTTP client measures the body as unknown and sends it chunked,
        # beside its Content-Length: a request the store refuses.
        return self._position

    def readable(self) -> bool:
        return True

    def read(self, size: int | None = -1) -> bytes:
        if monotonic() >= self._deadline or self._stopped():
            raise TimeoutError("The upload ran out of time.")
        while self._offset >= len(self._pending):
            try:
                self._pending, self._offset = next(self._chunks), 0
            except StopIteration:
                return b""
        if size is None or size < 0:
            size = len(self._pending)
        # Only what is read is copied, never the rest of the slice.
        result = self._pending[self._offset : self._offset + size]
        self._offset += len(result)
        self._position += len(result)
        return result


def _blob_entry(key: str, sha256: str, size: int, content_type: str) -> str:
    return json.dumps(
        {"key": key, "sha256": sha256, "size": size, "content_type": content_type},
        separators=(",", ":"),
    )


def _loopback(hostname: str) -> bool:
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return hostname.lower() == "localhost"


class HeldValues:
    """The budget of values over the inline limit queued spans hold whole for upload."""

    def __init__(self, limit: int = MAX_HELD_BLOB_BYTES) -> None:
        self._lock = Lock()
        self._limit = limit
        self._held = 0

    def reserve(self, size: int, already: int = 0) -> bool:
        """Charge ``size`` more for a record that holds ``already``: within the budget, or one
        value larger than it while nothing else is held."""
        with self._lock:
            if self._held + size > self._limit and not (self._held == 0 and already == 0):
                return False
            self._held += size
            return True

    def release(self, size: int) -> None:
        with self._lock:
            self._held = max(0, self._held - size)

    @property
    def held(self) -> int:
        with self._lock:
            return self._held


def held_size(value: str | bytes) -> int:
    """What a held value costs: the interpreter's own size for it."""
    return sys.getsizeof(value)


@dataclass
class Held:
    """A queued span's values held whole for upload, by key, and its message attributes whose
    large inline files export uploads; the budget is released once, when the span is placed or
    no longer referenced."""

    values: dict[str, str | bytes] = field(default_factory=dict)
    parts: list[str] = field(default_factory=list)
    # Keys of values over the inline limit cut when the span was queued: never held whole.
    cut: list[str] = field(default_factory=list)
    size: int = 0
    budget: HeldValues | None = None
    _released: bool = False

    def release(self) -> None:
        if not self._released and self.budget is not None:
            self._released = True
            self.budget.release(self.size)


def attach_held(record: Any, held: Held) -> None:
    """Hold ``held`` with the record; its budget is released when the record is garbage."""
    record._hue_held = held
    if held.size:
        weakref.finalize(record, held.release)


def held_of(record: Any) -> Held | None:
    held = getattr(record, "_hue_held", None)
    return held if isinstance(held, Held) else None


class Uploads:
    """A client's uploads of span values over the inline limit: its uploader, the budget of
    values queued spans hold whole for it, and the request budget its exports follow. A client
    has one only while it captures content with a project key: metadata-only export and setup
    credentials upload nothing."""

    def __init__(self, base_url: str, headers: Mapping[str, str], timeout: float) -> None:
        self.uploader = BlobUploader(base_url, headers, timeout)
        self.held = HeldValues()
        self.timeout = timeout

    def holds(self) -> bool:
        """Whether values over the inline limit are worth holding whole for upload now."""
        return self.uploader.available()


@dataclass
class _Outcome:
    ok: bool
    reason: str = "failed"
    content_type: str = ""


def _no_auth(request: Any) -> Any:
    """Leaves a request as it is: no .netrc credentials are added to it."""
    return request


class _Reply:
    __slots__ = ("status", "headers", "body")

    def __init__(self, response: requests.Response, limit: int) -> None:
        self.status = response.status_code
        self.headers = response.headers
        content = bytearray()
        try:
            for chunk in response.iter_content(chunk_size=4096):
                content.extend(chunk)
                if len(content) > limit:
                    break
        finally:
            response.close()
        self.body = bytes(content[:limit])


class BlobUploader:
    """Uploads values to Hue: reserves each with ``POST /api/v1/otlp/blobs``, PUTs its bytes to
    the presigned URL Hue answers (skipped when Hue already stores the value), and completes it.
    At most ``UPLOAD_CONCURRENCY`` uploads run at once; every request has a deadline and none
    follows a redirect. A receiver without the route (a 404 without Hue's JSON error, a 405 or
    501, or a 200 that is no reservation) is remembered for ``UNSUPPORTED_PAUSE_SECONDS``, and a
    transient failure or a refusal that is not about the value alone pauses uploads for
    ``FAILURE_PAUSE_SECONDS``, so values fall back to the inline cut instead of retrying."""

    def __init__(self, base_url: str, headers: Mapping[str, str], timeout: float) -> None:
        self._base_url = base_url
        self._headers = {**headers, "Content-Type": "application/json"}
        self._timeout = timeout
        self._lock = Lock()
        self._unsupported_until = 0.0
        self._paused_until = 0.0
        self._closed = False
        self._slots = Semaphore(UPLOAD_CONCURRENCY)

    def available(self) -> bool:
        """Whether a value over the inline limit is worth holding whole for upload now."""
        with self._lock:
            return not self._closed and monotonic() >= self._unsupported_until

    def unsupported(self) -> bool:
        with self._lock:
            return monotonic() < self._unsupported_until

    def refusal(self) -> str | None:
        """Why a value cannot be uploaded right now without trying, if it cannot."""
        with self._lock:
            now = monotonic()
            if self._closed or now < self._paused_until:
                return "failed"
            if now < self._unsupported_until:
                return "unsupported"
            return None

    def close(self) -> None:
        with self._lock:
            self._closed = True

    def _pause(self) -> None:
        with self._lock:
            self._paused_until = monotonic() + FAILURE_PAUSE_SECONDS

    def _request(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: Any,
        deadline: float,
        limit: int,
    ) -> _Reply | None:
        remaining = deadline - monotonic()
        if remaining <= 0 or self._closed:
            return None
        token = None
        try:
            # Uploads are the SDK's own export traffic: an instrumentation must not trace them.
            token = attach(export_context())
            with requests.Session() as session:
                # The environment's proxy and CA settings apply, as to the OTLP requests; an
                # explicit no-op auth keeps .netrc credentials off every request, the store's
                # included, whose signature is in its URL.
                response = session.request(
                    method,
                    url,
                    headers=dict(headers),
                    data=body,
                    auth=_no_auth,
                    timeout=(min(remaining, self._timeout), min(remaining, self._timeout)),
                    allow_redirects=False,
                    stream=True,
                )
                return _Reply(response, limit)
        except Exception:
            return None
        finally:
            if token is not None:
                try:
                    detach(token)
                except Exception:
                    pass

    def store(
        self,
        trace_id: str,
        key: str,
        value: str | bytes,
        content_type: str,
        digest: tuple[str, int],
        deadline: float,
        wait: Callable[[float], bool],
    ) -> _Outcome:
        """Stores ``value`` under ``key`` of the trace: reserved, uploaded unless Hue already
        holds it, and completed. Holds an upload slot meanwhile."""
        refused = self.refusal()
        if refused:
            return _Outcome(False, refused)
        sha256, size = digest
        if size > MAX_BLOB_BYTES:
            return _Outcome(False, "too_large")
        if (
            not _is_blob_key(key)
            or not is_blob_content_type(content_type)
            or not _TRACE_ID.match(trace_id)
            or trace_id == "0" * 32
        ):
            return _Outcome(False, "failed")
        if not self._slots.acquire(timeout=max(0.0, deadline - monotonic())):
            return _Outcome(False, "failed")
        try:
            return self._store(trace_id, key, value, content_type, sha256, size, deadline, wait)
        finally:
            self._slots.release()

    def _store(
        self,
        trace_id: str,
        key: str,
        value: str | bytes,
        content_type: str,
        sha256: str,
        size: int,
        deadline: float,
        wait: Callable[[float], bool],
    ) -> _Outcome:
        body = json.dumps(
            {
                "traceId": trace_id,
                "sha256": sha256,
                "byteSize": size,
                "contentType": content_type,
                "key": key,
            },
            separators=(",", ":"),
        )
        reservation = self._reserve(body, size, deadline, wait)
        presigns = 1
        attempts = 0
        while reservation.get("grant"):
            grant = reservation["grant"]
            put = self._put(grant, value, size, deadline)
            if put == "stored":
                break
            expired = put == "expired" or time() >= grant["expires_at"]
            if put == "transient":
                attempts += 1
                if attempts < 2 and monotonic() + _RETRY_DELAY_SECONDS < deadline:
                    Event().wait(_RETRY_DELAY_SECONDS)
                    if self._closed:
                        return _Outcome(False, "failed")
                    if time() < grant["expires_at"]:
                        continue
                else:
                    self._pause()
                    return _Outcome(False, "failed")
            elif not expired:
                return _Outcome(False, "failed")
            # The URL expired: reserved again once.
            if presigns >= 2:
                return _Outcome(False, "failed")
            presigns += 1
            reservation = self._reserve(body, size, deadline, wait)
        if "fallback" in reservation:
            return _Outcome(False, reservation["fallback"])
        if reservation.get("grant"):
            # For Hue's accounting only: a value is read whether or not it was completed, so a
            # failed completion is not retried.
            self._request(
                "POST",
                f"{self._base_url}/api/v1/otlp/blobs/complete",
                self._headers,
                json.dumps({"traceId": trace_id, "sha256": sha256}, separators=(",", ":")),
                min(deadline, monotonic() + self._timeout),
                _MAX_JSON_RESPONSE_BYTES,
            )
        return _Outcome(True, content_type=reservation["content_type"])

    def _reserve(
        self, body: str, size: int, deadline: float, wait: Callable[[float], bool]
    ) -> dict[str, Any]:
        """Reserves the value: Hue answers that it holds it already, or a presigned PUT. A rate
        limit is waited out within the export's hold, a transient refusal retried once."""
        url = f"{self._base_url}/api/v1/otlp/blobs"
        for attempt in range(3):
            reply = self._request(
                "POST",
                url,
                self._headers,
                body,
                min(deadline, monotonic() + self._timeout),
                _MAX_JSON_RESPONSE_BYTES,
            )
            if reply is None:
                if (
                    attempt == 0
                    and monotonic() + _RETRY_DELAY_SECONDS < deadline
                    and not self._closed
                ):
                    Event().wait(_RETRY_DELAY_SECONDS)
                    continue
                self._pause()
                return {"fallback": "failed"}
            status = reply.status
            answer = _json(reply.body) if status in (200, 404) else None
            # A receiver without the route answers its framework's not-found (Hue's own 404, an
            # archived project, is JSON with an ``error``), refuses the method, or answers
            # something that is no reservation at all: it is not asked again for a while.
            if (
                status in (405, 501)
                or (
                    status == 404
                    and not (isinstance(answer, dict) and isinstance(answer.get("error"), str))
                )
                or (
                    status == 200
                    and not (
                        isinstance(answer, dict) and answer.get("status") in ("exists", "upload")
                    )
                )
            ):
                with self._lock:
                    self._unsupported_until = monotonic() + UNSUPPORTED_PAUSE_SECONDS
                return {"fallback": "unsupported"}
            if status == 200:
                reservation = self._reservation(answer, size)
                # A reservation that cannot be used would fail every value alike.
                if "fallback" in reservation:
                    self._pause()
                return reservation
            if status == 413:
                return {"fallback": "too_large"}
            if status == 429:
                delay = _retry_after_seconds(reply)
                if monotonic() + delay < deadline and wait(delay):
                    continue
                return {"fallback": "failed"}
            if status >= 500:
                delay = _retry_after_seconds(reply)
                if (
                    attempt == 0
                    and delay <= _MAX_TRANSIENT_WAIT_SECONDS
                    and monotonic() + delay < deadline
                ):
                    Event().wait(delay)
                    continue
                self._pause()
                return {"fallback": "failed"}
            # A conflict over this value alone (409) fails only it. Any other refusal (a refused
            # key, an archived project, a request Hue could not read, a redirect) would meet every
            # value alike, so uploads pause; the export's own requests report a key problem.
            if status != 409:
                self._pause()
            return {"fallback": "failed"}
        return {"fallback": "failed"}

    def _reservation(self, answer: Any, size: int) -> dict[str, Any]:
        """A 200 answer read: ``exists``, or an upload whose URL and headers are usable."""
        if not isinstance(answer, dict):
            return {"fallback": "failed"}
        ref = answer.get("ref")
        content_type = ref.get("content_type") if isinstance(ref, dict) else None
        if not is_blob_content_type(content_type):
            return {"fallback": "failed"}
        if answer.get("status") == "exists":
            return {"content_type": content_type}
        headers = answer.get("headers")
        url = answer.get("url")
        if (
            answer.get("status") != "upload"
            or answer.get("method") != "PUT"
            or not isinstance(url, str)
            or not isinstance(headers, dict)
            or len(headers) > 32
        ):
            return {"fallback": "failed"}
        try:
            parsed = urlsplit(url)
            hostname = parsed.hostname or ""
        except ValueError:
            return {"fallback": "failed"}
        # The bytes go only where TLS protects them, or to a loopback development store.
        secure = parsed.scheme == "https" or (parsed.scheme == "http" and _loopback(hostname))
        if not secure or parsed.username is not None or parsed.password is not None:
            return {"fallback": "failed"}
        signed: dict[str, str] = {}
        for name, value in headers.items():
            if (
                not isinstance(name, str)
                or not isinstance(value, str)
                or not _HEADER_NAME.match(name)
                or not _HEADER_VALUE.match(value)
                # Hue's credentials never travel to the store; the signature is in the URL.
                or name.lower() == "authorization"
            ):
                return {"fallback": "failed"}
            signed[name] = value
        length = next(
            (value for name, value in signed.items() if name.lower() == "content-length"), None
        )
        if length is not None and length != str(size):
            return {"fallback": "failed"}
        if length is None:
            signed["Content-Length"] = str(size)
        expires_at = float("inf")
        if isinstance(answer.get("expiresAt"), str):
            try:
                expires_at = parsedate_iso(answer["expiresAt"])
            except ValueError:
                pass
        return {
            "content_type": content_type,
            "grant": {"url": url, "headers": signed, "expires_at": expires_at},
        }

    def _put(self, grant: Mapping[str, Any], value: str | bytes, size: int, deadline: float) -> str:
        """The PUT of the value's bytes, with exactly the headers Hue signed."""
        body = _Body(value, size, deadline, lambda: self._closed)
        reply = self._request(
            "PUT", grant["url"], grant["headers"], body, deadline, _MAX_ERROR_RESPONSE_BYTES
        )
        if reply is None:
            return "transient"
        # 412: the object exists already (another upload of the same value won).
        if 200 <= reply.status < 300 or reply.status == 412:
            return "stored"
        if reply.status == 403:
            return "expired" if b"Request has expired" in reply.body else "failed"
        if reply.status >= 500 or reply.status == 408:
            return "transient"
        return "failed"


def parsedate_iso(value: str) -> float:
    """An ISO 8601 timestamp (``2026-10-05T12:15:00.000Z``) as seconds since the epoch."""
    from datetime import datetime

    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def _retry_after_seconds(reply: _Reply) -> float:
    value = reply.headers.get("Retry-After")
    if value is not None:
        try:
            return max(0.0, float(value))
        except ValueError:
            pass
    return _RETRY_DELAY_SECONDS


def _json(body: bytes) -> Any:
    try:
        return json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


@dataclass
class Tally:
    """One export's uploads and fallbacks, reported once its records are placed."""

    uploaded: int = 0
    fallbacks: dict[str, tuple[int, set[str]]] = field(default_factory=dict)

    def fallback(self, reason: str, trace_id: str) -> None:
        count, traces = self.fallbacks.get(reason, (0, set()))
        traces.add(trace_id)
        self.fallbacks[reason] = (count + 1, traces)


@dataclass
class _Result:
    """Where one candidate value was placed, and what its placement uploaded or fell back."""

    value: Any
    listed: bool = False
    entries: list[tuple[tuple[int, int], str]] = field(default_factory=list)
    uploads: int = 0
    fallbacks: list[str] = field(default_factory=list)


class _Span:
    """One span's placement: its candidates, and the ``hue.blobs`` places it has left."""

    def __init__(self, attributes: Mapping[str, Any], held: Held, trace_id: str) -> None:
        self.attributes = attributes
        self.trace_id = trace_id
        existing = attributes.get(BLOBS_KEY)
        self.existing = (
            [item for item in existing if isinstance(item, str)]
            if isinstance(existing, (list, tuple))
            else []
        )
        self._lock = Lock()
        self._slots = MAX_BLOB_ENTRIES - len(self.existing)
        self.cut = len(held.cut)
        # In the span's attribute order, as the TypeScript SDK places them.
        self.candidates: list[tuple[str, str | bytes]] = []
        for key in attributes:
            if key not in held.values and key not in held.parts:
                continue
            value = held.values.get(key, attributes.get(key))
            if isinstance(value, (str, bytes)):
                self.candidates.append((key, value))

    def slot(self) -> bool:
        with self._lock:
            if self._slots <= 0:
                return False
            self._slots -= 1
            return True

    def give_back(self) -> None:
        with self._lock:
            self._slots += 1


@dataclass
class _Context:
    uploader: BlobUploader
    value_bytes: int
    deadline: float
    wait: Callable[[float], bool]


def _upload_parts(
    span: _Span, index: int, key: str, text: str, context: _Context, result: _Result
) -> str:
    """A recorded message with each inline file over the limit uploaded and replaced by its first
    16 KiB, or by its digest, as before, when it could not be."""
    if not may_inline_files(key, text):
        return text
    if not INLINE_FILE_LIMIT < utf8_size(text, MAX_INLINE_FILE_TEXT) <= MAX_INLINE_FILE_TEXT:
        return text
    try:
        parsed = json.loads(text)
        found = large_inline_file_parts(parsed)
    except (ValueError, RecursionError):
        return text
    changed = False
    for position, file in enumerate(found):
        part_key = f"{key}#{file.pointer}"
        has_slot = _is_blob_key(part_key) and span.slot()
        decoded = inline_file(file.content)
        if len(decoded.data) <= INLINE_FILE_LIMIT:
            if has_slot:
                span.give_back()
            continue
        changed = True
        digest = digest_of(decoded.data)
        outcome = (
            context.uploader.store(
                span.trace_id,
                part_key,
                decoded.data,
                _file_content_type(file.part, decoded),
                digest,
                context.deadline,
                context.wait,
            )
            if has_slot
            else _Outcome(False, "budget")
        )
        if outcome.ok:
            file.part[file.key] = blob_prefix(file.content)
            result.entries.append(
                ((index, position), _blob_entry(part_key, *digest, outcome.content_type))
            )
            result.uploads += 1
        else:
            digest_part(file.part, file.key, *digest)
            result.fallbacks.append(outcome.reason)
    return dumps_message(parsed) if changed else text


def _place(span: _Span, index: int, key: str, value: str | bytes, context: _Context) -> _Result:
    """One candidate placed: whole within the limit, uploaded, or cut as before."""
    result = _Result(value)
    cap = context.value_bytes
    if isinstance(value, str):
        # Credentials leave tool definitions and recorded requests before anything is stored.
        scrubbed = scrub_tool_credentials(key, value)
        if not isinstance(scrubbed, str):
            result.value = scrubbed
            return result
        value = _upload_parts(span, index, key, scrubbed, context, result)
    # ASCII text is its own size; other text is measured as it is hashed, once.
    digest = None if isinstance(value, bytes) or value.isascii() else digest_of(value)
    size = digest[1] if digest else len(value)
    if size <= cap:
        result.value = value
        return result
    result.listed = True
    placed = value

    def cut() -> Any:
        return cut_utf8(placed, cap) if isinstance(placed, str) else truncated_marker(size)

    refused = "too_large" if size > MAX_BLOB_BYTES else context.uploader.refusal()
    if refused or not span.slot():
        result.value = cut()
        result.fallbacks.append(refused or "budget")
        return result
    content_type = (
        text_content_type(value) if isinstance(value, str) else "application/octet-stream"
    )
    digest = digest or digest_of(value)
    outcome = context.uploader.store(
        span.trace_id, key, value, content_type, digest, context.deadline, context.wait
    )
    if outcome.ok:
        result.value = blob_prefix(value)
        result.entries.append(
            ((index, sys.maxsize), _blob_entry(key, *digest, outcome.content_type))
        )
        result.uploads += 1
    else:
        result.value = cut()
        result.fallbacks.append(outcome.reason)
    return result


def _fallback(key: str, value: str | bytes, cap: int) -> _Result:
    """A candidate placed as it was before uploads existed, for a placement that failed or did
    not finish in time: credentials scrubbed, large inline files as their digest, a value over
    the limit cut to it (bytes replaced by the receiver's marker) and listed. A value that cannot
    be scrubbed or encoded is replaced by the receiver's marker, never cut."""
    try:
        placed: Any = hash_inline_files(key, scrub_tool_credentials(key, value))
        if isinstance(placed, str) and over_utf8(placed, cap):
            return _Result(cut_utf8(placed, cap), listed=True, fallbacks=["failed"])
        if isinstance(placed, bytes) and len(placed) > cap:
            return _Result(truncated_marker(len(placed)), listed=True, fallbacks=["failed"])
        return _Result(placed)
    except Exception:
        return _Result(truncated_marker(len(value)), listed=True, fallbacks=["failed"])


def place_spans(
    spans: list[tuple[Mapping[str, Any], Held, str]],
    *,
    uploader: BlobUploader,
    value_bytes: int,
    deadline: float,
    wait: Callable[[float], bool],
) -> tuple[list[dict[str, Any]], Tally]:
    """Each span's own attributes with its held values, and its messages holding a large inline
    file, placed: a file uploaded and replaced by its first 16 KiB (or its digest), a value still
    over the inline limit uploaded and replaced by its first 16 KiB (or cut to the limit), each
    upload listed under ``hue.blobs`` and each whole value cut or uploaded listed under
    ``hue.truncated``. Values are placed on up to ``UPLOAD_CONCURRENCY`` threads; one not placed
    by ``deadline`` falls back to the cut, and an upload still running then stops sending its body
    at that deadline; its answer goes unused."""
    context = _Context(uploader, value_bytes, deadline, wait)
    placements = [_Span(attributes, held, trace_id) for attributes, held, trace_id in spans]
    pending = [
        (number, index, key, value)
        for number, span in enumerate(placements)
        for index, (key, value) in enumerate(span.candidates)
    ]
    total = len(pending)
    results: dict[tuple[int, int], _Result] = {}
    lock = Lock()
    done = Event()
    closed = [False]

    def work() -> None:
        token = attach(export_context())
        try:
            while True:
                with lock:
                    if closed[0] or not pending:
                        return
                    number, index, key, value = pending.pop(0)
                try:
                    result: _Result | None = _place(placements[number], index, key, value, context)
                except Exception:
                    result = None
                with lock:
                    if closed[0]:
                        return
                    if result is not None:
                        results[(number, index)] = result
                    else:
                        results[(number, index)] = _fallback(key, value, value_bytes)
                    if len(results) == total:
                        done.set()
        finally:
            detach(token)

    if total:
        for _ in range(min(UPLOAD_CONCURRENCY, total)):
            Thread(target=work, name="hue-upload", daemon=True).start()
        done.wait(max(0.0, deadline - monotonic()) + 1)
    with lock:
        closed[0] = True
        placed = dict(results)
    tally = Tally()
    attributes: list[dict[str, Any]] = []
    for number, span in enumerate(placements):
        for _ in range(span.cut):
            tally.fallback("unsupported" if uploader.unsupported() else "budget", span.trace_id)
        result_attributes = dict(span.attributes)
        listed: list[str] = []
        entries: list[tuple[tuple[int, int], str]] = []
        for index, (key, value) in enumerate(span.candidates):
            result = placed.get((number, index)) or _fallback(key, value, value_bytes)
            result_attributes[key] = result.value
            if result.listed:
                listed.append(key)
            entries.extend(result.entries)
            tally.uploaded += result.uploads
            for reason in result.fallbacks:
                tally.fallback(reason, span.trace_id)
        if listed:
            result_attributes[TRUNCATED_KEY] = with_truncated_keys(
                result_attributes.get(TRUNCATED_KEY), listed
            )
        if entries:
            result_attributes[BLOBS_KEY] = [
                *span.existing,
                *(entry for _, entry in sorted(entries)),
            ]
        attributes.append(result_attributes)
    return attributes, tally
