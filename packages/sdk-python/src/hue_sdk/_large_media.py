"""Inline media in a value too long for the media inspection bounds, read without parsing it out.

A span's own attribute held whole for upload past the inspection bounds (8 Mi UTF-16 code units for
one attribute, 16 Mi for a record) is scanned once: every value string longer than
``LONG_STRING_UNITS`` that is recorded without escapes as strict base64 or a base64 ``data:`` URL
is replaced, in a skeleton of the JSON text, by a short stand-in of the same kind, and the skeleton
(within the 8 Mi bound) is read as Hue's reader reads the value. A file whose content is such a
string is then decoded, hashed and uploaded a slice at a time from its place in the recorded text,
never copied out of it whole; its placement edits the skeleton, and the strings no file replaced
are written back from the recorded text. No step reads more than ``WINDOW_UNITS`` of the text at
once, so other threads run between them. Mirrors the TypeScript SDK's ``large-media.ts``, so both
SDKs write the same bytes.
"""

from __future__ import annotations

import binascii
import re
import secrets
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any

from ._inline_files import (
    MAX_INLINE_FILE_TEXT,
    InlineFilePart,
    MediaValue,
    data_url_media_type,
    loads_message,
    media_in,
    placed_media_text,
    reader_parses,
    reading_of,
    utf16_size,
)

# A value string longer than this, in code units, is read in place when it is base64 or a base64
# data: URL recorded without escapes. Longer than every label Hue's reader matches (256 units), so
# a stand-in decides every test of the walk as the string itself does.
LONG_STRING_UNITS = 16 * 1024
# The most of a value read in one step: files are decoded and hashed, and the text scanned, a
# window at a time.
WINDOW_UNITS = 1024 * 1024

_ALPHABET = re.compile(r"[A-Za-z0-9+/]*")
_BASE64 = re.compile(r"[A-Za-z0-9+/]*={0,2}")
_CONTROL = re.compile(r"[\x00-\x1f]")
# The longest data: URL header read in place, in characters: a string with a longer one is parsed
# with the rest of the value.
_MAX_HEADER_UNITS = 4096
_SPACE = re.compile(r"[ \t\n\r]*")
_ASTRAL = re.compile("[\U00010000-\U0010ffff]")
_JSON_OBJECT_TEXT = re.compile(r"\s*[\[{]")
_JSON_ARRAY_TEXT = re.compile(r"\s*\[")


class ByteSource:
    """A source of bytes read a slice at a time: an upload body that is never held whole.
    ``chunks`` may be called again for a retried upload, and starts fresh each time;
    ``changed`` is set when the latest read found the source no longer holds the bytes it was
    recorded with."""

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


def _strict_base64(text: str, start: int, end: int) -> bool:
    """Whether ``text`` from ``start`` to ``end`` is strict base64 (padded to a multiple of four),
    checked a window at a time."""
    if (end - start) % 4:
        return False
    for at in range(start, end, WINDOW_UNITS):
        stop = min(end, at + WINDOW_UNITS)
        # Padding only closes the whole string.
        if (_BASE64 if stop == end else _ALPHABET).fullmatch(text, at, stop) is None:
            return False
    return True


def _classify(text: str, start: int, end: int, raw: bool = False) -> LongText | None:
    """How the content from ``start`` to ``end`` of ``text`` (a string literal's, without escapes,
    or with ``raw`` the whole text of a value that is no JSON) is read in place, if it is: strict
    base64, or a data: URL declaring ``;base64`` whose data is strict base64. None for any other
    text, which is parsed with the rest of the value (a percent-escaped data: URL included); a
    string literal whose header holds a control character, which no JSON does, is left for the
    parse to refuse."""
    if text.startswith("data:", start):
        # The comma is looked for within the string and the header's bound only.
        comma = text.find(",", start + 5, min(end, start + 5 + _MAX_HEADER_UNITS + 1))
        if comma == -1:
            return None
        header = text[start + 5 : comma]
        if (not raw and _CONTROL.search(header)) or not _base64_header(header):
            return None
        if not _strict_base64(text, comma + 1, end):
            return None
        return LongText(text, start, end, comma + 1, "dataBase64", header)
    if not _strict_base64(text, start, end):
        return None
    return LongText(text, start, end, start, "base64")


def _stand_in(long: LongText, tag: str) -> str:
    """The stand-in for a long string in the skeleton: its kind kept (base64 and its first 16
    characters, which name an audio container; a data: URL's header), longer than any label, and
    unique by ``tag``."""
    fill = f"{tag}{'A' * 472}"
    if long.kind == "base64":
        return f"{long.text[long.start : long.start + 16]}{fill}"
    return f"data:{long.header},{fill}"


def _space(text: str, at: int) -> int:
    """The index past the whitespace JSON allows from ``at``."""
    match = _SPACE.match(text, at)
    return match.end() if match else at


