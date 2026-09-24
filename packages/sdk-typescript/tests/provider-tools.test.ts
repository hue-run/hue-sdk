import { expect, test } from "bun:test";
import { hostedToolActivity } from "../src/provider-tools.js";

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
  expect(activity.skipped).toBe(2);
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
