import { ConversionError, isObject } from "../traces-import-convert.js";
import type { ConvertContext, ImportAdapter } from "./adapter.js";
import { identityText } from "./identity.js";
import {
  count,
  first,
  isoNanos,
  metadataUser,
  object,
  SESSION_FIELDS,
  text,
  type JsonObject,
} from "./row-platform-fields.js";
import { readRecords, type SpanKind, type SpanRow } from "./rows.js";

/**
 * W&B Weave calls (`CallSchema` of Weave's trace server): one call per span, joined into traces by
 * `trace_id` with `parent_id`. Read from a single call, JSON Lines of calls (the calls stream
 * query's answer, a UI export), a JSON array of them, the calls query answer (`{"calls": […]}`)
 * and the call read answer (`{"call": …}`).
 *
 * - The op's kind (`attributes.weave.kind`) names the span's: `llm` a model call, `tool` a tool
 *   call, `agent`, and `search` a retrieval; `guardrail`, `scorer` and other ops record no
 *   operation. Weave records kinds since January 2026; a call without one from an op Weave's
 *   integrations patch (`openai.chat.completions.create`, `anthropic.Messages.create`,
 *   `litellm.completion`, … a model call; `mcp.server.fastmcp.FastMCP.call_tool` and
 *   `crewai_tools.*._run` a tool call) is read as the kind those integrations give it now. The
 *   name is the call's `display_name`, else its op's name.
 * - Token counts come from an `llm` call's `summary.usage`, recorded per model; Weave sums a
 *   parent's usage over its children, so no other call's is read.
 * - The conversation is the call's `thread_id`, else its `attributes`' (`thread_id`,
 *   `session_id`, …); the user comes from its `attributes` (`userId`, `user_id`, …, in the order
 *   Hue reads a metadata map). `wb_user_id` names the W&B account that logged the call, never the
 *   end user.
 * - A trace with an `Evaluation.*` op, or whose root is a scorer, is evaluation traffic; a scorer
 *   applied inside the application's own op (a guardrail) is a span of its production trace. A
 *   call exported both before and after it ended keeps the ended copy.
 */

const isCall = (value: unknown): value is JsonObject =>
  isObject(value) &&
  typeof value.id === "string" &&
  typeof value.trace_id === "string" &&
  typeof value.op_name === "string" &&
  typeof value.started_at === "string";

/** The calls a query answer (`calls`) or read answer (`call`) holds, when it holds any. */
function envelopeCalls(value: unknown): unknown[] | undefined {
  if (!isObject(value)) return undefined;
  if (Array.isArray(value.calls) && value.calls.some(isCall)) return value.calls;
  if (isCall(value.call)) return [value.call];
  return undefined;
}

const KINDS: Record<string, SpanKind> = {
  llm: "llm",
  tool: "tool",
  agent: "agent",
  search: "retrieval",
};

/** An op's own name from its ref (`weave:///<entity>/<project>/op/<name>:<digest>`). */
const opName = (ref: string) => /\/op\/([^/:]+)(?::[^/]*)?$/.exec(ref)?.[1] ?? ref;

/** The ops Weave's integrations patch, by the kind they give each since kinds were recorded
 * (weave `integrations/*`): a call from before then has the op but not the kind. */
const INTEGRATION_KINDS: [RegExp, SpanKind][] = [
  [/^openai\.(?:beta\.)?chat\.completions\.(?:create|parse)$/, "llm"],
  [/^openai\.responses\.(?:create|parse)$/, "llm"],
  [/^anthropic\.(?:beta\.)?(?:Async)?Messages\.(?:create|stream)$/, "llm"],
  [/^(?:cerebras|groq|groq\.async)\.chat\.completions\.create$/, "llm"],
  [/^mistralai\.(?:async_client\.)?chat\.(?:complete|stream)$/, "llm"],
  [/^cohere\.(?:Async)?Client(?:V2)?\.chat(?:_stream)?$/, "llm"],
  [/^litellm\.a?completion$/, "llm"],
  [/^huggingface_hub\.(?:Async)?InferenceClient\.chat_completion$/, "llm"],
  [/^google\.genai\.models\.(?:Async)?Models\.generate_content(?:_stream)?$/, "llm"],
  [/^vertexai\.(?:GenerativeModel\.generate_content|ChatSession\.send_message)(?:_async)?$/, "llm"],
  [/^BedrockRuntime\.(?:converse|invoke)$/, "llm"],
  [/^crewai\.LLM\.call$/, "llm"],
  [/^mcp\.server\.fastmcp\.FastMCP\.call_tool$/, "tool"],
  [/^crewai_tools\.[^.]+\._run$/, "tool"],
];

