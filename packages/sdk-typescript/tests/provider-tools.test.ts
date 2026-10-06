import { expect, test } from "bun:test";
import {
  hostedServerAddresses,
  hostedToolActivity,
  providerErrorDescription,
} from "../src/provider-tools.js";
import {
  scrubCredentialText,
  scrubCredentialTextUnbounded,
  toolCatalogSummary,
} from "../src/tool-definitions.js";
import errorTexts from "./fixtures/provider-error-text.json" with { type: "json" };
import listingDigest from "./fixtures/provider-tool-listing.json" with { type: "json" };
import plantedSecrets from "./fixtures/planted-secrets.json" with { type: "json" };

/** The provider items one response is read for; later items are counted as skipped. */
const ITEMS = 1024;

/** An item whose `type` cannot be read, as a broken provider model can be. */
const raisingType = () =>
  Object.defineProperty({}, "type", {
    enumerable: true,
    get() {
      throw new Error("synthetic type failure");
    },
  });

test("bounds provider calls, rejects malformed labels, and does not parse oversized arguments", () => {
  // Over the 1 MiB value cap, so it is not parsed.
  const oversized = "{" + '"value":"' + "x".repeat(1_100_000) + '"}';
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
  expect(activity.calls).toHaveLength(ITEMS - 1);
  expect(activity.calls[0]).toEqual({
    name: "tool",
    callId: "call-1",
    position: 1,
    arguments: undefined,
  });
  expect(activity.skipped).toBe(2_002 - ITEMS + 1);
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
      ...Array.from({ length: ITEMS - 1 }, (_, index) => ({
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
      ...Array.from({ length: 2 * ITEMS }, () => ({ type: "message", content: [] })),
      { type: "mcp_call", id: "call-after-content", name: "tool", arguments: "{}" },
    ],
  });
  expect(activity.calls).toEqual([]);
  expect(activity.skipped).toBe(1);
});

