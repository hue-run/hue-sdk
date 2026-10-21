import {
  anyValue,
  AttributeList,
  BlobSink,
  canonicalJson,
  ConversionError,
  digestHex,
  MAX_INLINE_VALUE_BYTES,
  SOURCE_RECORD,
  validateSource,
  type ConvertedTrace,
  type ImportEntry,
  type ImportSpan,
  type JsonValue,
  type OtlpAttribute,
  type Refusal,
  type TraceImportOrigin,
} from "../traces-import-convert.js";
import type { ConvertContext, TraceCollector } from "./adapter.js";
import { decideKey, resolveKey, type IdentityKeys } from "./identity.js";
import { genAiMessages } from "./messages.js";

/**
 * The canonical span row every row format maps its records to, and the one emitter that turns a
 * trace's rows into the OTLP spans Hue reads: the GenAI conventions for the operation, model,
 * messages, tool call and usage, the end user and conversation on the trace's root, and the
 * source record whole beside them. Nothing else writes spans for a row format.
 */

/** What a span did, as the GenAI conventions name it (`gen_ai.operation.name`). A span of none of
 * these (a task, a chain, a scorer) records no operation. */
export type SpanKind = "agent" | "llm" | "tool" | "embedding" | "retrieval";
const OPERATIONS: Record<SpanKind, string> = {
  agent: "invoke_agent",
  llm: "chat",
  tool: "execute_tool",
  embedding: "embeddings",
  retrieval: "retrieval",
};

export interface SpanRow {
  /** The source's trace id. Kept when it is 32 hex digits, otherwise mapped by SHA-256 with the
   * original kept as `hue.import.original_trace_id`. */
  traceKey: string;
  /** The source's span id: kept when it is 16 hex digits, otherwise mapped likewise. */
  spanKey: string;
  /** The parent's span id in the source. A parent the export does not hold leaves the span a
   * root of the trace, with the original kept as `hue.import.original_parent_span_id`. */
  parentKey?: string;
  /** Further parents, emitted as span links. */
  linkKeys?: string[];
  name: string;
  kind?: SpanKind;
  /** `gen_ai.operation.name` when the kind's is not the source's. */
  operation?: string;
  /** Recorded instants, in Unix nanoseconds (see {@link nanosFrom}). A missing one is inferred by
   * the documented rule and named in `hue.import.timing`. */
  start?: bigint;
  end?: bigint;
  /** How the adapter took a recorded instant from another field, such as `start_from_created`. */
  timing?: string;
  model?: string;
  responseModel?: string;
  provider?: string;
  agentName?: string;
  /** Content as recorded: chat messages in any common shape become `gen_ai.input.messages` and
   * `gen_ai.output.messages`; anything else is kept as `input.value` and `output.value`. */
  input?: JsonValue;
  output?: JsonValue;
  systemInstructions?: JsonValue;
  /** A tool call's own fields; `arguments` and `result` default to `input` and `output`. */
  tool?: {
    name?: string;
    callId?: string;
    type?: string;
    arguments?: JsonValue;
    result?: JsonValue;
  };
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
  };
  error?: { message?: string; type?: string };
  /** The end user and conversation the record names. Never taken from a tool row: a tool's
   * arguments and result may name the account it acted on, never who asked. */
  user?: string;
  session?: string;
  /** Evaluation or simulation traffic, which Hue keeps out of production history. */
  origin?: "evaluation" | "simulation";
  /** The deployment environment the source recorded (`deployment.environment.name`). */
  environment?: string;
  /** The format's own attributes, under its own names (never `hue.import.*`). */
  attributes?: Record<string, JsonValue>;
  resource?: Record<string, JsonValue>;
  /** The whole source record, kept as `hue.import.source_record`. */
  record: JsonValue;
  /** Where a dotted `--user-key` or `--session-key` looks after the span's attributes. */
  metadata?: JsonValue;
  /** A revision of a record exported more than once: the highest is kept. Decimal digits compare
   * as numbers. Without one, copies of a span must agree. */
  revision?: string;
  /** The record's position in its source, used to order an untimed trace. */
  sequence?: number;
}

