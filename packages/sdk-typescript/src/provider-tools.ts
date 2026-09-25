import type { HostedToolProvider } from "./types.js";
import { MAX_CONTENT_BYTES } from "./config.js";
import { scrubCredentialText } from "./tool-definitions.js";

// Provider-executed ("hosted") tool calls found in a model provider's response: OpenAI Responses
// output items and Anthropic Messages content blocks. The provider ran these tools itself, so no
// client-side `hue.tool()` call saw them; `HueClient.recordProviderToolCalls` turns them into
// `execute_tool` spans of type `extension` after the fact.

/** One provider-executed tool call. `arguments`, `result` and `errorText` are content. */
export interface HostedToolCall {
  name: string;
  callId?: string;
  /** 0-based position of the call's item in the response: the OpenAI `output` index or the
   * Anthropic `content` block index. */
  position: number;
  /** The provider's label (OpenAI `server_label`) or name (Anthropic `server_name`) for the MCP server. */
  server?: string;
  arguments?: unknown;
  result?: unknown;
  /** Low-cardinality failure marker for `error.type`; absent when the call succeeded. */
  errorType?: string;
  /** The provider's own error text for a failed OpenAI MCP call, unscrubbed and unbounded. */
  errorText?: string;
}

/** One `mcp_list_tools` result: the tools a hosted MCP server offered. */
export interface HostedToolListing {
  server: string;
  /** Tool definitions in the OpenTelemetry GenAI shape (`type`, `name`, `description`, `parameters`). */
  definitions: Record<string, unknown>[];
  errorType?: string;
}

export interface HostedToolActivity {
  calls: HostedToolCall[];
  listings: HostedToolListing[];
  /** Items that looked like hosted calls but could not be read. */
  skipped: number;
}

type Item = Record<string, unknown>;
const MAX_PROVIDER_ITEMS = 128;
const MAX_PROVIDER_DEFINITIONS = 512;
const MAX_PROVIDER_SERVERS = 512;

function isItem(value: unknown): value is Item {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Only provider-executed tool items contribute to invalid-item diagnostics when a response is
 * truncated; messages and reasoning are harmless response content. */
function isProviderToolItem(provider: HostedToolProvider, value: unknown): boolean {
  if (!isItem(value) || typeof value.type !== "string") return false;
  if (provider === "openai")
    return (
      value.type === "mcp_call" ||
      value.type === "mcp_list_tools" ||
      value.type === "web_search_call" ||
      value.type === "file_search_call" ||
      value.type === "code_interpreter_call"
    );
  return value.type === "mcp_tool_use" || value.type === "server_tool_use";
}

function countProviderToolItems(provider: HostedToolProvider, items: unknown[], start = 0): number {
  let keys: string[];
  try {
    keys = Object.keys(items);
  } catch {
    // A tail that cannot be listed still holds at least one item nothing could read.
    return 1;
  }
  let count = 0;
  for (const key of keys) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < start || index >= items.length || String(index) !== key)
      continue;
    try {
      if (isProviderToolItem(provider, items[index])) count++;
    } catch {
      // A tail item whose `type` cannot be read counts as skipped; the bounded prefix is still
      // recorded, as the Python SDK does.
      count++;
    }
  }
  return count;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= 256 &&
    !value.includes("\u0000") &&
    value.isWellFormed()
    ? value
    : undefined;
}

function errorCode(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value) ? value : "error";
}

/** The most of a provider's error text scrubbed, and the most exported, in code points. */
const MAX_ERROR_SCAN = 16_384;
const MAX_ERROR_TEXT = 1_024;

/** The first `count` code points of `text`. */
function codePoints(text: string, count: number): { text: string; cut: boolean } {
  let kept = "";
  let seen = 0;
  for (const character of text) {
    if (seen++ === count) return { text: kept, cut: true };
    kept += character;
  }
  return { text: kept, cut: false };
}

/**
 * A provider's error text as a failed call exports it under content capture: credentials
 * scrubbed first, then at most 1,024 code points with `…` marking a cut, lone surrogates
 * replaced and NUL removed. The Python SDK produces the same text.
 */
