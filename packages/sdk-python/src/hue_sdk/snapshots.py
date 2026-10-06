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

from ._blobs import MAX_BLOB_BYTES, Held, HeldValues, attach_held, held_size
from ._inline_files import hash_inline_files, hash_inline_files_counted
from ._limits import MAX_CONTENT_BYTES, TRUNCATED_KEY, cut_utf8, over_utf8
from ._records import CONTENT_PREFIXES as CONTENT_PREFIXES
from ._records import is_content_key as is_content_key
from ._records import is_truncated_marker, truncated_marker, with_truncated_keys
from ._tool_definitions import (
    scrub_tool_credentials,
    scrubs_tool_credentials,
    with_tool_catalog_summary,
)
from .transport import (
    MAX_REQUEST_BYTES,
    PENDING_PARENT_KEY,
    PENDING_SPAN_TYPE,
    PENDING_SPAN_TYPE_KEY,
    PendingSpan,
)

# A redactor's view of helper content: four times the value cap, so a secret that crosses the
# cap is still the redactor's to recognize before the content is cut to the cap.
MAX_CONTENT_SNAPSHOT_BYTES = 4 * MAX_CONTENT_BYTES
MAX_CONTENT_SNAPSHOT_DEPTH = 64
MAX_CONTENT_SNAPSHOT_NODES = 65_536
# Helper content encoded whole for upload: up to Hue's 1 GB upload limit, and as many values as
# the TypeScript SDK's queued record may hold.
MAX_WHOLE_CONTENT_NODES = 1_048_576
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

    def __init__(
        self,
        max_bytes: int = MAX_CONTENT_SNAPSHOT_BYTES,
        max_nodes: int = MAX_CONTENT_SNAPSHOT_NODES,
    ) -> None:
        self.remaining_bytes = max_bytes
        self.remaining_nodes = max_nodes
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
            # ASCII text is its own UTF-8 length; other text is encoded to count it.
            self.consume(len(value) if value.isascii() else len(value.encode("utf-8")))
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


def snapshot_content(value: Any, *, whole: bool = False) -> Any:
    """Detach nested mutable content before exposing it to a user redactor. ``whole`` bounds it
    by Hue's upload limit instead of four value caps, for content export may upload."""
    if whole:
        return _ContentBudget(MAX_BLOB_BYTES, MAX_WHOLE_CONTENT_NODES).value(value)
    return _ContentBudget().value(value)


_LEGACY_CONTENT_EVENTS = (
    "gen_ai.system",
    "gen_ai.user",
    "gen_ai.assistant",
    "gen_ai.tool",
    "gen_ai.choice",
)


def _is_legacy_content_event(name: str) -> bool:
    return any(name == prefix or name.startswith(prefix + ".") for prefix in _LEGACY_CONTENT_EVENTS)


# An event's or link's encoded fields the copy does not otherwise charge.
_ITEM_FRAMING_BYTES = 64


class Hold:
    """How a span's own values over the value cap are held whole for export to upload: the
    held-value budget, the cap, and whether values are held now (``active``): a client whose
    receiver lacks the upload route cuts them when they are queued, and export counts the cuts."""

    __slots__ = ("budget", "value_bytes", "active")

    def __init__(self, budget: HeldValues, value_bytes: int, active: bool = True) -> None:
        self.budget = budget
        self.value_bytes = value_bytes
        self.active = active


class _BudgetExceeded(ValueError):
    """The record's copy outgrew its budget: a span's events and links past it are left out and
    counted as dropped, where anything else loses the record."""