/** A point in time on a span (a log line, a message): a span event. */
export interface EventRow {
  traceKey: string;
  spanKey: string;
  name: string;
  time?: bigint;
  attributes?: Record<string, JsonValue>;
  record: JsonValue;
}

/** The instrumentation scope version of every row span: raised when the emitted shape changes. */
const ROW_IMPORT_VERSION = "1";
const MAX_KEY = 4096;
/** Where an untimed trace is placed: 2000-01-01T00:00:00Z, a millisecond per record in order. */
const UNTIMED_EPOCH = 946_684_800_000_000_000n;
const MILLISECOND = 1_000_000n;
const MAX_NANOS = 18_446_744_073_709_551_615n;

const UNITS = { s: 9, ms: 6, us: 3, ns: 0 } as const;

/** A timestamp in `unit` (a number or its decimal text, exponent allowed) as Unix nanoseconds,
 * read from its decimal digits so no float rounding is added. */
export function nanosFrom(value: unknown, unit: keyof typeof UNITS): bigint {
  const text =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : typeof value === "string"
        ? value
        : "";
  const match = /^(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) throw new ConversionError("Invalid source timestamp");
  const shift = UNITS[unit] + Number(match[3] ?? 0);
  const digits = match[1]! + (match[2] ?? "");
  const point = match[1]!.length + shift;
  if (point > 40) throw new ConversionError("Invalid source timestamp");
  const whole = point <= 0 ? "0" : digits.padEnd(point, "0").slice(0, point);
  const nanos = BigInt(whole);
  if (nanos <= 0n || nanos > MAX_NANOS) throw new ConversionError("Invalid source timestamp");
  return nanos;
}

/** Reads each record with `read`: a record that throws a ConversionError refuses the trace
 * `traceKeyOf` names (or is reported alone), never the rest of the value. */
export function readRecords<T>(
  context: ConvertContext,
  records: readonly T[],
  traceKeyOf: (record: T) => string | undefined,
  read: (record: T) => void,
): void {
  for (const [index, record] of records.entries())
    try {
      read(record);
    } catch (error) {
      if (!(error instanceof ConversionError)) throw error;
      const at = records.length > 1 ? `record ${index + 1}: ` : "";
      context.refuse(`${at}${error.message}`, traceKeyOf(record));
    }
}

/** A 32- or 16-hex OpenTelemetry id as lowercase hex, or undefined. */
function otelId(value: string, length: 32 | 16): string | undefined {
  const lower = value.toLowerCase();
  return lower.length === length && /^[0-9a-f]+$/.test(lower) && !/^0+$/.test(lower)
    ? lower
    : undefined;
}

/** The OpenTelemetry trace id of a row format's trace: its own id when it is one, otherwise one
 * derived from the format and the id by SHA-256. */
export const rowTraceId = (format: string, traceKey: string): string =>
  otelId(traceKey, 32) ?? digestHex(`${format}.trace:${traceKey}`, 32);

function key(value: unknown, what: string): string {
  if (typeof value !== "string" || !value || value.length > MAX_KEY)
    throw new ConversionError(`The record has no valid ${what}`);
  return value;
}