export function providerErrorDescription(value: string): string {
  const scanned = codePoints(value.toWellFormed().replaceAll("\u0000", ""), MAX_ERROR_SCAN);
  const bounded = codePoints(scrubCredentialText(scanned.text), MAX_ERROR_TEXT);
  return bounded.cut || scanned.cut ? `${bounded.text}…` : bounded.text;
}

/** An OpenAI MCP call's `error`: its text, or an error object's string `message`. */
function errorText(value: unknown): string | undefined {
  const message = isItem(value) ? value.message : value;
  return typeof message === "string" && message.trim() !== "" ? message : undefined;
}

/** MCP arguments arrive as a JSON string; record the structure when it parses, else the text. */
function jsonArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (Buffer.byteLength(value, "utf8") > MAX_CONTENT_BYTES) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** OpenAI Responses `output` items. Built-in tools are named by their kind; MCP calls by tool. */
function openaiCalls(items: unknown[], activity: HostedToolActivity): void {
  const count = Math.min(items.length, MAX_PROVIDER_ITEMS);
  activity.skipped += countProviderToolItems("openai", items, count);
  for (let index = 0; index < count; index++) {
    try {
      openaiItem(items[index], index, activity);
    } catch {
      // An item that cannot be read is skipped; the others are still recorded.
      activity.skipped++;
    }
  }
}

function openaiItem(item: unknown, position: number, activity: HostedToolActivity): void {
  if (!isItem(item)) return;
  const callId = text(item.id);
  switch (item.type) {
    case "mcp_call": {
      const name = text(item.name);
      if (!name) {
        activity.skipped++;
        break;
      }
      const failed = item.error !== undefined && item.error !== null;
      const detail = failed ? errorText(item.error) : undefined;
      activity.calls.push({
        name,
        callId,
        position,
        server: text(item.server_label),
        arguments: jsonArguments(item.arguments),
        ...(item.output !== undefined && item.output !== null ? { result: item.output } : {}),
        ...(failed ? { errorType: "mcp_error" } : {}),
        ...(detail !== undefined ? { errorText: detail } : {}),
      });
      break;
    }
    case "mcp_list_tools": {
      const server = text(item.server_label);
      if (!server || !Array.isArray(item.tools)) {
        activity.skipped++;
        break;
      }
      const definitions: Record<string, unknown>[] = [];
      const definitionCount = Math.min(item.tools.length, MAX_PROVIDER_DEFINITIONS);
      activity.skipped += item.tools.length - definitionCount;
      for (let index = 0; index < definitionCount; index++) {
        try {
          const tool: unknown = item.tools[index];
          if (!isItem(tool)) continue;
          definitions.push({
            type: "function",
            ...(tool.name !== undefined ? { name: tool.name } : {}),
            ...(tool.description !== undefined ? { description: tool.description } : {}),
            ...(tool.input_schema !== undefined ? { parameters: tool.input_schema } : {}),
            ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
          });
        } catch {
          // A definition that cannot be read is skipped; the rest of the listing is kept.
          activity.skipped++;
        }
      }
      activity.listings.push({
        server,
        definitions,
        ...(item.error !== undefined && item.error !== null ? { errorType: "mcp_error" } : {}),
      });
      break;
    }
    case "web_search_call":
    case "file_search_call":
    case "code_interpreter_call": {
      const name = item.type.slice(0, -"_call".length);
      const failed = item.status === "failed" ? { errorType: "failed" } : {};
      if (item.type === "web_search_call")
        activity.calls.push({ name, callId, position, arguments: item.action, ...failed });
      else if (item.type === "file_search_call")
        activity.calls.push({
          name,
          callId,
          position,
          arguments: { queries: item.queries },
          ...(item.results !== undefined && item.results !== null ? { result: item.results } : {}),
          ...failed,
        });
      else
        activity.calls.push({
          name,
          callId,
          position,
          arguments: { code: item.code, container_id: item.container_id },
          ...(item.outputs !== undefined && item.outputs !== null ? { result: item.outputs } : {}),
          ...failed,
        });
      break;
    }
    default:
      // Messages, reasoning, approval requests and other items are not executed tools.
      break;
  }
}

