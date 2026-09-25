from __future__ import annotations

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


def json_value(value: Any, max_bytes: int = VALUE_BYTES) -> Any:
    """Validate before serialization; never coerce keys, NaN, dates or large Python integers.

    As the TypeScript SDK's ``json``, the value is read depth-first in order (an object's members
    by key), and each value is checked for its type before it is counted against the value, depth
    and byte bounds, so both SDKs refuse an output for the same reason. The byte count is that of
    the JSON text ``encode`` produces, kept as the value is read, so an output too large to
    serialize is refused without serializing it.
    """
    ancestors: set[int] = set()
    nodes = 0
    size = 0

    def charge(amount: int) -> None:
        nonlocal size
        size += amount
        if size > max_bytes:
            raise JsonLimitError("bytes", "JSON exceeds the byte limit.")

    def charge_text(text: str) -> None:
        # A string's JSON text is at least as long as the string, so one longer than what is left
        # is refused before it is escaped.
        if len(text) + 2 > max_bytes - size:
            raise JsonLimitError("bytes", "JSON exceeds the byte limit.")
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
            charge(len(item) + 1 if item else 2)
            # By UTF-16 code unit, as JavaScript sorts, so both SDKs read members in one order.
            for key in sorted(item, key=lambda key: key.encode("utf-16-be", "surrogatepass")):
                _text(key)
                charge_text(key)
                charge(1)
                visit(item[key], depth + 1)
        finally:
            # Repeated siblings serialize independently; only an active ancestor is a cycle.
            ancestors.discard(id(item))

    visit(value, 0)
    return value


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
