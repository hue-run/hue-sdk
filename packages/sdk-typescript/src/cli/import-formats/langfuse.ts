import {
  ConversionError,
  conversionFailure,
  isObject,
  langfuseEvaluationEnvironment,
  LangfuseTraceCollector,
  parseNestedJsonText,
  validateSource,
  type ConvertedTrace,
  type JsonValue,
  type Refusal,
} from "../traces-import-convert.js";
import type { ImportAdapter, TraceCollector } from "./adapter.js";
import { identityText, type IdentityKeys } from "./identity.js";
import { readRecords, RowTraceCollector, rowTraceId, type SpanKind, type SpanRow } from "./rows.js";

/**
 * Langfuse exports, read by two formats:
 *
 * - `langfuse_observations`: the observation list Hue documents, a `data` or native
 *   `observations` envelope whose every record is an observation without a `projectId`,
 *   converted as Hue's own reader converts it (`traces-import-convert.ts`).
 * - `langfuse`: everything Langfuse itself writes, as canonical rows. Every observation of a
 *   Langfuse API page carries its `projectId`, which is how a page is told apart from Hue's list.
 *   - Public API: `GET /api/public/traces/{id}` (a trace with its observations), trace and
 *     observation list pages (v1), Observations API v2 pages, `GET /api/public/sessions/{id}`.
 *   - UI downloads of the traces, observations and events tables: a JSON array or JSON Lines.
 *   - Blob storage exports of the `traces`, `observations` and `observations_v2` tables: JSON
 *     or JSON Lines, gzip by default, snake_case columns and ClickHouse instants.
 *
 * How `langfuse` reads them:
 * - Records are gathered by trace across every file. A trace record (from any of the shapes
 *   above) becomes the trace's root span `t-<trace id>`, the id Langfuse gives the same root, and
 *   the observations without a parent go under it, as `hue import langfuse` builds a v1 trace.
 *   An observation already named `t-<trace id>` is that root, and no other is made.
 * - The trace record's `userId` and `sessionId` name the end user and conversation, as do each
 *   observation's (Observations API v2 and enriched exports copy them onto every observation);
 *   a tool observation's never do.
 * - `GENERATION` is a model call, `TOOL` a tool call, `AGENT`, `EMBEDDING` and `RETRIEVER` their
 *   GenAI operations; other types record none. An `EVALUATOR` (a judge assessing an output) and
 *   everything beneath it is Langfuse's evaluation, not the agent's work: no GenAI operation,
 *   messages or usage, and never the trace's user. `level` `ERROR` is an error with the status
 *   message.
 * - Token usage is `usageDetails` as Langfuse totals it: input and output are the sums of every
 *   key naming them (so cached and reasoning tokens are included), cache reads
 *   `input_cached_tokens` or `input_cache_read`, cache writes `input_cache_write` or
 *   `input_cache_creation`, reasoning `output_reasoning_tokens`.
 * - Input, output and metadata values recorded as JSON text (the v2 API, blob storage, the
 *   events table) are read as the JSON they hold. Metadata's `resourceAttributes` become the
 *   span's resource.
 * - An instant without a zone (ClickHouse's `YYYY-MM-DD HH:MM:SS.ffffff`) is UTC, as Langfuse
 *   writes and reads it.
 * - Langfuse's `default` environment is no deployment environment. Its experiment and
 *   evaluation environments (`sdk-experiment`, `langfuse-…`) and Hue's evaluation and simulation
 *   markers make the trace evaluation or simulation traffic.
 * - Copies of a record keep the latest `updatedAt`.
 * - `--user-key` and `--session-key` replace the user and conversation the records name, as for
 *   every row format.
 *
 * A page of the documented list holding an integer JavaScript cannot represent exactly refuses
 * only the traces of the observations that hold one, as Hue's reader would refuse them.
 */

type Fields = Record<string, JsonValue>;

const object = (value: JsonValue | undefined): Fields | undefined =>
  isObject(value) ? (value as Fields) : undefined;
const text = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" && value ? value : undefined;
/** A field under its camelCase (API, UI) or snake_case (blob storage) name. */
const field = (record: Fields, ...names: string[]): JsonValue | undefined => {
  for (const name of names)
    if (record[name] !== undefined && record[name] !== null) return record[name];
  return undefined;
};

