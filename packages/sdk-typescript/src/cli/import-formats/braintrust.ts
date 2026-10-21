import { ConversionError, isObject, unixNano, type JsonValue } from "../traces-import-convert.js";
import type { ConvertContext, ImportAdapter } from "./adapter.js";
import { identityText } from "./identity.js";
import { nanosFrom, readRecords, type SpanKind, type SpanRow } from "./rows.js";

/**
 * Braintrust span rows (`ProjectLogsEvent` and `ExperimentEvent` in Braintrust's OpenAPI): one
 * row per span, joined into traces by `root_span_id` with `span_id` and `span_parents`. Read from
 * a single row, a JSON array of rows (a UI download), JSON Lines (`bt sync pull`, a `fmt=jsonl`
 * query, a cloud-storage export once decompressed), a `{"data": […], "schema": …}` query answer
 * and the `{"events": […], "cursor": …}` fetch answer.
 *
 * - `metrics.start`/`end` are Unix seconds; a row without `metrics.start` starts at `created`.
 * - `span_attributes.type` names the kind: `llm` a model call, `tool` a tool call; Braintrust's
 *   own scorers and automations record no operation. `log` rows are events of the span they
 *   share `span_id` with.
 * - The user and conversation come from `metadata` (`user_id`, `userId`, `session_id`,
 *   `thread_id`, …), Mastra's `resourceId` on Mastra rows and `group_id` on OpenAI Agents rows.
 * - Rows exported more than once keep the highest `_xact_id`. An experiment's rows are
 *   evaluation traffic.
 */

type Row = Record<string, JsonValue>;

const isRow = (value: unknown): value is Row =>
  isObject(value) && typeof value.span_id === "string" && typeof value.root_span_id === "string";

/** The rows an envelope (`events` of a fetch, `data` of a query) holds, when it holds any. */
function envelopeRows(value: unknown): unknown[] | undefined {
  if (!isObject(value)) return undefined;
  for (const key of ["events", "data"])
    if (Array.isArray(value[key]) && (value[key] as unknown[]).some(isRow))
      return value[key] as unknown[];
  return undefined;
}

const object = (value: JsonValue | undefined): Row | undefined =>
  isObject(value) ? (value as Row) : undefined;
const text = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" && value ? value : undefined;
const first = (fields: Row | undefined, names: readonly string[]): string | undefined => {
  for (const name of names) {
    const value = identityText(fields?.[name]);
    if (value !== undefined) return value;
  }
  return undefined;
};

const USER_FIELDS = ["user_id", "userId", "user.id", "enduser.id"];
const SESSION_FIELDS = [
  "session_id",
  "sessionId",
  "thread_id",
  "threadId",
  "conversation_id",
  "conversationId",
  "gen_ai.conversation.id",
  "langgraph.thread_id",
];
/** Braintrust's own activity inside a trace (scoring, review, automation): no agent operation. */
const KINDS: Record<string, SpanKind> = { llm: "llm", tool: "tool" };

/** A token count Braintrust recorded, when it is a nonnegative integer. */
const count = (value: JsonValue | undefined) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** A Mastra tool span's input is the assistant message that requested it; its arguments are
 * that call's. Any other input is the arguments as recorded. */
function toolArguments(input: JsonValue | undefined): { arguments?: JsonValue; callId?: string } {
  const message = Array.isArray(input) && input.length === 1 ? object(input[0]) : undefined;
  const calls = message?.tool_calls;
  const requested = Array.isArray(calls) && calls.length === 1 ? object(calls[0]) : undefined;
  const fn = object(requested?.function);
  if (!requested || !fn) return input === undefined ? {} : { arguments: input };
  let args: JsonValue = fn.arguments ?? null;
  if (typeof args === "string")
    try {
      args = JSON.parse(args) as JsonValue;
    } catch {
      // Arguments that are not JSON stay the text recorded.
    }
  return { arguments: args, ...(text(requested.id) ? { callId: text(requested.id)! } : {}) };
}

/** A tool span's output as a tool message (`{role: "tool", content, tool_call_id}`) is read as
 * its content. */
function toolResult(output: JsonValue | undefined): { result?: JsonValue; callId?: string } {
  const message = object(output);
  if (message?.role === "tool" && "content" in message)
    return {
      result: message.content!,
      ...(text(message.tool_call_id) ? { callId: text(message.tool_call_id)! } : {}),
    };
  return output === undefined ? {} : { result: output };
}

