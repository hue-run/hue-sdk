"""Binary and large textual inline files in recorded messages, exported as digests.

Mirrors the TypeScript SDK's ``inline-files.ts`` so both SDKs export the same part shape.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
import sys
from collections import OrderedDict
from dataclasses import dataclass
from threading import Lock
from typing import Any

from ._limits import MAX_REQUEST_BYTES

# Textual file content over this decoded byte limit is exported as a digest; binary always is.
INLINE_FILE_LIMIT = 64 * 1024
# Admission runs on the application thread, so the JSON parsed there is bounded. Eight requests'
# worth matches the TypeScript SDK's default queue budget; a longer message is dropped as before.
# Both bounds count UTF-16 code units, as the TypeScript SDK measures strings.
MAX_INLINE_FILE_TEXT = 8 * MAX_REQUEST_BYTES
INLINE_FILE_TEXT_PER_RECORD = 2 * MAX_INLINE_FILE_TEXT

# Message attributes whose JSON can contain inline media parts.
_MESSAGE_KEYS = frozenset({"gen_ai.input.messages", "gen_ai.output.messages", "ai.prompt.messages"})
# Strict base64: alphabet characters only, padded to a multiple of four.
_BASE64 = re.compile(r"[A-Za-z0-9+/]*={0,2}\Z")
# An RFC 2397 data: URL's header, up to the comma before its data. Its ``;`` parameters are read
# in code, as the TypeScript SDK reads them.
_DATA_URL = re.compile(r"data:([^,]*),")
_HEX = frozenset("0123456789abcdefABCDEF")
_MAX_DEPTH = 256
_MEDIA_MARKERS = (
    "blob",
    "file",
    "image",
    "input_audio",
    "media",
    "inlineData",
    "inline_data",
    "document",
    "\\u",
)
_CONTENT_TYPE = re.compile(
    r"[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9!#$&^_.+-]+(?: *;[ -~]*)?\Z"
)


_ASTRAL = re.compile("[\U00010000-\U0010ffff]")


def utf16_size(value: str, limit: int) -> int:
    """Count UTF-16 code units, as the TypeScript SDK measures strings, without an encoded copy;
    counting stops once ``limit`` is exceeded."""
    size = len(value)
    if size > limit:
        return size
    for _ in _ASTRAL.finditer(value):
        size += 1
        if size > limit:
            break
    return size


def _base64_header(header: str) -> bool:
    """Whether a data: URL header's parameters, after its media type, include ``base64``."""
    semicolon = header.find(";")
    return semicolon != -1 and ";base64;" in f"{header[semicolon:]};"


_SURROGATE = re.compile("[\ud800-\udfff]")


def _well_formed(text: str) -> str:
    """Text as JavaScript encodes it to UTF-8: a surrogate pair is its character, a lone surrogate
    U+FFFD. Done once for a whole part, so its UTF-8 encodes without error."""
    if not _SURROGATE.search(text):
        return text
    return text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace")


def _percent_decoded(payload: str) -> bytes | None:
    """RFC 2397 data without ``;base64``: percent-escaped octets, other characters as UTF-8.

    None when a ``%`` does not start an escape.
    """
    decoded = bytearray()
    start = 0
    while (index := payload.find("%", start)) != -1:
        pair = payload[index + 1 : index + 3]
        if len(pair) != 2 or not _HEX.issuperset(pair):
            return None
        decoded += payload[start:index].encode("utf-8")
        decoded.append(int(pair, 16))
        start = index + 3
    decoded += payload[start:].encode("utf-8")
    return bytes(decoded)


@dataclass(frozen=True)
class InlineFile:
    """An inline file's bytes, whether they were decoded from the part's text (base64 or
    percent-escapes) rather than taken as its UTF-8, and the media type its data: URL names."""

    data: bytes
    decoded: bool
    url_media_type: str | None


def inline_file(content: str) -> InlineFile:
    """Decode content without a declared media type or provider encoding contract.

    A data: URL is decoded by its own encoding (base64 with ``;base64``, percent-escapes
    otherwise), content in the base64 alphabet is decoded, and anything else, such as a text
    file's own text, is UTF-8. A data: URL whose data does not decode is taken as UTF-8 too.
    ``media_bytes`` handles declared textual content and provider-specific base64 fields.
    """
    content = _well_formed(content)
    match = _DATA_URL.match(content)
    payload = content[match.end() :] if match else content
    decoded: bytes | None = None
    if match and not _base64_header(match.group(1)):
        decoded = _percent_decoded(payload)
    elif len(payload) % 4 == 0 and _BASE64.match(payload):
        try:
            decoded = base64.b64decode(payload, validate=True)
        except binascii.Error:
            decoded = None
    media_type = match.group(1).split(";")[0].strip() if match else ""
    return InlineFile(
        content.encode("utf-8") if decoded is None else decoded,
        decoded is not None,
        media_type or None,
    )


def _file_bytes(content: str) -> bytes:
    return inline_file(content).data


def is_message_key(key: str) -> bool:
    return key in _MESSAGE_KEYS


