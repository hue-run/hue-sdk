"""Bounded value snapshots for the records retained by Hue's processors.

Only OTLP value containers are copied; contexts, locks and arbitrary application
object graphs are never deep-copied. Byte accounting is performed on the resulting
owned record, so later changes by a caller or another processor cannot grow it.
"""

from __future__ import annotations

import os
import threading
from collections.abc import Mapping, Sequence
from copy import copy
from math import isfinite
from typing import Any

from opentelemetry.attributes import BoundedAttributes
from opentelemetry.context import Context
from opentelemetry.sdk._logs import ReadableLogRecord, ReadWriteLogRecord
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import Event, ReadableSpan
from opentelemetry.sdk.trace.id_generator import RandomIdGenerator
from opentelemetry.sdk.util.instrumentation import InstrumentationScope
from opentelemetry.trace import Link, SpanContext, Status, format_span_id

from .transport import (
    MAX_REQUEST_BYTES,
    PENDING_PARENT_KEY,
    PENDING_SPAN_TYPE,
    PENDING_SPAN_TYPE_KEY,
    PendingSpan,
)

MAX_CONTENT_SNAPSHOT_BYTES = 1_048_576
MAX_CONTENT_SNAPSHOT_DEPTH = 64
MAX_CONTENT_SNAPSHOT_NODES = 65_536
MAX_CONTENT_INTEGER_BITS = 14_000
MAX_PLACEHOLDER_VALUE_BYTES = 65_536
# Reserved for placeholders: a finished span must never read as one.
_PENDING_MARKERS = (PENDING_SPAN_TYPE_KEY, PENDING_PARENT_KEY)
# Large and rarely useful while a span runs; the finished span still carries them. Copied
# markers would misplace the placeholder.
_PLACEHOLDER_OMITTED_KEYS = (
    "gen_ai.tool.definitions",
    "gen_ai.system_instructions",
    *_PENDING_MARKERS,
)
_span_ids = RandomIdGenerator()


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


# Attribute keys (and their dotted children) removed in metadata-only mode. Mirrors the
# TypeScript SDK so both export paths strip the same GenAI, OpenInference, OpenLLMetry
# and Vercel AI SDK content fields regardless of which instrumentor produced them.
CONTENT_PREFIXES: tuple[str, ...] = (
    "gen_ai.input.messages",
    "gen_ai.output.messages",
    "gen_ai.system_instructions",
    "gen_ai.prompt",
    "gen_ai.completion",
    "gen_ai.tool.call.arguments",
    "gen_ai.tool.call.result",
    "gen_ai.tool.definitions",
    "gen_ai.event.content",
    "llm.input_messages",
    "llm.output_messages",
    "llm.prompts",
    "llm.completions",
    "llm.invocation_parameters",
    "llm.prompt_template.template",
    "llm.prompt_template.variables",
    "llm.tools",
    "llm.function_call",
    "llm.choices",
    "input.value",
    "output.value",
    "input.images",
    "output.images",
    "retrieval.documents",
    "embedding.embeddings",
    "reranker.query",
    "reranker.input_documents",
    "reranker.output_documents",
    "ai.prompt",
    "ai.response.text",
    "ai.response.object",
    "ai.response.reasoning",
    "ai.response.files",
    "ai.response.toolCalls",
    "ai.response.body",
    "ai.toolCall.args",
    "ai.toolCall.result",
    "ai.value",
    "ai.values",
    "ai.embedding",
    "ai.embeddings",
    "traceloop.entity.input",
    "traceloop.entity.output",
    "tool.parameters",
    "exception.message",
    "exception.stacktrace",
)
_LEGACY_CONTENT_EVENTS = (
    "gen_ai.system",
    "gen_ai.user",
    "gen_ai.assistant",
    "gen_ai.tool",
    "gen_ai.choice",
)


def is_content_key(key: str) -> bool:
    return any(key == prefix or key.startswith(prefix + ".") for prefix in CONTENT_PREFIXES)


def _is_legacy_content_event(name: str) -> bool:
    return any(name == prefix or name.startswith(prefix + ".") for prefix in _LEGACY_CONTENT_EVENTS)


