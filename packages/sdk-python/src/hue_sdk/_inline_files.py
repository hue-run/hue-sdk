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
from collections.abc import Mapping
from dataclasses import dataclass
from math import isfinite
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
# Attributes whose value is JSON text by its convention, read for files anywhere in it: message
# sources (GenAI, AI SDK, OpenInference ``input.value``/``output.value``, OpenLLMetry entities,
# Langfuse observations and traces) and tool arguments and results.
_JSON_MEDIA_KEYS = frozenset(
    {
        "gen_ai.input.messages",
        "gen_ai.output.messages",
        "ai.prompt.messages",
        "ai.prompt",
        "input.value",
        "output.value",
        "traceloop.entity.input",
        "traceloop.entity.output",
        "langfuse.observation.input",
        "langfuse.observation.output",
        "langfuse.trace.input",
        "langfuse.trace.output",
        "gen_ai.tool.call.arguments",
        "gen_ai.tool.call.result",
        "ai.toolCall.args",
        "ai.toolCall.result",
        "tool.parameters",
        "tool_arguments",
        "tool_response",
    }
)
# Recorded metadata: JSON text when it reads as an object or array, otherwise the text itself.
_METADATA_KEYS = frozenset({"metadata", "langfuse.observation.metadata", "langfuse.trace.metadata"})
_METADATA_PREFIXES = (
    "langfuse.observation.metadata.",
    "langfuse.trace.metadata.",
    "ai.telemetry.metadata.",
)
# OpenLLMetry's indexed message content: the JSON text of a parts list.
_INDEXED_CONTENT_KEY = re.compile(r"gen_ai\.(?:prompt|completion)\.[0-9]{1,9}\.content\Z")
# OpenInference's flattened image content: the image's URL.
_OPENINFERENCE_IMAGE_KEY = re.compile(
    r"llm\.(?:input|output)_messages\.[0-9]{1,9}\.message\.contents\.[0-9]{1,9}"
    r"\.message_content\.image\.image\.url\Z"
)
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
    "audio",
    "media",
    "inlineData",
    "inline_data",
    "document",
    "data:",
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


def reading_of(key: str) -> str | None:
    """How an attribute's text is read for files: ``json`` by convention, ``metadata``, an
    OpenLLMetry ``parts`` list, or a ``url`` that is the file; None when it is not read."""
    if key in _JSON_MEDIA_KEYS:
        return "json"
    if key in _METADATA_KEYS or key.startswith(_METADATA_PREFIXES):
        return "metadata"
    if _INDEXED_CONTENT_KEY.match(key):
        return "parts"
    if _OPENINFERENCE_IMAGE_KEY.match(key):
        return "url"
    return None


def is_media_key(key: str) -> bool:
    """Whether a span attribute is one whose value the SDK inspects for inline media: the
    attributes Hue's reader reads files from."""
    return reading_of(key) is not None


def may_hold_media(value: Any) -> bool:
    """Whether text may hold inline media at all: cheap, before it is parsed or walked."""
    return isinstance(value, str) and any(marker in value for marker in _MEDIA_MARKERS)


def may_inline_files(key: str, value: Any) -> bool:
    return is_media_key(key) and may_hold_media(value)


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
class EncodedValue:
    """A string inside a recorded value whose JSON the walk read (a tool call's arguments, a tool
    result): encoded again once a file inside it is placed."""

    owner: dict[str, Any]
    key: str
    value: Any
    dirty: bool = False


@dataclass
class InlineFilePart:
    """The provider part and the exact content leaf, with both JSON pointers.

    ``part`` carries the digest: the provider part, or for OpenAI assistant audio the message.
    A ``whole`` string is a ``data:`` URL replaced by a GenAI ``blob`` part in digest form.
    ``encoded`` names the JSON-encoded strings the file sits in, outermost first: no
    ``hue.blobs`` key can address inside a string, so such a file is placed by its digest.
    """

    part: dict[str, Any]
    owner: Any
    key: Any
    content: str
    pointer: str
    part_pointer: str
    content_type: str | None = None
    name: str | None = None
    base64: bool = False
    whole: bool = False
    encoded: list[EncodedValue] | None = None


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
    elif kind in ("input_image", "computer_screenshot"):
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