def may_inline_files(key: str, value: Any) -> bool:
    return (
        is_message_key(key)
        and isinstance(value, str)
        and any(marker in value for marker in _MEDIA_MARKERS)
    )


_ECMASCRIPT_WHITESPACE = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def is_media_name(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip(_ECMASCRIPT_WHITESPACE):
        return False
    try:
        units = len(value.encode("utf-16-le")) // 2
    except UnicodeEncodeError:
        return False
    return 1 <= units <= 256 and not any(ord(char) < 0x20 or ord(char) == 0x7F for char in value)


def is_media_content_type(value: Any) -> bool:
    return (
        isinstance(value, str) and 3 <= len(value) <= 255 and bool(_CONTENT_TYPE.fullmatch(value))
    )


def is_text_media_type(content_type: str) -> bool:
    mime = content_type.split(";", 1)[0].strip().lower()
    return (
        mime.startswith("text/")
        or mime.endswith(("+json", "+xml"))
        or mime
        in {
            "application/json",
            "application/xml",
            "application/javascript",
            "application/x-javascript",
            "application/x-www-form-urlencoded",
            "application/yaml",
            "application/x-yaml",
        }
    )


_AUDIO_TYPES = {
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "flac": "audio/flac",
    "ogg": "audio/ogg",
    "opus": "audio/opus",
    "aac": "audio/aac",
    "m4a": "audio/mp4",
    "webm": "audio/webm",
    "pcm16": "audio/pcm",
}
_DOCUMENT_TYPES = {
    "pdf": "application/pdf",
    "csv": "text/csv",
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xls": "application/vnd.ms-excel",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "html": "text/html",
    "txt": "text/plain",
    "md": "text/markdown",
}
_REMOTE = re.compile(r"(?:https?:|s3:|gs:|file:|blob:)", re.IGNORECASE)


@dataclass
class InlineFilePart:
    """The provider part and the exact content leaf, with both JSON pointers."""

    part: dict[str, Any]
    owner: dict[str, Any]
    key: str
    content: str
    pointer: str
    part_pointer: str
    content_type: str | None = None
    name: str | None = None
    base64: bool = False


def _object(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _coalesce(part: dict[str, Any], *keys: str) -> Any:
    return next((part[key] for key in keys if part.get(key) is not None), None)


def content_path(part: dict[str, Any], pointer: str = "") -> InlineFilePart | None:
    """Describe a supported provider part, its content leaf, and wire metadata."""
    owner = part
    key: str | None
    path = ""
    mime = _string(_coalesce(part, "mime_type", "mimeType", "mediaType", "media_type"))
    name = _string(_coalesce(part, "name", "filename"))
    encoded = url_only = False
    source = _object(part.get("source"))
    inline = _object(_coalesce(part, "inlineData", "inline_data"))
    audio = _object(part.get("input_audio"))
    chat_file = _object(part.get("file"))
    bedrock = _object(_coalesce(part, "image", "document"))
    kind = part.get("type")
    if inline is not None:
        owner, key = inline, "data"
        path = "/inlineData" if part.get("inlineData") is not None else "/inline_data"
        mime = _string(_coalesce(inline, "mimeType", "mime_type"))
        encoded, name = True, None
    elif audio is not None and kind == "input_audio":
        owner, key, path = audio, "data", "/input_audio"
        mime, encoded, name = _AUDIO_TYPES.get(_string(audio.get("format")) or ""), True, None
    elif chat_file is not None and kind == "file":
        owner, key, path = chat_file, "file_data", "/file"
        name, url_only = _string(chat_file.get("filename")), True
    elif bedrock is not None and _object(bedrock.get("source")) is not None:
        owner = bedrock["source"]
        key = "bytes"
        image = isinstance(part.get("image"), dict)
        path = "/image/source" if image else "/document/source"
        fmt = _string(bedrock.get("format")) or ""
        mime = (
            f"image/{fmt}"
            if image and fmt in ("png", "jpeg", "gif", "webp")
            else _DOCUMENT_TYPES.get(fmt)
        )
        name, encoded = None if image else _string(bedrock.get("name")), True
    elif source is not None and kind in ("image", "document"):
        if source.get("type") != "base64":
            return None
        owner, key, path = source, "data", "/source"
        mime, name, encoded = _string(source.get("media_type")), _string(part.get("title")), True
    elif kind == "image_url":
        image_url = _object(part.get("image_url"))
        owner = image_url if image_url is not None else part
        key, path = ("url", "/image_url") if image_url is not None else ("image_url", "")
        mime, name, url_only = None, None, True
    elif kind == "input_image":
        key, mime, name, url_only = "image_url", None, None, True
    elif kind == "input_file":
        key, mime, name, url_only = "file_data", None, _string(part.get("filename")), True
    elif kind == "image":
        key, name = "image", None
    elif kind == "media":
        key, name = "data", None
    else:
        key = "content" if kind == "blob" else "data" if kind == "file" else None
    if key is None:
        return None
    content = owner.get(key)
    if not isinstance(content, str) or _REMOTE.match(content):
        return None
    if url_only and not content.startswith("data:"):
        return None
    if encoded and (len(content) % 4 or not _BASE64.fullmatch(content)):
        return None
    return InlineFilePart(
        part,
        owner,
        key,
        content,
        f"{pointer}{path}/{key}",
        pointer,
        mime,
        name if is_media_name(name) else None,
        encoded,
    )


def _pointer_segment(segment: str) -> str:
    return segment.replace("~", "~0").replace("/", "~1")


def large_inline_file_parts(value: Any) -> list[InlineFilePart]:
    """Recognized inline media in document order; the caller applies the decoded text limit."""
    found: list[InlineFilePart] = []

    def visit(node: Any, pointer: str, depth: int) -> None:
        if depth > _MAX_DEPTH:
            raise ValueError("Message exceeds its nesting limit.")
        if isinstance(node, list):
            for index, item in enumerate(node):
                visit(item, f"{pointer}/{index}", depth + 1)
        elif isinstance(node, dict):
            file = content_path(node, pointer)
            if file is not None:
                found.append(file)
            else:
                for name, item in node.items():
                    visit(item, f"{pointer}/{_pointer_segment(str(name))}", depth + 1)

    visit(value, "", 0)
    return found


def media_bytes(file: InlineFilePart) -> InlineFile:
    if file.base64:
        return InlineFile(base64.b64decode(file.content, validate=True), True, None)
    if (
        is_media_content_type(file.content_type)
        and is_text_media_type(file.content_type or "")
        and not file.content.startswith("data:")
    ):
        return InlineFile(_well_formed(file.content).encode("utf-8"), False, None)
    return inline_file(file.content)


def media_content_type(file: InlineFilePart, decoded: InlineFile) -> str:
    for mime in (file.content_type, decoded.url_media_type):
        if is_media_content_type(mime):
            assert mime is not None
            return mime
    return "application/octet-stream" if decoded.decoded else "text/plain; charset=utf-8"


class MediaDigestMemo:
    """Bounded trace/digest cache; payload bytes are never retained."""

    def __init__(self, limit: int = 4 * 1024 * 1024, capacity: int = 256) -> None:
        self._lock = Lock()
        self._entries: OrderedDict[tuple[str, str], tuple[str, int]] = OrderedDict()
        self._size = 0
        self.limit, self.capacity = limit, capacity

    def digest(self, data: bytes, trace_id: str = "") -> tuple[str, int]:
        digest = hashlib.sha256(data).hexdigest(), len(data)
        identity = (trace_id, digest[0])
        with self._lock:
            known = self._entries.get(identity)
            if known is not None:
                return known
            charge = sys.getsizeof(identity[1]) + sys.getsizeof(trace_id) + sys.getsizeof(identity)
            if charge <= self.limit:
                while self._entries and (
                    len(self._entries) >= self.capacity or self._size + charge > self.limit
                ):
                    key, _ = self._entries.popitem(last=False)
                    self._size -= sys.getsizeof(key[1]) + sys.getsizeof(key[0]) + sys.getsizeof(key)
                self._entries[identity] = digest
                self._size += charge
            return digest

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._size = 0


def digest_part(file: InlineFilePart, sha256: str, size: int) -> None:
    file.owner.pop(file.key, None)
    file.part["sha256"] = sha256
    file.part["size"] = size


def hash_inline_files(key: str, value: Any, memo: MediaDigestMemo | None = None) -> Any:
    return hash_inline_files_counted(key, value, memo)[0]


def hash_inline_files_counted(
    key: str,
    value: Any,
    memo: MediaDigestMemo | None = None,
    receipts: dict[str, tuple[str, int]] | None = None,
    trace_id: str = "",
    *,
    preserve_small_binary: bool = False,
) -> tuple[Any, int]:
    if (
        not may_inline_files(key, value)
        or utf16_size(value, MAX_INLINE_FILE_TEXT) > MAX_INLINE_FILE_TEXT
    ):
        return value, 0
    try:
        parsed = json.loads(value)
        files = large_inline_file_parts(parsed)
        count = 0
        for file in files:
            decoded = media_bytes(file)
            if not decoded.data or (
                (preserve_small_binary or is_text_media_type(media_content_type(file, decoded)))
                and len(decoded.data) <= INLINE_FILE_LIMIT
            ):
                continue
            digest = (
                memo.digest(decoded.data, trace_id)
                if memo
                else (hashlib.sha256(decoded.data).hexdigest(), len(decoded.data))
            )
            if receipts is not None:
                receipts[file.pointer] = digest
            digest_part(file, *digest)
            count += 1
        return (dumps_message(parsed), count) if count else (value, 0)
    except (ValueError, RecursionError):
        return value, 0


def dumps_message(value: Any) -> str:
    # JSON can preserve lone surrogate code units, but UTF-8 cannot encode them. Escape only
    # those units so provider metadata round-trips without changing ordinary Unicode text.
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return _SURROGATE.sub(lambda match: f"\\u{ord(match.group()):04x}", encoded)