class _ValueBudget:
    def __init__(self, capture_content: bool = True) -> None:
        self.remaining = MAX_REQUEST_BYTES
        self.capture_content = capture_content

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

    def permitted(self, values: Any) -> Any:
        """Apply the content policy: metadata-only mode drops recognized content keys."""
        source = values or {}
        if not self.capture_content and isinstance(source, Mapping):
            source = {
                key: item
                for key, item in source.items()
                if not (isinstance(key, str) and is_content_key(key))
            }
        return source

    def attributes(self, values: Any, dropped: int = 0) -> BoundedAttributes:
        result = BoundedAttributes(
            attributes=self.value(self.permitted(values)), immutable=True, extended_attributes=True
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
    def __init__(self, span: ReadableSpan, capture_content: bool = True) -> None:
        budget = _ValueBudget(capture_content)
        attributes: Any = span.attributes
        if attributes and any(key in attributes for key in _PENDING_MARKERS):
            # Placeholder markers are reserved: a finished span must never read as one.
            attributes = {k: v for k, v in attributes.items() if k not in _PENDING_MARKERS}
        super().__init__(
            name=budget.value(span.name),
            context=span.context,
            parent=span.parent,
            resource=budget.resource(span.resource),
            attributes=budget.attributes(attributes, span.dropped_attributes),
            events=tuple(
                Event(
                    budget.value(event.name),
                    budget.attributes(event.attributes, event.dropped_attributes),
                    event.timestamp,
                )
                for event in span.events
                if capture_content or not _is_legacy_content_event(event.name)
            ),
            links=tuple(
                Link(link.context, budget.attributes(link.attributes, link.dropped_attributes))
                for link in span.links
            ),
            kind=span.kind,
            status=Status(
                span.status.status_code,
                budget.value(span.status.description) if capture_content else None,
            ),
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


def snapshot_span(span: ReadableSpan, capture_content: bool = True) -> ReadableSpan:
    return _SpanSnapshot(span, capture_content)


# The export worker holds an application span's lock while it copies attributes. A fork waits
# for that copy, so no child process inherits a span lock held by a thread it does not have.
_FORK_GUARD = threading.Lock()
if hasattr(os, "register_at_fork"):
    os.register_at_fork(
        before=_FORK_GUARD.acquire,
        after_in_parent=_FORK_GUARD.release,
        after_in_child=_FORK_GUARD.release,
    )


def _live_attributes(span: ReadableSpan) -> dict[str, Any]:
    """Copy an open span's attributes while its application thread may still set more.

    The SDK span lock guards ``set_attribute``/``set_attributes``, so holding it makes the
    key listing and value reads one consistent view even while limits evict keys.
    """
    lock = getattr(span, "_lock", None)
    if lock is None:
        return dict(span.attributes or {})
    with _FORK_GUARD, lock:
        return dict(span.attributes or {})


def _placeholder_omits(key: str) -> bool:
    return any(
        key == omitted or key.startswith(omitted + ".") for omitted in _PLACEHOLDER_OMITTED_KEYS
    )


def _value_bytes(value: Any, limit: int) -> int:
    """Conservative serialized size of an attribute value, stopping past ``limit``."""
    if isinstance(value, (str, bytes)):
        if len(value) > limit:
            return len(value)
        return len(value.encode("utf-8")) if isinstance(value, str) else len(value)
    if isinstance(value, Mapping):
        total = 0
        for key, item in value.items():
            total += len(key) + _value_bytes(item, limit - total)
            if total > limit:
                break
        return total
    if isinstance(value, Sequence):
        total = 0
        for item in value:
            total += _value_bytes(item, limit - total)
            if total > limit:
                break
        return total
    return 8


def snapshot_pending_span(span: ReadableSpan, capture_content: bool = True) -> PendingSpan:
    """Announce a still-open span with Hue's placeholder shape.

    The placeholder is a new child of the real span that ends at 0 and carries the real
    span's current attributes under the same content policy as finished spans, minus tool
    definitions, system instructions and any value over 64 KiB. The markers are written
    last, so no span attribute or redactor can replace them.
    """
    budget = _ValueBudget(capture_content)
    context = span.context
    if context is None:
        raise ValueError("A placeholder needs the span's context.")
    real_parent = span.parent
    attributes = budget.value(
        {
            key: value
            for key, value in budget.permitted(_live_attributes(span)).items()
            if isinstance(key, str)
            and not _placeholder_omits(key)
            and _value_bytes(value, MAX_PLACEHOLDER_VALUE_BYTES) <= MAX_PLACEHOLDER_VALUE_BYTES
        }
    )
    attributes[PENDING_SPAN_TYPE_KEY] = PENDING_SPAN_TYPE
    if real_parent is not None and real_parent.is_valid:
        attributes[PENDING_PARENT_KEY] = format_span_id(real_parent.span_id)
    return PendingSpan(
        source=span,
        name=budget.value(span.name),
        context=SpanContext(
            context.trace_id,
            _span_ids.generate_span_id(),
            False,
            context.trace_flags,
            context.trace_state,
        ),
        # Hue re-keys the placeholder as the real span, so the record's flags describe the
        # real span's own parent.
        parent=SpanContext(
            context.trace_id,
            context.span_id,
            bool(real_parent is not None and real_parent.is_remote),
            context.trace_flags,
            context.trace_state,
        ),
        resource=budget.resource(span.resource),
        attributes=BoundedAttributes(
            attributes=attributes, immutable=True, extended_attributes=True
        ),
        kind=span.kind,
        start_time=span.start_time,
        end_time=0,
        instrumentation_scope=budget.scope(span.instrumentation_scope),
    )


def snapshot_log(log_record: ReadWriteLogRecord, capture_content: bool = True) -> ReadableLogRecord:
    budget = _ValueBudget(capture_content)
    record = copy(log_record.log_record)
    record.context = Context()
    record.body = budget.value(record.body) if capture_content else None
    record.attributes = budget.attributes(record.attributes, log_record.dropped_attributes)
    record.event_name = budget.value(record.event_name)
    record.severity_text = budget.value(record.severity_text)
    return ReadableLogRecord(
        log_record=record,
        resource=budget.resource(log_record.resource),
        instrumentation_scope=budget.scope(log_record.instrumentation_scope),
        limits=log_record.limits,
    )
