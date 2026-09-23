import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs/light.js";
import { context, SpanKind, trace, TraceFlags } from "@opentelemetry/api";
import { TracerProvider, type SpanProcessor } from "@opentelemetry/sdk-trace";
import { createHue, createHueTransport, HueExportError, type HueTransport } from "../src/index.js";
import schema from "./fixtures/otlp-schema.json" with { type: "json" };

type Attribute = { key: string; value: { stringValue?: string } };
type WireSpan = {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: number;
  flags: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attribute[];
  status?: { code?: number };
  scope: string;
};
type Reply = { status?: number; rejectedSpans?: number; errorMessage?: string };

const root = protobuf.Root.fromJSON(schema);
const traces = "opentelemetry.proto.collector.trace.v1.ExportTraceService";
const apiKey = "synthetic-hue-test-key";
// Long enough for at least one 500 ms announcement tick, for checks that nothing was announced.
const pastTicks = 1100;
// Per-test budget: waits for announcement ticks are bounded well below it.
const timeout = 15_000;

const hex = (value: string) => Buffer.from(value, "base64").toString("hex");

/** Waits for a queue state the next announcement tick produces, instead of guessing its timing. */
async function until(condition: () => boolean, what: string, timeoutMillis = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMillis;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

const queued = (transport: HueTransport, count: number) =>
  until(() => transport.getReport().pendingSpans === count, `${count} queued spans`);

/**
 * Loopback OTLP receiver; `reply` chooses the acknowledgement for each trace request. A current
 * Hue marks trace acknowledgements with `Hue-Pending-Spans: 1`; `legacy` omits it, like a Hue
 * from before placeholders. `hold` delays each trace acknowledgement until it settles.
 */
function receiver(
  reply: (spans: WireSpan[]) => Reply = () => ({}),
  { legacy = false, hold }: { legacy?: boolean; hold?: Promise<void> } = {},
) {
  const requests: WireSpan[][] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      let bytes = Buffer.from(await request.arrayBuffer());
      if (request.headers.get("content-encoding") === "gzip") bytes = gunzipSync(bytes);
      // An empty message is a valid acknowledgement for logs and traces alike.
      if (new URL(request.url).pathname.endsWith("/logs")) return new Response(new Uint8Array());
      const type = root.lookupType(`${traces}Request`);
      const data = type.toObject(type.decode(bytes), {
        longs: String,
        bytes: String,
        defaults: true,
      });
      const spans: WireSpan[] = data.resourceSpans.flatMap(
        (group: { scopeSpans: { scope?: { name?: string }; spans: WireSpan[] }[] }) =>
          group.scopeSpans.flatMap((scope) =>
            scope.spans.map((span) => ({
              ...span,
              traceId: hex(span.traceId),
              spanId: hex(span.spanId),
              parentSpanId: hex(span.parentSpanId),
              scope: scope.scope?.name ?? "",
            })),
          ),
      );
      requests.push(spans);
      await hold;
      const { status, rejectedSpans, errorMessage } = reply(spans);
      if (status) return new Response("synthetic failure", { status });
      const response = root.lookupType(`${traces}Response`);
      const body = rejectedSpans
        ? { partialSuccess: { rejectedSpans: String(rejectedSpans), errorMessage } }
        : {};
      return new Response(new Uint8Array(response.encode(response.fromObject(body)).finish()), {
        headers: {
          "content-type": "application/x-protobuf",
          ...(legacy ? {} : { "hue-pending-spans": "1" }),
        },
      });
    },
  });
  const spans = () => requests.flat();
  return {
    server,
    requests,
    url: `http://127.0.0.1:${server.port}`,
    spans,
    placeholders: () => spans().filter(isPlaceholder),
    real: () => spans().filter((span) => !isPlaceholder(span)),
  };
}

function attr(span: WireSpan, key: string): string | undefined {
  return span.attributes.find((item) => item.key === key)?.value.stringValue;
}

