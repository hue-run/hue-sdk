"""Large values and binary media, uploaded apart from their span.

The exporter uses reservation, presigned PUT, and completion. Text keeps a 16 KiB prefix.
Binary media keeps digest metadata on its part. Successful uploads are listed in ``hue.blobs``;
failures keep inline fallback or file metadata, are reported as warnings, and are counted.
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
from collections import OrderedDict
from collections.abc import Callable, Iterator, Mapping
from contextlib import AbstractContextManager, contextmanager, nullcontext
from dataclasses import dataclass, field
from threading import Event, Lock, Semaphore, Thread, local
from time import monotonic, time
from typing import Any
from urllib.parse import urlsplit

import requests
from opentelemetry.context import attach, detach

from ._inline_files import (
    INLINE_FILE_LIMIT,
    INLINE_FILE_TEXT_PER_RECORD,
    MAX_INLINE_FILE_TEXT,
    InlineFilePart,
    MediaDigestMemo,
    MediaValue,
    digest_part,
    hash_inline_files_counted,
    is_message_key,
    is_text_media_type,
    keeps_prefix,
    may_inline_files,
    media_bytes,
    media_content_type,
    media_in,
    placeable,
    placed_media_text,
    prefix_part,
    read_media_text,
    reencode_media,
    utf16_size,
)
from ._limits import TRUNCATED_KEY, cut_utf8, over_utf8
from ._otel_compat import export_context
from ._records import truncated_marker, with_truncated_keys
from ._tool_definitions import scrub_tool_credentials

# The span attribute listing the values the SDK uploaded apart from the span: one compact JSON
# object per value, ``{"key", "sha256", "size", "content_type"}``, with an optional ``name``.
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
# Placement threads at once, counting those waiting for another reference's upload of the same
# bytes, for which another thread starts so waiting never holds a place a new file needs.
_MAX_PLACEMENT_THREADS = 64
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


# Why content kept its fallback instead of being uploaded, and its export issue description.
FALLBACK_MESSAGES = {
    "unsupported": (
        "This Hue server does not accept uploaded values; large values were cut inline "
        "and media kept digest metadata"
    ),
    "failed": (
        "Content could not be uploaded; large values were cut inline and media kept digest metadata"
    ),
    "too_large": "Content over its upload limit kept inline fallback or file metadata",
    "budget": (
        "Content did not fit the SDK's upload budget; large values were cut inline "
        "and media kept digest metadata"
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
    return (
        isinstance(key, str)
        and 1 <= len(key) <= _MAX_BLOB_KEY_LENGTH
        and not any(ord(char) < 0x20 or ord(char) == 0x7F for char in key)
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


def _blob_entry(
    key: str, sha256: str, size: int, content_type: str, name: str | None = None
) -> str:
    entry: dict[str, Any] = {
        "key": key,
        "sha256": sha256,
        "size": size,
        "content_type": content_type,
    }
    if name is not None:
        entry["name"] = name
    return json.dumps(entry, ensure_ascii=False, separators=(",", ":"))


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
    """A queued span's values held whole for upload, by key.

    Values include those over the inline limit and messages with binary or large textual
    inline files. The budget is released once, when placed or no longer referenced.
    """

    values: dict[str, str | bytes] = field(default_factory=dict)
    # Keys of values cut at the inline limit or messages whose binary and large textual
    # inline files shrank to digests when queued (once per file): never held whole.
    cut: list[str] = field(default_factory=list)
    size: int = 0
    budget: HeldValues | None = None
    files: list[ExplicitFile] = field(default_factory=list)
    digests: dict[str, dict[str, tuple[str, int]]] = field(default_factory=dict)
    inspected: set[str] | None = None
    # A log record whose GenAI body export places, and the strings over the cap its copy cut,
    # held whole by their JSON pointer in the body.
    body: bool = False
    body_values: dict[str, str] = field(default_factory=dict)
    _released: bool = False

    def release(self) -> None:
        if not self._released and self.budget is not None:
            self._released = True
            self.budget.release(self.size)


def attach_held(record: Any, held: Held) -> None:
    """Hold ``held`` with the record; its budget is released when the record is garbage."""
    # A log record is a frozen dataclass: the held values ride on it all the same.
    object.__setattr__(record, "_hue_held", held)
    if held.size:
        weakref.finalize(record, held.release)


def held_of(record: Any) -> Held | None:
    held = getattr(record, "_hue_held", None)
    return held if isinstance(held, Held) else None


@dataclass(frozen=True)
class ExplicitFile:
    data: bytes
    digest: tuple[str, int]
    content_type: str
    name: str | None
    role: str = "input"
    timestamp: int | None = None
    # For an attachment placed in a value: the record's attribute (or ``body``) holding its part,
    # and the part's JSON pointer there.
    attribute: str | None = None
    pointer: str | None = None

    @property
    def key(self) -> str:
        """The file's ``hue.blobs`` key: its part's, else its ``hue.file`` event's."""
        if self.attribute is not None and self.pointer is not None:
            return f"{self.attribute}#{self.pointer}"
        return f"event:hue.file:{self.digest[0]}"


