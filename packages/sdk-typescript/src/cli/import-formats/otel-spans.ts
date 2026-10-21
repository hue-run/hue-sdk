import {
  BlobSink,
  canonicalJson,
  ConversionError,
  conversionFailure,
  digestHex,
  MAX_INLINE_VALUE_BYTES,
  offloadOtlpValues,
  sha256Hex,
  SOURCE_RECORD,
  validateSource,
  type ConvertedTrace,
  type ImportEntry,
  type JsonValue,
  type OtlpAttribute,
  type OtlpValue,
  type Refusal,
  type TraceImportOrigin,
} from "../traces-import-convert.js";
import type { TraceCollector } from "./adapter.js";
import { cyclic, rowTraceId, timesOf, type SpanRow } from "./rows.js";

/**
 * Spans of formats that record OpenTelemetry's span model in a shape of their own (Jaeger,
 * Zipkin, Arize Phoenix): each is written as the OTLP span it was, with its attributes, kind,
 * status, events, links, resource and scope kept under their own names. Unlike a row format's
 * spans they get no GenAI attributes added, since the instrumentation that recorded them already
 * wrote its conventions. Beside the recorded attributes each span carries its provenance:
 * `hue.import.format`, the original ids where they changed, `hue.import.timing`,
 * `hue.import.source_index` and the source record whole as `hue.import.source_record`.
 *
 * - Ids: a hex id of up to 32 (trace) or 16 (span) digits is the id it encodes, zero-padded on
 *   the left the way the OpenTelemetry Collector pads a 64-bit Jaeger or Zipkin trace id. Any
 *   other id is mapped by SHA-256 as row formats map theirs. The original is kept as
 *   `hue.import.original_trace_id` or `hue.import.original_span_id` whenever it changed.
 * - A parent the export does not hold stays the span's parent, as in OTLP: Hue reads the span as
 *   a root of the trace.
 * - Missing instants are filled by the row formats' documented rules (`rows.ts`), named in
 *   `hue.import.timing` and the report. A recorded end before its start refuses the trace.
 * - Copies of a span with the same record are one span; copies that differ refuse the trace.
 */

/** One span as a format read it, before ids are mapped and instants filled. */
export interface OtelSpan {
  /** The trace id as the source recorded it. */
  traceId: string;
  /** The span's key within the trace: its id as recorded, or a key of the format's own for a
   * span the source records twice under one id (see {@link OtelSpan.sourceSpanId}). */
  spanKey: string;
  /** The id the source recorded, when {@link OtelSpan.spanKey} is not it. */
  sourceSpanId?: string;
  /** The parent's key; a parent the export does not hold is kept as a parent outside it. */
  parentKey?: string;
  name: string;
  /** OTLP `SpanKind`: 0 unspecified, 1 internal, 2 server, 3 client, 4 producer, 5 consumer. */
  kind: number;
  traceState?: string;
  flags?: number;
  /** Recorded instants in Unix nanoseconds; a missing one is filled by the documented rules. */
  start?: bigint;
  end?: bigint;
  /** How the format took a recorded instant from another field; named in `hue.import.timing`. */
  timing?: string;
  attributes: OtlpAttribute[];
  droppedAttributesCount?: number;
  events: { name: string; time?: bigint; attributes: OtlpAttribute[] }[];
  /** Links by the linked span's trace id as recorded and its key. */
  links: { traceId: string; spanKey: string; traceState?: string; attributes: OtlpAttribute[] }[];
  status?: { code: number; message?: string };
  resource: OtlpAttribute[];
  /** The instrumentation scope the source names; `hue.import.<format>` when it names none. */
  scope?: { name: string; version?: string };
  /** The whole source record, kept as `hue.import.source_record`. */
  record: JsonValue;
  /** The record's position in its source. */
  sequence?: number;
}

const HEX = /^[0-9a-f]+$/i;
const MAX_KEY = 4096;
/** The instrumentation scope version of a span with no scope of its own. */
const IMPORT_VERSION = "1";
/** Attributes that mark a trace as an evaluation's or a simulated world's, as Hue reads them. */
const EVALUATION_KEYS = ["hue.execution.id", "hue.eval.execution_id"];
const SIMULATION_KEYS = ["hue.world.id", "hue.environment.run_id"];
const SIMULATION_SCOPE = "hue.sim-gateway";

/** A hex id of at most `length` digits as the OpenTelemetry id it encodes, zero-padded on the
 * left; undefined for anything else, and for an all-zero id. */
export function paddedId(value: string, length: 32 | 16): string | undefined {
  if (!value || value.length > length || !HEX.test(value) || /^0+$/.test(value)) return undefined;
  return value.toLowerCase().padStart(length, "0");
}

/** The key a trace is gathered and named under (`context.refuse`, `readRecords`): its padded
 * OpenTelemetry id when it is one, else the id as recorded, which `rowTraceId` maps by SHA-256. */
export const otelTraceKey = (traceId: string): string => paddedId(traceId, 32) ?? traceId;

