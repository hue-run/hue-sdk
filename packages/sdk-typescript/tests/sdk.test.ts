import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs/light.js";
import { context, trace, type TraceState } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ProtobufTraceSerializer } from "@opentelemetry/otlp-transformer";
import { detectResources, resourceFromAttributes } from "@opentelemetry/resources";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import {
  createHue,
  createHueSafe,
  createHueTransport,
  HueConnectionError,
  HueExportError,
  contentPrefixes,
  type ExportIssue,
} from "../src/index.js";
import { hueTelemetry } from "../src/ai-sdk.js";
import { OpenTelemetry } from "@ai-sdk/otel";
import { generateText, jsonSchema, streamText, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import schema from "./fixtures/otlp-schema.json" with { type: "json" };
import hostedFixtures from "./fixtures/hosted-tool-calls.json" with { type: "json" };
import sdkPackage from "@hue-run/sdk/package.json" with { type: "json" };

type Value = {
  stringValue?: string;
  intValue?: string;
  kvlistValue?: { values: Attribute[] };
  arrayValue?: { values: Value[] };
};
type Attribute = { key: string; value: Value };
type WireRecord = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name?: string;
  attributes?: Attribute[];
  body?: Value;
  status?: { code?: number; message?: string };
  events?: { name: string; attributes?: Attribute[] }[];
};
const root = protobuf.Root.fromJSON(schema);
const apiKey = "synthetic-hue-test-key";
const project = {
  id: "synthetic-project",
  name: "SDK test",
  organizationId: "synthetic-org",
  slug: "sdk-test",
};

function receiver(
  mode:
    | "success"
    | "partial"
    | "unauthorized"
    | "retry"
    | "malformed"
    | "redirect"
    | "warning" = "success",
  redirect?: string,
  beforeReply?: (signal: "traces" | "logs") => Promise<void>,
) {
  const requests: {
    signal: "traces" | "logs";
    records: WireRecord[];
    raw: string;
    bytes: number;
    headers: Record<string, string>;
  }[] = [];
  let hits = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      hits++;
      expect(request.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
      if (mode === "redirect")
        return new Response(null, { status: 307, headers: { Location: redirect! } });
      if (mode === "unauthorized") {
        // This fixture tests received 401 acknowledgements, so finish reading the
        // compressed request instead of racing its upload with an early response.
        await request.arrayBuffer();
        return new Response(`reflected ${apiKey}`, { status: 401 });
      }
      if (new URL(request.url).pathname === "/api/v1/projects/current")
        return Response.json(project);
      if (mode === "retry" && hits === 1) {
        await request.arrayBuffer();
        return new Response("retry", { status: 503, headers: { "Retry-After": "1" } });
      }
      const signal = new URL(request.url).pathname.endsWith("/logs") ? "logs" : "traces";
      const namespace = `opentelemetry.proto.collector.${signal === "traces" ? "trace" : "logs"}.v1.Export${signal === "traces" ? "Trace" : "Logs"}Service`;
      let bytes = Buffer.from(await request.arrayBuffer());
      if (request.headers.get("content-encoding") === "gzip") bytes = gunzipSync(bytes);
      const type = root.lookupType(`${namespace}Request`);
      const data = type.toObject(type.decode(bytes), { longs: String, bytes: String });
      const records: WireRecord[] =
        signal === "traces"
          ? data.resourceSpans.flatMap((group: { scopeSpans: { spans: WireRecord[] }[] }) =>
              group.scopeSpans.flatMap((scope) => scope.spans),
            )
          : data.resourceLogs.flatMap((group: { scopeLogs: { logRecords: WireRecord[] }[] }) =>
              group.scopeLogs.flatMap((scope) => scope.logRecords),
            );
      requests.push({
        signal,
        records,
        raw: JSON.stringify(data),
        bytes: bytes.byteLength,
        headers: (() => {
          const headers: Record<string, string> = {};
          request.headers.forEach((value, name) => {
            headers[name] = value;
          });
          return headers;
        })(),
      });
      await beforeReply?.(signal);
      if (mode === "malformed")
        return new Response(new Uint8Array([0x0a, 0xff]), {
          headers: { "content-type": "application/x-protobuf" },
        });
      const responseType = root.lookupType(`${namespace}Response`);
      const response =
        mode === "partial" || mode === "warning"
          ? {
              partialSuccess: {
                [signal === "traces" ? "rejectedSpans" : "rejectedLogRecords"]:
                  mode === "warning" ? "0" : "1",
                errorMessage: `reflected ${apiKey}`,
              },
            }
          : {};
      return new Response(
        new Uint8Array(responseType.encode(responseType.fromObject(response)).finish()),
        { headers: { "content-type": "application/x-protobuf" } },
      );
    },
  });
  return { server, requests, url: `http://127.0.0.1:${server.port}`, hits: () => hits };
}

function attr(record: WireRecord, key: string): Value | undefined {
  return record.attributes?.find((item) => item.key === key)?.value;
}

