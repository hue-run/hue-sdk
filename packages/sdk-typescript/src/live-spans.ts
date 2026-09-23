import { SpanStatusCode, type Attributes, type SpanContext } from "@opentelemetry/api";
import { RandomIdGenerator, type ReadableSpan } from "@opentelemetry/sdk-trace";
import { HUE_SCOPE } from "./config.js";

/** Marks a placeholder for a span that has started but not ended. The value versions the shape. */
const PENDING_SPAN_TYPE_KEY = "hue.span_type";
const PENDING_SPAN_TYPE = "pending_span";
/** The real span's own parent. Absent when the real span is a root. */
const PENDING_PARENT_KEY = "hue.pending_parent_id";
const markerKeys = [PENDING_SPAN_TYPE_KEY, PENDING_PARENT_KEY];

/**
 * A finished span never carries the placeholder markers, whatever an application set: Hue would
 * read such a span as a malformed placeholder and reject it.
 */
export function withoutPlaceholderMarkers(attributes: Attributes): Attributes {
  if (!markerKeys.some((key) => Object.hasOwn(attributes, key))) return attributes;
  const kept: Attributes = { ...attributes };
  for (const key of markerKeys) delete kept[key];
  return kept;
}
/** Open spans tracked for announcement at once; later starts are not announced. */
export const MAX_LIVE_SPANS = 1024;
export const LIVE_SPAN_INTERVAL_MILLIS = 500;
/**
 * Response header on every trace acknowledgement from a Hue that accepts placeholders. Without
 * it the receiver predates them and rejects each one by its zero end time.
 */
export const PLACEHOLDERS_HEADER = "hue-pending-spans";

const MAX_PLACEHOLDER_VALUE_BYTES = 64 * 1024;
// Kept narrow on purpose: common application processors export only these spans, and a
// placeholder whose real span is filtered later would read as running until the trace stalls.
const livePrefixes = ["gen_ai.", "ai.", "llm.", "traceloop."];
// Definitions and instructions are large and rarely useful while a span runs; the real span
// still carries them. Copied markers would misplace the placeholder.
const omittedKeys = [
  "gen_ai.tool.definitions",
  "gen_ai.system_instructions",
  PENDING_SPAN_TYPE_KEY,
  PENDING_PARENT_KEY,
];
const ids = new RandomIdGenerator();

/** Hue's own spans and recognizable AI spans, judged from what is known when the span starts. */
export function announcesLiveSpan(span: ReadableSpan): boolean {
  if (span.instrumentationScope.name === HUE_SCOPE || span.name.startsWith("ai.")) return true;
  for (const key in span.attributes)
    if (livePrefixes.some((prefix) => key.startsWith(prefix))) return true;
  return false;
}

function valueBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (!Array.isArray(value)) return 8;
  let bytes = 0;
  for (const item of value) bytes += typeof item === "string" ? Buffer.byteLength(item) : 8;
  return bytes;
}

function placeholderAttributes(source: Attributes): Attributes {
  const attributes: Attributes = {};
  for (const key in source) {
    if (!Object.hasOwn(source, key)) continue;
    if (omittedKeys.some((omitted) => key === omitted || key.startsWith(`${omitted}.`))) continue;
    const value = source[key];
    if (valueBytes(value) <= MAX_PLACEHOLDER_VALUE_BYTES) attributes[key] = value;
  }
  return attributes;
}

/**
 * A normal OTLP span announcing `span` while it runs: a new identity whose parent is the real
 * span, the real start time and an end time of 0. The markers are added after redaction.
 */
export function pendingPlaceholder(span: ReadableSpan): {
  record: ReadableSpan;
  markers: Attributes;
} {
  const real = span.spanContext();
  const own: SpanContext = {
    traceId: real.traceId,
    spanId: ids.generateSpanId(),
    traceFlags: real.traceFlags,
    ...(real.traceState ? { traceState: real.traceState } : {}),
  };
  const parent = span.parentSpanContext?.spanId;
  const record: ReadableSpan = {
    name: span.name,
    kind: span.kind,
    spanContext: () => own,
    // Hue re-keys a placeholder as its real span, so the flags describe the real span's parent.
    parentSpanContext: { ...real, isRemote: span.parentSpanContext?.isRemote === true },
    startTime: span.startTime,
    endTime: [0, 0],
    duration: [0, 0],
    ended: true,
    status: { code: SpanStatusCode.UNSET },
    attributes: placeholderAttributes(span.attributes),
    links: [],
    events: [],
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
  return {
    record,
    markers: {
      [PENDING_SPAN_TYPE_KEY]: PENDING_SPAN_TYPE,
      ...(parent ? { [PENDING_PARENT_KEY]: parent } : {}),
    },
  };
}