@dataclass
class _Staged:
    held: Held
    finalizer: Any


class Uploads:
    """A client's uploads of span values over the inline limit: its uploader, the budget of
    values queued spans hold whole for it, and the request budget its exports follow. A client
    has one only while it captures content with a project key: metadata-only export and setup
    credentials upload nothing."""

    def __init__(self, base_url: str, headers: Mapping[str, str], timeout: float) -> None:
        self.uploader = BlobUploader(base_url, headers, timeout)
        self.held = HeldValues()
        self.timeout = timeout
        self.memo = MediaDigestMemo()
        self._lock = Lock()
        self._staged: dict[tuple[int, int], _Staged] = {}
        self._closed = False
        # Attachments placed in a log record's body, from ``log_inference`` to its admission.
        self._pending_log = local()

    def stage(self, span: Any, file: ExplicitFile) -> bool:
        context = span.get_span_context()
        key = (context.trace_id, context.span_id)
        size = held_size(file.data) + 1024
        with self._lock:
            if self._closed:
                return False
            staged = self._staged.get(key)
            if staged is None:
                if len(self._staged) >= 256:
                    return False
                held = Held(budget=self.held)
            else:
                held = staged.held
            if len(held.files) >= MAX_BLOB_ENTRIES or not self.held.reserve(size, held.size):
                return False
            held.size += size
            held.files.append(file)
            if staged is None:

                def abandoned() -> None:
                    with self._lock:
                        item = self._staged.pop(key, None)
                    if item is not None:
                        item.held.release()

                self._staged[key] = _Staged(held, weakref.finalize(span, abandoned))
            return True

    def stage_parts(self, span: Any, attribute: str, files: list[ExplicitFile]) -> list[str]:
        """Stage the attachments placed in a span's ``attribute``, replacing those an earlier
        value of the attribute placed. The fallback reason of each file that cannot be held."""
        context = span.get_span_context()
        key = (context.trace_id, context.span_id)
        refused: list[str] = []
        with self._lock:
            if self._closed:
                return ["failed" for _ in files]
            staged = self._staged.get(key)
            if staged is not None:
                held = staged.held
                kept = []
                for file in held.files:
                    if file.attribute == attribute:
                        released = held_size(file.data) + 1024
                        held.size -= released
                        self.held.release(released)
                    else:
                        kept.append(file)
                held.files[:] = kept
            for file in files:
                reason = self.uploader.refusal()
                if reason is not None or not self.uploader.available():
                    refused.append(reason or "unsupported")
                    continue
                size = held_size(file.data) + 1024
                staged = self._staged.get(key)
                if staged is None:
                    if len(self._staged) >= 256:
                        refused.append("budget")
                        continue
                    held = Held(budget=self.held)
                else:
                    held = staged.held
                if len(held.files) >= MAX_BLOB_ENTRIES or not self.held.reserve(size, held.size):
                    refused.append("budget")
                    continue
                held.size += size
                held.files.append(file)
                if staged is None:
                    self._staged[key] = _Staged(held, weakref.finalize(span, self._abandoned, key))
        return refused

    def _abandoned(self, key: tuple[int, int]) -> None:
        with self._lock:
            item = self._staged.pop(key, None)
        if item is not None:
            item.held.release()

    def stage_log(self, body: Any, files: list[ExplicitFile]) -> list[str]:
        """Stage the attachments placed in a log record's body until the record is emitted on
        this thread (``take_log``). The fallback reason of each file that cannot be held."""
        refused: list[str] = []
        kept: list[ExplicitFile] = []
        size = 0
        for file in files:
            reason = self.uploader.refusal()
            if reason is not None or not self.uploader.available():
                refused.append(reason or "unsupported")
            elif len(kept) >= MAX_BLOB_ENTRIES:
                refused.append("budget")
            else:
                kept.append(file)
                size += held_size(file.data) + 1024
        self._pending_log.value = (body, kept, size) if kept else None
        return refused

    def take_log(self, body: Any) -> Held | None:
        """The attachments staged for a log record being admitted, held within the held-value
        budget; those the budget refused are listed under ``cut``, once per file."""
        pending = getattr(self._pending_log, "value", None)
        if pending is None or not (pending[0] is body or pending[0] == body):
            return None
        self._pending_log.value = None
        _, files, size = pending
        if not self.held.reserve(size):
            return Held(cut=["body" for _ in files])
        return Held(budget=self.held, files=list(files), size=size)

    def drop_log(self, body: Any) -> int:
        """Drops the attachments staged for a log record lost before it was admitted: how many."""
        pending = getattr(self._pending_log, "value", None)
        if pending is None or not (pending[0] is body or pending[0] == body):
            return 0
        self._pending_log.value = None
        return len(pending[1])

    def unstage_log(self) -> None:
        """Drops what ``stage_log`` staged and no processor of this client admitted."""
        self._pending_log.value = None

    def take(self, span: Any) -> Held | None:
        context = span.context
        if context is None:
            return None
        with self._lock:
            item = self._staged.pop((context.trace_id, context.span_id), None)
        if item is None:
            return None
        item.finalizer.detach()
        return item.held

    def close(self) -> None:
        self.uploader.close()
        self.memo.clear()
        with self._lock:
            self._closed = True
            items = list(self._staged.values())
            self._staged.clear()
        for item in items:
            item.finalizer.detach()
            item.held.release()

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
    """A response read within ``deadline``, its body bounded by ``limit``. The read timeout only
    bounds silence, so a peer that trickles its answer would keep an upload slot and its value
    long after the export moved on: the body is read a byte at a time, each read waiting on the
    peer at most once, and a reply not read whole by the deadline raises."""

    __slots__ = ("status", "headers", "body")

    def __init__(self, response: requests.Response, limit: int, deadline: float) -> None:
        self.status = response.status_code
        self.headers = response.headers
        content = bytearray()
        try:
            # Hue's answers and the store's are small; a larger body is not read past ``limit``.
            for chunk in response.iter_content(chunk_size=1):
                if monotonic() >= deadline:
                    raise TimeoutError("The reply ran out of time.")
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
        # Outcomes retain only identifiers and completion metadata, never upload bytes.
        self._outcomes: OrderedDict[tuple[str, str], tuple[Event, list[_Outcome]]] = OrderedDict()
        self._outcome_limit = 1024

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
            self._outcomes.clear()

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
                return _Reply(response, limit, deadline)
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
        sharing: Callable[[], AbstractContextManager[None]] = nullcontext,
    ) -> _Outcome:
        """Stores ``value`` under ``key`` of the trace: reserved, uploaded unless Hue already
        holds it, and completed. Holds an upload slot meanwhile. Another reference to bytes the
        trace is already storing waits for that upload's outcome, within ``sharing``, without a
        slot."""
        sha256, size = digest
        if size <= 0:
            return _Outcome(False, "failed")
        if size > MAX_BLOB_BYTES:
            return _Outcome(False, "too_large")
        if (
            not _is_blob_key(key)
            or not is_blob_content_type(content_type)
            or not _TRACE_ID.match(trace_id)
            or trace_id == "0" * 32
        ):
            return _Outcome(False, "failed")
        identity = (trace_id, sha256)
        with self._lock:
            known = self._outcomes.get(identity)
            owner = known is None
            if known is None:
                if len(self._outcomes) >= self._outcome_limit:
                    finished = next(
                        (k for k, (event, _) in self._outcomes.items() if event.is_set()), None
                    )
                    if finished is None:
                        return _Outcome(False, "budget")
                    del self._outcomes[finished]
                known = (Event(), [])
                self._outcomes[identity] = known
        event, outcomes = known
        if not owner:
            if not event.is_set():
                with sharing():
                    event.wait(max(0.0, deadline - monotonic()))
            return outcomes[0] if event.is_set() else _Outcome(False, "failed")
        outcome = _Outcome(False, "failed")
        try:
            refused = self.refusal()
            if refused:
                outcome = _Outcome(False, refused)
            elif self._slots.acquire(timeout=max(0.0, deadline - monotonic())):
                try:
                    outcome = self._store(
                        trace_id, key, value, content_type, sha256, size, deadline, wait
                    )
                finally:
                    self._slots.release()
            return outcome
        finally:
            with self._lock:
                outcomes.append(outcome)
                if not outcome.ok and self._outcomes.get(identity) is known:
                    del self._outcomes[identity]
                event.set()

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
            completion = self._request(
                "POST",
                f"{self._base_url}/api/v1/otlp/blobs/complete",
                self._headers,
                json.dumps({"traceId": trace_id, "sha256": sha256}, separators=(",", ":")),
                min(deadline, monotonic() + self._timeout),
                _MAX_JSON_RESPONSE_BYTES,
            )
            if completion is None or completion.status >= 500 or completion.status == 429:
                self._pause()
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
            answer = _json(reply.body) if status in (200, 404, 409) else None
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
            if status == 200 or (
                status == 409 and isinstance(answer, dict) and answer.get("status") == "exists"
            ):
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
                self._pause()
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
            if status not in (400, 409, 413):
                self._pause()
            return {"fallback": "failed"}
        self._pause()
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
        if reply.status >= 500 or reply.status in (408, 429):
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
    """One span's or log record's placement: its candidates, and the ``hue.blobs`` places it has
    left. A log record (``log``) places the media of its held attributes and of its ``body``, the
    body first, and uploads no value whole."""

    def __init__(
        self,
        attributes: Mapping[str, Any],
        held: Held,
        trace_id: str,
        *,
        log: bool = False,
        body: Any = None,
    ) -> None:
        self.attributes = attributes
        self.trace_id = trace_id
        self.held = held
        self.log = log
        self.body_media: MediaValue | None = None
        self.body_files: list[InlineFilePart] = []
        self.placed_body: Any = None
        existing = attributes.get(BLOBS_KEY)
        self.existing = (
            [item for item in existing if isinstance(item, str)]
            if isinstance(existing, (list, tuple))
            else []
        )
        self._lock = Lock()
        self._slots = MAX_BLOB_ENTRIES - len(self.existing)
        self.cut = len(held.cut)
        # In the span's attribute order, as the TypeScript SDK places them; a log record's body
        # first.
        self.candidates: list[tuple[str, Any]] = []
        inspected_units = 0
        if log and held.body:
            self.candidates.append(("body", body))
            # A body's files count toward the record's inspection bounds first, each by its
            # content, as an attribute counts by its text.
            try:
                self.body_media = media_in(body)
            except (ValueError, RecursionError):
                self.body_media = None
            for file in self.body_media.files if self.body_media else ():
                units = utf16_size(file.content, MAX_INLINE_FILE_TEXT)
                if (
                    units <= MAX_INLINE_FILE_TEXT
                    and inspected_units + units <= INLINE_FILE_TEXT_PER_RECORD
                ):
                    inspected_units += units
                    self.body_files.append(file)
        for key in attributes:
            value = held.values.get(key)
            if isinstance(value, (str, bytes)):
                self.candidates.append((key, value))
        # A span's export inspects only what admission inspected; a log record's within its own
        # allowance, its body's files first.
        self.inspected: set[str] = set(() if log else held.inspected or ())
        for key, candidate in self.candidates:
            if (
                (log or held.inspected is None)
                and isinstance(candidate, str)
                and may_inline_files(key, candidate)
            ):
                size = utf16_size(candidate, MAX_INLINE_FILE_TEXT)
                if (
                    size <= MAX_INLINE_FILE_TEXT
                    and inspected_units + size <= INLINE_FILE_TEXT_PER_RECORD
                ):
                    self.inspected.add(key)
                    inspected_units += size
        self.candidates.extend((file.key, file) for file in held.files)

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
    memo: MediaDigestMemo
    # Entered while waiting for another reference's upload of the same bytes.
    sharing: Callable[[], AbstractContextManager[None]] = nullcontext


