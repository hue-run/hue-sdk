import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { createHue, createHueSafe, createHueTransport, HueConnectionError } from "../src/index.js";
import { hueTelemetry } from "../src/ai-sdk.js";
import { OpenTelemetry } from "@ai-sdk/otel";
import { generateText, isStepCount, jsonSchema, streamText, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { apiKey, receiver, attr, usage } from "./sdk-receiver.js";

test("workspaceId is recorded as hue.workspace.id and inherited like the user", async () => {
  const endpoint = receiver();
  const hue = createHue({
    apiKey,
    serviceName: "workspace",
    captureContent: false,
    baseUrl: endpoint.url,
  });
  try {
    await hue.withSpan(
      "request",
      async () => {
        await hue.tool("lookup", null, () => "ok");
        await hue.model("synthetic-model", () => "ok", { provider: "synthetic" });
        await generateText({
          model: new MockLanguageModelV4({
            doGenerate: async () => ({
              content: [{ type: "text", text: "ok" }],
              finishReason: { unified: "stop", raw: "stop" },
              usage,
              warnings: [],
            }),
          }),
          prompt: "Synthetic prompt",
          telemetry: hueTelemetry(hue),
        });
        await hue.withSpan("other-workspace", () => undefined, { workspaceId: "workspace-2" });
      },
      { workspaceId: "workspace-1", userId: "user-1" },
    );
    await hue.withSpan("unscoped", () => undefined);
    await hue.model("synthetic-model", () => "ok", {
      provider: "synthetic",
      name: "direct-model",
      workspaceId: "workspace-3",
    });
    expect(await hue.withSpan("blank", () => "ran", { workspaceId: "" })).toBe("ran");
    const result = await hue.flushSafe();
    expect(result.report.instrumentationFailures).toBe(1);
    const spans = endpoint.requests.flatMap((request) => request.records);
    const workspace = (name: string) =>
      attr(spans.find((span) => span.name === name)!, "hue.workspace.id")?.stringValue;
    const request = spans.find((span) => span.name === "request")!;
    const scoped = spans.filter(
      (span) => span.traceId === request.traceId && span.name !== "other-workspace",
    );
    expect(scoped.map((span) => span.name)).toEqual(
      expect.arrayContaining(["request", "execute_tool lookup", "chat synthetic-model"]),
    );
    expect(scoped.length).toBeGreaterThan(4);
    for (const span of scoped) {
      expect(attr(span, "hue.workspace.id")?.stringValue).toBe("workspace-1");
      expect(attr(span, "user.id")?.stringValue).toBe("user-1");
    }
    expect(workspace("other-workspace")).toBe("workspace-2");
    expect(workspace("unscoped")).toBeUndefined();
    expect(workspace("direct-model")).toBe("workspace-3");
    expect(spans.some((span) => span.name === "blank")).toBe(false);
  } finally {
    await hue.shutdown();
    endpoint.server.stop(true);
  }
});

describe("Vercel AI SDK integration", () => {
  test.each([true, false])(
    "streamed provider spans obey captureContent=%s inside a Hue parent",
    async (captureContent) => {
      const endpoint = receiver();
      const hue = createHue({
        apiKey,
        serviceName: "reference",
        captureContent,
        baseUrl: endpoint.url,
      });
      try {
        await hue.withSpan(
          "chat",
          async ({ setOutput }) => {
            const model = new MockLanguageModelV4({
              provider: "openai.chat",
              modelId: "synthetic-model",
              doStream: async () => ({
                stream: new ReadableStream({
                  start(controller) {
                    controller.enqueue({ type: "stream-start", warnings: [] });
                    controller.enqueue({ type: "text-start", id: "one" });
                    controller.enqueue({
                      type: "text-delta",
                      id: "one",
                      delta: "Synthetic streamed response",
                    });
                    controller.enqueue({ type: "text-end", id: "one" });
                    controller.enqueue({
                      type: "finish",
                      finishReason: { unified: "stop", raw: "stop" },
                      usage,
                    });
                    controller.close();
                  },
                }),
              }),
            });
            const result = streamText({
              model,
              prompt: "Synthetic streamed request",
              telemetry: hueTelemetry(hue),
            });
            setOutput(await result.text);
          },
          { sessionId: "sdk-stream-session" },
        );
        await hue.flush();
        const spans = endpoint.requests.flatMap((request) => request.records);
        const chat = spans.find((span) => span.name === "chat")!;
        expect(spans.length).toBeGreaterThan(2);
        expect(spans.every((span) => span.traceId === chat.traceId)).toBe(true);
        expect(
          spans.some(
            (span) => attr(span, "gen_ai.request.model")?.stringValue === "synthetic-model",
          ),
        ).toBe(true);
        const raw = endpoint.requests.map((request) => request.raw).join(" ");
        if (captureContent) {
          expect(raw).toContain("Synthetic streamed response");
          expect(raw).toContain("Synthetic streamed request");
        } else {
          expect(raw).not.toContain("Synthetic streamed response");
          expect(raw).not.toContain("Synthetic streamed request");
        }
      } finally {
        await hue.shutdown();
        await endpoint.server.stop(true);
      }
    },
  );

  // Content as @ai-sdk/openai 4.0.66 maps an OpenAI Responses `mcp_call` item: a provider-executed
  // `mcp.<name>` call plus a result naming the server only in `serverLabel`.
  const hostedMcpModel = (
    error?: string | { code: number; message: string },
    serverLabel: string | undefined = "gmail",
  ) =>
    new MockLanguageModelV4({
      provider: "openai.responses",
      modelId: "synthetic-model",
      doGenerate: async () => ({
        content: [
          {
            type: "tool-call",
            toolCallId: "mcp_synthetic",
            toolName: "mcp.create_draft",
            input: '{"to":"synthetic@example.test"}',
            providerExecuted: true,
            dynamic: true,
          },
          {
            type: "tool-result",
            toolCallId: "mcp_synthetic",
            toolName: "mcp.create_draft",
            result: {
              type: "call",
              ...(serverLabel === undefined ? {} : { serverLabel }),
              name: "create_draft",
              arguments: '{"to":"synthetic@example.test"}',
              ...(error === undefined ? { output: "Synthetic draft saved" } : { error }),
            },
            providerMetadata: { openai: { itemId: "mcp_synthetic" } },
          },
          { type: "text", text: "Synthetic hosted answer" },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      }),
    });

  test.each([
    { captureContent: true, error: undefined },
    { captureContent: false, error: undefined },
    { captureContent: true, error: { code: -32000, message: "Synthetic MCP failure" } },
    { captureContent: false, error: "Synthetic MCP failure" },
  ])(
    "hosted MCP extension spans carry the server label (%o)",
    async ({ captureContent, error }) => {
      const endpoint = receiver();
      const transport = createHueTransport({
        apiKey,
        serviceName: "hosted-mcp",
        captureContent,
        baseUrl: endpoint.url,
      });
      // The application records AI SDK content; Hue's export path applies captureContent.
      const tracerProvider = new TracerProvider({ spanProcessors: [transport.spanProcessor] });
      try {
        await generateText({
          model: hostedMcpModel(error),
          prompt: "Synthetic hosted request",
          telemetry: {
            recordInputs: true,
            recordOutputs: true,
            integrations: [new OpenTelemetry({ tracer: tracerProvider.getTracer("app") })],
          },
        });
        await tracerProvider.forceFlush();
        await transport.flush();
        const spans = endpoint.requests.flatMap((request) => request.records);
        const tool = spans.find((span) => span.name === "execute_tool mcp.create_draft")!;
        expect(attr(tool, "gen_ai.tool.type")?.stringValue).toBe("extension");
        expect(attr(tool, "mcp.server.name")?.stringValue).toBe("gmail");
        if (error === undefined) {
          expect(attr(tool, "error.type")).toBeUndefined();
          expect(tool.status?.code ?? 0).toBe(0);
        } else {
          expect(attr(tool, "error.type")?.stringValue).toBe("mcp_error");
          expect(tool.status?.code).toBe(2);
          expect(tool.status?.message).toBeUndefined();
        }
        const others = spans.filter((span) => span !== tool);
        expect(others.every((span) => attr(span, "mcp.server.name") === undefined)).toBe(true);
        const raw = endpoint.requests.map((request) => request.raw).join(" ");
        if (captureContent) {
          expect(attr(tool, "gen_ai.tool.call.result")?.stringValue).toContain('"serverLabel"');
        } else {
          expect(attr(tool, "gen_ai.tool.call.result")).toBeUndefined();
          expect(attr(tool, "gen_ai.tool.call.arguments")).toBeUndefined();
          expect(raw).not.toContain("synthetic@example.test");
          expect(raw).not.toContain("Synthetic draft saved");
          expect(raw).not.toContain("Synthetic MCP failure");
        }
      } finally {
        await tracerProvider.shutdown();
        await transport.shutdown();
        await endpoint.server.stop(true);
      }
    },
  );

  test("hosted MCP errors stay failed when the server label is malformed", async () => {
    const endpoint = receiver();
    const transport = createHueTransport({
      apiKey,
      serviceName: "hosted-mcp-invalid-label",
      captureContent: false,
      baseUrl: endpoint.url,
    });
    const tracerProvider = new TracerProvider({ spanProcessors: [transport.spanProcessor] });
    try {
      await generateText({
        model: hostedMcpModel({ code: -32000, message: "Synthetic MCP failure" }, "\u0000bad"),
        prompt: "Synthetic hosted request",
        telemetry: {
          recordInputs: true,
          recordOutputs: true,
          integrations: [new OpenTelemetry({ tracer: tracerProvider.getTracer("app") })],
        },
      });
      await tracerProvider.forceFlush();
      await transport.flush();
      const tool = endpoint.requests
        .flatMap((request) => request.records)
        .find((span) => span.name === "execute_tool mcp.create_draft")!;
      expect(attr(tool, "mcp.server.name")).toBeUndefined();
      expect(attr(tool, "error.type")?.stringValue).toBe("mcp_error");
      expect(tool.status?.code).toBe(2);
    } finally {
      await tracerProvider.shutdown();
      await transport.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test.each([true, false])(
    "AI SDK 7 tool definitions export without hosted MCP credentials (captureContent=%p)",
    async (captureContent) => {
      const endpoint = receiver();
      const hue = createHue({
        apiKey,
        serviceName: "tool-definitions",
        captureContent,
        baseUrl: endpoint.url,
      });
      try {
        const result = await generateText({
          model: new MockLanguageModelV4({
            doGenerate: async () => ({
              content: [{ type: "text", text: "Draft ready" }],
              finishReason: { unified: "stop", raw: "stop" },
              usage,
              warnings: [],
            }),
          }),
          prompt: "Synthetic prompt",
          tools: {
            // The shape `openai.tools.mcp({...})` returns: a provider-executed tool whose
            // arguments carry the MCP server's credentials.
            gmail: {
              type: "provider",
              id: "openai.mcp",
              isProviderExecuted: true,
              inputSchema: jsonSchema({ type: "object" }),
              args: {
                serverLabel: "gmail",
                serverUrl: "https://mcp.example.test/gmail",
                authorization: "synthetic-oauth-token",
                headers: { "X-Api-Key": "synthetic-header-secret" },
                allowedTools: ["create_draft"],
              },
            },
            fetch_page: tool({
              description: "Fetch a page",
              inputSchema: jsonSchema({
                type: "object",
                properties: { headers: { type: "object" }, url: { type: "string" } },
              }),
            }),
          },
          telemetry: hueTelemetry(hue),
        });
        expect(result.text).toBe("Draft ready");
        await hue.flush();
        const spans = endpoint.requests.flatMap((request) => request.records);
        const definitions = spans.flatMap((span) => {
          const value = attr(span, "gen_ai.tool.definitions")?.stringValue;
          return value === undefined ? [] : [JSON.parse(value) as Record<string, unknown>[]];
        });
        const raw = endpoint.requests.map((request) => request.raw).join(" ");
        expect(raw).not.toContain("synthetic-oauth-token");
        expect(raw).not.toContain("synthetic-header-secret");
        if (!captureContent) {
          expect(definitions).toEqual([]);
          return;
        }
        expect(definitions).toHaveLength(1);
        const [gmail, fetchPage] = [
          definitions[0].find((definition) => definition.name === "gmail"),
          definitions[0].find((definition) => definition.name === "fetch_page"),
        ];
        expect(gmail).toEqual({
          type: "provider",
          name: "gmail",
          id: "openai.mcp",
          args: {
            serverLabel: "gmail",
            serverUrl: "https://mcp.example.test/gmail",
            authorization: "[redacted]",
            headers: "[redacted]",
            allowedTools: ["create_draft"],
          },
        });
        // A parameter named `headers` is part of the tool's schema, not a credential.
        expect(fetchPage?.inputSchema).toMatchObject({
          properties: { headers: { type: "object" }, url: { type: "string" } },
        });
      } finally {
        await hue.shutdown();
        await endpoint.server.stop(true);
      }
    },
  );

  test("a large inline file in AI SDK 7 messages exports as its digest instead of rejecting the span", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "inline-files",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    const pdf = Uint8Array.from({ length: 300 * 1024 }, (_, index) => index % 251);
    const digest = createHash("sha256").update(pdf).digest("hex");
    try {
      await generateText({
        model: new MockLanguageModelV4({
          doGenerate: async () => ({
            content: [{ type: "text", text: "Summary" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage,
            warnings: [],
          }),
        }),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Summarize the contract" },
              { type: "file", data: pdf, mediaType: "application/pdf" },
            ],
          },
        ],
        telemetry: hueTelemetry(hue),
      });
      // Strict flush: every span, including the ones that inlined the file, was accepted.
      await hue.flush();
      const spans = endpoint.requests.flatMap((request) => request.records);
      const chat = spans.find((span) => span.name === "chat mock-model-id")!;
      const [message] = JSON.parse(attr(chat, "gen_ai.input.messages")!.stringValue!) as {
        parts: Record<string, unknown>[];
      }[];
      expect(message.parts[0]).toEqual({ type: "text", content: "Summarize the contract" });
      expect(message.parts[1]).toMatchObject({
        type: "blob",
        mime_type: "application/pdf",
        sha256: digest,
        size: pdf.byteLength,
      });
      expect(message.parts[1].content).toBeUndefined();
      const raw = endpoint.requests.map((request) => request.raw).join(" ");
      expect(raw).not.toContain(Buffer.from(pdf).toString("base64").slice(0, 64));
      expect(hue.transport.getReport().failedSpans).toBe(0);
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test("provider failure becomes an error span and missing token usage stays absent", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "reference",
      captureContent: false,
      baseUrl: endpoint.url,
    });
    try {
      await expect(
        generateText({
          model: new MockLanguageModelV4({
            doGenerate: async () => {
              throw new Error("Synthetic provider failure");
            },
          }),
          prompt: "Synthetic prompt",
          maxRetries: 0,
          telemetry: hueTelemetry(hue),
        }),
      ).rejects.toThrow("Synthetic provider failure");
      await hue.flush();
      const spans = endpoint.requests.flatMap((request) => request.records);
      expect(spans.some((span) => span.status?.code === 2)).toBe(true);
      expect(spans.every((span) => attr(span, "gen_ai.usage.input_tokens") === undefined)).toBe(
        true,
      );
      expect(endpoint.requests.map((request) => request.raw).join(" ")).not.toContain(
        "Synthetic provider failure",
      );
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test("records the end user and conversation the app puts in AI SDK 7 runtime context", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "runtime-context",
      captureContent: false,
      baseUrl: endpoint.url,
    });
    // One tool call, then an answer: invoke_agent, two steps, two chat spans and execute_tool.
    const model = () => {
      let call = 0;
      return new MockLanguageModelV4({
        doGenerate: async () => ({
          content:
            call++ === 0
              ? [
                  {
                    type: "tool-call",
                    toolCallId: "call-1",
                    toolName: "lookup",
                    input: '{"accountId":"tool-argument-user"}',
                  },
                ]
              : [{ type: "text", text: "Done" }],
          finishReason:
            call === 1
              ? { unified: "tool-calls", raw: "tool_calls" }
              : { unified: "stop", raw: "stop" },
          usage,
          warnings: [],
        }),
      });
    };
    const tools = {
      lookup: tool({
        inputSchema: jsonSchema<{ accountId: string }>({
          type: "object",
          properties: { accountId: { type: "string" } },
        }),
        execute: async () => ({ owner: "tool-result-user" }),
      }),
    };
    const call = (
      functionId: string,
      runtimeContext: Record<string, unknown>,
      telemetry = hueTelemetry(hue),
    ) =>
      generateText({
        model: model(),
        prompt: "Synthetic prompt",
        tools,
        stopWhen: isStepCount(2),
        runtimeContext,
        telemetry: { ...telemetry, functionId },
      });
    try {
      await call("defaults", {
        userId: "user-7",
        threadId: "thread-7",
        apiToken: "synthetic-runtime-secret",
      });
      await call("session-first", { userId: 42, sessionId: "session-1", threadId: "thread-1" });
      await call(
        "custom-keys",
        { accountId: "account-9", chatId: "chat-9", userId: "ignored" },
        hueTelemetry(hue, { userKey: "accountId", sessionKey: "chatId" }),
      );
      await call("unusable", { userId: "", sessionId: { id: "nested" }, threadId: "bad\u0000id" });
      await call("none", { tenant: "tenant-1" });
      await hue.withSpan(
        "request",
        () => call("scoped", { userId: "context-user", sessionId: "context-session" }),
        { userId: "scope-user", sessionId: "scope-session" },
      );
      await hue.flush();
      const spans = endpoint.requests.flatMap((request) => request.records);
      const traceOf = (functionId: string) => {
        const root = spans.find(
          (span) => attr(span, "gen_ai.agent.name")?.stringValue === functionId,
        )!;
        return spans.filter((span) => span.traceId === root.traceId && span.name !== "request");
      };
      const identity = (functionId: string) => {
        const trace = traceOf(functionId);
        expect(trace.map((span) => span.name)).toEqual(
          expect.arrayContaining(["execute_tool lookup", "chat mock-model-id"]),
        );
        expect(trace.length).toBe(6);
        return [
          ...new Set(
            trace.map((span) =>
              JSON.stringify([
                attr(span, "user.id")?.stringValue,
                attr(span, "gen_ai.conversation.id")?.stringValue,
              ]),
            ),
          ),
        ].map((value) => JSON.parse(value) as unknown);
      };
      // Every span of the call, tool span included, carries the same identity.
      expect(identity("defaults")).toEqual([["user-7", "thread-7"]]);
      expect(identity("session-first")).toEqual([["42", "session-1"]]);
      expect(identity("custom-keys")).toEqual([["account-9", "chat-9"]]);
      expect(identity("unusable")).toEqual([[null, null]]);
      expect(identity("none")).toEqual([[null, null]]);
      // An enclosing withSpan's identity wins over runtime context.
      expect(identity("scoped")).toEqual([["scope-user", "scope-session"]]);
      // No other runtime-context value, and no tool argument or result, is exported.
      const raw = endpoint.requests.map((request) => request.raw).join(" ");
      expect(raw).not.toContain("synthetic-runtime-secret");
      expect(raw).not.toContain("tenant-1");
      expect(raw).not.toContain("tool-argument-user");
      expect(raw).not.toContain("tool-result-user");
      expect(
        spans.some((span) => span.attributes?.some((a) => a.key.startsWith("ai.settings.context"))),
      ).toBe(false);
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test("hueTelemetry names only the runtime-context keys it reads and rejects an empty key", async () => {
    const hue = createHue({ apiKey, serviceName: "runtime-context-options" });
    try {
      expect(hueTelemetry(hue).includeRuntimeContext).toEqual({
        userId: true,
        sessionId: true,
        threadId: true,
      });
      expect(
        hueTelemetry(hue, { userKey: "accountId", sessionKey: ["chatId", "accountId"] })
          .includeRuntimeContext,
      ).toEqual({ accountId: true, chatId: true });
      // With both mappings off, the options are exactly what they were before the mapping existed.
      expect(Object.keys(hueTelemetry(hue, { userKey: false, sessionKey: false })).sort()).toEqual([
        "integrations",
        "isEnabled",
        "recordInputs",
        "recordOutputs",
      ]);
      expect(() => hueTelemetry(hue, { userKey: "" })).toThrow(TypeError);
      expect(() => hueTelemetry(hue, { sessionKey: ["sessionId", ""] })).toThrow(TypeError);
    } finally {
      await hue.shutdown();
    }
  });
});

test("safe initialization and the kill switch require no credentials and perform no HTTP", async () => {
  const endpoint = receiver();
  const clients = [
    createHue({ enabled: false, captureContent: true, baseUrl: endpoint.url }),
    createHueSafe({
      apiKey: "",
      serviceName: "invalid",
      captureContent: true,
      baseUrl: endpoint.url,
    }),
  ];
  for (const hue of clients) {
    expect(hue.enabled).toBe(false);
    expect(hueTelemetry(hue).isEnabled).toBe(false);
    expect(await hue.tool("disabled", null, () => "success")).toBe("success");
    await hue.shutdownSafe();
    expect(await hue.withSpan("late", () => "late-success")).toBe("late-success");
    await expect(hue.checkConnection()).rejects.toBeInstanceOf(HueConnectionError);
    await expect(hue.verifyTrace("f".repeat(32))).rejects.toBeInstanceOf(HueConnectionError);
  }
  expect(clients[1].transport.getReport().instrumentationFailures).toBe(1);
  expect(endpoint.hits()).toBe(0);
  endpoint.server.stop(true);
});