/** Anthropic Messages `content` blocks: a use block paired with the result block that names it. */
function anthropicCalls(blocks: unknown[], activity: HostedToolActivity): void {
  const results = new Map<string, Item>();
  const count = Math.min(blocks.length, MAX_PROVIDER_ITEMS);
  const truncated = blocks.length > MAX_PROVIDER_ITEMS;
  activity.skipped += countProviderToolItems("anthropic", blocks, count);
  // Each block is read once; one that cannot be read is skipped and the rest still recorded.
  const readable: unknown[] = [];
  for (let index = 0; index < count; index++) {
    try {
      const block = blocks[index];
      if (
        isItem(block) &&
        typeof block.type === "string" &&
        block.type.endsWith("_tool_result") &&
        typeof block.tool_use_id === "string"
      )
        results.set(block.tool_use_id, block);
      readable.push(block);
    } catch {
      activity.skipped++;
      readable.push(undefined);
    }
  }
  for (let index = 0; index < count; index++) {
    try {
      anthropicBlock(readable[index], index, results, truncated, activity);
    } catch {
      activity.skipped++;
    }
  }
}

function anthropicBlock(
  block: unknown,
  position: number,
  results: Map<string, Item>,
  truncated: boolean,
  activity: HostedToolActivity,
): void {
  if (!isItem(block) || (block.type !== "mcp_tool_use" && block.type !== "server_tool_use")) return;
  const name = text(block.name);
  const callId = text(block.id);
  if (!name) {
    activity.skipped++;
    return;
  }
  const result = callId === undefined ? undefined : results.get(callId);
  // When the response was truncated, an unmatched use block may have its result outside the
  // bounded prefix. Do not export it as a successful call with a missing result.
  if (truncated && result === undefined) {
    activity.skipped++;
    return;
  }
  const content = result?.content;
  let errorType: string | undefined;
  if (result?.is_error === true) errorType = "mcp_error";
  else if (isItem(content) && typeof content.type === "string" && content.type.endsWith("_error"))
    errorType = errorCode(content.error_code);
  activity.calls.push({
    name,
    callId,
    position,
    ...(block.type === "mcp_tool_use" ? { server: text(block.server_name) } : {}),
    arguments: block.input,
    ...(content !== undefined ? { result: content } : {}),
    ...(errorType ? { errorType } : {}),
  });
}

/**
 * Reads the hosted tool calls out of a provider response: the `output` items of an OpenAI
 * Responses API response, or the `content` blocks of an Anthropic Messages API response. An array
 * is taken as those items directly. Anything else yields no calls.
 */
export function hostedToolActivity(
  provider: HostedToolProvider,
  response: unknown,
): HostedToolActivity {
  const activity: HostedToolActivity = { calls: [], listings: [], skipped: 0 };
  const items = Array.isArray(response)
    ? response
    : isItem(response)
      ? response[provider === "openai" ? "output" : "content"]
      : undefined;
  if (!Array.isArray(items)) return activity;
  if (provider === "openai") openaiCalls(items, activity);
  else anthropicCalls(items, activity);
  return activity;
}

/**
 * The host of each hosted MCP server's URL, by label, read from the request that produced the
 * response: OpenAI `tools[].server_url` by `server_label`, Anthropic `mcp_servers[].url` by `name`.
 * Nothing else in the request is read.
 */
export function hostedServerAddresses(
  provider: HostedToolProvider,
  request: unknown,
): Map<string, string> {
  const addresses = new Map<string, string>();
  if (!isItem(request)) return addresses;
  const entries = request[provider === "openai" ? "tools" : "mcp_servers"];
  if (!Array.isArray(entries)) return addresses;
  const count = Math.min(entries.length, MAX_PROVIDER_SERVERS);
  for (let index = 0; index < count; index++) {
    const entry = entries[index];
    if (!isItem(entry)) continue;
    const label = text(provider === "openai" ? entry.server_label : entry.name);
    const url = provider === "openai" ? entry.server_url : entry.url;
    if (!label || typeof url !== "string") continue;
    try {
      const { hostname } = new URL(url);
      if (hostname) addresses.set(label, hostname);
    } catch {
      // Not a URL; there is no address to record.
    }
  }
  return addresses;
}

/** The provider a `model()` call named, when this module can read its responses. */
export function hostedToolProvider(value: unknown): HostedToolProvider | undefined {
  const provider = typeof value === "string" ? value.toLowerCase() : undefined;
  return provider === "openai" || provider === "anthropic" ? provider : undefined;
}
