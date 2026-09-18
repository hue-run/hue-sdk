import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs/light.js";
import { context, trace, type TraceState } from "@opentelemetry/api";
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
} from "../src/index.js";
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
        headers: Object.fromEntries(request.headers),
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
        await hue.model("synthetic-model", { provider: "synthetic" }, async (span) => {
          span.setInput([{ role: "user", content: "hi" }]);
          span.setOutput([{ role: "assistant", content: "hello" }]);
          span.setUsage({ inputTokens: 3, outputTokens: 2 });
          // Invalid counts are omitted and counted, never thrown into application code.
          span.setUsage({ inputTokens: -1 });
        });
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
        await hue.flush();
        const [record] = endpoint.requests.flatMap((request) => request.records);
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
            span.setOutput(value as never);
            hue.recordMessages({ output: value as never });
            return hue.tool("effect", value as never, () => {
              executions++;
              return value as never;
            });
          },
          { input: value as never },
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
    const hue = createHue({ enabled: false, captureContent: false });
    const result = await hue.model("", { provider: "", operation: " " }, async (span) => {
      span.setInput({ messages: [] });
      span.setUsage({ inputTokens: -1 });
      return "ok";
    });
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
    await hue.model("", { provider: "synthetic" }, async () => "ok");
    expect(hue.transport.getReport().instrumentationFailures).toBe(1);
    await hue.shutdownSafe({ timeoutMillis: 200 });
  });
});
