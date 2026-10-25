"""SDK span limits and cut sizes, retained only while the source span is alive."""

from __future__ import annotations

import os
import weakref
from dataclasses import dataclass
from typing import Any

from opentelemetry.attributes import BoundedAttributes
from opentelemetry.sdk.trace import SpanLimits


@dataclass(frozen=True)
class SpanBounds:
    value_length: int | None
    attribute_count: int | None


@dataclass
class _SpanFacts:
    source: weakref.ReferenceType[Any]
    bounds: SpanBounds | None
    cuts: dict[str, int]


_spans: dict[tuple[int, int], _SpanFacts] = {}


def _key(span: Any) -> tuple[int, int] | None:
    try:
        context = span.get_span_context()
        return (context.trace_id, context.span_id) if context.is_valid else None
    except Exception:
        return None


def _policy(value: Any) -> SpanBounds | None:
    try:
        limits = getattr(value, "_limits", None)
        attributes = getattr(value, "_attributes", None)
        if isinstance(limits, SpanLimits):
            length, count = limits.max_span_attribute_length, limits.max_span_attributes
        elif isinstance(attributes, BoundedAttributes):
            length, count = attributes.max_value_len, attributes.maxlen
        else:
            return None
        if any(
            item is not None and (type(item) is not int or item < 0) for item in (length, count)
        ):
            return None
        return SpanBounds(length, count)
    except Exception:
        return None


def remember_span(span: Any) -> None:
    key = _key(span)
    if key is None:
        return
    existing = _spans.get(key)
    if existing is not None and existing.source() is span:
        return

    def remove(reference: weakref.ReferenceType[Any]) -> None:
        entry = _spans.get(key)
        if entry is not None and entry.source is reference:
            _spans.pop(key, None)

    try:
        reference = weakref.ref(span, remove)
    except TypeError:
        return
    _spans[key] = _SpanFacts(reference, _policy(span), {})


def mark_cut(span: Any, key: str, original_bytes: int) -> None:
    if key not in {"input.value", "output.value"} or type(original_bytes) is not int:
        return
    if not 0 <= original_bytes <= (1 << 63) - 1:
        return
    context_key = _key(span)
    if context_key is None:
        return
    remember_span(span)
    entry = _spans.get(context_key)
    if entry is not None:
        entry.cuts[key] = original_bytes


def cuts_for(span: Any) -> dict[str, int]:
    key = _key(span)
    entry = _spans.get(key) if key is not None else None
    return dict(entry.cuts) if entry is not None else {}


def limits_for(value: Any) -> SpanBounds | None:
    key = _key(value)
    entry = _spans.get(key) if key is not None else None
    return entry.bounds if entry is not None else _policy(value)


def _after_fork() -> None:
    _spans.clear()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_after_fork)
