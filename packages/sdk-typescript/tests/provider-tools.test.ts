import { expect, test } from "bun:test";
import {
  hostedServerAddresses,
  hostedToolActivity,
  providerErrorDescription,
} from "../src/provider-tools.js";
import errorTexts from "./fixtures/provider-error-text.json" with { type: "json" };

/** An item whose `type` cannot be read, as a broken provider model can be. */
const raisingType = () =>
  Object.defineProperty({}, "type", {
    enumerable: true,
    get() {
      throw new Error("synthetic type failure");
    },
  });

test("bounds provider calls, rejects malformed labels, and does not parse oversized arguments", () => {
  const oversized = "{" + '"value":"' + "x".repeat(300_000) + '"}';
  const activity = hostedToolActivity("openai", {
    output: [
      { type: "mcp_call", id: "\u0000", name: "\ud800", server_label: "\ud800", arguments: "{}" },
      { type: "mcp_call", id: "call-1", name: "tool", arguments: oversized },
      ...Array.from({ length: 2_000 }, (_, index) => ({
        type: "mcp_call",
        id: `call-${index + 2}`,
        name: "tool",
        arguments: "{}",
      })),
    ],
  });
  expect(activity.calls).toHaveLength(127);
  expect(activity.calls[0]).toEqual({
    name: "tool",
    callId: "call-1",
    position: 1,
    arguments: undefined,
  });
  expect(activity.skipped).toBeGreaterThan(1_800);
});

test("bounds hosted tool definitions per listing", () => {
  const activity = hostedToolActivity("openai", {
    output: [
      {
        type: "mcp_list_tools",
        server_label: "synthetic",
        tools: Array.from({ length: 2_000 }, (_, index) => ({ name: `tool-${index}` })),
      },
    ],
  });
  expect(activity.listings[0]?.definitions).toHaveLength(512);
  expect(activity.skipped).toBe(1_488);
});

test("does not export an Anthropic use block without its bounded result", () => {
  const activity = hostedToolActivity("anthropic", {
    content: [
      { type: "mcp_tool_use", id: "call-0", name: "tool", input: {} },
      ...Array.from({ length: 127 }, (_, index) => ({
        type: "mcp_tool_result",
        tool_use_id: `result-${index}`,
        content: { type: "text", text: "ok" },
      })),
      { type: "mcp_tool_result", tool_use_id: "call-0", content: { type: "text", text: "ok" } },
    ],
  });
  expect(activity.calls).toEqual([]);
  expect(activity.skipped).toBe(1);
});

test("does not count truncated messages and reasoning as invalid provider tools", () => {
  const activity = hostedToolActivity("openai", {
    output: [
      ...Array.from({ length: 256 }, () => ({ type: "message", content: [] })),
      { type: "mcp_call", id: "call-after-content", name: "tool", arguments: "{}" },
    ],
  });
  expect(activity.calls).toEqual([]);
  expect(activity.skipped).toBe(1);
});

test("does not count an Anthropic text tail as provider tools", () => {
  const activity = hostedToolActivity("anthropic", {
    content: [
      ...Array.from({ length: 256 }, () => ({ type: "text", text: "harmless response" })),
      { type: "mcp_tool_use", id: "late", name: "tool", input: {} },
    ],
  });
  expect(activity.calls).toEqual([]);
  expect(activity.skipped).toBe(1);
});

test("counts sparse provider tails without scanning array holes", () => {
  const output: unknown[] = [];
  output.length = 2 ** 32 - 1;
  output[2 ** 32 - 2] = { type: "mcp_call", id: "late", name: "tool" };
  const activity = hostedToolActivity("openai", { output });
  expect(activity.calls).toEqual([]);
  expect(activity.skipped).toBe(1);
});

test("bounds Anthropic error codes to safe metadata labels", () => {
  const activity = hostedToolActivity("anthropic", {
    content: [
      { type: "mcp_tool_use", id: "call", name: "tool", input: {} },
      {
        type: "mcp_tool_result",
        tool_use_id: "call",
        content: { type: "mcp_tool_result_error", error_code: "SECRET-" + "x".repeat(256) },
      },
    ],
  });
  expect(activity.calls[0]?.errorType).toBe("error");
});

test("a tail item whose type cannot be read does not discard the bounded prefix", () => {
  const openai = hostedToolActivity("openai", {
    output: [
      ...Array.from({ length: 128 }, (_, index) => ({
        type: "mcp_call",
        id: `call-${index}`,
        name: "tool",
      })),
      raisingType(),
    ],
  });
  expect(openai.calls).toHaveLength(128);
  expect(openai.skipped).toBe(1);
  const anthropic = hostedToolActivity("anthropic", {
    content: [
      ...Array.from({ length: 64 }, (_, index) => [
        { type: "server_tool_use", id: `call-${index}`, name: "tool" },
        {
          type: "server_tool_result",
          tool_use_id: `call-${index}`,
          content: { type: "text", text: "ok" },
        },
      ]).flat(),
      raisingType(),
    ],
  });
  expect(anthropic.calls).toHaveLength(64);
  expect(anthropic.skipped).toBe(1);
});