const stringAttribute = (key: string, value: string): OtlpAttribute => ({
  key,
  value: { stringValue: value },
});
const stringOf = (value: OtlpValue | undefined) =>
  typeof value?.stringValue === "string" ? value.stringValue : undefined;

interface Draft {
  /** Distinct copies of each span, by key and content. */
  spans: Map<string, OtelSpan>;
  sourceDigests: Set<string>;
}

/** Gathers one format's spans by trace across files and lines, and emits each trace as OTLP.
 * `prepare` sees every distinct span of a trace before ids are mapped, for a format whose spans
 * relate in ways only the whole trace shows (Zipkin's shared spans). */
export class OtelSpanCollector implements TraceCollector {
  private readonly traces = new Map<string, Draft>();

  constructor(
    private readonly format: string,
    private readonly prepare: (spans: OtelSpan[]) => OtelSpan[] = (spans) => spans,
  ) {}

  add(span: OtelSpan, sourceDigest: string): void {
    for (const [value, what] of [
      [span.traceId, "trace id"],
      [span.spanKey, "span id"],
    ] as const)
      if (!value || value.length > MAX_KEY)
        throw new ConversionError(`The record has no valid ${what}`);
    validateSource(span.record);
    const traceKey = otelTraceKey(span.traceId);
    let draft = this.traces.get(traceKey);
    if (!draft) {
      draft = { spans: new Map(), sourceDigests: new Set() };
      this.traces.set(traceKey, draft);
    }
    draft.sourceDigests.add(sourceDigest);
    const copy = `${span.spanKey}\u0000${sha256Hex(`${canonicalJson(span.record)}\u0000${JSON.stringify(span.resource)}`)}`;
    if (!draft.spans.has(copy)) draft.spans.set(copy, span);
  }

  finish(): { traces: ConvertedTrace[]; refused: Refusal[] } {
    const traces: ConvertedTrace[] = [];
    const refused: Refusal[] = [];
    for (const [traceKey, draft] of this.traces) {
      // Each draft is let go once its trace is emitted, so a run holds one copy of each record.
      this.traces.delete(traceKey);
      const traceId = rowTraceId(this.format, traceKey);
      try {
        traces.push(this.emit(traceKey, traceId, draft, refused));
      } catch (error) {
        const failure = conversionFailure(error);
        if (!failure) throw error;
        refused.push({ traceId, reason: failure.message });
      }
    }
    return { traces, refused };
  }