def _find(text: str, character: str, start: int, end: int) -> int:
    """The first ``character`` of ``text`` from ``start`` before ``end``, or -1, looked for a
    window at a time."""
    at = start
    while at < end:
        stop = min(end, at + WINDOW_UNITS)
        found = text.find(character, at, stop)
        if found != -1:
            return found
        at = stop
    return -1


def _escaped_quote(text: str, at: int) -> bool:
    """Whether the quote at ``at`` is escaped: whether an odd run of backslashes ends just before
    it. A string's run stops at its opening quote. The run is read back in windows that double,
    so each backslash is read at most twice."""
    run = 0
    end = at
    width = 16
    while end > 0:
        begin = max(0, end - width)
        piece = text[begin:end]
        kept = len(piece.rstrip("\\"))
        run += len(piece) - kept
        if kept:
            break
        end = begin
        width = min(2 * width, WINDOW_UNITS)
    return run % 2 == 1


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
    nonce: str = ""


def _skeleton_of(text: str, long_units: int) -> _Skeleton | None:
    """The skeleton of JSON ``text``: each value string longer than ``long_units`` and recorded
    without escapes as base64 or a base64 data: URL replaced by its stand-in. None once the
    skeleton is longer than ``MAX_INLINE_FILE_TEXT`` code units: the scan stops there, so the text
    it reads and the skeleton it makes stay within that bound however long the value is. A string
    the scan finds unterminated (text that is no JSON) ends the scan; the skeleton then holds the
    rest as recorded and fails to parse."""
    nonce = secrets.token_hex(16)
    long: dict[str, LongText] = {}
    ranges: list[tuple[int, int, str]] = []
    size = len(text)
    at = 0
    # The skeleton's length less the text's, up to where the scan stands, in characters.
    shorter = 0
    while True:
        opening = _find(text, '"', at, size)
        if opening == -1:
            break
        # The string's end: its first quote after an even run of backslashes, found quote by
        # quote, not escape by escape.
        close = _find(text, '"', opening + 1, size)
        escaped = close != -1 and _find(text, "\\", opening + 1, close) != -1
        while escaped and close != -1:
            # A string with an escape is kept as recorded: once it passes the bound, so does the
            # skeleton, and its run of backslashes is no longer than the bound.
            if close - shorter > MAX_INLINE_FILE_TEXT:
                return None
            if not _escaped_quote(text, close):
                break
            close = _find(text, '"', close + 1, size)
        if close == -1:
            break
        at = close + 1
        # Only a value: a key stays as it is.
        found = None
        if not escaped and _longer(text, opening + 1, close, long_units):
            following = _space(text, at)
            if following >= size or text[following] != ":":
                found = _classify(text, opening + 1, close)
        if found is not None:
            stub = _stand_in(found, f"{nonce}{len(long):08x}")
            long[stub] = found
            ranges.append((opening + 1, close, stub))
            shorter += close - opening - 1 - len(stub)
        # Characters count no more than code units: past the bound in characters is past it.
        if at - shorter > MAX_INLINE_FILE_TEXT:
            return None
    if size - shorter > MAX_INLINE_FILE_TEXT:
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
    return _Skeleton(skeleton, long, nonce)


@dataclass
class LargeMediaValue:
    """A media value read in place, with the long strings its stand-ins name. Its ``source`` is
    the skeleton: placing its files edits the skeleton, and ``placed_large_text`` writes the long
    strings back."""

    media: MediaValue
    long: dict[str, LongText]
    # What every stand-in's tag starts with, followed by its index in ``order`` as eight hex
    # digits: one forward scan for it finds every stand-in left in a placed text.
    nonce: str = ""
    order: list[str] = field(default_factory=list)


def read_large_media_text(
    key: str, text: str, long_units: int | None = None
) -> LargeMediaValue | None:
    """An attribute's recorded text read for files as ``read_media_text`` reads it, its long
    base64 and base64 data: URL strings (longer than ``long_units``, ``LONG_STRING_UNITS`` by
    default) read in place. None for text whose JSON around those strings is over the 8 Mi bound,
    or that reading finds nothing in. Raises ValueError for JSON that does not parse, except text
    read by JSON convention that is a data: URL, which is no JSON: it is read as the text itself,
    as ``read_media_text`` reads it."""
    if long_units is None:
        long_units = LONG_STRING_UNITS
    reading = reading_of(key)

    def whole() -> LargeMediaValue | None:
        # Text that is no JSON is the file itself when it is one long base64 data: URL; other
        # text is read as ``read_media_text`` reads it, within the 8 Mi bound.
        found = (
            _classify(text, 0, len(text), raw=True)
            if text.startswith("data:") and _longer(text, 0, len(text), long_units)
            else None
        )
        if found is None:
            if utf16_size(text, MAX_INLINE_FILE_TEXT) > MAX_INLINE_FILE_TEXT:
                return None
            return LargeMediaValue(media_in(text), {})
        nonce = secrets.token_hex(16)
        stub = _stand_in(found, f"{nonce}{0:08x}")
        return LargeMediaValue(media_in(stub), {stub: found}, nonce, [stub])

    def json_text(check: Callable[[Any], bool] | None = None) -> LargeMediaValue | None:
        skeleton = _skeleton_of(text, long_units)
        if skeleton is None:
            return None
        parsed = loads_message(skeleton.text)
        if check is not None and not check(parsed):
            return None
        if not reader_parses(parsed):
            return None
        return LargeMediaValue(
            media_in(parsed, skeleton.text), skeleton.long, skeleton.nonce, list(skeleton.long)
        )

    if reading == "json":
        # Text that is no JSON is the text itself: a whole data: URL is the file.
        return whole() if text.startswith("data:") else json_text()
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


