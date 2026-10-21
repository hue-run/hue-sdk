import {
  canonicalJson,
  ConversionError,
  isObject,
  sha256Hex,
  type JsonValue,
} from "../traces-import-convert.js";
import type { ConvertContext, ImportAdapter } from "./adapter.js";
import { identityText } from "./identity.js";
import { genAiMessages, type GenAiMessage } from "./messages.js";
import { nanosFrom, readRecords, type SpanRow } from "./rows.js";

/**
 * Plain chat transcripts: a conversation as a model API took or returned it, with no trace of its
 * own. Three formats share one reading:
 *
 * - `openai_chat`: a Chat Completions request, or a line of a chat JSONL file (fine-tuning and
 *   eval datasets): `{"messages": […], "tools"?: […], "model"?: …}`.
 * - `openai_responses`: a Responses API `response` object, a request (`{"input": […]}`, with
 *   `output` beside it when the answer was logged with it), or a bare list of input and output
 *   items.
 * - `anthropic_messages`: a Messages API request (`{"messages": […], "system"?: …}`) or response
 *   (`{"type": "message", "role": "assistant", "content": […], "model": …}`).
 *
 * Each value is one trace: an `invoke_agent` span for the whole conversation, a `chat` span per
 * assistant turn (consecutive assistant messages or items are one turn) with the conversation so
 * far as its input, and an `execute_tool` span per tool call, paired with its result by
 * `tool_call_id`, `call_id` or `tool_use_id`. A logged answer (a response object, or `output`
 * beside a request's `input`) is the last turn and carries the token usage the source records.
 *
 * - Ids: a response's own id (`msg_…`, `resp_…`) names the trace; otherwise the trace id derives
 *   from the SHA-256 of the value's canonical JSON, so the same transcript is the same trace.
 * - Times: transcripts record none, except a Responses object's `created_at`, the start of its
 *   turn. Every other instant follows the emitter's rules (`untimed_trace` for a transcript with
 *   none: 2000-01-01T00:00:00Z, a millisecond per span in conversation order).
 * - The end user is the API's own end-user field when the request carries one (OpenAI
 *   `safety_identifier` or the older `user`, Anthropic `metadata.user_id`) and the conversation a
 *   Responses `conversation`; otherwise `--user-key` names them, or the trace has no owner.
 * - The agent span keeps the whole value as `hue.import.source_record`; each turn keeps the
 *   messages it was read from, and each tool call the message holding its result.
 * - A request whose messages are all user and assistant text, with nothing only Anthropic sends,
 *   reads as `openai_chat`; both read it the same way.
 */

type JsonObject = { [key: string]: JsonValue };
type Usage = NonNullable<SpanRow["usage"]>;

const object = (value: unknown): JsonObject | undefined =>
  isObject(value) ? (value as JsonObject) : undefined;
const text = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" && value ? value : undefined;
const count = (value: JsonValue | undefined): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Keys of another format's record: a value holding one is never a transcript. */
const FOREIGN_KEYS = [
  "span_id",
  "root_span_id",
  "trace_id",
  "traceId",
  "resourceSpans",
  "resource_spans",
  "schema_version",
  "steps",
  "observations",
];
const foreign = (value: JsonObject) => FOREIGN_KEYS.some((key) => key in value);

// --- Message lists ---------------------------------------------------------------------------

/** A Responses API item type: messages, tool calls and their outputs, reasoning and the rest. */
const RESPONSES_ITEM =
  /^(?:message|reasoning|compaction|compaction_trigger|item_reference|configuration_update|additional_tools|program|program_output|tool_search_output|mcp_list_tools|mcp_approval_request|mcp_approval_response|[a-z_]+_call(?:_output)?)$/;

/** A typed Responses item (never an Anthropic response, which names its model). */
function isResponsesItem(value: unknown): boolean {
  const item = object(value);
  if (!item || typeof item.type !== "string" || !RESPONSES_ITEM.test(item.type)) return false;
  if ("model" in item || foreign(item)) return false;
  return item.type !== "message" || typeof item.role === "string";
}

/** An untyped message (`{role, content}`), which the Responses API also takes as input. */
const isEasyMessage = (value: unknown): boolean => {
  const item = object(value);
  return (
    !!item &&
    item.type === undefined &&
    typeof item.role === "string" &&
    (typeof item.content === "string" || Array.isArray(item.content))
  );
};

/** A list of Responses items: every element an item or a message, at least one typed. */
const isItemList = (value: unknown): value is JsonValue[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => isResponsesItem(item) || isEasyMessage(item)) &&
  value.some(isResponsesItem);

