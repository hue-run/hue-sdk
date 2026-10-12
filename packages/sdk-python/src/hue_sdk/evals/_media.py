"""Reading recorded media back, the TypeScript SDK's ``client.media`` and ``rehydrateMedia``.

A trace records a large file as a digest part: the provider part with its content field removed
and the file's ``sha256`` and ``size`` added, its bytes uploaded under the record's
``hue.blobs``. ``MediaClient.fetch`` downloads one file by digest through a short-lived link Hue
issues; ``MediaClient.resolve`` and ``rehydrate_media`` put the bytes back into the parts of a
recorded value, in the field and encoding each part's shape uses.
"""

from __future__ import annotations

import base64
import hashlib
import json
import random
import re
import time
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

import requests

MediaFetchErrorReason = Literal[
    "not_found", "missing", "unavailable", "forbidden", "too_large", "digest_mismatch", "failed"
]

_MESSAGES: dict[str, str] = {
    "not_found": "Hue holds no file with this digest for the trace or snapshot.",
    "missing": "The trace lists this file, but its bytes were never uploaded or have been erased.",
    "unavailable": "Hue could not read the file now; retry later.",
    "forbidden": "The key cannot read recorded content; use a Read or Read and write key.",
    "too_large": "The file is larger than max_bytes.",
    "digest_mismatch": "The downloaded bytes do not match the requested SHA-256.",
    "failed": "The media request failed.",
}


class MediaFetchError(RuntimeError):
    """A media read that failed; the message is fixed and never includes response text.

    ``reason`` says what failed: ``not_found`` (Hue holds no such file for the trace or snapshot:
    an unknown trace, another project's, or a digest none of its records list), ``missing`` (the
    trace lists the file, but its bytes were never uploaded or have been erased),
    ``unavailable`` (Hue could not read its evidence store, again after one retry),
    ``forbidden`` (the key cannot read recorded content), ``too_large`` (over ``max_bytes``;
    nothing was downloaded), ``digest_mismatch`` (the bytes do not have the requested SHA-256 or
    the size Hue reported) or ``failed`` (a connection failure, a timeout, an unexpected status or
    an invalid response). ``status`` is the HTTP status of the failing answer when there was one;
    ``retry_after_seconds`` the wait Hue asked for on ``unavailable`` when it said.
    """

    reason: MediaFetchErrorReason
    status: int | None
    retry_after_seconds: int | None

    def __init__(
        self,
        reason: MediaFetchErrorReason,
        status: int | None = None,
        retry_after_seconds: int | None = None,
    ) -> None:
        self.reason = reason
        self.status = status
        self.retry_after_seconds = retry_after_seconds
        message = _MESSAGES[reason]
        if reason == "failed" and status:
            message = f"The media request failed (HTTP {status})."
        super().__init__(message)


@dataclass(frozen=True)
class MediaFile:
    """One recorded file, downloaded and checked against its digest.

    ``content_type`` and ``file_name`` are what the record lists; a snapshot's copy carries
    neither, and its type is the part's own.
    """

    data: bytes = field(repr=False)
    sha256: str
    size: int
    content_type: str | None = None
    file_name: str | None = None


@dataclass(frozen=True)
class MediaResolveFailure:
    """A digest part left unchanged: its RFC 6901 pointer in the value, the SHA-256 it records
    and why (a ``MediaFetchError`` reason, or ``not_found`` when no local file has the digest)."""

    pointer: str
    sha256: str
    reason: MediaFetchErrorReason


@dataclass(frozen=True)
class ResolvedMedia:
    """A recorded value with the bytes of its digest parts written back.

    ``value`` is new: the input is never changed. Each resolved part holds its bytes in its
    content field and no longer carries ``sha256`` and ``size``. ``resolved`` counts the parts
    written; ``failures`` lists those left unchanged, in reading order.
    """

    value: Any
    resolved: int
    failures: list[MediaResolveFailure]


_SHA256 = re.compile(r"[0-9a-f]{64}")
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)
_TRACE = re.compile(r"[0-9a-f]{32}", re.IGNORECASE)
_SPAN = re.compile(r"[0-9a-f]{16}", re.IGNORECASE)
_MEDIA_TYPE = re.compile(r"[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9!#$&^_.+-]+")
# The default and largest ``max_bytes``: Hue keeps values of up to 1 GB.
DEFAULT_MAX_BYTES = 64 * 1024 * 1024
_MAX_BYTES = 1_000_000_000
# The longest ``Retry-After`` the one retry of an unavailable read waits.
_MAX_RETRY_AFTER_SECONDS = 10
# Bytes of a JSON answer read: a link answer or an error body.
_MAX_ANSWER_BYTES = 64 * 1024
# Nesting a value is walked to; deeper parts stay as they are.
_MAX_DEPTH = 128


