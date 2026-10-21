import { ConversionError, isObject, type JsonValue } from "../traces-import-convert.js";
import type { ConvertContext, ImportAdapter } from "./adapter.js";
import { identityText } from "./identity.js";
import {
  count,
  first,
  isoNanos,
  object,
  SESSION_FIELDS,
  text,
  USER_FIELDS,
  type JsonObject,
} from "./row-platform-fields.js";
import { readRecords, type SpanKind, type SpanRow } from "./rows.js";

/**
 * Opik traces and spans (`TracePublic` and `SpanPublic` in Opik's REST API). Read from the files
 * `opik export … project …` writes, one per trace (`{"trace": …, "spans": […], …}`), and from
 * span records alone: one span, JSON Lines of them or the spans API's page (`{"content": […]}`).
 *
 * - The trace becomes the root span of its trace, its id the span id; a span without a
 *   `parent_span_id` is its child. Spans read without their trace keep it as their missing parent.
 * - `type` names the kind: `llm` a model call, `tool` a tool call; `general` and `guardrail` record
 *   no operation. Token counts (`usage`) are read from `llm` spans, `prompt_tokens` and
 *   `completion_tokens` with the provider's own cache and reasoning counts (`original_usage.*`).
 * - The conversation is the trace's `thread_id`, else its metadata's; the user comes from the
 *   metadata (`user_id`, `userId`, …). `created_by` names who logged it, never the end user.
 * - A trace from an experiment, evaluator, optimization or the playground (`source`, `experiment`)
 *   is evaluation traffic; `environment` is the deployment environment.
 * - A record exported more than once keeps the copy updated last (`last_updated_at`).
 */

const SPAN_TYPES = new Set(["general", "tool", "llm", "guardrail"]);
const KINDS: Record<string, SpanKind> = { llm: "llm", tool: "tool" };
const EVALUATION_SOURCES = new Set(["experiment", "evaluator", "optimization", "playground"]);

const isSpan = (value: unknown): value is JsonObject =>
  isObject(value) &&
  typeof value.id === "string" &&
  typeof value.trace_id === "string" &&
  typeof value.type === "string" &&
  SPAN_TYPES.has(value.type) &&
  typeof value.start_time === "string" &&
  value.run_type === undefined;

/** An `opik export` trace file: the trace with its spans. */
const isExport = (value: unknown): value is { trace: JsonObject; spans: JsonValue[] } =>
  isObject(value) &&
  isObject(value.trace) &&
  typeof value.trace.id === "string" &&
  typeof value.trace.start_time === "string" &&
  Array.isArray(value.spans) &&
  (value.spans.some(isSpan) || typeof value.downloaded_at === "string");

/** The spans a spans API page holds, when it holds any. */
const spanPage = (value: unknown): unknown[] | undefined =>
  isObject(value) && Array.isArray(value.content) && value.content.some(isSpan)
    ? value.content
    : undefined;

/** A token count from Opik's usage, the OpenAI-shaped total first, then the provider's own. */
const usageCount = (usage: JsonObject | undefined, names: readonly string[]) => {
  for (const name of names) {
    const value = count(usage?.[name]);
    if (value !== undefined) return value;
  }
  return undefined;
};

/** The fields Opik's trace and span records share, as a row. */
function readRecord(
  record: JsonObject,
  traceKey: string,
  spanKey: string,
  parentKey: string | undefined,
): SpanRow {
  const start = isoNanos(record.start_time);
  const end = record.end_time == null ? undefined : isoNanos(record.end_time);
  const metadata = object(record.metadata);
  const tags =
    Array.isArray(record.tags) && record.tags.every((tag) => typeof tag === "string")
      ? (record.tags as string[])
      : undefined;
  const updated = record.last_updated_at == null ? undefined : isoNanos(record.last_updated_at);
  const row: SpanRow = {
    traceKey,
    spanKey,
    ...(parentKey !== undefined ? { parentKey } : {}),
    name: text(record.name) ?? "span",
    start,
    ...(end !== undefined ? { end } : {}),
    ...(record.input != null ? { input: record.input } : {}),
    ...(record.output != null ? { output: record.output } : {}),
    record,
    ...(metadata ? { metadata } : {}),
    ...(updated !== undefined ? { revision: updated.toString() } : {}),
    attributes: {
      ...(record.metadata != null
        ? {
            "opik.metadata":
              typeof record.metadata === "string"
                ? record.metadata
                : JSON.stringify(record.metadata),
          }
        : {}),
      ...(tags?.length ? { "opik.tags": tags } : {}),
    },
  };
  const error = object(record.error_info);
  if (record.error_info != null && !error) throw new ConversionError("error_info is not an object");
  if (error) {
    const type = text(error.exception_type);
    const message = text(error.message) ?? type;
    row.error = { ...(message ? { message } : {}), ...(type ? { type } : {}) };
  }
  const source = text(record.source);
  if ((source && EVALUATION_SOURCES.has(source)) || isObject(record.experiment))
    row.origin = "evaluation";
  const environment = text(record.environment);
  if (environment) row.environment = environment;
  return row;
}