function readRow(record: Row, context: ConvertContext): void {
  const traceKey = text(record.root_span_id);
  const spanKey = text(record.span_id);
  if (!traceKey || !spanKey) throw new ConversionError("a row without a span_id or root_span_id");
  const parents = record.span_parents ?? [];
  if (!Array.isArray(parents) || !parents.every((parent) => typeof parent === "string" && parent))
    throw new ConversionError("span_parents is not a list of span ids");
  const attributes = object(record.span_attributes);
  if (record.span_attributes != null && !attributes)
    throw new ConversionError("span_attributes is not an object");
  const metadata = object(record.metadata);
  if (record.metadata != null && !metadata) throw new ConversionError("metadata is not an object");
  const metrics = object(record.metrics);
  if (record.metrics != null && !metrics) throw new ConversionError("metrics is not an object");
  const instant = (value: JsonValue | undefined) =>
    value == null ? undefined : nanosFrom(value, "s");
  let start = instant(metrics?.start);
  const end = instant(metrics?.end);
  let timing: string | undefined;
  if (start === undefined && typeof record.created === "string") {
    start = BigInt(unixNano(record.created));
    timing = "start_from_created";
  }
  const type = text(attributes?.type);
  const name = text(attributes?.name) ?? "span";
  if (type === "log") {
    context.event({
      traceKey,
      spanKey,
      name: text(record.output) ?? name,
      ...(start !== undefined ? { time: start } : {}),
      ...(metadata ? { attributes: { "braintrust.metadata": JSON.stringify(metadata) } } : {}),
      record,
    });
    return;
  }
  const context_ = object(record.context);
  const origin = object(context_?.span_origin);
  const instrumentation = text(object(origin?.instrumentation)?.name);
  const environment = object(origin?.environment);
  const mastra =
    instrumentation === "mastra" ||
    metadata?.spanType !== undefined ||
    metadata?.["mastra-trace-id"] !== undefined;
  const openaiAgents = instrumentation === "openai-agents" || traceKey.startsWith("trace_");
  const kind: SpanKind | undefined =
    type && Object.hasOwn(KINDS, type)
      ? KINDS[type]
      : mastra && metadata?.spanType === "agent_run"
        ? "agent"
        : undefined;
  const error = record.error;
  const row: SpanRow = {
    traceKey,
    spanKey,
    ...(parents[0] !== undefined ? { parentKey: parents[0] as string } : {}),
    ...(parents.length > 1 ? { linkKeys: parents.slice(1) as string[] } : {}),
    name,
    ...(kind ? { kind } : {}),
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
    ...(timing ? { timing } : {}),
    ...(record.input !== undefined ? { input: record.input } : {}),
    ...(record.output !== undefined ? { output: record.output } : {}),
    record,
    ...(metadata ? { metadata } : {}),
    ...(text(record._xact_id) ? { revision: text(record._xact_id)! } : {}),
    attributes: {
      ...(attributes ? { "braintrust.span_attributes": JSON.stringify(attributes) } : {}),
      ...(metadata && Object.keys(metadata).length
        ? { "braintrust.metadata": JSON.stringify(metadata) }
        : {}),
      ...(object(record.scores) ? { "braintrust.scores": JSON.stringify(record.scores) } : {}),
      ...(Array.isArray(record.tags) && record.tags.every((tag) => typeof tag === "string")
        ? { "braintrust.tags": record.tags }
        : {}),
    },
  };
  if (error !== undefined && error !== null && error !== false && error !== "")
    row.error = {
      message:
        typeof error === "string" ? error : (text(object(error)?.message) ?? JSON.stringify(error)),
      ...(text(object(error)?.name) ? { type: text(object(error)?.name)! } : {}),
    };
  if (kind === "llm") {
    const model = text(metadata?.model);
    const provider = text(metadata?.provider);
    if (model) row.model = model;
    if (provider) row.provider = provider;
    row.usage = {
      input: count(metrics?.prompt_tokens),
      output: count(metrics?.completion_tokens),
      cacheRead: count(metrics?.prompt_cached_tokens),
      cacheWrite: count(metrics?.prompt_cache_creation_tokens),
      reasoning: count(metrics?.completion_reasoning_tokens),
    };
  }
  if (kind === "tool") {
    const requested = toolArguments(record.input);
    const returned = toolResult(record.output);
    const quoted = /'([^']+)'\s*$/.exec(name)?.[1];
    row.tool = {
      name: text(metadata?.toolName) ?? text(metadata?.tool_name) ?? quoted ?? name,
      ...(requested.arguments !== undefined ? { arguments: requested.arguments } : {}),
      ...(returned.result !== undefined ? { result: returned.result } : {}),
    };
    const callId =
      text(metadata?.toolCallId) ??
      text(metadata?.tool_call_id) ??
      requested.callId ??
      returned.callId;
    if (callId) row.tool.callId = callId;
  } else {
    const user =
      first(metadata, USER_FIELDS) ?? (mastra ? first(metadata, ["resourceId"]) : undefined);
    const session =
      first(metadata, SESSION_FIELDS) ?? (openaiAgents ? first(metadata, ["group_id"]) : undefined);
    if (user !== undefined) row.user = user;
    if (session !== undefined) row.session = session;
  }
  if (text(record.experiment_id)) row.origin = "evaluation";
  // `vercel` and other platform names are where the code ran, not a deployment environment.
  const environmentName = text(environment?.name);
  if (environmentName === "production" || environmentName === "staging")
    row.environment = environmentName;
  context.row(row);
}

export const braintrust: ImportAdapter = {
  id: "braintrust",
  manifestFormat: "otlp_json",
  detect: (value) => isRow(value) || envelopeRows(value) !== undefined,
  convert(value, context) {
    const records = isRow(value) ? [value] : (envelopeRows(value) ?? []);
    readRecords(
      context,
      records,
      (record) => (isRow(record) ? text(record.root_span_id) : undefined),
      (record) => {
        if (!isRow(record)) throw new ConversionError("a record that is not a Braintrust span row");
        readRow(record, context);
      },
    );
  },
};