def _no_auth(request: Any) -> Any:
    """Leaves a request as it is: no .netrc credentials are added to it."""
    return request


def _digest(value: object) -> str:
    digest = value.lower() if isinstance(value, str) else value
    if not isinstance(digest, str) or not _SHA256.fullmatch(digest):
        raise ValueError("sha256 must be 64 hex characters.")
    return digest


def _max_bytes(value: int) -> int:
    if isinstance(value, bool) or type(value) is not int or not 1 <= value <= _MAX_BYTES:
        raise ValueError("max_bytes must be an integer from 1 to 1000000000.")
    return value


def _route(
    sha256: object, trace_id: str | None, span_id: str | None, snapshot_id: str | None
) -> tuple[str, str]:
    """The route of a file and the digest it names, validated before anything is sent."""
    digest = _digest(sha256)
    if snapshot_id is not None:
        if trace_id is not None or span_id is not None:
            raise ValueError("Name a trace_id or a snapshot_id, not both.")
        if not isinstance(snapshot_id, str) or not _UUID.fullmatch(snapshot_id):
            raise ValueError("snapshot_id must be a UUID.")
        return f"/trace-snapshots/{snapshot_id.lower()}/blobs/{digest}", digest
    if not isinstance(trace_id, str) or not (
        _UUID.fullmatch(trace_id) or (_TRACE.fullmatch(trace_id) and trace_id.strip("0") != "")
    ):
        raise ValueError("trace_id must be a Hue trace ID or a 32-hex OpenTelemetry trace ID.")
    query = ""
    if span_id is not None:
        if not isinstance(span_id, str) or not _SPAN.fullmatch(span_id) or span_id.strip("0") == "":
            raise ValueError("span_id must be a 16-hex OpenTelemetry span ID.")
        query = f"?spanId={span_id.lower()}"
    return f"/traces/{trace_id.lower()}/blobs/{digest}{query}", digest


def _link(value: object) -> str | None:
    """A download link Hue issued: HTTPS, or HTTP to loopback, without credentials or a fragment."""
    if (
        not isinstance(value, str)
        or len(value) > 8192
        or any(ord(c) <= 0x20 or ord(c) == 0x7F for c in value)
    ):
        return None
    try:
        url = urlsplit(value)
        loopback = url.hostname in ("localhost", "127.0.0.1", "::1")
        allowed = url.scheme == "https" or (url.scheme == "http" and loopback)
        if not url.hostname or not allowed or url.username or url.password or url.fragment:
            return None
    except ValueError:
        return None
    return value


def _retry_after(response: requests.Response) -> int | None:
    header = (response.headers.get("Retry-After") or "").strip()
    if not (header.isascii() and header.isdigit()) or len(header) > 6:
        return None
    return min(int(header), 86_400)


def _answer(response: requests.Response) -> Any:
    """A JSON answer read to a bound; None when it is larger or not JSON."""
    chunks: list[bytes] = []
    size = 0
    try:
        for chunk in response.iter_content(chunk_size=8192):
            size += len(chunk)
            if size > _MAX_ANSWER_BYTES:
                return None
            chunks.append(chunk)
        return json.loads(b"".join(chunks).decode("utf-8"))
    except (ValueError, UnicodeError, requests.RequestException):
        return None


@dataclass(frozen=True)
class _Grant:
    url: str
    size: int
    content_type: str | None
    file_name: str | None


def _grant(answer: Any, sha256: str) -> _Grant:
    fields = answer if isinstance(answer, dict) else None
    url = _link(fields.get("url")) if fields else None
    size = fields.get("size") if fields else None
    if (
        fields is None
        or fields.get("sha256") != sha256
        or url is None
        or isinstance(size, bool)
        or type(size) is not int
        or size < 0
        or fields.get("method", "GET") != "GET"
    ):
        raise MediaFetchError("failed")
    content_type = fields.get("contentType")
    if not (
        isinstance(content_type, str)
        and len(content_type) <= 255
        and _MEDIA_TYPE.fullmatch(content_type.split(";")[0].strip())
    ):
        content_type = None
    file_name = fields.get("fileName")
    if not (isinstance(file_name, str) and 0 < len(file_name) <= 255):
        file_name = None
    return _Grant(url, size, content_type, file_name)


