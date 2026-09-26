from __future__ import annotations

import functools
import hashlib
import json
import math
import re
from typing import Any
from uuid import UUID


class _Missing:
    def __repr__(self) -> str:
        return "MISSING"


MISSING = _Missing()
VALUE_BYTES = 200_000
VALUE_NODES = 20_000
VALUE_DEPTH = 32


class JsonLimitError(ValueError):
    """JSON that is valid but beyond the size (``bytes``) or the count and depth
    (``structure``) bounds."""

    def __init__(self, limit: str, message: str) -> None:
        super().__init__(message)
        self.limit = limit


# A lone surrogate, found at C speed rather than character by character.
_SURROGATE = re.compile("[\ud800-\udfff]")


def _text(value: str) -> None:
    # An ASCII string, which CPython knows without scanning, cannot hold a surrogate.
    if "\0" in value or (not value.isascii() and _SURROGATE.search(value)):
        raise ValueError("JSON contains invalid Unicode or NUL.")


_ASTRAL = re.compile("[\U00010000-\U0010ffff]")
_ABOVE_SURROGATES = re.compile("[\ue000-\uffff]")


def _utf16_units(character: str) -> tuple[int, ...]:
    code = ord(character)
    if code < 0x10000:
        return (code,)
    code -= 0x10000
    return (0xD800 + (code >> 10), 0xDC00 + (code & 0x3FF))


def _compare_utf16(left: str, right: str) -> int:
    # Skip a shared prefix a chunk at a time, then find the first difference in the chunk that
    # differs by halves, all at C speed, so a long key is walked quickly and never copied whole.
    index, end = 0, min(len(left), len(right))
    while index < end and left[index : index + 65536] == right[index : index + 65536]:
        index += 65536
    size = 1 << min(16, max(end - index, 0).bit_length())
    while size > 1:
        size //= 2
        if left[index : index + size] == right[index : index + size]:
            index += size
    if index < end:
        return -1 if _utf16_units(left[index]) < _utf16_units(right[index]) else 1
    return len(left) - len(right)


def _utf16_order(keys: list[str]) -> list[str]:
    """Keys in UTF-16 code unit order, as JavaScript sorts them, without encoding them."""
    # Code point order differs only between a character above U+FFFF and one from U+E000.
    if not (
        any(_ASTRAL.search(key) for key in keys)
        and any(_ABOVE_SURROGATES.search(key) for key in keys)
    ):
        return sorted(keys)
    return sorted(keys, key=functools.cmp_to_key(_compare_utf16))


def _is_array_index(key: str) -> bool:
    """Whether JavaScript lists ``key`` among an object's array indices, ahead of its other keys."""
    return (
        len(key) <= 10
        and key.isascii()
        and key.isdigit()
        and (key == "0" or key[0] != "0")
        and int(key) < 2**32 - 1
    )


def _js_order(keys: list[str]) -> list[str]:
    """Keys in the order JavaScript lists an object's own keys: its array indices in numeric order,
    then the others as inserted."""
    indices = [key for key in keys if _is_array_index(key)]
    if not indices:
        return keys
    return sorted(indices, key=int) + [key for key in keys if not _is_array_index(key)]


class _PastByteBound(Exception):
    """Raised within ``json_value`` when the byte bound is passed, which is checked last."""