/**
 * A message list's items as the message shapes `genAiMessages` reads: a Responses item it reads
 * no message from (a hosted tool call, encrypted reasoning) becomes a message holding that item as
 * a part of its own type, from the tool for an `…_output` item and from the assistant otherwise.
 */
export function chatItems(items: readonly JsonValue[]): JsonValue[] {
  return items.map((raw) => {
    if (genAiMessages([raw])) return raw;
    const item = object(raw);
    const type = text(item?.type);
    if (!item || !type || item.role !== undefined) return raw;
    return { role: type.endsWith("_output") ? "tool" : "assistant", parts: [item] };
  });
}

/** Each item read as one GenAI message, or a ConversionError naming the first that is not. */
function readMessages(items: readonly JsonValue[], what: string): GenAiMessage[] {
  return items.map((item, index) => {
    const message = genAiMessages([item])?.[0];
    if (!message) throw new ConversionError(`${what} ${index + 1} is not a chat message`);
    return message;
  });
}

/** System instructions as GenAI parts: text as it is, Anthropic text blocks as text parts. */
function systemParts(value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return value;
  return genAiMessages([{ role: "system", content: value }])?.[0]?.parts ?? value;
}

// --- Model API bodies (also read by the Helicone format) -------------------------------------

/** The conversation a model request sends, as message shapes: chat `messages` (OpenAI, Anthropic)
 * or Responses `input`; anything else as recorded. */
export function requestContent(body: JsonValue | undefined): JsonValue | undefined {
  const fields = object(body);
  if (!fields) return body;
  if (Array.isArray(fields.messages)) return chatItems(fields.messages);
  if (typeof fields.input === "string") return [{ role: "user", content: fields.input }];
  if (isItemList(fields.input)) return chatItems(fields.input);
  return body;
}

/** A request's system instructions: Anthropic `system` or Responses `instructions`. */
export const requestInstructions = (body: JsonValue | undefined): JsonValue | undefined =>
  systemParts(object(body)?.system ?? object(body)?.instructions);

/** A model response's content as message shapes: Responses `output` items; a chat completion or
 * Anthropic message as recorded, which `genAiMessages` reads. */
export function responseContent(body: JsonValue | undefined): JsonValue | undefined {
  const fields = object(body);
  return fields && Array.isArray(fields.output) ? chatItems(fields.output) : body;
}

/** Token usage of an OpenAI (chat or Responses) or Anthropic response. Anthropic's input count
 * leaves out cached tokens, so they are added back as the GenAI conventions count input. */
export function responseUsage(usage: JsonValue | undefined): Usage | undefined {
  const fields = object(usage);
  if (!fields) return undefined;
  const input = object(fields.input_tokens_details) ?? object(fields.prompt_tokens_details);
  const output = object(fields.output_tokens_details) ?? object(fields.completion_tokens_details);
  const cacheRead = count(fields.cache_read_input_tokens) ?? count(input?.cached_tokens);
  const cacheWrite = count(fields.cache_creation_input_tokens);
  const anthropic = "cache_read_input_tokens" in fields || "cache_creation_input_tokens" in fields;
  const inputTokens = count(fields.input_tokens) ?? count(fields.prompt_tokens);
  return {
    input:
      anthropic && inputTokens !== undefined
        ? inputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0)
        : inputTokens,
    output: count(fields.output_tokens) ?? count(fields.completion_tokens),
    cacheRead,
    cacheWrite,
    reasoning: count(output?.reasoning_tokens),
  };
}

// --- One transcript as one trace -------------------------------------------------------------

interface Transcript {
  record: JsonValue;
  /** The conversation as sent: its messages or items as recorded. */
  history: JsonValue[];
  /** The answer the source logged with it, the last turn: its messages or items as recorded, and
   * the record its span keeps. */
  answer?: {
    items: JsonValue[];
    record: JsonValue;
    usage?: Usage;
    model?: string;
    start?: bigint;
    error?: { message?: string; type?: string };
  };
  model?: string;
  system?: JsonValue;
  tools?: JsonValue;
  user?: string;
  session?: string;
  /** Tool call ids whose result the source marks as an error (Anthropic `is_error`). */
  failed?: ReadonlySet<string>;
}

interface Turn {
  /** Index of its first message in the conversation, and of the message after its last. */
  at: number;
  end: number;
  messages: GenAiMessage[];
}