class MediaClient:
    """Hue's media reads, ``client.media``: one recorded file by digest (``fetch``), and every
    digest part of a recorded value written back with its bytes (``resolve``).

    The project key is sent to Hue only; the file itself comes from a short-lived link fetched
    without it. Created by ``EvaluationClient``; it needs a key that may read recorded content
    (Read, or Read and write).
    """

    def __init__(self, base_url: str, headers: dict[str, str], timeout_seconds: float) -> None:
        self._base_url = base_url
        self._headers = headers
        self._timeout = timeout_seconds

    def __repr__(self) -> str:
        return "MediaClient()"

    def fetch(
        self,
        *,
        sha256: str,
        trace_id: str | None = None,
        span_id: str | None = None,
        snapshot_id: str | None = None,
        max_bytes: int = DEFAULT_MAX_BYTES,
    ) -> MediaFile:
        """Download one recorded file and check it against its digest.

        Name the trace (a Hue trace ID or the 32-hex OpenTelemetry trace ID) and, when known, the
        16-hex ``span_id`` of the span that recorded the part, so Hue reads that span's record
        alone; or a ``snapshot_id`` to read a snapshot's pinned copy. A read Hue answers as
        unavailable (503 or 429) is asked once more after its ``Retry-After``, at most 10
        seconds, and so is one that lost its connection or timed out. A file over ``max_bytes``
        (default 64 MiB, at most 1 GB) fails before any byte is downloaded.

        Raises ``MediaFetchError`` for a file Hue does not hold, a refused key, an unavailable
        store, a file over ``max_bytes``, bytes that do not match the digest or a failed request;
        ``ValueError`` for invalid identifiers.
        """
        path, digest = _route(sha256, trace_id, span_id, snapshot_id)
        limit = _max_bytes(max_bytes)
        grant = self._grant(path, digest)
        if grant.size > limit:
            raise MediaFetchError("too_large")
        data = self._download(grant, digest)
        return MediaFile(data, digest, len(data), grant.content_type, grant.file_name)

    def resolve(
        self,
        value: Any,
        *,
        trace_id: str | None = None,
        span_id: str | None = None,
        snapshot_id: str | None = None,
        as_: Literal["data_url", "bytes"] = "data_url",
        concurrency: int = 4,
        max_bytes: int = DEFAULT_MAX_BYTES,
    ) -> ResolvedMedia:
        """Write the bytes of every digest part in ``value`` back into its content field.

        The reverse of the SDK's media capture: each distinct digest is downloaded once with
        ``fetch``, at most ``concurrency`` (1–16, default 4) at a time. ``as_="data_url"`` writes
        text: a ``data:`` URL where the part's field takes one (OpenAI ``image_url`` and
        ``file_data``, Responses ``input_image``, ``input_file`` and ``computer_screenshot``, AI
        SDK ``image`` and ``file`` ``data``), and bare base64 where its convention requires it
        (GenAI ``blob`` ``content``, OpenAI ``input_audio`` and assistant ``audio`` ``data``,
        Anthropic ``source.data``, Gemini ``inlineData.data``, Vertex ``media`` ``data``, Bedrock
        ``source.bytes``), so the value can be sent to the provider again; ``as_="bytes"`` writes
        the bytes themselves. Returns a new value; a part whose file cannot be read stays as it
        is and is reported in ``failures``. Parse attributes recorded as JSON text (such as
        ``gen_ai.input.messages``) before passing them.

        Raises ``ValueError`` for invalid identifiers or options; never for one file's failure.
        """
        mode = _mode(as_)
        if (
            isinstance(concurrency, bool)
            or type(concurrency) is not int
            or not 1 <= concurrency <= 16
        ):
            raise ValueError("concurrency must be 1–16.")
        limit = _max_bytes(max_bytes)
        # Identifiers are checked once, before any request.
        _route("0" * 64, trace_id, span_id, snapshot_id)
        parts = _digest_parts(value)
        digests = list(dict.fromkeys(part.sha256 for part in parts.values()))

        def read(digest: str) -> MediaFile | MediaFetchError:
            try:
                return self.fetch(
                    sha256=digest,
                    trace_id=trace_id,
                    span_id=span_id,
                    snapshot_id=snapshot_id,
                    max_bytes=limit,
                )
            except MediaFetchError as error:
                return error
            except Exception:
                return MediaFetchError("failed")

        files: dict[str, MediaFile | MediaFetchError] = {}
        if digests:
            with ThreadPoolExecutor(
                max_workers=min(concurrency, len(digests)), thread_name_prefix="hue-media"
            ) as executor:
                files = dict(zip(digests, executor.map(read, digests), strict=True))

        def file_of(digest: str) -> MediaFile | MediaFetchErrorReason:
            file = files[digest]
            return file.reason if isinstance(file, MediaFetchError) else file

        return _write_back(value, parts, file_of, mode)

    def _grant(self, path: str, sha256: str) -> _Grant:
        """The download link of one file, asked once more after an unavailable answer or a lost
        connection."""
        attempt = 0
        while True:
            try:
                with requests.get(
                    f"{self._base_url}/api/v1{path}",
                    headers=self._headers,
                    timeout=self._timeout,
                    allow_redirects=False,
                    stream=True,
                ) as response:
                    status = response.status_code
                    if status in (503, 429):
                        seconds = _retry_after(response)
                        wait: float = 1 if seconds is None else seconds
                        if attempt > 0 or wait > _MAX_RETRY_AFTER_SECONDS:
                            raise MediaFetchError("unavailable", status, seconds)
                    elif status == 404:
                        answer = _answer(response)
                        missing = isinstance(answer, dict) and answer.get("state") == "missing"
                        raise MediaFetchError("missing" if missing else "not_found", status)
                    elif status in (401, 403):
                        raise MediaFetchError("forbidden", status)
                    elif not 200 <= status < 300:
                        raise MediaFetchError("failed", status)
                    else:
                        return _grant(_answer(response), sha256)
            except requests.RequestException:
                if attempt > 0:
                    raise MediaFetchError("failed") from None
                wait = 0.25 + random.random() * 0.25
            time.sleep(wait)
            attempt += 1

    def _download(self, grant: _Grant, sha256: str) -> bytes:
        """The bytes behind a link, fetched without the key, stopped past the reported size and
        checked against the digest."""
        hasher = hashlib.sha256()
        data = bytearray()
        try:
            with requests.get(
                grant.url,
                auth=_no_auth,
                timeout=max(self._timeout, 120),
                allow_redirects=False,
                stream=True,
            ) as response:
                if not 200 <= response.status_code < 300:
                    raise MediaFetchError("failed", response.status_code)
                for chunk in response.iter_content(chunk_size=65536):
                    if len(data) + len(chunk) > grant.size:
                        raise MediaFetchError("digest_mismatch")
                    hasher.update(chunk)
                    data += chunk
        except requests.RequestException:
            raise MediaFetchError("failed") from None
        if len(data) != grant.size or hasher.hexdigest() != sha256:
            raise MediaFetchError("digest_mismatch")
        return bytes(data)


