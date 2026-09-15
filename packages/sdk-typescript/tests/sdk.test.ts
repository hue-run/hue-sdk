import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs/light.js";
import { context, trace } from "@opentelemetry/api";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import { createHue, createHueTransport, HueConnectionError, HueExportError } from "../src/index.js";
import { hueTelemetry } from "../src/ai-sdk.js";
import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import schema from "./fixtures/otlp-schema.json" with { type: "json" };

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
      if (mode === "unauthorized") return new Response(`reflected ${apiKey}`, { status: 401 });
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
      requests.push({ signal, records, raw: JSON.stringify(data), bytes: bytes.byteLength });
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
      });
      const spans = endpoint.requests
        .filter((request) => request.signal === "traces")
        .flatMap((request) => request.records);
      const parent = spans.find((span) => span.name === "chat")!;
      const tool = spans.find((span) => span.name === "lookup")!;
      expect(tool.traceId).toBe(parent.traceId);
      expect(tool.parentSpanId).toBe(parent.spanId);
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

  test("retryable failure is retried by the official exporter and accepted once", async () => {
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
      expect((await hue.flush()).acceptedSpans).toBe(1);
      expect(endpoint.hits()).toBe(2);
      expect(hue.transport.getIssues()).toEqual([]);
    } finally {
      await hue.shutdown();
      await endpoint.server.stop(true);
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