/** The trace's rows: the agent, a chat span per turn and a tool span per call. */
function transcriptRows(traceKey: string, transcript: Transcript): SpanRow[] {
  // Spans carry the items in shapes the emitter reads; records keep them as the source wrote them.
  const raw = transcript.history;
  const items = chatItems(raw);
  const history = readMessages(items, "message");
  const answerItems = transcript.answer ? chatItems(transcript.answer.items) : undefined;
  const answer = answerItems ? readMessages(answerItems, "output item") : undefined;
  const turns: Turn[] = [];
  for (let index = 0; index < history.length; index++) {
    if (history[index]!.role !== "assistant") continue;
    let end = index;
    while (end < history.length && history[end]!.role === "assistant") end++;
    turns.push({ at: index, end, messages: history.slice(index, end) });
    index = end - 1;
  }
  // A tool call's result, by call id, with the message that holds it.
  const results = new Map<string, { response: JsonValue; item: JsonValue }>();
  for (const [index, message] of history.entries())
    for (const part of message.parts)
      if (
        part.type === "tool_call_response" &&
        typeof part.id === "string" &&
        !results.has(part.id)
      )
        results.set(part.id, { response: part.response ?? null, item: raw[index]! });

  const model = transcript.model ?? transcript.answer?.model;
  const system = transcript.system;
  const firstTurn = turns[0]?.at ?? history.length;
  const last = turns.at(-1);
  const lastOutput = answerItems ?? (last ? items.slice(last.at, last.end) : undefined);
  const rows: SpanRow[] = [
    {
      traceKey,
      spanKey: "agent",
      name: "invoke_agent",
      kind: "agent",
      ...(firstTurn > 0 ? { input: items.slice(0, firstTurn) } : {}),
      ...(lastOutput?.length ? { output: lastOutput } : {}),
      ...(system !== undefined ? { systemInstructions: system } : {}),
      ...(transcript.user !== undefined ? { user: transcript.user } : {}),
      ...(transcript.session !== undefined ? { session: transcript.session } : {}),
      ...(transcript.tools !== undefined
        ? { attributes: { "gen_ai.tool.definitions": JSON.stringify(transcript.tools) } }
        : {}),
      record: transcript.record,
      sequence: 0,
    },
  ];
  let sequence = 1;
  const addTurn = (
    number: number,
    input: JsonValue[],
    output: { items: JsonValue[]; raw: JsonValue[]; messages: GenAiMessage[]; record: JsonValue },
    fields: Partial<SpanRow>,
  ) => {
    rows.push({
      traceKey,
      spanKey: `turn-${number}`,
      parentKey: "agent",
      name: model ? `chat ${model}` : "chat",
      kind: "llm",
      ...(model ? { model } : {}),
      ...(input.length ? { input } : {}),
      output: output.items,
      ...(system !== undefined ? { systemInstructions: system } : {}),
      record: output.record,
      sequence: sequence++,
      ...fields,
    });
    let call = 0;
    for (const [index, message] of output.messages.entries())
      for (const part of message.parts) {
        if (part.type !== "tool_call") continue;
        const id = typeof part.id === "string" ? part.id : undefined;
        const name = typeof part.name === "string" && part.name ? part.name : "tool";
        const result = id === undefined ? undefined : results.get(id);
        rows.push({
          traceKey,
          spanKey: `turn-${number}.tool-${++call}`,
          parentKey: "agent",
          name: `execute_tool ${name}`,
          kind: "tool",
          tool: {
            name,
            ...(id !== undefined ? { callId: id } : {}),
            arguments: part.arguments ?? null,
            ...(result ? { result: result.response } : {}),
          },
          ...(id !== undefined && transcript.failed?.has(id) ? { error: {} } : {}),
          record: result?.item ?? output.raw[index]!,
          sequence: sequence++,
        });
      }
  };
  for (const [index, turn] of turns.entries()) {
    const own = raw.slice(turn.at, turn.end);
    addTurn(
      index + 1,
      items.slice(0, turn.at),
      {
        items: items.slice(turn.at, turn.end),
        raw: own,
        messages: turn.messages,
        record: own.length === 1 ? own[0]! : own,
      },
      {},
    );
  }
  if (transcript.answer && answerItems && answer) {
    const { usage, start, error } = transcript.answer;
    addTurn(
      turns.length + 1,
      items,
      {
        items: answerItems,
        raw: transcript.answer.items,
        messages: answer,
        record: transcript.answer.record,
      },
      {
        ...(transcript.answer.model ? { responseModel: transcript.answer.model } : {}),
        ...(usage ? { usage } : {}),
        ...(start !== undefined ? { start } : {}),
        ...(error ? { error } : {}),
      },
    );
  }
  return rows;
}