test("an unreadable item in the bounded prefix is skipped and the rest recorded", () => {
  const openai = hostedToolActivity("openai", {
    output: [raisingType(), { type: "mcp_call", id: "call-1", name: "tool" }],
  });
  expect(openai.calls.map((call) => [call.callId, call.position])).toEqual([["call-1", 1]]);
  expect(openai.skipped).toBe(1);
  const unreadableTool = Object.defineProperty({}, "name", {
    enumerable: true,
    get() {
      throw new Error("synthetic name failure");
    },
  });
  const listing = hostedToolActivity("openai", {
    output: [
      {
        type: "mcp_list_tools",
        server_label: "gmail",
        tools: [unreadableTool, { name: "search" }],
      },
    ],
  });
  expect(listing.listings[0]?.definitions).toEqual([{ type: "function", name: "search" }]);
  expect(listing.skipped).toBe(1);
  const anthropic = hostedToolActivity("anthropic", {
    content: [
      raisingType(),
      { type: "server_tool_use", id: "call-1", name: "web_search", input: {} },
      { type: "web_search_tool_result", tool_use_id: "call-1", content: [] },
    ],
  });
  expect(anthropic.calls.map((call) => [call.callId, call.position])).toEqual([["call-1", 1]]);
  expect(anthropic.skipped).toBe(1);
});

test("each call carries its item's 0-based position in the response", () => {
  const openai = hostedToolActivity("openai", {
    output: [
      { type: "reasoning", summary: [] },
      { type: "mcp_list_tools", server_label: "gmail", tools: [] },
      { type: "mcp_call", id: "mcp-1", name: "search", server_label: "gmail" },
      { type: "message", content: [] },
      { type: "web_search_call", id: "ws-1", action: {} },
      { type: "mcp_call", id: "mcp-2", name: "create", server_label: "gmail" },
    ],
  });
  expect(openai.calls.map((call) => [call.callId, call.position])).toEqual([
    ["mcp-1", 2],
    ["ws-1", 4],
    ["mcp-2", 5],
  ]);
  const anthropic = hostedToolActivity("anthropic", {
    content: [
      { type: "text", text: "Looking" },
      { type: "server_tool_use", id: "srv-1", name: "web_search", input: {} },
      { type: "web_search_tool_result", tool_use_id: "srv-1", content: [] },
      { type: "mcp_tool_use", id: "mcp-1", name: "post", server_name: "slack", input: {} },
      { type: "mcp_tool_result", tool_use_id: "mcp-1", content: [] },
    ],
  });
  expect(anthropic.calls.map((call) => [call.callId, call.position])).toEqual([
    ["srv-1", 1],
    ["mcp-1", 3],
  ]);
});

test("a failed MCP call keeps the provider's error text, from a string or an error object", () => {
  const activity = hostedToolActivity("openai", {
    output: [
      { type: "mcp_call", id: "a", name: "tool", error: "Rate limited" },
      { type: "mcp_call", id: "b", name: "tool", error: { message: "Denied", code: 403 } },
      { type: "mcp_call", id: "c", name: "tool", error: { code: 500 } },
      { type: "mcp_call", id: "d", name: "tool", error: "   " },
    ],
  });
  expect(activity.calls.map((call) => [call.errorType, call.errorText])).toEqual([
    ["mcp_error", "Rate limited"],
    ["mcp_error", "Denied"],
    ["mcp_error", undefined],
    ["mcp_error", undefined],
  ]);
});

test("error text is scrubbed of credentials and bounded, identically to the Python SDK", () => {
  for (const { input, expected } of errorTexts.cases)
    expect(providerErrorDescription(input)).toBe(expected);
  expect(providerErrorDescription("x".repeat(1_100))).toBe(`${"x".repeat(1_024)}…`);
  expect(providerErrorDescription("x".repeat(1_024))).toBe("x".repeat(1_024));
  // Scrubbed before the cut: a credential that straddles the bound never shows a prefix.
  const straddling = providerErrorDescription(`${"a".repeat(1_015)} token=synthetic-secret-value`);
  expect(straddling).not.toContain("synthetic");
  expect(straddling.endsWith("…")).toBe(true);
  expect([...providerErrorDescription(`${"😀".repeat(1_030)}`)]).toHaveLength(1_025);
});

test("server.address keeps an underscore in a host name, as WHATWG URL parsing does", () => {
  expect(
    Object.fromEntries(
      hostedServerAddresses("openai", {
        tools: [
          { server_label: "compose", server_url: "http://mcp_server:8080/sse" },
          { server_label: "internal", server_url: "https://mcp_gateway.internal.example/mcp" },
        ],
      }),
    ),
  ).toEqual({ compose: "mcp_server", internal: "mcp_gateway.internal.example" });
});