// --- Detection ----------------------------------------------------------------------------------

const isObservation = (value: unknown): value is Fields =>
  isObject(value) &&
  typeof value.id === "string" &&
  typeof value.traceId === "string" &&
  typeof value.type === "string" &&
  typeof value.startTime === "string";

/** Hue's documented observation list: every record an observation without Langfuse's project id. */
const documented = (value: unknown): value is Fields[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((record) => isObservation(record) && !("projectId" in record));

/** An observation as Langfuse's API and UI write it (`traceId` may be null in the v2 API). */
const isCamelObservation = (value: unknown): value is Fields =>
  isObject(value) &&
  typeof value.id === "string" &&
  typeof value.type === "string" &&
  typeof value.startTime === "string" &&
  "traceId" in value;

/** An observation row of a blob storage export (`observations`, `observations_v2`). */
const isSnakeObservation = (value: unknown): value is Fields =>
  isObject(value) &&
  typeof value.id === "string" &&
  typeof value.type === "string" &&
  typeof value.start_time === "string" &&
  "trace_id" in value &&
  "parent_observation_id" in value;

/** A trace: an API trace (with or without its observations), a traces-table download or blob
 * row. Every one carries `bookmarked` and `public`. */
const isTraceRecord = (value: unknown): value is Fields & { id: string; timestamp: string } =>
  isObject(value) &&
  typeof value.id === "string" &&
  typeof value.timestamp === "string" &&
  "bookmarked" in value &&
  "public" in value &&
  !("traceId" in value) &&
  !("trace_id" in value);

const isRecord = (value: unknown) =>
  isCamelObservation(value) || isSnakeObservation(value) || isTraceRecord(value);

/** The lists of Langfuse records a page or envelope holds: `data` (list pages), `observations`
 * (the native envelope) and `traces` (a session). One record suffices: the others are read one by
 * one, and a malformed one refuses only its trace. */
const lists = (value: unknown): unknown[][] =>
  isObject(value)
    ? (["data", "observations", "traces"] as const)
        .map((key) => value[key])
        .filter((list): list is unknown[] => Array.isArray(list) && list.some(isRecord))
    : [];

// --- langfuse_observations ----------------------------------------------------------------------

/** Hue's documented observation list: a list page (`data`) or the native `observations`
 * envelope, every record an observation, converted as Hue's own reader converts it. */
export const langfuseObservations: ImportAdapter = {
  id: "langfuse_observations",
  manifestFormat: "langfuse_observations",
  detect: (value) =>
    isObject(value) &&
    !isTraceRecord(value) &&
    (documented(value.data) || documented(value.observations)),
  convert(value, context) {
    if (!isObject(value)) return;
    if (value.data !== undefined && value.observations !== undefined)
      throw new ConversionError("two observation envelopes in one file");
    const key = documented(value.data) ? "data" : "observations";
    let records = value[key] as Fields[];
    const envelope = Object.fromEntries(
      Object.entries(value).filter(([name]) => name !== key),
    ) as Fields;
    const collector = context.collector(() => new LangfuseTraceCollector());
    if (context.source.unsafeIntegers) {
      // Which observations hold such an integer: read again with each marked, so only their
      // traces are refused and the page's others read.
      const marked = markedRecords(context.source.text, key);
      if (!marked || marked.envelope)
        throw new ConversionError("Source JSON contains an unsafe number");
      const refused = new Set<string>();
      for (const [index, observation] of records.entries())
        if (marked.records.has(index)) refused.add(observation.traceId as string);
      for (const traceId of refused)
        collector.refuse(traceId, "Source JSON contains an unsafe number", context.source.digest);
      records = records.filter((observation) => !refused.has(observation.traceId as string));
      if (!records.length) return;
    }
    collector.add(records, envelope, context.source.digest);
  },
};

/** An integer JavaScript cannot represent exactly, as `markedRecords` marks one. */
class UnsafeInteger {}

/** The positions of the records of `text`'s list `key` that hold an integer JavaScript cannot
 * represent exactly, and whether the rest of the document holds one; undefined when the text does
 * not parse so. */
function markedRecords(
  text: string,
  key: string,
): { records: Set<number>; envelope: boolean } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text, (_key, item: unknown, source?: { source?: string }) =>
      typeof item === "number" &&
      !Number.isSafeInteger(item) &&
      typeof source?.source === "string" &&
      /^-?\d+$/.test(source.source)
        ? new UnsafeInteger()
        : item,
    );
  } catch {
    return undefined;
  }
  const holds = (item: unknown): boolean => {
    const stack = [item];
    while (stack.length) {
      const next = stack.pop();
      if (next instanceof UnsafeInteger) return true;
      if (next !== null && typeof next === "object")
        for (const child of Object.values(next)) stack.push(child);
    }
    return false;
  };
  if (!isObject(value) || !Array.isArray(value[key])) return undefined;
  const records = new Set<number>();
  for (const [index, record] of (value[key] as unknown[]).entries())
    if (holds(record)) records.add(index);
  const envelope = Object.entries(value).some(([name, item]) => name !== key && holds(item));
  return { records, envelope };
}