test("does not count an Anthropic text tail as provider tools", () => {
  const activity = hostedToolActivity("anthropic", {
    content: [
      ...Array.from({ length: 2 * ITEMS }, () => ({ type: "text", text: "harmless response" })),
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
      ...Array.from({ length: ITEMS }, (_, index) => ({
        type: "mcp_call",
        id: `call-${index}`,
        name: "tool",
      })),
      raisingType(),
    ],
  });
  expect(openai.calls).toHaveLength(ITEMS);
  expect(openai.skipped).toBe(1);
  const anthropic = hostedToolActivity("anthropic", {
    content: [
      ...Array.from({ length: ITEMS / 2 }, (_, index) => [
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
  expect(anthropic.calls).toHaveLength(ITEMS / 2);
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

test("an error whose message cannot be read still fails its call, without text", () => {
  const error = Object.defineProperty({}, "message", {
    enumerable: true,
    get() {
      throw new Error("synthetic message failure");
    },
  });
  const activity = hostedToolActivity("openai", {
    output: [{ type: "mcp_call", id: "mcp-1", name: "search", server_label: "s", error }],
  });
  expect(activity.skipped).toBe(0);
  expect(activity.calls).toEqual([
    expect.objectContaining({ name: "search", position: 0, errorType: "mcp_error" }),
  ]);
  expect(activity.calls[0]).not.toHaveProperty("errorText");
});

test("a listing's null fields are left out, so both SDKs digest its catalog alike", () => {
  // The Python suite reads the same fixture and checks the same names and digest.
  const [listing] = hostedToolActivity("openai", listingDigest.response).listings;
  for (const definition of listing!.definitions)
    expect(Object.values(definition)).not.toContain(null);
  expect(toolCatalogSummary(JSON.stringify(listing!.definitions))).toEqual(listingDigest.expected);
});

test("error text is scrubbed of credentials and bounded, identically to the Python SDK", () => {
  for (const { input, expected } of errorTexts.cases)
    expect(providerErrorDescription(input)).toBe(expected);
  expect(providerErrorDescription("x".repeat(1_100))).toBe(`${"x".repeat(1_024)}…`);
  expect(providerErrorDescription("x".repeat(1_024))).toBe("x".repeat(1_024));
  // Scrubbed before the cut: the 1,024th code point falls inside `[redacted]`, never inside a
  // credential, where cutting first would leave its start to be scrubbed on its own.
  expect(providerErrorDescription(`${"a".repeat(1_015)} token=synthetic-secret-value`)).toBe(
    `${"a".repeat(1_015)} token=[r…`,
  );
  expect(providerErrorDescription(`${"a".repeat(1_010)} password="synthetic two words"`)).toBe(
    `${"a".repeat(1_010)} password="[re…`,
  );
  expect([...providerErrorDescription(`${"😀".repeat(1_030)}`)]).toHaveLength(1_025);
});

test("what the 16,384-code-point scan cuts through is redacted to the cut, as in the Python SDK", () => {
  // The long value before it is scrubbed to `[redacted]`, so the text at the cut is exported.
  const lead = `token=${"x".repeat(16_000)} `;
  // `kept` ends where the scan cuts, and `rest` is past it; `exported` is what `kept` becomes.
  const expectCut = (kept: string, rest: string, exported: string) => {
    const filler = "y".repeat(16_384 - lead.length - kept.length - 1);
    expect(providerErrorDescription(`${lead}${filler} ${kept}${rest}`)).toBe(
      `token=[redacted] ${filler} ${exported}…`,
    );
  };
  expectCut('password="synthetic-first synth', 'etic-second"', 'password="[redacted]');
  expectCut("https://synthetic-us", "er:synthetic-pass@mcp.example.test/", "[redacted]");
  expectCut("see hue_sk_syn", "thetic0123456789", "see [redacted]");
  expectCut('headers={"Authorization": "Bot synth', 'etic"}', "headers=[redacted]");
  // Text the cut does not interrupt keeps its words.
  expectCut(
    "see https://mcp.example.test/sse next ",
    "words",
    "see https://mcp.example.test/sse next ",
  );
});

test("an escaped space ends a credential, so a run of them scrubs in linear time", () => {
  // Each `Bearer%20` starts a credential; were `%20` part of one, each would run to the end.
  const started = performance.now();
  const scrubbed = scrubCredentialTextUnbounded("Bearer%20".repeat(111_112));
  expect(scrubbed.startsWith("Bearer%20[redacted]%20[redacted]%20")).toBe(true);
  expect(scrubbed).not.toContain("Bearer%20Bearer");
  expect(performance.now() - started).toBeLessThan(5_000);
});

test("a bracketed value full of escaped quotes scrubs in linear time", () => {
  // A string between backslash-escaped quotes that a bare quote ends is read once, not again
  // from each escaped quote inside it.
  const started = performance.now();
  const text = String.raw`token: [\"${String.raw`\\\"`.repeat(50_000)}"`;
  expect(scrubCredentialTextUnbounded(text)).toBe("token: [redacted]");
  expect(performance.now() - started).toBeLessThan(5_000);
});

test("a URL of 500,000 escaped values is read to its end", () => {
  // A URL is read a piece at a time; as one repeated pattern, a URL this long made Bun's regular
  // expression engine (1.4) match nothing and leave it as it was, and a shorter one Bun 1.3's.
  const started = performance.now();
  const scrubbed = scrubCredentialTextUnbounded(
    `see https://h.example.test/?sig=synthetic-sig${'&a=\\"x\\"'.repeat(500_000)}`,
  );
  expect(
    scrubbed.startsWith("see https://h.example.test/?sig=%5Bredacted%5D&a=%5Bredacted%5D"),
  ).toBe(true);
  expect(scrubbed).not.toContain("synthetic-sig");
  expect(performance.now() - started).toBeLessThan(20_000);
});

test("a query full of `?` is read once for names holding a URL", () => {
  // A name starts at the query's `?` or an `&`; were every `?` a start, each would be read to the
  // end of the query.
  const started = performance.now();
  expect(scrubCredentialTextUnbounded(`https://h.example.test/?${"?".repeat(100_000)}`)).toContain(
    "https://h.example.test/?",
  );
  expect(performance.now() - started).toBeLessThan(5_000);
});

test("a text longer than 16,384 code points is scrubbed to there and cut", () => {
  // An escaped value this long in a URL is past what Bun's regular expression engine reads, which
  // then matched nothing and left the value as it was.
  const scrubbed = scrubCredentialText(
    `see https://h.example.test/?t=\\"synthetic-long-value${"b".repeat(200_000)}`,
  );
  expect(scrubbed).not.toContain("synthetic-long-value");
  expect(scrubbed.endsWith("…")).toBe(true);
  expect(scrubbed.length).toBeLessThan(16_384);
});

test("a scheme that a cut text ends in or right after is replaced whole", () => {
  for (const end of ["wss://", "wss:/", "wss:", "ws"])
    expect(scrubCredentialText(`see x>synthetic-cut-glue-${end}`, true)).toBe("see x>[redacted]");
  // The 16,384-code-point cut falls inside the `://`.
  const text = `${"a ".repeat(8_179)}synthetic-cap-glue-redis://h?x=1`;
  expect(scrubCredentialText(text)).toBe(`${"a ".repeat(8_179)}[redacted]…`);
});

test("a run of Authorization values inside each other's first word is read once", () => {
  // Each value starting inside the one before's first word ends where that one does; were each
  // read again to the end, 20,000 of them would take seconds.
  const started = performance.now();
  for (const value of ["Authorization=>%5Bredacted%5D\\", "Authorization=%5Bredacted%5D&"])
    expect(scrubCredentialTextUnbounded(value.repeat(20_000))).not.toContain("%5Bredacted%5D");
  expect(performance.now() - started).toBeLessThan(1_000);
});

test("a run of backslashes in a value that does not close is read once", () => {
  // Each run can be read only one way; were it two, 80 backslashes would take seconds and 200
  // would not finish.
  for (const count of [80, 200]) {
    const started = performance.now();
    providerErrorDescription(`{"error": "token=\\"${"\\".repeat(count)}"x"}`);
    scrubCredentialTextUnbounded(String.raw`token: [\"${"\\".repeat(count)}"x`);
    expect(performance.now() - started).toBeLessThan(100);
  }
  const started = performance.now();
  for (const value of [String.raw`token=\"`, String.raw`token: [\"`, String.raw`?t=\"`])
    scrubCredentialTextUnbounded(`${value}${"\\".repeat(200_000)}x\n`);
  expect(performance.now() - started).toBeLessThan(5_000);
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

test("every secret planted in the shared corpus is redacted, one case at a time or all at once", () => {
  // The Python suite checks the same corpus; `planted-secrets.py` regenerates it from its seed.
  const started = performance.now();
  const leaked = plantedSecrets.cases.flatMap(({ input, secrets }) => {
    const scrubbed = scrubCredentialText(input);
    return secrets.filter((secret) => scrubbed.includes(secret));
  });
  expect(leaked).toEqual([]);
  // The whole corpus as one text: every secret still redacted, in time linear in its length.
  const whole = scrubCredentialTextUnbounded(
    plantedSecrets.cases.map(({ input }) => input).join("\n"),
  );
  expect(
    plantedSecrets.cases.flatMap(({ secrets }) =>
      secrets.filter((secret) => whole.includes(secret)),
    ),
  ).toEqual([]);
  expect(performance.now() - started).toBeLessThan(2_000);
});
