"""Inline media in a value too long for the media inspection bounds, read without parsing it out.

A span's own attribute held whole for upload past the inspection bounds (8 Mi UTF-16 code units for
one attribute, 16 Mi for a record) is scanned once: every value string longer than
``LONG_STRING_UNITS`` that is recorded without escapes as base64 or a ``data:`` URL is replaced, in
a skeleton of the JSON text, by a short stand-in of the same kind, and the skeleton (within the
8 Mi bound) is read as Hue's reader reads the value. A file whose content is such a string is then
decoded, hashed and uploaded a slice at a time from its place in the recorded text, never copied
out of it whole, and placed with the same JSON edits as any file. Mirrors the TypeScript SDK's
``large-media.ts``, so both SDKs write the same bytes.
"""

from __future__ import annotations

import binascii
import re
import secrets
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any

from ._inline_files import (
    _ECMASCRIPT_WHITESPACE,
    MAX_INLINE_FILE_TEXT,
    InlineFilePart,
    MediaValue,
    loads_message,
    media_in,
    reader_parses,
    reading_of,
    utf16_size,
)

# A value string longer than this, in code units, is read in place when it is base64 or a data:
# URL recorded without escapes. Longer than every label Hue's reader matches (256 units), so a
# stand-in decides every test of the walk as the string itself does.
LONG_STRING_UNITS = 16 * 1024

_BASE64 = re.compile(r"[A-Za-z0-9+/]*={0,2}\Z")
_CONTROL = re.compile(r"[\x00-\x1f]")
_BAD_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")
# The longest data: URL header read in place, in characters: a string with a longer one is parsed
# with the rest of the value.
_MAX_HEADER_UNITS = 4096
_SURROGATE = re.compile("[\ud800-\udfff]")
_SPACE = re.compile(r"[ \t\n\r]*")
_ASTRAL = re.compile("[\U00010000-\U0010ffff]")
_JSON_OBJECT_TEXT = re.compile(r"\s*[\[{]")
_JSON_ARRAY_TEXT = re.compile(r"\s*\[")
# Slices of base64 decoded at once: a multiple of four characters.
_BASE64_SLICE = 1 << 20
# Slices of other text read at once, in characters.
_TEXT_SLICE = 1 << 20


class ByteSource:
    """A source of bytes read a slice at a time: an upload body that is never held whole.
    ``chunks`` may be called again for a retried upload; ``changed`` is set once a read found the
    source no longer holds the bytes it was recorded with."""

    def __init__(self, size: int, chunks: Callable[[], Iterator[bytes]]) -> None:
        self.size = size
        self._chunks = chunks
        self.changed = False

    def chunks(self) -> Iterator[bytes]:
        return self._chunks()


@dataclass
class LongText:
    """A long value string in place in the recorded text: its content is ``text`` from ``start``
    to ``end``, without escapes, and its data (after a data: URL's comma) starts at ``data``."""

    text: str
    start: int
    end: int
    data: int
    kind: str
    # A data: URL's header, between ``data:`` and its comma.
    header: str | None = None


def _base64_header(header: str) -> bool:
    """Whether a data: URL header's parameters, after its media type, include ``base64``."""
    semicolon = header.find(";")
    return semicolon != -1 and ";base64;" in f"{header[semicolon:]};"


def _classify(text: str, start: int, end: int, raw: bool = False) -> LongText | None:
    """How the content from ``start`` to ``end`` of ``text`` (a string literal's, without escapes,
    or with ``raw`` the whole text of a value that is no JSON) is read in place, if it is: strict
    base64, or a data: URL whose data decodes by its own encoding. None for any other text, which
    is parsed with the rest of the value; a string literal holding a control character, which no
    JSON does, is left for the parse to refuse."""
    if text.startswith("data:", start):
        # The comma is looked for within the string and the header's bound only.
        comma = text.find(",", start + 5, min(end, start + 5 + _MAX_HEADER_UNITS + 1))
        if comma == -1:
            return None
        header = text[start + 5 : comma]
        if not raw and _CONTROL.search(header):
            return None
        if _base64_header(header):
            if (end - comma - 1) % 4 or not _BASE64.fullmatch(text, comma + 1, end):
                return None
            return LongText(text, start, end, comma + 1, "dataBase64", header)
        # Data that ends in whitespace could trim to a label Hue's reader matches, which its
        # stand-in could not.
        if (
            (not raw and _CONTROL.search(text, comma + 1, end))
            or _BAD_ESCAPE.search(text, comma + 1, end)
            or (end > comma + 1 and text[end - 1] in _ECMASCRIPT_WHITESPACE)
        ):
            return None
        return LongText(text, start, end, comma + 1, "dataPercent", header)
    if (end - start) % 4 or not _BASE64.fullmatch(text, start, end):
        return None
    return LongText(text, start, end, start, "base64")


