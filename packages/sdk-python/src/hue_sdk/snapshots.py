"""Bounded value snapshots for the records retained by Hue's processors.

Only OTLP value containers are copied; contexts, locks and arbitrary application
object graphs are never deep-copied. Byte accounting is performed on the resulting
owned record, so later changes by a caller or another processor cannot grow it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from copy import copy
from math import isfinite
from typing import Any

from opentelemetry.attributes import BoundedAttributes
from opentelemetry.context import Context
from opentelemetry.sdk._logs import ReadableLogRecord, ReadWriteLogRecord
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import Event, ReadableSpan
from opentelemetry.sdk.util.instrumentation import InstrumentationScope
from opentelemetry.trace import Link, Status

from .transport import MAX_REQUEST_BYTES

MAX_CONTENT_SNAPSHOT_BYTES = 1_048_576
MAX_CONTENT_SNAPSHOT_DEPTH = 64
MAX_CONTENT_SNAPSHOT_NODES = 65_536
MAX_CONTENT_INTEGER_BITS = 14_000


class _ContentBudget:
    """Copy only built-in JSON values; never invoke application copy/iteration hooks."""

    def __init__(self) -> None:
        self.remaining_bytes = MAX_CONTENT_SNAPSHOT_BYTES
        self.remaining_nodes = MAX_CONTENT_SNAPSHOT_NODES
        self.active: set[int] = set()

    def consume(self, size: int) -> None:
        self.remaining_bytes -= size
        if self.remaining_bytes < 0:
            raise ValueError("Content snapshot exceeds its value budget.")

    def value(self, value: Any, depth: int = 0) -> Any:
        self.remaining_nodes -= 1
        self.consume(8)
        if self.remaining_nodes < 0 or depth > MAX_CONTENT_SNAPSHOT_DEPTH:
            raise ValueError("Content snapshot exceeds its traversal limit.")
        kind = type(value)
        if value is None or kind is bool:
            return value
        if kind is str:
            if len(value) > self.remaining_bytes:
                raise ValueError("Content snapshot exceeds its value budget.")
            self.consume(len(value.encode("utf-8")))
            return value
        if kind is int:
            # Decimal conversion can be superlinear even when it fits the byte
            # budget. Do not depend on the interpreter's configurable digit cap.
            if value.bit_length() > MAX_CONTENT_INTEGER_BITS:
                raise ValueError("Content integer exceeds its conversion limit.")
            self.consume((value.bit_length() * 30103) // 100000 + 2)
            return value
        if kind is float and isfinite(value):
            self.consume(24)
            return value
        if kind is not dict and kind is not list and kind is not tuple:
            raise ValueError("Content must contain only built-in JSON values.")
        identity = id(value)
        if identity in self.active:
            raise ValueError("Content snapshot cannot contain cycles.")
        self.active.add(identity)
        try:
            if kind is dict:
                result = {}
                for key, item in value.items():
                    key_kind = type(key)
                    if (
                        key is not None
                        and key_kind is not str
                        and key_kind is not bool
                        and key_kind is not int
                        and key_kind is not float
                    ):
                        raise ValueError("Content contains an unsupported object key.")
                    result[self.value(key, depth + 1)] = self.value(item, depth + 1)
                return result
            items = [self.value(item, depth + 1) for item in value]
            return tuple(items) if kind is tuple else items
        finally:
            self.active.remove(identity)


def snapshot_content(value: Any) -> Any:
    """Detach nested mutable content before exposing it to a user redactor."""
    return _ContentBudget().value(value)


class _ValueBudget:
    def __init__(self) -> None:
        self.remaining = MAX_REQUEST_BYTES

    def consume(self, size: int) -> None:
        self.remaining -= size
        if self.remaining < 0:
            raise ValueError("Telemetry snapshot exceeds its budget.")

    def value(self, value: Any, depth: int = 0) -> Any:
        # Conservative per-value work/storage bound, separate from exact protobuf
        # admission bytes. Reject excessive nesting and cycles without retaining
        # or traversing arbitrarily large application objects.
        self.consume(8)
        if depth > 64:
            raise ValueError("Telemetry snapshot exceeds its nesting limit.")
        if value is None or isinstance(value, bool):
            return value
        if isinstance(value, float):
            return float.__float__(value)
        if isinstance(value, int):
            self.consume((int.bit_length(value) + 7) // 8)
            return int.__int__(value)
        if isinstance(value, (str, bytes)):
            if len(value) > self.remaining:
                raise ValueError("Telemetry snapshot exceeds its budget.")
            if isinstance(value, str):
                self.consume(len(str.encode(value, "utf-8")))
                return str.__str__(value)
            self.consume(len(value))
            return value if type(value) is bytes else memoryview(value).tobytes()
        if isinstance(value, Mapping):
            result = {}
            for key, item in value.items():
                if not isinstance(key, str):
                    raise ValueError("Telemetry mapping keys must be strings.")
                result[self.value(key, depth + 1)] = self.value(item, depth + 1)
            return result
        if isinstance(value, Sequence):
            return tuple(self.value(item, depth + 1) for item in value)
        raise ValueError("Unsupported telemetry snapshot value.")

    def attributes(self, values: Any, dropped: int = 0) -> BoundedAttributes:
        result = BoundedAttributes(
            attributes=self.value(values or {}), immutable=True, extended_attributes=True
        )
        result.dropped += dropped
        return result

    def resource(self, resource: Resource | None) -> Resource:
        if resource is None:
            return Resource({})
        return Resource(self.value(resource.attributes), self.value(resource.schema_url))

    def scope(self, scope: InstrumentationScope | None) -> InstrumentationScope | None:
        if scope is None:
            return None
        return InstrumentationScope(
            self.value(scope.name),
            self.value(scope.version),
            self.value(scope.schema_url),
            self.value(scope.attributes),
        )


class _SpanSnapshot(ReadableSpan):
    def __init__(self, span: ReadableSpan) -> None:
        budget = _ValueBudget()
        super().__init__(
            name=budget.value(span.name),
            context=span.context,
            parent=span.parent,
            resource=budget.resource(span.resource),
            attributes=budget.attributes(span.attributes, span.dropped_attributes),
            events=tuple(
                Event(
                    budget.value(event.name),
                    budget.attributes(event.attributes, event.dropped_attributes),
                    event.timestamp,
                )
                for event in span.events
            ),
            links=tuple(
                Link(link.context, budget.attributes(link.attributes, link.dropped_attributes))
                for link in span.links
            ),
            kind=span.kind,
            status=Status(span.status.status_code, budget.value(span.status.description)),
            start_time=span.start_time,
            end_time=span.end_time,
            instrumentation_scope=budget.scope(span.instrumentation_scope),
        )
        self._snapshot_dropped_events = span.dropped_events
        self._snapshot_dropped_links = span.dropped_links

    @property
    def dropped_events(self) -> int:
        return self._snapshot_dropped_events

    @property
    def dropped_links(self) -> int:
        return self._snapshot_dropped_links


def snapshot_span(span: ReadableSpan) -> ReadableSpan:
    return _SpanSnapshot(span)


def snapshot_log(log_record: ReadWriteLogRecord) -> ReadableLogRecord:
    budget = _ValueBudget()
    record = copy(log_record.log_record)
    record.context = Context()
    record.body = budget.value(record.body)
    record.attributes = budget.attributes(record.attributes, log_record.dropped_attributes)
    record.event_name = budget.value(record.event_name)
    record.severity_text = budget.value(record.severity_text)
    return ReadableLogRecord(
        log_record=record,
        resource=budget.resource(log_record.resource),
        instrumentation_scope=budget.scope(log_record.instrumentation_scope),
        limits=log_record.limits,
    )
