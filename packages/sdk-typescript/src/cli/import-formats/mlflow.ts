import { ConversionError, isObject, type JsonValue } from "../traces-import-convert.js";
import type { ConvertContext, ImportAdapter } from "./adapter.js";
import { identityText } from "./identity.js";
import { count, jsonOf, object, text, type JsonObject } from "./row-platform-fields.js";
import { nanosFrom, readRecords, type EventRow, type SpanKind, type SpanRow } from "./rows.js";

/**
 * MLflow traces as `Trace.to_dict()` writes them (`mlflow traces get`, `trace.to_json()`): an
 * `info` (`TraceInfo`: `trace_id`, `request_time`, `trace_metadata`, `tags`) and `data.spans`, each
 * span OpenTelemetry-shaped with base64 ids, nanosecond times and every attribute JSON-encoded.
 * Read from one trace, a JSON array or JSON Lines of them, and `mlflow traces search --output json`
 * (`{"traces": […], "next_page_token": …}`); MLflow 2's form (`info.request_id`,
 * `request_metadata`, spans with `context`, `parent_id` and `start_time`) is read too.
 *
 * - `mlflow.spanType` names the kind: `LLM` and `CHAT_MODEL` a model call, `TOOL` a tool call,
 *   `AGENT`, `RETRIEVER` and `EMBEDDING`; `mlflow.spanInputs` and `mlflow.spanOutputs` are the
 *   content, `mlflow.chat.tokenUsage` the token counts, `mlflow.llm.model` and
 *   `mlflow.llm.provider` the model.
 * - The user and conversation are the trace's `mlflow.trace.user` and `mlflow.trace.session`
 *   metadata, else a span's own `user.id` and `session.id`. `mlflow.user` and `mlflow.auth.*`
 *   name who logged the trace, never the end user.
 * - A trace tagged `mlflow.eval.requestId` (made by `mlflow.genai.evaluate`) or
 *   `mlflow.trace.sourceScorer` (a judge's own trace) is evaluation traffic.
 * - A trace is one record: a malformed span refuses its trace. The spans without a parent keep the
 *   trace's `info` beside the span in their source record.
 */

const isTrace = (value: unknown): value is JsonObject =>
  isObject(value) &&
  isObject(value.info) &&
  isObject(value.data) &&
  Array.isArray(value.data.spans) &&
  (typeof value.info.trace_id === "string" || typeof value.info.request_id === "string");

/** The traces `mlflow traces search --output json` answers, when it holds any. */
const envelopeTraces = (value: unknown): unknown[] | undefined =>
  isObject(value) && Array.isArray(value.traces) && value.traces.some(isTrace)
    ? value.traces
    : undefined;

/** An MLflow id as lowercase hex: the base64 of its bytes (`Span.to_dict`), its hex (MLflow
 * 3.5), `0x`-prefixed hex (MLflow 2) or a `tr-` trace id; undefined when it is none of these. */
function hexId(value: JsonValue | undefined, bytes: 8 | 16): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const hex = value.replace(/^0x|^tr-/i, "");
  if (hex.length === bytes * 2 && /^[0-9a-f]+$/i.test(hex)) return hex.toLowerCase();
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length === Math.ceil(bytes / 3) * 4) {
    const decoded = Buffer.from(value, "base64");
    if (decoded.byteLength === bytes) return decoded.toString("hex");
  }
  return undefined;
}

const KINDS: Record<string, SpanKind> = {
  LLM: "llm",
  CHAT_MODEL: "llm",
  TOOL: "tool",
  AGENT: "agent",
  RETRIEVER: "retrieval",
  EMBEDDING: "embedding",
};

/** The span's attributes with MLflow's JSON encoding undone; text that is not JSON is kept. */
function decodedAttributes(value: JsonValue | undefined): JsonObject {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new ConversionError("a span's attributes are not an object");
  const decoded: JsonObject = {};
  for (const [key, raw] of Object.entries(value as JsonObject)) decoded[key] = jsonOf(raw) ?? raw;
  return decoded;
}

/** An attribute value OTLP holds as it is: text, a number or a boolean; anything else as JSON. */
const attributeValue = (value: JsonValue): JsonValue =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : JSON.stringify(value);

/** The instant a span field records, in nanoseconds; undefined when absent. */
const instant = (value: JsonValue | undefined) =>
  value === undefined || value === null || value === "" || value === 0
    ? undefined
    : nanosFrom(value, "ns");

interface Trace {
  traceKey: string;
  info: JsonObject;
  /** `trace_metadata`, where a dotted `--user-key` looks after a span's attributes. */
  metadata?: JsonObject;
  user?: string;
  session?: string;
  evaluation: boolean;
}