def _stand_in(long: LongText, tag: str) -> str:
    """The stand-in for a long string in the skeleton: its kind kept (base64 and its first 16
    characters, which name an audio container; a data: URL's header and whether its data decode),
    longer than any label, and unique by ``tag``."""
    if long.kind == "base64":
        return f"{long.text[long.start : long.start + 16]}{tag}{'A' * 472}"
    fill = "A" if long.kind == "dataBase64" else "x"
    return f"data:{long.header},{tag}{fill * 472}"


def _space(text: str, at: int) -> int:
    """The index past the whitespace JSON allows from ``at``."""
    match = _SPACE.match(text, at)
    return match.end() if match else at


def _longer(text: str, start: int, end: int, units: int) -> bool:
    """Whether ``text`` from ``start`` to ``end`` is longer than ``units`` UTF-16 code units, as
    the TypeScript SDK measures strings, without a copy of it."""
    length = end - start
    if length > units:
        return True
    if length * 2 <= units:
        return False
    for _ in _ASTRAL.finditer(text, start, end):
        length += 1
        if length > units:
            return True
    return False


@dataclass
class _Skeleton:
    text: str
    long: dict[str, LongText] = field(default_factory=dict)


def _skeleton_of(text: str, long_units: int) -> _Skeleton | None:
    """The skeleton of JSON ``text``: each value string longer than ``long_units`` and recorded
    without escapes as base64 or a data: URL replaced by its stand-in. None once the skeleton is
    longer than ``MAX_INLINE_FILE_TEXT`` code units: the scan stops there, so the text it reads
    and the skeleton it makes stay within that bound however long the value is. A string the scan
    finds unterminated (text that is no JSON) ends the scan; the skeleton then holds the rest as
    recorded and fails to parse."""
    nonce = secrets.token_hex(16)
    long: dict[str, LongText] = {}
    ranges: list[tuple[int, int, str]] = []
    at = 0
    # The skeleton's length less the text's, up to where the scan stands, in characters.
    shorter = 0
    # The first backslash at or after where the scan stands, found once and passed: the scan is
    # linear however the escapes and the strings fall.
    slash = text.find("\\")
    while True:
        opening = text.find('"', at)
        if opening == -1:
            break
        close = text.find('"', opening + 1)
        cursor = opening + 1
        escaped = False
        while close != -1:
            if slash != -1 and slash < cursor:
                slash = text.find("\\", cursor)
            if slash == -1 or slash > close:
                break
            escaped = True
            cursor = slash + 2
            if close < cursor:
                close = text.find('"', cursor)
        if close == -1:
            break
        at = close + 1
        # Only a value: a key stays as it is.
        found = None
        if not escaped and _longer(text, opening + 1, close, long_units):
            following = _space(text, at)
            if following >= len(text) or text[following] != ":":
                found = _classify(text, opening + 1, close)
        if found is not None:
            stub = _stand_in(found, f"{nonce}{len(long):08x}")
            long[stub] = found
            ranges.append((opening + 1, close, stub))
            shorter += close - opening - 1 - len(stub)
        # Characters count no more than code units: past the bound in characters is past it.
        if at - shorter > MAX_INLINE_FILE_TEXT:
            return None
    if len(text) - shorter > MAX_INLINE_FILE_TEXT:
        return None
    pieces: list[str] = []
    copied = 0
    for start, end, stub in ranges:
        pieces.append(text[copied:start])
        pieces.append(stub)
        copied = end
    pieces.append(text[copied:])
    skeleton = "".join(pieces)
    # Counted in UTF-16 code units, as the TypeScript SDK counts the skeleton.
    if utf16_size(skeleton, MAX_INLINE_FILE_TEXT) > MAX_INLINE_FILE_TEXT:
        return None
    return _Skeleton(skeleton, long)


@dataclass
class LargeMediaValue:
    """A media value read in place, with the long strings its stand-ins name."""

    media: MediaValue
    long: dict[str, LongText]


