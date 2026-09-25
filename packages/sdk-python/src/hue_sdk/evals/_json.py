from __future__ import annotations

import hashlib
import json
import math
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


def json_value(value: Any, max_bytes: int = VALUE_BYTES) -> Any:
    """Validate before serialization; never coerce keys, NaN, dates or large Python integers."""
    pending = [(value, 0, False)]
    ancestors: set[int] = set()
    nodes = 0
    while pending:
        item, depth, leaving = pending.pop()
        if leaving:
            ancestors.remove(id(item))
            continue
        nodes += 1
        if nodes > VALUE_NODES or depth > VALUE_DEPTH:
            raise JsonLimitError("structure", "JSON exceeds depth or node limits.")
        if item is None or type(item) is bool:
            continue
        if type(item) is int and abs(item) <= 2**53 - 1:
            continue
        if type(item) is float and math.isfinite(item):
            continue
        if type(item) is str:
            if "\0" in item or any(0xD800 <= ord(char) <= 0xDFFF for char in item):
                raise ValueError("JSON contains invalid Unicode or NUL.")
            continue
        if type(item) not in (dict, list) or id(item) in ancestors:
            raise ValueError("Expected JSON without coercion or cycles.")
        ancestors.add(id(item))
        pending.append((item, depth, True))
        if isinstance(item, dict):
            if any(type(key) is not str for key in item):
                raise ValueError("JSON object keys must be strings.")
            pending.extend((key, depth + 1, False) for key in item)
            pending.extend((child, depth + 1, False) for child in item.values())
        else:
            pending.extend((child, depth + 1, False) for child in item)
    if len(encode(value)) > max_bytes:
        raise JsonLimitError("bytes", "JSON exceeds the byte limit.")
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
