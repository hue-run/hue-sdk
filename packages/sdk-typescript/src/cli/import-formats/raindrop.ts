import {
  canonicalJson,
  ConversionError,
  isObject,
  parseNestedJsonText,
  sha256Hex,
  unixNano,
  type JsonValue,
} from "../traces-import-convert.js";
import type { ConvertContext, ImportAdapter } from "./adapter.js";
import { identityText, readIdentity } from "./identity.js";
import { nanosFrom, readRecords, type SpanKind, type SpanRow } from "./rows.js";

/**
 * Raindrop exports, read by two formats: `raindrop` (events) and `raindrop_spans` (the span rows of
 * an event's trace; see {@link raindropSpans}).
 *
 * Raindrop events: one event is one agent turn (the user's input, the tools the agent ran, the
 * assistant's output), read from two shapes:
 *
 * - What an application sends to `POST /v1/events/track`: an array of
 *   `{event_id, user_id, event, timestamp, properties, attachments, ai_data: {model, input,
 *   output, convo_id, tool_calls}}`, one event per element or per line.
 * - What the Query API answers for `GET /v1/events` (`{"data": […], "meta": …}`) and
 *   `GET /v1/events/{id}` (`{"data": {…}}`): `{id, event_name, user_id, convo_id, timestamp,
 *   user_input, assistant_output, model, tool_calls: [{tool_name, status, duration_ms,
 *   started_at, span_id}], …}`.
 *
 * Each event is one trace: an agent span named for the event, carrying the model, the input as
 * the user's message and the output as the assistant's, with a tool span per tool call beneath
 * it. `user_id` is the end user and `convo_id` the conversation.
 *
 * - Ids: `event_id` (a Query API event's `id`) names the trace; an event without one is named by
 *   the SHA-256 of its canonical JSON.
 * - Times: the event's `timestamp` is its start. A tool call starts at `started_at` and lasts
 *   `duration_ms` when it records them; otherwise the emitter's rules place it, and an event with
 *   no instant at all is an `untimed_trace`.
 * - An event without `ai_data` (a sign-up, a page view) records no agent turn and is reported,
 *   not imported.
 * - An event sent while pending (`is_pending: true`) and again finished is read from the finished
 *   copy; two copies that differ otherwise refuse the trace.
 */

type JsonObject = { [key: string]: JsonValue };

const object = (value: JsonValue | undefined): JsonObject | undefined =>
  isObject(value) ? (value as JsonObject) : undefined;
const text = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" && value ? value : undefined;

/** An event as sent to the track endpoint. */
const isTrackEvent = (value: unknown): boolean =>
  isObject(value) &&
  typeof value.event === "string" &&
  (isObject(value.ai_data) || (typeof value.event_id === "string" && "user_id" in value));

/** An event as the Query API answers it. */
const isQueryEvent = (value: unknown): boolean =>
  isObject(value) &&
  typeof value.event_name === "string" &&
  "user_input" in value &&
  "assistant_output" in value;

const isEvent = (value: unknown): value is JsonObject =>
  isObject(value) && (isTrackEvent(value) || isQueryEvent(value));

/** The events a Query API answer holds: a page (`data` a list) or one event (`data` an event). */
function envelopeEvents(value: unknown): unknown[] | undefined {
  if (!isObject(value)) return undefined;
  if (isQueryEvent(value.data)) return [value.data];
  return Array.isArray(value.data) && value.data.some(isQueryEvent) ? value.data : undefined;
}

const traceKeyOf = (record: JsonObject): string =>
  text(record.event_id) ?? text(record.id) ?? sha256Hex(canonicalJson(record));

/** A recorded instant, or none. */
const instant = (value: JsonValue | undefined): bigint | undefined =>
  text(value) ? BigInt(unixNano(value)) : undefined;

/** A tool call's span: its name, call, timing and status as the event records them. */
function toolRow(
  call: JsonValue,
  index: number,
  parent: { traceKey: string; spanKey: string },
): SpanRow {
  const fields = object(call);
  const name = text(fields?.name) ?? text(fields?.tool_name);
  if (!fields || !name) throw new ConversionError(`tool call ${index + 1} has no name`);
  const start = instant(fields.started_at);
  const duration = fields.duration_ms;
  if (duration != null && (typeof duration !== "number" || !(duration >= 0)))
    throw new ConversionError(`tool call ${index + 1} has an invalid duration_ms`);
  const status = text(fields.status)?.toLowerCase();
  const error = fields.error;
  return {
    traceKey: parent.traceKey,
    spanKey: text(fields.span_id) ?? `tool_calls[${index}]`,
    parentKey: parent.spanKey,
    name,
    kind: "tool",
    ...(start !== undefined ? { start } : {}),
    ...(start !== undefined && typeof duration === "number"
      ? { end: start + (duration === 0 ? 0n : nanosFrom(duration, "ms")) }
      : {}),
    tool: {
      name,
      ...(text(fields.call_id) ? { callId: text(fields.call_id)! } : {}),
      ...(fields.arguments !== undefined ? { arguments: fields.arguments } : {}),
      ...(fields.result !== undefined ? { result: fields.result } : {}),
    },
    ...((error !== undefined && error !== null && error !== "") || status === "error"
      ? {
          error: typeof error === "string" && error ? { message: error } : {},
        }
      : {}),
    record: call,
    sequence: index + 1,
  };
}