def _mode(value: object) -> Literal["data_url", "bytes"]:
    if value == "data_url":
        return "data_url"
    if value == "bytes":
        return "bytes"
    raise ValueError('as_ must be "data_url" or "bytes".')


def rehydrate_media(
    value: Any, files: Iterable[Any], *, as_: Literal["data_url", "bytes"] = "data_url"
) -> ResolvedMedia:
    """Write case files back into the digest parts of a case's inputs, by SHA-256.

    ``files`` are the files a runner hands a target (``context.files``: ``LocalFile``, read from
    ``path``; a managed target's ``ManagedInputFile``, whose ``data`` is in memory) or any objects
    with ``sha256``, ``data`` or ``path``, and optionally ``content_type``, so a target can send
    the recorded model call again with the real image, document or audio. Each file is read once
    and checked against its digest; a part with no matching file, or whose file does not match,
    stays as it is and is reported in ``failures``. ``as_`` is as in ``MediaClient.resolve``.
    Returns a new value; the input is never changed.
    """
    mode = _mode(as_)
    by_digest: dict[str, Any] = {}
    for file in files:
        digest = getattr(file, "sha256", None)
        digest = digest.lower() if isinstance(digest, str) else None
        if digest is not None and _SHA256.fullmatch(digest) and digest not in by_digest:
            by_digest[digest] = file
    parts = _digest_parts(value)
    read: dict[str, MediaFile | MediaFetchErrorReason] = {}
    for digest in dict.fromkeys(part.sha256 for part in parts.values()):
        file = by_digest.get(digest)
        if file is None:
            read[digest] = "not_found"
            continue
        data = getattr(file, "data", None)
        try:
            if data is None:
                data = Path(file.path).read_bytes()
            elif not isinstance(data, (bytes, bytearray, memoryview)):
                raise TypeError
            data = bytes(data)
        except (OSError, TypeError, AttributeError):
            read[digest] = "failed"
            continue
        if hashlib.sha256(data).hexdigest() != digest:
            read[digest] = "digest_mismatch"
            continue
        content_type = getattr(file, "content_type", None)
        read[digest] = MediaFile(
            data, digest, len(data), content_type if isinstance(content_type, str) else None
        )
    return _write_back(value, parts, read.__getitem__, mode)