describe("Hue SDK contract", () => {
  test("export requests ignore OTEL_EXPORTER_OTLP_* environment configuration", async () => {
    const endpoint = receiver();
    const previous = {
      OTEL_EXPORTER_OTLP_HEADERS: process.env.OTEL_EXPORTER_OTLP_HEADERS,
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS,
      OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    };
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "x-foreign-vendor=leaked";
    process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = "x-foreign-traces=leaked";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:9/elsewhere";
    const hue = createHue({
      apiKey,
      serviceName: "env-isolation",
      captureContent: false,
      baseUrl: endpoint.url,
    });
    try {
      await hue.withSpan("request", () => undefined);
      await hue.flush();
      expect(endpoint.requests.length).toBeGreaterThan(0);
      for (const request of endpoint.requests) {
        expect(request.headers["x-foreign-vendor"]).toBeUndefined();
        expect(request.headers["x-foreign-traces"]).toBeUndefined();
        expect(request.headers["user-agent"]).toMatch(/^hue-sdk-typescript\/\d/);
        // Hue's token, then OpenTelemetry's exporter token for the pinned exporter version.
        expect(request.headers["user-agent"]).toBe(
          `hue-sdk-typescript/${sdkPackage.version} OTel-OTLP-Exporter-JavaScript/${sdkPackage.dependencies["@opentelemetry/otlp-exporter-base"]}`,
        );
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await hue.shutdown();
      endpoint.server.stop(true);
    }
  });
  test.each([true, false])(
    "records provider-executed tools under their model parent without leaking request credentials (captureContent=%p)",
    async (captureContent) => {
      const endpoint = receiver();
      const hue = createHue({
        apiKey,
        serviceName: "provider-tool-guard",
        captureContent,
        baseUrl: endpoint.url,
      });
      const openai = hostedFixtures.openai as {
        request: Record<string, unknown>;
        response: { output: Record<string, unknown>[] };
      };
      const anthropic = hostedFixtures.anthropic as {
        request: Record<string, unknown>;
        response: { content: Record<string, unknown>[] };
      };
      try {
        await hue.model(
          "synthetic-model",
          async () => {
            const response = structuredClone(openai.response);
            response.output[1] = {
              ...response.output[1],
              arguments: JSON.stringify({ query: "private-provider-content" }),
            };
            response.output.push({
              type: "mcp_call",
              id: "constructor-call",
              server_label: "constructor",
              name: "constructor_tool",
              arguments: "{}",
            });
            hue.recordProviderToolCalls(response, {
              provider: "openai",
              request: openai.request,
              // An object with no own `constructor` key must not resolve Object.prototype.
              servers: {},
            });
            hue.recordProviderToolCalls(anthropic.response, {
              provider: "anthropic",
              request: anthropic.request,
            });
          },
          { provider: "openai" },
        );
        await hue.flush();
        const spans = endpoint.requests.flatMap((request) => request.records);
        const model = spans.find((span) => span.name === "chat synthetic-model")!;
        const tools = spans.filter((span) => span.name?.startsWith("execute_tool "));
        expect(tools.length).toBe(9);
        expect(tools.every((span) => span.parentSpanId === model.spanId)).toBe(true);
        const listing = spans.find((span) => span.name === "tools/list")!;
        expect(listing.parentSpanId).toBe(model.spanId);
        expect(attr(listing, "mcp.method.name")?.stringValue).toBe("tools/list");
        expect(attr(listing, "mcp.server.name")?.stringValue).toBe("gmail");
        expect(attr(listing, "server.address")?.stringValue).toBe("mcp.example.test");
        const byName = Object.fromEntries(tools.map((span) => [span.name, span]));
        expect(
          attr(byName["execute_tool search_threads"]!, "gen_ai.tool.call.id")?.stringValue,
        ).toBe("mcp_1");
        expect(attr(byName["execute_tool search_threads"]!, "server.address")?.stringValue).toBe(
          "mcp.example.test",
        );
        expect(attr(byName["execute_tool create_draft"]!, "error.type")?.stringValue).toBe(
          "mcp_error",
        );
        expect(byName["execute_tool create_draft"]!.status?.code).toBe(2);
        expect(attr(byName["execute_tool file_search"]!, "error.type")?.stringValue).toBe("failed");
        expect(attr(byName["execute_tool code_interpreter"]!, "error.type")).toBeUndefined();
        expect(attr(byName["execute_tool post_message"]!, "mcp.server.name")?.stringValue).toBe(
          "slack",
        );
        expect(attr(byName["execute_tool post_message"]!, "server.address")?.stringValue).toBe(
          "mcp.example.test",
        );
        expect(attr(byName["execute_tool post_message"]!, "error.type")?.stringValue).toBe(
          "mcp_error",
        );
        const constructorTool = byName["execute_tool constructor_tool"]!;
        expect(attr(constructorTool, "mcp.server.name")?.stringValue).toBe("constructor");
        expect(spans.some((span) => attr(span, "mcp.server.name")?.stringValue === "Object")).toBe(
          false,
        );
        const raw = endpoint.requests.map((request) => request.raw).join(" ");
        expect(raw).not.toContain("synthetic-oauth-token");
        if (captureContent) {
          expect(raw).toContain("private-provider-content");
          expect(attr(listing, "gen_ai.tool.definitions")).toBeDefined();
          expect(
            attr(byName["execute_tool search_threads"]!, "gen_ai.tool.call.arguments"),
          ).toBeDefined();
          expect(
            attr(byName["execute_tool search_threads"]!, "gen_ai.tool.call.result"),
          ).toBeDefined();
          expect(
            attr(byName["execute_tool post_message"]!, "gen_ai.tool.call.arguments"),
          ).toBeDefined();
        } else {
          expect(raw).not.toContain("private-provider-content");
          for (const span of [listing, ...tools]) {
            expect(attr(span, "gen_ai.tool.call.arguments")).toBeUndefined();
            expect(attr(span, "gen_ai.tool.call.result")).toBeUndefined();
            expect(attr(span, "gen_ai.tool.definitions")).toBeUndefined();
          }
        }
      } finally {
        await hue.shutdown();
        endpoint.server.stop(true);
      }
    },
  );

  test("does not make a harmless truncated response fail strict flush", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "provider-tool-truncation",
      captureContent: false,
      baseUrl: endpoint.url,
    });
    try {
      await hue.model(
        "synthetic-model",
        async () => {
          hue.recordProviderToolCalls(
            {
              output: Array.from({ length: 256 }, () => ({ type: "message", content: [] })),
            },
            { provider: "openai" },
          );
        },
        { provider: "openai" },
      );
      const report = await hue.flush();
      expect(report.instrumentationFailures).toBe(0);
    } finally {
      await hue.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("model helper records GenAI request attributes, message content and validated usage", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "model-helper",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    try {
      await hue.withSpan("request", async () => {
        await hue.model(
          "synthetic-model",
          async (span) => {
            span.setOutput([{ role: "assistant", content: "hello" }]);
            span.setUsage({ inputTokens: 3, outputTokens: 2 });
            // Invalid counts are omitted and counted, never thrown into application code.
            span.setUsage({ inputTokens: -1 });
          },
          { provider: "synthetic", input: [{ role: "user", content: "hi" }], userId: "user-1" },
        );
      });
      // The counted omission fails a strict flush by contract; the safe path reports it.
      const result = await hue.flushSafe();
      expect(result.ok).toBe(false);
      expect(result.report.instrumentationFailures).toBe(1);
      const spans = endpoint.requests.flatMap((request) => request.records);
      const root = spans.find((span) => span.name === "request")!;
      const model = spans.find((span) => span.name === "chat synthetic-model")!;
      expect(model.parentSpanId).toBe(root.spanId);
      expect(attr(model, "gen_ai.operation.name")?.stringValue).toBe("chat");
      expect(attr(model, "gen_ai.request.model")?.stringValue).toBe("synthetic-model");
      expect(attr(model, "gen_ai.provider.name")?.stringValue).toBe("synthetic");
      expect(attr(model, "user.id")?.stringValue).toBe("user-1");
      // The `input` option of a model span is message content, not a generic input value.
      expect(attr(model, "input.value")).toBeUndefined();
      expect(JSON.parse(attr(model, "gen_ai.input.messages")!.stringValue!)).toEqual([
        { role: "user", content: "hi" },
      ]);
      expect(JSON.parse(attr(model, "gen_ai.output.messages")!.stringValue!)).toEqual([
        { role: "assistant", content: "hello" },
      ]);
      expect(attr(model, "gen_ai.usage.input_tokens")?.intValue).toBe("3");
      expect(attr(model, "gen_ai.usage.output_tokens")?.intValue).toBe("2");
    } finally {
      await hue.shutdown();
      endpoint.server.stop(true);
    }
  });
  test.each([true, false])(
    "model helper records system instructions and tool definitions as content (captureContent=%p)",
    async (captureContent) => {
      const endpoint = receiver();
      const hue = createHue({
        apiKey,
        serviceName: "model-instructions",
        captureContent,
        baseUrl: endpoint.url,
      });
      const systemInstructions = [{ type: "text", content: "Answer in one sentence." }];
      const tools = [
        {
          type: "function",
          name: "lookup",
          description: "Look up an order",
          parameters: { type: "object", properties: { id: { type: "string" } } },
        },
      ];
      try {
        const answer = await hue.model(
          "synthetic-model",
          () => {
            hue.recordMessages({
              systemInstructions,
              output: [{ role: "assistant", parts: [{ type: "text", content: "Shipped." }] }],
            });
            return "Shipped.";
          },
          { provider: "synthetic", systemInstructions, tools },
        );
        expect(answer).toBe("Shipped.");
        // A value that is not JSON is omitted and counted; the call still runs.
        expect(
          await hue.model("synthetic-model", () => "ran", {
            provider: "synthetic",
            name: "invalid",
            tools: new Date(0),
          }),
        ).toBe("ran");
        const result = await hue.flushSafe();
        expect(result.report.instrumentationFailures).toBe(captureContent ? 1 : 0);
        const spans = endpoint.requests
          .filter((request) => request.signal === "traces")
          .flatMap((request) => request.records);
        const model = spans.find((span) => span.name === "chat synthetic-model")!;
        const invalid = spans.find((span) => span.name === "invalid")!;
        expect(attr(invalid, "gen_ai.tool.definitions")).toBeUndefined();
        const logs = endpoint.requests
          .filter((request) => request.signal === "logs")
          .flatMap((request) => request.records);
        if (!captureContent) {
          expect(attr(model, "gen_ai.system_instructions")).toBeUndefined();
          expect(attr(model, "gen_ai.tool.definitions")).toBeUndefined();
          expect(logs).toHaveLength(0);
          return;
        }
        expect(JSON.parse(attr(model, "gen_ai.system_instructions")!.stringValue!)).toEqual(
          systemInstructions,
        );
        expect(JSON.parse(attr(model, "gen_ai.tool.definitions")!.stringValue!)).toEqual(tools);
        const [log] = logs;
        const body = Object.fromEntries(
          log.body!.kvlistValue!.values.map((item) => [item.key, item.value]),
        );
        expect(
          body["gen_ai.system_instructions"].arrayValue!.values[0].kvlistValue!.values,
        ).toContainEqual({ key: "content", value: { stringValue: "Answer in one sentence." } });
        expect(Object.keys(body).sort()).toEqual([
          "gen_ai.output.messages",
          "gen_ai.system_instructions",
        ]);
      } finally {
        await hue.shutdown();
        endpoint.server.stop(true);
      }
    },
  );
  test("helpers accept interface-typed values without casts and omit non-JSON values", async () => {
    interface ToolInput {
      city: string;
      units?: "c" | "f";
    }
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "typed-inputs",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    try {
      const input: ToolInput = { city: "Oslo" };
      const when = await hue.withSpan(
        "request",
        async (span) => {
          span.setOutput(input);
          hue.recordMessages({ output: input });
          return hue.tool("weather", input, () => new Date(0));
        },
        { input },
      );
      expect(when).toBeInstanceOf(Date);
      // A Date is not JSON data: the result is omitted and counted, and still returned to the caller.
      const result = await hue.flushSafe();
      expect(result.report.instrumentationFailures).toBe(1);
      expect(result.report.acceptedLogs).toBe(1);
      const spans = endpoint.requests
        .filter((request) => request.signal === "traces")
        .flatMap((request) => request.records);
      const root = spans.find((span) => span.name === "request")!;
      const tool = spans.find((span) => span.name === "execute_tool weather")!;
      expect(JSON.parse(attr(root, "input.value")!.stringValue!)).toEqual({ city: "Oslo" });
      expect(JSON.parse(attr(root, "output.value")!.stringValue!)).toEqual({ city: "Oslo" });
      expect(JSON.parse(attr(tool, "gen_ai.tool.call.arguments")!.stringValue!)).toEqual({
        city: "Oslo",
      });
      expect(attr(tool, "gen_ai.tool.call.result")).toBeUndefined();
    } finally {
      await hue.shutdown();
      endpoint.server.stop(true);
    }
  });
  test("tool records an optional call id and counts a blank one as an instrumentation failure", async () => {
    const endpoint = receiver();
    // The id is metadata, so it must survive metadata-only mode.
    const hue = createHue({
      apiKey,
      serviceName: "tool-call-ids",
      captureContent: false,
      baseUrl: endpoint.url,
    });
    try {
      expect(await hue.tool("lookup", { q: 1 }, () => "found", { callId: "call_1" })).toBe("found");
      expect(await hue.tool("plain", null, () => "ok")).toBe("ok");
      expect(await hue.tool("blank", null, () => "ran", { callId: "" })).toBe("ran");
      const result = await hue.flushSafe();
      expect(result.report.instrumentationFailures).toBe(1);
      const spans = endpoint.requests
        .filter((request) => request.signal === "traces")
        .flatMap((request) => request.records);
      const lookup = spans.find((span) => span.name === "execute_tool lookup")!;
      expect(attr(lookup, "gen_ai.operation.name")?.stringValue).toBe("execute_tool");
      expect(attr(lookup, "gen_ai.tool.name")?.stringValue).toBe("lookup");
      expect(attr(lookup, "gen_ai.tool.call.id")?.stringValue).toBe("call_1");
      expect(attr(lookup, "gen_ai.tool.call.arguments")).toBeUndefined();
      for (const name of ["execute_tool plain", "execute_tool blank"]) {
        const span = spans.find((record) => record.name === name)!;
        expect(attr(span, "gen_ai.tool.call.id")).toBeUndefined();
      }
    } finally {
      await hue.shutdown();
      endpoint.server.stop(true);
    }
  });
  test("tool records the MCP server that handled the call", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "mcp-tool-source",
      captureContent: false,
      baseUrl: endpoint.url,
    });
    try {
      expect(
        await hue.tool("get_thread", { thread_id: "t1" }, () => "ok", {
          mcp: { name: "gmail", version: "1.2.3" },
        }),
      ).toBe("ok");
      expect(
        await hue.tool("get_thread", { thread_id: "t2" }, () => "ok", {
          mcp: { name: "" },
        }),
      ).toBe("ok");
      const result = await hue.flushSafe();
      expect(result.report.instrumentationFailures).toBe(1);
      const spans = endpoint.requests
        .filter((request) => request.signal === "traces")
        .flatMap((request) => request.records);
      const labeled = spans.find((span) => span.name === "execute_tool get_thread")!;
      expect(attr(labeled, "gen_ai.tool.name")?.stringValue).toBe("get_thread");
      expect(attr(labeled, "mcp.server.name")?.stringValue).toBe("gmail");
      expect(attr(labeled, "mcp.server.version")?.stringValue).toBe("1.2.3");
      const unlabeled = spans.filter((span) => span.name === "execute_tool get_thread")[1]!;
      expect(attr(unlabeled, "mcp.server.name")).toBeUndefined();
    } finally {
      await hue.shutdown();
      endpoint.server.stop(true);
    }
  });
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
  test("tool records the Hue provider and surface and drops blank or invalid labels", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "mcp-tool-surface",
      captureContent: false,
      baseUrl: endpoint.url,
    });
    try {
      await hue.tool("labeled", {}, () => "ok", {
        mcp: { name: "gmail", provider: "google.gmail", surface: "google.gmail/mcp" },
      });
      await hue.tool("blank", {}, () => "ok", {
        mcp: { name: "gmail", provider: " ", surface: "" },
      });
      await hue.tool("invalid", {}, () => "ok", {
        mcp: {
          name: "gmail",
          provider: "google\u0000gmail",
          surface: "\ud800",
          version: 3 as unknown as string,
        },
      });
      await hue.tool("oversized", {}, () => "ok", {
        mcp: { provider: "p".repeat(257), surface: "s".repeat(256) },
      });
      const result = await hue.flushSafe();
      expect(result.report.instrumentationFailures).toBe(6);
      const spans = endpoint.requests
        .filter((request) => request.signal === "traces")
        .flatMap((request) => request.records);
      const span = (name: string) =>
        spans.find((record) => record.name === `execute_tool ${name}`)!;
      expect(attr(span("labeled"), "hue.mcp.provider")?.stringValue).toBe("google.gmail");
      expect(attr(span("labeled"), "hue.mcp.surface")?.stringValue).toBe("google.gmail/mcp");
      expect(attr(span("labeled"), "mcp.server.name")?.stringValue).toBe("gmail");
      for (const name of ["blank", "invalid"]) {
        expect(attr(span(name), "mcp.server.name")?.stringValue).toBe("gmail");
        expect(attr(span(name), "mcp.server.version")).toBeUndefined();
        expect(attr(span(name), "hue.mcp.provider")).toBeUndefined();
        expect(attr(span(name), "hue.mcp.surface")).toBeUndefined();
      }
      expect(attr(span("oversized"), "hue.mcp.provider")).toBeUndefined();
      expect(attr(span("oversized"), "hue.mcp.surface")?.stringValue).toBe("s".repeat(256));
    } finally {
      await hue.shutdown();
      endpoint.server.stop(true);
    }
  });
  test("tool source labels use UTF-16 length like Python and Fern", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "mcp-tool-source-unicode",
      captureContent: false,
      baseUrl: endpoint.url,
    });
    const accepted = "😀".repeat(128); // 256 UTF-16 code units: the inclusive limit.
    const rejected = "😀".repeat(129);
    try {
      await hue.tool("accepted", {}, () => "ok", {
        mcp: { provider: accepted, surface: accepted },
      });
      await hue.tool("rejected", {}, () => "ok", {
        mcp: { provider: rejected, surface: rejected },
      });
      await hue.tool("nul", {}, () => "ok", {
        mcp: { provider: "\u0000bad", surface: "\u0000bad" },
      });
      expect((await hue.flushSafe()).report.instrumentationFailures).toBe(4);
      const spans = endpoint.requests
        .filter((request) => request.signal === "traces")
        .flatMap((request) => request.records);
      const span = (name: string) =>
        spans.find((record) => record.name === `execute_tool ${name}`)!;
      expect(attr(span("accepted"), "hue.mcp.provider")?.stringValue).toBe(accepted);
      expect(attr(span("accepted"), "hue.mcp.surface")?.stringValue).toBe(accepted);
      expect(attr(span("rejected"), "hue.mcp.provider")).toBeUndefined();
      expect(attr(span("rejected"), "hue.mcp.surface")).toBeUndefined();
      expect(attr(span("nul"), "hue.mcp.provider")).toBeUndefined();
      expect(attr(span("nul"), "hue.mcp.surface")).toBeUndefined();
    } finally {
      await hue.shutdown();
      endpoint.server.stop(true);
    }
  });
  test("export hashes inline files over 64 KiB in recorded messages and keeps smaller ones", async () => {
    const endpoint = receiver();
    const transport = createHueTransport({
      apiKey,
      serviceName: "inline-files-export",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    const tracerProvider = new TracerProvider({ spanProcessors: [transport.spanProcessor] });
    const loggerProvider = new LoggerProvider({ processors: [transport.logRecordProcessor] });
    const hue = createHue({ transport, tracerProvider, loggerProvider });
    const image = Uint8Array.from({ length: 100 * 1024 }, (_, index) => (index * 7) % 256);
    const imageBase64 = Buffer.from(image).toString("base64");
    const imageDigest = createHash("sha256").update(image).digest("hex");
    const text = `${"line\n".repeat(20000)}end`;
    const textDigest = createHash("sha256").update(text, "utf8").digest("hex");
    const asciiText = "A".repeat(64 * 1024 + 4);
    const asciiDigest = createHash("sha256").update(asciiText, "utf8").digest("hex");
    try {
      const span = tracerProvider.getTracer("third-party").startSpan("external");
      // AI SDK 6 file parts: the large image is hashed, its other fields kept; small data stays.
      span.setAttribute(
        "ai.prompt.messages",
        JSON.stringify([
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this" },
              { type: "file", mediaType: "image/png", filename: "chart.png", data: imageBase64 },
              { type: "file", mediaType: "text/plain", data: "c21hbGw=" },
            ],
          },
        ]),
      );
      // GenAI blob parts: text content is hashed as UTF-8, a data: URL is decoded first.
      span.setAttribute(
        "gen_ai.output.messages",
        JSON.stringify([
          {
            role: "assistant",
            parts: [
              { type: "blob", modality: "document", mime_type: "text/plain", content: text },
              { type: "blob", modality: "document", mime_type: "text/plain", content: asciiText },
              {
                type: "blob",
                modality: "image",
                mime_type: "image/png",
                content: `data:image/png;base64,${imageBase64}`,
              },
            ],
            finish_reason: "stop",
          },
        ]),
      );
      // Not a message attribute: left alone even though it carries the same part.
      span.setAttribute(
        "input.value",
        JSON.stringify({ parts: [{ type: "blob", content: imageBase64 }] }),
      );
      span.end();
      await hue.flush();
      const record = endpoint.requests
        .flatMap((request) => request.records)
        .find((candidate) => candidate.name === "external")!;
      const prompt = JSON.parse(attr(record, "ai.prompt.messages")!.stringValue!);
      expect(prompt[0].content).toEqual([
        { type: "text", text: "Describe this" },
        {
          type: "file",
          mediaType: "image/png",
          filename: "chart.png",
          sha256: imageDigest,
          size: image.byteLength,
        },
        { type: "file", mediaType: "text/plain", data: "c21hbGw=" },
      ]);
      const output = JSON.parse(attr(record, "gen_ai.output.messages")!.stringValue!);
      expect(output[0].parts).toEqual([
        {
          type: "blob",
          modality: "document",
          mime_type: "text/plain",
          sha256: textDigest,
          size: Buffer.byteLength(text),
        },
        {
          type: "blob",
          modality: "document",
          mime_type: "text/plain",
          sha256: asciiDigest,
          size: Buffer.byteLength(asciiText),
        },
        {
          type: "blob",
          modality: "image",
          mime_type: "image/png",
          sha256: imageDigest,
          size: image.byteLength,
        },
      ]);
      expect(attr(record, "input.value")?.stringValue).toContain(imageBase64);
    } finally {
      await hue.shutdown();
      await tracerProvider.shutdown();
      await loggerProvider.shutdown();
      await transport.shutdown();
      endpoint.server.stop(true);
    }
  });
  test.each([true, false])(
    "recordFile links a file by content hash without exporting its bytes (captureContent=%p)",
    async (captureContent) => {
      const endpoint = receiver();
      const hue = createHue({
        apiKey,
        serviceName: "files",
        captureContent,
        baseUrl: endpoint.url,
      });
      const body = "synthetic-file-body";
      const digest = createHash("sha256").update(body).digest("hex");
      const pdf = "AB".repeat(32);
      try {
        await hue.withSpan("request", () => {
          hue.recordFile({
            role: "input",
            mediaType: "text/plain",
            data: Buffer.from(body),
            name: "notes.txt",
          });
          hue.recordFile({
            role: "output",
            mediaType: "application/pdf",
            sha256: pdf,
            byteSize: 2048,
          });
          // A string is hashed as UTF-8; a blank name is omitted (and counted when captured).
          hue.recordFile({ role: "attachment", mediaType: "text/plain", data: body, name: " " });
          // Each of these is omitted and counted; the callback keeps running.
          hue.recordFile({ role: "draft" as never, mediaType: "text/plain", data: body });
          hue.recordFile({ role: "input", mediaType: "text/plain", sha256: "not-a-digest" });
          hue.recordFile({
            role: "input",
            mediaType: "text/plain",
            data: body,
            sha256: "0".repeat(64),
          });
          hue.recordFile({ role: "input", mediaType: "text/plain", sha256: digest, byteSize: -1 });
          hue.recordFile({ role: "input", mediaType: "", sha256: digest });
        });
        // Outside any span there is nothing to attach the event to.
        hue.recordFile({ role: "input", mediaType: "text/plain", data: body });
        const result = await hue.flushSafe();
        expect(result.report.instrumentationFailures).toBe(captureContent ? 7 : 6);
        const request = endpoint.requests
          .flatMap((request) => request.records)
          .find((span) => span.name === "request")!;
        const files = (request.events ?? [])
          .filter((event) => event.name === "hue.file")
          .map((event) =>
            Object.fromEntries(
              (event.attributes ?? []).map((item) => [
                item.key,
                item.value.stringValue ?? Number(item.value.intValue),
              ]),
            ),
          );
        expect(files).toEqual([
          {
            "hue.file.sha256": digest,
            "hue.file.role": "input",
            "hue.file.media_type": "text/plain",
            "hue.file.size": body.length,
            ...(captureContent ? { "hue.file.name": "notes.txt" } : {}),
          },
          {
            "hue.file.sha256": pdf.toLowerCase(),
            "hue.file.role": "output",
            "hue.file.media_type": "application/pdf",
            "hue.file.size": 2048,
          },
          {
            "hue.file.sha256": digest,
            "hue.file.role": "attachment",
            "hue.file.media_type": "text/plain",
            "hue.file.size": body.length,
          },
        ]);
        expect(endpoint.requests.map((request) => request.raw).join(" ")).not.toContain(body);
      } finally {
        await hue.shutdown();
        endpoint.server.stop(true);
      }
    },
  );
  test("recordFile rejects oversized data before hashing or exporting it", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "files-limit",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    const oversized = new Uint8Array(25 * 1024 * 1024 + 1);
    try {
      await hue.withSpan("request", () => {
        hue.recordFile({ role: "input", mediaType: "application/octet-stream", data: oversized });
        hue.recordFile({
          role: "input",
          mediaType: "text/plain",
          data: "x".repeat(25 * 1024 * 1024 + 1),
        });
      });
      const result = await hue.flushSafe();
      expect(result.report.instrumentationFailures).toBe(2);
      const request = endpoint.requests
        .flatMap((request) => request.records)
        .find((span) => span.name === "request")!;
      expect(request.events ?? []).toEqual([]);
    } finally {
      await hue.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("resourceAttributes reach the exported resource; attach mode ignores them with a warning", async () => {
    // Attach mode: the application owns the resource, so the option is a warning, not a failure.
    const transport = createHueTransport({
      apiKey,
      serviceName: "attached",
      captureContent: false,
      baseUrl: "http://127.0.0.1:9",
      resourceAttributes: { "deployment.environment.name": "staging" },
    });
    const attached = createHue({
      transport,
      tracerProvider: new TracerProvider({ spanProcessors: [transport.spanProcessor] }),
      loggerProvider: new LoggerProvider({ processors: [transport.logRecordProcessor] }),
    });
    expect(transport.getIssues()).toHaveLength(1);
    expect(transport.getIssues()[0]).toMatchObject({ kind: "warning", count: 0 });
    expect(transport.getIssues()[0].message).toContain("resourceAttributes");
    expect(transport.getFailureSequence()).toBe(0);
    await attached.shutdown();
    await transport.shutdown();
    expect(() =>
      createHue({
        apiKey,
        serviceName: "invalid",
        captureContent: false,
        resourceAttributes: ["deployment.environment.name=staging"] as never,
      }),
    ).toThrow(TypeError);
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "resources",
      serviceVersion: "1.2.3",
      captureContent: false,
      baseUrl: endpoint.url,
      resourceAttributes: {
        "deployment.environment.name": "staging",
        "service.namespace": "agents",
      },
    });
    try {
      await hue.withSpan("request", () => undefined);
      await hue.flush();
      const resource = (
        JSON.parse(endpoint.requests[0].raw) as {
          resourceSpans: { resource: { attributes: Attribute[] } }[];
        }
      ).resourceSpans[0].resource.attributes;
      const value = (key: string) => resource.find((item) => item.key === key)?.value.stringValue;
      expect(value("service.name")).toBe("resources");
      expect(value("service.version")).toBe("1.2.3");
      expect(value("deployment.environment.name")).toBe("staging");
      expect(value("service.namespace")).toBe("agents");
    } finally {
      await hue.shutdown();
      endpoint.server.stop(true);
    }
  });
  test("allowInsecureHttp opts in to plain HTTP for non-loopback hosts with a one-time warning", async () => {
    const options = {
      apiKey,
      serviceName: "insecure",
      captureContent: false,
      baseUrl: "http://otel-collector:4318",
    };
    expect(() => createHue(options)).toThrow(/allowInsecureHttp/);
    expect(() => createHue({ ...options, allowInsecureHttp: "yes" as never })).toThrow(TypeError);
    const hue = createHue({ ...options, allowInsecureHttp: true });
    try {
      expect(hue.enabled).toBe(true);
      expect(hue.transport.options.baseUrl).toBe("http://otel-collector:4318");
      const issues = hue.transport.getIssues();
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ kind: "warning", count: 0 });
      expect(issues[0].message).toContain("allowInsecureHttp");
      expect(hue.transport.getFailureSequence()).toBe(0);
    } finally {
      // Nothing was emitted, so shutdown sends no request to the unresolvable host.
      expect((await hue.shutdownSafe()).ok).toBe(true);
    }
    // Loopback never needed the opt-in and records no warning when it is set anyway.
    const loopback = createHue({
      apiKey,
      serviceName: "loopback",
      captureContent: false,
      baseUrl: "http://127.0.0.1:9",
      allowInsecureHttp: true,
    });
    expect(loopback.transport.getIssues()).toEqual([]);
    await loopback.shutdownSafe();
  });
  test("checkConnection exposes the underlying network or parsing error as cause", async () => {
    const closed = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("never"),
    });
    const closedUrl = `http://127.0.0.1:${closed.port}`;
    await closed.stop(true);
    const invalid = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ id: 42 }),
    });
    const unreachable = createHue({
      apiKey,
      serviceName: "cause",
      captureContent: false,
      baseUrl: closedUrl,
      timeoutMillis: 2000,
    });
    const malformed = createHue({
      apiKey,
      serviceName: "cause",
      captureContent: false,
      baseUrl: `http://127.0.0.1:${invalid.port}`,
    });
    try {
      const network = await unreachable.checkConnection().catch((error: unknown) => error);
      expect(network).toBeInstanceOf(HueConnectionError);
      expect((network as HueConnectionError).status).toBeUndefined();
      expect((network as HueConnectionError).cause).toBeInstanceOf(Error);
      const parsing = await malformed.checkConnection().catch((error: unknown) => error);
      expect(parsing).toBeInstanceOf(HueConnectionError);
      expect((parsing as HueConnectionError).message).toBe(
        "Hue returned an invalid project response",
      );
      expect((parsing as HueConnectionError).cause).toBeInstanceOf(Error);
    } finally {
      await unreachable.shutdownSafe();
      await malformed.shutdownSafe();
      invalid.stop(true);
    }
  });
  test("message records carry GenAI request attributes from the enclosing model span or the caller", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "message-attributes",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    try {
      await hue.withSpan(
        "request",
        async (root) => {
          await hue.model(
            "synthetic-model",
            async () => {
              hue.recordMessages({
                output: [{ role: "assistant", parts: [{ type: "text", content: "hi" }] }],
              });
            },
            { provider: "synthetic", operation: "generate_content" },
          );
          // Outside a model span the caller supplies the request metadata.
          hue.recordMessages({
            output: "plain",
            operation: "chat",
            provider: "caller",
            model: "caller-model",
          });
          // Without either source only the active session is stamped.
          hue.recordMessages({ output: "bare" });
          // An invalid explicit value is omitted and counted; the record is still emitted.
          hue.recordMessages({ output: "invalid", model: "" }, root.context);
        },
        { sessionId: "session-attributes" },
      );
      const result = await hue.flushSafe();
      expect(result.report.acceptedLogs).toBe(4);
      expect(result.report.instrumentationFailures).toBe(1);
      const logs = endpoint.requests
        .filter((request) => request.signal === "logs")
        .flatMap((request) => request.records);
      const byOutput = (text: string) =>
        logs.find((log) => JSON.stringify(log.body).includes(text))!;
      const inherited = byOutput("assistant");
      expect(attr(inherited, "gen_ai.operation.name")?.stringValue).toBe("generate_content");
      expect(attr(inherited, "gen_ai.provider.name")?.stringValue).toBe("synthetic");
      expect(attr(inherited, "gen_ai.request.model")?.stringValue).toBe("synthetic-model");
      expect(attr(inherited, "gen_ai.conversation.id")?.stringValue).toBe("session-attributes");
      const explicit = byOutput("plain");
      expect(attr(explicit, "gen_ai.operation.name")?.stringValue).toBe("chat");
      expect(attr(explicit, "gen_ai.provider.name")?.stringValue).toBe("caller");
      expect(attr(explicit, "gen_ai.request.model")?.stringValue).toBe("caller-model");
      expect(byOutput("bare").attributes?.map((item) => item.key)).toEqual([
        "gen_ai.conversation.id",
      ]);
      const invalid = byOutput("invalid");
      expect(attr(invalid, "gen_ai.request.model")).toBeUndefined();
      expect(attr(invalid, "gen_ai.conversation.id")?.stringValue).toBe("session-attributes");
    } finally {
      await hue.shutdown();
      endpoint.server.stop(true);
    }
  });
  test("inject and extract carry W3C trace context without baggage or credentials", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "propagation",
      captureContent: false,
      baseUrl: endpoint.url,
    });
    try {
      const carrier: Record<string, string> = {};
      let producerSpanId = "";
      await hue.withSpan("producer", (span) => {
        producerSpanId = span.spanId;
        hue.inject(carrier);
      });
      expect(Object.keys(carrier)).toEqual(["traceparent"]);
      expect(carrier.traceparent).toContain(producerSpanId);
      expect(JSON.stringify(carrier)).not.toContain(apiKey);
      const parentContext = hue.extract(carrier);
      await hue.withSpan("consumer", () => undefined, { parentContext });
      await hue.flush();
      const spans = endpoint.requests.flatMap((request) => request.records);
      const producer = spans.find((span) => span.name === "producer")!;
      const consumer = spans.find((span) => span.name === "consumer")!;
      // Wire identifiers are base64; the helper exposes hex, which the carrier must contain.
      expect(Buffer.from(producer.spanId, "base64").toString("hex")).toBe(producerSpanId);
      expect(consumer.parentSpanId).toBe(producer.spanId);
      expect(consumer.traceId).toBe(producer.traceId);
    } finally {
      await hue.shutdown();
      endpoint.server.stop(true);
    }
  });
  test("contentPrefixes lists every recognized content key, identical to the Python SDK", () => {
    expect(contentPrefixes).toEqual([
      "gen_ai.input.messages",
      "gen_ai.output.messages",
      "gen_ai.system_instructions",
      "gen_ai.prompt",
      "gen_ai.completion",
      "gen_ai.tool.call.arguments",
      "gen_ai.tool.call.result",
      "gen_ai.tool.definitions",
      "gen_ai.event.content",
      "llm.input_messages",
      "llm.output_messages",
      "llm.prompts",
      "llm.completions",
      "llm.invocation_parameters",
      "llm.prompt_template.template",
      "llm.prompt_template.variables",
      "llm.tools",
      "llm.function_call",
      "llm.choices",
      "input.value",
      "output.value",
      "input.images",
      "output.images",
      "retrieval.documents",
      "embedding.embeddings",
      "reranker.query",
      "reranker.input_documents",
      "reranker.output_documents",
      "ai.prompt",
      "ai.response.text",
      "ai.response.object",
      "ai.response.reasoning",
      "ai.response.files",
      "ai.response.toolCalls",
      "ai.response.body",
      "ai.toolCall.args",
      "ai.toolCall.result",
      "ai.value",
      "ai.values",
      "ai.embedding",
      "ai.embeddings",
      "traceloop.entity.input",
      "traceloop.entity.output",
      "tool.parameters",
      "exception.message",
      "exception.stacktrace",
    ]);
  });
  test.each([true, false])(
    "export strips every recognized content prefix from borrowed-provider spans (captureContent=%p)",
    async (captureContent) => {
      const endpoint = receiver();
      const transport = createHueTransport({
        apiKey,
        serviceName: "content-prefixes",
        captureContent,
        baseUrl: endpoint.url,
      });
      const tracerProvider = new TracerProvider({ spanProcessors: [transport.spanProcessor] });
      const loggerProvider = new LoggerProvider({ processors: [transport.logRecordProcessor] });
      const hue = createHue({ transport, tracerProvider, loggerProvider });
      try {
        const span = tracerProvider.getTracer("third-party").startSpan("external");
        for (const prefix of contentPrefixes) {
          span.setAttribute(prefix, "private-value");
          span.setAttribute(`${prefix}.0.content`, "private-value");
        }
        span.setAttribute("gen_ai.request.model", "synthetic-model");
        span.addEvent("gen_ai.user.message", { content: "private-value" });
        span.end();
        // An OpenInference retriever span: document text is content, the score is metadata.
        const retriever = tracerProvider.getTracer("third-party").startSpan("retrieve");
        retriever.setAttribute("openinference.span.kind", "RETRIEVER");
        retriever.setAttribute("retrieval.documents.0.document.content", "private-value");
        retriever.setAttribute("retrieval.documents.0.document.score", 0.42);
        retriever.setAttribute("ai.response.reasoning", "private-value");
        retriever.setAttribute("ai.response.finishReason", "stop");
        retriever.end();
        await hue.flush();
        const records = endpoint.requests.flatMap((request) => request.records);
        const record = records.find((candidate) => candidate.name === "external")!;
        const retrieved = records.find((candidate) => candidate.name === "retrieve")!;
        const retrievedKeys = (retrieved.attributes ?? []).map((attribute) => attribute.key);
        expect(retrievedKeys).toContain("openinference.span.kind");
        expect(retrievedKeys).toContain("ai.response.finishReason");
        expect(retrievedKeys.includes("retrieval.documents.0.document.content")).toBe(
          captureContent,
        );
        expect(retrievedKeys.includes("retrieval.documents.0.document.score")).toBe(captureContent);
        expect(retrievedKeys.includes("ai.response.reasoning")).toBe(captureContent);
        const keys = (record.attributes ?? []).map((attribute) => attribute.key);
        const content = keys.filter((key) =>
          contentPrefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}.`)),
        );
        expect(content).toHaveLength(captureContent ? contentPrefixes.length * 2 : 0);
        expect(keys).toContain("gen_ai.request.model");
        expect((record.events ?? []).some((event) => event.name === "gen_ai.user.message")).toBe(
          captureContent,
        );
        expect(endpoint.requests.some((request) => request.raw.includes("private-value"))).toBe(
          captureContent,
        );
      } finally {
        await hue.shutdown();
        await tracerProvider.shutdown();
        await loggerProvider.shutdown();
        await transport.shutdown();
        endpoint.server.stop(true);
      }
    },
  );
  test("export replaces hosted-tool credentials in tool definitions before redact", async () => {
    const endpoint = receiver();
    const seen: string[] = [];
    const transport = createHueTransport({
      apiKey,
      serviceName: "tool-credentials",
      captureContent: true,
      baseUrl: endpoint.url,
      redact: (value) => {
        seen.push(value);
        return value;
      },
    });
    const tracerProvider = new TracerProvider({ spanProcessors: [transport.spanProcessor] });
    const loggerProvider = new LoggerProvider({ processors: [transport.logRecordProcessor] });
    const hue = createHue({ transport, tracerProvider, loggerProvider });
    // OpenAI Responses hosted MCP tool as OpenInference records it, and a function tool whose
    // parameters are named like credentials: parameter schemas are not credentials.
    const hostedMcp = {
      type: "mcp",
      server_label: "gmail",
      server_url: "https://mcp.example.test/gmail",
      authorization: "synthetic-oauth-token",
      headers: { "X-Api-Key": "synthetic-header-secret" },
      require_approval: "never",
    };
    const fetchPage = JSON.stringify({
      type: "function",
      function: {
        name: "fetch_page",
        parameters: {
          type: "object",
          properties: { headers: { type: "object" }, api_key: { type: "string" } },
          required: ["headers"],
        },
      },
    });
    try {
      const span = tracerProvider.getTracer("third-party").startSpan("external");
      span.setAttribute("llm.tools.0.tool.json_schema", JSON.stringify(hostedMcp));
      span.setAttribute("llm.tools.1.tool.json_schema", fetchPage);
      span.setAttribute(
        "input.value",
        JSON.stringify({ model: "synthetic-model", input: "Synthetic prompt", tools: [hostedMcp] }),
      );
      // Anthropic's MCP connector and AI SDK 6's per-tool JSON strings.
      span.setAttribute(
        "llm.invocation_parameters",
        JSON.stringify({
          max_tokens: 100,
          mcp_servers: [
            {
              type: "url",
              url: "https://mcp.example.test/slack",
              name: "slack",
              authorization_token: "synthetic-oauth-token",
            },
          ],
        }),
      );
      span.setAttribute("ai.prompt.tools", [
        JSON.stringify({
          type: "provider",
          name: "gmail",
          id: "openai.mcp",
          args: { serverLabel: "gmail", authorization: "synthetic-oauth-token" },
        }),
        "not JSON: authorization",
      ]);
      span.setAttribute("gen_ai.tool.definitions", "not JSON: authorization");
      span.setAttribute("output.value", "The authorization field was set.");
      span.end();
      await hue.flush();
      const record = endpoint.requests
        .flatMap((request) => request.records)
        .find((candidate) => candidate.name === "external")!;
      const text = (key: string) => attr(record, key)!.stringValue!;
      expect(JSON.parse(text("llm.tools.0.tool.json_schema"))).toEqual({
        ...hostedMcp,
        authorization: "[redacted]",
        headers: "[redacted]",
      });
      expect(text("llm.tools.1.tool.json_schema")).toBe(fetchPage);
      expect(JSON.parse(text("input.value"))).toEqual({
        model: "synthetic-model",
        input: "Synthetic prompt",
        tools: [{ ...hostedMcp, authorization: "[redacted]", headers: "[redacted]" }],
      });
      expect(JSON.parse(text("llm.invocation_parameters")).mcp_servers[0].authorization_token).toBe(
        "[redacted]",
      );
      const promptTools = attr(record, "ai.prompt.tools")!.arrayValue!.values;
      expect(JSON.parse(promptTools[0].stringValue!).args).toEqual({
        serverLabel: "gmail",
        authorization: "[redacted]",
      });
      expect(promptTools[1].stringValue).toBe("not JSON: authorization");
      expect(text("gen_ai.tool.definitions")).toBe("not JSON: authorization");
      expect(text("output.value")).toBe("The authorization field was set.");
      const raw = endpoint.requests.map((request) => request.raw).join(" ");
      for (const secret of ["synthetic-oauth-token", "synthetic-header-secret"]) {
        expect(raw).not.toContain(secret);
        // The caller's redact runs after the scrub and never sees the credential either.
        expect(seen.some((value) => value.includes(secret))).toBe(false);
      }
    } finally {
      await hue.shutdown();
      await tracerProvider.shutdown();
      await loggerProvider.shutdown();
      await transport.shutdown();
      endpoint.server.stop(true);
    }
  });
  test("a tool definition too deeply nested to inspect rejects its record", async () => {
    const endpoint = receiver();
    const transport = createHueTransport({
      apiKey,
      serviceName: "tool-credentials-depth",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    const tracerProvider = new TracerProvider({ spanProcessors: [transport.spanProcessor] });
    const loggerProvider = new LoggerProvider({ processors: [transport.logRecordProcessor] });
    const hue = createHue({ transport, tracerProvider, loggerProvider });
    try {
      const span = tracerProvider.getTracer("third-party").startSpan("deep");
      span.setAttribute(
        "gen_ai.tool.definitions",
        `${'{"a":'.repeat(300)}{"authorization":"synthetic-oauth-token"}${"}".repeat(300)}`,
      );
      span.end();
      await expect(hue.flush()).rejects.toBeInstanceOf(HueExportError);
      expect(endpoint.requests).toHaveLength(0);
      expect(transport.getIssues()).toContainEqual(
        expect.objectContaining({ kind: "invalid", count: 1 }),
      );
    } finally {
      await hue.shutdown();
      await tracerProvider.shutdown();
      await loggerProvider.shutdown();
      await transport.shutdown();
      endpoint.server.stop(true);
    }
  });
  test.each([
    ["client", "traces"],
    ["transport", "traces"],
    ["client", "logs"],
    ["transport", "logs"],
  ] as const)(
    "%s flush drains %s emitted during an earlier delayed export",
    async (layer, signal) => {
      const gate = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => {
          resolve = done;
        });
        return { promise, resolve };
      };
      const firstEntered = gate(),
        firstRelease = gate(),
        secondEntered = gate(),
        secondRelease = gate();
      let batches = 0;
      const endpoint = receiver("success", undefined, async (currentSignal) => {
        if (currentSignal !== signal) return;
        const index = ++batches;
        if (index === 1) {
          firstEntered.resolve();
          await firstRelease.promise;
        }
        if (index === 2 && layer === "client") {
          secondEntered.resolve();
          await secondRelease.promise;
        }
      });
      const hue = createHue({
        apiKey,
        serviceName: "delayed-flush",
        captureContent: true,
        baseUrl: endpoint.url,
      });
      const emit = (name: string) =>
        hue.withSpan(name, () => {
          if (signal === "logs") hue.recordMessages({ output: name });
        });
      const flush = () => (layer === "client" ? hue.flush() : hue.transport.flush());
      const work: Promise<unknown>[] = [];
      try {
        await emit("first");
        work.push(flush());
        await firstEntered.promise;
        await emit("second");
        if (layer === "client") {
          // The owned provider drains first; transport then drains the second span.
          // Emit a third span while that final transport batch is still in flight.
          firstRelease.resolve();
          await secondEntered.promise;
          await emit("third");
        }
        const later = flush();
        work.push(later);
        firstRelease.resolve();
        secondRelease.resolve();
        const report = await later;
        expect(signal === "traces" ? report.acceptedSpans : report.acceptedLogs).toBe(
          layer === "client" ? 3 : 2,
        );
        expect(report.pendingSpans + report.pendingLogs).toBe(0);
        expect(
          endpoint.requests
            .filter((batch) => batch.signal === signal)
            .flatMap((batch) => batch.records),
        ).toHaveLength(layer === "client" ? 3 : 2);
      } finally {
        firstRelease.resolve();
        secondRelease.resolve();
        await Promise.allSettled(work);
        await hue.shutdown();
        endpoint.server.stop(true);
      }
    },
  );
  test("requires explicit capture policy and secure endpoints without credentials in errors", () => {
    for (const baseUrl of [
      "http://example.test",
      "https://user:password@example.test",
      "https://example.test?key=secret",
      "https://example.test#fragment",
      "https://example.test/api/v1",
      "https://example.test/api/v1/otlp/v1/traces",
      "https://example.test//",
    ])
      expect(() =>
        createHue({ apiKey, serviceName: "test", captureContent: true, baseUrl }),
      ).toThrow(TypeError);
    // Runtime JS users receive the same explicit-policy requirement as TypeScript callers.
    expect(() =>
      createHue({ apiKey, serviceName: "test" } as Parameters<typeof createHue>[0]),
    ).toThrow("Choose captureContent explicitly");
  });

  test("normalizes origin-only base URLs before project and export requests", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "origin",
      captureContent: false,
      baseUrl: `${endpoint.url}/`,
    });
    try {
      expect(hue.transport.options.baseUrl).toBe(endpoint.url);
      expect(await hue.checkConnection()).toEqual(project);
      await hue.withSpan("origin", () => {});
      expect((await hue.flush()).acceptedSpans).toBe(1);
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test("nests spans, propagates session/user IDs, preserves null and exports correlated logs", async () => {
    const endpoint = receiver();
    const globalProvider = trace.getTracerProvider();
    const globalContext = context.active();
    const hue = createHue({
      apiKey,
      serviceName: "external-chatbot",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    try {
      expect(await hue.checkConnection()).toEqual(project);
      await hue.withSpan(
        "chat",
        async (parent) => {
          parent.setOutput(null);
          await hue.tool("lookup", null, () => null);
          hue.recordMessages({ output: null });
        },
        { sessionId: "session-one", userId: "synthetic-user", input: { text: "hello" } },
      );
      const report = await hue.flush();
      expect(report).toEqual({
        acceptedSpans: 2,
        acceptedLogs: 1,
        rejectedSpans: 0,
        rejectedLogs: 0,
        failedSpans: 0,
        failedLogs: 0,
        pendingSpans: 0,
        pendingLogs: 0,
        droppedSpans: 0,
        droppedLogs: 0,
        pendingBytes: 0,
        instrumentationFailures: 0,
      });
      const spans = endpoint.requests
        .filter((request) => request.signal === "traces")
        .flatMap((request) => request.records);
      const parent = spans.find((span) => span.name === "chat")!;
      const tool = spans.find((span) => span.name === "execute_tool lookup")!;
      expect(tool.traceId).toBe(parent.traceId);
      expect(tool.parentSpanId).toBe(parent.spanId);
      expect(attr(tool, "gen_ai.operation.name")?.stringValue).toBe("execute_tool");
      expect(attr(tool, "gen_ai.tool.name")?.stringValue).toBe("lookup");
      expect(attr(parent, "output.value")?.stringValue).toBe("null");
      expect(attr(tool, "gen_ai.tool.call.result")?.stringValue).toBe("null");
      expect(
        spans.every((span) => attr(span, "gen_ai.conversation.id")?.stringValue === "session-one"),
      ).toBe(true);
      expect(spans.every((span) => attr(span, "user.id")?.stringValue === "synthetic-user")).toBe(
        true,
      );
      const log = endpoint.requests.find((request) => request.signal === "logs")!.records[0];
      expect(log.traceId).toBe(parent.traceId);
      expect(log.spanId).toBe(parent.spanId);
      expect(
        log.body?.kvlistValue?.values.find(
          (attribute) => attribute.key === "gen_ai.output.messages",
        )?.value,
      ).toEqual({});
      expect(trace.getTracerProvider()).toBe(globalProvider);
      expect(context.active()).toBe(globalContext);
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test("metadata-only capture removes supported content including errors and tools", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "test",
      captureContent: false,
      baseUrl: endpoint.url,
    });
    try {
      await expect(
        hue.withSpan(
          "failure",
          async ({ span }) => {
            span.setAttribute("ai.prompt.messages", "private synthetic content");
            span.setAttribute("gen_ai.input.messages", "private synthetic content");
            await hue.tool("lookup", { private: "synthetic content" }, () => null);
            hue.recordMessages({ input: "private synthetic content" });
            throw new Error("private synthetic content");
          },
          { input: "private synthetic content" },
        ),
      ).rejects.toThrow("private synthetic content");
      await hue.flush();
      expect(endpoint.requests.map((request) => request.raw).join(" ")).not.toContain(
        "private synthetic content",
      );
      expect(
        endpoint.requests
          .flatMap((request) => request.records)
          .some((span) => span.status?.code === 2),
      ).toBe(true);
      expect(endpoint.requests.every((request) => request.signal === "traces")).toBe(true);
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test("redaction happens before export and callback errors fail closed", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "test",
      captureContent: true,
      baseUrl: endpoint.url,
      redact: (text) => text.replaceAll("customer-secret", "[redacted]"),
    });
    try {
      await hue.withSpan("request", ({ setOutput }) => {
        setOutput({ text: "customer-secret" });
        hue.recordMessages({ output: [{ content: "customer-secret" }] });
      });
      await hue.flush();
      expect(endpoint.requests.map((request) => request.raw).join(" ")).not.toContain(
        "customer-secret",
      );
      expect(endpoint.requests.map((request) => request.raw).join(" ")).toContain("[redacted]");
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
    const failedEndpoint = receiver();
    const failed = createHue({
      apiKey,
      serviceName: "test",
      captureContent: true,
      baseUrl: failedEndpoint.url,
      redact: () => {
        throw new Error(`private ${apiKey}`);
      },
    });
    try {
      await failed.withSpan("request", ({ setOutput }) => setOutput("private text"));
      await expect(failed.flush()).rejects.toBeInstanceOf(HueExportError);
      expect(failedEndpoint.requests).toHaveLength(0);
      expect(JSON.stringify(failed.transport.getIssues())).not.toContain(apiKey);
    } finally {
      await failed.shutdown();
      await failedEndpoint.server.stop(true);
    }
  });

  test.each(["partial", "unauthorized", "malformed"] as const)(
    "%s acknowledgement is surfaced truthfully without response text",
    async (mode) => {
      const endpoint = receiver(mode);
      const hue = createHue({
        apiKey,
        serviceName: "test",
        captureContent: true,
        baseUrl: endpoint.url,
      });
      try {
        await hue.withSpan("request", () => {
          hue.recordMessages({ output: null });
        });
        const firstFlush = hue.flush();
        const concurrentFlush = hue.flush();
        expect(concurrentFlush).not.toBe(firstFlush);
        const outcomes = await Promise.allSettled([firstFlush, concurrentFlush]);
        for (const outcome of outcomes) {
          expect(outcome.status).toBe("rejected");
          if (outcome.status === "rejected") expect(outcome.reason).toBeInstanceOf(HueExportError);
        }
        expect(hue.transport.getReport().acceptedSpans).toBe(0);
        expect(
          hue.transport.getReport()[mode === "partial" ? "rejectedSpans" : "failedSpans"],
        ).toBe(1);
        expect(JSON.stringify(hue.transport.getIssues())).not.toContain(apiKey);
        expect(hue.transport.getReport().acceptedLogs).toBe(0);
        expect(hue.transport.getReport()[mode === "partial" ? "rejectedLogs" : "failedLogs"]).toBe(
          1,
        );
        if (mode === "unauthorized") {
          for (const signal of ["traces", "logs"] as const) {
            const recordIssues = hue.transport
              .getIssues()
              .filter((issue) => issue.signal === signal && issue.count > 0);
            expect(recordIssues).toEqual([
              expect.objectContaining({ signal, kind: "failed", count: 1, status: 401 }),
            ]);
          }
        }
        expect(hue.transport.getReport().pendingSpans).toBe(0);
        expect(hue.transport.getReport().pendingLogs).toBe(0);
        expect(endpoint.hits()).toBe(2);
      } finally {
        await hue.shutdown();
        await endpoint.server.stop(true);
      }
    },
  );

  test("warning-only acknowledgements remain successful and surface sanitized diagnostics", async () => {
    const endpoint = receiver("warning");
    const hue = createHue({
      apiKey,
      serviceName: "warnings",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    try {
      await hue.withSpan("warning", () => hue.recordMessages({ output: null }));
      const report = await hue.flush();
      expect(report.acceptedSpans).toBe(1);
      expect(report.acceptedLogs).toBe(1);
      expect(
        report.failedSpans + report.failedLogs + report.rejectedSpans + report.rejectedLogs,
      ).toBe(0);
      expect(hue.transport.getIssues().every((issue) => issue.kind === "warning")).toBe(true);
      expect(JSON.stringify(hue.transport.getIssues())).not.toContain(apiKey);
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test("retryable failure is retried after Retry-After and accepted once", async () => {
    const endpoint = receiver("retry");
    const hue = createHue({
      apiKey,
      serviceName: "test",
      captureContent: false,
      baseUrl: endpoint.url,
      timeoutMillis: 5000,
    });
    try {
      await hue.withSpan("retry", () => {});
      const started = Date.now();
      expect((await hue.flush()).acceptedSpans).toBe(1);
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      expect(endpoint.hits()).toBe(2);
      expect(hue.transport.getIssues()).toEqual([]);
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test.each([
    ["a client error is not retried", 401, {}],
    ["a Retry-After beyond the request budget is not awaited", 503, { "Retry-After": "30" }],
    ["an acknowledgement over 4 MiB is not accepted", 200, {}],
  ] as const)("%s", async (_name, status, headers) => {
    let hits = 0;
    const endpoint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        hits++;
        await request.arrayBuffer();
        const body = status === 200 ? new Uint8Array(4 * 1024 * 1024 + 1) : "synthetic failure";
        return new Response(body, { status, headers });
      },
    });
    const hue = createHue({
      apiKey,
      serviceName: "transport-rules",
      captureContent: false,
      baseUrl: `http://127.0.0.1:${endpoint.port}`,
      timeoutMillis: 2000,
    });
    try {
      await hue.withSpan("request", () => {});
      const started = Date.now();
      const error = await hue.flush().catch((reason: unknown) => reason);
      expect(Date.now() - started).toBeLessThan(1500);
      expect(error).toBeInstanceOf(HueExportError);
      const lost = (error as HueExportError).issues.filter((issue) => issue.count > 0);
      expect(lost).toEqual([expect.objectContaining({ kind: "failed", count: 1 })]);
      // A retryable status that is not retried reports no status, as OpenTelemetry's exporter did.
      expect(lost[0]!.status).toBe(status === 401 ? 401 : undefined);
      expect(hits).toBe(1);
    } finally {
      await hue.shutdown();
      await endpoint.stop(true);
    }
  });

  test("a receiver that never acknowledges fails the export at its deadline and is disconnected", async () => {
    let disconnected!: () => void;
    const closed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const endpoint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        return new Promise<Response>((resolve) => {
          request.signal.addEventListener("abort", () => {
            disconnected();
            resolve(new Response(null));
          });
        });
      },
    });
    const hue = createHue({
      apiKey,
      serviceName: "hung",
      captureContent: false,
      baseUrl: `http://127.0.0.1:${endpoint.port}`,
      timeoutMillis: 300,
    });
    try {
      await hue.withSpan("unacknowledged", () => {});
      const start = Date.now();
      const error = await hue.flush().catch((reason: unknown) => reason);
      expect(Date.now() - start).toBeLessThan(2000);
      expect(error).toBeInstanceOf(HueExportError);
      expect((error as HueExportError).report).toMatchObject({ acceptedSpans: 0, failedSpans: 1 });
      await closed;
    } finally {
      await hue.shutdown();
      await endpoint.stop(true);
    }
  });

  test("project checks and OTLP exporters never follow redirects with the API key", async () => {
    let leakedRequests = 0;
    const destination = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        leakedRequests++;
        return new Response("Unexpected request");
      },
    });
    const endpoint = receiver("redirect", `http://127.0.0.1:${destination.port}`);
    const hue = createHue({
      apiKey,
      serviceName: "test",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    try {
      await expect(hue.checkConnection()).rejects.toBeInstanceOf(HueConnectionError);
      await hue.withSpan("request", () => {});
      await expect(hue.flush()).rejects.toBeInstanceOf(HueExportError);
      expect(leakedRequests).toBe(0);
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
      await destination.stop(true);
    }
  });

  test("existing providers export through explicitly attached processors and remain usable", async () => {
    const endpoint = receiver();
    const transport = createHueTransport({
      apiKey,
      serviceName: "external",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    const tracerProvider = new TracerProvider({ spanProcessors: [transport.spanProcessor] });
    const loggerProvider = new LoggerProvider({ processors: [transport.logRecordProcessor] });
    const hue = createHue({ transport, tracerProvider, loggerProvider });
    try {
      await hue.withSpan("bound-client", () => {});
      await hue.shutdown();
      const external = tracerProvider.getTracer("external").startSpan("still-running");
      external.end();
      await tracerProvider.forceFlush();
      expect((await transport.flush()).acceptedSpans).toBe(2);
    } finally {
      await tracerProvider.shutdown();
      await loggerProvider.shutdown();
      await transport.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test("queue overflow reports exact losses while flushing accepted siblings", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "overflow",
      captureContent: false,
      baseUrl: endpoint.url,
    });
    try {
      for (let index = 0; index < 2200; index++) hue.tracer.startSpan("burst").end();
      await expect(hue.flush()).rejects.toBeInstanceOf(HueExportError);
      const report = hue.transport.getReport();
      expect(report.acceptedSpans + report.failedSpans).toBe(2200);
      expect(report.failedSpans).toBeGreaterThan(0);
      expect(report.pendingSpans).toBe(0);
      expect(hue.transport.getIssues().some((issue) => issue.kind === "dropped")).toBe(true);
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test("shutdown waits for both signals and rejects their export failures", async () => {
    const endpoint = receiver("unauthorized");
    const hue = createHue({
      apiKey,
      serviceName: "shutdown",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    try {
      await hue.withSpan("shutdown", () => hue.recordMessages({ input: "synthetic" }));
      await expect(hue.shutdown()).rejects.toBeInstanceOf(HueExportError);
      const report = hue.transport.getReport();
      expect(report.failedSpans).toBe(1);
      expect(report.failedLogs).toBe(1);
      expect(report.pendingSpans + report.pendingLogs).toBe(0);
    } finally {
      await endpoint.server.stop(true);
    }
  });

  test("serializes large content across bounded requests without dropping sibling spans", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "test",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    try {
      for (let i = 0; i < 8; i++)
        await hue.withSpan(`record-${i}`, ({ setOutput }) => setOutput("x".repeat(200000)));
      expect((await hue.flush()).acceptedSpans).toBe(8);
      expect(endpoint.requests.length).toBeGreaterThan(1);
      expect(endpoint.requests.every((request) => request.bytes <= 1024 * 1024)).toBe(true);
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });
});

const usage = {
  inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};

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
});

describe("Application failure isolation", () => {
  test("content proxies cannot invoke traps or mutate application inputs and results", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "proxy-content",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    let traps = 0;
    let executions = 0;
    const live = { value: "unchanged" };
    const forbidden = () => {
      traps++;
      live.value = "modified by capture";
      throw new Error("application proxy trap");
    };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const proxies = [
      new Proxy(live, { ownKeys: forbidden }),
      new Proxy([], { get: forbidden }),
      revoked.proxy,
    ];
    try {
      for (const proxy of proxies) {
        const input = { nested: proxy };
        const output = { nested: proxy };
        expect(
          await hue.tool("proxy-content", input, () => {
            executions++;
            expect(live.value).toBe("unchanged");
            return output;
          }),
        ).toBe(output);
      }
      expect(traps).toBe(0);
      expect(executions).toBe(proxies.length);
      expect(live.value).toBe("unchanged");
      expect(hue.transport.getReport().instrumentationFailures).toBe(proxies.length * 2);
      await hue.shutdownSafe();
      expect(endpoint.requests.flatMap((request) => request.records)).toHaveLength(proxies.length);
      expect(endpoint.requests.map((request) => request.raw).join(" ")).not.toContain("nested");
    } finally {
      await hue.shutdownSafe();
      endpoint.server.stop(true);
    }
  });

  test("invalid capture never prevents a callback or changes a completed side effect", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "safe",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let getterCalls = 0;
    const accessor = {
      get private() {
        getterCalls++;
        throw new Error(apiKey);
      },
    };
    const invalid = ["x".repeat(262144), cyclic, accessor, { n: NaN }, 1n];
    try {
      let executions = 0;
      for (const value of invalid) {
        const result = await hue.withSpan(
          "safe",
          async (span) => {
            span.setOutput(value);
            hue.recordMessages({ output: value });
            return hue.tool("effect", value, () => {
              executions++;
              return value;
            });
          },
          { input: value },
        );
        expect(result as unknown).toBe(value);
      }
      expect(executions).toBe(invalid.length);
      expect(getterCalls).toBe(0);
      expect(hue.transport.getReport().instrumentationFailures).toBe(25);
      await expect(hue.flush()).rejects.toBeInstanceOf(HueExportError);
      expect(hue.transport.getReport().acceptedSpans).toBe(10);
      expect(JSON.stringify(hue.transport.getIssues())).not.toContain(apiKey);
    } finally {
      await hue.shutdownSafe();
      endpoint.server.stop(true);
    }
  });

  test("invalid identifiers and telemetry setup still execute exactly once", async () => {
    const hue = createHue({ apiKey, serviceName: "safe", captureContent: true });
    let executions = 0;
    for (const options of [
      { sessionId: "" },
      { userId: "\u0000" },
      { parentContext: {} as never },
    ]) {
      expect(
        await hue.withSpan(
          "invalid",
          () => {
            executions++;
            return 42;
          },
          options,
        ),
      ).toBe(42);
    }
    expect(executions).toBe(3);
    expect(hue.transport.getReport().instrumentationFailures).toBeGreaterThan(0);
    await hue.shutdownSafe();
  });

  test("borrowed provider failures in start, recording, logging and end cannot replace business errors", async () => {
    const transport = createHueTransport({
      apiKey,
      serviceName: "broken-provider",
      captureContent: true,
    });
    const fail = () => {
      throw new Error(apiKey);
    };
    const source = new Proxy({}, { get: () => fail });
    const hue = createHue({
      transport,
      tracerProvider: {
        getTracer: () => ({ startSpan: () => source, startActiveSpan: fail }),
        async forceFlush() {},
      } as never,
      loggerProvider: { getLogger: () => ({ emit: fail }), async forceFlush() {} } as never,
    });
    const original = new Error("business failure");
    Object.defineProperty(original, "stack", { get: fail });
    let executions = 0;
    try {
      expect(
        await hue.withSpan("success", ({ span }) => {
          executions++;
          span.setAttribute("example", "value").addEvent("test");
          hue.recordMessages({ output: null });
          return original;
        }),
      ).toBe(original);
      await expect(
        hue.withSpan("failure", () => {
          executions++;
          throw original;
        }),
      ).rejects.toBe(original);
      expect(executions).toBe(2);
      expect(hue.transport.getReport().instrumentationFailures).toBeGreaterThan(0);
    } finally {
      await hue.shutdownSafe();
      await transport.shutdown().catch(() => {});
    }
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

  test("non-boolean enabled values fail strict initialization and safely disable telemetry", async () => {
    const endpoint = receiver();
    try {
      for (const enabled of ["false", "true", 0, 1, null, {}]) {
        const options = {
          apiKey,
          serviceName: "invalid-enabled",
          captureContent: false,
          enabled,
          baseUrl: endpoint.url,
        } as never;
        expect(() => createHue(options)).toThrow(new TypeError("enabled must be a boolean"));
        expect(() => createHueTransport(options)).toThrow(
          new TypeError("enabled must be a boolean"),
        );
        const hue = createHueSafe(options);
        expect(hue.enabled).toBe(false);
        let executions = 0;
        expect(
          await hue.withSpan("disabled", () => {
            executions++;
            return 42;
          }),
        ).toBe(42);
        expect(executions).toBe(1);
        await hue.shutdownSafe();
        expect(hue.transport.getReport().instrumentationFailures).toBe(1);
      }
      expect(endpoint.hits()).toBe(0);
    } finally {
      endpoint.server.stop(true);
    }
  });

  test("safe shutdown preserves an application exception during a collector outage", async () => {
    const endpoint = receiver("unauthorized");
    const hue = createHue({
      apiKey,
      serviceName: "unavailable",
      captureContent: false,
      baseUrl: endpoint.url,
    });
    const original = new Error("business failure");
    const result = (async () => {
      try {
        return await hue.withSpan("failure", () => {
          throw original;
        });
      } finally {
        expect((await hue.shutdownSafe()).ok).toBe(false);
      }
    })();
    await expect(result).rejects.toBe(original);
    expect(hue.transport.getReport().failedSpans).toBe(1);
    endpoint.server.stop(true);
  });

  test("safe lifecycle returns within budget for a hung borrowed provider without queuing new drains", async () => {
    const transport = createHueTransport({ apiKey, serviceName: "hung", captureContent: false });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const tracer = new TracerProvider({});
    const logger = new LoggerProvider({});
    const hue = createHue({
      transport,
      tracerProvider: {
        getTracer: tracer.getTracer.bind(tracer),
        forceFlush: () => {
          calls++;
          return wait;
        },
      },
      loggerProvider: logger,
    });
    const start = Date.now();
    const first = hue.flushSafe({ timeoutMillis: 25 });
    expect(await first).toMatchObject({ ok: false, timedOut: true });
    expect(Date.now() - start).toBeLessThan(500);
    for (let i = 0; i < 100; i++) expect(hue.flushSafe()).toBe(first);
    expect(calls).toBe(1);
    release();
    await hue.shutdownSafe();
    await tracer.shutdown();
    await logger.shutdown();
    await transport.shutdown();
  });

  test("queue byte budget applies to both signals and includes work in flight", async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const endpoint = receiver("success", undefined, async () => {
      enter();
      await blocked;
    });
    const maxQueueBytes = 64 * 1024;
    const hue = createHue({
      apiKey,
      serviceName: "bytes",
      captureContent: true,
      baseUrl: endpoint.url,
      maxQueueBytes,
    });
    await hue.withSpan("first", ({ setOutput }) => setOutput("x".repeat(20000)));
    const drain = hue.flush().catch((error) => error);
    await entered;
    for (let i = 0; i < 20; i++)
      await hue.withSpan("burst", () => hue.recordMessages({ output: "y".repeat(20000) }), {
        input: "z".repeat(20000),
      });
    const pending = hue.transport.getReport();
    expect(pending.pendingBytes).toBeGreaterThan(40000);
    expect(pending.pendingBytes).toBeLessThanOrEqual(maxQueueBytes);
    expect(pending.droppedSpans).toBe(20);
    expect(pending.droppedLogs).toBe(20);
    release();
    expect(await drain).toBeInstanceOf(HueExportError);
    expect(hue.transport.getReport()).toMatchObject({
      acceptedSpans: 1,
      failedSpans: 20,
      failedLogs: 20,
      pendingBytes: 0,
    });
    await hue.shutdownSafe();
    endpoint.server.stop(true);
  });

  test("async diagnostic rejections cannot reject business requests", async () => {
    const endpoint = receiver("unauthorized");
    let calls = 0;
    const hue = createHue({
      apiKey,
      serviceName: "diagnostics",
      captureContent: true,
      baseUrl: endpoint.url,
      onExportIssue: async () => {
        calls++;
        throw new Error(apiKey);
      },
    });
    expect(await hue.withSpan("request", () => "ok", { input: "x".repeat(300000) })).toBe("ok");
    await hue.flushSafe();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(1);
    expect(hue.transport.getReport().instrumentationFailures).toBe(1);
    await hue.shutdownSafe();
    endpoint.server.stop(true);
  });
});

test("array-heavy records admitted within the byte budget are exported, not failed as invalid", async () => {
  const endpoint = receiver();
  const maxQueueBytes = 65536;
  const hue = createHue({
    apiKey,
    serviceName: "arrays",
    captureContent: true,
    baseUrl: endpoint.url,
    maxQueueBytes,
  });
  // An embedding-sized numeric array: admission charges its elements as nodes only, so
  // export accounting must not add per-index key costs and refuse the admitted record.
  const embedding = Array.from({ length: 3072 }, (_, index) => index / 3072);
  expect(await hue.withSpan("embed", () => "ok", { attributes: { embedding } })).toBe("ok");
  const admitted = hue.transport.getReport();
  expect(admitted.droppedSpans).toBe(0);
  expect(admitted.pendingBytes).toBeGreaterThan(3072 * 16);
  expect(admitted.pendingBytes).toBeLessThanOrEqual(maxQueueBytes);
  expect(await hue.flush()).toMatchObject({ acceptedSpans: 1, failedSpans: 0, pendingBytes: 0 });
  expect(hue.transport.getIssues()).toEqual([]);
  expect(endpoint.requests.filter((request) => request.signal === "traces")).toHaveLength(1);
  await hue.shutdownSafe();
  endpoint.server.stop(true);
});

test("redaction expansion is bounded and loses telemetry rather than an application result", async () => {
  const endpoint = receiver();
  const hue = createHue({
    apiKey,
    serviceName: "expansion",
    captureContent: true,
    baseUrl: endpoint.url,
    maxQueueBytes: 65536,
    redact: (value) => (value === "expand" ? "x".repeat(20000) : value),
  });
  for (let i = 0; i < 10; i++)
    expect(await hue.withSpan("record", () => 42, { attributes: { custom: "expand" } })).toBe(42);
  await expect(hue.flush()).rejects.toBeInstanceOf(HueExportError);
  expect(hue.transport.getReport()).toMatchObject({
    acceptedSpans: 1,
    failedSpans: 9,
    pendingBytes: 0,
  });
  await hue.shutdownSafe();
  endpoint.server.stop(true);
});

describe("Queued telemetry snapshots", () => {
  test("byte array accessors cannot bypass the aggregate queue limit", async () => {
    const endpoint = receiver();
    const transport = createHueTransport({
      apiKey,
      serviceName: "byte-budget",
      captureContent: true,
      baseUrl: endpoint.url,
      maxQueueBytes: 8192,
    });
    const provider = new LoggerProvider({ processors: [transport.logRecordProcessor] });
    let getters = 0;
    const body = new Uint8Array(1_000_000);
    Object.defineProperty(body, "byteLength", {
      get() {
        getters++;
        return 1;
      },
    });
    try {
      provider.getLogger("byte-budget").emit({ body });
      expect(getters).toBe(0);
      expect(transport.getReport()).toMatchObject({
        droppedLogs: 1,
        pendingLogs: 0,
        pendingBytes: 0,
      });
      provider.getLogger("byte-budget").emit({ body: Buffer.from([1, 2, 3]) });
      await provider.forceFlush();
      await expect(transport.flush()).rejects.toBeInstanceOf(HueExportError);
      expect(transport.getReport()).toMatchObject({ acceptedLogs: 1, pendingBytes: 0 });
      expect(endpoint.requests).toHaveLength(1);
      expect(endpoint.requests[0]!.raw).toContain("AQID");
    } finally {
      await provider.shutdown();
      await transport.shutdown().catch(() => {});
      endpoint.server.stop(true);
    }
  });

  test("borrowed log proxies are dropped without executing application traps", async () => {
    const endpoint = receiver();
    const transport = createHueTransport({
      apiKey,
      serviceName: "proxy-log",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    const provider = new LoggerProvider({ processors: [transport.logRecordProcessor] });
    let traps = 0;
    const forbidden = () => {
      traps++;
      throw new Error("application proxy trap");
    };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    try {
      for (const body of [new Proxy({}, { getPrototypeOf: forbidden }), revoked.proxy])
        provider.getLogger("proxy-log").emit({ body });
      expect(traps).toBe(0);
      expect(transport.getReport()).toMatchObject({
        droppedLogs: 2,
        pendingLogs: 0,
        pendingBytes: 0,
      });
      await provider.forceFlush();
      await expect(transport.flush()).rejects.toBeInstanceOf(HueExportError);
      expect(endpoint.hits()).toBe(0);
    } finally {
      await provider.shutdown();
      await transport.shutdown().catch(() => {});
      endpoint.server.stop(true);
    }
  });

  test("mutating borrowed log data after emit cannot change queued bytes or exported values", async () => {
    const endpoint = receiver();
    const transport = createHueTransport({
      apiKey,
      serviceName: "snapshot",
      captureContent: true,
      baseUrl: endpoint.url,
      maxQueueBytes: 8192,
    });
    const resourceValues = ["resource-before"];
    const scopeValues = ["scope-before"];
    const attributes = { nested: ["attribute-before"] };
    const bytes = new Uint8Array([1, 2, 3]);
    const body = { value: "body-before", bytes };
    const provider = new LoggerProvider({
      resource: resourceFromAttributes({ example: resourceValues }),
      processors: [transport.logRecordProcessor],
    });
    try {
      provider
        .getLogger("snapshot", "1", { attributes: { example: scopeValues } })
        .emit({ body, attributes });
      const queued = transport.getReport();
      expect(queued.pendingLogs).toBe(1);
      expect(queued.pendingBytes).toBeLessThanOrEqual(8192);
      body.value = "mutated-secret".repeat(100000);
      bytes.fill(255);
      attributes.nested[0] = "attribute-mutated";
      resourceValues[0] = "resource-mutated";
      scopeValues[0] = "scope-mutated";
      expect(transport.getReport().pendingBytes).toBe(queued.pendingBytes);
      await provider.forceFlush();
      expect((await transport.flush()).acceptedLogs).toBe(1);
      const raw = endpoint.requests.map((request) => request.raw).join(" ");
      for (const original of [
        "body-before",
        "attribute-before",
        "resource-before",
        "scope-before",
        "AQID",
      ])
        expect(raw).toContain(original);
      for (const changed of [
        "mutated-secret",
        "attribute-mutated",
        "resource-mutated",
        "scope-mutated",
        "////",
      ])
        expect(raw).not.toContain(changed);
      expect(transport.getReport().pendingBytes).toBe(0);
    } finally {
      await provider.shutdown();
      await transport.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("span snapshots detach events, links, trace state and resource attributes before admission", async () => {
    const endpoint = receiver();
    const transport = createHueTransport({
      apiKey,
      serviceName: "snapshot",
      captureContent: true,
      baseUrl: endpoint.url,
      maxQueueBytes: 16384,
    });
    let traceState = "vendor=before";
    const state = { serialize: () => traceState } as TraceState;
    const resourceValues = ["resource-before"];
    const provider = new TracerProvider({
      resource: resourceFromAttributes({ example: resourceValues }),
      spanProcessors: [
        transport.spanProcessor,
        {
          onStart() {},
          async forceFlush() {},
          async shutdown() {},
          onEnd(record) {
            // A later borrowed processor can mutate the source object it receives.
            record.attributes["custom"] = "attribute-mutated";
            record.events[0]!.attributes!["custom"] = "event-mutated";
            record.links[0]!.attributes!["custom"] = "link-mutated";
          },
        },
      ],
    });
    try {
      const source = provider.getTracer("snapshot", "1").startSpan("snapshot", {
        attributes: { custom: "attribute-before" },
        links: [
          {
            context: {
              traceId: "f".repeat(32),
              spanId: "f".repeat(16),
              traceFlags: 1,
              traceState: state,
            },
            attributes: { custom: "link-before" },
          },
        ],
      });
      source.addEvent("event", { custom: "event-before" });
      source.end();
      const before = transport.getReport().pendingBytes;
      resourceValues[0] = "resource-mutated".repeat(100000);
      traceState = "vendor=after";
      expect(transport.getReport().pendingBytes).toBe(before);
      await provider.forceFlush();
      expect((await transport.flush()).acceptedSpans).toBe(1);
      const raw = endpoint.requests.map((request) => request.raw).join(" ");
      for (const original of [
        "resource-before",
        "attribute-before",
        "event-before",
        "link-before",
        "vendor=before",
      ])
        expect(raw).toContain(original);
      expect(raw).not.toContain("mutated");
      expect(raw).not.toContain("vendor=after");
      expect(transport.getReport().pendingBytes).toBe(0);
    } finally {
      await provider.shutdown();
      await transport.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("unresolved resource attributes are omitted with a warning and appear on later records", async () => {
    const endpoint = receiver();
    const transport = createHueTransport({
      apiKey,
      serviceName: "snapshot",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const resource = detectResources({
      detectors: [{ detect: () => ({ attributes: { sync: "available", async: pending } }) }],
    });
    const provider = new LoggerProvider({ resource, processors: [transport.logRecordProcessor] });
    try {
      provider.getLogger("snapshot").emit({ body: "before-detection" });
      expect(transport.getIssues()).toEqual([
        expect.objectContaining({ kind: "warning", count: 0 }),
      ]);
      await provider.forceFlush();
      expect((await transport.flush()).acceptedLogs).toBe(1);
      expect(endpoint.requests[0]!.raw).toContain("available");
      expect(endpoint.requests[0]!.raw).not.toContain("detected");
      resolve("detected");
      await resource.waitForAsyncAttributes?.();
      provider.getLogger("snapshot").emit({ body: "after-detection" });
      await provider.forceFlush();
      expect((await transport.flush()).acceptedLogs).toBe(2);
      expect(endpoint.requests[1]!.raw).toContain("detected");
    } finally {
      resolve("detected");
      await provider.shutdown();
      await transport.shutdown();
      endpoint.server.stop(true);
    }
  });
});

describe("model() metadata validation", () => {
  test("a disabled client runs the callback and records no instrumentation failure", async () => {
    const hue = createHue({ enabled: false });
    const result = await hue.model(
      "",
      async (span) => {
        span.setInput({ messages: [] });
        span.setUsage({ inputTokens: -1 });
        return "ok";
      },
      { provider: "", operation: " " },
    );
    expect(result).toBe("ok");
    expect(hue.transport.getReport().instrumentationFailures).toBe(0);
    expect((await hue.flushSafe()).ok).toBe(true);
    await hue.shutdownSafe();
  });

  test("an active client still counts invalid metadata", async () => {
    const hue = createHue({
      apiKey: "hue_test_key",
      serviceName: "model-metadata",
      captureContent: false,
      baseUrl: "http://127.0.0.1:9",
    });
    await hue.model("", async () => "ok", { provider: "synthetic" });
    expect(hue.transport.getReport().instrumentationFailures).toBe(1);
    await hue.shutdownSafe({ timeoutMillis: 200 });
  });
});

describe("warning issues", () => {
  test("do not consume the once-a-second onExportIssue slot", async () => {
    const seen: string[] = [];
    const hue = createHue({
      apiKey: "hue_test_key",
      serviceName: "warning-slot",
      captureContent: false,
      baseUrl: "http://collector.internal:4318",
      allowInsecureHttp: true,
      onExportIssue: (issue) => {
        seen.push(issue.kind);
      },
    });
    // The warning's callback settles over two microtasks; wait for a macrotask before the failure.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // `issue` is @internal (stripped from the published declarations); reach it through a cast so
    // the installed-package typecheck of this file still passes.
    (
      hue.transport as unknown as {
        issue(signal: "traces", kind: "failed", count: number, message: string): void;
      }
    ).issue("traces", "failed", 1, "synthetic failure");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual(["warning", "failed"]);
    await hue.shutdownSafe({ timeoutMillis: 200 });
  });
});

describe("OpenTelemetry interoperability", () => {
  test("helpers make their span the active OpenTelemetry span when a context manager is registered", async () => {
    const endpoint = receiver();
    const previousContext = context.active();
    const manager = new AsyncLocalStorageContextManager().enable();
    expect(context.setGlobalContextManager(manager)).toBe(true);
    const transport = createHueTransport({
      apiKey,
      serviceName: "interop",
      captureContent: false,
      baseUrl: endpoint.url,
    });
    const tracerProvider = new TracerProvider({ spanProcessors: [transport.spanProcessor] });
    const loggerProvider = new LoggerProvider({ processors: [transport.logRecordProcessor] });
    expect(trace.setGlobalTracerProvider(tracerProvider)).toBe(true);
    const hue = createHue({ transport, tracerProvider, loggerProvider });
    const disabled = createHue({ enabled: false });
    const ids: Record<string, string> = {};
    const carrier: Record<string, string> = {};
    const activeSpanId = () => trace.getActiveSpan()?.spanContext().spanId;
    try {
      await hue.withSpan("request", async (request) => {
        ids.request = request.spanId;
        expect(activeSpanId()).toBe(request.spanId);
        // Instrumentation that only knows the global API (HTTP clients, provider SDKs) joins the trace.
        trace.getTracer("third-party-instrumentation").startSpan("HTTP POST").end();
        await hue.tool("lookup", null, () => {
          ids.tool = activeSpanId() ?? "";
          return null;
        });
        await hue.model(
          "synthetic-model",
          () => {
            ids.model = activeSpanId() ?? "";
            return null;
          },
          { provider: "synthetic" },
        );
        hue.tracer.startActiveSpan("nested", (nested) => {
          ids.nested = nested.spanContext().spanId;
          expect(activeSpanId()).toBe(ids.nested);
          nested.end();
        });
        // The kill switch neither hides the application's active span nor blocks propagation.
        await disabled.withSpan("kill-switch", (span) => {
          expect(activeSpanId()).toBe(request.spanId);
          expect(trace.getSpan(span.context)?.spanContext().spanId).toBe(request.spanId);
          expect(trace.getSpan(disabled.getContext())?.spanContext().spanId).toBe(request.spanId);
          disabled.inject(carrier);
        });
        expect(activeSpanId()).toBe(request.spanId);
      });
      expect(trace.getActiveSpan()).toBeUndefined();
      expect(carrier.traceparent).toContain(ids.request);
      // The other direction: a Hue span started under an application span joins its trace.
      await tracerProvider.getTracer("application").startActiveSpan("outer", async (outer) => {
        ids.outer = outer.spanContext().spanId;
        await hue.withSpan("inner", () => undefined);
        outer.end();
      });
      await hue.flush();
      const spans = endpoint.requests.flatMap((request) => request.records);
      const hex = (id: string) => Buffer.from(id, "base64").toString("hex");
      const byName = (name: string) => spans.find((span) => span.name === name)!;
      const request = byName("request");
      expect(hex(request.spanId)).toBe(ids.request);
      for (const name of ["HTTP POST", "execute_tool lookup", "chat synthetic-model", "nested"]) {
        expect(hex(byName(name).parentSpanId!)).toBe(ids.request);
        expect(byName(name).traceId).toBe(request.traceId);
      }
      expect(hex(byName("execute_tool lookup").spanId)).toBe(ids.tool);
      expect(hex(byName("chat synthetic-model").spanId)).toBe(ids.model);
      expect(hex(byName("nested").spanId)).toBe(ids.nested);
      expect(spans.some((span) => span.name === "kill-switch")).toBe(false);
      expect(hex(byName("inner").parentSpanId!)).toBe(ids.outer);
    } finally {
      context.disable();
      trace.disable();
      await hue.shutdown();
      await disabled.shutdownSafe();
      await tracerProvider.shutdown();
      await loggerProvider.shutdown();
      await transport.shutdown();
      endpoint.server.stop(true);
    }
    expect(context.active()).toBe(previousContext);
  });

  test("export batches encode each record once and each request once", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "linear-export",
      captureContent: false,
      baseUrl: endpoint.url,
    });
    const serialize = spyOn(ProtobufTraceSerializer, "serializeRequest");
    try {
      const count = 2000; // within the 2048-record queue
      for (let index = 0; index < count; index++)
        hue.tracer.startSpan("burst", { attributes: { index } }).end();
      const started = performance.now();
      expect((await hue.flush()).acceptedSpans).toBe(count);
      const elapsed = performance.now() - started;
      const requests = endpoint.requests.filter((request) => request.signal === "traces");
      expect(requests.flatMap((request) => request.records)).toHaveLength(count);
      // Each record is encoded once to measure it and once more inside its request; the growing
      // batch is never re-encoded, so the encoded record total is exactly twice the record count.
      const encoded = serialize.mock.calls.map(([records]) => records.length);
      expect(encoded.filter((size) => size === 1).length).toBeGreaterThanOrEqual(count);
      expect(encoded.reduce((total, size) => total + size, 0)).toBe(2 * count);
      expect(serialize).toHaveBeenCalledTimes(count + requests.length);
      expect(elapsed).toBeLessThan(1000);
    } finally {
      serialize.mockRestore();
      await hue.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("owned providers export the OpenTelemetry default resource with Hue's service identity", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "resource-owner",
      serviceVersion: "1.2.3",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    try {
      await hue.withSpan("request", () => hue.recordMessages({ output: null }));
      await hue.flush();
      for (const signal of ["traces", "logs"] as const) {
        const request = endpoint.requests.find((request) => request.signal === signal)!;
        const data = JSON.parse(request.raw);
        const [group] = signal === "traces" ? data.resourceSpans : data.resourceLogs;
        const attributes = Object.fromEntries(
          (group.resource.attributes as Attribute[]).map((attribute) => [
            attribute.key,
            attribute.value.stringValue,
          ]),
        );
        expect(attributes).toMatchObject({
          "service.name": "resource-owner",
          "service.version": "1.2.3",
          "telemetry.sdk.name": "opentelemetry",
          "telemetry.sdk.language": "nodejs",
        });
        expect(attributes["telemetry.sdk.version"]).toMatch(/^\d+\.\d+\.\d+/);
      }
    } finally {
      await hue.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("failed spans record error.type and status without exception text at either capture setting", async () => {
    class ProviderTimeout extends Error {
      override name = "ProviderTimeout";
    }
    for (const captureContent of [true, false]) {
      const endpoint = receiver();
      const hue = createHue({
        apiKey,
        serviceName: "errors",
        captureContent,
        baseUrl: endpoint.url,
      });
      try {
        await expect(
          hue.withSpan("failure", () => {
            throw new RangeError("private synthetic message");
          }),
        ).rejects.toBeInstanceOf(RangeError);
        await expect(
          hue.tool("timeout", null, () => {
            throw new ProviderTimeout("private synthetic message");
          }),
        ).rejects.toBeInstanceOf(ProviderTimeout);
        await hue.flush();
        const spans = endpoint.requests.flatMap((request) => request.records);
        const failure = spans.find((span) => span.name === "failure")!;
        const tool = spans.find((span) => span.name === "execute_tool timeout")!;
        for (const [span, type] of [
          [failure, "RangeError"],
          [tool, "ProviderTimeout"],
        ] as const) {
          expect(span.status?.code).toBe(2);
          expect(span.status?.message).toBeUndefined();
          expect(attr(span, "error.type")?.stringValue).toBe(type);
          expect(span.events).toHaveLength(1);
          expect(span.events![0]!.name).toBe("exception");
          expect(span.events![0]!.attributes).toEqual([
            { key: "exception.type", value: { stringValue: type } },
          ]);
        }
        expect(endpoint.requests.map((request) => request.raw).join(" ")).not.toContain(
          "private synthetic message",
        );
      } finally {
        await hue.shutdown();
        endpoint.server.stop(true);
      }
    }
  });
});

describe("Kill switch and safe initialization", () => {
  test("the kill switch needs neither credentials nor a capture decision and still propagates", async () => {
    const hue = createHue({ enabled: false });
    expect(hue.enabled).toBe(false);
    expect(hue.captureContent).toBe(false);
    expect(await hue.withSpan("off", () => 42)).toBe(42);
    const traceparent = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
    const carrier: Record<string, string> = {};
    hue.inject(carrier, hue.extract({ traceparent }));
    expect(carrier).toEqual({ traceparent });
    expect(() => createHue({ enabled: false, captureContent: "yes" } as never)).toThrow(
      new TypeError("captureContent must be a boolean"),
    );
    expect(hue.transport.getReport().instrumentationFailures).toBe(0);
    expect((await hue.shutdownSafe()).ok).toBe(true);
  });

  test("safe initialization keeps the diagnostics hook and reports why telemetry is off", async () => {
    const issues: ExportIssue[] = [];
    const onExportIssue = (issue: ExportIssue) => {
      issues.push(issue);
    };
    const hue = createHueSafe({
      apiKey: "bad key",
      serviceName: "safe",
      captureContent: false,
      onExportIssue,
    });
    expect(hue.enabled).toBe(false);
    expect(hue.captureContent).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0)); // the hook runs asynchronously
    expect(issues).toEqual([
      expect.objectContaining({
        signal: "traces",
        kind: "invalid",
        count: 0,
        message: "Hue is disabled: A valid Hue project API key is required",
      }),
    ]);
    expect(hue.transport.getReport().instrumentationFailures).toBe(1);
    expect(JSON.stringify(hue.transport.getIssues())).not.toContain("bad key");
    await hue.shutdownSafe();
    // A broken borrowed provider disables the client the same way, through the transport's hook.
    const transport = createHueTransport({
      apiKey,
      serviceName: "safe",
      captureContent: false,
      onExportIssue,
    });
    const borrowed = createHueSafe({
      transport,
      tracerProvider: {
        getTracer: () => {
          throw new Error("provider failure");
        },
        async forceFlush() {},
      } as never,
      loggerProvider: new LoggerProvider({ processors: [] }),
    });
    expect(borrowed.enabled).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(issues).toHaveLength(2);
    expect(issues[1]!.message).toBe("Hue is disabled: provider failure");
    await borrowed.shutdownSafe();
    await transport.shutdown();
  });
});