  private emit(
    traceKey: string,
    traceId: string,
    draft: Draft,
    refused: Refusal[],
  ): ConvertedTrace {
    const format = this.format;
    const byKey = new Map<string, OtelSpan>();
    for (const span of this.prepare([...draft.spans.values()])) {
      if (byKey.has(span.spanKey))
        throw new ConversionError(`span ${span.spanKey} appears with different content`);
      byKey.set(span.spanKey, span);
    }
    const keys = [...byKey.keys()].sort();
    const mapSpan = (trace: string, key: string) =>
      paddedId(key, 16) ?? digestHex(`${format}.span:${trace}:${key}`, 16);
    // Span ids in key order, so a collision is salted the same way whatever order spans arrived.
    const spanIds = new Map<string, string>();
    const taken = new Set<string>();
    for (const key of keys) {
      let spanId = mapSpan(traceId, key);
      for (let salt = 0; taken.has(spanId); salt++)
        spanId = digestHex(`${format}.span:${traceId}:${key}#${salt}`, 16);
      taken.add(spanId);
      spanIds.set(key, spanId);
    }
    const rows = new Map<string, SpanRow>(
      keys.map((key) => {
        const span = byKey.get(key)!;
        return [
          key,
          {
            traceKey,
            spanKey: key,
            name: span.name,
            record: null,
            ...(span.parentKey !== undefined ? { parentKey: span.parentKey } : {}),
            ...(span.start !== undefined ? { start: span.start } : {}),
            ...(span.end !== undefined ? { end: span.end } : {}),
            ...(span.sequence !== undefined ? { sequence: span.sequence } : {}),
          },
        ];
      }),
    );
    const parentOf = (row: SpanRow) =>
      row.parentKey !== undefined && row.parentKey !== row.spanKey && rows.has(row.parentKey)
        ? row.parentKey
        : undefined;
    if (cyclic(rows, parentOf)) throw new ConversionError("The source hierarchy contains a cycle");
    const { starts, ends, notes } = timesOf(rows, parentOf);
    const traceNotes = new Set([...notes.values()].flat());
    const blobs = new BlobSink();
    let evaluation = false;
    let simulation = false;
    let production = false;
    let remappedSpans = 0;
    const ordered = [...keys].sort((a, b) => {
      const [x, y] = [starts.get(a)!, starts.get(b)!];
      return x < y ? -1 : x > y ? 1 : spanIds.get(a)! < spanIds.get(b)! ? -1 : 1;
    });
    const entries = ordered.map((key): ImportEntry => {
      const span = byKey.get(key)!;
      const spanId = spanIds.get(key)!;
      if (span.attributes.some((attribute) => attribute.key.startsWith("hue.import.")))
        throw new ConversionError("Source attributes use reserved import keys");
      const attributes = [...span.attributes];
      attributes.push(stringAttribute("hue.import.format", format));
      if (span.traceId !== traceId)
        attributes.push(stringAttribute("hue.import.original_trace_id", span.traceId));
      const original = span.sourceSpanId ?? key;
      if (spanId !== original) {
        attributes.push(stringAttribute("hue.import.original_span_id", original));
        remappedSpans++;
      }
      let parentSpanId: string | undefined;
      if (span.parentKey !== undefined && span.parentKey !== key) {
        const held = spanIds.get(span.parentKey);
        parentSpanId = held ?? mapSpan(traceId, span.parentKey);
        const recorded = byKey.get(span.parentKey)?.sourceSpanId ?? span.parentKey;
        if (held === undefined && parentSpanId !== recorded)
          attributes.push(stringAttribute("hue.import.original_parent_span_id", recorded));
      }
      if (span.sequence !== undefined)
        attributes.push({
          key: "hue.import.source_index",
          value: { intValue: String(span.sequence) },
        });
      const spanNotes = [...(span.timing ? [span.timing] : []), ...(notes.get(key) ?? [])];
      if (span.timing) traceNotes.add(span.timing);
      if (spanNotes.length)
        attributes.push(stringAttribute("hue.import.timing", spanNotes.join("; ")));
      attributes.push(stringAttribute(SOURCE_RECORD, JSON.stringify(span.record)));
      const start = starts.get(key)!;
      // An event too large to keep inline is left out and reported, as row formats do; the
      // source record, stored apart when it is large, still holds it.
      const events = span.events.flatMap((event) => {
        if (Buffer.byteLength(JSON.stringify(event.attributes)) > MAX_INLINE_VALUE_BYTES) {
          refused.push({ reason: `an event of span ${key} is over the inline value limit` });
          return [];
        }
        if (event.time === undefined) traceNotes.add("event_at_span_start");
        return [
          {
            timeUnixNano: (event.time ?? start).toString(),
            name: event.name,
            attributes: event.attributes,
          },
        ];
      });
      const links = span.links.map((link) => {
        const linkKey = otelTraceKey(link.traceId);
        const linkTrace = linkKey === traceKey ? traceId : rowTraceId(format, linkKey);
        const linkSpan =
          linkKey === traceKey
            ? (spanIds.get(link.spanKey) ?? mapSpan(traceId, link.spanKey))
            : mapSpan(linkTrace, link.spanKey);
        return {
          traceId: linkTrace,
          spanId: linkSpan,
          ...(link.traceState ? { traceState: link.traceState } : {}),
          attributes: link.attributes,
        };
      });
      const scope = span.scope?.name
        ? span.scope
        : { name: `hue.import.${format}`, version: IMPORT_VERSION };
      const has = (key: string) =>
        span.attributes.some((attribute) => attribute.key === key) ||
        span.resource.some((attribute) => attribute.key === key);
      if (EVALUATION_KEYS.some(has)) evaluation = true;
      if (SIMULATION_KEYS.some(has) || scope.name === SIMULATION_SCOPE) simulation = true;
      for (const attribute of span.resource)
        if (
          (attribute.key === "deployment.environment.name" ||
            attribute.key === "deployment.environment") &&
          stringOf(attribute.value) === "production"
        )
          production = true;
      return {
        resource: { attributes: span.resource },
        scopeSpans: [
          {
            scope,
            spans: [
              {
                traceId,
                spanId,
                ...(parentSpanId !== undefined ? { parentSpanId } : {}),
                ...(span.traceState ? { traceState: span.traceState } : {}),
                ...(span.flags !== undefined ? { flags: span.flags } : {}),
                name: span.name,
                kind: span.kind,
                startTimeUnixNano: start.toString(),
                endTimeUnixNano: ends.get(key)!.toString(),
                attributes: offloadOtlpValues(attributes, blobs),
                ...(span.droppedAttributesCount
                  ? { droppedAttributesCount: span.droppedAttributesCount }
                  : {}),
                ...(events.length ? { events } : {}),
                ...(links.length ? { links } : {}),
                status: span.status ?? { code: 0 },
              },
            ],
          },
        ],
      };
    });
    const origin: TraceImportOrigin = evaluation
      ? "evaluation"
      : simulation
        ? "simulation"
        : production
          ? "production"
          : "unknown";
    const inferredTiming = [...traceNotes].sort();
    return {
      traceId,
      format,
      entries,
      blobs: blobs.sorted(),
      origin,
      sourceDigests: draft.sourceDigests,
      remappedTraceId: [...byKey.values()].some((span) => span.traceId !== traceId),
      remappedSpans,
      ...(inferredTiming.length ? { inferredTiming } : {}),
    };
  }
}

/** A span id or count recorded as a nonnegative integer (a number or its decimal text). */
export function unsigned(value: unknown): bigint | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d{1,20}$/.test(value)) return BigInt(value);
  return undefined;
}