// --- langfuse: reading a record -----------------------------------------------------------------

const FORMAT = "langfuse";
/** The longest source id the emitter keeps, less the root's `t-` prefix. */
const MAX_ID = 4094;

const KINDS: Record<string, SpanKind> = {
  GENERATION: "llm",
  TOOL: "tool",
  AGENT: "agent",
  EMBEDDING: "embedding",
  RETRIEVER: "retrieval",
};
/** A judge assessing an output: Langfuse's evaluation inside a trace, and everything beneath it. */
const EVALUATOR = "EVALUATOR";
const EVALUATION_KEYS = ["hue.execution.id", "hue.eval.execution_id"];
const SIMULATION_KEYS = ["hue.world.id", "hue.environment.run_id"];

const INSTANT =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** An ISO 8601 or ClickHouse instant as Unix nanoseconds; one without a zone is UTC. */
function instant(value: JsonValue | undefined, what: string): bigint {
  const match = typeof value === "string" ? INSTANT.exec(value.trim()) : null;
  const zone = match?.[4]?.toUpperCase() ?? "Z";
  const offset =
    zone === "Z"
      ? zone
      : zone.length === 3
        ? `${zone}:00`
        : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const millis = match ? Date.parse(`${match[1]}T${match[2]}${offset}`) : NaN;
  if (!Number.isSafeInteger(millis) || millis <= 0)
    throw new ConversionError(`${what} is not a timestamp`);
  return BigInt(millis) * 1_000_000n + BigInt((match![3] ?? "").padEnd(9, "0"));
}

/** A copy's revision: its `updatedAt` in nanoseconds, when it is an instant. */
function revisionOf(record: Fields): string | undefined {
  try {
    const updated = field(record, "updatedAt", "updated_at");
    return updated === undefined ? undefined : instant(updated, "updatedAt").toString();
  } catch {
    return undefined;
  }
}