/** Converts one transcript; a malformed one refuses only its own trace. `id` reads the source's
 * own id; without one the trace id derives from the content. */
function convertTranscript(
  value: unknown,
  context: ConvertContext,
  read: (value: JsonObject | JsonValue[]) => Transcript,
  id?: (fields: JsonObject) => string | undefined,
): void {
  // Parsed JSON, an object or a list as `detect` claimed it.
  const json = value as JsonObject | JsonValue[];
  const traceKey = (!Array.isArray(json) && id?.(json)) || sha256Hex(canonicalJson(json));
  readRecords(
    context,
    [json],
    () => traceKey,
    () => {
      for (const row of transcriptRows(traceKey, read(json))) context.row(row);
    },
  );
}

// --- OpenAI Chat Completions -----------------------------------------------------------------

/** A request's end user: OpenAI's `safety_identifier` or the older `user` field. */
const openAiUser = (fields: JsonObject) =>
  identityText(fields.safety_identifier) ?? identityText(fields.user);

/** Anthropic content block types OpenAI chat never sends. */
const ANTHROPIC_BLOCKS = new Set([
  "tool_use",
  "tool_result",
  "thinking",
  "redacted_thinking",
  "document",
  "search_result",
  "server_tool_use",
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "mcp_tool_use",
  "mcp_tool_result",
  "container_upload",
]);
const OPENAI_ROLES = new Set(["system", "developer", "tool", "function"]);

/** A request with a message list: `messages` holding at least one `{role}` message. */
const isChatRequest = (value: unknown): value is JsonObject => {
  const fields = object(value);
  return (
    !!fields &&
    !foreign(fields) &&
    !("object" in fields) &&
    Array.isArray(fields.messages) &&
    fields.messages.some((message) => typeof object(message)?.role === "string")
  );
};

/** Whether a chat request carries something only the Anthropic Messages API sends, and nothing
 * only OpenAI's does. */
function anthropicRequest(fields: JsonObject): boolean {
  const messages = (fields.messages as JsonValue[]).map(object);
  const openAi =
    messages.some(
      (message) =>
        OPENAI_ROLES.has(text(message?.role) ?? "") ||
        message?.tool_calls !== undefined ||
        message?.tool_call_id !== undefined ||
        message?.function_call !== undefined,
    ) ||
    (Array.isArray(fields.tools) && fields.tools.some((tool) => object(tool)?.type === "function"));
  if (openAi) return false;
  return (
    "system" in fields ||
    "anthropic_version" in fields ||
    "stop_sequences" in fields ||
    (Array.isArray(fields.tools) &&
      fields.tools.some((tool) => "input_schema" in (object(tool) ?? {}))) ||
    messages.some(
      (message) =>
        Array.isArray(message?.content) &&
        message.content.some((block) => ANTHROPIC_BLOCKS.has(text(object(block)?.type) ?? "")),
    )
  );
}

export const openaiChat: ImportAdapter = {
  id: "openai_chat",
  manifestFormat: "otlp_json",
  detect: (value) => isChatRequest(value) && !anthropicRequest(value),
  convert(value, context) {
    convertTranscript(value, context, (fields) => {
      const request = fields as JsonObject;
      const user = openAiUser(request);
      return {
        record: request,
        history: request.messages as JsonValue[],
        ...(text(request.model) ? { model: text(request.model)! } : {}),
        ...(request.tools !== undefined ? { tools: request.tools } : {}),
        ...(user !== undefined ? { user } : {}),
      };
    });
  },
};

// --- Anthropic Messages ----------------------------------------------------------------------

const isAnthropicResponse = (value: unknown): boolean => {
  const fields = object(value);
  return (
    !!fields &&
    fields.type === "message" &&
    fields.role === "assistant" &&
    Array.isArray(fields.content) &&
    typeof fields.model === "string"
  );
};

/** Tool use ids whose result block says `is_error`. */
function failedToolUses(messages: readonly JsonValue[]): Set<string> {
  const failed = new Set<string>();
  for (const message of messages) {
    const content = object(message)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content.map(object))
      if (block?.type === "tool_result" && block.is_error === true && text(block.tool_use_id))
        failed.add(text(block.tool_use_id)!);
  }
  return failed;
}