class JoinedText:
    """Text made of pieces of other strings, not yet copied into one: the recorded text with its
    files placed, whose long strings no file replaced are still pieces of the recorded text. It
    is read a window at a time, and made one string only when it is short enough to keep inline,
    so a long remainder is never held in two copies."""

    def __init__(self, pieces: list[tuple[str, int, int]]) -> None:
        self._pieces = [(text, start, end) for text, start, end in pieces if end > start]
        self.length = sum(end - start for _, start, end in self._pieces)

    def windows(self) -> Iterator[str]:
        """The text a window at a time."""
        for text, start, end in self._pieces:
            for at in range(start, end, WINDOW_UNITS):
                yield text[at : min(end, at + WINDOW_UNITS)]

    def utf8(self) -> Iterator[bytes]:
        """The text's UTF-8 as JavaScript encodes it (a lone surrogate as U+FFFD), a window at a
        time, never between the halves of a surrogate pair."""
        from ._blobs import utf8_slices

        for text, start, end in self._pieces:
            yield from utf8_slices(text, start, end)

    def head(self, characters: int) -> str:
        """The first ``characters`` characters."""
        out: list[str] = []
        left = characters
        for text, start, end in self._pieces:
            if left <= 0:
                break
            out.append(text[start : min(end, start + left)])
            left -= min(end - start, left)
        return "".join(out)

    def tail(self, characters: int) -> str:
        """The last ``characters`` characters."""
        out: list[str] = []
        left = characters
        for text, start, end in reversed(self._pieces):
            if left <= 0:
                break
            out.append(text[max(start, end - left) : end])
            left -= min(end - start, left)
        return "".join(reversed(out))

    def text(self) -> str:
        """The text as one string."""
        return "".join(text[start:end] for text, start, end in self._pieces)

    def utf8_size(self) -> int:
        """The text's UTF-8 size, counted a window at a time."""
        return sum(len(window) for window in self.utf8())

    def source(self, size: int) -> ByteSource:
        """The text's UTF-8, a window at a time."""
        return ByteSource(size, self.utf8)


def placed_large_text(media: LargeMediaValue) -> str | JoinedText:
    """The recorded text once the files of a value read in place are placed: the skeleton with
    the placements' edits, and each stand-in no placement replaced written back as the string it
    stands for. Every byte the placements do not change is the recorded text's. Text that keeps a
    long string is returned as its pieces (``JoinedText``), not copied into one string."""
    edited = placed_media_text(media.media)
    if not media.order:
        return edited
    # One forward scan for the stand-ins' shared nonce finds each one left, in order, by the index
    # its tag carries: linear in the text however many there are.
    pieces: list[tuple[str, int, int]] = []
    start = 0
    at = edited.find(media.nonce)
    while at != -1:
        try:
            stub = media.order[int(edited[at + 32 : at + 40], 16)]
        except (ValueError, IndexError):
            stub = None
        begin = at - stub.find(media.nonce) if stub is not None else -1
        if stub is not None and begin >= start and edited.startswith(stub, begin):
            long = media.long[stub]
            pieces.append((edited, start, begin))
            pieces.append((long.text, long.start, long.end))
            start = begin + len(stub)
            at = edited.find(media.nonce, start)
        else:
            at = edited.find(media.nonce, at + 1)
    if not pieces:
        return edited
    pieces.append((edited, start, len(edited)))
    return JoinedText(pieces)


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
    decoded a window at a time."""
    pad = (text[end - 1] == "=") + (text[end - 2] == "=")

    def chunks() -> Iterator[bytes]:
        for at in range(start, end, WINDOW_UNITS):
            yield binascii.a2b_base64(text[at : min(end, at + WINDOW_UNITS)])

    return ByteSource((end - start) // 4 * 3 - pad, chunks)


def long_file_bytes(file: InlineFilePart, long: LongText) -> LongFileBytes:
    """The bytes of a file whose content is a long string, as ``media_bytes`` reads them: a field
    its convention declares base64 decoded, base64 text decoded (``bare_base64``), a base64 data:
    URL."""
    source = _base64_source(long.text, long.data, long.end)
    if long.kind == "base64":
        return LongFileBytes(source, bare_base64=not file.base64)
    return LongFileBytes(source, url_media_type=data_url_media_type(long.header or "") or None)


def long_head(long: LongText, units: int) -> str:
    """The first ``units`` characters of a long string's content."""
    return long.text[long.start : min(long.end, long.start + units)]
