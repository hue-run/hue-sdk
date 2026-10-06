"""Record copies Hue's pipeline makes: content keys, the receiver's truncation marker, and the
copies the exporters send when a record must shed content to fit the receiver's limits."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from copy import copy
from dataclasses import dataclass
from typing import Any

from opentelemetry.attributes import BoundedAttributes
from opentelemetry.sdk._logs import ReadableLogRecord
from opentelemetry.sdk.trace import Event, ReadableSpan
from opentelemetry.trace import Link

from ._limits import TRUNCATED_BYTES_KEY, TRUNCATED_KEY

# Attribute keys (and their dotted children) removed in metadata-only mode. Mirrors the
# TypeScript SDK so both export paths strip the same GenAI, OpenInference, OpenLLMetry,
# Langfuse and Vercel AI SDK content fields regardless of which instrumentor produced them.
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
    # Langfuse content; its model name, usage, cost, type, session, user and metadata keys stay.
    "langfuse.observation.input",
    "langfuse.observation.output",
    "langfuse.observation.status_message",
    "langfuse.observation.model.parameters",
    "langfuse.trace.input",
    "langfuse.trace.output",
    "tool.parameters",
    "exception.message",
    "exception.stacktrace",
)


def is_content_key(key: str) -> bool:
    return any(key == prefix or key.startswith(prefix + ".") for prefix in CONTENT_PREFIXES)


def truncated_marker(size: int) -> dict[str, Any]:
    """Hue's receiver's own marker for a value it replaced: nothing of the value, its size, and
    the flag a reader tests."""
    return {TRUNCATED_KEY: True, TRUNCATED_BYTES_KEY: size}


def is_truncated_marker(value: Any) -> bool:
    return isinstance(value, Mapping) and value.get(TRUNCATED_KEY) is True


def with_truncated_keys(listed: Any, keys: Sequence[str]) -> list[str]:
    """``listed`` (a record's ``hue.truncated``) with ``keys`` added, each once, in order."""
    result = (
        [item for item in listed if isinstance(item, str)]
        if isinstance(listed, (list, tuple))
        else []
    )
    for key in keys:
        if key not in result:
            result.append(key)
    return result


def value_bytes(value: Any) -> int:
    """The serialized size of an attribute value or log body, for choosing what to shed first."""
    if isinstance(value, str):
        return len(value.encode("utf-8", errors="replace"))
    if isinstance(value, (bytes, bytearray)):
        return len(value)
    if isinstance(value, Mapping):
        return sum(len(str(key)) + value_bytes(item) for key, item in value.items())
    if isinstance(value, Sequence):
        return sum(value_bytes(item) for item in value)
    return 8


def dropped_of(attributes: Any) -> int:
    return attributes.dropped if isinstance(attributes, BoundedAttributes) else 0


def owned_attributes(values: Mapping[str, Any], dropped: int = 0) -> BoundedAttributes:
    """Immutable attributes as Hue's snapshots hold them, keeping OpenTelemetry's dropped count."""
    result = BoundedAttributes(attributes=dict(values), immutable=True, extended_attributes=True)
    result.dropped += dropped
    return result


class OwnedSpan(ReadableSpan):
    """A span copy owned by Hue's pipeline; its dropped event and link counts are fixed when it
    is made, since the copy holds its events and links as plain sequences."""

    def __init__(self, *, dropped_events: int = 0, dropped_links: int = 0, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._owned_dropped_events = dropped_events
        self._owned_dropped_links = dropped_links

    @property
    def dropped_events(self) -> int:
        return self._owned_dropped_events

    @property
    def dropped_links(self) -> int:
        return self._owned_dropped_links


def replace_span(
    span: ReadableSpan,
    *,
    attributes: Mapping[str, Any] | None = None,
    events: Sequence[Event] | None = None,
    links: Sequence[Link] | None = None,
) -> ReadableSpan:
    """A copy of ``span`` with its attributes, events or links replaced."""
    return OwnedSpan(
        name=span.name,
        context=span.context,
        parent=span.parent,
        resource=span.resource,
        attributes=owned_attributes(
            (span.attributes or {}) if attributes is None else attributes, span.dropped_attributes
        ),
        events=tuple(span.events if events is None else events),
        links=tuple(span.links if links is None else links),
        kind=span.kind,
        status=span.status,
        start_time=span.start_time,
        end_time=span.end_time,
        instrumentation_scope=span.instrumentation_scope,
        dropped_events=span.dropped_events,
        dropped_links=span.dropped_links,
    )


_KEEP = object()


def replace_log(
    log: ReadableLogRecord, *, body: Any = _KEEP, attributes: Mapping[str, Any] | None = None
) -> ReadableLogRecord:
    """A copy of ``log`` with its body or attributes replaced."""
    record = copy(log.log_record)
    if body is not _KEEP:
        record.body = body
    if attributes is not None:
        record.attributes = owned_attributes(attributes, dropped_of(log.log_record.attributes))
    return ReadableLogRecord(
        log_record=record,
        resource=log.resource,
        instrumentation_scope=log.instrumentation_scope,
        limits=log.limits,
    )


@dataclass(frozen=True)
class Sheddable:
    """One content value a record may shed: a log's body (``where`` is ``"body"``), or a content
    attribute of the record (``"own"``), of one of a span's events (``"event"``) or of one of its
    links (``"link"``), at ``index`` among them."""

    where: str
    index: int
    key: str
    size: int


# A value smaller than this would grow its record if the receiver's marker replaced it.
MIN_SHED_BYTES = 64


def sheddable_content(record: Any, signal: str) -> list[Sheddable]:
    """The content values a record over the receiver's limits may shed, in the order it sheds
    them: a log's body first, then the largest values first. Metadata is never shed: a record too
    large without its content is lost whole."""
    found: list[Sheddable] = []
    if signal == "logs":
        own: Mapping[str, Any] = record.log_record.attributes or {}
        events: Sequence[Event] = ()
        links: Sequence[Link] = ()
    else:
        own = record.attributes or {}
        events = record.events
        links = record.links
    places: list[tuple[str, int, Mapping[str, Any]]] = [("own", 0, own)]
    places += [("event", index, event.attributes or {}) for index, event in enumerate(events)]
    places += [("link", index, link.attributes or {}) for index, link in enumerate(links)]
    for where, index, values in places:
        for key, value in values.items():
            if not isinstance(key, str) or not is_content_key(key) or is_truncated_marker(value):
                continue
            size = value_bytes(value)
            if size >= MIN_SHED_BYTES:
                found.append(Sheddable(where, index, key, size))
    # Stable: of values of one size, the record's own come first, then its events' and links'.
    found.sort(key=lambda item: -item.size)
    if signal == "logs":
        body = record.log_record.body
        if body is not None and not is_truncated_marker(body):
            found.insert(0, Sheddable("body", 0, "body", value_bytes(body)))
    return found


def shed_content(record: Any, signal: str, shed: Sequence[Sheddable]) -> Any:
    """The record with ``shed`` replaced by the receiver's marker, each listed under
    ``hue.truncated`` as the receiver lists a cut of the same place: the key alone, ``body``,
    ``event:<name>:<key>`` or ``link:<key>``."""
    if signal == "logs":
        own: Mapping[str, Any] = record.log_record.attributes or {}
        events: Sequence[Event] = ()
        links: Sequence[Link] = ()
    else:
        own = record.attributes or {}
        events = record.events
        links = record.links
    attributes = dict(own)
    event_markers: dict[int, dict[str, Any]] = {}
    link_markers: dict[int, dict[str, Any]] = {}
    listed: list[str] = []
    body: Any = _KEEP
    for value in shed:
        marker = truncated_marker(value.size)
        if value.where == "body":
            body = marker
            listed.append("body")
        elif value.where == "own":
            attributes[value.key] = marker
            listed.append(value.key)
        elif value.where == "event":
            event_markers.setdefault(value.index, {})[value.key] = marker
            listed.append(f"event:{events[value.index].name}:{value.key}")
        else:
            link_markers.setdefault(value.index, {})[value.key] = marker
            listed.append(f"link:{value.key}")
    attributes[TRUNCATED_KEY] = with_truncated_keys(own.get(TRUNCATED_KEY), listed)
    if signal == "logs":
        return replace_log(record, body=body, attributes=attributes)
    if event_markers:
        events = [
            Event(
                event.name,
                owned_attributes(
                    {**(event.attributes or {}), **event_markers[position]},
                    event.dropped_attributes,
                ),
                event.timestamp,
            )
            if position in event_markers
            else event
            for position, event in enumerate(events)
        ]
    if link_markers:
        links = [
            Link(
                link.context,
                owned_attributes(
                    {**(link.attributes or {}), **link_markers[position]}, link.dropped_attributes
                ),
            )
            if position in link_markers
            else link
            for position, link in enumerate(links)
        ]
    return replace_span(record, attributes=attributes, events=events, links=links)
