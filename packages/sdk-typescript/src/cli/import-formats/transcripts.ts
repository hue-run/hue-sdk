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
 * - `openai_responses`: a Responses API `response` object, a request (`{"input": …}`, text or a
 *   list of items and messages, with `output` beside it when the answer was logged with it), or a
 *   bare list of input and output items.
 * - `anthropic_messages`: a Messages API request (`{"messages": […], "system"?: …}`) or response
 *   (`{"type": "message", "role": "assistant", "content": […], "model": …}`).
 *
 * Each value is one trace: an `invoke_agent` span for the whole conversation, a `chat` span per
 * assistant turn (consecutive assistant messages or items are one turn) with the conversation so
 * far as its input, and an `execute_tool` span per tool call, paired with its result by
 * `tool_call_id`, `call_id` or `tool_use_id`: a result answers one call, the first unanswered one
 * under its id in the latest turn that made one, and fails it when the result says so (Anthropic
 * `is_error`). The agent's reply is a logged answer (a response object, or `output` beside a
 * request's `input`), which is the last turn and carries the token usage the source records, else
 * the last turn when the conversation ends with it. A conversation that goes on past its last
 * turn, and a Responses request logged with an empty `output`, is a request logged without its
 * reply: the agent's input is all of it, and it has no reply. A transcript whose turns together
 * repeat more than 64 MiB of conversation is refused.
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
 *   messages it was read from, and each tool call the block holding its result, else its call.
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

/** A request's `input` list: every element an item or a message. */
const isInputList = (value: unknown): value is JsonValue[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => isResponsesItem(item) || isEasyMessage(item));

/** A list of Responses items: every element an item or a message, at least one typed. */
const isItemList = (value: unknown): value is JsonValue[] =>
  isInputList(value) && value.some(isResponsesItem);

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
  if (isInputList(fields.input)) return chatItems(fields.input);
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
  /** Logged with an empty answer (a request's empty `output`), so the conversation has no reply,
   * whatever it ends with. */
  unanswered?: true;
}

interface Turn {
  /** Index of its first message in the conversation, and of the message after its last. */
  at: number;
  end: number;
  messages: GenAiMessage[];
}

/** What a transcript's turns may repeat together, as much as one file may decompress to: each
 * turn's span holds the conversation before it, so a long transcript repeats its early messages
 * once per turn. */
const MAX_REPEATED_BYTES = 64 * 1024 * 1024;

/** The block of a recorded message that a part was read from: the message when it holds the part
 * alone, else the element of its content or tool calls the part came from, else the part as read.
 * A tool span keeps its own call or result, never a whole message of parallel ones. */
function blockOf(raw: JsonValue, message: GenAiMessage, part: number): JsonValue {
  if (message.parts.length === 1) return raw;
  const fields = object(raw);
  const content = fields?.content;
  const legacy = object(fields?.function_call);
  const blocks = [
    ...(Array.isArray(content) ? content : content ? [content] : []),
    ...(Array.isArray(fields?.tool_calls) ? fields.tool_calls : []),
    ...(legacy ? [legacy] : []),
  ];
  return blocks.length === message.parts.length ? blocks[part]! : message.parts[part]!;
}

/** Whether the source marks a tool result as failed: an Anthropic `tool_result` block with
 * `is_error`, whose message's content blocks are its parts in order. */
