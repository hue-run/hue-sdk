import { ConversionError, isObject, type JsonValue } from "../traces-import-convert.js";
import type { ConvertContext, ImportAdapter } from "./adapter.js";
import { identityText } from "./identity.js";
import { unsigned } from "./otel-spans.js";
import { readRecords, type SpanKind, type SpanRow } from "./rows.js";

/**
 * Datadog LLM Observability spans, as its export API answers them
 * (`GET /api/v2/llm-obs/v1/spans/events` and `POST …/spans/events/search`):
 * `{"data": [{"id", "type": "span", "attributes": {span_id, trace_id, parent_id, name,
 * span_kind, status, start_ns, duration, ml_app, model_name, model_provider, input, output,
 * metadata, metrics, tags, tool_definitions, evaluation, …}}], "meta": …, "links": …}`, one such
 * span alone, or one per line. Each span is one canonical row (`rows.ts`).
 *
 * - `span_id` is a decimal 64-bit id and `trace_id` 32 hex digits; a root's `parent_id` is the
 *   text `undefined`.
 * - `start_ns` and `duration` are nanoseconds, as the SDKs record them. Datadog's own example
 *   answer shows a `start_ns` of millisecond size, so a `start_ns` under 10^14 is read as
 *   milliseconds and one under 10^17 as microseconds, each named in `hue.import.timing`
 *   (`start_ns_read_as_ms`, `start_ns_read_as_us`).
 * - `span_kind` names the kind (`llm`, `tool`, `agent`, `embedding`, `retrieval`; `workflow` and
 *   `task` record no operation); an `experiment` span is evaluation traffic.
 * - LLM messages (`content`, `tool_calls`, `tool_results`) become GenAI message parts; a tool
 *   span's input and output values are its arguments and result.
 * - The conversation is `session_id` (or the `session_id` tag); the end user the `user_id`,
 *   `user.id` or `usr.id` tag, or `user_id` in `metadata`. The `env` tag is the deployment
 *   environment and the `service` tag the resource's `service.name`.
 */

type Json = Record<string, JsonValue>;
const object = (value: unknown): Json | undefined =>
  isObject(value) ? (value as Json) : undefined;
const text = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" && value ? value : undefined;

const isSpan = (value: unknown): value is Json => {
  const attributes = object(object(value)?.attributes);
  return (
    object(value)?.type === "span" &&
    attributes !== undefined &&
    typeof attributes.span_id === "string" &&
    typeof attributes.trace_id === "string"
  );
};

function recordsOf(value: unknown): unknown[] | undefined {
  if (isSpan(value)) return [value];
  const page = object(value);
  return page && Array.isArray(page.data) && page.data.some(isSpan) ? page.data : undefined;
}

const KINDS: Record<string, SpanKind> = {
  llm: "llm",
  tool: "tool",
  agent: "agent",
  embedding: "embedding",
  retrieval: "retrieval",
};
/** A root span's `parent_id`. */
const NO_PARENT = new Set(["undefined", "", "0"]);

/** `start_ns` as Unix nanoseconds, with the rule that read it when it was not nanoseconds. */
function startOf(value: JsonValue | undefined): { start: bigint; timing?: string } | undefined {
  if (value === undefined || value === null) return undefined;
  const count = unsigned(value);
  if (!count) throw new ConversionError("start_ns is not a positive integer");
  if (count < 100_000_000_000_000n)
    return { start: count * 1_000_000n, timing: "start_ns_read_as_ms" };
  if (count < 100_000_000_000_000_000n)
    return { start: count * 1_000n, timing: "start_ns_read_as_us" };
  return { start: count };
}

function durationOf(value: JsonValue | undefined): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return BigInt(Math.round(value));
  const count = unsigned(value);
  if (count === undefined) throw new ConversionError("duration is not a count of nanoseconds");
  return count;
}

/** Tags (`key:value`) by key; a key tagged twice keeps its first value. */
function tagMap(tags: JsonValue | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (tags === undefined || tags === null) return map;
  if (!Array.isArray(tags)) throw new ConversionError("tags is not a list of text");
  for (const tag of tags) {
    if (typeof tag !== "string") throw new ConversionError("tags is not a list of text");
    const at = tag.indexOf(":");
    const key = at < 0 ? tag : tag.slice(0, at);
    if (!map.has(key)) map.set(key, at < 0 ? "" : tag.slice(at + 1));
  }
  return map;
}

/** Datadog's messages as GenAI messages: content as a text part, tool calls and tool results as
 * `tool_call` and `tool_call_response` parts. */
function messagesOf(raw: JsonValue | undefined, role: "user" | "assistant"): JsonValue | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  return raw.map((item) => {
    const message = object(item);
    if (!message) throw new ConversionError("a message that is not an object");
    const parts: JsonValue[] = [];
    if (typeof message.content === "string" && message.content)
      parts.push({ type: "text", content: message.content });
    for (const [field, kind] of [
      ["tool_calls", "tool_call"],
      ["tool_results", "tool_call_response"],
    ] as const) {
      const calls = message[field] ?? [];
      if (!Array.isArray(calls)) throw new ConversionError(`${field} is not a list`);
      for (const value of calls) {
        const call = object(value);
        if (!call) throw new ConversionError(`${field} holds a value that is not an object`);
        parts.push({
          type: kind,
          ...(text(call.tool_id) ? { id: text(call.tool_id)! } : {}),
          ...(text(call.name) ? { name: text(call.name)! } : {}),
          ...(kind === "tool_call"
            ? { arguments: call.arguments ?? null }
            : { response: call.result ?? null }),
        });
      }
    }
    return { role: text(message.role) ?? role, parts };
  });
}