export const anthropicMessages: ImportAdapter = {
  id: "anthropic_messages",
  manifestFormat: "otlp_json",
  detect: (value) =>
    isAnthropicResponse(value) || (isChatRequest(value) && anthropicRequest(value)),
  convert(value, context) {
    convertTranscript(
      value,
      context,
      (fields) => {
        const message = fields as JsonObject;
        if (isAnthropicResponse(message))
          return {
            record: message,
            history: [],
            answer: {
              items: [message],
              record: message,
              model: text(message.model),
              usage: responseUsage(message.usage),
            },
          };
        const messages = message.messages as JsonValue[];
        const user = identityText(object(message.metadata)?.user_id);
        const system = systemParts(message.system);
        return {
          record: message,
          history: messages,
          ...(text(message.model) ? { model: text(message.model)! } : {}),
          ...(system !== undefined ? { system } : {}),
          ...(message.tools !== undefined ? { tools: message.tools } : {}),
          ...(user !== undefined ? { user } : {}),
          failed: failedToolUses(messages),
        };
      },
      (fields) => (isAnthropicResponse(fields) ? text(fields.id) : undefined),
    );
  },
};

// --- OpenAI Responses ------------------------------------------------------------------------

const isResponseObject = (value: unknown): boolean => {
  const fields = object(value);
  return !!fields && fields.object === "response" && Array.isArray(fields.output);
};

/** The fields of a Responses API request, and the answer (`output`, `usage`) logged beside it.
 * `input` and `output` are common names, so a value with any other field is left to the format
 * that owns it. */
const RESPONSES_REQUEST_FIELDS = new Set([
  "access_programs",
  "background",
  "context_management",
  "conversation",
  "include",
  "input",
  "instructions",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "model",
  "moderation",
  "parallel_tool_calls",
  "previous_response_id",
  "prompt",
  "prompt_cache_key",
  "prompt_cache_options",
  "prompt_cache_retention",
  "reasoning",
  "safety_identifier",
  "service_tier",
  "store",
  "stream",
  "stream_options",
  "temperature",
  "text",
  "tool_choice",
  "tools",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "output",
  "usage",
]);

/** A request (`input`), with the answer beside it (`output`) when it was logged too. */
const isResponsesRequest = (value: unknown): boolean => {
  const fields = object(value);
  if (!fields || !Object.keys(fields).every((key) => RESPONSES_REQUEST_FIELDS.has(key)))
    return false;
  return (
    (isItemList(fields.input) &&
      (fields.output === undefined || fields.output === null || isItemList(fields.output))) ||
    (typeof fields.input === "string" && isItemList(fields.output))
  );
};

/** A Responses conversation id: `conversation` as an id or `{id}`. */
const conversationOf = (fields: JsonObject) =>
  identityText(fields.conversation) ?? identityText(object(fields.conversation)?.id);

export const openaiResponses: ImportAdapter = {
  id: "openai_responses",
  manifestFormat: "otlp_json",
  detect: (value) => isResponseObject(value) || isResponsesRequest(value) || isItemList(value),
  convert(value, context) {
    convertTranscript(
      value,
      context,
      (read) => {
        if (Array.isArray(read)) return { record: read, history: read };
        const fields = read;
        const user = openAiUser(fields);
        const session = conversationOf(fields);
        const system = systemParts(fields.instructions);
        const failed = fields.status === "failed";
        const error = object(fields.error);
        const output = Array.isArray(fields.output) ? fields.output : undefined;
        const input =
          fields.input === undefined || fields.input === null
            ? []
            : typeof fields.input === "string"
              ? [{ role: "user", content: fields.input }]
              : fields.input;
        if (!Array.isArray(input)) throw new ConversionError("input is not a list of items");
        return {
          record: fields,
          history: input,
          ...(output
            ? {
                answer: {
                  items: output,
                  record: output,
                  ...(isResponseObject(fields) && text(fields.model)
                    ? { model: text(fields.model)! }
                    : {}),
                  usage: responseUsage(fields.usage),
                  ...(typeof fields.created_at === "number"
                    ? { start: nanosFrom(fields.created_at, "s") }
                    : {}),
                  ...(error || failed
                    ? {
                        error: {
                          ...(text(error?.message) ? { message: text(error?.message)! } : {}),
                          ...(text(error?.code) ? { type: text(error?.code)! } : {}),
                        },
                      }
                    : {}),
                },
              }
            : {}),
          ...(!isResponseObject(fields) && text(fields.model)
            ? { model: text(fields.model)! }
            : {}),
          ...(system !== undefined ? { system } : {}),
          ...(fields.tools !== undefined ? { tools: fields.tools } : {}),
          ...(user !== undefined ? { user } : {}),
          ...(session !== undefined ? { session } : {}),
        };
      },
      (fields) => (isResponseObject(fields) ? text(fields.id) : undefined),
    );
  },
};