/** One span as a row and its events. */
function readSpan(span: JsonValue, trace: Trace): { row: SpanRow; events: EventRow[] } {
  if (!isObject(span)) throw new ConversionError("a span that is not an object");
  const v2 = isObject(span.context);
  const rawId = v2 ? (span.context as JsonObject).span_id : span.span_id;
  const rawParent = v2 ? span.parent_id : span.parent_span_id;
  const spanKey = hexId(rawId, 8) ?? text(rawId);
  if (spanKey === undefined) throw new ConversionError("a span without a span_id");
  const parentKey = rawParent ? (hexId(rawParent, 8) ?? text(rawParent)) : undefined;
  const status = object(span.status);
  const code = text(v2 ? span.status_code : status?.code);
  const message = text(v2 ? span.status_message : status?.message);
  const attributes = decodedAttributes(span.attributes);
  const type = text(attributes["mlflow.spanType"]);
  const kind = type && Object.hasOwn(KINDS, type) ? KINDS[type] : undefined;
  const start = instant(v2 ? span.start_time : span.start_time_unix_nano);
  const end = instant(v2 ? span.end_time : span.end_time_unix_nano);
  const events = span.events ?? [];
  if (!Array.isArray(events)) throw new ConversionError("a span's events are not a list");
  let exceptionType: string | undefined;
  const eventRows = events.map((event): EventRow => {
    if (!isObject(event)) throw new ConversionError("a span event that is not an object");
    const time = instant(v2 ? event.timestamp : event.time_unix_nano);
    const eventAttributes = object(event.attributes);
    if (event.name === "exception") exceptionType ??= text(eventAttributes?.["exception.type"]);
    return {
      traceKey: trace.traceKey,
      spanKey,
      name: text(event.name) ?? "event",
      ...(time !== undefined ? { time } : {}),
      ...(eventAttributes ? { attributes: eventAttributes } : {}),
      record: event as JsonObject,
    };
  });
  const input = attributes["mlflow.spanInputs"];
  const output = attributes["mlflow.spanOutputs"];
  const own: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(attributes))
    if (
      key.startsWith("mlflow.") &&
      key !== "mlflow.spanInputs" &&
      key !== "mlflow.spanOutputs" &&
      value !== null
    )
      own[key] = attributeValue(value);
  const row: SpanRow = {
    traceKey: trace.traceKey,
    spanKey,
    ...(parentKey !== undefined ? { parentKey } : {}),
    name: text(span.name) ?? "span",
    ...(kind ? { kind } : {}),
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
    ...(input !== undefined && input !== null ? { input } : {}),
    ...(output !== undefined && output !== null ? { output } : {}),
    record: parentKey === undefined ? { info: trace.info, span } : (span as JsonObject),
    ...(trace.metadata ? { metadata: trace.metadata } : {}),
    attributes: own,
  };
  if (code && /ERROR$/.test(code))
    row.error = {
      ...(message ? { message } : {}),
      ...(exceptionType ? { type: exceptionType } : {}),
    };
  const model = text(attributes["mlflow.llm.model"]);
  const provider = text(attributes["mlflow.llm.provider"]);
  if (model) row.model = model;
  if (provider) row.provider = provider;
  const usage = object(attributes["mlflow.chat.tokenUsage"]);
  if (usage)
    row.usage = {
      input: count(usage.input_tokens),
      output: count(usage.output_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      cacheWrite: count(usage.cache_creation_input_tokens),
    };
  if (kind === "tool")
    row.tool = {
      name: row.name,
      ...(input !== undefined && input !== null ? { arguments: input } : {}),
      ...(output !== undefined && output !== null ? { result: output } : {}),
    };
  else {
    const user = trace.user ?? identityText(attributes["user.id"]);
    const session = trace.session ?? identityText(attributes["session.id"]);
    if (user !== undefined) row.user = user;
    if (session !== undefined) row.session = session;
  }
  if (trace.evaluation) row.origin = "evaluation";
  return { row, events: eventRows };
}

function readTrace(value: JsonObject, context: ConvertContext): void {
  const trace = traceOf(value);
  if (!trace) throw new ConversionError("a trace without a trace_id");
  const spans = (value.data as JsonObject).spans as JsonValue[];
  if (!spans.length)
    throw new ConversionError("a trace exported without its spans; export it with its spans");
  // Every span is read before any is added, so a malformed one refuses the trace whole.
  const read = spans.map((span) => readSpan(span, trace));
  for (const { row, events } of read) {
    context.row(row);
    for (const event of events) context.event(event);
  }
}

function traceOf(value: JsonObject): Trace | undefined {
  const info = value.info as JsonObject;
  const reference = text(info.trace_id) ?? text(info.request_id);
  if (reference === undefined) return undefined;
  const spans = (value.data as JsonObject).spans as JsonValue[];
  const spanTraces = new Set(
    spans.flatMap((span) => {
      const raw = isObject(span)
        ? isObject(span.context)
          ? (span.context as JsonObject).trace_id
          : span.trace_id
        : undefined;
      return hexId(raw, 16) ?? [];
    }),
  );
  const traceKey =
    hexId(reference, 16) ??
    hexId(reference.split("/").at(-1), 16) ??
    (spanTraces.size === 1 ? [...spanTraces][0]! : reference);
  const metadata = object(info.trace_metadata ?? info.request_metadata);
  const tags = object(info.tags);
  const user = identityText(metadata?.["mlflow.trace.user"]);
  const session = identityText(metadata?.["mlflow.trace.session"]);
  return {
    traceKey,
    info,
    ...(metadata ? { metadata } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(session !== undefined ? { session } : {}),
    evaluation:
      tags?.["mlflow.eval.requestId"] !== undefined ||
      tags?.["mlflow.trace.sourceScorer"] !== undefined,
  };
}

export const mlflowTraces: ImportAdapter = {
  id: "mlflow_traces",
  manifestFormat: "otlp_json",
  detect: (value) => isTrace(value) || envelopeTraces(value) !== undefined,
  convert(value, context) {
    const records = isTrace(value) ? [value] : (envelopeTraces(value) ?? []);
    readRecords(
      context,
      records,
      (record) => (isTrace(record) ? traceOf(record)?.traceKey : undefined),
      (record) => {
        if (!isTrace(record)) throw new ConversionError("a record that is not an MLflow trace");
        readTrace(record, context);
      },
    );
  },
};
