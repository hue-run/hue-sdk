import {
  ConversionError,
  isObject,
  parseNestedJsonText,
  unixNano,
  type JsonValue,
} from "../traces-import-convert.js";
import type { ConvertContext, ImportAdapter } from "./adapter.js";
import { identityText } from "./identity.js";
import { metadataUser } from "./row-platform-fields.js";
import { readRecords, type SpanKind, type SpanRow } from "./rows.js";

/**
 * OpenAI Agents SDK traces as a `TracingProcessor` writes them (Python and JavaScript alike):
 * `Trace.export()`, `{"object": "trace", id, workflow_name, group_id, metadata}`, and
 * `Span.export()`, `{"object": "trace.span", id, trace_id, parent_id, started_at, ended_at,
 * span_data, error}`, one per line or in a list, and the `{"data": […]}` body the SDK's exporter
 * posts to OpenAI's trace ingest.
 *
 * - The trace record is the root span, named by `workflow_name`; a span with no `parent_id` sits
 *   beneath it. Without the trace record such a span is a root of its trace, the trace id kept as
 *   its original parent.
 * - `span_data.type` names the kind: `agent` an agent invocation, `generation` a model call with
 *   its messages, model and token usage, `response` a Responses API call (its id and usage; the
 *   SDK exports no content for it), `function` a tool call with its arguments and result.
 *   `handoff`, `guardrail`, `custom` (the SDK's task and turn spans among them), `mcp_tools` and
 *   the voice spans record no GenAI operation and keep their data as attributes.
 * - `group_id` is the conversation; the trace metadata's `userId` (or `user_id`) is the end user,
 *   read as Hue reads a metadata map.
 * - `started_at` and `ended_at` are ISO 8601 instants. The trace record has none, so it spans its
 *   spans (`start_from_trace`, `end_from_children`).
 * - The ids (`trace_…`, `span_…`) are no OpenTelemetry ids: they are mapped by SHA-256 and kept.
 * - A span written both when it started and when it ended is read from its ended copy.
 */

type JsonObject = { [key: string]: JsonValue };
type Usage = NonNullable<SpanRow["usage"]>;

const object = (value: JsonValue | undefined): JsonObject | undefined =>
  isObject(value) ? (value as JsonObject) : undefined;
const text = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" && value ? value : undefined;
const count = (value: JsonValue | undefined): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const strings = (value: JsonValue | undefined): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;

const isTrace = (value: unknown): value is JsonObject =>
  isObject(value) && value.object === "trace" && typeof value.id === "string";
const isSpan = (value: unknown): value is JsonObject =>
  isObject(value) && value.object === "trace.span" && typeof value.trace_id === "string";
const isRecord = (value: unknown): value is JsonObject => isTrace(value) || isSpan(value);

/** The records an ingest body (`{"data": […]}`) holds, when it holds any. */
function envelopeRecords(value: unknown): unknown[] | undefined {
  return isObject(value) && Array.isArray(value.data) && value.data.some(isRecord)
    ? value.data
    : undefined;
}

const SESSION_FIELDS = [
  "session_id",
  "sessionId",
  "thread_id",
  "threadId",
  "conversation_id",
  "conversationId",
];
const first = (fields: JsonObject | undefined, names: readonly string[]) => {
  for (const name of names) {
    const value = identityText(fields?.[name]);
    if (value !== undefined) return value;
  }
  return undefined;
};

/** An instant the SDK recorded (`started_at`, `ended_at`), or none when it is null. */
const instant = (value: JsonValue | undefined): bigint | undefined =>
  value === undefined || value === null ? undefined : BigInt(unixNano(value));

/** Token usage of a model call: `input_tokens`, `output_tokens` and their details, also as the
 * SDK's OpenAI exporter nests them under `details`. */
function usageOf(value: JsonValue | undefined): Usage | undefined {
  const usage = object(value);
  if (!usage) return undefined;
  const details = object(usage.details);
  const detail = (name: string) => {
    const found = usage[name] ?? details?.[name];
    return object(Array.isArray(found) ? found[0] : found);
  };
  const input = detail("input_tokens_details");
  const output = detail("output_tokens_details");
  return {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(input?.cached_tokens) ?? count(usage.cached_input_tokens),
    cacheWrite: count(input?.cache_write_tokens) ?? count(usage.cache_write_input_tokens),
    reasoning: count(output?.reasoning_tokens),
  };
}

/** A function tool's arguments: the JSON text the model wrote, parsed when it is JSON. */
function argumentsOf(value: JsonValue | undefined): JsonValue | undefined {
  if (typeof value !== "string") return value ?? undefined;
  try {
    return parseNestedJsonText(value).value as JsonValue;
  } catch {
    return value;
  }
}