function failedResult(raw: JsonValue, part: number): boolean {
  const content = object(raw)?.content;
  const block = Array.isArray(content) ? object(content[part]) : undefined;
  return block?.type === "tool_result" && block.is_error === true;
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
  // The conversation each turn repeats, measured before any of it is copied.
  const before = [0];
  for (const item of items) before.push(before.at(-1)! + Buffer.byteLength(JSON.stringify(item)));
  let repeated = answer ? before[items.length]! : 0;
  for (const turn of turns) repeated += before[turn.at]!;
  if (repeated > MAX_REPEATED_BYTES)
    throw new ConversionError(
      `a transcript whose turns together repeat more than ${MAX_REPEATED_BYTES} bytes of conversation`,
    );
  // Each tool result answers a call made before it under its id: the first unanswered one of the
  // latest turn that made one, a turn's calls in the order made, however many of its messages or
  // items hold them. No result answers two calls, and an id a later turn uses again is that
  // turn's. Results by the call's message and part, with the block that holds them.
  const turnOf = new Map<number, number>();
  for (const [number, turn] of turns.entries())
    for (let index = turn.at; index < turn.end; index++) turnOf.set(index, number);
  const results = new Map<string, { response: JsonValue; block: JsonValue; failed: boolean }>();
  const calls = new Map<string, { turn: number; slots: string[]; answered: number }>();
  for (const [index, message] of history.entries())
    for (const [at, part] of message.parts.entries()) {
      if (typeof part.id !== "string") continue;
      const made = calls.get(part.id);
      const turn = turnOf.get(index);
      if (part.type === "tool_call" && turn !== undefined) {
        if (made?.turn === turn) made.slots.push(`${index}.${at}`);
        else calls.set(part.id, { turn, slots: [`${index}.${at}`], answered: 0 });
      } else if (part.type === "tool_call_response" && made && made.answered < made.slots.length)
        results.set(made.slots[made.answered++]!, {
          response: part.response ?? null,
          block: blockOf(raw[index]!, message, at),
          failed: failedResult(raw[index]!, at),
        });
    }

  const model = transcript.model ?? transcript.answer?.model;
  const system = transcript.system;
  const last = turns.at(-1);
  // The reply is the logged answer, else the last turn when the conversation ends with it. A
  // conversation that goes on past its last turn, or has none, or was logged with an empty answer,
  // is a request logged without its reply: the agent's input is all of it.
  const replied =
    answerItems !== undefined || (!transcript.unanswered && last?.end === history.length);
  const input = replied ? items.slice(0, turns[0]?.at ?? history.length) : items;
  const reply = answerItems ?? (replied && last ? items.slice(last.at, last.end) : undefined);
  const rows: SpanRow[] = [
    {
      traceKey,
      spanKey: "agent",
      name: "invoke_agent",
      kind: "agent",
      ...(input.length ? { input } : {}),
      ...(reply?.length ? { output: reply } : {}),
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
    output: {
      items: JsonValue[];
      raw: JsonValue[];
      messages: GenAiMessage[];
      record: JsonValue;
      /** Where its first message sits in the conversation, for a turn of it. */
      at?: number;
    },
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
      for (const [at, part] of message.parts.entries()) {
        if (part.type !== "tool_call") continue;
        const id = typeof part.id === "string" ? part.id : undefined;
        const name = typeof part.name === "string" && part.name ? part.name : "tool";
        const result =
          output.at === undefined ? undefined : results.get(`${output.at + index}.${at}`);
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
          ...(result?.failed ? { error: {} } : {}),
          record: result?.block ?? blockOf(output.raw[index]!, message, at),
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
        at: turn.at,
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

/** A request's `output` that holds no answer: absent, null or an empty list. */
const noOutput = (output: JsonValue | undefined) =>
  output === undefined || output === null || (Array.isArray(output) && !output.length);

/** A request (`input`: text, or items and messages), with the answer beside it (`output`) when
 * it was logged too. */
const isResponsesRequest = (value: unknown): boolean => {
  const fields = object(value);
  if (!fields || !Object.keys(fields).every((key) => RESPONSES_REQUEST_FIELDS.has(key)))
    return false;
  return (
    (typeof fields.input === "string" || isInputList(fields.input)) &&
    (noOutput(fields.output) || isItemList(fields.output))
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
        // A response object's output is its answer, an empty one too (a failed response); a
        // request's empty output is no answer.
        const output =
          Array.isArray(fields.output) && (isResponseObject(fields) || !noOutput(fields.output))
            ? fields.output
            : undefined;
        const unanswered = !isResponseObject(fields) && "output" in fields && !output;
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
          ...(unanswered ? { unanswered: true } : {}),
        };
      },
      (fields) => (isResponseObject(fields) ? text(fields.id) : undefined),
    );
  },
};