@dataclass(frozen=True)
class _Slot:
    """Where a digest part keeps its content: the objects from the part to the field's owner,
    the field, the encoding the shape's convention uses, and the media type the part declares."""

    owner: tuple[str, ...]
    key: str
    encoding: Literal["base64", "data_url"]
    media_type: str | None


@dataclass(frozen=True)
class _DigestPart:
    pointer: str
    sha256: str
    slot: _Slot


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _declared(part: dict[str, Any]) -> str | None:
    for key in ("mime_type", "mediaType", "media_type", "mimeType"):
        if part.get(key) is not None:
            return _text(part[key])
    return None


_AUDIO_FORMATS = {
    "mp3": "audio/mpeg",
    "mpeg": "audio/mpeg",
    "mpga": "audio/mpeg",
    "wav": "audio/wav",
    "wave": "audio/wav",
    "ogg": "audio/ogg",
    "oga": "audio/ogg",
    "opus": "audio/opus",
    "flac": "audio/flac",
    "aac": "audio/aac",
    "m4a": "audio/mp4",
    "mp4": "audio/mp4",
    "webm": "audio/webm",
    "pcm16": "audio/pcm",
    "pcm": "audio/pcm",
}
_BEDROCK_TYPES = {
    "image": {
        "png": "image/png",
        "jpeg": "image/jpeg",
        "jpg": "image/jpeg",
        "gif": "image/gif",
        "webp": "image/webp",
    },
    "document": {
        "pdf": "application/pdf",
        "csv": "text/csv",
        "doc": "application/msword",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls": "application/vnd.ms-excel",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "html": "text/html",
        "txt": "text/plain",
        "md": "text/markdown",
    },
}


def _audio_type(value: object) -> str | None:
    return _AUDIO_FORMATS.get(value.strip().lower()) if isinstance(value, str) else None


def _slot(part: dict[str, Any]) -> _Slot | None:
    """The content slot of a part read by its shape, the shapes Hue reads media parts in; None
    for text, tool and reference parts (a provider file ID, a remote URL)."""
    kind = part.get("type")
    kind = kind.lower().replace("-", "_") if isinstance(kind, str) else None
    reference = isinstance(part.get("file_id"), str)
    declared = _declared(part)
    if kind == "blob":
        return _Slot((), "content", "base64", declared)
    if kind == "file":
        nested = part.get("file")
        if isinstance(nested, dict):
            if isinstance(nested.get("file_id"), str):
                return None
            return _Slot(("file",), "file_data", "data_url", declared)
        return None if reference else _Slot((), "data", "data_url", declared)
    if kind in ("image", "document"):
        source = part.get("source")
        if isinstance(source, dict):
            if source.get("type") not in (None, "base64"):
                return None
            return _Slot(("source",), "data", "base64", _text(source.get("media_type")) or declared)
        return _Slot((), "image", "data_url", declared) if kind == "image" else None
    if kind == "image_url":
        if isinstance(part.get("image_url"), dict):
            return _Slot(("image_url",), "url", "data_url", declared)
        return _Slot((), "image_url", "data_url", declared)
    if kind in ("input_image", "computer_screenshot"):
        return None if reference else _Slot((), "image_url", "data_url", declared)
    if kind == "input_audio":
        audio = part.get("input_audio")
        if isinstance(audio, dict):
            return _Slot(("input_audio",), "data", "base64", _audio_type(audio.get("format")))
        return _Slot((), "data", "base64", _audio_type(part.get("format")) or declared)
    if kind == "input_file":
        if reference or isinstance(part.get("file_url"), str):
            return None
        return _Slot((), "file_data", "data_url", declared)
    if kind == "media":
        return _Slot((), "data", "base64", declared)
    if kind is None:
        for key in ("inlineData", "inline_data"):
            data = part.get(key)
            if isinstance(data, dict):
                media_type = data.get("mimeType", data.get("mime_type"))
                return _Slot((key,), "data", "base64", _text(media_type))
        for key in ("image", "document"):
            block = part.get(key)
            source = block.get("source") if isinstance(block, dict) else None
            if isinstance(block, dict) and isinstance(source, dict) and "s3Location" not in source:
                fmt = block.get("format")
                media_type = _BEDROCK_TYPES[key].get(fmt.lower()) if isinstance(fmt, str) else None
                return _Slot((key, "source"), "bytes", "base64", media_type)
        # An OpenAI Chat assistant message's spoken reply: the message itself is the part.
        audio = part.get("audio")
        if isinstance(audio, dict) and isinstance(audio.get("id"), str):
            return _Slot(("audio",), "data", "base64", _audio_type(audio.get("format")))
    return None