function readEvent(record: JsonObject, context: ConvertContext): void {
  const query = !isTrackEvent(record);
  const ai = object(record.ai_data);
  if (!query && record.ai_data != null && !ai)
    throw new ConversionError("ai_data is not an object");
  if (!query && !ai) {
    // An analytics event: reported on its own, with no trace to refuse.
    context.refuse("a Raindrop event without ai_data records no agent turn");
    return;
  }
  const traceKey = traceKeyOf(record);
  const spanKey = traceKey;
  const calls = (query ? record.tool_calls : ai!.tool_calls) ?? [];
  if (!Array.isArray(calls)) throw new ConversionError("tool_calls is not a list");
  const properties = object(record.properties);
  const user = identityText(record.user_id);
  const session = identityText(query ? record.convo_id : ai!.convo_id);
  const input = query ? record.user_input : ai!.input;
  const output = query ? record.assistant_output : ai!.output;
  const model = text(query ? record.model : ai!.model);
  const start = instant(record.timestamp);
  const attributes: Record<string, JsonValue> = {};
  const keep = (name: string, value: JsonValue | undefined) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value) ? value.length : isObject(value) ? Object.keys(value).length : true)
      attributes[name] = typeof value === "object" ? JSON.stringify(value) : value;
  };
  keep("raindrop.properties", properties);
  keep("raindrop.feature_flags", record.feature_flags);
  keep("raindrop.attachments", record.attachments);
  keep("raindrop.topics", record.topics);
  keep("raindrop.signals", record.signals);
  // A pending event (`is_pending`, sent before the turn finished) gives way to the finished one.
  const revision = record.is_pending === true ? "0" : "1";
  const event: SpanRow = {
    traceKey,
    spanKey,
    name: text(query ? record.event_name : record.event) ?? "event",
    kind: "agent",
    ...(start !== undefined ? { start } : {}),
    ...(model ? { model } : {}),
    ...(input != null && input !== "" ? { input } : {}),
    ...(output != null && output !== "" ? { output } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(session !== undefined ? { session } : {}),
    attributes,
    record,
    sequence: 0,
  };
  const rows = [event, ...calls.map((call, index) => toolRow(call, index, { traceKey, spanKey }))];
  for (const row of rows) context.row({ ...row, revision });
}

export const raindrop: ImportAdapter = {
  id: "raindrop",
  manifestFormat: "otlp_json",
  detect: (value) => isEvent(value) || envelopeEvents(value) !== undefined,
  convert(value, context) {
    const records = isEvent(value) ? [value] : (envelopeEvents(value) ?? []);
    readRecords(
      context,
      records,
      (record) => (isEvent(record) ? traceKeyOf(record) : undefined),
      (record) => {
        if (!isEvent(record)) throw new ConversionError("a record that is not a Raindrop event");
        readEvent(record, context);
      },
    );
  },
};

// --- raindrop_spans --------------------------------------------------------------------------

/** Raindrop's span types, by the kind each is. */
const SPAN_TYPES: Record<string, SpanKind | undefined> = {
  INTERNAL: undefined,
  LLM_GENERATION: "llm",
  LLM_GENERATION_STREAM: "llm",
  TOOL_CALL: "tool",
};

/** A span row of the Query API's `GET /v1/traces`. */
const isSpanRow = (value: unknown): value is JsonObject =>
  isObject(value) &&
  typeof value.trace_id === "string" &&
  typeof value.span_id === "string" &&
  typeof value.span_name === "string" &&
  typeof value.span_type === "string" &&
  Object.hasOwn(SPAN_TYPES, value.span_type) &&
  "start_time_ns" in value;

/** The span rows a `GET /v1/traces` answer (`{"data": […]}`) holds, when it holds any. */
const envelopeSpans = (value: unknown): unknown[] | undefined =>
  isObject(value) && Array.isArray(value.data) && value.data.some(isSpanRow)
    ? value.data
    : undefined;

