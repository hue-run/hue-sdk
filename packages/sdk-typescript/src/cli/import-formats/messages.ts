import { isObject, parseNestedJsonText, type JsonValue } from "../traces-import-convert.js";

/**
 * Chat content as the OpenTelemetry GenAI conventions record it (`gen_ai.input.messages`,
 * `gen_ai.output.messages`): a list of `{role, parts}` messages whose parts are `text`,
 * `tool_call`, `tool_call_response`, `reasoning`, `blob` and `uri`, read from the shapes exports
 * commonly hold: OpenAI chat messages and choices, OpenAI Responses items, Anthropic content
 * blocks, LangChain messages and generations, Vercel AI SDK messages and plain strings. A part of
 * any other type is kept whole under its own `type`; content of no recognized shape converts to
 * nothing, and the emitter keeps it raw instead.
 */

type Part = { type: string } & { [key: string]: JsonValue };
export interface GenAiMessage {
  role: string;
  parts: Part[];
  name?: string;
  finish_reason?: string;
}

type JsonObject = { [key: string]: JsonValue };
const object = (value: JsonValue | undefined): JsonObject | undefined =>
  isObject(value) ? (value as JsonObject) : undefined;
const string = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

/** Tool call arguments as recorded: an OpenAI arguments string is read as the JSON it holds. */
function argumentsOf(value: JsonValue | undefined): JsonValue {
  if (typeof value === "string")
    try {
      return parseNestedJsonText(value).value as JsonValue;
    } catch {
      return value;
    }
  return value ?? null;
}

const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+)?((?:;[\w.+-]+=[^;,]*)*);base64,(.*)$/s;

/** An image, audio or file reference: a base64 data URL becomes a blob part, a URL a uri part. */
function mediaPart(url: string, modality: string): Part {
  const data = DATA_URL.exec(url);
  if (data)
    return {
      type: "blob",
      modality: data[1]?.split("/")[0] ?? modality,
      ...(data[1] ? { mime_type: data[1] } : {}),
      content: data[3]!,
    };
  return { type: "uri", modality, uri: url };
}

/** One content part of any recognized shape, or undefined when it is not one. */
function contentPart(raw: JsonValue): Part | undefined {
  if (typeof raw === "string") return { type: "text", content: raw };
  const part = object(raw);
  const type = string(part?.type);
  if (!part || !type) return undefined;
  switch (type) {
    case "text":
    case "input_text":
    case "output_text": {
      const content = string(part.text) ?? string(part.content);
      return content === undefined ? { ...part, type } : { type: "text", content };
    }
    case "image_url": {
      const url = string(object(part.image_url)?.url) ?? string(part.image_url);
      return url === undefined ? { ...part, type } : mediaPart(url, "image");
    }
    case "image": {
      const source = object(part.source);
      if (source?.type === "base64" && typeof source.data === "string")
        return {
          type: "blob",
          modality: "image",
          ...(typeof source.media_type === "string" ? { mime_type: source.media_type } : {}),
          content: source.data,
        };
      if (source?.type === "url" && typeof source.url === "string")
        return { type: "uri", modality: "image", uri: source.url };
      return { ...part, type };
    }
    case "tool_use":
      return {
        type: "tool_call",
        ...(typeof part.id === "string" ? { id: part.id } : {}),
        name: string(part.name) ?? "",
        arguments: part.input ?? null,
      };
    case "tool-call":
      return {
        type: "tool_call",
        ...(typeof part.toolCallId === "string" ? { id: part.toolCallId } : {}),
        name: string(part.toolName) ?? "",
        arguments: argumentsOf(part.input ?? part.args),
      };
    case "tool_result":
      return {
        type: "tool_call_response",
        ...(typeof part.tool_use_id === "string" ? { id: part.tool_use_id } : {}),
        response: part.content ?? null,
      };
    case "tool-result":
      return {
        type: "tool_call_response",
        ...(typeof part.toolCallId === "string" ? { id: part.toolCallId } : {}),
        response: part.output ?? part.result ?? null,
      };
    case "thinking":
      return { type: "reasoning", content: string(part.thinking) ?? "" };
    case "reasoning": {
      const content = string(part.text) ?? string(part.content);
      return content === undefined ? { ...part, type } : { type: "reasoning", content };
    }
    default:
      return { ...part, type };
  }
}

