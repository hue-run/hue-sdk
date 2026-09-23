import type { HostedToolProvider } from "./types.js";

// Provider-executed ("hosted") tool calls found in a model provider's response: OpenAI Responses
// output items and Anthropic Messages content blocks. The provider ran these tools itself, so no
// client-side `hue.tool()` call saw them; `HueClient.recordProviderToolCalls` turns them into
// `execute_tool` spans of type `extension` after the fact.

/** One provider-executed tool call. `arguments` and `result` are content. */
export interface HostedToolCall {
  name: string;
  callId?: string;
  /** The provider's label (OpenAI `server_label`) or name (Anthropic `server_name`) for the MCP server. */
  server?: string;
  arguments?: unknown;
  result?: unknown;
  /** Low-cardinality failure marker for `error.type`; absent when the call succeeded. */
  errorType?: string;
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

function isItem(value: unknown): value is Item {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" && value.length <= 256
    ? value
    : undefined;
}

/** MCP arguments arrive as a JSON string; record the structure when it parses, else the text. */
function jsonArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** OpenAI Responses `output` items. Built-in tools are named by their kind; MCP calls by tool. */
function openaiCalls(items: unknown[], activity: HostedToolActivity): void {
  for (const item of items) {
    if (!isItem(item)) continue;
    const callId = text(item.id);
    switch (item.type) {
      case "mcp_call": {
        const name = text(item.name);
        if (!name) {
          activity.skipped++;
          break;
        }
        activity.calls.push({
          name,
          callId,
          server: text(item.server_label),
          arguments: jsonArguments(item.arguments),
          ...(item.output !== undefined && item.output !== null ? { result: item.output } : {}),
          ...(item.error !== undefined && item.error !== null ? { errorType: "mcp_error" } : {}),
        });
        break;
      }
      case "mcp_list_tools": {
        const server = text(item.server_label);
        if (!server || !Array.isArray(item.tools)) {
          activity.skipped++;
          break;
        }
        activity.listings.push({
          server,
          definitions: item.tools.filter(isItem).map((tool) => ({
            type: "function",
            ...(tool.name !== undefined ? { name: tool.name } : {}),
            ...(tool.description !== undefined ? { description: tool.description } : {}),
            ...(tool.input_schema !== undefined ? { parameters: tool.input_schema } : {}),
            ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
          })),
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
          activity.calls.push({ name, callId, arguments: item.action, ...failed });
        else if (item.type === "file_search_call")
          activity.calls.push({
            name,
            callId,
            arguments: { queries: item.queries },
            ...(item.results !== undefined && item.results !== null
              ? { result: item.results }
              : {}),
            ...failed,
          });
        else
          activity.calls.push({
            name,
            callId,
            arguments: { code: item.code, container_id: item.container_id },
            ...(item.outputs !== undefined && item.outputs !== null
              ? { result: item.outputs }
              : {}),
            ...failed,
          });
        break;
      }
      default:
        // Messages, reasoning, approval requests and other items are not executed tools.
        break;
    }
  }
}

/** Anthropic Messages `content` blocks: a use block paired with the result block that names it. */
function anthropicCalls(blocks: unknown[], activity: HostedToolActivity): void {
  const results = new Map<string, Item>();
  for (const block of blocks)
    if (
      isItem(block) &&
      typeof block.type === "string" &&
      block.type.endsWith("_tool_result") &&
      typeof block.tool_use_id === "string"
    )
      results.set(block.tool_use_id, block);
  for (const block of blocks) {
    if (!isItem(block) || (block.type !== "mcp_tool_use" && block.type !== "server_tool_use"))
      continue;
    const name = text(block.name);
    const callId = text(block.id);
    if (!name) {
      activity.skipped++;
      continue;
    }
    const result = callId === undefined ? undefined : results.get(callId);
    const content = result?.content;
    let errorType: string | undefined;
    if (result?.is_error === true) errorType = "mcp_error";
    else if (isItem(content) && typeof content.type === "string" && content.type.endsWith("_error"))
      errorType = text(content.error_code) ?? "error";
    activity.calls.push({
      name,
      callId,
      ...(block.type === "mcp_tool_use" ? { server: text(block.server_name) } : {}),
      arguments: block.input,
      ...(content !== undefined ? { result: content } : {}),
      ...(errorType ? { errorType } : {}),
    });
  }
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
  for (const entry of entries) {
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