function isPlaceholder(span: WireSpan): boolean {
  return attr(span, "hue.span_type") === "pending_span";
}

describe("Live spans", () => {
  test(
    "a running span is announced by a trimmed placeholder keyed to the real span",
    async () => {
      const endpoint = receiver();
      const hue = createHue({
        apiKey,
        serviceName: "live",
        captureContent: true,
        baseUrl: endpoint.url,
      });
      try {
        await hue.withSpan(
          "chat.request",
          async (request) => {
            const chat = hue.tracer.startSpan(
              "chat synthetic-model",
              {
                kind: SpanKind.CLIENT,
                attributes: {
                  "gen_ai.operation.name": "chat",
                  "gen_ai.tool.definitions": "[]",
                  "gen_ai.system_instructions": "Answer briefly",
                  "synthetic.large": "x".repeat(65 * 1024),
                  "synthetic.small": "kept",
                },
              },
              request.context,
            );
            await queued(hue.transport, 2);
            const mid = await hue.flush();
            expect(mid.acceptedSpans).toBe(0);
            expect(endpoint.placeholders()).toHaveLength(2);
            chat.end();
          },
          // A copied marker must not survive onto a root's placeholder.
          { attributes: { "hue.pending_parent_id": "ffffffffffffffff" } },
        );
        const report = await hue.flush();
        expect(report.acceptedSpans).toBe(2);
        expect(report.pendingSpans).toBe(0);

        const request = endpoint.real().find((span) => span.name === "chat.request")!;
        const chat = endpoint.real().find((span) => span.name === "chat synthetic-model")!;
        const pending = endpoint.placeholders().find((span) => span.parentSpanId === chat.spanId)!;
        expect(pending.spanId).not.toBe(chat.spanId);
        expect(pending.traceId).toBe(chat.traceId);
        // Re-keyed as the real span by Hue, so the flags describe the real span's own parent.
        expect(pending.flags).toBe(chat.flags);
        expect(pending.name).toBe(chat.name);
        expect(pending.kind).toBe(chat.kind);
        expect(pending.scope).toBe(chat.scope);
        expect(pending.startTimeUnixNano).toBe(chat.startTimeUnixNano);
        expect(pending.endTimeUnixNano).toBe("0");
        expect(pending.status?.code ?? 0).toBe(0);
        expect(attr(pending, "hue.pending_parent_id")).toBe(request.spanId);
        expect(attr(pending, "gen_ai.operation.name")).toBe("chat");
        expect(attr(pending, "synthetic.small")).toBe("kept");
        const keys = pending.attributes.map((item) => item.key);
        for (const key of [
          "gen_ai.tool.definitions",
          "gen_ai.system_instructions",
          "synthetic.large",
        ]) {
          expect(keys).not.toContain(key);
          // The real span is unchanged by its placeholder's trimming.
          expect(chat.attributes.map((item) => item.key)).toContain(key);
        }
        expect(isPlaceholder(chat)).toBe(false);

        // `withSpan` spans carry no AI attributes; Hue's own instrumentation scope announces them.
        const rootPending = endpoint
          .placeholders()
          .find((span) => span.parentSpanId === request.spanId)!;
        expect(request.scope).toBe("@hue-run/sdk");
        expect(request.attributes.some((item) => item.key.startsWith("gen_ai."))).toBe(false);
        expect(rootPending.name).toBe("chat.request");
        expect(rootPending.endTimeUnixNano).toBe("0");
        expect(attr(rootPending, "hue.pending_parent_id")).toBeUndefined();
        expect(hue.transport.getIssues()).toEqual([]);
      } finally {
        await hue.shutdown();
        await endpoint.server.stop(true);
      }
    },
    timeout,
  );

  test(
    "a finished span never carries the placeholder markers an application set",
    async () => {
      const endpoint = receiver();
      const hue = createHue({
        apiKey,
        serviceName: "live-markers",
        captureContent: false,
        baseUrl: endpoint.url,
      });
      try {
        const span = hue.tracer.startSpan("custom.step", {
          attributes: {
            "hue.span_type": "pending_span",
            "hue.pending_parent_id": "0123456789abcdef",
            "app.kept": "yes",
          },
        });
        span.end();
        await hue.flush();
        const [finished] = endpoint.real().filter((item) => item.name === "custom.step");
        expect(finished).toBeDefined();
        expect(attr(finished!, "hue.pending_parent_id")).toBeUndefined();
        expect(attr(finished!, "app.kept")).toBe("yes");
        expect(endpoint.placeholders()).toEqual([]);
      } finally {
        await hue.shutdown();
        await endpoint.server.stop(true);
      }
    },
    timeout,
  );

  test(
    "helper input and tool arguments set after start appear in placeholders",
    async () => {
      const endpoint = receiver();
      const hue = createHue({
        apiKey,
        serviceName: "live-input",
        captureContent: true,
        baseUrl: endpoint.url,
      });
      try {
        await hue.withSpan(
          "chat.request",
          () =>
            hue.tool("lookup_order", { orderId: "A-17" }, async () => {
              await queued(hue.transport, 2);
              await hue.flush();
              return "shipped";
            }),
          { input: "Where is my order?" },
        );
        await hue.flush();
        const pending = new Map(endpoint.placeholders().map((span) => [span.name, span]));
        expect(attr(pending.get("chat.request")!, "input.value")).toBe(
          JSON.stringify("Where is my order?"),
        );
        expect(attr(pending.get("execute_tool lookup_order")!, "gen_ai.tool.call.arguments")).toBe(
          JSON.stringify({ orderId: "A-17" }),
        );
        // Output recorded later belongs only to the real span.
        expect(
          attr(pending.get("execute_tool lookup_order")!, "gen_ai.tool.call.result"),
        ).toBeUndefined();
      } finally {
        await hue.shutdown();
        await endpoint.server.stop(true);
      }
    },
    timeout,
  );

  test(
    "metadata-only capture removes third-party content from placeholders",
    async () => {
      const endpoint = receiver();
      const transport = createHueTransport({
        apiKey,
        serviceName: "live-metadata",
        captureContent: false,
        baseUrl: endpoint.url,
      });
      const provider = new TracerProvider({ spanProcessors: [transport.spanProcessor] });
      try {
        const span = provider.getTracer("customer").startSpan("ai.streamText", {
          attributes: {
            "ai.model.id": "synthetic-model",
            "ai.prompt": "private prompt",
            "gen_ai.input.messages": '[{"role":"user","content":"private message"}]',
            "input.value": "private input",
          },
        });
        await queued(transport, 1);
        await transport.flush();
        const [pending] = endpoint.placeholders();
        expect(attr(pending!, "ai.model.id")).toBe("synthetic-model");
        expect(JSON.stringify(endpoint.spans())).not.toContain("private");
        span.end();
        await transport.flush();
        expect(endpoint.real()).toHaveLength(1);
        expect(JSON.stringify(endpoint.spans())).not.toContain("private");
      } finally {
        await provider.shutdown();
        await transport.shutdown();
        await endpoint.server.stop(true);
      }
    },
    timeout,
  );

  test(
    "spans that end before their batch is exported send no placeholder",
    async () => {
      const endpoint = receiver();
      const hue = createHue({
        apiKey,
        serviceName: "live-short",
        captureContent: true,
        baseUrl: endpoint.url,
      });
      try {
        await hue.withSpan("synchronous", () => {});
        await hue.flush();
        await hue.withSpan("chat.request", async () => {
          // The tick queued a placeholder; its real span now joins the same batch.
          await queued(hue.transport, 1);
        });
        expect(hue.transport.getReport().pendingSpans).toBe(2);
        const report = await hue.flush();
        expect(endpoint.placeholders()).toEqual([]);
        expect(endpoint.real().map((span) => span.name)).toEqual(["synchronous", "chat.request"]);
        expect(report.acceptedSpans).toBe(2);
        expect(report.pendingSpans).toBe(0);
      } finally {
        await hue.shutdown();
        await endpoint.server.stop(true);
      }
    },
    timeout,
  );

  test(
    "a redactor that masks hexadecimal text cannot alter placeholder markers",
    async () => {
      const endpoint = receiver();
      const hue = createHue({
        apiKey,
        serviceName: "live-redaction",
        captureContent: true,
        baseUrl: endpoint.url,
        redact: (text) => text.replace(/[0-9a-f]/g, "#"),
      });
      try {
        await hue.withSpan("chat.request", () =>
          hue.withSpan(
            "step",
            async () => {
              await queued(hue.transport, 2);
              await hue.flush();
            },
            { input: "abc" },
          ),
        );
        await hue.flush();
        const request = endpoint.real().find((span) => span.name === "chat.request")!;
        const step = endpoint.real().find((span) => span.name === "step")!;
        const pending = endpoint.placeholders().find((span) => span.name === "step")!;
        expect(pending.parentSpanId).toBe(step.spanId);
        expect(attr(pending, "hue.span_type")).toBe("pending_span");
        expect(attr(pending, "hue.pending_parent_id")).toBe(request.spanId);
        // The redactor did run on the placeholder's own attributes.
        expect(attr(pending, "input.value")).toBe('"###"');
      } finally {
        await hue.shutdown();
        await endpoint.server.stop(true);
      }
    },
    timeout,
  );

  test.each([
    ["failed request", { status: 401 }],
    ["rejection", { rejectedSpans: 1, errorMessage: "Invalid pending span placeholder" }],
  ] as const)(
    "a %s involving only placeholders is a warning and flush succeeds",
    async (_name, failure) => {
      const endpoint = receiver((spans) => (spans.every(isPlaceholder) ? failure : {}));
      const hue = createHue({
        apiKey,
        serviceName: "live-warning",
        captureContent: false,
        baseUrl: endpoint.url,
      });
      try {
        await hue.withSpan("chat.request", async () => {
          await queued(hue.transport, 1);
          const mid = await hue.flush();
          expect(mid.failedSpans + mid.rejectedSpans).toBe(0);
        });
        // Only an older server's missing header turns live spans off: the next span is announced.
        await hue.withSpan("later", () => queued(hue.transport, 1));
        const report = await hue.flush();
        expect(endpoint.placeholders()).toHaveLength(1);
        expect(report.acceptedSpans).toBe(2);
        expect(report.failedSpans + report.rejectedSpans + report.droppedSpans).toBe(0);
        expect(hue.transport.getFailureSequence()).toBe(0);
        const issues = hue.transport.getIssues();
        expect(issues).toEqual([expect.objectContaining({ kind: "warning", count: 1 })]);
        expect(JSON.stringify(issues)).not.toContain("Invalid pending span placeholder");
      } finally {
        await hue.shutdown();
        await endpoint.server.stop(true);
      }
    },
    timeout,
  );

  test(
    "a failed request mixing real spans and placeholders counts only the real spans",
    async () => {
      let requests = 0;
      const endpoint = receiver(() => (++requests === 1 ? { status: 401 } : {}));
      const hue = createHue({
        apiKey,
        serviceName: "live-mixed",
        captureContent: false,
        baseUrl: endpoint.url,
      });
      try {
        await hue.withSpan("chat.request", async () => {
          await queued(hue.transport, 1);
          await hue.withSpan("quick", () => {});
          const error = await hue.flush().catch((reason: unknown) => reason);
          expect(error).toBeInstanceOf(HueExportError);
          // The placeholder in the failed request is not counted as a lost record.
          expect((error as HueExportError).issues.filter((issue) => issue.count > 0)).toEqual([
            expect.objectContaining({ kind: "failed", count: 1, status: 401 }),
          ]);
        });
        const report = await hue.flush();
        expect(endpoint.requests[0]!.map(isPlaceholder)).toEqual([false, true]);
        expect(report.failedSpans).toBe(1);
        expect(report.acceptedSpans).toBe(1);
      } finally {
        await hue.shutdown();
        await endpoint.server.stop(true);
      }
    },
    timeout,
  );

  test(
    "an older Hue rejecting placeholders turns live spans off with one warning",
    async () => {
      // Mirrors a receiver from before placeholders: a zero end time is rejected per record.
      const endpoint = receiver(
        (spans) => {
          const rejected = spans.filter((span) => span.endTimeUnixNano === "0").length;
          return rejected
            ? { rejectedSpans: rejected, errorMessage: "Invalid span start or end timestamp" }
            : {};
        },
        { legacy: true },
      );
      const hue = createHue({
        apiKey,
        serviceName: "live-downgrade",
        captureContent: false,
        baseUrl: endpoint.url,
      });
      try {
        await hue.withSpan("chat.request", async () => {
          await queued(hue.transport, 1);
          await hue.withSpan("quick", () => {});
          const mid = await hue.flush();
          expect(endpoint.requests[0]!.map(isPlaceholder)).toEqual([false, true]);
          expect(mid.acceptedSpans).toBe(1);
          expect(mid.rejectedSpans).toBe(0);
          await hue.withSpan("later", async () => {
            await Bun.sleep(pastTicks);
            expect(hue.transport.getReport().pendingSpans).toBe(0);
          });
        });
        const report = await hue.flush();
        expect(endpoint.placeholders()).toHaveLength(1);
        expect(report.acceptedSpans).toBe(3);
        expect(report.rejectedSpans + report.failedSpans).toBe(0);
        expect(hue.transport.getFailureSequence()).toBe(0);
        expect(hue.transport.getIssues()).toEqual([
          expect.objectContaining({
            kind: "warning",
            count: 1,
            message: expect.stringContaining("live spans are disabled"),
          }),
        ]);
      } finally {
        await hue.shutdown();
        await endpoint.server.stop(true);
      }
    },
    timeout,
  );

  test(
    "an older Hue's mixed rejection counts only the real rejections and turns live spans off",
    async () => {
      // One placeholder rejected by timestamp plus one real span rejected for another reason.
      const endpoint = receiver(
        (spans) =>
          spans.some(isPlaceholder)
            ? {
                rejectedSpans: spans.filter(isPlaceholder).length + 1,
                errorMessage: "Invalid span start or end timestamp Attribute limit exceeded",
              }
            : {},
        { legacy: true },
      );
      const hue = createHue({
        apiKey,
        serviceName: "live-downgrade-mixed",
        captureContent: false,
        baseUrl: endpoint.url,
      });
      try {
        await hue.withSpan("chat.request", async () => {
          await queued(hue.transport, 1);
          await hue.withSpan("first", () => {});
          await hue.withSpan("second", () => {});
          const error = await hue.flush().catch((reason: unknown) => reason);
          expect(endpoint.requests[0]!.map(isPlaceholder)).toEqual([false, false, true]);
          expect(error).toBeInstanceOf(HueExportError);
          expect((error as HueExportError).issues).toEqual([
            expect.objectContaining({ kind: "rejected", count: 1 }),
          ]);
          expect((error as HueExportError).report).toMatchObject({
            acceptedSpans: 1,
            rejectedSpans: 1,
          });
          await hue.withSpan("later", async () => {
            await Bun.sleep(pastTicks);
            expect(hue.transport.getReport().pendingSpans).toBe(0);
          });
        });
        const report = await hue.flush();
        expect(endpoint.placeholders()).toHaveLength(1);
        expect(report).toMatchObject({ acceptedSpans: 3, rejectedSpans: 1, failedSpans: 0 });
        expect(hue.transport.getIssues().filter((issue) => issue.kind === "warning")).toEqual([
          expect.objectContaining({
            count: 1,
            message: expect.stringContaining("live spans are disabled"),
          }),
        ]);
      } finally {
        await hue.shutdown();
        await endpoint.server.stop(true);
      }
    },
    timeout,
  );

  test(
    "a current Hue's timestamp rejection counts against real spans and keeps live spans on",
    async () => {
      // The same text an older Hue gives placeholders, here about a real span with a bad timestamp.
      const endpoint = receiver((spans) =>
        spans.some((span) => span.name === "bad timestamp")
          ? { rejectedSpans: 1, errorMessage: "Invalid span start or end timestamp" }
          : {},
      );
      const hue = createHue({
        apiKey,
        serviceName: "live-current",
        captureContent: false,
        baseUrl: endpoint.url,
      });
      try {
        await hue.withSpan("chat.request", () =>
          hue.withSpan("step", async () => {
            await queued(hue.transport, 2);
            await hue.withSpan("bad timestamp", () => {});
            const error = await hue.flush().catch((reason: unknown) => reason);
            expect(endpoint.requests[0]!.map(isPlaceholder)).toEqual([false, true, true]);
            expect(error).toBeInstanceOf(HueExportError);
            expect((error as HueExportError).issues).toEqual([
              expect.objectContaining({ kind: "rejected", count: 1 }),
            ]);
            expect((error as HueExportError).report).toMatchObject({
              acceptedSpans: 0,
              rejectedSpans: 1,
            });
            await hue.withSpan("later", async () => {
              await queued(hue.transport, 1);
              await hue.flush();
            });
          }),
        );
        await hue.flush();
        expect(endpoint.placeholders().map((span) => span.name)).toEqual([
          "chat.request",
          "step",
          "later",
        ]);
        expect(hue.transport.getIssues().map((issue) => issue.kind)).toEqual(["rejected"]);
      } finally {
        await hue.shutdown();
        await endpoint.server.stop(true);
      }
    },
    timeout,
  );

  test(
    "placeholders use at most a quarter of the export queue's records",
    async () => {
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const endpoint = receiver(() => ({}), { hold });
      const hue = createHue({
        apiKey,
        serviceName: "live-queue",
        captureContent: false,
        baseUrl: endpoint.url,
      });
      try {
        await hue.withSpan("chat.request", async () => {
          // Held by the receiver, a quarter of the 2,048-record queue stays pending.
          for (let index = 0; index < 512; index++) hue.tracer.startSpan("burst").end();
          await Bun.sleep(pastTicks);
          expect(hue.transport.getReport().pendingSpans).toBe(512);
          release();
        });
        const report = await hue.flush();
        expect(endpoint.placeholders()).toEqual([]);
        expect(report).toMatchObject({ acceptedSpans: 513, droppedSpans: 0, pendingSpans: 0 });
        expect(hue.transport.getIssues()).toEqual([]);
      } finally {
        release();
        await hue.shutdown();
        await endpoint.server.stop(true);
      }
    },
    timeout,
  );

  test(
    "placeholders use at most a quarter of the export queue's bytes",
    async () => {
      const endpoint = receiver();
      const hue = createHue({
        apiKey,
        serviceName: "live-bytes",
        captureContent: true,
        baseUrl: endpoint.url,
        // A quarter is 4 KiB, which a placeholder with this span's input exceeds.
        maxQueueBytes: 16 * 1024,
      });
      try {
        await hue.withSpan(
          "chat.request",
          async () => {
            await Bun.sleep(pastTicks);
            expect(hue.transport.getReport().pendingSpans).toBe(0);
          },
          { input: "x".repeat(3000) },
        );
        await hue.flush();
        // A small span's placeholder fits the same quarter; it is dropped with its real span.
        await hue.withSpan("small", () => queued(hue.transport, 1));
        const report = await hue.flush();
        expect(endpoint.placeholders()).toEqual([]);
        expect(report).toMatchObject({ acceptedSpans: 2, droppedSpans: 0, pendingSpans: 0 });
        expect(hue.transport.getIssues()).toEqual([]);
      } finally {
        await hue.shutdown();
        await endpoint.server.stop(true);
      }
    },
    timeout,
  );

  test.each([
    ["setup credentials", { apiKey: `hue_setup_test_setup-${"0".repeat(24)}_${"a".repeat(43)}` }],
    ["liveSpans: false", { apiKey, liveSpans: false }],
  ] as const)(
    "%s never announce running spans",
    async (_name, options) => {
      const endpoint = receiver();
      const hue = createHue({
        ...options,
        serviceName: "live-off",
        captureContent: false,
        baseUrl: endpoint.url,
      });
      try {
        expect(hue.transport.options.liveSpans).toBe(false);
        await hue.withSpan("chat.request", async () => {
          await Bun.sleep(pastTicks);
          expect(hue.transport.getReport().pendingSpans).toBe(0);
          await hue.flush();
        });
        const report = await hue.flush();
        expect(endpoint.placeholders()).toEqual([]);
        expect(report.acceptedSpans).toBe(1);
      } finally {
        await hue.shutdown();
        await endpoint.server.stop(true);
      }
    },
    timeout,
  );

  test(
    "liveSpans defaults on for enabled clients and must be a boolean",
    () => {
      const options = { apiKey, serviceName: "live-options", captureContent: false };
      const enabled = createHueTransport(options);
      expect(enabled.options.liveSpans).toBe(true);
      expect(createHueTransport({ enabled: false }).options.liveSpans).toBe(false);
      for (const liveSpans of ["false", 0, null]) {
        expect(() => createHue({ ...options, liveSpans } as never)).toThrow(
          new TypeError("liveSpans must be a boolean"),
        );
      }
    },
    timeout,
  );

  test(
    "a span continuing a remote parent announces it with the same remote flag",
    async () => {
      const endpoint = receiver();
      const transport = createHueTransport({
        apiKey,
        serviceName: "live-remote",
        captureContent: false,
        baseUrl: endpoint.url,
      });
      const provider = new TracerProvider({ spanProcessors: [transport.spanProcessor] });
      try {
        const upstream = trace.setSpanContext(context.active(), {
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: "b7ad6b7169203331",
          traceFlags: TraceFlags.SAMPLED,
          isRemote: true,
        });
        const span = provider
          .getTracer("customer")
          .startSpan(
            "chat remote-model",
            { attributes: { "gen_ai.operation.name": "chat" } },
            upstream,
          );
        await queued(transport, 1);
        await transport.flush();
        span.end();
        await transport.flush();
        const [pending] = endpoint.placeholders();
        const [real] = endpoint.real();
        expect(pending!.flags).toBe(real!.flags);
        // HAS_IS_REMOTE and IS_REMOTE are both set for a span whose parent is remote.
        expect(pending!.flags & 0x300).toBe(0x300);
      } finally {
        await provider.shutdown();
        await transport.shutdown();
        await endpoint.server.stop(true);
      }
    },
    timeout,
  );

  test(
    "a queued placeholder is not sent once its span has ended, even unseen by Hue",
    async () => {
      const endpoint = receiver();
      const transport = createHueTransport({
        apiKey,
        serviceName: "live-settled",
        captureContent: false,
        baseUrl: endpoint.url,
      });
      // Every start is forwarded, the filtered span's end is not.
      const wrapper: SpanProcessor = {
        onStart: (span, parent) => transport.spanProcessor.onStart(span, parent),
        onEnd: (span) => {
          if (span.name !== "filtered") transport.spanProcessor.onEnd(span);
        },
        forceFlush: () => transport.spanProcessor.forceFlush(),
        shutdown: () => transport.spanProcessor.shutdown(),
      };
      const provider = new TracerProvider({ spanProcessors: [wrapper] });
      try {
        const span = provider
          .getTracer("customer")
          .startSpan("filtered", { attributes: { "gen_ai.operation.name": "chat" } });
        await queued(transport, 1);
        // Ends after its placeholder was queued but before that placeholder is exported.
        span.end();
        const report = await transport.flush();
        expect(endpoint.spans()).toEqual([]);
        expect(report.pendingSpans).toBe(0);
      } finally {
        await provider.shutdown();
        await transport.shutdown();
        await endpoint.server.stop(true);
      }
    },
    timeout,
  );

  test(
    "spans a wrapping processor filtered are forgotten without a placeholder",
    async () => {
      const endpoint = receiver();
      const transport = createHueTransport({
        apiKey,
        serviceName: "live-wrapped",
        captureContent: false,
        baseUrl: endpoint.url,
      });
      // The documented borrowed-provider pattern: every start is forwarded, some ends are not.
      const wrapper: SpanProcessor = {
        onStart: (span, parent) => transport.spanProcessor.onStart(span, parent),
        onEnd: (span) => {
          if (span.name !== "filtered") transport.spanProcessor.onEnd(span);
        },
        forceFlush: () => transport.spanProcessor.forceFlush(),
        shutdown: () => transport.spanProcessor.shutdown(),
      };
      const provider = new TracerProvider({ spanProcessors: [wrapper] });
      try {
        const tracer = provider.getTracer("customer");
        const chat = { attributes: { "gen_ai.operation.name": "chat" } };
        // Ended, but never seen by Hue's onEnd: these fill the 1,024 tracked spans.
        for (let index = 0; index < 1024; index++) tracer.startSpan("filtered", chat).end();
        const overCap = tracer.startSpan("over cap", chat);
        await Bun.sleep(pastTicks);
        // The tick forgot the filtered spans, so tracking has room again.
        const after = tracer.startSpan("after", chat);
        await queued(transport, 1);
        await transport.flush();
        expect(endpoint.placeholders().map((span) => span.name)).toEqual(["after"]);
        overCap.end();
        after.end();
        const report = await transport.flush();
        expect(endpoint.real().map((span) => span.name)).toEqual(["over cap", "after"]);
        expect(report.pendingSpans).toBe(0);
      } finally {
        await provider.shutdown();
        await transport.shutdown();
        await endpoint.server.stop(true);
      }
    },
    timeout,
  );

  test(
    "only AI spans from other tracers are announced",
    async () => {
      const endpoint = receiver();
      const transport = createHueTransport({
        apiKey,
        serviceName: "live-borrowed",
        captureContent: false,
        baseUrl: endpoint.url,
      });
      const provider = new TracerProvider({ spanProcessors: [transport.spanProcessor] });
      try {
        const tracer = provider.getTracer("customer");
        const spans = [
          tracer.startSpan("POST /chat", { attributes: { "http.request.method": "POST" } }),
          tracer.startSpan("ai.streamText"),
          tracer.startSpan("model call", { attributes: { "llm.request.type": "chat" } }),
          tracer.startSpan("workflow", { attributes: { "traceloop.span.kind": "workflow" } }),
          tracer.startSpan("chat synthetic", { attributes: { "gen_ai.operation.name": "chat" } }),
        ];
        await queued(transport, 4);
        await transport.flush();
        expect(
          endpoint
            .placeholders()
            .map((span) => span.name)
            .sort(),
        ).toEqual(["ai.streamText", "chat synthetic", "model call", "workflow"]);
        for (const span of spans) span.end();
        const report = await transport.flush();
        expect(endpoint.real()).toHaveLength(5);
        expect(report.acceptedSpans).toBe(5);
      } finally {
        await provider.shutdown();
        await transport.shutdown();
        await endpoint.server.stop(true);
      }
    },
    timeout,
  );
});