/** A message's content: a string, a list of parts or nothing; undefined when not readable. */
function contentParts(content: JsonValue | undefined): Part[] | undefined {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") return content ? [{ type: "text", content }] : [];
  if (!Array.isArray(content)) return undefined;
  const parts: Part[] = [];
  for (const item of content) {
    const part = contentPart(item);
    if (!part) return undefined;
    parts.push(part);
  }
  return parts;
}

/** OpenAI-shaped `tool_calls` (`{id, function: {name, arguments}}`) and LangChain's
 * (`{id, name, args}`) as tool call parts. */
function toolCallParts(calls: JsonValue | undefined): Part[] | undefined {
  if (calls === undefined || calls === null) return [];
  if (!Array.isArray(calls)) return undefined;
  const parts: Part[] = [];
  for (const raw of calls) {
    const call = object(raw);
    if (!call) return undefined;
    const fn = object(call.function);
    parts.push({
      type: "tool_call",
      ...(typeof call.id === "string" ? { id: call.id } : {}),
      name: string(fn?.name) ?? string(call.name) ?? "",
      arguments: fn ? argumentsOf(fn.arguments) : (call.args ?? null),
    });
  }
  return parts;
}

const LANGCHAIN_ROLES: Record<string, string> = {
  human: "user",
  user: "user",
  ai: "assistant",
  assistant: "assistant",
  system: "system",
  tool: "tool",
  function: "tool",
};
const LANGCHAIN_CLASSES: Record<string, string> = {
  HumanMessage: "human",
  HumanMessageChunk: "human",
  AIMessage: "ai",
  AIMessageChunk: "ai",
  SystemMessage: "system",
  ToolMessage: "tool",
  FunctionMessage: "function",
  ChatMessage: "chat",
};

/** A LangChain message (`{type, content}`, `{type, data}` or the serialized constructor form)
 * as role and fields, or undefined when it is not one. */
function langchain(message: JsonObject): { role: string; fields: JsonObject } | undefined {
  if (message.lc === 1 && Array.isArray(message.id) && object(message.kwargs)) {
    const kind = LANGCHAIN_CLASSES[string(message.id.at(-1)) ?? ""];
    const fields = object(message.kwargs)!;
    if (!kind) return undefined;
    const role = kind === "chat" ? string(fields.role) : LANGCHAIN_ROLES[kind];
    return role ? { role, fields } : undefined;
  }
  const type = string(message.type);
  if (!type || message.role !== undefined) return undefined;
  const fields = object(message.data) ?? message;
  if (!("content" in fields)) return undefined;
  const role = type === "chat" ? string(fields.role) : LANGCHAIN_ROLES[type];
  return role ? { role, fields } : undefined;
}

/** A tool's answer as one `tool_call_response` part. */
const responsePart = (id: JsonValue | undefined, response: JsonValue | undefined): Part => ({
  type: "tool_call_response",
  ...(typeof id === "string" ? { id } : {}),
  response: response ?? null,
});