def _place_files(
    span: _Span,
    index: int,
    key: str,
    files: list[InlineFilePart],
    context: _Context,
    result: _Result,
) -> bool:
    """Upload each file of a value and place it; whether any was placed. A file is placed in its
    digest form (a text file in a provider part keeps a 16 KiB prefix). One that is not uploaded
    keeps its bytes inline, except in a recorded message: a span's own message keeps its digest,
    and a log record's keeps the digest of a file over the inline limit, as nested messages kept
    them before log records uploaded."""
    message = is_message_key(key)
    changed = False
    for position, file in enumerate(files):
        decoded = media_bytes(file)
        if not placeable(file, decoded):
            continue
        content_type = media_content_type(file, decoded)
        if not is_blob_content_type(content_type):
            content_type = (
                "application/octet-stream" if decoded.decoded else "text/plain; charset=utf-8"
            )
        textual = is_text_media_type(content_type)
        if textual and len(decoded.data) <= INLINE_FILE_LIMIT:
            continue
        prefix = keeps_prefix(file, textual)
        part_key = f"{key}#{file.pointer if prefix else file.part_pointer}"
        has_slot = _is_blob_key(part_key) and span.slot()
        digest = span.held.digests.get(key, {}).get(file.pointer) or context.memo.digest(
            decoded.data, span.trace_id
        )
        outcome = (
            context.uploader.store(
                span.trace_id,
                part_key,
                decoded.data,
                content_type,
                digest,
                context.deadline,
                context.wait,
                context.sharing,
            )
            if has_slot
            else _Outcome(False, "budget")
        )
        if outcome.ok:
            if prefix:
                prefix_part(file, blob_prefix(file.content))  # type: ignore[arg-type]
            else:
                digest_part(file, *digest)
            changed = True
            result.entries.append(
                ((index, position), _blob_entry(part_key, *digest, outcome.content_type, file.name))
            )
            result.uploads += 1
        else:
            if message and (not span.log or len(decoded.data) > INLINE_FILE_LIMIT):
                digest_part(file, *digest)
                changed = True
            result.fallbacks.append(outcome.reason)
    return changed