function readTrace(record: JsonObject, context: ConvertContext): void {
  const traceKey = text(record.id);
  if (!traceKey) throw new ConversionError("a trace without an id");
  const metadata = object(record.metadata);
  if (record.metadata != null && !metadata) throw new ConversionError("metadata is not an object");
  const user = metadataUser(metadata);
  const session = identityText(record.group_id) ?? first(metadata, SESSION_FIELDS);
  context.row({
    traceKey,
    spanKey: traceKey,
    name: text(record.workflow_name) ?? "trace",
    ...(user !== undefined ? { user } : {}),
    ...(session !== undefined ? { session } : {}),
    attributes:
      metadata && Object.keys(metadata).length
        ? { "openai_agents.metadata": JSON.stringify(metadata) }
        : {},
    record,
    ...(metadata ? { metadata } : {}),
  });
}

function readSpan(record: JsonObject, context: ConvertContext): void {
  const traceKey = text(record.trace_id);
  const spanKey = text(record.id);
  if (!traceKey || !spanKey) throw new ConversionError("a span without an id or trace_id");
  if (record.parent_id != null && !text(record.parent_id))
    throw new ConversionError("parent_id is not a span id");
  const data = object(record.span_data);
  const type = text(data?.type);
  if (!data || !type) throw new ConversionError("span_data has no type");
  const error = record.error;
  if (error != null && !object(error)) throw new ConversionError("error is not an object");
  const metadata = object(record.metadata);
  const name = text(data.name) ?? type;
  const attributes: Record<string, JsonValue> = { "openai_agents.span.type": type };
  const json = (key: string, value: JsonValue | undefined) => {
    if (value !== undefined && value !== null) attributes[key] = JSON.stringify(value);
  };
  if (metadata && Object.keys(metadata).length) json("openai_agents.metadata", metadata);
  let kind: SpanKind | undefined;
  const row: Partial<SpanRow> = {};
  switch (type) {
    case "agent":
      kind = "agent";
      row.agentName = name;
      for (const field of ["handoffs", "tools"] as const)
        if (strings(data[field]))
          attributes[`openai_agents.agent.${field}`] = strings(data[field])!;
      if (text(data.output_type)) attributes["openai_agents.agent.output_type"] = data.output_type!;
      break;
    case "function":
      kind = "tool";
      row.tool = {
        name,
        ...(data.input != null ? { arguments: argumentsOf(data.input)! } : {}),
        ...(data.output != null ? { result: data.output } : {}),
      };
      json("openai_agents.mcp_data", data.mcp_data);
      break;
    case "generation":
      kind = "llm";
      if (data.input != null) row.input = data.input;
      if (data.output != null) row.output = data.output;
      if (text(data.model)) row.model = text(data.model)!;
      row.usage = usageOf(data.usage);
      json("openai_agents.model_config", data.model_config);
      break;
    case "response":
      kind = "llm";
      if (text(data.response_id)) attributes["gen_ai.response.id"] = data.response_id!;
      row.usage = usageOf(data.usage);
      break;
    case "handoff":
      if (text(data.from_agent)) attributes["openai_agents.handoff.from_agent"] = data.from_agent!;
      if (text(data.to_agent)) attributes["openai_agents.handoff.to_agent"] = data.to_agent!;
      break;
    case "guardrail":
      if (typeof data.triggered === "boolean")
        attributes["openai_agents.guardrail.triggered"] = data.triggered;
      break;
    case "custom":
      json("openai_agents.custom.data", data.data);
      break;
    case "mcp_tools":
      if (text(data.server)) attributes["openai_agents.mcp.server"] = data.server!;
      if (strings(data.result)) attributes["openai_agents.mcp.tools"] = strings(data.result)!;
      break;
    default:
      // Voice and future span types: the model they name, their data in the source record.
      if (text(data.model)) row.model = text(data.model)!;
  }
  const start = instant(record.started_at);
  const end = instant(record.ended_at);
  const errorFields = object(error);
  context.row({
    traceKey,
    spanKey,
    parentKey: text(record.parent_id) ?? traceKey,
    name,
    ...(kind ? { kind } : {}),
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
    ...row,
    ...(errorFields
      ? {
          error: text(errorFields.message) ? { message: text(errorFields.message)! } : {},
        }
      : {}),
    attributes: {
      ...attributes,
      ...(errorFields?.data != null
        ? { "openai_agents.error.data": JSON.stringify(errorFields.data) }
        : {}),
    },
    record,
    ...(metadata ? { metadata } : {}),
    // A processor may write a span when it starts and again when it ends: the ended copy wins.
    revision: end === undefined ? "0" : "1",
  });
}

export const openaiAgents: ImportAdapter = {
  id: "openai_agents",
  manifestFormat: "otlp_json",
  detect: (value) => isRecord(value) || envelopeRecords(value) !== undefined,
  convert(value, context) {
    const records = isRecord(value) ? [value] : (envelopeRecords(value) ?? []);
    readRecords(
      context,
      records,
      (record) =>
        isTrace(record) ? text(record.id) : isSpan(record) ? text(record.trace_id) : undefined,
      (record) => {
        if (isTrace(record)) readTrace(record, context);
        else if (isSpan(record)) readSpan(record, context);
        else throw new ConversionError("a record that is not an OpenAI Agents trace or span");
      },
    );
  },
};