/** Orders revisions; undefined when either is missing. */
function compareRevisions(a: string | undefined, b: string | undefined): number | undefined {
  if (a === undefined || b === undefined) return undefined;
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const [x, y] = [BigInt(a), BigInt(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Held {
  row: SpanRow;
  canonical: string;
}
interface Draft {
  rows: Map<string, Held>;
  events: { event: EventRow; canonical: string }[];
  sourceDigests: Set<string>;
  refusal?: string;
}

/** Gathers one row format's rows by trace across files and lines, and emits each trace. */
export class RowTraceCollector implements TraceCollector {
  private readonly traces = new Map<string, Draft>();
  constructor(
    private readonly format: string,
    private readonly keys: IdentityKeys = {},
  ) {}

  private draft(traceKey: string): Draft {
    let draft = this.traces.get(traceKey);
    if (!draft) {
      draft = { rows: new Map(), events: [], sourceDigests: new Set() };
      this.traces.set(traceKey, draft);
    }
    return draft;
  }

  add(row: SpanRow, sourceDigest: string): void {
    key(row.traceKey, "trace id");
    key(row.spanKey, "span id");
    validateSource(row.record);
    const draft = this.draft(row.traceKey);
    draft.sourceDigests.add(sourceDigest);
    const canonical = canonicalJson(row.record);
    const held = draft.rows.get(row.spanKey);
    if (!held) {
      draft.rows.set(row.spanKey, { row, canonical });
      return;
    }
    if (held.canonical === canonical) return;
    const order = compareRevisions(held.row.revision, row.revision);
    if (order === undefined || order === 0)
      draft.refusal ??= `span ${row.spanKey} appears with different content`;
    else if (order < 0) draft.rows.set(row.spanKey, { row, canonical });
  }

  addEvent(event: EventRow, sourceDigest: string): void {
    key(event.traceKey, "trace id");
    key(event.spanKey, "span id");
    validateSource(event.record);
    const draft = this.draft(event.traceKey);
    draft.sourceDigests.add(sourceDigest);
    const canonical = canonicalJson(event.record);
    if (!draft.events.some((held) => held.canonical === canonical))
      draft.events.push({ event, canonical });
  }

  finish(): { traces: ConvertedTrace[]; refused: Refusal[] } {
    const traces: ConvertedTrace[] = [];
    const refused: Refusal[] = [];
    for (const [traceKey, draft] of this.traces) {
      const traceId = rowTraceId(this.format, traceKey);
      if (draft.refusal || !draft.rows.size) {
        refused.push({
          traceId,
          reason: draft.refusal ?? "the export holds events of this trace but none of its spans",
        });
        continue;
      }
      try {
        traces.push(this.emit(traceKey, traceId, draft, refused));
      } catch (error) {
        if (!(error instanceof ConversionError)) throw error;
        refused.push({ traceId, reason: error.message });
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
    const keys = [...draft.rows.keys()].sort();
    const rows = new Map(keys.map((spanKey) => [spanKey, draft.rows.get(spanKey)!.row]));
    // Span ids in key order, so a collision is salted the same way whatever order rows arrived.
    const spanIds = new Map<string, string>();
    const taken = new Set<string>();
    let remappedSpans = 0;
    for (const spanKey of keys) {
      let spanId = otelId(spanKey, 16) ?? digestHex(`${format}.span:${traceId}:${spanKey}`, 16);
      for (let salt = 0; taken.has(spanId); salt++)
        spanId = digestHex(`${format}.span:${traceId}:${spanKey}#${salt}`, 16);
      if (spanId !== spanKey) remappedSpans++;
      taken.add(spanId);
      spanIds.set(spanKey, spanId);
    }
    const parentOf = (row: SpanRow) =>
      row.parentKey !== undefined && row.parentKey !== row.spanKey && rows.has(row.parentKey)
        ? row.parentKey
        : undefined;
    for (const spanKey of keys) {
      const seen = new Set<string>();
      for (let at: string | undefined = spanKey; at !== undefined; at = parentOf(rows.get(at)!)) {
        if (seen.has(at)) throw new ConversionError("The source hierarchy contains a cycle");
        seen.add(at);
      }
    }
    const { starts, ends, notes } = timesOf(rows, parentOf);
    const traceNotes = new Set([...notes.values()].flat());
    // The trace's user and conversation: from the identity keys when they name one across the
    // agent's rows, else from the rows' own; tool rows and rows beneath them never count.
    const spans = keys.map((spanKey) => {
      const row = rows.get(spanKey)!;
      const parentKey = parentOf(row);
      return {
        spanId: spanKey,
        ...(parentKey !== undefined ? { parentSpanId: parentKey } : {}),
        row,
      };
    });
    const tool = (span: (typeof spans)[number]) => span.row.kind === "tool";
    const keyed = (path: IdentityKeys["user"], span: (typeof spans)[number]) =>
      path &&
      resolveKey(
        path,
        { attributes: new Map(Object.entries(span.row.attributes ?? {})) },
        span.row.record,
        span.row.metadata,
      );
    const decide = (path: IdentityKeys["user"], own: (row: SpanRow) => string | undefined) => {
      const fromKey = path ? decideKey(spans, tool, (span) => keyed(path, span)) : { found: false };
      return fromKey.found ? fromKey.value : decideKey(spans, tool, (span) => own(span.row)).value;
    };
    const user = decide(this.keys.user, (row) => row.user);
    const session = decide(this.keys.session, (row) => row.session);
    const blobs = new BlobSink();
    let origin: TraceImportOrigin = "unknown";
    const order = (a: string, b: string) => {
      const [x, y] = [starts.get(a)!, starts.get(b)!];
      return x < y ? -1 : x > y ? 1 : spanIds.get(a)! < spanIds.get(b)! ? -1 : 1;
    };
    const events = new Map<string, EventRow[]>();
    for (const { event } of draft.events) {
      if (!rows.has(event.spanKey)) {
        refused.push({
          reason: `an event for span ${event.spanKey}, which the export does not hold`,
        });
        continue;
      }
      events.set(event.spanKey, [...(events.get(event.spanKey) ?? []), event]);
    }
    const entries = [...keys].sort(order).map((spanKey): ImportEntry => {
      const row = rows.get(spanKey)!;
      const parentKey = parentOf(row);
      const root = parentKey === undefined;
      if (row.origin === "evaluation") origin = "evaluation";
      else if (row.origin === "simulation" && origin !== "evaluation") origin = "simulation";
      else if (row.environment === "production" && origin === "unknown") origin = "production";
      const attributes = new AttributeList(blobs);
      const operation = row.operation ?? (row.kind ? OPERATIONS[row.kind] : undefined);
      if (operation) attributes.add("gen_ai.operation.name", operation);
      if (row.model) attributes.add("gen_ai.request.model", row.model);
      if (row.responseModel) attributes.add("gen_ai.response.model", row.responseModel);
      if (row.provider) attributes.add("gen_ai.provider.name", row.provider);
      if (row.agentName) attributes.add("gen_ai.agent.name", row.agentName);
      if (root && row.kind !== "tool") {
        if (user !== undefined) attributes.add("user.id", user);
        if (session !== undefined) attributes.add("gen_ai.conversation.id", session);
      }
      addContent(attributes, row);
      for (const [field, name] of [
        ["input", "gen_ai.usage.input_tokens"],
        ["output", "gen_ai.usage.output_tokens"],
        ["cacheRead", "gen_ai.usage.cache_read.input_tokens"],
        ["cacheWrite", "gen_ai.usage.cache_write.input_tokens"],
        ["reasoning", "gen_ai.usage.reasoning.output_tokens"],
      ] as const) {
        const count = row.usage?.[field];
        if (count !== undefined && Number.isSafeInteger(count) && count >= 0)
          attributes.add(name, count);
      }
      if (row.error?.type) attributes.add("error.type", row.error.type);
      for (const [name, value] of Object.entries(row.attributes ?? {})) {
        if (name.startsWith("hue.import."))
          throw new ConversionError("Source attributes use reserved import keys");
        attributes.add(name, value);
      }
      attributes.add("hue.import.format", format);
      if (traceId !== traceKey) attributes.add("hue.import.original_trace_id", traceKey);
      if (spanIds.get(spanKey) !== spanKey) attributes.add("hue.import.original_span_id", spanKey);
      if (root && row.parentKey !== undefined && row.parentKey !== row.spanKey)
        attributes.add("hue.import.original_parent_span_id", row.parentKey);
      if (row.sequence !== undefined) attributes.add("hue.import.source_index", row.sequence);
      const spanNotes = [...(row.timing ? [row.timing] : []), ...(notes.get(spanKey) ?? [])];
      if (row.timing) traceNotes.add(row.timing);
      if (spanNotes.length) attributes.add("hue.import.timing", spanNotes.join("; "));
      attributes.add(SOURCE_RECORD, JSON.stringify(row.record));
      const start = starts.get(spanKey)!;
      const spanEvents = (events.get(spanKey) ?? [])
        .map((event) => {
          if (event.time === undefined) traceNotes.add("event_at_span_start");
          return { event, time: event.time ?? start };
        })
        .sort((a, b) =>
          a.time < b.time
            ? -1
            : a.time > b.time
              ? 1
              : canonicalJson(a.event.record) < canonicalJson(b.event.record)
                ? -1
                : 1,
        )
        .flatMap(({ event, time }) => {
          const record = JSON.stringify(event.record);
          if (Buffer.byteLength(record) > MAX_INLINE_VALUE_BYTES) {
            refused.push({ reason: `an event of span ${spanKey} is over the inline value limit` });
            return [];
          }
          return [
            {
              timeUnixNano: time.toString(),
              name: event.name,
              attributes: [
                ...Object.entries(event.attributes ?? {}).map(([name, value]) => ({
                  key: name,
                  value: anyValue(value),
                })),
                { key: SOURCE_RECORD, value: { stringValue: record } },
              ],
            },
          ];
        });
      const links = (row.linkKeys ?? [])
        .filter((link) => rows.has(link) && link !== parentKey)
        .map((link) => ({ traceId, spanId: spanIds.get(link)!, attributes: [] }));
      const span: ImportSpan & { events?: unknown[]; links?: unknown[] } = {
        traceId,
        spanId: spanIds.get(spanKey)!,
        ...(parentKey !== undefined ? { parentSpanId: spanIds.get(parentKey)! } : {}),
        name: row.name,
        kind: 1,
        startTimeUnixNano: start.toString(),
        endTimeUnixNano: ends.get(spanKey)!.toString(),
        attributes: attributes.finish(),
        status: row.error
          ? { code: 2, ...(row.error.message ? { message: row.error.message } : {}) }
          : { code: 0 },
        ...(spanEvents.length ? { events: spanEvents } : {}),
        ...(links.length ? { links } : {}),
      };
      const resource: OtlpAttribute[] = Object.entries(row.resource ?? {}).map(([name, value]) => ({
        key: name,
        value: anyValue(value),
      }));
      if (row.environment && !row.resource?.["deployment.environment.name"])
        resource.push({
          key: "deployment.environment.name",
          value: { stringValue: row.environment },
        });
      return {
        resource: { attributes: resource },
        scopeSpans: [
          { scope: { name: `hue.import.${format}`, version: ROW_IMPORT_VERSION }, spans: [span] },
        ],
      };
    });
    const inferredTiming = [...traceNotes].sort();
    return {
      traceId,
      format,
      entries,
      blobs: blobs.sorted(),
      origin,
      sourceDigests: draft.sourceDigests,
      remappedTraceId: traceId !== traceKey,
      remappedSpans,
      ...(inferredTiming.length ? { inferredTiming } : {}),
    };
  }
}

/** A row's content under the GenAI conventions: a tool's arguments and result, or chat messages,
 * or the raw value as `input.value`/`output.value`. */
function addContent(attributes: AttributeList, row: SpanRow): void {
  if (row.kind === "tool") {
    attributes.add("gen_ai.tool.name", row.tool?.name ?? row.name);
    if (row.tool?.callId) attributes.add("gen_ai.tool.call.id", row.tool.callId);
    if (row.tool?.type) attributes.add("gen_ai.tool.type", row.tool.type);
    const args = row.tool?.arguments ?? row.input;
    const result = row.tool?.result ?? row.output;
    if (args !== undefined) attributes.json("gen_ai.tool.call.arguments", args);
    if (result !== undefined) attributes.json("gen_ai.tool.call.result", result);
    return;
  }
  const chat = row.kind === "llm" || row.kind === "agent";
  if (row.systemInstructions !== undefined && row.systemInstructions !== null)
    attributes.json(
      "gen_ai.system_instructions",
      typeof row.systemInstructions === "string"
        ? [{ type: "text", content: row.systemInstructions }]
        : row.systemInstructions,
    );
  for (const [field, role] of [
    ["input", "user"],
    ["output", "assistant"],
  ] as const) {
    const value = row[field];
    if (value === undefined || value === null) continue;
    const messages = genAiMessages(value, chat ? role : undefined);
    if (messages) attributes.json(`gen_ai.${field}.messages`, messages);
    else if (typeof value === "string") {
      attributes.add(`${field}.value`, value);
      attributes.add(`${field}.mime_type`, "text/plain");
    } else {
      attributes.json(`${field}.value`, value);
      attributes.add(`${field}.mime_type`, "application/json");
    }
  }
}

/**
 * Every span's start and end, the recorded ones kept and the rest inferred by these rules, each
 * named in the span's `hue.import.timing` and the report:
 * - `start_at_end`: no start but an end: the span starts at its end;
 * - `start_from_parent`: no instant at all: the span starts with its parent;
 * - `start_from_trace`: nor has its parent: it starts with the trace's earliest recorded instant;
 * - `untimed_trace`: the trace records no instant: spans are placed at 2000-01-01T00:00:00Z, a
 *   millisecond apart in source order;
 * - `end_from_children` / `end_at_start`: no end: the span ends with its last child, else at its
 *   start.
 * A recorded end before its start refuses the trace.
 */
function timesOf(
  rows: ReadonlyMap<string, SpanRow>,
  parentOf: (row: SpanRow) => string | undefined,
): { starts: Map<string, bigint>; ends: Map<string, bigint>; notes: Map<string, string[]> } {
  const notes = new Map<string, string[]>();
  const note = (spanKey: string, rule: string) =>
    notes.set(spanKey, [...(notes.get(spanKey) ?? []), rule]);
  const recorded = [...rows.values()].flatMap((row) =>
    [row.start, row.end].filter((time) => time !== undefined),
  );
  const earliest = recorded.reduce<bigint | undefined>(
    (min, time) => (min === undefined || time < min ? time : min),
    undefined,
  );
  const starts = new Map<string, bigint>();
  if (earliest === undefined) {
    const ordered = [...rows.values()].sort(
      (a, b) =>
        (a.sequence ?? Infinity) - (b.sequence ?? Infinity) || (a.spanKey < b.spanKey ? -1 : 1),
    );
    for (const [index, row] of ordered.entries()) {
      starts.set(row.spanKey, UNTIMED_EPOCH + BigInt(index) * MILLISECOND);
      note(row.spanKey, "untimed_trace");
    }
  }
  const startOf = (row: SpanRow): bigint => {
    const known = starts.get(row.spanKey);
    if (known !== undefined) return known;
    let start: bigint;
    if (row.start !== undefined) start = row.start;
    else if (row.end !== undefined) {
      start = row.end;
      note(row.spanKey, "start_at_end");
    } else {
      const parent = parentOf(row);
      const inherited = parent === undefined ? undefined : startOf(rows.get(parent)!);
      start = inherited ?? earliest!;
      note(row.spanKey, inherited === undefined ? "start_from_trace" : "start_from_parent");
    }
    starts.set(row.spanKey, start);
    return start;
  };
  for (const row of rows.values()) startOf(row);
  const children = new Map<string, SpanRow[]>();
  for (const row of rows.values()) {
    const parent = parentOf(row);
    if (parent !== undefined) children.set(parent, [...(children.get(parent) ?? []), row]);
  }
  const ends = new Map<string, bigint>();
  const endOf = (row: SpanRow): bigint => {
    const known = ends.get(row.spanKey);
    if (known !== undefined) return known;
    const start = starts.get(row.spanKey)!;
    let end: bigint;
    if (row.end !== undefined && row.start !== undefined) {
      if (row.end < start) throw new ConversionError(`span ${row.spanKey} ends before it starts`);
      end = row.end;
    } else if (row.end !== undefined) end = row.end;
    else {
      const last = (children.get(row.spanKey) ?? [])
        .map(endOf)
        .reduce((max, time) => (time > max ? time : max), start);
      end = last;
      note(row.spanKey, last > start ? "end_from_children" : "end_at_start");
    }
    ends.set(row.spanKey, end);
    return end;
  };
  for (const row of rows.values()) endOf(row);
  return { starts, ends, notes };
}