def read_large_media_text(
    key: str, text: str, long_units: int | None = None
) -> LargeMediaValue | None:
    """An attribute's recorded text read for files as ``read_media_text`` reads it, its long
    base64 and data: URL strings (longer than ``long_units``, ``LONG_STRING_UNITS`` by default)
    read in place; the edits of placed files apply to the recorded text itself. None for text
    whose JSON around those strings is over the 8 Mi bound, or that reading finds nothing in.
    Raises ValueError for JSON that does not parse."""
    if long_units is None:
        long_units = LONG_STRING_UNITS
    reading = reading_of(key)

    def whole() -> LargeMediaValue | None:
        # Text that is no JSON is the file itself when it is one long data: URL.
        if not _longer(text, 0, len(text), long_units):
            if utf16_size(text, MAX_INLINE_FILE_TEXT) > MAX_INLINE_FILE_TEXT:
                return None
            return LargeMediaValue(media_in(text), {})
        found = _classify(text, 0, len(text), raw=True) if text.startswith("data:") else None
        if found is None:
            return None
        stub = _stand_in(found, f"{secrets.token_hex(16)}{0:08x}")
        return LargeMediaValue(media_in(stub), {stub: found})

    def json_text(check: Callable[[Any], bool] | None = None) -> LargeMediaValue | None:
        skeleton = _skeleton_of(text, long_units)
        if skeleton is None:
            return None
        parsed = loads_message(skeleton.text)
        if check is not None and not check(parsed):
            return None
        if not reader_parses(parsed):
            return None
        return LargeMediaValue(media_in(parsed, text), skeleton.long)

    if reading == "json":
        return json_text()
    if reading == "metadata":
        return json_text() if _JSON_OBJECT_TEXT.match(text) else whole()
    if reading == "parts":
        if not _JSON_ARRAY_TEXT.match(text):
            return None
        return json_text(
            lambda parsed: (
                isinstance(parsed, list)
                and bool(parsed)
                and all(
                    isinstance(part, dict) and isinstance(part.get("type"), str) for part in parsed
                )
            )
        )
    if reading == "url":
        return whole()
    return None


@dataclass
class LongFileBytes:
    """A long file's bytes as ``media_bytes`` reads them, measured without being made: its size,
    whether it was decoded, the media type its data: URL names, and a source of its bytes."""

    source: ByteSource
    decoded: bool = True
    url_media_type: str | None = None
    bare_base64: bool = False

    @property
    def size(self) -> int:
        return self.source.size


def _base64_source(text: str, start: int, end: int) -> ByteSource:
    """Base64 from ``start`` to ``end`` of ``text`` (strict, padded to a multiple of four),
    decoded a slice at a time."""
    pad = (text[end - 1] == "=") + (text[end - 2] == "=")

    def chunks() -> Iterator[bytes]:
        for at in range(start, end, _BASE64_SLICE):
            yield binascii.a2b_base64(text[at : min(end, at + _BASE64_SLICE)])

    return ByteSource((end - start) // 4 * 3 - pad, chunks)


def _well_formed(text: str) -> str:
    """Text as JavaScript encodes it to UTF-8: a surrogate pair is its character, a lone surrogate
    U+FFFD."""
    if not _SURROGATE.search(text):
        return text
    return text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace")


def _percent_slices(text: str, start: int, end: int) -> Iterator[bytes]:
    """A data: URL's data without ``;base64``: each ``%XX`` escape its octet, any other character
    its UTF-8, a slice at a time, never splitting an escape or a surrogate pair."""
    at = start
    while at < end:
        stop = min(end, at + _TEXT_SLICE)
        if stop < end:
            # Never between the halves of a surrogate pair, nor inside a %XX escape: a step of at
            # most three characters back from a slice of 1 Mi, so every slice moves on.
            if "\ud800" <= text[stop - 1] <= "\udbff" and "\udc00" <= text[stop] <= "\udfff":
                stop -= 1
            if text[stop - 1] == "%":
                stop -= 1
            elif text[stop - 2] == "%":
                stop -= 2
        piece = _well_formed(text[at:stop])
        decoded = bytearray()
        begin = 0
        while (index := piece.find("%", begin)) != -1:
            decoded += piece[begin:index].encode("utf-8")
            decoded.append(int(piece[index + 1 : index + 3], 16))
            begin = index + 3
        decoded += piece[begin:].encode("utf-8")
        yield bytes(decoded)
        at = stop


def _percent_source(text: str, start: int, end: int) -> ByteSource:
    """A data: URL's data without ``;base64`` from ``start`` to ``end``, decoded a slice at a
    time; its size is measured by one decoding pass. Every ``%`` starts an escape (checked when
    the string was read)."""
    size = sum(len(piece) for piece in _percent_slices(text, start, end))
    return ByteSource(size, lambda: _percent_slices(text, start, end))


def long_file_bytes(file: InlineFilePart, long: LongText) -> LongFileBytes:
    """The bytes of a file whose content is a long string, as ``media_bytes`` reads them: a field
    its convention declares base64 decoded, base64 text decoded (``bare_base64``), a data: URL by
    its own encoding."""
    if long.kind == "base64":
        return LongFileBytes(
            _base64_source(long.text, long.start, long.end), bare_base64=not file.base64
        )
    source = (
        _base64_source(long.text, long.data, long.end)
        if long.kind == "dataBase64"
        else _percent_source(long.text, long.data, long.end)
    )
    media_type = (long.header or "").split(";")[0].strip(_ECMASCRIPT_WHITESPACE)
    return LongFileBytes(source, url_media_type=media_type or None)


def long_head(long: LongText, units: int) -> str:
    """The first ``units`` characters of a long string's content."""
    return long.text[long.start : min(long.end, long.start + units)]