/** JSON text read as the JSON it holds (an object, list or string), else the value as recorded. */
function decoded(value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\s*[[{"]/.test(value)) return value;
  try {
    const parsed = parseNestedJsonText(value);
    return parsed.unsafeIntegers ? value : (parsed.value as JsonValue);
  } catch {
    return value;
  }
}

/** Metadata with each value recorded as JSON text read as its JSON, as Langfuse reads it. */
function metadataOf(value: JsonValue | undefined): JsonValue | undefined {
  const metadata = decoded(value);
  const fields = object(metadata);
  if (!fields) return metadata;
  if (!Object.keys(fields).length) return undefined;
  return Object.fromEntries(
    Object.entries(fields).map(([key, item]) => {
      if (typeof item !== "string") return [key, item];
      try {
        const parsed = parseNestedJsonText(item);
        return [key, parsed.unsafeIntegers ? item : (parsed.value as JsonValue)];
      } catch {
        return [key, item];
      }
    }),
  );
}

/** Resource attributes Langfuse kept in metadata: flattened `resourceAttributes.<key>` (direct
 * writes) or a `resourceAttributes` object (the legacy path). */
function resourceOf(metadata: JsonValue | undefined): Fields | undefined {
  const fields = object(metadata);
  if (!fields) return undefined;
  const resource: Fields = { ...object(fields.resourceAttributes) };
  for (const [key, value] of Object.entries(fields))
    if (key.startsWith("resourceAttributes.") && key.length > 19) resource[key.slice(19)] = value;
  return Object.keys(resource).length ? resource : undefined;
}

/** Evaluation or simulation traffic: Hue's markers in metadata or resource attributes, or one of
 * Langfuse's experiment and evaluator environments. */
function originOf(
  metadata: JsonValue | undefined,
  resource: Fields | undefined,
  environment: string | undefined,
): SpanRow["origin"] {
  const fields = object(metadata) ?? {};
  const keys = new Set([
    ...Object.keys(fields).map((key) => key.replace(/^attributes\./, "")),
    ...Object.keys(object(fields.attributes) ?? {}),
    ...Object.keys(resource ?? {}),
  ]);
  if (EVALUATION_KEYS.some((key) => keys.has(key)) || langfuseEvaluationEnvironment(environment))
    return "evaluation";
  const scope = text(fields["scope.name"]) ?? text(object(fields.scope)?.name);
  if (SIMULATION_KEYS.some((key) => keys.has(key)) || scope === "hue.sim-gateway")
    return "simulation";
  return undefined;
}

/** A token count: a nonnegative integer, or its decimal text (ClickHouse quotes 64-bit integers). */
function count(value: JsonValue | undefined): number | undefined {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0
    ? number
    : undefined;
}

/** `usageDetails` as Langfuse totals it; `inputUsage`/`outputUsage` (a UI download's totals) when
 * a record has no details. */
function usageOf(record: Fields): SpanRow["usage"] | undefined {
  const counts = new Map<string, number>();
  for (const [key, value] of Object.entries(
    object(field(record, "usageDetails", "usage_details")) ?? {},
  )) {
    const tokens = count(value);
    if (tokens !== undefined) counts.set(key, tokens);
  }
  const sum = (match: (key: string) => boolean) => {
    let total: number | undefined;
    for (const [key, tokens] of counts) if (match(key)) total = (total ?? 0) + tokens;
    return total;
  };
  const first = (...keys: string[]) =>
    keys.map((key) => counts.get(key)).find((tokens) => tokens !== undefined);
  const usage: NonNullable<SpanRow["usage"]> = {
    input:
      sum((key) => key.includes("input")) ??
      first("prompt_tokens") ??
      count(field(record, "inputUsage")),
    output:
      sum((key) => key.includes("output")) ??
      first("completion_tokens") ??
      count(field(record, "outputUsage")),
    cacheRead: first("input_cached_tokens", "input_cache_read"),
    cacheWrite: first("input_cache_write", "input_cache_creation"),
    reasoning: first("output_reasoning_tokens", "output_reasoning"),
  };
  return Object.values(usage).some((tokens) => tokens !== undefined) ? usage : undefined;
}

/** A Python `@observe` tool's input, `{"args": [], "kwargs": {…}}`, is its keyword arguments. */
function toolArguments(input: JsonValue | undefined): JsonValue | undefined {
  const fields = object(input);
  if (
    fields &&
    Object.keys(fields).length === 2 &&
    Array.isArray(fields.args) &&
    !fields.args.length &&
    object(fields.kwargs)
  )
    return fields.kwargs!;
  return input;
}

function sourceId(value: JsonValue | undefined, what: string): string {
  const id = text(value);
  if (!id || id.length > MAX_ID) throw new ConversionError(`${what} is missing or too long`);
  return id;
}

const strings = (value: JsonValue | undefined): string[] | undefined =>
  Array.isArray(value) && value.length && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;

/** The trace-level fields Langfuse copies onto observations, kept on the trace's root. */
function traceAttributes(record: Fields, nameField: string[], tagField: string[]): Fields {
  const name = text(field(record, ...nameField));
  const tags = strings(field(record, ...tagField));
  const release = text(field(record, "release"));
  return {
    ...(name ? { "langfuse.trace.name": name } : {}),
    ...(tags ? { "langfuse.trace.tags": tags } : {}),
    ...(release ? { "langfuse.release": release } : {}),
  };
}

/** A pending span: its row, the source it came from, and whether Langfuse records a parent. */
interface Pending {
  row: SpanRow;
  digest: string;
  /** No parent recorded: the trace's root, when the trace has one, becomes its parent. */
  topLevel: boolean;
  /** Made from a trace record rather than an observation. */
  trace: boolean;
}

function observationRow(
  record: Fields,
  inheritedTrace: string | undefined,
): { row: SpanRow; topLevel: boolean } {
  const traceKey =
    text(field(record, "traceId", "trace_id")) ??
    inheritedTrace ??
    (() => {
      throw new ConversionError("an observation without a traceId");
    })();
  sourceId(traceKey, "the trace id");
  const spanKey = sourceId(record.id, "the observation id");
  const type = text(record.type)?.toUpperCase() ?? "SPAN";
  const kind = Object.hasOwn(KINDS, type) ? KINDS[type] : undefined;
  const parent = text(field(record, "parentObservationId", "parent_observation_id"));
  const start = instant(field(record, "startTime", "start_time"), "startTime");
  const endValue = field(record, "endTime", "end_time");
  const end = endValue === undefined || endValue === "" ? undefined : instant(endValue, "endTime");
  const metadata = metadataOf(record.metadata);
  const resource = resourceOf(metadata);
  const environment = text(record.environment);
  const origin = originOf(metadata, resource, environment);
  const level = text(record.level);
  const statusMessage = text(field(record, "statusMessage", "status_message"));
  const model = text(field(record, "model", "providedModelName", "provided_model_name"));
  const input = decoded(record.input);
  const output = decoded(record.output);
  const appRoot = field(record, "isRootObservation", "is_root_observation") === true;
  const revision = revisionOf(record);
  const row: SpanRow = {
    traceKey,
    spanKey,
    ...(parent ? { parentKey: parent } : {}),
    name: text(record.name) ?? type.toLowerCase(),
    ...(kind ? { kind } : {}),
    start,
    ...(end !== undefined ? { end } : {}),
    ...(model ? { model } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(level === "ERROR" ? { error: statusMessage ? { message: statusMessage } : {} } : {}),
    ...(type === EVALUATOR ? { scoring: true } : {}),
    ...(environment && environment !== "default" ? { environment } : {}),
    ...(origin ? { origin } : {}),
    ...(resource ? { resource } : {}),
    attributes: {
      "langfuse.observation.type": type.toLowerCase(),
      ...(level && level !== "DEFAULT" ? { "langfuse.observation.level": level } : {}),
      ...(statusMessage && level !== "ERROR"
        ? { "langfuse.observation.status_message": statusMessage }
        : {}),
      ...(metadata !== undefined
        ? { "langfuse.observation.metadata": JSON.stringify(metadata) }
        : {}),
      ...(!parent || appRoot
        ? traceAttributes(record, ["traceName", "trace_name"], ["tags", "traceTags"])
        : {}),
    },
    record,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(revision ? { revision } : {}),
  };
  if (kind === "tool") {
    const args = toolArguments(input);
    row.tool = {
      name: row.name,
      ...(args !== undefined ? { arguments: args } : {}),
      ...(output !== undefined ? { result: output } : {}),
    };
  } else {
    const user = identityText(field(record, "userId", "user_id"));
    const session = identityText(field(record, "sessionId", "session_id"));
    if (user !== undefined) row.user = user;
    if (session !== undefined) row.session = session;
    const usage = usageOf(record);
    if (usage) row.usage = usage;
  }
  return { row, topLevel: !parent };
}

/** A trace record as the trace's root span, `t-<trace id>`. Embedded observations are their own
 * spans' records and are left out of the root's. */
function traceRow(record: Fields): SpanRow {
  const traceKey = sourceId(record.id, "the trace id");
  const metadata = metadataOf(record.metadata);
  const resource = resourceOf(metadata);
  const environment = text(record.environment);
  const origin = originOf(metadata, resource, environment);
  const name = text(record.name);
  const version = text(record.version);
  const user = identityText(field(record, "userId", "user_id"));
  const session = identityText(field(record, "sessionId", "session_id"));
  const input = decoded(record.input);
  const output = decoded(record.output);
  const embedded = Array.isArray(record.observations) && record.observations.some(isObject);
  const kept = embedded
    ? (Object.fromEntries(
        Object.entries(record).filter(([key]) => key !== "observations"),
      ) as Fields)
    : record;
  const revision = revisionOf(record);
  return {
    traceKey,
    spanKey: `t-${traceKey}`,
    name: name ?? "trace",
    start: instant(record.timestamp, "timestamp"),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(session !== undefined ? { session } : {}),
    ...(environment && environment !== "default" ? { environment } : {}),
    ...(origin ? { origin } : {}),
    ...(resource ? { resource } : {}),
    attributes: {
      ...traceAttributes(record, ["name"], ["tags"]),
      ...(version ? { "langfuse.version": version } : {}),
      ...(metadata !== undefined ? { "langfuse.trace.metadata": JSON.stringify(metadata) } : {}),
    },
    record: kept,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(revision ? { revision } : {}),
  };
}

/** Gathers a run's Langfuse records by trace, so a trace record in one file roots the
 * observations of another, and emits each trace through the shared emitter. */
class LangfuseCollector implements TraceCollector {
  private readonly traces = new Map<string, Pending[]>();
  /** Its emitter writes `--user-key` and `--session-key` as every row format's does. */
  readonly appliesKeys = true;

  constructor(private readonly keys: IdentityKeys) {}

  add(pending: Pending): void {
    const held = this.traces.get(pending.row.traceKey);
    if (held) held.push(pending);
    else this.traces.set(pending.row.traceKey, [pending]);
  }

  finish(): { traces: ConvertedTrace[]; refused: Refusal[] } {
    const emitter = new RowTraceCollector(FORMAT, this.keys);
    const refused: Refusal[] = [];
    for (const [traceKey, pending] of this.traces) {
      const root = `t-${traceKey}`;
      // An observation named as the root is the root; a trace record then adds nothing.
      const recordedRoot = pending.some((item) => !item.trace && item.row.spanKey === root);
      const rooted = recordedRoot || pending.some((item) => item.trace);
      try {
        for (const item of pending) {
          if (item.trace && recordedRoot) continue;
          const row =
            !item.trace && item.topLevel && rooted && item.row.spanKey !== root
              ? { ...item.row, parentKey: root }
              : item.row;
          emitter.add(row, item.digest);
        }
      } catch (error) {
        const failure = conversionFailure(error);
        if (!failure) throw error;
        refused.push({ traceId: rowTraceId(FORMAT, traceKey), reason: failure.message });
      }
    }
    const finished = emitter.finish();
    return { traces: finished.traces, refused: [...refused, ...finished.refused] };
  }
}

/** A record to read and the trace it sits in, for an observation embedded in a trace. */
interface Item {
  record: unknown;
  trace?: string;
}

/** A trace record and the observations embedded in it (`GET /api/public/traces/{id}`). */
function traceItems(trace: Fields & { id: string }): Item[] {
  const embedded = Array.isArray(trace.observations) ? trace.observations.filter(isObject) : [];
  return [{ record: trace }, ...embedded.map((record) => ({ record, trace: trace.id }))];
}

function itemsOf(value: unknown): Item[] {
  if (isTraceRecord(value)) return traceItems(value);
  if (isCamelObservation(value) || isSnakeObservation(value)) return [{ record: value }];
  const [list, ...more] = lists(value);
  if (more.length) throw new ConversionError("two lists of Langfuse records in one value");
  return (list ?? []).flatMap((record) =>
    isTraceRecord(record) ? traceItems(record) : [{ record }],
  );
}

const traceKeyOf = ({ record, trace }: Item): string | undefined => {
  if (!isObject(record)) return trace;
  const fields = record as Fields;
  return (
    text(field(fields, "traceId", "trace_id")) ??
    (isTraceRecord(record) ? record.id : undefined) ??
    trace
  );
};

/** Langfuse's own exports, from its API, UI downloads and blob storage (see the top of this
 * file), as canonical rows. */
export const langfuse: ImportAdapter = {
  id: FORMAT,
  manifestFormat: "otlp_json",
  detect: (value) =>
    !langfuseObservations.detect(value) && (isRecord(value) || lists(value).length > 0),
  convert(value, context) {
    const collector = context.collector(() => new LangfuseCollector(context.keys));
    readRecords(context, itemsOf(value), traceKeyOf, (item) => {
      const { record } = item;
      if (!isRecord(record))
        throw new ConversionError("a record that is neither a Langfuse trace nor an observation");
      validateSource(record as Fields);
      const digest = context.source.digest;
      if (isTraceRecord(record))
        collector.add({ row: traceRow(record), digest, topLevel: false, trace: true });
      else collector.add({ ...observationRow(record, item.trace), digest, trace: false });
    });
  },
};