function readCall(call: JsonObject, context: ConvertContext): void {
  const traceKey = text(call.trace_id);
  const spanKey = text(call.id);
  if (!traceKey || !spanKey) throw new ConversionError("a call without an id or trace_id");
  const attributes = object(call.attributes);
  if (call.attributes != null && !attributes)
    throw new ConversionError("attributes is not an object");
  const summary = object(call.summary);
  if (call.summary != null && !summary) throw new ConversionError("summary is not an object");
  const op = opName(call.op_name as string);
  const weaveKind = text(object(attributes?.weave)?.kind);
  const kind =
    weaveKind !== undefined
      ? Object.hasOwn(KINDS, weaveKind)
        ? KINDS[weaveKind]
        : undefined
      : INTEGRATION_KINDS.find(([pattern]) => pattern.test(op))?.[1];
  const start = isoNanos(call.started_at);
  const end = call.ended_at == null ? undefined : isoNanos(call.ended_at);
  const inputs = call.inputs ?? undefined;
  const output = call.output ?? undefined;
  const row: SpanRow = {
    traceKey,
    spanKey,
    ...(text(call.parent_id) ? { parentKey: text(call.parent_id)! } : {}),
    name: text(call.display_name) ?? op,
    ...(kind ? { kind } : {}),
    start,
    ...(end !== undefined ? { end } : {}),
    ...(inputs !== undefined ? { input: inputs } : {}),
    ...(output !== undefined ? { output } : {}),
    record: call,
    ...(attributes ? { metadata: attributes } : {}),
    revision: end !== undefined ? "1" : "0",
    attributes: {
      "weave.op_name": call.op_name as string,
      ...(attributes ? { "weave.attributes": JSON.stringify(attributes) } : {}),
    },
  };
  const exception = text(call.exception);
  if (exception !== undefined || text(object(summary?.weave)?.status) === "error")
    row.error = exception !== undefined ? { message: exception } : {};
  if (kind === "llm") {
    const usage = object(summary?.usage);
    const models = usage ? Object.keys(usage) : [];
    const model = text(object(inputs)?.model) ?? (models.length === 1 ? models[0] : undefined);
    const responseModel = text(object(output)?.model);
    if (model) row.model = model;
    if (responseModel) row.responseModel = responseModel;
    const counts = models.length === 1 ? object(usage![models[0]!]) : undefined;
    if (counts)
      row.usage = {
        input: count(counts.prompt_tokens) ?? count(counts.input_tokens),
        output: count(counts.completion_tokens) ?? count(counts.output_tokens),
        cacheRead: count(counts.cache_read_input_tokens),
        cacheWrite: count(counts.cache_creation_input_tokens),
      };
  }
  if (kind === "tool")
    row.tool = {
      name: row.name,
      ...(inputs !== undefined ? { arguments: inputs } : {}),
      ...(output !== undefined ? { result: output } : {}),
    };
  else {
    const user = metadataUser(attributes);
    const session = identityText(call.thread_id) ?? first(attributes, SESSION_FIELDS);
    if (user !== undefined) row.user = user;
    if (session !== undefined) row.session = session;
  }
  if (op.startsWith("Evaluation.") || (weaveKind === "scorer" && row.parentKey === undefined))
    row.origin = "evaluation";
  context.row(row);
}

export const weaveCalls: ImportAdapter = {
  id: "weave_calls",
  manifestFormat: "otlp_json",
  detect: (value) => isCall(value) || envelopeCalls(value) !== undefined,
  convert(value, context) {
    readRecords(
      context,
      isCall(value) ? [value] : (envelopeCalls(value) ?? []),
      (record) => (isCall(record) ? text(record.trace_id) : undefined),
      (record) => {
        if (!isCall(record)) throw new ConversionError("a record that is not a Weave call");
        readCall(record, context);
      },
    );
  },
};
