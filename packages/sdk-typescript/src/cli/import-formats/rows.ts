import {
  anyValue,
  AttributeList,
  BlobSink,
  canonicalJson,
  ConversionError,
  conversionFailure,
  digestHex,
  MAX_INLINE_VALUE_BYTES,
  sha256Hex,
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
import type { ConvertContext, Location, TraceCollector } from "./adapter.js";
import {
  decideKey,
  namesIdentity,
  resolveKey,
  subtreeIds,
  withoutIdentity,
  type IdentityKeys,
  type IdentityKind,
} from "./identity.js";
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
  /** Links the source records to a span of this trace or of another, by that trace's and span's
   * keys as recorded, mapped to OpenTelemetry ids as their own spans' are. */
  links?: { traceKey: string; spanKey: string; attributes?: Record<string, JsonValue> }[];
  name: string;
  kind?: SpanKind;
  /** `gen_ai.operation.name` when the kind's is not the source's. */
  operation?: string;
  /** Recorded instants, in Unix nanoseconds (see {@link nanosFrom}). A missing one is inferred by
   * the documented rule and named in `hue.import.timing`. */
  start?: bigint;
  end?: bigint;
  /** How the adapter took a recorded instant from another field, such as `start_from_created`;
   * several rules are separated by `; `. */
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
  /** The vendor's own evaluation recorded inside the trace (a scorer, a judge, an automation):
   * this row and every row beneath it are emitted without a GenAI operation, model, messages,
   * tool call, usage or identity attribute, their content kept as `input.value`/`output.value`,
   * and never name the trace's user or conversation, as a tool's subtree never does. */
  scoring?: boolean;
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

/** Reads each record with `read`: a record that throws a ConversionError (or is too deep or
 * large to walk) refuses the trace `traceKeyOf` names (or is reported alone), never the rest of
 * the value. */
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
      const failure = conversionFailure(error);
      if (!failure) throw error;
      const at = records.length > 1 ? `record ${index + 1}: ` : "";
      let traceKey: string | undefined;
      try {
        traceKey = traceKeyOf(record);
      } catch (keyError) {
        if (!conversionFailure(keyError)) throw keyError;
      }
      context.refuse(`${at}${failure.message}`, traceKey);
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
  /** The SHA-256 of the record's canonical JSON, which a copy must match. */
  digest: string;
  /** Where the record was first read, for the report. */
  at?: Location;
}
interface Draft {
  rows: Map<string, Held>;
  /** Events by span, record and how many identical records the same value gave that span before
   * it: a record repeated within one source is kept each time, the same source read again once. */
  events: Map<string, EventRow>;
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
      draft = { rows: new Map(), events: new Map(), sourceDigests: new Set() };
      this.traces.set(traceKey, draft);
    }
    return draft;
  }

  /**
   * Adds a row read at `at`. Returns where an identical copy of the record was read before, when
   * one was read somewhere else: the record is then read once, and the caller may say so.
   */
  add(row: SpanRow, sourceDigest: string, at?: Location): Location | undefined {
    key(row.traceKey, "trace id");
    key(row.spanKey, "span id");
    validateSource(row.record);
    const draft = this.draft(row.traceKey);
    draft.sourceDigests.add(sourceDigest);
    const digest = sha256Hex(canonicalJson(row.record));
    const held = draft.rows.get(row.spanKey);
    if (!held) {
      draft.rows.set(row.spanKey, { row, digest, ...(at ? { at } : {}) });
      return undefined;
    }
    if (held.digest === digest) {
      const elsewhere =
        at &&
        held.at &&
        (held.at.file !== at.file || held.at.line !== at.line || held.at.record !== at.record);
      return elsewhere ? held.at : undefined;
    }
    const order = compareRevisions(held.row.revision, row.revision);
    if (order === undefined || order === 0)
      draft.refusal ??= `span ${row.spanKey} appears with different content`;
    else if (order < 0) draft.rows.set(row.spanKey, { row, digest, ...(at ? { at } : {}) });
    return undefined;
  }

  /**
   * Adds an event. `repeats` counts, for one source value, the identical records it gave each span
   * so far: an event the value repeats on a span is kept each time, the same value read again (a
   * file read twice) adds nothing.
   */
  addEvent(event: EventRow, sourceDigest: string, repeats = new Map<string, number>()): void {
    key(event.traceKey, "trace id");
    key(event.spanKey, "span id");
    validateSource(event.record);
    const draft = this.draft(event.traceKey);
    draft.sourceDigests.add(sourceDigest);
    const copy = `${event.traceKey}\u0000${event.spanKey}\u0000${eventDigest(event)}`;
    const occurrence = repeats.get(copy) ?? 0;
    repeats.set(copy, occurrence + 1);
    const id = `${copy}\u0000${occurrence}`;
    if (!draft.events.has(id)) draft.events.set(id, event);
  }

  finish(): { traces: ConvertedTrace[]; refused: Refusal[] } {
    const traces: ConvertedTrace[] = [];
    const refused: Refusal[] = [];
    for (const [traceKey, draft] of this.traces) {
      // Each draft is let go once its trace is emitted, so a run holds one copy of each record.
      this.traces.delete(traceKey);
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
    if (cyclic(rows, parentOf)) throw new ConversionError("The source hierarchy contains a cycle");
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
    // The vendor's own evaluation inside the trace, and every row beneath it.
    const scored = subtreeIds(spans, (span) => span.row.scoring === true);
    const tool = (span: (typeof spans)[number]) =>
      span.row.kind === "tool" || span.row.scoring === true;
    const keyed = (path: IdentityKeys["user"], span: (typeof spans)[number]) =>
      path &&
      resolveKey(
        path,
        {
          attributes: new Map(Object.entries(span.row.attributes ?? {})),
          resource: new Map(Object.entries(span.row.resource ?? {})),
        },
        span.row.record,
        span.row.metadata,
      );
    const decide = (path: IdentityKeys["user"], own: (row: SpanRow) => string | undefined) => {
      const fromKey = path ? decideKey(spans, tool, (span) => keyed(path, span)) : { found: false };
      return fromKey.found
        ? { keyed: true, value: fromKey.value }
        : { keyed: false, value: decideKey(spans, tool, (span) => own(span.row)).value };
    };
    const user = decide(this.keys.user, (row) => row.user);
    const session = decide(this.keys.session, (row) => row.session);
    // What a key decided, a user or none, is the trace's: no span keeps a recorded attribute Hue
    // would read another from.
    const keyedKinds: IdentityKind[] = [];
    if (user.keyed) keyedKinds.push("user");
    if (session.keyed) keyedKinds.push("session");
    const blobs = new BlobSink();
    let origin: TraceImportOrigin = "unknown";
    const order = (a: string, b: string) => {
      const [x, y] = [starts.get(a)!, starts.get(b)!];
      return x < y ? -1 : x > y ? 1 : spanIds.get(a)! < spanIds.get(b)! ? -1 : 1;
    };
    const events = new Map<string, EventRow[]>();
    for (const event of draft.events.values()) {
      if (!rows.has(event.spanKey)) {
        refused.push({
          reason: `an event for span ${event.spanKey}, which the export does not hold`,
        });
        continue;
      }
      const held = events.get(event.spanKey);
      if (held) held.push(event);
      else events.set(event.spanKey, [event]);
    }
    const entries = [...keys].sort(order).map((spanKey): ImportEntry => {
      const row = rows.get(spanKey)!;
      const parentKey = parentOf(row);
      const root = parentKey === undefined;
      const scoring = scored.has(spanKey);
      if (row.origin === "evaluation") origin = "evaluation";
      else if (row.origin === "simulation" && origin !== "evaluation") origin = "simulation";
      else if (row.environment === "production" && origin === "unknown") origin = "production";
      const attributes = new AttributeList(blobs);
      const own: [string, JsonValue][] = [];
      for (const [name, value] of Object.entries(row.attributes ?? {})) {
        let kept: JsonValue | undefined = value;
        for (const kind of keyedKinds)
          if (kept !== undefined) kept = withoutIdentity(kind, name, kept);
        if (kept !== undefined) own.push([name, kept]);
      }
      // An attribute the source recorded under its own name is kept as recorded; the emitter
      // adds none of the same name beside it.
      const recorded = new Set(own.map(([name]) => name));
      const add = (name: string, value: JsonValue) => {
        if (!recorded.has(name)) attributes.add(name, value);
      };
      if (!scoring) {
        const operation = row.operation ?? (row.kind ? OPERATIONS[row.kind] : undefined);
        if (operation) add("gen_ai.operation.name", operation);
        if (row.model) add("gen_ai.request.model", row.model);
        if (row.responseModel) add("gen_ai.response.model", row.responseModel);
        if (row.provider) add("gen_ai.provider.name", row.provider);
        if (row.agentName) add("gen_ai.agent.name", row.agentName);
        if (root && row.kind !== "tool") {
          if (user.value !== undefined) add("user.id", user.value);
          if (session.value !== undefined) add("gen_ai.conversation.id", session.value);
        }
      }
      addContent(add, row, scoring);
      for (const [field, name] of [
        ["input", "gen_ai.usage.input_tokens"],
        ["output", "gen_ai.usage.output_tokens"],
        ["cacheRead", "gen_ai.usage.cache_read.input_tokens"],
        ["cacheWrite", "gen_ai.usage.cache_write.input_tokens"],
        ["reasoning", "gen_ai.usage.reasoning.output_tokens"],
      ] as const) {
        const count = row.usage?.[field];
        if (!scoring && count !== undefined && Number.isSafeInteger(count) && count >= 0)
          add(name, count);
      }
      if (row.error?.type) add("error.type", row.error.type);
      for (const [name, value] of own) {
        if (name.startsWith("hue.import."))
          throw new ConversionError("Source attributes use reserved import keys");
        // A scorer's metadata may name a user; Hue never reads one from the vendor's evaluation.
        if (scoring && namesIdentity(name)) continue;
        attributes.add(name, value);
      }
      attributes.add("hue.import.format", format);
      if (traceId !== traceKey) attributes.add("hue.import.original_trace_id", traceKey);
      if (spanIds.get(spanKey) !== spanKey) attributes.add("hue.import.original_span_id", spanKey);
      if (root && row.parentKey !== undefined && row.parentKey !== row.spanKey)
        attributes.add("hue.import.original_parent_span_id", row.parentKey);
      if (row.sequence !== undefined) attributes.add("hue.import.source_index", row.sequence);
      const spanNotes = [...(row.timing ? [row.timing] : []), ...(notes.get(spanKey) ?? [])];
      for (const rule of row.timing?.split("; ") ?? []) traceNotes.add(rule);
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
              : eventDigest(a.event) < eventDigest(b.event)
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
      const links = [
        ...(row.linkKeys ?? [])
          .filter((link) => rows.has(link) && link !== parentKey)
          .map((link) => ({ traceId, spanId: spanIds.get(link)!, attributes: [] })),
        ...(row.links ?? []).map((link) => {
          const linkTrace =
            link.traceKey === traceKey ? traceId : rowTraceId(format, link.traceKey);
          const held = link.traceKey === traceKey ? spanIds.get(link.spanKey) : undefined;
          return {
            traceId: linkTrace,
            spanId:
              held ??
              otelId(link.spanKey, 16) ??
              digestHex(`${format}.span:${linkTrace}:${link.spanKey}`, 16),
            attributes: Object.entries(link.attributes ?? {}).map(([name, value]) => ({
              key: name,
              value: anyValue(value),
            })),
          };
        }),
      ];
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
 * or the raw value as `input.value`/`output.value`. A scoring row's content is always raw. */
function addContent(
  add: (name: string, value: JsonValue) => void,
  row: SpanRow,
  scoring: boolean,
): void {
  if (row.kind === "tool" && !scoring) {
    add("gen_ai.tool.name", row.tool?.name ?? row.name);
    if (row.tool?.callId) add("gen_ai.tool.call.id", row.tool.callId);
    if (row.tool?.type) add("gen_ai.tool.type", row.tool.type);
    const args = row.tool?.arguments ?? row.input;
    const result = row.tool?.result ?? row.output;
    if (args !== undefined) add("gen_ai.tool.call.arguments", JSON.stringify(args));
    if (result !== undefined) add("gen_ai.tool.call.result", JSON.stringify(result));
    return;
  }
  const chat = row.kind === "llm" || row.kind === "agent";
  if (!scoring && row.systemInstructions !== undefined && row.systemInstructions !== null)
    add(
      "gen_ai.system_instructions",
      JSON.stringify(
        typeof row.systemInstructions === "string"
          ? [{ type: "text", content: row.systemInstructions }]
          : row.systemInstructions,
      ),
    );
  for (const [field, role] of [
    ["input", "user"],
    ["output", "assistant"],
  ] as const) {
    const value = row[field];
    if (value === undefined || value === null) continue;
    const messages = scoring ? undefined : genAiMessages(value, chat ? role : undefined);
    if (messages) add(`gen_ai.${field}.messages`, JSON.stringify(messages));
    else if (typeof value === "string") {
      add(`${field}.value`, value);
      add(`${field}.mime_type`, "text/plain");
    } else {
      add(`${field}.value`, JSON.stringify(value));
      add(`${field}.mime_type`, "application/json");
    }
  }
}

/** The SHA-256 of an event's record, by which copies of it are told apart. */
const eventDigests = new WeakMap<EventRow, string>();
function eventDigest(event: EventRow): string {
  let digest = eventDigests.get(event);
  if (digest === undefined) {
    digest = sha256Hex(canonicalJson(event.record));
    eventDigests.set(event, digest);
  }
  return digest;
}

/** Whether the parents of a trace's rows close on themselves anywhere; each row's ancestry is
 * walked once, so the check takes time in proportion to the rows. */
export function cyclic(
  rows: ReadonlyMap<string, SpanRow>,
  parentOf: (row: SpanRow) => string | undefined,
): boolean {
  const settled = new Set<string>();
  for (const spanKey of rows.keys()) {
    const path = new Set<string>();
    for (
      let at: string | undefined = spanKey;
      at !== undefined && !settled.has(at);
      at = parentOf(rows.get(at)!)
    ) {
      if (path.has(at)) return true;
      path.add(at);
    }
    for (const done of path) settled.add(done);
  }
  return false;
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
export function timesOf(
  rows: ReadonlyMap<string, SpanRow>,
  parentOf: (row: SpanRow) => string | undefined,
): { starts: Map<string, bigint>; ends: Map<string, bigint>; notes: Map<string, string[]> } {
  const notes = new Map<string, string[]>();
  const note = (spanKey: string, rule: string) => {
    const held = notes.get(spanKey);
    if (held) held.push(rule);
    else notes.set(spanKey, [rule]);
  };
  let earliest: bigint | undefined;
  for (const row of rows.values())
    for (const time of [row.start, row.end])
      if (time !== undefined && (earliest === undefined || time < earliest)) earliest = time;
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
  // Starts: a row without an instant takes its nearest ancestor's start, found by walking up to
  // the first row whose start is settled and settling the path on the way back down, without
  // recursion (the hierarchy is acyclic: the caller checked).
  const ownStart = (row: SpanRow): bigint | undefined => {
    if (row.start !== undefined) return row.start;
    if (row.end !== undefined) {
      note(row.spanKey, "start_at_end");
      return row.end;
    }
    return undefined;
  };
  for (const row of rows.values()) {
    if (starts.has(row.spanKey)) continue;
    const path: SpanRow[] = [];
    let inherited: bigint | undefined;
    for (let at: SpanRow | undefined = row; at; ) {
      const known = starts.get(at.spanKey);
      if (known !== undefined) {
        inherited = known;
        break;
      }
      const own = ownStart(at);
      if (own !== undefined) {
        starts.set(at.spanKey, own);
        inherited = own;
        break;
      }
      path.push(at);
      const parent = parentOf(at);
      at = parent === undefined ? undefined : rows.get(parent);
    }
    // The path's first rows are the deepest; the last is the one nearest the settled ancestor,
    // or the root without a parent, which starts with the trace.
    for (let index = path.length - 1; index >= 0; index--) {
      const at = path[index]!;
      note(at.spanKey, inherited !== undefined ? "start_from_parent" : "start_from_trace");
      inherited ??= earliest!;
      starts.set(at.spanKey, inherited);
    }
  }
  const children = new Map<string, SpanRow[]>();
  for (const row of rows.values()) {
    const parent = parentOf(row);
    if (parent === undefined) continue;
    const held = children.get(parent);
    if (held) held.push(row);
    else children.set(parent, [row]);
  }
  // Ends: a row without one ends with its last child, so children are settled first, in a
  // depth-first order kept on an explicit stack.
  const ends = new Map<string, bigint>();
  const settle = (row: SpanRow) => {
    const start = starts.get(row.spanKey)!;
    if (row.end !== undefined) {
      if (row.start !== undefined && row.end < start)
        throw new ConversionError(`span ${row.spanKey} ends before it starts`);
      ends.set(row.spanKey, row.end);
      return;
    }
    let last = start;
    for (const child of children.get(row.spanKey) ?? []) {
      const end = ends.get(child.spanKey)!;
      if (end > last) last = end;
    }
    ends.set(row.spanKey, last);
    note(row.spanKey, last > start ? "end_from_children" : "end_at_start");
  };
  for (const row of rows.values()) {
    if (ends.has(row.spanKey)) continue;
    const stack: { row: SpanRow; expanded: boolean }[] = [{ row, expanded: false }];
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      if (ends.has(top.row.spanKey)) {
        stack.pop();
        continue;
      }
      // A row with its own end needs no child's.
      if (top.expanded || top.row.end !== undefined) {
        stack.pop();
        settle(top.row);
        continue;
      }
      top.expanded = true;
      for (const child of children.get(top.row.spanKey) ?? [])
        if (!ends.has(child.spanKey)) stack.push({ row: child, expanded: false });
    }
  }
  return { starts, ends, notes };
}