# A media type as a data: URL declares one: ``type/subtype``, no parameters.
_DECLARED_MEDIA_TYPE = re.compile(r"[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9!#$&^_.+-]+\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_MAX_SAFE_INTEGER = 2**53 - 1


def _data_url_type(text: str) -> str | None:
    """The media type a whole string that is a data: URL declares, when it declares one: such a
    string is a file wherever it sits. A web URL, or any other text, is not."""
    if not text.startswith("data:"):
        return None
    header = _DATA_URL.match(text)
    if header is None:
        return None
    mime = header.group(1).split(";")[0].strip(_ECMASCRIPT_WHITESPACE)
    return mime if _DECLARED_MEDIA_TYPE.match(mime) and is_media_content_type(mime) else None


def modality_of(media_type: str) -> str:
    """The modality a media type implies, as Hue's reader names it."""
    mime = media_type.split(";")[0].strip(_ECMASCRIPT_WHITESPACE).lower()
    if mime.startswith("image/"):
        return "image"
    if mime.startswith("audio/"):
        return "audio"
    if mime.startswith("video/"):
        return "video"
    if (
        mime.startswith("text/")
        or mime
        in {
            "application/pdf",
            "application/rtf",
            "application/msword",
            "application/vnd.ms-excel",
            "application/vnd.ms-powerpoint",
        }
        or mime.startswith("application/vnd.openxmlformats-officedocument.")
    ):
        return "document"
    return "file"


# The media types OpenAI's audio ``format`` names; any other valid name is ``audio/<name>``.
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
_AUDIO_FORMAT = re.compile(r"[a-z0-9.+-]{1,32}\Z")


def _audio_format_media_type(audio_format: str) -> str | None:
    name = audio_format.strip(_ECMASCRIPT_WHITESPACE).lower()
    if not _AUDIO_FORMAT.match(name):
        return None
    return _AUDIO_FORMATS.get(name, f"audio/{name}")


def _audio_signature_media_type(encoded: str) -> str | None:
    """The media type the first bytes of base64 audio name by their container's signature (WAV,
    MP3, AAC, FLAC, Ogg): OpenAI's assistant audio keeps only the bytes, in the format the request
    asked for. Raw PCM has no signature and no type."""
    try:
        head = base64.b64decode(encoded[:16])
    except (binascii.Error, ValueError):
        return None
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "audio/wav"
    if head[:3] == b"ID3":
        return "audio/mpeg"
    if head[:4] == b"fLaC":
        return "audio/flac"
    if head[:4] == b"OggS":
        return "audio/ogg"
    # An MPEG frame's sync word: layer bits 00 are an AAC ADTS frame, any other an MP3 frame.
    if len(head) >= 2 and head[0] == 0xFF and head[1] & 0xF0 == 0xF0:
        return "audio/aac" if head[1] & 0x06 == 0 else "audio/mpeg"
    if len(head) >= 2 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0:
        return "audio/mpeg"
    return None


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_safe_size(value: Any) -> bool:
    """A JavaScript safe integer at least zero, as the reader reads a recorded size."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, float) and not value.is_integer():
        return False
    return 0 <= value <= _MAX_SAFE_INTEGER


def _reader_label(value: Any) -> bool:
    """A label as Hue's reader takes one: nonempty once trimmed, at most 256 code units."""
    if not isinstance(value, str) or not value:
        return False
    text = value.strip(_ECMASCRIPT_WHITESPACE)
    return 0 < utf16_size(text, 256) <= 256


def _reader_type(item: dict[str, Any]) -> str | None:
    kind = item.get("type")
    return kind.lower().replace("-", "_") if isinstance(kind, str) else None


def _reader_consumed(part: dict[str, Any]) -> tuple[str, ...] | None:
    """The keys of a value Hue's reader reads as a file by its shape, where the SDK found no
    inline bytes to upload in it (a remote URL, a provider file id, an empty or malformed field):
    nothing inside them is read as another file, so nothing inside them is replaced either. None
    for a value that is no file. Mirrors the reader's shapes."""
    kind = _reader_type(part)
    size = part.get("size") if part.get("size") is not None else part.get("byte_size")
    sha = part.get("sha256")
    digest = (isinstance(sha, str) and bool(_SHA256.match(sha))) or _is_safe_size(size)

    def identifies(content: Any, file_id: Any = None) -> bool:
        return (isinstance(content, str) and len(content) > 0) or _reader_label(file_id) or digest

    def anthropic() -> tuple[str, ...] | None:
        source = _object(part.get("source"))
        if source is None or source.get("type") == "content":
            return None
        return ("type", "source", "title", "name", "filename", "cache_control")

    if kind == "blob":
        return ("type", "content", "mime_type", "modality", "name", "filename", "transcript")
    if kind == "uri":
        return ("type", "uri", "mime_type", "modality", "name", "filename", "transcript")
    if kind == "file":
        file = _object(part.get("file"))
        if file is not None:
            named = identifies(file.get("file_data"), file.get("file_id"))
            return ("type", "file") if named else None
        if isinstance(part.get("file_id"), str) or isinstance(part.get("modality"), str):
            return (
                ("type", "file_id", "mime_type", "modality", "name", "filename")
                if identifies(None, part.get("file_id"))
                else None
            )
        return (
            ("type", "data", "mediaType", "mimeType", "filename", "name", "providerOptions")
            if identifies(part.get("data"))
            else None
        )
    if kind == "image":
        if _object(part.get("source")) is not None:
            return anthropic()
        return (
            ("type", "image", "mediaType", "mimeType", "filename", "name", "providerOptions")
            if isinstance(part.get("image"), str) or digest
            else None
        )
    if kind == "document":
        return anthropic()
    if kind == "image_url":
        return ("type", "image_url")
    if kind == "input_image":
        return ("type", "image_url", "file_id", "detail")
    if kind == "input_audio":
        return ("type", "input_audio", "data", "format", "transcript")
    if kind == "input_file":
        return ("type", "file_data", "file_url", "file_id", "filename", "name")
    if kind == "computer_screenshot":
        return ("type", "image_url", "file_id")
    if kind == "media":
        return ("type", "data", "mime_type", "file_uri", "fileUri", "name", "filename")
    if kind is None:
        for key in ("inlineData", "inline_data", "fileData", "file_data"):
            if _object(part.get(key)) is not None:
                return (key,)
        for key in ("image", "document"):
            nested = _object(part.get(key))
            if nested is not None and _object(nested.get("source")) is not None:
                return (key,)
        audio = _object(part.get("audio"))
        if (
            audio is not None
            and isinstance(audio.get("id"), str)
            and (
                isinstance(audio.get("data"), str)
                or isinstance(audio.get("transcript"), str)
                or _is_number(audio.get("expires_at"))
            )
        ):
            return ("audio",)
    return None


def _encoded_json_keys(item: dict[str, Any]) -> tuple[str, ...]:
    """The keys of a part whose string value is JSON by its convention, read as the value it
    encodes: a tool call's ``arguments``, a tool result, and a ``tool`` or ``function`` message's
    ``content``. A message's own text is never read as JSON."""
    if item.get("role") in ("tool", "function"):
        return ("content",)
    kind = _reader_type(item)
    if kind in ("tool_call", "function_call"):
        return ("arguments",)
    if kind in ("tool_result", "function_call_output", "tool_call_response"):
        return ("output", "result", "content", "response")
    if isinstance(item.get("name"), str) and "arguments" in item:
        return ("arguments",)
    return ()


_JSON_CONTAINER = re.compile(r"[ \t\n\r]*[\[{]")


def _encoded_json_value(text: str) -> Any:
    """The object or array a JSON-encoded string holds; None for any other string."""
    if not _JSON_CONTAINER.match(text):
        return None
    try:
        parsed = loads_message(text)
    except (ValueError, RecursionError):
        return None
    return parsed if isinstance(parsed, (dict, list)) else None


@dataclass
class MediaValue:
    """The files a recorded value holds, the box holding the value (so a whole-string file at its
    root can be replaced), and the JSON-encoded strings the walk read, innermost first, to encode
    again once a file inside one is placed."""

    box: dict[str, Any]
    files: list[InlineFilePart]
    encoded: list[EncodedValue]


def media_in(value: Any) -> MediaValue:
    """Every file a recorded value carries for upload, in reading order, as Hue's reader finds
    them: a provider part with inline bytes, an OpenAI assistant message's audio, a whole string
    that is a typed data: URL, and the files inside a tool call's or tool result's JSON-encoded
    string. A part whose bytes are not inline (a remote URL, a file id) is left whole. The caller
    applies the decoded text threshold."""
    box: dict[str, Any] = {"value": value}
    files: list[InlineFilePart] = []
    encoded: list[EncodedValue] = []

    def visit(
        node: Any, pointer: str, depth: int, owner: Any, key: Any, within: list[EncodedValue]
    ) -> None:
        if depth > _MAX_DEPTH:
            raise ValueError("Message exceeds its nesting limit.")

        def add(file: InlineFilePart) -> None:
            if within:
                file.encoded = within
            files.append(file)

        if isinstance(node, str):
            mime = _data_url_type(node)
            if mime is not None:
                add(InlineFilePart({}, owner, key, node, pointer, pointer, mime, whole=True))
            return
        if isinstance(node, list):
            for index, item in enumerate(node):
                visit(item, f"{pointer}/{index}", depth + 1, node, index, within)
            return
        if not isinstance(node, dict):
            return
        file = content_path(node, pointer)
        if file is not None:
            add(file)
            return
        consumed = _reader_consumed(node)
        if consumed == ("audio",):
            # An OpenAI Chat assistant message's spoken reply: the message is the part.
            audio = node["audio"]
            data = audio.get("data")
            if isinstance(data, str) and len(data) % 4 == 0 and _BASE64.match(data):
                audio_format = audio.get("format")
                mime = (
                    _audio_format_media_type(audio_format)
                    if isinstance(audio_format, str) and audio_format
                    else _audio_signature_media_type(data)
                )
                add(
                    InlineFilePart(
                        node,
                        audio,
                        "data",
                        data,
                        f"{pointer}/audio/data",
                        pointer,
                        mime,
                        base64=True,
                    )
                )
        encoded_keys = _encoded_json_keys(node)
        for name, item in node.items():
            if consumed is not None and name in consumed:
                continue
            at = f"{pointer}/{_pointer_segment(str(name))}"
            inner = (
                _encoded_json_value(item)
                if isinstance(item, str) and name in encoded_keys
                else None
            )
            if inner is not None:
                holder = EncodedValue(node, name, inner)
                before = len(files)
                visit(inner, at, depth + 1, holder, "value", [*within, holder])
                if len(files) > before:
                    encoded.append(holder)
                continue
            visit(item, at, depth + 1, node, name, within)

    visit(value, "", 0, box, "value", [])
    return MediaValue(box, files, encoded)


_JSON_OBJECT_TEXT = re.compile(r"\s*[\[{]")
_JSON_ARRAY_TEXT = re.compile(r"\s*\[")


def read_media_text(key: str, text: str) -> MediaValue | None:
    """An attribute's recorded text read for files as Hue's reader reads that attribute: JSON by
    its convention; metadata as JSON when it reads as an object or array, otherwise as the text
    itself; an OpenLLMetry content as the parts list it encodes (any other content stays text); an
    OpenInference image URL as the text itself. None for text that reading finds nothing in.
    Raises ValueError for JSON that does not parse or nests too deep."""
    reading = reading_of(key)
    if reading == "json":
        return media_in(loads_message(text))
    if reading == "metadata":
        return media_in(loads_message(text) if _JSON_OBJECT_TEXT.match(text) else text)
    if reading == "parts":
        if not _JSON_ARRAY_TEXT.match(text):
            return None
        parsed = loads_message(text)
        if (
            isinstance(parsed, list)
            and parsed
            and all(isinstance(part, dict) and isinstance(part.get("type"), str) for part in parsed)
        ):
            return media_in(parsed)
        return None
    if reading == "url":
        return media_in(text)
    return None


def reencode_media(media: MediaValue) -> None:
    """Each JSON-encoded string a placed file sits in, encoded again, innermost first."""
    for holder in media.encoded:
        if holder.dirty:
            holder.owner[holder.key] = dumps_message(holder.value)


def placed_media_text(media: MediaValue) -> str:
    """The recorded value's text once its files are placed."""
    reencode_media(media)
    return dumps_message(media.box["value"])


def placeable(file: InlineFilePart, decoded: InlineFile) -> bool:
    """Whether a found file has bytes to place: nonempty, and a whole string's data: URL
    decodes."""
    return bool(decoded.data) and (not file.whole or decoded.decoded)


def keeps_prefix(file: InlineFilePart, textual: bool) -> bool:
    """Whether an uploaded file keeps a 16 KiB prefix of its content in place (text media in a
    provider part, whose entry names the content) rather than its digest. A whole string and a
    file inside a JSON-encoded string always take the digest form."""
    return textual and not file.whole and not file.encoded


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


def _blob_part(content_type: str, sha256: str, size: int) -> dict[str, Any]:
    """The GenAI ``blob`` part in digest form a whole-string file is replaced by."""
    return {
        "type": "blob",
        "mime_type": content_type,
        "modality": modality_of(content_type),
        "sha256": sha256,
        "size": size,
    }


def digest_part(file: InlineFilePart, sha256: str, size: int) -> None:
    """Digest placement removes only the leaf and adds identity to the provider part (the message,
    for OpenAI assistant audio); a whole string becomes a GenAI ``blob`` part in digest form."""
    if file.whole:
        file.owner[file.key] = _blob_part(file.content_type or "", sha256, size)
    else:
        file.owner.pop(file.key, None)
        file.part["sha256"] = sha256
        file.part["size"] = size
    for holder in file.encoded or ():
        holder.dirty = True


def prefix_part(file: InlineFilePart, prefix: str) -> None:
    """Prefix placement keeps the first 16 KiB of a text file's content in place."""
    file.owner[file.key] = prefix
    for holder in file.encoded or ():
        holder.dirty = True


def hash_inline_files(key: str, value: Any, memo: MediaDigestMemo | None = None) -> Any:
    return hash_inline_files_counted(key, value, memo)[0]


def digest_media(
    media: MediaValue,
    memo: MediaDigestMemo | None = None,
    receipts: dict[str, tuple[str, int]] | None = None,
    trace_id: str = "",
    *,
    preserve_small_binary: bool = False,
) -> int:
    """Each file a recorded value holds replaced by its digest, as export places a file it does
    not upload: binary media of any size (``preserve_small_binary``: over the inline limit) and
    text media over the inline limit. How many were replaced."""
    count = 0
    for file in media.files:
        decoded = media_bytes(file)
        if not placeable(file, decoded) or (
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
    if count:
        reencode_media(media)
    return count


def digest_form_size(value: Any) -> int:
    """The UTF-8 size of a structured value's JSON once each file the SDK may upload from it,
    within the inspection limits, is placed in its digest form: whether a log body field over the
    value cap fits it once its media upload. Mutates ``value``, a copy the caller owns."""
    media = media_in(value)
    inspected = 0
    for file in media.files:
        units = utf16_size(file.content, MAX_INLINE_FILE_TEXT)
        if units > MAX_INLINE_FILE_TEXT or inspected + units > INLINE_FILE_TEXT_PER_RECORD:
            continue
        inspected += units
        decoded = media_bytes(file)
        if not placeable(file, decoded) or (
            is_text_media_type(media_content_type(file, decoded))
            and len(decoded.data) <= INLINE_FILE_LIMIT
        ):
            continue
        digest_part(file, "0" * 64, len(decoded.data))
    reencode_media(media)
    return len(dumps_message(media.box["value"]).encode("utf-8", "surrogatepass"))


def hash_inline_files_counted(
    key: str,
    value: Any,
    memo: MediaDigestMemo | None = None,
    receipts: dict[str, tuple[str, int]] | None = None,
    trace_id: str = "",
    *,
    preserve_small_binary: bool = False,
    any_key: bool = False,
) -> tuple[Any, int]:
    """A span attribute with its inline media replaced by their digest, as export places media it
    does not upload, and how many. Only the recorded message attributes (``is_message_key``)
    shrink without an upload; every other inspected attribute keeps its bytes inline unless they
    upload, so ``any_key`` asks for the digest form of any inspected attribute (what the queue is
    charged for a value it holds whole for upload)."""
    if (
        not may_inline_files(key, value)
        or not (any_key or is_message_key(key))
        or utf16_size(value, MAX_INLINE_FILE_TEXT) > MAX_INLINE_FILE_TEXT
    ):
        return value, 0
    try:
        media = read_media_text(key, value)
        if media is None:
            return value, 0
        count = digest_media(
            media, memo, receipts, trace_id, preserve_small_binary=preserve_small_binary
        )
        return (dumps_message(media.box["value"]), count) if count else (value, 0)
    except (ValueError, RecursionError):
        return value, 0


def _js_number(text: str) -> Any:
    """A JSON number as JavaScript reads and writes it again: an integral value as an integer
    (``1.0`` is written ``1``) and one past the double range as ``null``."""
    number = float(text)
    if not isfinite(number):
        return None
    return int(number) if number.is_integer() and abs(number) < 1e21 else number


def _no_constant(text: str) -> Any:
    raise ValueError(f"{text} is not JSON")


def loads_message(text: str) -> Any:
    """JSON text as the TypeScript SDK parses it, so a value placed again is written the same:
    ``NaN`` and ``Infinity`` are not JSON, and every number, integer literals included, keeps the
    double JavaScript gives it (``9007199254740993`` reads as ``9007199254740992``)."""
    return json.loads(
        text, parse_float=_js_number, parse_int=_js_number, parse_constant=_no_constant
    )


def js_number_text(number: float) -> str:
    """A number as JavaScript's ``JSON.stringify`` writes it (ECMAScript Number::toString): the
    shortest digits that read back as the same double, positional from 1e-6 up to 1e21
    (``0.00001``, ``150000000000000000000``), else exponential (``1e-7``, ``1e+21``); ``-0`` as
    ``0`` and a value that is not finite as ``null``."""
    if not isfinite(number):
        return "null"
    if number == 0:
        return "0"
    sign = "-" if number < 0 else ""
    # Python's repr is the shortest decimal that reads back as the same double, as JavaScript's.
    mantissa, _, exponent = repr(abs(number)).partition("e")
    whole, _, fraction = mantissa.partition(".")
    figures = whole + fraction
    digits = figures.lstrip("0")
    # The value is 0.<digits> times ten to the power ``point``.
    point = len(whole) + (int(exponent) if exponent else 0) - (len(figures) - len(digits))
    digits = digits.rstrip("0")
    count = len(digits)
    if count <= point <= 21:
        return sign + digits + "0" * (point - count)
    if 0 < point <= 21:
        return sign + digits[:point] + "." + digits[point:]
    if -6 < point <= 0:
        return sign + "0." + "0" * -point + digits
    power = point - 1
    shown = digits if count == 1 else digits[0] + "." + digits[1:]
    return f"{sign}{shown}e{'+' if power >= 0 else '-'}{abs(power)}"


def _json_text(value: Any, parts: list[str]) -> None:
    """``value`` written as JavaScript's ``JSON.stringify`` writes the same JSON data."""
    if isinstance(value, str):
        parts.append(json.dumps(value, ensure_ascii=False))
    elif value is None or value is True or value is False:
        parts.append("null" if value is None else "true" if value else "false")
    elif isinstance(value, int):
        parts.append(int.__repr__(value))
    elif isinstance(value, float):
        parts.append(js_number_text(value))
    elif isinstance(value, Mapping):
        parts.append("{")
        for index, (key, item) in enumerate(value.items()):
            if index:
                parts.append(",")
            if not isinstance(key, str):
                key = (
                    "null"
                    if key is None
                    else ("true" if key else "false")
                    if isinstance(key, bool)
                    else js_number_text(key)
                    if isinstance(key, float)
                    else str(key)
                )
            parts.append(json.dumps(key, ensure_ascii=False))
            parts.append(":")
            _json_text(item, parts)
        parts.append("}")
    elif isinstance(value, (list, tuple)):
        parts.append("[")
        for index, item in enumerate(value):
            if index:
                parts.append(",")
            _json_text(item, parts)
        parts.append("]")
    else:
        raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def _spelled_alike(value: Any) -> bool:
    """Whether ``json.dumps`` writes ``value`` as ``JSON.stringify`` does: plain dicts, lists,
    strings, integers and booleans, and only floats both spell the same (finite, not integral,
    from 1e-4 up to 1e16)."""
    stack = [value]
    while stack:
        item = stack.pop()
        kind = type(item)
        if kind is str or kind is int or kind is bool or item is None:
            continue
        if kind is float:
            if not (isfinite(item) and not item.is_integer() and 1e-4 <= abs(item) < 1e16):
                return False
        elif kind is dict:
            if any(type(key) is not str for key in item):
                return False
            stack.extend(item.values())
        elif kind is list or kind is tuple:
            stack.extend(item)
        else:
            return False
    return True


def dumps_message(value: Any) -> str:
    """Compact JSON text as JavaScript's ``JSON.stringify`` writes the same data, numbers
    included, so a value the SDK places again matches the TypeScript SDK's byte for byte."""
    if _spelled_alike(value):
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    else:
        parts: list[str] = []
        _json_text(value, parts)
        encoded = "".join(parts)
    # JSON can preserve lone surrogate code units, but UTF-8 cannot encode them. Escape only
    # those units so provider metadata round-trips without changing ordinary Unicode text.
    return _SURROGATE.sub(lambda match: f"\\u{ord(match.group()):04x}", encoded)