def json_value(value: Any, max_bytes: int = VALUE_BYTES) -> Any:
    """Validate before serialization; never coerce keys, NaN, dates or large Python integers.

    As the TypeScript SDK's ``json``, the value is read depth-first in order (an object's members
    by key), and each value is checked for its type before it is counted against the value, depth
    and byte bounds, so both SDKs refuse an output for the same reason. The byte count is that of
    the JSON text ``encode`` produces, kept as the value is read, so an output too large to
    serialize is refused without serializing it. The byte bound is checked last, as it was before
    it was counted as the value is read: past it, the value is read again, as in TypeScript, and
    one holding a value that is not JSON, or past the value or depth bound, is refused for that.
    """
    ancestors: set[int] = set()
    nodes = 0
    size = 0
    # Once the byte bound is passed, the value is read again only to check it (below).
    checking = False

    def charge(amount: int) -> None:
        nonlocal size
        if checking:
            return
        size += amount
        if size > max_bytes:
            raise _PastByteBound

    def charge_text(text: str) -> None:
        if checking:
            return
        # A string's JSON text is at least as long as the string, so one longer than what is left
        # is refused before it is escaped.
        if len(text) + 2 > max_bytes - size:
            raise _PastByteBound
        charge(len(json.dumps(text, ensure_ascii=False).encode("utf-8")))

    def visit(item: Any, depth: int) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > VALUE_NODES or depth > VALUE_DEPTH:
            raise JsonLimitError("structure", "JSON exceeds depth or node limits.")
        if item is None or type(item) is bool:
            charge(5 if item is False else 4)
            return
        if type(item) is int and abs(item) <= 2**53 - 1:
            charge(len(str(item)))
            return
        if type(item) is float and math.isfinite(item):
            charge(len(json.dumps(item)))
            return
        if type(item) is str:
            _text(item)
            charge_text(item)
            return
        if type(item) not in (dict, list) or id(item) in ancestors:
            raise ValueError("Expected JSON without coercion or cycles.")
        # Each element or member is a value: a container with more than the values left is
        # refused before it is read.
        if len(item) > VALUE_NODES - nodes:
            raise JsonLimitError("structure", "JSON exceeds depth or node limits.")
        ancestors.add(id(item))
        try:
            if type(item) is list:
                charge(len(item) + 1 if item else 2)
                for child in item:
                    visit(child, depth + 1)
                return
            # Keys are checked but, as in the TypeScript SDK, not counted as values.
            if any(type(key) is not str for key in item):
                raise ValueError("JSON object keys must be strings.")
            # Keys whose JSON text alone (at least their code points, two quotes and a colon each)
            # needs more bytes than are left pass the byte bound before they are sorted, as in the
            # TypeScript SDK, so both read such an object the same way.
            key_bytes = 0
            for key in item if not checking else ():
                key_bytes += len(key) + 3
                if key_bytes > max_bytes - size:
                    raise _PastByteBound
            charge(len(item) + 1 if item else 2)
            for key in _js_order(list(item)) if checking else _utf16_order(list(item)):
                _text(key)
                charge_text(key)
                charge(1)
                visit(item[key], depth + 1)
        finally:
            # Repeated siblings serialize independently; only an active ancestor is a cycle.
            ancestors.discard(id(item))

    try:
        visit(value, 0)
        return value
    except _PastByteBound:
        pass
    # Read again with each object's keys in the order JavaScript lists them, as the TypeScript SDK
    # reads it again, and nothing is counted, escaped or sorted, which takes time linear in it.
    checking = True
    nodes = 0
    visit(value, 0)
    raise JsonLimitError("bytes", "JSON exceeds the byte limit.")


def encode(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")


def digest(value: Any) -> str:
    return hashlib.sha256(encode(json_value(value, 8 * 1024 * 1024))).hexdigest()


def uuid(value: str) -> str:
    try:
        if not isinstance(value, str) or str(UUID(value)) != value.lower():
            raise ValueError
    except (ValueError, AttributeError):
        raise ValueError("Expected a UUID.") from None
    return value


def json_equal(left: Any, right: Any) -> bool:
    # Python bool is a subclass of int; JSON booleans and numbers remain distinct.
    if type(left) in (int, float) and type(right) in (int, float):
        return left == right
    if type(left) is not type(right):
        return False
    if isinstance(left, list):
        return len(left) == len(right) and all(
            json_equal(a, b) for a, b in zip(left, right, strict=True)
        )
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(
            json_equal(left[key], right[key]) for key in left
        )
    return left == right