function traceRow(trace: JsonObject): SpanRow {
  const id = trace.id as string;
  const row = readRecord(trace, id, id, undefined);
  const metadata = object(trace.metadata);
  const user = first(metadata, USER_FIELDS);
  const session = identityText(trace.thread_id) ?? first(metadata, SESSION_FIELDS);
  if (user !== undefined) row.user = user;
  if (session !== undefined) row.session = session;
  return row;
}

function spanRow(span: JsonObject): SpanRow {
  const traceKey = text(span.trace_id);
  const spanKey = text(span.id);
  if (!traceKey || !spanKey) throw new ConversionError("a span without an id or trace_id");
  const parent = text(span.parent_span_id) ?? traceKey;
  const row = readRecord(span, traceKey, spanKey, parent);
  const type = text(span.type);
  const kind = type && Object.hasOwn(KINDS, type) ? KINDS[type] : undefined;
  if (kind) row.kind = kind;
  if (type) row.attributes!["opik.span.type"] = type;
  const model = text(span.model);
  const provider = text(span.provider);
  if (model) row.model = model;
  if (provider) row.provider = provider;
  const usage = object(span.usage);
  if (kind === "llm" && usage)
    row.usage = {
      input: usageCount(usage, ["prompt_tokens", "original_usage.input_tokens"]),
      output: usageCount(usage, ["completion_tokens", "original_usage.output_tokens"]),
      cacheRead: usageCount(usage, [
        "original_usage.prompt_tokens_details.cached_tokens",
        "original_usage.input_tokens_details.cached_tokens",
        "original_usage.cache_read_input_tokens",
      ]),
      cacheWrite: usageCount(usage, ["original_usage.cache_creation_input_tokens"]),
      reasoning: usageCount(usage, [
        "original_usage.completion_tokens_details.reasoning_tokens",
        "original_usage.output_tokens_details.reasoning_tokens",
      ]),
    };
  if (kind === "tool")
    row.tool = {
      name: row.name,
      ...(row.input !== undefined ? { arguments: row.input } : {}),
      ...(row.output !== undefined ? { result: row.output } : {}),
    };
  else {
    const metadata = object(span.metadata);
    const user = first(metadata, USER_FIELDS);
    const session = first(metadata, SESSION_FIELDS);
    if (user !== undefined) row.user = user;
    if (session !== undefined) row.session = session;
  }
  return row;
}

/** Reads an export file whole: a malformed trace or span refuses the trace. */
function readExport(value: { trace: JsonObject; spans: JsonValue[] }, context: ConvertContext) {
  const traceKey = value.trace.id as string;
  const rows = [traceRow(value.trace)];
  for (const span of value.spans) {
    if (!isObject(span)) throw new ConversionError("a span that is not an object");
    if (span.trace_id !== traceKey) throw new ConversionError("a span of another trace");
    rows.push(spanRow(span as JsonObject));
  }
  for (const row of rows) context.row(row);
}

export const opikTraces: ImportAdapter = {
  id: "opik_traces",
  manifestFormat: "otlp_json",
  detect: (value) => isExport(value) || isSpan(value) || spanPage(value) !== undefined,
  convert(value, context) {
    if (isExport(value)) {
      readRecords(
        context,
        [value],
        (record) => record.trace.id as string,
        (record) => readExport(record, context),
      );
      return;
    }
    readRecords(
      context,
      isSpan(value) ? [value] : (spanPage(value) ?? []),
      (record) => (isObject(record) ? text(record.trace_id as JsonValue) : undefined),
      (record) => {
        if (!isObject(record)) throw new ConversionError("a record that is not an Opik span");
        context.row(spanRow(record as JsonObject));
      },
    );
  },
};