/** One message of any recognized shape, or undefined. */
function message(raw: JsonValue): GenAiMessage | undefined {
  const item = object(raw);
  if (!item) return undefined;
  // An OpenAI choice: the message and why the model stopped.
  if (object(item.message) && ("finish_reason" in item || "index" in item)) {
    const inner = message(item.message!);
    const finish = string(item.finish_reason);
    return inner && finish ? { ...inner, finish_reason: finish } : inner;
  }
  // OpenAI Responses items.
  if (item.type === "function_call")
    return {
      role: "assistant",
      parts: [
        {
          type: "tool_call",
          ...(typeof item.call_id === "string" ? { id: item.call_id } : {}),
          name: string(item.name) ?? "",
          arguments: argumentsOf(item.arguments),
        },
      ],
    };
  if (item.type === "function_call_output")
    return { role: "tool", parts: [responsePart(item.call_id, item.output)] };
  if (item.type === "reasoning" && Array.isArray(item.summary)) {
    const text = item.summary.map((entry) => string(object(entry)?.text) ?? "").join("\n");
    return { role: "assistant", parts: [{ type: "reasoning", content: text }] };
  }
  const chain = langchain(item);
  if (chain) {
    const { role, fields } = chain;
    if (role === "tool")
      return { role, parts: [responsePart(fields.tool_call_id, fields.content)] };
    const parts = contentParts(fields.content);
    const calls = toolCallParts(fields.tool_calls);
    if (!parts || !calls) return undefined;
    return { role, parts: [...parts, ...calls], ...nameOf(fields) };
  }
  const role = string(item.role);
  if (!role) return undefined;
  // Already GenAI parts.
  if (
    Array.isArray(item.parts) &&
    item.parts.every((part) => typeof object(part)?.type === "string")
  )
    return { ...(item as unknown as GenAiMessage) };
  if (role === "tool" || role === "function")
    return {
      role: "tool",
      parts: [responsePart(item.tool_call_id, item.content)],
      ...nameOf(item),
    };
  const parts = contentParts(item.content);
  const calls = toolCallParts(item.tool_calls);
  if (!parts || !calls) return undefined;
  const legacy = object(item.function_call);
  if (legacy)
    calls.push({
      type: "tool_call",
      name: string(legacy.name) ?? "",
      arguments: argumentsOf(legacy.arguments),
    });
  const stop = string(item.stop_reason);
  return {
    role,
    parts: [...parts, ...calls],
    ...nameOf(item),
    ...(stop ? { finish_reason: stop } : {}),
  };
}

const nameOf = (fields: JsonObject) =>
  typeof fields.name === "string" && fields.name ? { name: fields.name } : {};

/**
 * `value` as GenAI messages, or undefined when it holds no recognized chat content. A plain
 * string is one message from `stringRole` when one is given; `{messages: […]}` and
 * `{choices: […]}` wrappers, LangChain's batched lists and `LLMResult` generations are unwrapped.
 */
export function genAiMessages(
  value: JsonValue | undefined,
  stringRole?: "user" | "assistant",
): GenAiMessage[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string")
    return stringRole && value
      ? [{ role: stringRole, parts: [{ type: "text", content: value }] }]
      : undefined;
  const wrapper = object(value);
  if (wrapper) {
    for (const key of ["messages", "choices"])
      if (Array.isArray(wrapper[key])) return genAiMessages(wrapper[key], stringRole);
    if (Array.isArray(wrapper.generations)) {
      const generations = wrapper.generations.flatMap((batch) =>
        Array.isArray(batch) ? batch : [batch],
      );
      const messages = generations.map((generation) => {
        const entry = object(generation);
        const inner = object(entry?.message);
        if (inner) return message(inner);
        const text = string(entry?.text);
        return text === undefined
          ? undefined
          : { role: "assistant", parts: [{ type: "text", content: text }] };
      });
      return messages.length && messages.every(Boolean) ? (messages as GenAiMessage[]) : undefined;
    }
    const single = message(wrapper);
    return single ? [single] : undefined;
  }
  if (!Array.isArray(value) || !value.length) return undefined;
  // LangChain records a batch of prompts as a list of message lists.
  if (value.length === 1 && Array.isArray(value[0])) return genAiMessages(value[0], stringRole);
  const messages: GenAiMessage[] = [];
  for (const raw of value) {
    const converted = message(raw);
    if (!converted) return undefined;
    messages.push(converted);
  }
  return messages;
}