/** A span's input or output: its messages when it has any, else its value, else the object. */
function contentOf(raw: JsonValue | undefined, role: "user" | "assistant"): JsonValue | undefined {
  const io = object(raw);
  if (!io) return raw ?? undefined;
  const messages = messagesOf(io.messages, role);
  if (messages) return messages;
  if (typeof io.value === "string") return io.value;
  return Object.keys(io).length ? io : undefined;
}

/** A tool's arguments or result: the JSON a value holds, else the text. */
function toolValue(raw: JsonValue | undefined): JsonValue | undefined {
  const io = object(raw);
  const value = io ? io.value : raw;
  if (typeof value !== "string") return value ?? undefined;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

const count = (value: JsonValue | undefined) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function readSpan(resource: Json, context: ConvertContext): void {
  const span = object(resource.attributes);
  const traceKey = span?.trace_id;
  const spanKey = span?.span_id;
  if (
    !span ||
    resource.type !== "span" ||
    typeof traceKey !== "string" ||
    typeof spanKey !== "string"
  )
    throw new ConversionError("a record that is not a Datadog span");
  const parent = text(span.parent_id);
  const metadata = object(span.metadata);
  if (span.metadata != null && !metadata) throw new ConversionError("metadata is not an object");
  const metrics = object(span.metrics);
  if (span.metrics != null && !metrics) throw new ConversionError("metrics is not an object");
  const tags = tagMap(span.tags);
  const spanKind = text(span.span_kind);
  const kind = spanKind && Object.hasOwn(KINDS, spanKind) ? KINDS[spanKind] : undefined;
  const started = startOf(span.start_ns);
  const duration = durationOf(span.duration);
  const tool = kind === "tool";
  const row: SpanRow = {
    traceKey,
    spanKey,
    ...(parent && !NO_PARENT.has(parent) ? { parentKey: parent } : {}),
    name: text(span.name) ?? spanKind ?? "span",
    ...(kind ? { kind } : {}),
    ...(started ? { start: started.start } : {}),
    ...(started && duration !== undefined ? { end: started.start + duration } : {}),
    ...(started?.timing ? { timing: started.timing } : {}),
    record: resource,
    ...(metadata ? { metadata } : {}),
    attributes: {
      ...(spanKind ? { "datadog.span_kind": spanKind } : {}),
      ...(text(span.ml_app) ? { "datadog.ml_app": text(span.ml_app)! } : {}),
      ...(Array.isArray(span.tags) ? { "datadog.tags": span.tags } : {}),
      ...(metadata && Object.keys(metadata).length
        ? { "datadog.metadata": JSON.stringify(metadata) }
        : {}),
      ...(metrics ? { "datadog.metrics": JSON.stringify(metrics) } : {}),
      ...(object(span.evaluation) ? { "datadog.evaluation": JSON.stringify(span.evaluation) } : {}),
      ...(text(span.intent) ? { "datadog.intent": text(span.intent)! } : {}),
      ...(Array.isArray(span.tool_definitions)
        ? { "gen_ai.tool.definitions": JSON.stringify(span.tool_definitions) }
        : {}),
    },
  };
  const service = tags.get("service");
  if (service) row.resource = { "service.name": service };
  const environment = tags.get("env");
  if (environment) row.environment = environment;
  if (spanKind === "experiment") row.origin = "evaluation";
  if (tool) {
    const args = toolValue(span.input);
    const result = toolValue(span.output);
    row.tool = {
      name: text(span.name) ?? "tool",
      ...(args !== undefined ? { arguments: args } : {}),
      ...(result !== undefined ? { result } : {}),
    };
  } else {
    const input = contentOf(span.input, "user");
    const output = contentOf(span.output, "assistant");
    if (input !== undefined) row.input = input;
    if (output !== undefined) row.output = output;
    // Who asked, never from a tool span: a tool's record may name the account it acted on.
    const user =
      tags.get("user_id") ??
      tags.get("user.id") ??
      tags.get("usr.id") ??
      identityText(metadata?.user_id) ??
      identityText(metadata?.userId);
    const session =
      identityText(span.session_id) ??
      tags.get("session_id") ??
      identityText(metadata?.session_id) ??
      identityText(metadata?.sessionId) ??
      identityText(metadata?.thread_id) ??
      identityText(metadata?.conversation_id);
    if (user) row.user = user;
    if (session) row.session = session;
  }
  if (kind === "llm") {
    if (text(span.model_name)) row.model = text(span.model_name)!;
    if (text(span.model_provider)) row.provider = text(span.model_provider)!;
    row.usage = {
      input: count(metrics?.input_tokens),
      output: count(metrics?.output_tokens),
      cacheRead: count(metrics?.cache_read_input_tokens),
      cacheWrite: count(metrics?.cache_write_input_tokens),
      reasoning: count(metrics?.reasoning_output_tokens),
    };
  }
  if (span.status === "error") {
    const error = object(span.error);
    const message = text(error?.message) ?? text(span["error.message"]);
    const type = text(error?.type) ?? text(span["error.type"]) ?? tags.get("error_type");
    row.error = { ...(message ? { message } : {}), ...(type ? { type } : {}) };
  }
  context.row(row);
}

export const datadogLlmObs: ImportAdapter = {
  id: "datadog_llmobs",
  manifestFormat: "otlp_json",
  detect: (value) => recordsOf(value) !== undefined,
  convert(value, context) {
    readRecords(
      context,
      recordsOf(value) ?? [],
      (record) => {
        const traceId = object(object(record)?.attributes)?.trace_id;
        return typeof traceId === "string" && traceId ? traceId : undefined;
      },
      (record) => {
        const resource = object(record);
        if (!resource) throw new ConversionError("a record that is not an object");
        readSpan(resource, context);
      },
    );
  },
};
