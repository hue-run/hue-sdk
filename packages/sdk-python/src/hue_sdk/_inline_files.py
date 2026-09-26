"""Large inline files in recorded messages, exported as their digest.

Mirrors the TypeScript SDK's ``inline-files.ts`` so both SDKs export the same part shape.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from typing import Any

from .transport import MAX_REQUEST_BYTES

# Inline file content larger than this many UTF-8 bytes is exported as its digest instead.
INLINE_FILE_LIMIT = 64 * 1024
# Admission runs on the application thread, so the JSON parsed there is bounded. Eight requests'
# worth matches the TypeScript SDK's default queue budget; a longer message is dropped as before.
MAX_INLINE_FILE_TEXT = 8 * MAX_REQUEST_BYTES

# Message attributes whose JSON can inline files: GenAI blob parts and AI SDK 6 file parts.
_MESSAGE_KEYS = frozenset({"gen_ai.input.messages", "gen_ai.output.messages", "ai.prompt.messages"})
# Strict base64: alphabet characters only, padded to a multiple of four.
_BASE64 = re.compile(r"[A-Za-z0-9+/]*={0,2}\Z")
# An RFC 2397 data: URL's header, up to the comma before its data. Its ``;`` parameters are read
# in code, as the TypeScript SDK reads them.
_DATA_URL = re.compile(r"data:([^,]*),")
_HEX = frozenset("0123456789abcdefABCDEF")
_MAX_DEPTH = 256


def _utf8_size(value: str, limit: int) -> int:
    """Count UTF-8 bytes without allocating an encoded copy beyond ``limit``."""
    size = 0
    for character in value:
        code = ord(character)
        size += 1 if code <= 0x7F else 2 if code <= 0x7FF else 3 if code <= 0xFFFF else 4
        if size > limit:
            return size
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


def _file_bytes(content: str) -> bytes:
    """The file's own bytes, whatever its media type.

    A data: URL is decoded by its own encoding (base64 with ``;base64``, percent-escapes
    otherwise), content in the base64 alphabet is decoded, and anything else, such as a text
    file's own text, is UTF-8. A data: URL whose data does not decode is taken as UTF-8 too.
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
    return content.encode("utf-8") if decoded is None else decoded


def _content_key(part: dict[str, Any]) -> str | None:
    """The key holding a part's inline content: GenAI ``blob`` parts and AI SDK 6 ``file`` parts."""
    kind = part.get("type")
    return "content" if kind == "blob" else "data" if kind == "file" else None


class _Hash:
    def __init__(self) -> None:
        self.changed = False

    def node(self, value: Any, depth: int = 0) -> Any:
        if depth > _MAX_DEPTH:
            raise ValueError("Message exceeds its nesting limit.")
        if isinstance(value, list):
            return [self.node(item, depth + 1) for item in value]
        if not isinstance(value, dict):
            return value
        key = _content_key(value)
        inline = value.get(key) if key is not None else None
        if key is not None and isinstance(inline, str):
            data = _file_bytes(inline)
            if len(data) > INLINE_FILE_LIMIT:
                self.changed = True
                rest = {name: item for name, item in value.items() if name != key}
                return {**rest, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
        return {name: self.node(item, depth + 1) for name, item in value.items()}


def hash_inline_files(key: str, value: Any) -> Any:
    """Replace inline files longer than ``INLINE_FILE_LIMIT`` in a recorded message attribute.

    Each such part keeps its other fields and gains ``sha256`` and ``size``, so a span that inlines
    a large file exports the file's identity instead of being dropped for its size. Other
    attributes, shorter messages, messages longer than ``MAX_INLINE_FILE_TEXT`` and values that
    are not JSON are returned unchanged.
    """
    if (
        key not in _MESSAGE_KEYS
        or not isinstance(value, str)
        or not INLINE_FILE_LIMIT < _utf8_size(value, MAX_INLINE_FILE_TEXT) <= MAX_INLINE_FILE_TEXT
        or ('"blob"' not in value and '"file"' not in value)
    ):
        return value
    try:
        parsed = json.loads(value)
        hashed = _Hash()
        result = hashed.node(parsed)
    except (ValueError, RecursionError):
        # Not JSON, or nested too deeply to inspect: admission decides the value's fate as before.
        return value
    if not hashed.changed:
        return value
    return json.dumps(result, ensure_ascii=False, separators=(",", ":"))