class _ValueBudget:
    """One record's copy. ``record_bytes`` bounds the copy's work and size; a value string (an
    attribute's, an event's or link's attribute's, a log body or a status description) over
    ``value_bytes`` is cut to it and its key listed under ``hue.truncated``, and bytes over it
    are replaced by the receiver's marker, as export would cut them: copying them whole could
    exceed the record's budget and lose the record for one value."""

    def __init__(
        self,
        capture_content: bool = True,
        *,
        record_bytes: int = MAX_REQUEST_BYTES,
        value_bytes: int | None = None,
        hold: Hold | None = None,
    ) -> None:
        self.remaining = record_bytes
        self.capture_content = capture_content
        self.value_bytes = value_bytes
        # The keys whose values this copy cut, as the record's ``hue.truncated`` lists them.
        self.truncated: list[str] = []
        self._cut = False
        self.hold = hold
        # The span's own values held whole for upload, charged to the held-value budget.
        self.held = Held(budget=hold.budget if hold else None)

    def consume(self, size: int) -> None:
        self.remaining -= size
        if self.remaining < 0:
            raise _BudgetExceeded("Telemetry snapshot exceeds its budget.")

    def newest(self, items: Sequence[Any], copy_item: Any) -> tuple[tuple[Any, ...], int]:
        """As many of a span's newest ``items`` (its events or links) as the budget still holds,
        each copied by ``copy_item``, and how many older ones it could not hold, as OpenTelemetry
        keeps a span's newest events and links past its own count limits. A span whose events or
        links outgrow the budget keeps its name, timing, attributes and the rest of them, counting
        the ones left out as dropped, instead of being lost whole."""
        kept: list[Any] = []
        for item in reversed(items):
            remaining, listed = self.remaining, len(self.truncated)
            try:
                # What the copy does not charge of an event or link: its timestamp or identifiers
                # and its framing, so the record kept encodes within the budget it was charged.
                self.consume(_ITEM_FRAMING_BYTES)
                kept.append(copy_item(item))
            except _BudgetExceeded:
                self.remaining = remaining
                del self.truncated[listed:]
                break
        kept.reverse()
        return tuple(kept), len(items) - len(kept)

    def value(self, value: Any, depth: int = 0, *, cut: bool = False) -> Any:
        # Conservative per-value work/storage bound, separate from exact protobuf
        # admission bytes. Reject excessive nesting and cycles without retaining
        # or traversing arbitrarily large application objects.
        self.consume(8)
        if depth > 64:
            raise ValueError("Telemetry snapshot exceeds its nesting limit.")
        if value is None or isinstance(value, bool):
            return value
        if isinstance(value, float):
            # Its eight bytes, as the queue charges the encoded record, so a span whose events
            # were trimmed to this budget still fits it when encoded.
            self.consume(8)
            return float.__float__(value)
        if isinstance(value, int):
            self.consume((int.bit_length(value) + 7) // 8)
            return int.__int__(value)
        if isinstance(value, (str, bytes)):
            limit = self.value_bytes if cut else None
            if isinstance(value, str):
                if limit is not None and over_utf8(value, limit):
                    value = cut_utf8(value, limit)
                    self._cut = True
                if len(value) > self.remaining:
                    raise _BudgetExceeded("Telemetry snapshot exceeds its budget.")
                self.consume(len(str.encode(value, "utf-8")))
                return str.__str__(value)
            if limit is not None and len(value) > limit:
                # Bytes are never cut: a shortened encoding is a different value.
                self._cut = True
                return self.value(truncated_marker(len(value)), depth)
            if len(value) > self.remaining:
                raise _BudgetExceeded("Telemetry snapshot exceeds its budget.")
            self.consume(len(value))
            return value if type(value) is bytes else memoryview(value).tobytes()
        if isinstance(value, Mapping):
            result = {}
            for key, item in value.items():
                if not isinstance(key, str):
                    raise ValueError("Telemetry mapping keys must be strings.")
                result[self.value(key, depth + 1)] = self.value(item, depth + 1, cut=cut)
            return result
        if isinstance(value, Sequence):
            return tuple(self.value(item, depth + 1, cut=cut) for item in value)
        raise ValueError("Unsupported telemetry snapshot value.")

    def content(self, value: Any, listed: str) -> Any:
        """A value cut to the value cap, its key listed as ``listed`` when it was cut."""
        self._cut = False
        result = self.value(value, cut=self.value_bytes is not None)
        if self._cut and listed not in self.truncated:
            self.truncated.append(listed)
        return result

    def _scrubbed_before_cut(self, key: str, value: Any) -> Any:
        """A tool definition or recorded request the copy will cut, with its credentials removed
        from the whole value first: a cut prefix no longer parses, so scrubbing the copy could
        not find them. A value too long to parse within the record's budget is replaced by the
        receiver's marker instead of exported unscrubbed."""
        limit = self.value_bytes
        if limit is None or not scrubs_tool_credentials(key):
            return value
        texts = (
            [value] if isinstance(value, str) else value if isinstance(value, (list, tuple)) else []
        )
        long = [text for text in texts if isinstance(text, str) and over_utf8(text, limit)]
        if not long:
            return value
        if sum(len(text) for text in long) > self.remaining:
            return truncated_marker(sum(len(text) for text in long))
        return scrub_tool_credentials(key, value)

    def permitted(self, values: Any, files: bool = True) -> Any:
        """Apply the content policy: metadata-only mode drops recognized content keys. With
        ``files`` false, large inline files are left for export to upload."""
        source = values or {}
        if not self.capture_content and isinstance(source, Mapping):
            # Summarize the tool definitions metadata-only export removes by name and digest.
            source = with_tool_catalog_summary(source)
        if isinstance(source, Mapping):
            # Large inline files shrink to their digest before the budget, so the span survives.
            source = {
                key: hash_inline_files(key, item) if files and isinstance(key, str) else item
                for key, item in source.items()
                if self.capture_content or not (isinstance(key, str) and is_content_key(key))
            }
        return source

    def _held_value(self, key: str, item: Any) -> tuple[bool, Any]:
        """One of the span's own attribute values held whole for export to upload, when it may
        be, within the held-value budget: text or bytes over the cap, replaced in the copy by the
        receiver's marker until export places it, or a recorded message within the cap holding a
        large inline file, whose copy carries the files as their digest (what the queue is
        charged, as before). ``(True, copy)`` for a held value, ``(False, value)`` for one copied
        as before, its large inline files already shrunk to their digest. A value not held only
        for the budget or a receiver without the upload route is listed in ``held.cut`` (once per
        file for a message), so export counts it as not uploaded."""
        hold = self.hold
        assert hold is not None
        digested, files = hash_inline_files_counted(key, item)
        if isinstance(item, str):
            try:
                over = over_utf8(item, hold.value_bytes)
            except UnicodeEncodeError:
                return False, digested
            if not over and not files:
                return False, item
            value: str | bytes = str.__str__(item)
            # What is not uploaded if the value is not held: each file, and the value itself
            # when it is still over the cap with its files as their digest.
            lost = files + (1 if over and over_utf8(digested, hold.value_bytes) else 0)
        elif isinstance(item, bytes) and len(item) > hold.value_bytes:
            value = item if type(item) is bytes else memoryview(item).tobytes()
            over, lost = True, 1
        else:
            return False, digested
        size = held_size(value)
        if not hold.active or not hold.budget.reserve(size, self.held.size):
            # Cut, or its files digested, when queued, as before uploads existed.
            self.held.cut.extend([key] * lost)
            return False, digested
        self.held.size += size
        self.held.values[key] = value
        # The copy carries what the queue is charged: the receiver's marker for a value over the
        # cap, a message within it with its files as their digest.
        return True, self.value(truncated_marker(len(value)) if over else digested)

    def copied_attributes(self, values: Any, prefix: str = "", own: bool = False) -> Any:
        """Attribute values copied, each cut to the value cap and listed as ``prefix`` + key. A
        span's ``own`` values over the cap are held whole for upload when they may be."""
        holding = own and self.hold is not None
        source = self.permitted(values, files=not holding)
        if not isinstance(source, Mapping):
            return self.value(source)
        copied: dict[str, Any] = {}
        for key, item in source.items():
            if not isinstance(key, str):
                raise ValueError("Telemetry mapping keys must be strings.")
            listed = f"{prefix}{key}"
            if holding:
                # Not held, a value's large inline files shrink to their digest, as before.
                kept, item = self._held_value(key, item)
                if kept:
                    copied[self.value(key, 1)] = item
                    continue
            scrubbed = self._scrubbed_before_cut(key, item)
            copied[self.value(key, 1)] = self.content(scrubbed, listed)
            if scrubbed is not item and is_truncated_marker(scrubbed):
                if listed not in self.truncated:
                    self.truncated.append(listed)
        return copied

    def attributes(
        self, values: Any, dropped: int = 0, prefix: str = "", own: bool = False
    ) -> BoundedAttributes:
        # Scrub the copy admission already bounded, so the application thread never parses
        # more than one record's budget of tool-definition JSON. A value held for upload is
        # scrubbed whole on export instead.
        copied = self.copied_attributes(values, prefix, own)
        if isinstance(copied, dict):
            copied = {
                key: item if own and key in self.held.values else scrub_tool_credentials(key, item)
                for key, item in copied.items()
            }
        result = BoundedAttributes(attributes=copied, immutable=True, extended_attributes=True)
        result.dropped += dropped
        return result

    def take_truncated(self) -> list[str]:
        """The keys listed since the last call, which the record lists in its own order."""
        taken, self.truncated = self.truncated, []
        return taken

    def listed(self, attributes: BoundedAttributes) -> BoundedAttributes:
        """The record's own attributes with every cut of the record listed under
        ``hue.truncated``, merged with any the application listed itself."""
        if not self.truncated:
            return attributes
        values = dict(attributes)
        values[TRUNCATED_KEY] = with_truncated_keys(values.get(TRUNCATED_KEY), self.truncated)
        result = BoundedAttributes(attributes=values, immutable=True, extended_attributes=True)
        result.dropped += attributes.dropped
        return result

    def resource(self, resource: Resource | None) -> Resource:
        if resource is None:
            return Resource({})
        return Resource(
            self.copied_attributes(resource.attributes, "resource."),
            self.value(resource.schema_url),
        )

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
    def __init__(
        self,
        span: ReadableSpan,
        capture_content: bool = True,
        *,
        record_bytes: int = MAX_REQUEST_BYTES,
        value_bytes: int | None = None,
        hold: Hold | None = None,
    ) -> None:
        budget = _ValueBudget(
            capture_content, record_bytes=record_bytes, value_bytes=value_bytes, hold=hold
        )
        try:
            self._copy(span, budget, capture_content)
        except BaseException:
            # The values held for a copy that failed are no one's.
            budget.held.release()
            raise
        if budget.held.values or budget.held.cut:
            attach_held(self, budget.held)

    def _copy(self, span: ReadableSpan, budget: _ValueBudget, capture_content: bool) -> None:
        attributes: Any = span.attributes
        if attributes and any(key in attributes for key in _PENDING_MARKERS):
            # Placeholder markers are reserved: a finished span must never read as one.
            attributes = {k: v for k, v in attributes.items() if k not in _PENDING_MARKERS}
        name = budget.value(span.name)
        scope = budget.scope(span.instrumentation_scope)
        own = budget.attributes(attributes, span.dropped_attributes, own=True)
        own_cuts = budget.take_truncated()
        resource = budget.resource(span.resource)
        status = Status(
            span.status.status_code,
            budget.content(span.status.description, "status.message") if capture_content else None,
        )
        record_cuts = budget.take_truncated()
        # Last, with what the budget has left: past it, events and links are counted as dropped.
        events, dropped_events = budget.newest(
            [
                event
                for event in span.events
                if capture_content or not _is_legacy_content_event(event.name)
            ],
            lambda event: Event(
                budget.value(event.name),
                budget.attributes(
                    event.attributes, event.dropped_attributes, f"event:{event.name}:"
                ),
                event.timestamp,
            ),
        )
        links, dropped_links = budget.newest(
            span.links,
            lambda link: Link(
                link.context,
                budget.attributes(link.attributes, link.dropped_attributes, "link:"),
            ),
        )
        # Every cut of the record, its events', links' and resource's included, is listed on its
        # own attributes, in that order.
        budget.truncated = budget.take_truncated() + record_cuts + own_cuts
        super().__init__(
            name=name,
            context=span.context,
            parent=span.parent,
            resource=resource,
            attributes=budget.listed(own),
            events=events,
            links=links,
            kind=span.kind,
            status=status,
            start_time=span.start_time,
            end_time=span.end_time,
            instrumentation_scope=scope,
        )
        self._snapshot_dropped_events = span.dropped_events + dropped_events
        self._snapshot_dropped_links = span.dropped_links + dropped_links

    @property
    def dropped_events(self) -> int:
        return self._snapshot_dropped_events

    @property
    def dropped_links(self) -> int:
        return self._snapshot_dropped_links


def snapshot_span(
    span: ReadableSpan,
    capture_content: bool = True,
    *,
    record_bytes: int = MAX_REQUEST_BYTES,
    value_bytes: int | None = None,
    hold: Hold | None = None,
) -> ReadableSpan:
    return _SpanSnapshot(
        span, capture_content, record_bytes=record_bytes, value_bytes=value_bytes, hold=hold
    )


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
    copied = budget.value(
        {
            key: value
            for key, value in budget.permitted(_live_attributes(span)).items()
            if isinstance(key, str)
            and not _placeholder_omits(key)
            and _value_bytes(value, MAX_PLACEHOLDER_VALUE_BYTES) <= MAX_PLACEHOLDER_VALUE_BYTES
        }
    )
    attributes = {key: scrub_tool_credentials(key, value) for key, value in copied.items()}
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


def snapshot_log(
    log_record: ReadWriteLogRecord,
    capture_content: bool = True,
    *,
    record_bytes: int = MAX_REQUEST_BYTES,
    value_bytes: int | None = None,
    hold: Hold | None = None,
) -> ReadableLogRecord:
    # Log records are never uploaded: Hue reads no log record's uploaded values yet.
    del hold
    budget = _ValueBudget(capture_content, record_bytes=record_bytes, value_bytes=value_bytes)
    record = copy(log_record.log_record)
    record.context = Context()
    record.body = budget.content(record.body, "body") if capture_content else None
    resource = budget.resource(log_record.resource)
    record.attributes = budget.listed(
        budget.attributes(record.attributes, log_record.dropped_attributes)
    )
    record.event_name = budget.value(record.event_name)
    record.severity_text = budget.value(record.severity_text)
    return ReadableLogRecord(
        log_record=record,
        resource=resource,
        instrumentation_scope=budget.scope(log_record.instrumentation_scope),
        limits=log_record.limits,
    )
