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
_BASE64_DATA_URL = re.compile(r"data:[^,]*;base64,")
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


def _binary_mime_type(value: Any) -> bool:
    return (
        isinstance(value, str)
        and not value.lower().startswith("text/")
        and value.lower() != "application/json"
    )


def _file_bytes(content: str, mime_type: Any = None) -> bytes:
    """Decode explicit data URLs or MIME-marked binary content; otherwise use UTF-8."""
    match = _BASE64_DATA_URL.match(content)
    payload = content[match.end() :] if match else content
    if (match or _binary_mime_type(mime_type)) and len(payload) % 4 == 0 and _BASE64.match(payload):
        try:
            return base64.b64decode(payload, validate=True)
        except binascii.Error:
            pass
    return content.encode("utf-8")


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
        mime_type = value.get("mime_type", value.get("mediaType"))
        if (
            key is not None
            and isinstance(inline, str)
            and _utf8_size(inline, INLINE_FILE_LIMIT) > INLINE_FILE_LIMIT
        ):
            data = _file_bytes(inline, mime_type)
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
