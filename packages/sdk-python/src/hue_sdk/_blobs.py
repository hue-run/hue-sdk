"""Large values and binary media, uploaded apart from their span.

Export places each value in its final form (text keeps a 16 KiB prefix, binary media keeps digest
metadata on its part), lists it in ``hue.blobs`` once its upload is accepted, and sends the record
without waiting: background threads reserve, PUT and complete each upload, retrying transient
failures. An upload that then fails leaves its entry, which Hue reads as missing; one refused
before export keeps inline fallback or file metadata. Both are reported as warnings and counted.
Mirrors the TypeScript SDK's ``blobs.ts``.
"""

from __future__ import annotations

import hashlib
import io
import ipaddress
import json
import os
import random
import re
import sys
import weakref
from collections import OrderedDict, deque
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field, replace
from heapq import heappop, heappush
from threading import Condition, Event, Lock, Thread, Timer, local
from time import monotonic, time
from typing import Any
from urllib.parse import urlsplit

import requests
from opentelemetry.context import attach, detach

from ._attachment import PathFile, file_source
from ._inline_files import (
    INLINE_FILE_LIMIT,
    INLINE_FILE_TEXT_PER_RECORD,
    MAX_INLINE_FILE_TEXT,
    InlineFile,
    InlineFilePart,
    MediaDigestMemo,
    MediaValue,
    _well_formed,
    digest_part,
    hash_inline_files_counted,
    is_message_key,
    is_text_media_type,
    keeps_prefix,
    literal_keys,
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
from ._large_media import (
    ByteSource,
    JoinedText,
    LargeMediaValue,
    LongFileBytes,
    LongText,
    long_file_bytes,
    long_head,
    placed_large_text,
    read_large_media_text,
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
# from ``max_queue_bytes`` (as the interpreter holds them), held from admission until the uploads
# keeping them settle. A value the budget cannot hold, even once the uploads no worker has started
# gave way to it, is cut when it is queued, as before uploads existed; a single value larger than
# the whole budget is held while nothing else is.
MAX_HELD_BLOB_BYTES = 128 * 1024 * 1024
# Background upload threads per client, shared by both signals.
UPLOAD_CONCURRENCY = 4
# Each reservation, PUT and completion is tried this many times on no answer, 408, 429 or 5xx.
UPLOAD_ATTEMPTS = 3
# The longest Retry-After an upload request waits before it is tried again.
MAX_RETRY_AFTER_SECONDS = 60.0
# Uploads accepted and not yet settled, one per (trace, sha256); more fall back at export.
MAX_PENDING_UPLOADS = 1024
# How long shutdown gives pending uploads after the processors stopped, before abandoning them.
SHUTDOWN_UPLOAD_SECONDS = 30.0
_MAX_JSON_RESPONSE_BYTES = 64 * 1024
_MAX_ERROR_RESPONSE_BYTES = 4096
# Text is encoded to UTF-8 a slice at a time to hash and upload it: no full copy is held.
_TEXT_CHUNK_CHARS = 1 << 20
# The base of the jittered backoff between attempts: 0-1 s, then 0-2 s.
_RETRY_DELAY_SECONDS = 1.0
# The (trace, sha256) identities this client stored, answered without a request.
_STORED_LIMIT = 1024
# Settled uploads are counted at most this often while others are pending.
_REPORT_INTERVAL_SECONDS = 1.0
# The slowest link a PUT attempt allows for before its own deadline.
_MIN_PUT_BYTES_PER_SECOND = 1 << 20


def upload_budget_seconds(timeout: float) -> float:
    """How long one export may spend hashing values it reads in place, and the shortest
    deadline of one PUT attempt."""
    return timeout * 6


def put_seconds(size: int, timeout: float) -> float:
    """The deadline of one PUT attempt of ``size`` bytes: six export timeouts, or one second per
    MiB, whichever is longer."""
    return max(upload_budget_seconds(timeout), size / _MIN_PUT_BYTES_PER_SECOND)


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
    "not_uploaded": (
        "Content listed in hue.blobs could not be uploaded after its record was exported; "
        "Hue reads its reference as missing"
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
    """A key Hue accepts: 1 to 256 UTF-16 code units, as Hue and the TypeScript SDK count them,
    with no C0 control or DEL."""
    return (
        isinstance(key, str)
        and 1 <= utf16_size(key, _MAX_BLOB_KEY_LENGTH) <= _MAX_BLOB_KEY_LENGTH
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
    """What an uploaded value keeps inline: its first 16 KiB, text cut back to a character (a
    lone surrogate as U+FFFD, as the upload carries it)."""
    if isinstance(value, bytes):
        return value[:BLOB_PREFIX_BYTES]
    return well_formed_cut(value, BLOB_PREFIX_BYTES)


def well_formed_cut(value: str, limit: int) -> str:
    """``value`` cut to at most ``limit`` UTF-8 bytes as JavaScript cuts it: a lone surrogate is
    U+FFFD, and ``limit`` characters hold at least ``limit`` bytes."""
    return cut_utf8(_well_formed(value[: limit + 1]), limit)


def utf8_slices(text: str, start: int = 0, end: int | None = None) -> Iterator[bytes]:
    """``text``'s UTF-8 as JavaScript encodes it (a lone surrogate as U+FFFD), a slice at a time,
    never between the two halves of a surrogate pair."""
    stop_at = len(text) if end is None else end
    at = start
    while at < stop_at:
        stop = min(stop_at, at + _TEXT_CHUNK_CHARS)
        if stop < stop_at and "\ud800" <= text[stop - 1] <= "\udbff":
            stop -= 1
        yield _well_formed(text[at:stop]).encode("utf-8")
        at = stop


def _chunks(value: str | bytes | ByteSource) -> Iterator[bytes | memoryview]:
    """The bytes an upload of ``value`` carries, a slice at a time: bytes as views of their own
    buffer, never copied whole, a source as it reads them, and text as JavaScript encodes it, a
    lone surrogate as U+FFFD."""
    if isinstance(value, ByteSource):
        yield from value.chunks()
        return
    if isinstance(value, bytes):
        view = memoryview(value)
        for start in range(0, len(value), _TEXT_CHUNK_CHARS):
            yield view[start : start + _TEXT_CHUNK_CHARS]
        return
    yield from utf8_slices(value)


def digest_of(value: str | bytes | ByteSource, deadline: float = float("inf")) -> tuple[str, int]:
    """The SHA-256 (lowercase hex) and byte size of what an upload of ``value`` carries, a lone
    surrogate as U+FFFD; past ``deadline``, ``TimeoutError`` is raised rather than read on."""
    if isinstance(value, bytes):
        return hashlib.sha256(value).hexdigest(), len(value)
    digest = hashlib.sha256()
    size = 0
    for chunk in _chunks(value):
        digest.update(chunk)
        size += len(chunk)
        if monotonic() >= deadline:
            raise TimeoutError("The upload ran out of time.")
    return digest.hexdigest(), size


class _Body(io.RawIOBase):
    """A value's upload body, read a slice at a time, its length known before it is sent. Past
    ``deadline``, or once ``stopped`` answers true, a read raises: the upload ends there instead
    of holding the value and an upload slot after its export has moved on."""

    def __init__(
        self,
        value: str | bytes | ByteSource,
        size: int,
        deadline: float,
        stopped: Callable[[], bool],
    ) -> None:
        super().__init__()
        self._chunks = _chunks(value)
        self._size = size
        self._pending: bytes | memoryview = b""
        self._offset = 0
        self._deadline = deadline
        self._stopped = stopped
        self._position = 0
        self._complete = False

    @property
    def complete(self) -> bool:
        """Whether the whole body was read: its every byte, and the source to its end."""
        return self._complete

    def close(self) -> None:
        # The source is let go now, a file it reads closed with it, not when a collection finds
        # the body: a stalled or cut-off upload holds no file open.
        if not self.closed:
            chunks = self._chunks
            self._chunks = iter(())
            self._pending = b""
            close = getattr(chunks, "close", None)
            if close is not None:
                close()
        super().close()

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
        result = bytes(self._pending[self._offset : self._offset + size])
        self._offset += len(result)
        self._position += len(result)
        if self._position >= self._size:
            # Every byte was read: the source has nothing left to read or check.
            self._complete = self._position == self._size
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

    def __init__(
        self,
        limit: int = MAX_HELD_BLOB_BYTES,
        make_room: Callable[[int], bool] | None = None,
    ) -> None:
        self._lock = Lock()
        self._limit = limit
        self._held = 0
        # Gives up uploads no worker has started to release at least the bytes it is asked for
        # (``BlobUploader.make_room``).
        self._make_room = make_room

    def reserve(self, size: int, already: int = 0, *, make_room: bool = False) -> bool:
        """Charge ``size`` more for a record that holds ``already``: within the budget, or one
        value larger than it while nothing else is held. With ``make_room``, for a value that
        would otherwise be cut into its record's queue or an attachment that would otherwise be
        refused, uploads earlier records listed that no worker has started are given up while
        the budget is short: uploads queued behind a stalled receiver never turn a later
        record's value back into the inline cut that can overflow the queue, nor refuse a later
        file. Never called with a lock ``make_room`` takes held."""
        if self._charge(size, already):
            return True
        if not make_room or self._make_room is None or size + already > self._limit:
            return False
        with self._lock:
            shortfall = self._held + size - self._limit
        return self._make_room(shortfall) and self._charge(size, already)

    def _charge(self, size: int, already: int) -> bool:
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
    inline files. The budget is released once: by ``release()`` when the record is lost or no
    longer referenced, or by the ``UploadGroup`` export placed it with, once its uploads settle.
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
    # The JSON pointers of the body's strings its copy cut and did not hold: never read as files.
    body_cut: set[str] = field(default_factory=set)
    # The span's own values held whole past the inspection bounds: export reads their media in
    # place (``read_large_media_text``).
    large: set[str] = field(default_factory=set)
    # The record's charge once export placed it, kept until its uploads settle.
    group: UploadGroup | None = None
    _released: bool = False

    def release(self) -> None:
        if not self._released and self.budget is not None:
            self._released = True
            self.budget.release(self.size)


class UploadGroup:
    """One record's held-value charge, released once its placement is sealed and every upload
    keeping its bytes has settled."""

    __slots__ = ("_lock", "_budget", "_size", "_pending")

    def __init__(self, budget: HeldValues | None = None, size: int = 0) -> None:
        self._lock = Lock()
        # One pending for the placement itself, until ``seal()``.
        self._budget, self._size, self._pending = budget, size, 1

    @classmethod
    def adopt(cls, held: Held) -> UploadGroup:
        """Takes over the record's charge: its finalizer, discard and release become no-ops."""
        size = 0 if held._released else held.size
        held._released = True
        return cls(held.budget, size)

    def add(self) -> None:
        with self._lock:
            self._pending += 1

    def charge(self, size: int) -> bool:
        """Charges ``size`` more for bytes an accepted upload keeps that the record's admission
        did not charge, released with the rest: False when the budget cannot hold them. Called
        before ``seal()``."""
        if self._budget is None:
            return True
        with self._lock:
            if not self._budget.reserve(size, self._size):
                return False
            self._size += size
            return True

    def releasable(self, uploads: int) -> int:
        """What settling ``uploads`` of its pending uploads releases: the whole charge when they
        are all that keeps it (the placement sealed), nothing otherwise."""
        with self._lock:
            return self._size if self._pending == uploads else 0

    def done(self) -> None:
        with self._lock:
            self._pending -= 1
            if self._pending or not self._size:
                return
            size, self._size = self._size, 0
        if self._budget is not None:
            self._budget.release(size)

    # The placement is finished: the charge goes once the uploads keeping its bytes settle.
    seal = done


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
    # A file given by path over the in-memory limit (``data`` empty): read again from disk when it
    # is uploaded.
    on_disk: PathFile | None = None

    def body(self) -> bytes | ByteSource:
        """What its upload carries: its bytes, or its file read from disk as it is sent."""
        return file_source(self.on_disk) if self.on_disk is not None else self.data

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
        self.held = HeldValues(make_room=self.uploader.make_room)
        self.timeout = timeout
        self.memo = MediaDigestMemo()
        self._lock = Lock()
        self._staged: dict[tuple[int, int], _Staged] = {}
        self._closed = False
        # Attachments placed in a log record's body, from ``log_inference`` to its admission.
        self._pending_log = local()

    def grace_deadline(self) -> float:
        """The end of shutdown's wait for pending uploads, which begins once its processors
        stopped: ``SHUTDOWN_UPLOAD_SECONDS`` from now."""
        return monotonic() + SHUTDOWN_UPLOAD_SECONDS

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
            if len(held.files) >= MAX_BLOB_ENTRIES or not self.held.reserve(
                size, held.size, make_room=True
            ):
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
                if len(held.files) >= MAX_BLOB_ENTRIES or not self.held.reserve(
                    size, held.size, make_room=True
                ):
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
        if not self.held.reserve(size, make_room=True):
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
    # The value's own source no longer held its bytes (a file that changed since it was
    # recorded), which says nothing of another reference's bytes.
    changed: bool = False
    # Its PUT just stored it: Hue is to be told so (``_confirm``).
    complete: bool = False


@dataclass(eq=False)
class _Job:
    """One accepted upload of a (trace, sha256), shared by every reference to it while pending."""

    seq: int
    trace_id: str
    key: str
    content_type: str
    digest: tuple[str, int]
    # The bytes to send: the first reference's, and, when that is a file read from disk, one
    # other reference's, tried only if the file changed since it was recorded.
    sources: list[str | bytes | ByteSource]
    from_disk: bool
    # The charges kept while a source is held, and the references by signal.
    groups: list[UploadGroup]
    signals: dict[str, int]
    # Waiting in the queue for a worker; once taken, until when its worker waits out a retry.
    queued: bool = True
    resting_until: float = 0.0


def _valid_trace(trace_id: str) -> bool:
    return bool(_TRACE_ID.match(trace_id)) and trace_id != "0" * 32


def _invalid(trace_id: str, key: str, content_type: str, size: int) -> str | None:
    """Why a value can never be uploaded as given, without trying, if it cannot."""
    if size <= 0:
        return "failed"
    if size > MAX_BLOB_BYTES:
        return "too_large"
    if (
        not _is_blob_key(key)
        or not is_blob_content_type(content_type)
        or not _valid_trace(trace_id)
    ):
        return "failed"
    return None


def _retried(status: int) -> bool:
    """Whether an upload request answered ``status`` is tried again."""
    return status in (408, 429) or status >= 500


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
    """Uploads values to Hue in the background. Export accepts each upload (``submit``), which
    decides any refusal at once, without a request, and lists its reference; up to
    ``UPLOAD_CONCURRENCY`` daemon threads then reserve it with ``POST /api/v1/otlp/blobs``, PUT
    its bytes to the presigned URL Hue answers (skipped when Hue already stores the value), and
    complete it. Each request is tried up to ``UPLOAD_ATTEMPTS`` times on no answer, 408, 429 or
    5xx, waiting its Retry-After (at most ``MAX_RETRY_AFTER_SECONDS``) or a jittered backoff;
    every request has a deadline and none follows a redirect. An upload settles once its bytes
    are stored: its completion, for Hue's accounting only, is retried with no bytes, charge or
    worker held meanwhile. A receiver without the route (a 404 without Hue's JSON error, a 405 or
    501, or a 200 that is no reservation) is remembered for the life of the client: values
    queued after its answer are cut when they are queued rather than listed for an upload that
    would never be stored, so only records exported before it list such entries. An upload that
    fails after its record was exported leaves its reference, which Hue reads as missing, and
    counts as not uploaded; a later reference to the same bytes uploads them again."""

    def __init__(self, base_url: str, headers: Mapping[str, str], timeout: float) -> None:
        self._base_url = base_url
        self._headers = {**headers, "Content-Type": "application/json"}
        self._timeout = timeout
        self._pid = os.getpid()
        self._lock = Lock()
        self._wake = Condition(self._lock)
        self._settled = Condition(self._lock)
        # Set by ``close()``: every wait between attempts ends at once.
        self._stop = Event()
        # A reservation found the receiver without the upload route: for the client's life.
        self._unsupported = False
        self._closed = False
        # Accepted uploads: queued for a worker, by identity while pending, and by sequence
        # (oldest first) until settled.
        self._queue: deque[_Job] = deque()
        self._jobs: dict[tuple[str, str], _Job] = {}
        self._pending: dict[int, _Job] = {}
        # Completions to try again, ``(when, attempt, trace_id, sha256)`` soonest first, which a
        # worker with no upload to start sends once due.
        self._retries: list[tuple[float, int, str, str]] = []
        # The job each worker thread is uploading.
        self._local = local()
        # Identities this client stored, never their bytes.
        self._stored: OrderedDict[tuple[str, str], None] = OrderedDict()
        self._sequence = 0
        self._workers = 0
        self._running = 0
        self._queue_limit = MAX_PENDING_UPLOADS
        # Where settled uploads are counted, by signal: the span exporter's ``_report_uploads``.
        self.report: Callable[[Tally, str], None] | None = None
        self._unreported: dict[str, Tally] = {}
        self._reported_at = 0.0
        # A delivery of the counts the interval held back is scheduled.
        self._report_due = False
        self._report_lock = Lock()

    def available(self) -> bool:
        """Whether a value over the inline limit is worth holding whole for upload now."""
        with self._lock:
            return not self._closed and not self._unsupported

    def unsupported(self) -> bool:
        with self._lock:
            return self._unsupported

    def refusal(self) -> str | None:
        """Why a value cannot be uploaded right now without trying, if it cannot."""
        with self._lock:
            if self._closed:
                return "failed"
            if self._unsupported:
                return "unsupported"
            return None

    def submit(
        self,
        trace_id: str,
        key: str,
        body: str | bytes | ByteSource,
        content_type: str,
        digest: tuple[str, int],
        group: UploadGroup,
        signal: str = "traces",
        *,
        from_disk: bool = False,
        uncharged: int = 0,
    ) -> _Outcome:
        """Accepts one upload for the workers; the caller lists its reference now. A refusal is
        decided here, without a request or a wait, and the caller keeps its fallback. Another
        reference to bytes the trace is already uploading shares that upload. ``uncharged`` is
        what keeping ``body`` costs beyond what ``group`` was charged: charged to it once the
        upload keeps it, or the upload is refused for the budget."""
        # A forked child never waits on a lock a parent thread may hold.
        if os.getpid() != self._pid:
            return _Outcome(False, "failed")
        sha256, size = digest
        invalid = _invalid(trace_id, key, content_type, size)
        if invalid is not None:
            return _Outcome(False, invalid)
        identity = (trace_id, sha256)
        with self._lock:
            if self._closed:
                return _Outcome(False, "failed")
            if self._unsupported:
                return _Outcome(False, "unsupported")
            if identity in self._stored:
                self._stored.move_to_end(identity)
                self._tally(signal).uploaded += 1
                return _Outcome(True, content_type=content_type)
            job = self._jobs.get(identity)
            if job is not None:
                job.signals[signal] = job.signals.get(signal, 0) + 1
                if (
                    job.from_disk
                    and len(job.sources) == 1
                    and body is not job.sources[0]
                    and (not uncharged or group.charge(uncharged))
                ):
                    # Tried only if the file changed since it was recorded.
                    job.sources.append(body)
                    group.add()
                    job.groups.append(group)
                return _Outcome(True, content_type=content_type)
            if len(self._jobs) >= self._queue_limit or (uncharged and not group.charge(uncharged)):
                return _Outcome(False, "budget")
            if self._workers < UPLOAD_CONCURRENCY and self._workers - self._running <= len(
                self._queue
            ):
                try:
                    Thread(target=self._work, name="hue-upload", daemon=True).start()
                    self._workers += 1
                except RuntimeError:
                    # The interpreter is finalizing: without a worker, nothing would upload it.
                    if not self._workers:
                        return _Outcome(False, "failed")
            self._sequence += 1
            job = _Job(
                self._sequence,
                trace_id,
                key,
                content_type,
                digest,
                [body],
                from_disk,
                [group],
                {signal: 1},
            )
            group.add()
            self._jobs[identity] = job
            self._pending[job.seq] = job
            self._queue.append(job)
            self._wake.notify()
        return _Outcome(True, content_type=content_type)

    def _tally(self, signal: str) -> Tally:
        """The counts not yet reported for ``signal``. Called under the lock."""
        return self._unreported.setdefault(signal, Tally())

    def _work(self) -> None:
        # Uploads are the SDK's own export traffic: an instrumentation must not trace them.
        token = attach(export_context())
        try:
            while True:
                with self._lock:
                    job = self._next()
                    if job is None:
                        return
                    self._running += 1
                if not isinstance(job, _Job):
                    try:
                        self._confirm(*job)
                    except Exception:
                        pass
                    finally:
                        with self._lock:
                            self._running -= 1
                    continue
                self._local.job = job
                try:
                    outcome = self._upload(job)
                except Exception:
                    outcome = _Outcome(False, "failed")
                finally:
                    self._local.job = None
                self._settle(job, outcome, started=True)
        finally:
            with self._lock:
                self._workers -= 1
            try:
                detach(token)
            except Exception:
                pass

    def _next(self) -> _Job | tuple[str, str, int] | None:
        """A worker's next upload, else the next completion due again (its trace, sha256 and
        attempt), waiting for either; None once the uploader is closed. Called under the lock."""
        while not self._closed:
            if self._queue:
                job = self._queue.popleft()
                job.queued = False
                if self._retries:
                    # Another idle worker keeps the time of the completions due again.
                    self._wake.notify()
                return job
            if self._retries and self._retries[0][0] <= monotonic():
                _, attempt, trace_id, sha256 = heappop(self._retries)
                return trace_id, sha256, attempt
            self._wake.wait(self._retries[0][0] - monotonic() if self._retries else None)
        return None

    def _upload(self, job: _Job) -> _Outcome:
        """One job's upload: its first source, then, if that file changed since it was recorded,
        the other reference's bytes."""
        outcome = _Outcome(False, "failed")
        for index in range(2):
            with self._lock:
                if index >= len(job.sources):
                    return outcome
                source = job.sources[index]
            outcome = self.store(job.trace_id, job.key, source, job.content_type, job.digest)
            if not outcome.changed:
                return outcome
        return outcome

    def _settle(self, job: _Job, outcome: _Outcome, *, started: bool) -> None:
        """Counts a job's references and lets go of its bytes and charges; tells Hue once of a
        value its PUT just stored, any retry left to an idle worker; then wakes the waiters: a
        waiter finds the counts and the released budget in place."""
        identity = (job.trace_id, job.digest[0])
        with self._lock:
            # No reference shares this job from here on.
            if self._jobs.get(identity) is job:
                del self._jobs[identity]
            groups, job.groups, job.sources = job.groups, [], []
            if outcome.ok and not self._closed:
                self._stored[identity] = None
                while len(self._stored) > _STORED_LIMIT:
                    self._stored.popitem(last=False)
            for signal, count in job.signals.items():
                if outcome.ok:
                    self._tally(signal).uploaded += count
                else:
                    self._tally(signal).fallback("not_uploaded", job.trace_id, count)
        for group in groups:
            group.done()
        if outcome.complete:
            try:
                self._confirm(job.trace_id, job.digest[0])
            except Exception:
                pass
        with self._lock:
            if started:
                self._running -= 1
            self._pending.pop(job.seq, None)
            self._settled.notify_all()
        self._deliver_reports(force=False)

    def make_room(self, shortfall: int) -> bool:
        """Gives up the oldest uploads no worker has started until the records whose charges
        they keep release at least ``shortfall`` bytes of the held-value budget, each counted as
        not uploaded: its record was exported listing it, and Hue reads that entry as missing.
        A value being queued is worth more than an upload an earlier record listed, which a
        stalled receiver would keep charged for its every retry. Gives up none, and answers
        False, when giving up all of them would not release that much."""
        if os.getpid() != self._pid:
            return False
        with self._lock:
            # A record's charge is released when the last upload keeping it settles: giving up
            # queued uploads releases the charges of records none of whose uploads has started.
            queued: dict[UploadGroup, int] = {}
            for job in self._queue:
                for group in job.groups:
                    queued[group] = queued.get(group, 0) + 1
            left = dict(queued)
            released = count = 0
            for job in self._queue:
                if released >= shortfall:
                    break
                count += 1
                for group in job.groups:
                    left[group] -= 1
                    if not left[group]:
                        released += group.releasable(queued[group])
            if released < shortfall:
                return False
            given_up = [self._queue.popleft() for _ in range(count)]
            for job in given_up:
                job.queued = False
                # No later reference shares an upload given up.
                identity = (job.trace_id, job.digest[0])
                if self._jobs.get(identity) is job:
                    del self._jobs[identity]
        for job in given_up:
            self._settle(job, _Outcome(False, "failed"), started=False)
        return True

    def _deliver_reports(self, *, force: bool) -> None:
        """Hands the counts of settled uploads to ``report``: when nothing is pending, at most
        once a second otherwise, and always when ``force``d. Counts the interval holds back are
        delivered when it ends, whether or not another upload settles by then. A delivery in
        progress is waited for, so a waiter that forces one finds every settled upload
        counted."""
        schedule = 0.0
        with self._report_lock:
            with self._lock:
                if not self._unreported:
                    return
                later = (
                    0.0
                    if force or not self._pending
                    else self._reported_at + _REPORT_INTERVAL_SECONDS - monotonic()
                )
                tallies: dict[str, Tally] = {}
                if later <= 0:
                    tallies, self._unreported = self._unreported, {}
                    self._reported_at = monotonic()
                elif not self._report_due:
                    self._report_due, schedule = True, later
            report = self.report
            if report is not None:
                for signal, tally in tallies.items():
                    try:
                        report(tally, signal)
                    except Exception:
                        pass
        if schedule:
            self._report_later(schedule)

    def _report_later(self, seconds: float) -> None:
        """Delivers the counts held back once ``seconds`` have passed."""

        def deliver() -> None:
            with self._lock:
                self._report_due = False
            self._deliver_reports(force=False)

        try:
            timer = Timer(seconds, deliver)
            timer.daemon = True
            timer.start()
        except RuntimeError:
            # The interpreter is finalizing: the next settle or flush delivers them.
            with self._lock:
                self._report_due = False

    def wait_idle(self, deadline: float) -> bool:
        """Waits until every upload accepted so far has settled, stored or not, and is counted;
        False when ``deadline`` came first, or as soon as none of those pending can be stored
        before it (``_stalled``), so a provider's processors after Hue's keep the rest of a
        shared deadline. Uploads accepted meanwhile are not waited for."""
        if os.getpid() != self._pid:
            return True
        with self._lock:
            through = self._sequence
            while self._pending and next(iter(self._pending)) <= through:
                remaining = deadline - monotonic()
                if remaining <= 0 or self._stalled(through, deadline):
                    break
                self._settled.wait(remaining)
            idle = not self._pending or next(iter(self._pending)) > through
        self._deliver_reports(force=True)
        return idle

    def _stalled(self, through: int, deadline: float) -> bool:
        """Whether no pending upload accepted through ``through`` can be stored before
        ``deadline``: each one a worker took waits out a retry past it, and each one queued
        waits for a worker while every worker does. Called under the lock."""
        resting = sum(
            not job.queued and job.resting_until >= deadline for job in self._pending.values()
        )
        for job in self._pending.values():
            if job.seq > through:
                break
            if job.queued:
                if resting < UPLOAD_CONCURRENCY:
                    return False
            elif job.resting_until < deadline:
                return False
        return True

    def close(self) -> None:
        """Stops the uploads: queued ones are abandoned and counted as not uploaded at once, and
        running ones at their next read, request or wait."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._stop.set()
            queued = list(self._queue)
            self._queue.clear()
            for job in queued:
                job.queued = False
            self._retries.clear()
            self._stored.clear()
            self._wake.notify_all()
        for job in queued:
            self._settle(job, _Outcome(False, "failed"), started=False)
        self._deliver_reports(force=True)

    def _wait(self, seconds: float) -> bool:
        """Waits between attempts; False once the uploader is closed. A worker's job is marked
        resting until then, and the flushes waiting for it look again (``_stalled``)."""
        job = getattr(self._local, "job", None)
        if job is None:
            return not self._stop.wait(seconds)
        with self._lock:
            job.resting_until = monotonic() + seconds
            self._settled.notify_all()
        try:
            return not self._stop.wait(seconds)
        finally:
            with self._lock:
                job.resting_until = 0.0

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
        value: str | bytes | ByteSource,
        content_type: str,
        digest: tuple[str, int],
    ) -> _Outcome:
        """Stores ``value`` under ``key`` of the trace on the calling thread: reserved and
        uploaded unless Hue already holds it, each request tried up to ``UPLOAD_ATTEMPTS`` times.
        A value its PUT stored is answered ``complete``: the workers, which run it for each
        accepted upload, then complete it (``_confirm``) once they let go of its bytes."""
        sha256, size = digest
        refused = _invalid(trace_id, key, content_type, size) or self.refusal()
        if refused is not None:
            return _Outcome(False, refused)
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
        reservation = self._reserve(body, size)
        presigns, failures = 1, 0
        while grant := reservation.get("grant"):
            state, reply = self._put(grant, value, size)
            if state == "stored":
                break
            if state == "changed":
                return _Outcome(False, "failed", changed=True)
            if state == "transient":
                failures += 1
                if failures >= UPLOAD_ATTEMPTS or not self._wait(_backoff(failures - 1, reply)):
                    return _Outcome(False, "failed")
                if time() < grant["expires_at"]:
                    continue
            elif state != "expired" and time() < grant["expires_at"]:
                return _Outcome(False, "failed")
            # The URL expired: reserved again once.
            if presigns >= 2:
                return _Outcome(False, "failed")
            presigns += 1
            reservation = self._reserve(body, size)
        if "fallback" in reservation:
            return _Outcome(False, reservation["fallback"])
        return _Outcome(True, content_type=content_type, complete=bool(reservation.get("grant")))

    def _reserve(self, body: str, size: int) -> dict[str, Any]:
        """Reserves the value: Hue answers that it holds it already, or a presigned PUT. No
        answer, a 408, 429 or 5xx is tried again; any other refusal is final."""
        url = f"{self._base_url}/api/v1/otlp/blobs"
        for attempt in range(UPLOAD_ATTEMPTS):
            reply = self._request(
                "POST",
                url,
                self._headers,
                body,
                monotonic() + self._timeout,
                _MAX_JSON_RESPONSE_BYTES,
            )
            if reply is not None:
                status = reply.status
                answer = _json(reply.body) if status in (200, 404, 409) else None
                # A receiver without the route answers its framework's not-found (Hue's own 404,
                # an archived project, is JSON with an ``error``), refuses the method, or answers
                # something that is no reservation at all: it is not asked again, and values are
                # cut when queued instead of listed for uploads it would never store.
                if (
                    status in (405, 501)
                    or (
                        status == 404
                        and not (isinstance(answer, dict) and isinstance(answer.get("error"), str))
                    )
                    or (
                        status == 200
                        and not (
                            isinstance(answer, dict)
                            and answer.get("status") in ("exists", "upload")
                        )
                    )
                ):
                    with self._lock:
                        self._unsupported = True
                    return {"fallback": "unsupported"}
                if status == 200 or (
                    status == 409 and isinstance(answer, dict) and answer.get("status") == "exists"
                ):
                    return self._reservation(answer, size)
                if status == 413:
                    return {"fallback": "too_large"}
                if not _retried(status):
                    return {"fallback": "failed"}
            if attempt + 1 >= UPLOAD_ATTEMPTS or not self._wait(_backoff(attempt, reply)):
                break
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

    def _put(
        self, grant: Mapping[str, Any], value: str | bytes | ByteSource, size: int
    ) -> tuple[str, _Reply | None]:
        """The PUT of the value's bytes, with exactly the headers Hue signed, within its own
        deadline (``put_seconds``): an attempt that runs out of it is final. A source that no
        longer holds its bytes (a file changed since it was recorded) ends the request before its
        body is complete, and fails the value without a retry."""
        deadline = monotonic() + put_seconds(size, self._timeout)
        body = _Body(value, size, deadline, lambda: self._closed)
        try:
            reply = self._request(
                "PUT", grant["url"], grant["headers"], body, deadline, _MAX_ERROR_RESPONSE_BYTES
            )
        finally:
            complete = body.complete
            body.close()
        if isinstance(value, ByteSource) and value.changed:
            return "changed", reply
        if reply is None:
            return ("failed" if self._closed or monotonic() >= deadline else "transient"), None
        # 412: the object exists already (another upload of the same value won). A success
        # answered before the whole body was sent stores nothing that was sent.
        if reply.status == 412:
            return "stored", reply
        if 200 <= reply.status < 300:
            return ("stored" if complete else "failed"), reply
        if reply.status == 403:
            return ("expired" if b"Request has expired" in reply.body else "failed"), reply
        if _retried(reply.status):
            return "transient", reply
        return "failed", reply

    def _confirm(self, trace_id: str, sha256: str, attempt: int = 0) -> None:
        """Confirms a stored value, for Hue's accounting only: a value is read whether or not it
        was completed, so the upload is stored whatever the answer. No answer, a 408, 429 or 5xx
        is tried again, up to ``UPLOAD_ATTEMPTS`` times in all, once its Retry-After or backoff
        has passed, by a worker with no upload to start: nothing waits for it meanwhile."""
        body = json.dumps({"traceId": trace_id, "sha256": sha256}, separators=(",", ":"))
        reply = self._request(
            "POST",
            f"{self._base_url}/api/v1/otlp/blobs/complete",
            self._headers,
            body,
            monotonic() + self._timeout,
            _MAX_JSON_RESPONSE_BYTES,
        )
        if (reply is not None and not _retried(reply.status)) or attempt + 1 >= UPLOAD_ATTEMPTS:
            return
        with self._lock:
            if not self._closed and len(self._retries) < MAX_PENDING_UPLOADS:
                due = monotonic() + _backoff(attempt, reply)
                heappush(self._retries, (due, attempt + 1, trace_id, sha256))
                self._wake.notify()


def parsedate_iso(value: str) -> float:
    """An ISO 8601 timestamp (``2026-10-05T12:15:00.000Z``) as seconds since the epoch."""
    from datetime import datetime

    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def _retry_after_seconds(reply: _Reply) -> float | None:
    value = reply.headers.get("Retry-After")
    if value is not None:
        try:
            return max(0.0, float(value))
        except ValueError:
            pass
    return None


def _backoff(attempt: int, reply: _Reply | None) -> float:
    """The wait before attempt ``attempt + 1``: the answer's Retry-After, at most
    ``MAX_RETRY_AFTER_SECONDS``, or else a full-jitter exponential backoff."""
    after = _retry_after_seconds(reply) if reply is not None else None
    if after is not None:
        return min(after, MAX_RETRY_AFTER_SECONDS)
    return random.uniform(0.0, _RETRY_DELAY_SECONDS * 2**attempt)


def _json(body: bytes) -> Any:
    try:
        return json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


@dataclass
class Tally:
    """Uploads and fallbacks to report: an export's refusals, or the uploads settled since the
    last report."""

    uploaded: int = 0
    fallbacks: dict[str, tuple[int, set[str]]] = field(default_factory=dict)

    def fallback(self, reason: str, trace_id: str, count: int = 1) -> None:
        total, traces = self.fallbacks.get(reason, (0, set()))
        traces.add(trace_id)
        self.fallbacks[reason] = (total + count, traces)


@dataclass
class _Result:
    """Where one candidate value was placed, and what its placement fell back."""

    value: Any
    listed: bool = False
    entries: list[tuple[tuple[int, int], str]] = field(default_factory=list)
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
        # The record's charge, kept while its accepted uploads hold its bytes.
        self.group = held.group or UploadGroup()
        self.signal = "logs" if log else "traces"
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
            # content, as an attribute counts by its text. The upload threads place them in a copy
            # of the body, so the body itself stays intact for the fallback.
            try:
                self.body_media = media_in(_containers_copied(body))
            except (ValueError, RecursionError):
                self.body_media = None
            for file in self.body_media.files if self.body_media else ():
                # A string the queue cut holds only the start of its file: it stays as cut.
                if file.pointer in held.body_cut:
                    continue
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
        # allowance, its body's files first. A span's values admission held whole past the
        # inspection bounds are read in place.
        self.inspected: set[str] = set(() if log else held.inspected or ())
        self.large: set[str] = set() if log else set(held.large)
        literal = literal_keys(attributes)
        for key, candidate in self.candidates:
            if (
                (log or held.inspected is None)
                and isinstance(candidate, str)
                and key not in literal
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


@dataclass
class _Context:
    uploader: BlobUploader
    value_bytes: int
    # The deadline of local hashing of values read in place.
    deadline: float
    memo: MediaDigestMemo

    def submit(
        self,
        span: _Span,
        key: str,
        body: str | bytes | ByteSource,
        content_type: str,
        digest: tuple[str, int],
        *,
        from_disk: bool = False,
        uncharged: int = 0,
    ) -> _Outcome:
        return self.uploader.submit(
            span.trace_id,
            key,
            body,
            content_type,
            digest,
            span.group,
            span.signal,
            from_disk=from_disk,
            uncharged=uncharged,
        )


def _place_files(
    span: _Span,
    index: int,
    key: str,
    files: list[InlineFilePart],
    context: _Context,
    result: _Result,
    long: Mapping[str, LongText] | None = None,
) -> bool:
    """Submit each file of a value for upload and place it; whether any was placed. A file whose
    upload is accepted is placed in its digest form (a text file in a provider part keeps a 16 KiB
    prefix). One refused keeps its bytes inline, except in a recorded message: a span's own message
    keeps its digest, and a log record's keeps the digest of a file over the inline limit, as nested
    messages kept them before log records uploaded."""
    message = is_message_key(key)
    changed = False
    for position, file in enumerate(files):
        # A file whose content is a long string is read from its place in the recorded text, a
        # slice at a time: never decoded or copied whole.
        in_place = long.get(file.content) if long else None
        decoded: InlineFile | LongFileBytes = (
            long_file_bytes(file, in_place) if in_place is not None else media_bytes(file)
        )
        body: bytes | ByteSource = (
            decoded.source if isinstance(decoded, LongFileBytes) else decoded.data
        )
        size = decoded.size if isinstance(decoded, LongFileBytes) else len(decoded.data)
        if not placeable(file, decoded, size):
            continue
        content_type = media_content_type(file, decoded)
        if not is_blob_content_type(content_type):
            content_type = (
                "application/octet-stream" if decoded.decoded else "text/plain; charset=utf-8"
            )
        textual = is_text_media_type(content_type)
        if textual and size <= INLINE_FILE_LIMIT:
            continue
        prefix = keeps_prefix(file, textual, decoded)
        part_key = f"{key}#{file.pointer if prefix else file.part_pointer}"
        has_slot = _is_blob_key(part_key) and span.slot()
        try:
            # A long file the export's hashing deadline cannot hash stays as recorded.
            digest = (
                digest_of(body, context.deadline)
                if isinstance(body, ByteSource)
                else span.held.digests.get(key, {}).get(file.pointer)
                or context.memo.digest(body, span.trace_id)
            )
        except TimeoutError:
            result.fallbacks.append("failed")
            continue
        # A log record's body file in a string its queue did not hold whole was never charged:
        # the bytes its upload keeps are charged to the record when it is accepted.
        holder = file.encoded[0].at if file.encoded else file.pointer
        uncharged = (
            held_size(body)
            if span.log
            and key == "body"
            and isinstance(body, bytes)
            and holder not in span.held.body_values
            else 0
        )
        outcome = (
            context.submit(span, part_key, body, content_type, digest, uncharged=uncharged)
            if has_slot
            else _Outcome(False, "budget")
        )
        if outcome.ok:
            if prefix:
                content = (
                    long_head(in_place, BLOB_PREFIX_BYTES + 1)
                    if in_place is not None
                    else file.content
                )
                prefix_part(file, blob_prefix(content))  # type: ignore[arg-type]
            else:
                digest_part(file, *digest)
            changed = True
            result.entries.append(
                ((index, position), _blob_entry(part_key, *digest, outcome.content_type, file.name))
            )
        else:
            if message and (not span.log or size > INLINE_FILE_LIMIT):
                digest_part(file, *digest)
                changed = True
            result.fallbacks.append(outcome.reason)
    return changed


def _upload_parts(
    span: _Span, index: int, key: str, text: str, context: _Context, result: _Result
) -> str | JoinedText:
    """Submit recognized media, keeping digests for binary and prefixes for large text. A value
    admission held whole past the inspection bounds has its long strings read in place, the JSON
    around them within the per-attribute bound."""
    media: MediaValue | None
    large: LargeMediaValue | None = None
    if key in span.large:
        if not may_inline_files(key, text):
            return text
        try:
            large = read_large_media_text(key, text)
        except (ValueError, RecursionError):
            return text
        if large is None:
            return text
        media = large.media
    else:
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
    long = large.long if large is not None else None
    if not _place_files(span, index, key, media.files, context, result, long):
        return text
    return placed_large_text(large) if large is not None else placed_media_text(media)


def _containers_copied(value: Any) -> Any:
    """A JSON-like value with its dicts and lists copied (strings are shared)."""
    if isinstance(value, dict):
        return {key: _containers_copied(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_containers_copied(item) for item in value]
    return value


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
    """One candidate placed: whole within the limit, listed for upload, or cut as before."""
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
            context.submit(
                span,
                key,
                value.body(),
                value.content_type,
                value.digest,
                from_disk=value.on_disk is not None,
            )
            if span.slot()
            else _Outcome(False, "budget")
        )
        if outcome.ok:
            result.entries.append(
                ((index, 0), _blob_entry(key, *value.digest, outcome.content_type, value.name))
            )
        else:
            result.fallbacks.append(outcome.reason)
        return result
    if isinstance(value, str):
        # Credentials leave tool definitions and recorded requests before anything is stored.
        scrubbed = scrub_tool_credentials(key, value)
        if not isinstance(scrubbed, str):
            result.value = scrubbed
            return result
        placed_parts = _upload_parts(span, index, key, scrubbed, context, result)
        if isinstance(placed_parts, JoinedText):
            return _place_joined(span, index, key, placed_parts, context, result)
        value = placed_parts
    # ASCII text is its own size; other text is measured as it is hashed, once.
    digest = None if isinstance(value, bytes) or value.isascii() else digest_of(value)
    size = digest[1] if digest else len(value)
    if size <= cap:
        result.value = value
        return result
    result.listed = True
    placed = value

    def cut() -> Any:
        return well_formed_cut(placed, cap) if isinstance(placed, str) else truncated_marker(size)

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
    outcome = context.submit(span, key, value, content_type, digest)
    if outcome.ok:
        result.value = blob_prefix(value)
        result.entries.append(
            ((index, sys.maxsize), _blob_entry(key, *digest, outcome.content_type))
        )
    else:
        result.value = cut()
        result.fallbacks.append(outcome.reason)
    return result


def _place_joined(
    span: _Span, index: int, key: str, joined: JoinedText, context: _Context, result: _Result
) -> _Result:
    """A value read in place whose files are placed, placed as ``_place`` places a string, read a
    window at a time: made one string only when it is within the cap, otherwise listed for upload
    whole (or cut) from its pieces, so a long string no file replaced is never copied twice."""
    cap = context.value_bytes
    size = joined.utf8_size()
    if size <= cap:
        result.value = joined.text()
        return result
    result.listed = True

    def cut() -> str:
        # ``cap`` characters hold at least ``cap`` bytes.
        return well_formed_cut(joined.head(cap + 1), cap)

    refused = "too_large" if size > MAX_BLOB_BYTES else None
    if refused or not span.slot():
        result.value = cut()
        result.fallbacks.append(refused or "budget")
        return result
    source = joined.source(size)
    try:
        digest = digest_of(source, context.deadline)
    except TimeoutError:
        result.value = cut()
        result.fallbacks.append("failed")
        return result
    outcome = context.submit(
        span, key, source, text_content_type(joined.head(256) + joined.tail(256)), digest
    )
    if outcome.ok:
        result.value = blob_prefix(joined.head(BLOB_PREFIX_BYTES + 1))
        result.entries.append(
            ((index, sys.maxsize), _blob_entry(key, *digest, outcome.content_type))
        )
    else:
        result.value = cut()
        result.fallbacks.append(outcome.reason)
    return result


def _fallback(key: str, value: Any, cap: int, inspect: bool = True, log: bool = False) -> _Result:
    """Place a candidate whose placement failed.

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
    memo: MediaDigestMemo | None = None,
) -> tuple[list[dict[str, Any]], Tally]:
    """Each span's own attributes with its held values, and its messages holding a large inline
    file, placed: a file whose upload is accepted replaced by its first 16 KiB (or its digest), a
    value still over the inline limit whose upload is accepted replaced by its first 16 KiB (or
    cut to the limit when refused), each accepted upload listed under ``hue.blobs`` and each whole
    value cut or listed for upload listed under ``hue.truncated``. Placement is local work on the
    calling thread, in order; the accepted uploads run in the background and nothing waits for
    them. ``deadline`` bounds the hashing of values read in place."""
    return _place_all(
        [_Span(attributes, held, trace_id) for attributes, held, trace_id in spans],
        uploader=uploader,
        value_bytes=value_bytes,
        deadline=deadline,
        memo=memo,
    )


def _place_all(
    placements: list[_Span],
    *,
    uploader: BlobUploader,
    value_bytes: int,
    deadline: float,
    memo: MediaDigestMemo | None,
) -> tuple[list[dict[str, Any]], Tally]:
    """The records' candidates placed one after another (see ``place_spans``)."""
    context = _Context(uploader, value_bytes, deadline, memo or MediaDigestMemo())
    placed: dict[tuple[int, int], _Result] = {}
    for number, span in enumerate(placements):
        for index, (key, value) in enumerate(span.candidates):
            try:
                placed[(number, index)] = _place(span, index, key, value, context)
            except Exception:
                placed[(number, index)] = _fallback(
                    key, value, value_bytes, key in span.inspected, span.log
                )
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
    memo: MediaDigestMemo | None = None,
) -> tuple[list[dict[str, Any]], list[Any], Tally]:
    """Each log record's attributes and body with the media its copy held placed: each file whose
    upload is accepted listed in the record's own ``hue.blobs`` and uploaded under its trace in the
    background, keyed ``<attribute>#<pointer>`` or ``body#<pointer>``, or kept inline when it is
    refused (a message's file over the inline limit as its digest); what is left over the inline
    limit is cut as before. The attachments a body holds (``held.files``, keyed
    ``body#<pointer>``) then take the ``hue.blobs`` places left, as a span's helper files follow
    its values. Nothing waits for an upload. ``logs`` holds each record's attributes, held values,
    trace id and body (a JSON-like copy, with the strings its copy held whole restored)."""
    placements = [
        _Span(attributes, replace(held, files=[]), trace_id, log=True, body=body)
        for attributes, held, trace_id, body in logs
    ]
    attributes, tally = _place_all(
        placements,
        uploader=uploader,
        value_bytes=value_bytes,
        deadline=deadline,
        memo=memo,
    )
    attaching = [
        (
            number,
            _Span(
                attributes[number],
                Held(files=list(held.files), inspected=set(), group=held.group),
                trace_id,
                log=True,
            ),
        )
        for number, (_, held, trace_id, _) in enumerate(logs)
        if held.files
    ]
    if attaching:
        placed, attached = _place_all(
            [span for _, span in attaching],
            uploader=uploader,
            value_bytes=value_bytes,
            deadline=deadline,
            memo=memo,
        )
        for (number, _), result in zip(attaching, placed, strict=True):
            attributes[number] = result
        tally.uploaded += attached.uploaded
        for reason, (count, traces) in attached.fallbacks.items():
            previous, named = tally.fallbacks.get(reason, (0, set()))
            tally.fallbacks[reason] = (previous + count, named | traces)
    return attributes, [placement.placed_body for placement in placements], tally