/** A payload Raindrop keeps as text: the JSON it holds when it holds an object or a list. */
function payload(value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\s*[[{]/.test(value)) return value;
  try {
    return parseNestedJsonText(value).value as JsonValue;
  } catch {
    return value;
  }
}

/** An instant or duration in nanoseconds (a number, or its decimal text for one past 2^53). */
const nanos = (value: JsonValue | undefined): bigint | undefined =>
  value === undefined || value === null || value === 0 ? undefined : nanosFrom(value, "ns");

function readSpanRow(record: JsonObject, context: ConvertContext): void {
  const traceKey = text(record.trace_id);
  const spanKey = text(record.span_id);
  if (!traceKey || !spanKey) throw new ConversionError("a span without a trace_id or span_id");
  const attributes = object(record.attributes);
  if (record.attributes != null && !attributes)
    throw new ConversionError("attributes is not an object");
  const kind = SPAN_TYPES[record.span_type as string];
  const start = nanos(record.start_time_ns);
  const duration = record.end_time_ns == null ? nanos(record.duration_ns) : undefined;
  const end = nanos(record.end_time_ns) ?? (start && duration ? start + duration : undefined);
  const input = payload(record.input);
  const output = payload(record.output);
  const row: SpanRow = {
    traceKey,
    spanKey,
    ...(text(record.parent_span_id) ? { parentKey: text(record.parent_span_id)! } : {}),
    name: text(record.span_name) ?? "span",
    ...(kind ? { kind } : {}),
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
    ...(record.end_time_ns == null && duration !== undefined
      ? { timing: "end_from_duration" }
      : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(attributes ? { attributes, metadata: attributes } : {}),
    record,
  };
  if (text(record.status) === "ERROR") row.error = {};
  if (kind === "llm") {
    if (text(record.model)) row.model = text(record.model)!;
    if (text(record.provider)) row.provider = text(record.provider)!.toLowerCase();
    const count = (value: JsonValue | undefined) =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    row.usage = { input: count(record.input_tokens), output: count(record.output_tokens) };
  }
  if (kind === "tool")
    row.tool = {
      name: row.name,
      ...(input !== undefined ? { arguments: input } : {}),
      ...(output !== undefined ? { result: output } : {}),
    };
  else {
    // Raindrop's SDKs stamp the interaction's user and conversation on every span they open
    // (`traceloop.association.properties.user_id`, `ai.telemetry.metadata.raindrop.userId`, …),
    // read as Hue reads them.
    const user = readIdentity("user", (key) => attributes?.[key]);
    const session = readIdentity("session", (key) => attributes?.[key]);
    if (user !== undefined) row.user = user;
    if (session !== undefined) row.session = session;
  }
  context.row(row);
}

/**
 * Raindrop's span rows: the Query API's `GET /v1/traces?event_id=` answer (`{"data": […]}`), one
 * row alone, or one per line. Each row (`trace_id`, `span_id`, `parent_span_id`, `span_name`,
 * `span_type`, `status`, `start_time_ns`, `end_time_ns`, `duration_ns`, `input`, `output`,
 * `input_tokens`, `output_tokens`, `model`, `provider`, `attributes`) is one span of its trace; it
 * carries the content, tool arguments and results, tokens and model an event record lacks.
 *
 * - `span_type` names the kind: `LLM_GENERATION` and `LLM_GENERATION_STREAM` a model call,
 *   `TOOL_CALL` a tool call, `INTERNAL` none. A tool span's input and output are its arguments and
 *   result; payload text holding JSON is read as that JSON.
 * - Times are Unix nanoseconds; a row without `end_time_ns` ends `duration_ns` after it starts
 *   (`end_from_duration`). `status` `ERROR` is an error.
 * - `attributes` (text and numbers only, as Raindrop serves them) are kept under their own names.
 *   The user and conversation are those Raindrop's SDKs stamp on every span of the interaction
 *   (`traceloop.association.properties.user_id` and `convo_id`, `ai.telemetry.metadata.raindrop.*`),
 *   read as Hue reads them; the rows name no event, so the event's own `user_id` is not joined in,
 *   and `--user-key` names a user the attributes lack.
 */
export const raindropSpans: ImportAdapter = {
  id: "raindrop_spans",
  manifestFormat: "otlp_json",
  detect: (value) => isSpanRow(value) || envelopeSpans(value) !== undefined,
  convert(value, context) {
    readRecords(
      context,
      isSpanRow(value) ? [value] : (envelopeSpans(value) ?? []),
      (record) => (isSpanRow(record) ? text(record.trace_id) : undefined),
      (record) => {
        if (!isSpanRow(record)) throw new ConversionError("a record that is not a Raindrop span");
        readSpanRow(record, context);
      },
    );
  },
};
