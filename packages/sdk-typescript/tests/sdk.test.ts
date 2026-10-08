import { describe, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs/light.js";
import { context, trace, type TraceState } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ProtobufTraceSerializer } from "@opentelemetry/otlp-transformer";
import { detectResources, resourceFromAttributes } from "@opentelemetry/resources";
import { TracerProvider, type ReadableSpan } from "@opentelemetry/sdk-trace";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import {
  createHue,
  createHueSafe,
  createHueTransport,
  type HueTransport,
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
  boolValue?: boolean;
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
  droppedEventsCount?: number;
  droppedLinksCount?: number;
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
  /** The status and headers of the `index`th telemetry request's reply (1-based); a status other
   * than 200 refuses the request, which is still recorded. */
  reply?: (
    index: number,
    signal: "traces" | "logs",
  ) => { status?: number; headers?: Record<string, string> } | undefined,
) {
  const requests: {
    signal: "traces" | "logs";
    records: WireRecord[];
    raw: string;
    /** The request's size after decompression. */
    bytes: number;
    /** The request's size on the wire. */
    wire: number;
    headers: Record<string, string>;
    /** The reply's status. */
    status: number;
    /** When the request arrived. */
    at: number;
  }[] = [];
  let hits = 0;
  let blobRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      // A receiver without the large-value upload route answers its framework's not-found; the
      // upload tests use their own receiver.
      if (new URL(request.url).pathname.startsWith("/api/v1/otlp/blobs")) {
        blobRequests++;
        return new Response("Not Found", { status: 404 });
      }
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
      const wire = bytes.byteLength;
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
        wire,
        headers: (() => {
          const headers: Record<string, string> = {};
          request.headers.forEach((value, name) => {
            headers[name] = value;
          });
          return headers;
        })(),
        status: 200,
        at: Date.now(),
      });
      const custom = reply?.(requests.length, signal);
      if (custom?.status !== undefined && custom.status !== 200) {
        requests.at(-1)!.status = custom.status;
        return new Response("synthetic refusal", {
          status: custom.status,
          headers: custom.headers,
        });
      }
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
        {
          headers: {
            "content-type": "application/x-protobuf",
            // A current Hue marks every trace acknowledgement as accepting placeholders.
            ...(signal === "traces" ? { "hue-pending-spans": "1" } : {}),
            ...custom?.headers,
          },
        },
      );
    },
  });
  return {
    server,
    requests,
    /** The records of the requests the receiver accepted. */
    accepted: () =>
      requests.filter((request) => request.status === 200).flatMap((request) => request.records),
    url: `http://127.0.0.1:${server.port}`,
    hits: () => hits,
    /** Requests to the upload route, which this receiver lacks. */
    blobRequests: () => blobRequests,
  };
}

function attr(record: WireRecord, key: string): Value | undefined {
  return record.attributes?.find((item) => item.key === key)?.value;
}