def _upload_parts(
    span: _Span, index: int, key: str, text: str, context: _Context, result: _Result
) -> str:
    """Upload recognized media, keeping digests for binary and prefixes for large text."""
    if (
        key not in span.inspected
        or not may_inline_files(key, text)
        or utf16_size(text, MAX_INLINE_FILE_TEXT) > MAX_INLINE_FILE_TEXT
    ):
        return text
    try:
        media = read_media_text(key, text)
    except (ValueError, RecursionError):
        return text
    if media is None or not media.files:
        return text
    return (
        placed_media_text(media)
        if _place_files(span, index, key, media.files, context, result)
        else text
    )


def _cap_body(body: Any, cap: int) -> tuple[Any, bool]:
    """A log record's placed body cut as its copy would have been: each string over the cap cut
    to it and bytes over it replaced by the receiver's marker. Whether anything was cut."""
    cut = False

    def visit(value: Any) -> Any:
        nonlocal cut
        if isinstance(value, str):
            if not over_utf8(value, cap):
                return value
            cut = True
            return cut_utf8(value, cap)
        if isinstance(value, bytes):
            if len(value) <= cap:
                return value
            cut = True
            return truncated_marker(len(value))
        if isinstance(value, Mapping):
            return {key: visit(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [visit(item) for item in value]
        return value

    return visit(body), cut


def _place(
    span: _Span, index: int, key: str, value: str | bytes | ExplicitFile, context: _Context
) -> _Result:
    """One candidate placed: whole within the limit, uploaded, or cut as before."""
    result = _Result(value)
    cap = context.value_bytes
    if span.log and key == "body" and index == 0:
        # A log record's body: its files placed, then what is left over the cap cut.
        if span.body_media is not None and _place_files(
            span, index, key, span.body_files, context, result
        ):
            reencode_media(span.body_media)
        body = span.body_media.box["value"] if span.body_media is not None else value
        result.value, result.listed = _cap_body(body, cap)
        return result
    if isinstance(value, ExplicitFile):
        outcome = (
            context.uploader.store(
                span.trace_id,
                key,
                value.data,
                value.content_type,
                value.digest,
                context.deadline,
                context.wait,
                context.sharing,
            )
            if span.slot()
            else _Outcome(False, "budget")
        )
        if outcome.ok:
            result.entries.append(
                ((index, 0), _blob_entry(key, *value.digest, outcome.content_type, value.name))
            )
            result.uploads += 1
        else:
            result.fallbacks.append(outcome.reason)
        return result
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

    if span.log:
        # A log record's value is cut, as no log reader pages an uploaded text value.
        result.value = cut()
        return result
    refused = "too_large" if size > MAX_BLOB_BYTES else None
    if refused or not span.slot():
        result.value = cut()
        result.fallbacks.append(refused or "budget")
        return result
    content_type = (
        text_content_type(value) if isinstance(value, str) else "application/octet-stream"
    )
    digest = digest or digest_of(value)
    outcome = context.uploader.store(
        span.trace_id,
        key,
        value,
        content_type,
        digest,
        context.deadline,
        context.wait,
        context.sharing,
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


def _fallback(key: str, value: Any, cap: int, inspect: bool = True, log: bool = False) -> _Result:
    """Place a candidate whose upload failed or did not finish in time.

    Scrub credentials, replace a span's recorded messages' binary and large textual inline files
    with digests, and cut values over the limit (bytes use the receiver's marker). Values that
    cannot be scrubbed or encoded use the receiver's marker. A log record's files keep their bytes
    inline, its messages' files over the inline limit their digest, and its values over the limit
    are cut, as before log records uploaded.
    """
    if isinstance(value, ExplicitFile):
        return _Result(None, fallbacks=["failed"])
    if log and key == "body":
        body, listed = _cap_body(value, cap)
        return _Result(body, listed=listed)
    try:
        scrubbed = scrub_tool_credentials(key, value)
        placed, files = (
            hash_inline_files_counted(key, scrubbed, preserve_small_binary=log)
            if inspect
            else (scrubbed, 0)
        )
        # Report each binary or large textual inline file as not uploaded.
        fallbacks = ["failed"] * files
        failed = [] if log else ["failed"]
        if isinstance(placed, str) and over_utf8(placed, cap):
            return _Result(cut_utf8(placed, cap), listed=True, fallbacks=[*fallbacks, *failed])
        if isinstance(placed, bytes) and len(placed) > cap:
            return _Result(truncated_marker(len(placed)), listed=True, fallbacks=failed)
        return _Result(placed, fallbacks=fallbacks)
    except Exception:
        return _Result(truncated_marker(len(value)), listed=True, fallbacks=["failed"])


def place_spans(
    spans: list[tuple[Mapping[str, Any], Held, str]],
    *,
    uploader: BlobUploader,
    value_bytes: int,
    deadline: float,
    wait: Callable[[float], bool],
    memo: MediaDigestMemo | None = None,
) -> tuple[list[dict[str, Any]], Tally]:
    """Each span's own attributes with its held values, and its messages holding a large inline
    file, placed: a file uploaded and replaced by its first 16 KiB (or its digest), a value still
    over the inline limit uploaded and replaced by its first 16 KiB (or cut to the limit), each
    upload listed under ``hue.blobs`` and each whole value cut or uploaded listed under
    ``hue.truncated``. Values are placed on up to ``UPLOAD_CONCURRENCY`` threads, and a thread
    waiting for another reference's upload of the same bytes is replaced meanwhile, so repeated
    files never hold the places new files need; one not placed by ``deadline`` falls back to the
    cut, and an upload still running then stops sending its body at that deadline; its answer goes
    unused."""
    return _place_all(
        [_Span(attributes, held, trace_id) for attributes, held, trace_id in spans],
        uploader=uploader,
        value_bytes=value_bytes,
        deadline=deadline,
        wait=wait,
        memo=memo,
    )


def _place_all(
    placements: list[_Span],
    *,
    uploader: BlobUploader,
    value_bytes: int,
    deadline: float,
    wait: Callable[[float], bool],
    memo: MediaDigestMemo | None,
) -> tuple[list[dict[str, Any]], Tally]:
    """The records' candidates placed on the shared upload threads (see ``place_spans``)."""
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
    # Placement threads started and still running, and how many of them wait for an upload
    # another reference started.
    threads = {"running": 0, "sharing": 0}

    def start() -> None:
        """Starts a placement thread. Called under the lock."""
        threads["running"] += 1
        Thread(target=work, name="hue-upload", daemon=True).start()

    @contextmanager
    def sharing() -> Iterator[None]:
        with lock:
            threads["sharing"] += 1
            if (
                not closed[0]
                and pending
                and threads["running"] - threads["sharing"] < UPLOAD_CONCURRENCY
                and threads["running"] < _MAX_PLACEMENT_THREADS
            ):
                start()
        try:
            yield
        finally:
            with lock:
                threads["sharing"] -= 1

    context = _Context(uploader, value_bytes, deadline, wait, memo or MediaDigestMemo(), sharing)

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
                        results[(number, index)] = _fallback(
                            key,
                            value,
                            value_bytes,
                            key in placements[number].inspected,
                            placements[number].log,
                        )
                    if len(results) == total:
                        done.set()
        finally:
            with lock:
                threads["running"] -= 1
            detach(token)

    if total:
        with lock:
            for _ in range(min(UPLOAD_CONCURRENCY, total)):
                start()
        done.wait(max(0.0, deadline - monotonic()) + 1)
    with lock:
        closed[0] = True
        placed = dict(results)
        # The context refers to the threads' work through ``sharing``: break that cycle so the
        # held values go as soon as the threads do, without waiting for a collection.
        context.sharing = nullcontext
    tally = Tally()
    attributes: list[dict[str, Any]] = []
    for number, span in enumerate(placements):
        for _ in range(span.cut):
            tally.fallback("unsupported" if uploader.unsupported() else "budget", span.trace_id)
        result_attributes = dict(span.attributes)
        listed: list[str] = []
        entries: list[tuple[tuple[int, int], str]] = []
        for index, (key, value) in enumerate(span.candidates):
            result = placed.get((number, index)) or _fallback(
                key, value, value_bytes, key in span.inspected, span.log
            )
            if span.log and key == "body" and index == 0:
                span.placed_body = result.value
            elif not isinstance(value, ExplicitFile):
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


def place_logs(
    logs: list[tuple[Mapping[str, Any], Held, str, Any]],
    *,
    uploader: BlobUploader,
    value_bytes: int,
    deadline: float,
    wait: Callable[[float], bool],
    memo: MediaDigestMemo | None = None,
) -> tuple[list[dict[str, Any]], list[Any], Tally]:
    """Each log record's attributes and body with the media its copy held placed: each file
    uploaded under the log record's trace and listed in its own ``hue.blobs``, keyed
    ``<attribute>#<pointer>`` or ``body#<pointer>``, or kept inline when it is not uploaded (a
    message's file over the inline limit as its digest); what is left over the inline limit is cut
    as before. The attachments a body holds (``held.files``, keyed ``body#<pointer>``) upload in
    the same placement, on the same threads and deadline. ``logs`` holds each record's
    attributes, held values, trace id and body (a JSON-like copy, with the strings its copy held
    whole restored)."""
    placements = [
        _Span(attributes, held, trace_id, log=True, body=body)
        for attributes, held, trace_id, body in logs
    ]
    attributes, tally = _place_all(
        placements,
        uploader=uploader,
        value_bytes=value_bytes,
        deadline=deadline,
        wait=wait,
        memo=memo,
    )
    return attributes, [placement.placed_body for placement in placements], tally