def _digest_slot(part: dict[str, Any]) -> _Slot | None:
    """The slot of a part in digest form: a known shape that records a SHA-256 in place of its
    content, its content field absent or empty."""
    digest = part.get("sha256")
    if not isinstance(digest, str) or not _SHA256.fullmatch(digest):
        return None
    slot = _slot(part)
    if slot is None:
        return None
    owner: Any = part
    for segment in slot.owner:
        owner = owner.get(segment) if isinstance(owner, dict) else None
    if not isinstance(owner, dict):
        return None
    content = owner.get(slot.key)
    return slot if content is None or content == "" else None


def _escape(key: str) -> str:
    return key.replace("~", "~0").replace("/", "~1")


def _digest_parts(value: Any) -> dict[int, _DigestPart]:
    """The digest parts of a value, by the part object's identity, each once, in reading order."""
    found: dict[int, _DigestPart] = {}

    def visit(node: Any, pointer: str, depth: int) -> None:
        if depth > _MAX_DEPTH:
            return
        if isinstance(node, (list, tuple)):
            for index, item in enumerate(node):
                visit(item, f"{pointer}/{index}", depth + 1)
            return
        if not isinstance(node, dict):
            return
        slot = _digest_slot(node)
        # The slot's owners must sit within the depth the copy is made to.
        if slot is not None and depth + len(slot.owner) < _MAX_DEPTH and id(node) not in found:
            found[id(node)] = _DigestPart(pointer, node["sha256"], slot)
        # A message whose ``audio`` is a part still holds the parts of its ``content``.
        for key, item in node.items():
            visit(item, f"{pointer}/{_escape(str(key))}", depth + 1)

    visit(value, "", 0)
    return found


def _data_url_type(slot: _Slot, file: MediaFile) -> str:
    """The type a ``data:`` URL declares: the part's own, else the file's, without parameters."""
    for candidate in (slot.media_type, file.content_type):
        kind = candidate.split(";")[0].strip() if candidate else ""
        if kind and _MEDIA_TYPE.fullmatch(kind):
            return kind.lower()
    return "application/octet-stream"


def _write_back(
    value: Any,
    parts: dict[int, _DigestPart],
    file_of: Callable[[str], MediaFile | MediaFetchErrorReason],
    mode: Literal["data_url", "bytes"],
) -> ResolvedMedia:
    """A copy of ``value`` with each digest part whose file was read holding its bytes."""
    failures: list[MediaResolveFailure] = []
    reported: set[int] = set()
    resolved = 0

    def visit(node: Any, depth: int) -> Any:
        nonlocal resolved
        if depth > _MAX_DEPTH:
            return node
        if isinstance(node, list):
            return [visit(item, depth + 1) for item in node]
        if isinstance(node, tuple):
            return tuple(visit(item, depth + 1) for item in node)
        if not isinstance(node, dict):
            return node
        part = parts.get(id(node))
        file = file_of(part.sha256) if part is not None else None
        if part is not None and isinstance(file, str) and id(node) not in reported:
            failures.append(MediaResolveFailure(part.pointer, part.sha256, file))
            reported.add(id(node))
        copy = {key: visit(item, depth + 1) for key, item in node.items()}
        if part is not None and isinstance(file, MediaFile):
            # The owners along the slot are this copy's own objects: the walk copied every one.
            owner = copy
            for segment in part.slot.owner:
                owner = owner[segment]
            if mode == "bytes":
                owner[part.slot.key] = file.data
            else:
                encoded = base64.b64encode(file.data).decode("ascii")
                owner[part.slot.key] = (
                    encoded
                    if part.slot.encoding == "base64"
                    else f"data:{_data_url_type(part.slot, file)};base64,{encoded}"
                )
            copy.pop("sha256", None)
            copy.pop("size", None)
            resolved += 1
        return copy

    result = visit(value, 0)
    return ResolvedMedia(result, resolved, failures)