/** `length` characters of random base64: text gzip cannot shrink below about three quarters. */
function noise(length: number): string {
  return randomBytes(Math.ceil((length * 3) / 4))
    .toString("base64")
    .slice(0, length);
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
      const openaiRequest = structuredClone(openai.request);
      const anthropicRequest = structuredClone(anthropic.request);
      const openaiTools = openaiRequest.tools as Record<string, unknown>[];
      openaiTools[0] = {
        ...openaiTools[0],
        headers: { Authorization: "Bearer synthetic-header-token" },
        server_url:
          "https://synthetic-user:synthetic-pass@mcp.example.test/gmail/mcp?token=synthetic-query-token",
      };
      const anthropicServers = anthropicRequest.mcp_servers as Record<string, unknown>[];
      anthropicServers[0] = {
        ...anthropicServers[0],
        headers: { Authorization: "Bearer synthetic-header-token" },
        url: "https://synthetic-user:synthetic-pass@mcp.example.test/slack/mcp?token=synthetic-query-token",
      };
      try {
        await hue.model(
          "synthetic-model",
          async () => {
            const response = structuredClone(openai.response);
            response.output[1] = {
              ...response.output[1],
              arguments: JSON.stringify({ query: "private-provider-content" }),
              output: "synthetic-provider-result-marker",
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
              request: openaiRequest,
              servers: {
                gmail: {
                  version: "1.0",
                  provider: "google.gmail",
                  surface: "google.gmail/mcp",
                },
              },
            });
            hue.recordProviderToolCalls(anthropic.response, {
              provider: "anthropic",
              request: anthropicRequest,
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
        expect(attr(listing, "mcp.server.version")?.stringValue).toBe("1.0");
        expect(attr(listing, "hue.mcp.provider")?.stringValue).toBe("google.gmail");
        expect(attr(listing, "hue.mcp.surface")?.stringValue).toBe("google.gmail/mcp");
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
        for (const secret of [
          "synthetic-oauth-token",
          "synthetic-header-token",
          "synthetic-query-token",
          "synthetic-user",
          "synthetic-pass",
        ])
          expect(raw).not.toContain(secret);
        if (captureContent) {
          expect(raw).toContain("private-provider-content");
          expect(raw).toContain("synthetic-provider-result-marker");
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
          expect(raw).not.toContain("synthetic-provider-result-marker");
          for (const privateValue of ["Create a draft", "Update posted", "channel_not_found"])
            expect(raw).not.toContain(privateValue);
          expect(raw).not.toMatch(/\\+"threads\\+"/);
          for (const span of [listing, ...tools]) {
            expect(attr(span, "gen_ai.tool.call.arguments")).toBeUndefined();
            expect(attr(span, "gen_ai.tool.call.result")).toBeUndefined();
            expect(attr(span, "gen_ai.tool.definitions")).toBeUndefined();
          }
        }
        hue.recordProviderToolCalls(openai.response);
        expect((await hue.flushSafe()).report.instrumentationFailures).toBe(1);
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
  test("a 5 MiB inline file exports as its digest within the default queue budget", async () => {
    // Base64 makes the file about 6.7 M characters, charged at two bytes each: without hashing
    // at admission the span would exceed the default 8 MiB queue and be dropped.
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "inline-files-budget",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    const file = Uint8Array.from({ length: 5 * 1024 * 1024 }, (_, index) => (index * 31) % 256);
    const base64 = Buffer.from(file).toString("base64");
    const digest = createHash("sha256").update(file).digest("hex");
    const messages = JSON.stringify([
      {
        role: "user",
        parts: [
          { type: "text", content: "Summarize the attachment" },
          { type: "blob", modality: "document", mime_type: "application/pdf", content: base64 },
        ],
      },
    ]);
    try {
      const span = hue.tracer.startSpan("large-file");
      span.setAttribute("gen_ai.input.messages", messages);
      span.addEvent("messages", { "gen_ai.input.messages": messages });
      span.end();
      // Strict flush: the span was admitted and accepted, not dropped for its size.
      await hue.flush();
      const record = endpoint.requests
        .flatMap((request) => request.records)
        .find((candidate) => candidate.name === "large-file")!;
      expect(record).toBeDefined();
      const expected = [
        { type: "text", content: "Summarize the attachment" },
        {
          type: "blob",
          modality: "document",
          mime_type: "application/pdf",
          sha256: digest,
          size: file.byteLength,
        },
      ];
      expect(JSON.parse(attr(record, "gen_ai.input.messages")!.stringValue!)[0].parts).toEqual(
        expected,
      );
      const event = record.events!.find((candidate) => candidate.name === "messages")!;
      const eventMessages = event.attributes!.find(
        (attribute) => attribute.key === "gen_ai.input.messages",
      )!;
      expect(JSON.parse(eventMessages.value.stringValue!)[0].parts).toEqual(expected);
      expect(hue.transport.getReport()).toMatchObject({ droppedSpans: 0, failedSpans: 0 });
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test("admission hashes a shared message once and bounds the message text it inspects", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "inline-files-work",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    const message = (seed: number) =>
      JSON.stringify([
        {
          role: "user",
          parts: [
            {
              type: "blob",
              modality: "document",
              mime_type: "application/pdf",
              content: Buffer.alloc(1024 * 1024, seed).toString("base64"),
            },
          ],
        },
      ]);
    const shared = message(1);
    const distinct = Array.from({ length: 24 }, (_, index) => message(index + 2));
    const parsed: number[] = [];
    const parse = JSON.parse;
    const spy = spyOn(JSON, "parse").mockImplementation(((text: string, reviver?: never) => {
      if (typeof text === "string" && text.length > 1024 * 1024) parsed.push(text.length);
      return parse(text, reviver);
    }) as typeof JSON.parse);
    try {
      // One message shared by 128 events under all three message keys is parsed once.
      const repeated = hue.tracer.startSpan("shared-message");
      for (let index = 0; index < 128; index++)
        repeated.addEvent(`event-${index}`, {
          "gen_ai.input.messages": shared,
          "gen_ai.output.messages": shared,
          "ai.prompt.messages": shared,
        });
      repeated.end();
      expect(parsed).toHaveLength(1);
      // Distinct messages are inspected only up to the per-record limit of 16 MiB of text.
      parsed.length = 0;
      const many = hue.tracer.startSpan("distinct-messages");
      distinct.forEach((text, index) =>
        many.addEvent(`event-${index}`, { "gen_ai.input.messages": text }),
      );
      many.end();
      expect(parsed.length).toBeLessThanOrEqual(Math.floor((16 * 1024 * 1024) / shared.length));
      // The messages past the limit are charged as recorded, so not every event fits the budget:
      // the span keeps its newest events and counts the rest as dropped.
      await hue.flush();
      expect(hue.transport.getReport().droppedSpans).toBe(0);
      const record = endpoint.accepted().find((span) => span.name === "distinct-messages")!;
      const kept = record.events!.length;
      expect(kept).toBeLessThan(distinct.length);
      expect(record.events!.at(-1)!.name).toBe(`event-${distinct.length - 1}`);
      expect(record.droppedEventsCount).toBe(distinct.length - kept);
    } finally {
      spy.mockRestore();
      await hue.shutdownSafe();
      await endpoint.server.stop(true);
    }
  });

  test("metadata-only admission neither hashes nor charges the recorded messages", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "inline-files-metadata",
      captureContent: false,
      baseUrl: endpoint.url,
    });
    const content = Buffer.alloc(5 * 1024 * 1024, 7).toString("base64");
    const messages = JSON.stringify([
      { role: "user", parts: [{ type: "blob", mime_type: "application/pdf", content }] },
    ]);
    let parsedMessages = 0;
    const parse = JSON.parse;
    const spy = spyOn(JSON, "parse").mockImplementation(((text: string, reviver?: never) => {
      if (text === messages) parsedMessages += 1;
      return parse(text, reviver);
    }) as typeof JSON.parse);
    try {
      const span = hue.tracer.startSpan("metadata-only");
      span.setAttribute("gen_ai.input.messages", messages);
      span.end();
      await hue.flush();
      expect(parsedMessages).toBe(0);
      const record = endpoint.requests
        .flatMap((request) => request.records)
        .find((candidate) => candidate.name === "metadata-only")!;
      expect(record).toBeDefined();
      expect(attr(record, "gen_ai.input.messages")).toBeUndefined();
      expect(hue.transport.getReport()).toMatchObject({ droppedSpans: 0 });
    } finally {
      spy.mockRestore();
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  /** The strings of a wire array value. */
  const strings = (value: Value | undefined) =>
    (
      value as { arrayValue?: { values: { stringValue?: string }[] } } | undefined
    )?.arrayValue?.values.map((item) => item.stringValue);
  /** A wire key-value list as an object. */
  const kvlist = (value: Value | undefined) =>
    Object.fromEntries(
      (
        value as { kvlistValue?: { values: { key: string; value: Record<string, unknown> }[] } }
      ).kvlistValue!.values.map((item) => [item.key, Object.values(item.value)[0]]),
    );
  /** A transport, its providers and a client over `endpoint`, and the records it exported. */
  function exporting(
    endpoint: ReturnType<typeof receiver>,
    serviceName: string,
    maxQueueBytes?: number,
  ) {
    const transport = createHueTransport({
      apiKey,
      serviceName,
      captureContent: true,
      baseUrl: endpoint.url,
      ...(maxQueueBytes ? { maxQueueBytes } : {}),
    });
    const tracerProvider = new TracerProvider({ spanProcessors: [transport.spanProcessor] });
    const loggerProvider = new LoggerProvider({ processors: [transport.logRecordProcessor] });
    const hue = createHue({ transport, tracerProvider, loggerProvider });
    return {
      transport,
      tracerProvider,
      loggerProvider,
      hue,
      records: () => endpoint.requests.flatMap((request) => request.records),
      async stop() {
        await hue.shutdown();
        await tracerProvider.shutdown();
        await loggerProvider.shutdown();
        await transport.shutdown();
        endpoint.server.stop(true);
      },
    };
  }

  test("a content value over the 1 MiB value cap is cut to a UTF-8 prefix and listed under hue.truncated; the record is exported", async () => {
    const endpoint = receiver();
    const exporter = exporting(endpoint, "large-values");
    const { hue, tracerProvider, loggerProvider, transport } = exporter;
    // 640 Ki two-byte characters: 1.25 MiB of UTF-8, over the value cap. Dropping the span for it
    // lost the call, its arguments and the rest of the turn; the receiver's own answer to a
    // value over its cap is a cut to a UTF-8 prefix, listed under `hue.truncated`.
    const text = "é".repeat(640 * 1024);
    const large = `{"body":"${text}"}`;
    try {
      // A third-party instrumentation's attribute (what an AI SDK tool span records), and a
      // link's attribute over the cap, listed under the link prefix with the record's own cut.
      const tracer = tracerProvider.getTracer("third-party");
      const linked = tracer.startSpan("linked");
      linked.end();
      const span = tracer.startSpan("execute_tool read_document", {
        links: [{ context: linked.spanContext(), attributes: { "ai.prompt": large } }],
      });
      span.setAttribute("gen_ai.tool.call.result", large);
      span.setAttribute("gen_ai.tool.name", "read_document");
      span.end();
      // The Hue helper's own result, encoded by the client before it reaches the span; a whole
      // value set after a cut one unmarks its key, and the application's own entry is kept.
      await hue.tool("read_page", { id: "p1" }, () => ({ text, pages: 3 }));
      await hue.withSpan(
        "replaced",
        (context) => {
          context.span.setAttribute("hue.truncated", ["custom.blob"]);
          context.setOutput(text);
          context.setOutput("short");
        },
        { input: text },
      );
      // A structured log body over the cap: the receiver's marker, as the receiver itself
      // answers a structured value over its cap, and the body listed.
      loggerProvider.getLogger("third-party").emit({ body: { text, kind: "page" } as never });
      // A log whose body text alone is over the cap: cut to the prefix.
      loggerProvider.getLogger("third-party").emit({ body: text });
      await hue.flush();
      const records = exporter.records();
      const external = records.find((record) => record.name === "execute_tool read_document")!;
      const stored = attr(external, "gen_ai.tool.call.result")!.stringValue!;
      expect(Buffer.byteLength(stored)).toBeLessThanOrEqual(1024 * 1024);
      expect(Buffer.byteLength(stored)).toBeGreaterThan(1024 * 1024 - 4);
      expect(large.startsWith(stored)).toBe(true);
      // Listed in redaction order: the links are redacted before the record's own attributes.
      expect(strings(attr(external, "hue.truncated"))).toEqual([
        "link:ai.prompt",
        "gen_ai.tool.call.result",
      ]);
      const replaced = records.find((record) => record.name === "replaced")!;
      expect(attr(replaced, "output.value")!.stringValue).toBe('"short"');
      expect(strings(attr(replaced, "hue.truncated"))).toEqual(["custom.blob", "input.value"]);
      expect(attr(external, "gen_ai.tool.name")!.stringValue).toBe("read_document");
      const helper = records.find((record) => record.name === "execute_tool read_page")!;
      const result = attr(helper, "gen_ai.tool.call.result")!.stringValue!;
      expect(Buffer.byteLength(result)).toBeLessThanOrEqual(1024 * 1024);
      expect(Buffer.byteLength(result)).toBeGreaterThan(1024 * 1024 - 4);
      expect(result.startsWith('{"text":"éé')).toBe(true);
      expect(strings(attr(helper, "hue.truncated"))).toEqual(["gen_ai.tool.call.result"]);
      expect(JSON.parse(attr(helper, "gen_ai.tool.call.arguments")!.stringValue!)).toEqual({
        id: "p1",
      });
      const logs = endpoint.requests
        .filter((request) => request.signal === "logs")
        .flatMap((request) => request.records);
      expect(logs).toHaveLength(2);
      const [structured, plain] = logs as [WireRecord, WireRecord];
      // The marker names the body's size as recorded, not what was left after its text was cut.
      expect(kvlist(structured.body)).toEqual({
        "hue.truncated": true,
        "hue.truncated_bytes": String(Buffer.byteLength(JSON.stringify({ text, kind: "page" }))),
      });
      expect(strings(attr(structured, "hue.truncated"))).toEqual(["body"]);
      const cut = plain.body!.stringValue!;
      expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(1024 * 1024);
      expect(Buffer.byteLength(cut)).toBeGreaterThan(1024 * 1024 - 4);
      expect(text.startsWith(cut)).toBe(true);
      expect(strings(attr(plain, "hue.truncated"))).toEqual(["body"]);
      // Nothing was omitted, dropped or counted as a failure.
      expect(transport.getIssues().filter((issue) => issue.kind !== "warning")).toEqual([]);
      expect(transport.getReport().instrumentationFailures).toBe(0);
    } finally {
      await exporter.stop();
    }
  });

  test("a structured value over the 1 MiB value cap is cut to a UTF-8 prefix of its JSON text at the cap, never a shorter whole document", async () => {
    const endpoint = receiver();
    const exporter = exporting(endpoint, "structured-values");
    const { hue, transport } = exporter;
    // 24,000 small rows, 1.5 MiB of JSON together with no one value over the cap: the receiver
    // recognizes Hue's cut by its size at the cap, so a prefix of the rows that stopped early as
    // a shorter valid document would read as the whole result.
    const rows = Array.from({ length: 24_000 }, (_, index) => ({
      id: index,
      name: `row-${String(index).padStart(5, "0")}`,
      note: "n".repeat(24),
    }));
    const whole = JSON.stringify(rows);
    expect(Buffer.byteLength(whole)).toBeGreaterThan(1024 * 1024);
    try {
      await hue.tool("list_rows", { page: 1 }, () => rows);
      await hue.flush();
      const helper = exporter.records().find((record) => record.name === "execute_tool list_rows")!;
      const result = attr(helper, "gen_ai.tool.call.result")!.stringValue!;
      expect(Buffer.byteLength(result)).toBeLessThanOrEqual(1024 * 1024);
      expect(Buffer.byteLength(result)).toBeGreaterThan(1024 * 1024 - 4);
      expect(whole.startsWith(result)).toBe(true);
      expect(() => JSON.parse(result)).toThrow();
      expect(strings(attr(helper, "hue.truncated"))).toEqual(["gen_ai.tool.call.result"]);
      expect(transport.getIssues().filter((issue) => issue.kind !== "warning")).toEqual([]);
      expect(transport.getReport().instrumentationFailures).toBe(0);
    } finally {
      await exporter.stop();
    }
  });

  test("a redactor's answer that grows past the cap is refused by its length, never scanned or cut", async () => {
    // The redactor sees the whole recorded text, and an answer no longer than it is cut to the
    // cap as the text would be; an answer longer than both the cap and its input is the
    // redactor's own, and the record is refused before anything reads that text.
    const endpoint = receiver();
    const transport = createHueTransport({
      apiKey,
      serviceName: "oversized-redactor",
      captureContent: true,
      baseUrl: endpoint.url,
      redact: (text) => (text.startsWith("expand") ? "x".repeat(1_100_000) : text),
    });
    const tracerProvider = new TracerProvider({ spanProcessors: [transport.spanProcessor] });
    const loggerProvider = new LoggerProvider({ processors: [transport.logRecordProcessor] });
    const hue = createHue({ transport, tracerProvider, loggerProvider });
    try {
      const tracer = tracerProvider.getTracer("third-party");
      const kept = tracer.startSpan("kept");
      kept.setAttribute("gen_ai.tool.call.result", "y".repeat(1_100_000));
      kept.end();
      const refused = tracer.startSpan("refused");
      refused.setAttribute("gen_ai.tool.call.result", "expand me");
      refused.end();
      await expect(hue.flush()).rejects.toBeInstanceOf(HueExportError);
      const records = endpoint.requests.flatMap((request) => request.records);
      expect(records.map((record) => record.name)).toEqual(["kept"]);
      expect(Buffer.byteLength(attr(records[0]!, "gen_ai.tool.call.result")!.stringValue!)).toBe(
        1024 * 1024,
      );
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

  test("a record over the request limit on the wire sheds its largest content values, measured after gzip", async () => {
    const endpoint = receiver();
    const exporter = exporting(endpoint, "shed-content");
    const { hue, tracerProvider, transport } = exporter;
    try {
      const span = tracerProvider.getTracer("third-party").startSpan("chat gpt");
      // Four content values under the cap each and an event's content value, 1,900 KiB of text
      // gzip cannot shrink much: about 1.4 MiB on the wire, over the receiver's 1 MiB.
      const sizes: Record<string, number> = {
        "gen_ai.output.messages": 600,
        "ai.prompt": 300,
        "ai.response.text": 200,
        "gen_ai.tool.call.result": 100,
      };
      const values = Object.fromEntries(
        Object.entries(sizes).map(([key, kib]) => [key, noise(kib * 1024)]),
      );
      for (const [key, value] of Object.entries(values)) span.setAttribute(key, value);
      span.addEvent("gen_ai.content.prompt", { "gen_ai.prompt": noise(700 * 1024) });
      span.setAttribute("gen_ai.request.model", "gpt-5.6-terra");
      span.end();
      await hue.flush();
      const [record] = exporter.records();
      // The largest value alone is shed, the event's, as the receiver's marker and under the
      // receiver's event prefix; the other four reach Hue whole.
      const [event] = record!.events!;
      expect(
        kvlist(event!.attributes!.find((item) => item.key === "gen_ai.prompt")!.value),
      ).toEqual({ "hue.truncated": true, "hue.truncated_bytes": String(700 * 1024) });
      for (const [key, value] of Object.entries(values))
        expect(attr(record!, key)!.stringValue).toBe(value);
      expect(strings(attr(record!, "hue.truncated"))).toEqual([
        "event:gen_ai.content.prompt:gen_ai.prompt",
      ]);
      expect(attr(record!, "gen_ai.request.model")!.stringValue).toBe("gpt-5.6-terra");
      // Measured on the wire, not before gzip: the request is over 1 MiB decoded.
      expect(endpoint.requests).toHaveLength(1);
      expect(endpoint.requests[0]!.wire).toBeLessThanOrEqual(1024 * 1024);
      expect(endpoint.requests[0]!.bytes).toBeGreaterThan(1024 * 1024);
      expect(transport.getIssues().filter((issue) => issue.kind !== "warning")).toEqual([]);
    } finally {
      await exporter.stop();
    }
  });

  test("a record over the decoded request limit sheds its largest content values; under it, nothing is shed for its size before gzip", async () => {
    const endpoint = receiver();
    const exporter = exporting(endpoint, "shed-decoded", 32 * 1024 * 1024);
    const { hue, tracerProvider, transport } = exporter;
    try {
      const tracer = tracerProvider.getTracer("third-party");
      // 5,020 KiB of text that compresses to almost nothing: over the receiver's 4 MiB decoded
      // limit, far under its 1 MiB on the wire.
      const span = tracer.startSpan("chat gpt");
      const keys = ["gen_ai.output.messages", "ai.prompt", "ai.response.text", "output.value"];
      for (const key of keys) span.setAttribute(key, "x".repeat(1000 * 1024));
      span.addEvent("gen_ai.content.prompt", { "gen_ai.prompt": "x".repeat(1020 * 1024) });
      span.end();
      // 3 MiB of the same text: sent whole, though over 1 MiB before gzip.
      const whole = tracer.startSpan("whole");
      for (const key of keys.slice(0, 3)) whole.setAttribute(key, "y".repeat(1000 * 1024));
      whole.end();
      await hue.flush();
      const records = exporter.records();
      const shed = records.find((record) => record.name === "chat gpt")!;
      const [event] = shed.events!;
      expect(
        kvlist(event!.attributes!.find((item) => item.key === "gen_ai.prompt")!.value),
      ).toEqual({ "hue.truncated": true, "hue.truncated_bytes": String(1020 * 1024) });
      for (const key of keys) expect(attr(shed, key)!.stringValue).toHaveLength(1000 * 1024);
      expect(strings(attr(shed, "hue.truncated"))).toEqual([
        "event:gen_ai.content.prompt:gen_ai.prompt",
      ]);
      const kept = records.find((record) => record.name === "whole")!;
      for (const key of keys.slice(0, 3))
        expect(attr(kept, key)!.stringValue).toHaveLength(1000 * 1024);
      expect(attr(kept, "hue.truncated")).toBeUndefined();
      for (const request of endpoint.requests) {
        expect(request.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
        expect(request.wire).toBeLessThanOrEqual(1024 * 1024);
      }
      expect(transport.getIssues().filter((issue) => issue.kind !== "warning")).toEqual([]);
    } finally {
      await exporter.stop();
    }
  });

  test("a record too large without its content is lost, and its trace's root counts it", async () => {
    const endpoint = receiver();
    const exporter = exporting(endpoint, "dropped-records");
    const { hue, tracerProvider, transport } = exporter;
    try {
      const tracer = tracerProvider.getTracer("third-party");
      const root = tracer.startSpan("agent turn");
      const child = tracer.startSpan("custom step", {}, trace.setSpan(context.active(), root));
      // 1,500 KiB of metadata gzip cannot shrink to the receiver's 1 MiB, and metadata is never
      // shed: the record cannot be sent.
      for (let index = 0; index < 6; index++)
        child.setAttribute(`custom.blob.${index}`, noise(250 * 1024));
      child.end();
      root.end();
      await expect(hue.flush()).rejects.toBeInstanceOf(HueExportError);
      const records = exporter.records();
      expect(records.map((record) => record.name)).toEqual(["agent turn"]);
      // The root says how many of the trace's records Hue never received.
      expect(attr(records[0]!, "hue.sdk.dropped_records")).toEqual({ intValue: "1" });
      expect(transport.getIssues()).toContainEqual(
        expect.objectContaining({
          kind: "invalid",
          count: 1,
          message: "Telemetry record exceeds Hue's request limit without its content values",
        }),
      );
    } finally {
      await exporter.stop();
    }
  });

  test("a root's dropped-record count is consumed when its request is acknowledged, not when the root is written", () => {
    // The exporter's callbacks, internal to the package: the installed declarations omit them.
    const transport = createHueTransport({
      apiKey,
      serviceName: "counted-roots",
      captureContent: false,
    }) as HueTransport & {
      issue(
        signal: "traces" | "logs",
        kind: "dropped",
        count: number,
        message: string,
        status?: number,
        traceIds?: string[],
      ): void;
      withDroppedRecords(span: ReadableSpan): ReadableSpan;
      consumeDroppedRecords(counts: ReadonlyMap<string, number>): void;
    };
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    const span = (fields: Partial<ReadableSpan>): ReadableSpan => fields as ReadableSpan;
    const root = span({
      spanContext: () => ({ traceId, spanId: "b7ad6b7169203331", traceFlags: 1 }),
      attributes: { "hue.kind": "agent" },
    });
    transport.issue("traces", "dropped", 2, "Telemetry queue is full", undefined, [traceId]);
    // Written on the root as often as the root is written: a request that fails, or is retried,
    // has not told Hue, so the count is still there for the root's next write.
    expect(transport.withDroppedRecords(root).attributes["hue.sdk.dropped_records"]).toBe(2);
    expect(transport.withDroppedRecords(root).attributes["hue.sdk.dropped_records"]).toBe(2);
    // Acknowledged: the count has reached Hue, and the map holds nothing for the ended trace.
    transport.consumeDroppedRecords(new Map([[traceId, 2]]));
    expect(transport.withDroppedRecords(root)).toBe(root);
    // A child never carries it, and another trace's count is another trace's.
    transport.issue("traces", "dropped", 1, "Telemetry queue is full", undefined, [traceId]);
    const child = span({ ...root, parentSpanContext: root.spanContext() });
    expect(transport.withDroppedRecords(child)).toBe(child);
    transport.consumeDroppedRecords(new Map([["00000000000000000000000000000001", 1]]));
    expect(transport.withDroppedRecords(root).attributes["hue.sdk.dropped_records"]).toBe(1);
    // Only what the acknowledged root carried is consumed: a record lost while its request was in
    // flight is still counted.
    transport.issue("traces", "dropped", 2, "Telemetry queue is full", undefined, [traceId]);
    transport.consumeDroppedRecords(new Map([[traceId, 1]]));
    expect(transport.withDroppedRecords(root).attributes["hue.sdk.dropped_records"]).toBe(2);
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
    // In the base64 alphabet, so it is decoded whatever its media type: 48 KiB, kept inline.
    const asciiText = "A".repeat(64 * 1024 + 4);
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
      // GenAI blob parts: a text file's own text is hashed as UTF-8, a data: URL is decoded.
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
        { type: "blob", modality: "document", mime_type: "text/plain", content: asciiText },
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
      "langfuse.observation.input",
      "langfuse.observation.output",
      "langfuse.observation.status_message",
      "langfuse.observation.model.parameters",
      "langfuse.trace.input",
      "langfuse.trace.output",
      "tool.parameters",
      "exception.message",
      "exception.stacktrace",
    ]);
  });
  const langfuseContent = [
    "langfuse.observation.input",
    "langfuse.observation.output",
    "langfuse.observation.status_message",
    "langfuse.observation.model.parameters",
    "langfuse.trace.input",
    "langfuse.trace.output",
  ];
  const langfuseMetadata = {
    "langfuse.observation.model.name": "synthetic-model",
    "langfuse.observation.usage_details": '{"input":3,"output":5}',
    "langfuse.session.id": "session-123",
    "langfuse.user.id": "user-123",
    "langfuse.observation.type": "generation",
    "langfuse.observation.metadata.customer": "acme",
  };
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
        // A Langfuse span: inputs, outputs, the status message and model parameters are
        // content; the model name, usage, type, session, user and metadata keys stay.
        const langfuse = tracerProvider.getTracer("third-party").startSpan("langfuse");
        for (const key of langfuseContent) langfuse.setAttribute(key, "private-value");
        for (const [key, value] of Object.entries(langfuseMetadata))
          langfuse.setAttribute(key, value);
        langfuse.end();
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
        const langfuseRecord = records.find((candidate) => candidate.name === "langfuse")!;
        const langfuseKeys = (langfuseRecord.attributes ?? []).map((attribute) => attribute.key);
        for (const key of langfuseContent) expect(langfuseKeys.includes(key)).toBe(captureContent);
        for (const key of Object.keys(langfuseMetadata)) expect(langfuseKeys).toContain(key);
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
  test("rejects invalid capture options and insecure endpoints without credentials in errors", () => {
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
    // Invalid supplied values must not coerce to either capture mode.
    for (const captureContent of [null, "false", 0])
      expect(() =>
        createHue({ apiKey, serviceName: "test", captureContent } as unknown as Parameters<
          typeof createHue
        >[0]),
      ).toThrow("captureContent must be a boolean");
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

  test.each([createHue, createHueSafe])(
    "captures supplied content by default through %p",
    async (create) => {
      const endpoint = receiver();
      const hue = create({
        apiKey,
        serviceName: "default-capture",
        baseUrl: endpoint.url,
        redact: (value) => value.replaceAll("synthetic-secret", "[redacted]"),
      });
      try {
        await hue.withSpan(
          "root",
          async (root) => {
            await hue.model(
              "synthetic-model",
              async (model) => {
                model.setInput([
                  { role: "user", parts: [{ type: "text", content: "synthetic-secret" }] },
                ]);
                model.setOutput([
                  { role: "assistant", parts: [{ type: "text", content: "reply" }] },
                ]);
              },
              { provider: "synthetic" },
            );
            await hue.tool("lookup", { query: "synthetic-secret" }, () => ({ answer: "result" }));
            root.setOutput("reply");
            hue.recordMessages({ output: "reply" });
          },
          { input: "synthetic-secret" },
        );
        await hue.flush();
        const spans = endpoint.requests
          .filter((request) => request.signal === "traces")
          .flatMap((request) => request.records);
        const root = spans.find((span) => span.name === "root")!;
        const model = spans.find((span) => span.name === "chat synthetic-model")!;
        const tool = spans.find((span) => span.name === "execute_tool lookup")!;
        expect(attr(root, "input.value")?.stringValue).toBe('"[redacted]"');
        expect(attr(root, "output.value")?.stringValue).toBe('"reply"');
        expect(attr(model, "gen_ai.input.messages")).toBeDefined();
        expect(attr(model, "gen_ai.output.messages")).toBeDefined();
        expect(attr(tool, "gen_ai.tool.call.arguments")?.stringValue).toBe(
          '{"query":"[redacted]"}',
        );
        expect(attr(tool, "gen_ai.tool.call.result")?.stringValue).toBe('{"answer":"result"}');
        expect(endpoint.requests.some((request) => request.signal === "logs")).toBe(true);
        expect(endpoint.requests.map((request) => request.raw).join(" ")).not.toContain(
          "synthetic-secret",
        );
      } finally {
        await hue.shutdown();
        endpoint.server.stop(true);
      }
    },
  );

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
        uploadedValues: 0,
        uploadFallbacks: 0,
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

  test.each(["backoff", "zero", "seconds", "date"] as const)(
    "transient HTTP 500 recovers for traces and logs with %s Retry-After",
    async (policy) => {
      const attempts = new Map<string, number>();
      const earliest = new Map<string, number>();
      const endpoint = receiver("success", undefined, undefined, (_index, signal) => {
        const attempt = (attempts.get(signal) ?? 0) + 1;
        attempts.set(signal, attempt);
        if (attempt !== 1) return;
        const now = Date.now();
        const value =
          policy === "zero"
            ? "0"
            : policy === "seconds"
              ? "1"
              : policy === "date"
                ? new Date(now + 2000).toUTCString()
                : undefined;
        earliest.set(
          signal,
          policy === "date"
            ? Date.parse(value!)
            : now + (policy === "seconds" ? 900 : policy === "backoff" ? 700 : 0),
        );
        return { status: 500, headers: value === undefined ? undefined : { "Retry-After": value } };
      });
      const hue = createHue({
        apiKey,
        serviceName: "retry-500",
        captureContent: true,
        liveSpans: false,
        baseUrl: endpoint.url,
        timeoutMillis: 5000,
      });
      try {
        await hue.withSpan("retry-500", () => hue.recordMessages({ output: "synthetic output" }));
        const report = await hue.flush();
        expect(report).toMatchObject({
          acceptedSpans: 1,
          acceptedLogs: 1,
          failedSpans: 0,
          failedLogs: 0,
        });
        expect(hue.transport.getIssues()).toEqual([]);
        for (const signal of ["traces", "logs"] as const) {
          const requests = endpoint.requests.filter((request) => request.signal === signal);
          expect(requests.map((request) => request.status)).toEqual([500, 200]);
          expect(requests[1]!.at).toBeGreaterThanOrEqual(earliest.get(signal)!);
          // Retry exactly the refused records, without changing trace or span identity.
          expect(requests[1]!.raw).toBe(requests[0]!.raw);
        }
      } finally {
        await hue.shutdown();
        await endpoint.server.stop(true);
      }
    },
    15000,
  );

  test("persistent HTTP 500 exhausts six attempts and counts each signal's failed batch once", async () => {
    const endpoint = receiver("success", undefined, undefined, () => ({
      status: 500,
      headers: { "Retry-After": "0" },
    }));
    const hue = createHue({
      apiKey,
      serviceName: "persistent-500",
      captureContent: true,
      liveSpans: false,
      baseUrl: endpoint.url,
      timeoutMillis: 1500,
    });
    try {
      await hue.withSpan("persistent-500", () =>
        hue.recordMessages({ output: "synthetic output" }),
      );
      const error = await hue.flush().catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(HueExportError);
      expect((error as HueExportError).report).toMatchObject({
        acceptedSpans: 0,
        acceptedLogs: 0,
        failedSpans: 1,
        failedLogs: 1,
      });
      const issues = hue.transport.getIssues().filter((issue) => issue.count > 0);
      expect(issues).toHaveLength(2);
      for (const signal of ["traces", "logs"] as const) {
        expect(endpoint.requests.filter((request) => request.signal === signal)).toHaveLength(6);
        expect(issues.filter((issue) => issue.signal === signal)).toEqual([
          expect.objectContaining({ kind: "failed", count: 1 }),
        ]);
      }
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test.each(["backoff", "seconds", "date", "terminal-501"] as const)(
    "HTTP 500 request budget and terminal status are bounded: %s",
    async (policy) => {
      const endpoint = receiver("success", undefined, undefined, () => ({
        status: policy === "terminal-501" ? 501 : 500,
        headers:
          policy === "seconds"
            ? { "Retry-After": "30" }
            : policy === "date"
              ? { "Retry-After": new Date(Date.now() + 30000).toUTCString() }
              : undefined,
      }));
      const hue = createHue({
        apiKey,
        serviceName: "retry-budget",
        captureContent: false,
        liveSpans: false,
        baseUrl: endpoint.url,
        timeoutMillis: 300,
      });
      try {
        await hue.withSpan("budget", () => {});
        const started = Date.now();
        const error = await hue.flush().catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(HueExportError);
        expect(Date.now() - started).toBeLessThan(1500);
        expect(endpoint.requests).toHaveLength(1);
        expect((error as HueExportError).report).toMatchObject({
          acceptedSpans: 0,
          failedSpans: 1,
        });
        expect((error as HueExportError).issues.filter((issue) => issue.count > 0)).toEqual([
          expect.objectContaining({ kind: "failed", count: 1 }),
        ]);
      } finally {
        await hue.shutdown();
        await endpoint.server.stop(true);
      }
    },
  );

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

  test("batches requests to the 4 MiB target before gzip, each within the receiver's limits", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "test",
      captureContent: true,
      baseUrl: endpoint.url,
      maxQueueBytes: 32 * 1024 * 1024,
    });
    try {
      // 4.8 MB of text that compresses well: over one batch, under 1 MiB on the wire either way.
      for (let i = 0; i < 8; i++)
        await hue.withSpan(`record-${i}`, ({ setOutput }) => setOutput("x".repeat(600_000)));
      expect((await hue.flush()).acceptedSpans).toBe(8);
      expect(endpoint.requests).toHaveLength(2);
      for (const request of endpoint.requests) {
        expect(request.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
        expect(request.wire).toBeLessThanOrEqual(1024 * 1024);
      }
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test("splits a batch whose gzip size is over the wire limit without dropping sibling spans", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "test",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    try {
      // 1.6 MB of text gzip cannot shrink below 1 MiB: within the batch target before gzip, over
      // the receiver's limit on the wire, so the batch travels in halves.
      for (let i = 0; i < 8; i++)
        await hue.withSpan(`record-${i}`, ({ setOutput }) => setOutput(noise(200_000)));
      expect((await hue.flush()).acceptedSpans).toBe(8);
      expect(endpoint.requests.length).toBeGreaterThan(1);
      expect(endpoint.requests.every((request) => request.wire <= 1024 * 1024)).toBe(true);
      expect(endpoint.requests.flatMap((request) => request.records)).toHaveLength(8);
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

describe("Receiver limits", () => {
  const MiB = 1024 * 1024;
  /** The strings of a wire array value. */
  const strings = (value: Value | undefined) =>
    (
      value as { arrayValue?: { values: { stringValue?: string }[] } } | undefined
    )?.arrayValue?.values.map((item) => item.stringValue);
  const named = (records: WireRecord[], name: string) =>
    records.find((record) => record.name === name)!;
  /** Exports one value over the cap, so the client learns its receiver lacks the upload route and
   * cuts values when they are queued again, as before uploads existed. */
  const withoutUploads = async (hue: ReturnType<typeof createHue>) => {
    const span = hue.tracer.startSpan("learns the receiver lacks uploads");
    span.setAttribute("custom.blob", "u".repeat(MiB + 1));
    span.end();
    await hue.flush();
  };

  test("adopts the limits any response advertises, clamped to their ranges, and never exceeds them", async () => {
    let advertised: Record<string, string> = {};
    const endpoint = receiver("success", undefined, undefined, (index, signal) => {
      if (signal !== "traces") return undefined;
      // A refusal advertises too; a value cap of 1,000 bytes is clamped to 256 KiB.
      if (index === 1)
        return { status: 503, headers: { "Retry-After": "0", "Hue-Max-Value-Bytes": "1000" } };
      return { headers: advertised };
    });
    const hue = createHue({
      apiKey,
      serviceName: "advertised-limits",
      captureContent: true,
      baseUrl: endpoint.url,
      maxQueueBytes: 64 * MiB,
    });
    try {
      await hue.withSpan("first", () => undefined);
      await hue.flush();
      expect(endpoint.requests.map((request) => request.status)).toEqual([503, 200]);
      const capped = hue.tracer.startSpan("capped");
      capped.setAttribute("output.value", "v".repeat(300 * 1024));
      capped.end();
      await hue.flush();
      const cappedRecord = named(endpoint.accepted(), "capped");
      expect(attr(cappedRecord, "output.value")!.stringValue).toBe("v".repeat(256 * 1024));
      expect(strings(attr(cappedRecord, "hue.truncated"))).toEqual(["output.value"]);

      // A receiver that raises its limits: a 1.5 MiB value stays whole, and a record gzip cannot
      // shrink to 1 MiB travels whole in one request, over 1 MiB on the wire.
      advertised = {
        "Hue-Max-Request-Bytes": String(4 * MiB),
        "Hue-Max-Decoded-Bytes": String(16 * MiB),
        "Hue-Max-Value-Bytes": String(2 * MiB),
      };
      await hue.withSpan("raised", () => undefined);
      await hue.flush();
      const text = "w".repeat(1.5 * MiB);
      const random = noise(1.8 * MiB);
      const wide = hue.tracer.startSpan("wide");
      wide.setAttribute("output.value", text);
      wide.setAttribute("input.value", random);
      wide.end();
      await hue.flush();
      const wideRequest = endpoint.requests.find((request) =>
        request.records.some((record) => record.name === "wide"),
      )!;
      expect(wideRequest.wire).toBeGreaterThan(MiB);
      expect(wideRequest.wire).toBeLessThanOrEqual(4 * MiB);
      const wideRecord = named(wideRequest.records, "wide");
      expect(attr(wideRecord, "output.value")!.stringValue).toBe(text);
      expect(attr(wideRecord, "input.value")!.stringValue).toBe(random);
      expect(attr(wideRecord, "hue.truncated")).toBeUndefined();

      // Lowered again, the lower limits are kept: the value is cut to 1 MiB, and the record sheds
      // the content gzip cannot fit into 1 MiB.
      advertised = {
        "Hue-Max-Request-Bytes": String(MiB),
        "Hue-Max-Decoded-Bytes": String(4 * MiB),
        "Hue-Max-Value-Bytes": String(MiB),
      };
      await hue.withSpan("lowered", () => undefined);
      await hue.flush();
      const narrow = hue.tracer.startSpan("narrow");
      narrow.setAttribute("output.value", text);
      narrow.setAttribute("input.value", noise(1.8 * MiB));
      narrow.end();
      await hue.flush();
      const narrowRequest = endpoint.requests.find((request) =>
        request.records.some((record) => record.name === "narrow"),
      )!;
      expect(narrowRequest.wire).toBeLessThanOrEqual(MiB);
      const narrowRecord = named(narrowRequest.records, "narrow");
      expect(attr(narrowRecord, "output.value")!.stringValue).toBe("w".repeat(MiB));
      expect(strings(attr(narrowRecord, "hue.truncated"))).toEqual(["output.value", "input.value"]);
      expect(hue.transport.getIssues().filter((issue) => issue.kind !== "warning")).toEqual([]);
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test("a 429 whose Retry-After outlasts the request deadline keeps its records queued and sends them after it", async () => {
    const endpoint = receiver("success", undefined, undefined, (index) =>
      index === 1 ? { status: 429, headers: { "Retry-After": "30" } } : undefined,
    );
    const hue = createHue({
      apiKey,
      serviceName: "rate-limited",
      captureContent: false,
      baseUrl: endpoint.url,
    });
    try {
      await hue.withSpan("held", () => undefined);
      const flushing = hue.flush();
      while (!endpoint.requests.length) await Bun.sleep(50);
      await Bun.sleep(1000);
      // Refused for its rate and held: still pending, nothing lost or reported.
      expect(hue.transport.getReport()).toMatchObject({ pendingSpans: 1, failedSpans: 0 });
      const report = await flushing;
      expect(report).toMatchObject({
        acceptedSpans: 1,
        failedSpans: 0,
        droppedSpans: 0,
        pendingSpans: 0,
      });
      expect(endpoint.requests.map((request) => request.status)).toEqual([429, 200]);
      expect(endpoint.requests[1]!.at - endpoint.requests[0]!.at).toBeGreaterThanOrEqual(29_900);
      expect(named(endpoint.accepted(), "held")).toBeDefined();
      expect(hue.transport.getIssues()).toEqual([]);
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  }, 60_000);

  test("a 429 whose Retry-After exceeds the 60 s hold loses its records at once and counts them on the trace's root", async () => {
    const endpoint = receiver("success", undefined, undefined, (index) =>
      index === 1 ? { status: 429, headers: { "Retry-After": "61" } } : undefined,
    );
    const hue = createHue({
      apiKey,
      serviceName: "rate-limited-long",
      captureContent: false,
      baseUrl: endpoint.url,
    });
    try {
      await hue.withSpan("agent turn", async () => {
        await hue.withSpan("step", () => undefined);
        const started = Date.now();
        const error = await hue.flush().catch((reason: unknown) => reason);
        expect(Date.now() - started).toBeLessThan(5000);
        expect(error).toBeInstanceOf(HueExportError);
        expect((error as HueExportError).issues.filter((issue) => issue.count > 0)).toEqual([
          expect.objectContaining({ kind: "failed", count: 1, status: 429 }),
        ]);
      });
      await hue.flush();
      const root = named(endpoint.accepted(), "agent turn");
      expect(attr(root, "hue.sdk.dropped_records")).toEqual({ intValue: "1" });
      expect(endpoint.accepted().map((record) => record.name)).toEqual(["agent turn"]);
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test("a client's own spans keep 2,000 attributes, events and links, and its log records 2,000 attributes", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "wide-records",
      captureContent: false,
      baseUrl: endpoint.url,
    });
    try {
      const target = hue.tracer.startSpan("target");
      target.end();
      const span = hue.tracer.startSpan("wide", {
        links: Array.from({ length: 300 }, (_, index) => ({
          context: target.spanContext(),
          attributes: { "app.link": index },
        })),
      });
      for (let index = 0; index < 2001; index++) span.setAttribute(`app.field.${index}`, index);
      for (let index = 0; index < 300; index++) span.addEvent(`step ${index}`);
      span.addEvent(
        "wide event",
        Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`app.key.${index}`, index])),
      );
      span.end();
      // The client's own logger provider, as recordMessages uses it.
      const { loggerProvider } = hue as unknown as { loggerProvider: LoggerProvider };
      loggerProvider.getLogger("wide").emit({
        body: "wide log",
        attributes: Object.fromEntries(
          Array.from({ length: 300 }, (_, index) => [`app.key.${index}`, index]),
        ),
      });
      await hue.flush();
      const records = endpoint.accepted();
      const wide = named(records, "wide");
      // OpenTelemetry's default keeps 128 of each; the client keeps 2,000, then drops the rest.
      expect(wide.attributes).toHaveLength(2000);
      expect(attr(wide, "app.field.1999")).toEqual({ intValue: "1999" });
      expect(attr(wide, "app.field.2000")).toBeUndefined();
      expect(wide.events).toHaveLength(301);
      expect(wide.events!.at(-1)!.attributes).toHaveLength(200);
      expect((wide as { links?: unknown[] }).links).toHaveLength(300);
      const logs = endpoint.requests
        .filter((request) => request.signal === "logs")
        .flatMap((request) => request.records);
      expect(logs).toHaveLength(1);
      expect(logs[0]!.attributes).toHaveLength(300);
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test("a value of millions of characters is cut when queued, not charged whole, so its record is exported", async () => {
    const endpoint = receiver();
    // The default 8 MiB queue: these two values charged whole would take 18 MB of it.
    const hue = createHue({
      apiKey,
      serviceName: "huge-values",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    try {
      const span = hue.tracer.startSpan("huge");
      span.setAttribute("output.value", "z".repeat(4_000_000));
      span.setAttribute("custom.blob", "q".repeat(5_000_000));
      span.end();
      const report = await hue.flush();
      expect(report).toMatchObject({ acceptedSpans: 1, droppedSpans: 0, failedSpans: 0 });
      const record = named(endpoint.accepted(), "huge");
      expect(attr(record, "output.value")!.stringValue).toBe("z".repeat(MiB));
      expect(attr(record, "custom.blob")!.stringValue).toBe("q".repeat(MiB));
      expect(strings(attr(record, "hue.truncated"))).toEqual(["output.value", "custom.blob"]);
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test("text cut when queued never exports the end the redactor saw without its continuation", async () => {
    const endpoint = receiver();
    // The redactor recognizes a whole key only, and removes a large block, so what it returns of a
    // cut text is shorter than the cap and would otherwise be exported to its last character.
    const hue = createHue({
      apiKey,
      serviceName: "redacted-cut",
      captureContent: true,
      baseUrl: endpoint.url,
      redact: (text) => text.replaceAll(/sk-synthetic-s{40}/g, "[key]").replaceAll(/b{1000,}/g, ""),
    });
    // Cut when queued at the cap and 64 Ki code units, 20 characters into the key.
    const queuedLength = MiB + 64 * 1024;
    const key = `sk-synthetic-${"s".repeat(40)}`;
    const text =
      "b".repeat(300_000) + "a".repeat(queuedLength - 300_000 - 20) + key + "a".repeat(100_000);
    try {
      await withoutUploads(hue);
      const span = hue.tracer.startSpan("redacted");
      span.setAttribute("output.value", text);
      span.setAttribute("input.value", `${key} kept whole`);
      span.end();
      await hue.flush();
      const record = named(endpoint.accepted(), "redacted");
      const exported = attr(record, "output.value")!.stringValue!;
      expect(exported).not.toContain("sk-synthetic");
      expect(exported).toBe("a".repeat(queuedLength - 300_000 - 64 * 1024));
      expect(attr(record, "input.value")!.stringValue).toBe("[key] kept whole");
      expect(strings(attr(record, "hue.truncated"))).toEqual(["output.value"]);
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test("a recorded request cut when queued has its tool credentials removed from the whole value first", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "scrubbed-cut",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    try {
      const span = hue.tracer.startSpan("request");
      span.setAttribute(
        "input.value",
        JSON.stringify({
          model: "synthetic-model",
          tools: [
            {
              type: "mcp",
              server_label: "synthetic",
              headers: { Authorization: "Bearer synthetic-cut-token" },
            },
          ],
          input: "x".repeat(1_300_000),
        }),
      );
      span.end();
      await hue.flush();
      const record = named(endpoint.accepted(), "request");
      const exported = attr(record, "input.value")!.stringValue!;
      expect(endpoint.requests.map((request) => request.raw).join(" ")).not.toContain(
        "synthetic-cut-token",
      );
      expect(exported.startsWith('{"model":"synthetic-model","tools":[{"type":"mcp"')).toBe(true);
      expect(exported).toContain("[redacted]");
      expect(Buffer.byteLength(exported)).toBe(MiB);
      expect(strings(attr(record, "hue.truncated"))).toEqual(["input.value"]);
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test("a client's own span with 2,000 events of several attributes each is exported whole", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "many-events",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    try {
      const span = hue.tracer.startSpan("many events");
      for (let index = 0; index < 2000; index++)
        span.addEvent(`step ${index}`, {
          "app.step": index,
          "app.kind": "tool",
          "app.ok": true,
          "app.note": `note ${index}`,
          "app.cost": index / 10,
        });
      span.end();
      const report = await hue.flush();
      expect(report).toMatchObject({ acceptedSpans: 1, droppedSpans: 0, failedSpans: 0 });
      const record = named(endpoint.accepted(), "many events");
      expect(record.events).toHaveLength(2000);
      expect(record.events!.at(-1)!.attributes).toHaveLength(5);
      expect(record.droppedEventsCount ?? 0).toBe(0);
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test("a span whose events outgrow the queue's byte budget keeps its newest events and counts the rest as dropped", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "events-over-budget",
      captureContent: true,
      baseUrl: endpoint.url,
      maxQueueBytes: 1024 * 1024,
    });
    try {
      const target = hue.tracer.startSpan("target");
      target.end();
      const span = hue.tracer.startSpan("long turn", {
        links: Array.from({ length: 600 }, (_, index) => ({
          context: target.spanContext(),
          attributes: { "app.link": index, "app.note": "l".repeat(1000) },
        })),
      });
      span.setAttribute("output.value", "the final answer");
      // About 4 MB charged for these events: four times the record's budget.
      for (let index = 0; index < 2000; index++)
        span.addEvent(`step ${index}`, { "app.note": "n".repeat(1000) });
      span.end();
      const report = await hue.flush();
      expect(report).toMatchObject({ droppedSpans: 0, failedSpans: 0 });
      const record = named(endpoint.accepted(), "long turn");
      expect(attr(record, "output.value")!.stringValue).toBe("the final answer");
      const kept = record.events!.length;
      expect(kept).toBeGreaterThan(100);
      expect(kept).toBeLessThan(2000);
      expect(record.events!.at(-1)!.name).toBe("step 1999");
      expect(record.events![0]!.name).toBe(`step ${2000 - kept}`);
      expect(record.droppedEventsCount).toBe(2000 - kept);
      // The events took what the budget held, so the links, copied after them, were left out.
      const links = (record as { links?: unknown[] }).links ?? [];
      expect(links.length + (record.droppedLinksCount ?? 0)).toBe(600);
      expect(record.droppedLinksCount).toBeGreaterThan(0);
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test("recordMessages exports a body of more than 16,384 values", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "many-messages",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    try {
      const input = Array.from({ length: 20_000 }, (_, index) => index);
      await hue.model(
        "synthetic-model",
        () => {
          hue.recordMessages({ input });
        },
        { provider: "synthetic" },
      );
      const report = await hue.flush();
      expect(report).toMatchObject({ droppedLogs: 0, failedLogs: 0, instrumentationFailures: 0 });
      const logs = endpoint.requests
        .filter((request) => request.signal === "logs")
        .flatMap((request) => request.records);
      expect(logs).toHaveLength(1);
      const messages = logs[0]!.body!.kvlistValue!.values.find(
        (item) => item.key === "gen_ai.input.messages",
      )!;
      expect(messages.value.arrayValue!.values).toHaveLength(20_000);
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test.each([
    { decoded: 8 * MiB, target: 4 * MiB },
    { decoded: 2 * MiB, target: 2 * MiB },
  ])(
    "batches to the lower of 4 MiB and an advertised decoded limit of $decoded bytes",
    async ({ decoded, target }) => {
      const endpoint = receiver("success", undefined, undefined, () => ({
        headers: {
          "Hue-Max-Request-Bytes": String(4 * MiB),
          "Hue-Max-Decoded-Bytes": String(decoded),
        },
      }));
      const hue = createHue({
        apiKey,
        serviceName: "batch-target",
        captureContent: true,
        baseUrl: endpoint.url,
        maxQueueBytes: 32 * MiB,
      });
      try {
        await hue.withSpan("adopt", () => undefined);
        await hue.flush();
        // 7.2 MB of text that compresses well: one request under the advertised ceiling alone.
        for (let i = 0; i < 12; i++)
          await hue.withSpan(`record-${i}`, ({ setOutput }) => setOutput("x".repeat(600_000)));
        expect((await hue.flush()).acceptedSpans).toBe(13);
        const batches = endpoint.requests.slice(1);
        expect(batches.length).toBeGreaterThanOrEqual(Math.ceil((12 * 600_000) / target));
        for (const request of batches) expect(request.bytes).toBeLessThanOrEqual(target);
      } finally {
        await hue.shutdown();
        await endpoint.server.stop(true);
      }
    },
  );

  test("a record over the wire limit with 1,500 incompressible content values sheds the fewest in bounded time", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "many-values",
      captureContent: true,
      baseUrl: endpoint.url,
    });
    try {
      // A long conversation flattened into 3 MB of messages, about 2.3 MB after gzip.
      const span = hue.tracer.startSpan("conversation");
      for (let index = 0; index < 1500; index++)
        span.setAttribute(`llm.input_messages.${index}.message.content`, noise(2000));
      span.end();
      const started = Date.now();
      const report = await hue.flush();
      // Shedding one value per encoding and compression took over a minute here.
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(report).toMatchObject({ acceptedSpans: 1, droppedSpans: 0, failedSpans: 0 });
      expect(endpoint.requests).toHaveLength(1);
      const [request] = endpoint.requests;
      expect(request!.wire).toBeLessThanOrEqual(MiB);
      // The fewest values are shed: the request is within a few values of the limit.
      expect(request!.wire).toBeGreaterThan(MiB - 32 * 1024);
      const record = named(request!.records, "conversation");
      const listed = strings(attr(record, "hue.truncated"))!;
      expect(listed.length).toBeGreaterThan(500);
      expect(listed.length).toBeLessThan(1500);
      for (const key of listed) expect(attr(record, key!)!.kvlistValue).toBeDefined();
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  }, 60_000);

  test.each([
    { status: 429, retryAfter: "3" },
    { status: 503, retryAfter: "1" },
  ])(
    "a request over limits a $status lowered is split before it is sent again",
    async ({ status, retryAfter }) => {
      const lowered = {
        "Hue-Max-Request-Bytes": String(MiB),
        "Hue-Max-Decoded-Bytes": String(MiB),
      };
      const endpoint = receiver("success", undefined, undefined, (index, signal) => {
        if (signal !== "traces") return undefined;
        return index === 1
          ? { status, headers: { ...lowered, "Retry-After": retryAfter } }
          : { headers: lowered };
      });
      const hue = createHue({
        apiKey,
        serviceName: "lowered-while-sent",
        captureContent: true,
        baseUrl: endpoint.url,
        timeoutMillis: 2000,
      });
      try {
        // 2.4 MB that compresses well: one request under the 4 MiB decoded limit it was sent at.
        for (let i = 0; i < 6; i++)
          await hue.withSpan(`record-${i}`, ({ setOutput }) => setOutput("x".repeat(400_000)));
        const report = await hue.flush();
        expect(report).toMatchObject({ acceptedSpans: 6, failedSpans: 0, droppedSpans: 0 });
        const [refused, ...resent] = endpoint.requests;
        expect(refused!.status).toBe(status);
        expect(refused!.bytes).toBeGreaterThan(MiB);
        expect(resent.length).toBeGreaterThan(1);
        for (const request of resent) expect(request.bytes).toBeLessThanOrEqual(MiB);
        expect(hue.transport.getIssues().filter((issue) => issue.kind !== "warning")).toEqual([]);
      } finally {
        await hue.shutdown();
        await endpoint.server.stop(true);
      }
    },
    30_000,
  );

  test("a trace's root carries the records an earlier request of the same export lost", async () => {
    // The child's request is refused for longer than an export holds it; the root, too large to
    // share its request, follows in the same export.
    const endpoint = receiver("success", undefined, undefined, (index, signal) =>
      signal === "traces" && index === 1
        ? { status: 429, headers: { "Retry-After": "61" } }
        : undefined,
    );
    const hue = createHue({
      apiKey,
      serviceName: "root-after-loss",
      captureContent: true,
      baseUrl: endpoint.url,
      maxQueueBytes: 32 * MiB,
    });
    try {
      // 2.7 MB each before gzip: two requests at the 4 MiB batch target.
      const turn = hue.tracer.startSpan("agent turn");
      const step = hue.tracer.startSpan("step", {}, trace.setSpan(context.active(), turn));
      for (let index = 0; index < 3; index++)
        step.setAttribute(`custom.blob.${index}`, "s".repeat(900_000));
      step.end();
      for (let index = 0; index < 3; index++)
        turn.setAttribute(`custom.blob.${index}`, "r".repeat(900_000));
      turn.end();
      await hue.flush().catch(() => undefined);
      const exported = named(endpoint.accepted(), "agent turn");
      expect(attr(exported, "hue.sdk.dropped_records")).toEqual({ intValue: "1" });
      expect(endpoint.requests.map((request) => request.status)).toEqual([429, 200]);
    } finally {
      await hue.shutdown().catch(() => undefined);
      await endpoint.server.stop(true);
    }
  });

  test("a recorded request longer than the record's budget is replaced by the marker, never cut unscrubbed", async () => {
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      serviceName: "unscrubbable",
      captureContent: true,
      baseUrl: endpoint.url,
      maxQueueBytes: 2 * MiB,
    });
    const recorded = JSON.stringify({
      model: "synthetic-model",
      tools: [
        {
          type: "mcp",
          server_label: "synthetic",
          headers: { Authorization: "Bearer synthetic-unscrubbed-token" },
        },
      ],
      input: "x".repeat(1_300_000),
    });
    try {
      const span = hue.tracer.startSpan("request");
      span.setAttribute("input.value", recorded);
      span.setAttribute("gen_ai.request.model", "synthetic-model");
      span.end();
      const report = await hue.flush();
      expect(report).toMatchObject({ acceptedSpans: 1, droppedSpans: 0, failedSpans: 0 });
      const record = named(endpoint.accepted(), "request");
      const marker = Object.fromEntries(
        attr(record, "input.value")!.kvlistValue!.values.map((item) => [item.key, item.value]),
      );
      expect(marker["hue.truncated"]).toEqual({ boolValue: true });
      expect(marker["hue.truncated_bytes"]).toEqual({ intValue: String(recorded.length) });
      expect(strings(attr(record, "hue.truncated"))).toEqual(["input.value"]);
      expect(attr(record, "gen_ai.request.model")!.stringValue).toBe("synthetic-model");
      expect(endpoint.requests.map((request) => request.raw).join(" ")).not.toContain(
        "synthetic-unscrubbed-token",
      );
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test("a shutdownSafe budget that ends during a rate-limit hold ends the hold and reports its records lost", async () => {
    const endpoint = receiver("success", undefined, undefined, (index) =>
      index === 1 ? { status: 429, headers: { "Retry-After": "30" } } : undefined,
    );
    const hue = createHue({
      apiKey,
      serviceName: "rate-limited-shutdown",
      captureContent: false,
      baseUrl: endpoint.url,
    });
    try {
      await hue.withSpan("held", () => undefined);
      const started = Date.now();
      const result = await hue.shutdownSafe({ timeoutMillis: 2000 });
      expect(result).toMatchObject({ ok: false, timedOut: true });
      // The hold ended with the budget: shutdown settles now, not after the 30 s Retry-After, and
      // no timer of the hold keeps the process running.
      const error = await hue.shutdown().catch((reason: unknown) => reason);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(error).toBeInstanceOf(HueExportError);
      expect((error as HueExportError).issues.filter((issue) => issue.count > 0)).toEqual([
        expect.objectContaining({ kind: "failed", count: 1, status: 429 }),
      ]);
      expect(endpoint.requests.map((request) => request.status)).toEqual([429]);
    } finally {
      await endpoint.server.stop(true);
    }
  });
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
      // A span and its tool span, each with a 1 MiB input and output, held at once.
      maxQueueBytes: 32 * 1024 * 1024,
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
    const invalid = ["x".repeat(1024 * 1024), cyclic, accessor, { n: NaN }, 1n];
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
      // Five captures of each value; the 1 MiB string is cut to the cap, not a failure, except
      // as an inference log's body, which is parsed back and so still omitted.
      expect(hue.transport.getReport().instrumentationFailures).toBe(21);
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
    // The 300,000-character input is cut to the cap and listed, never a failure.
    expect(hue.transport.getReport().instrumentationFailures).toBe(0);
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
