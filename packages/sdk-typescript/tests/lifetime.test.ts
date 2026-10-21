import { afterAll, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import { Attachment, createHue, createHueSafe, createHueTransport } from "../src/index.js";

type RequestLifetime = { tasks: Promise<unknown>[]; waitUntil(promise: Promise<unknown>): void };
const requests = new AsyncLocalStorage<RequestLifetime>();
const contextSymbol = Symbol.for("@vercel/request-context");
const previous = Object.getOwnPropertyDescriptor(globalThis, contextSymbol);
Object.defineProperty(globalThis, contextSymbol, {
  configurable: true,
  value: { get: () => requests.getStore() },
});
afterAll(() => {
  if (previous) Object.defineProperty(globalThis, contextSymbol, previous);
  else Reflect.deleteProperty(globalThis, contextSymbol);
});

function lifetime(): RequestLifetime {
  return {
    tasks: [],
    waitUntil(promise) {
      this.tasks.push(promise);
    },
  };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for synthetic receiver");
    await Bun.sleep(5);
  }
}

function receiver(status = 200) {
  const arrived: { signal: string; release: () => void }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await request.arrayBuffer();
      const signal = new URL(request.url).pathname.split("/").at(-1)!;
      const ack = Promise.withResolvers<void>();
      arrived.push({ signal, release: ack.resolve });
      await ack.promise;
      return new Response(null, {
        status,
        headers: { "content-type": "application/x-protobuf", "hue-pending-spans": "1" },
      });
    },
  });
  return { arrived, server, url: `http://127.0.0.1:${server.port}` };
}

function client(baseUrl: string) {
  return createHue({
    apiKey: "synthetic-lifetime-key",
    serviceName: "lifetime-test",
    baseUrl,
    captureContent: true,
    liveSpans: false,
  });
}

describe("Vercel background lifetime", () => {
  test("registers synchronously and preserves batching while protecting the HTTP acknowledgement", async () => {
    const endpoint = receiver();
    const hue = client(endpoint.url);
    const request = lifetime();
    let completed = false;
    try {
      requests.run(request, () => {
        for (let index = 0; index < 20; index++) hue.tracer.startSpan(`work-${index}`).end();
      });
      expect(request.tasks).toHaveLength(20);
      expect(new Set(request.tasks).size).toBe(1);
      void Promise.all(request.tasks).then(() => (completed = true));
      await Bun.sleep(100);
      expect(endpoint.arrived).toHaveLength(0);
      expect(completed).toBe(false);
      await until(() => endpoint.arrived.length === 1);
      expect(endpoint.arrived[0]!.signal).toBe("traces");
      expect(completed).toBe(false);
      endpoint.arrived[0]!.release();
      await Promise.all(request.tasks);
      expect(hue.transport.getReport().acceptedSpans).toBe(20);
      expect(hue.transport.getReport().pendingSpans).toBe(0);
    } finally {
      for (const item of endpoint.arrived) item.release();
      await hue.shutdownSafe();
      await endpoint.server.stop(true);
    }
  });

  test("a full batch seals its cohort before a later request is admitted", async () => {
    const endpoint = receiver();
    const hue = client(endpoint.url);
    const first = lifetime();
    const second = lifetime();
    let firstDone = false;
    let secondDone = false;
    try {
      requests.run(first, () => {
        for (let index = 0; index < 128; index++) hue.tracer.startSpan(`first-${index}`).end();
      });
      expect(first.tasks).toHaveLength(128);
      expect(new Set(first.tasks).size).toBe(1);
      requests.run(second, () => hue.tracer.startSpan("second-request").end());
      expect(second.tasks).toHaveLength(1);
      expect(first.tasks[0]).not.toBe(second.tasks[0]);
      void Promise.all(first.tasks).then(() => (firstDone = true));
      void Promise.all(second.tasks).then(() => (secondDone = true));
      await until(() => endpoint.arrived.length === 1);
      endpoint.arrived[0]!.release();
      await until(() => firstDone);
      expect(secondDone).toBe(false);
      await until(() => endpoint.arrived.length === 2);
      expect(secondDone).toBe(false);
      endpoint.arrived[1]!.release();
      await Promise.all(second.tasks);
      expect(hue.transport.getReport().acceptedSpans).toBe(129);
    } finally {
      for (const item of endpoint.arrived) item.release();
      await hue.shutdownSafe();
      await endpoint.server.stop(true);
    }
  });

  test("background failures remain observable by the next explicit flush", async () => {
    const endpoint = receiver(400);
    const hue = client(endpoint.url);
    const request = lifetime();
    try {
      requests.run(request, () => hue.tracer.startSpan("refused").end());
      await until(() => endpoint.arrived.length === 1);
      endpoint.arrived[0]!.release();
      await Promise.all(request.tasks);
      const result = await hue.flushSafe();
      expect(result.ok).toBe(false);
      expect(result.report.failedSpans).toBe(1);
      expect((await hue.flush()).failedSpans).toBe(1);
      expect(endpoint.arrived).toHaveLength(1);
    } finally {
      for (const item of endpoint.arrived) item.release();
      await hue.shutdownSafe();
      await endpoint.server.stop(true);
    }
  });

  test("borrowed providers deliver both spans and logs without a provider flush", async () => {
    const endpoint = receiver();
    const transport = createHueTransport({
      apiKey: "synthetic-lifetime-key",
      serviceName: "borrowed-lifetime",
      baseUrl: endpoint.url,
      liveSpans: false,
    });
    const tracer = new TracerProvider({ spanProcessors: [transport.spanProcessor] });
    const logger = new LoggerProvider({ processors: [transport.logRecordProcessor] });
    let providerFlushes = 0;
    const hue = createHue({
      transport,
      tracerProvider: {
        getTracer: tracer.getTracer.bind(tracer),
        forceFlush: async () => {
          providerFlushes++;
        },
      },
      loggerProvider: {
        getLogger: logger.getLogger.bind(logger),
        forceFlush: async () => {
          providerFlushes++;
        },
      },
    });
    const request = lifetime();
    let settled = false;
    try {
      requests.run(request, () => {
        hue.tracer.startSpan("borrowed").end();
        logger.getLogger("synthetic").emit({ body: "borrowed log" });
      });
      expect(request.tasks).toHaveLength(2);
      expect(new Set(request.tasks).size).toBe(1);
      void Promise.all(request.tasks).then(() => (settled = true));
      await until(() => endpoint.arrived.length === 2);
      endpoint.arrived.find((item) => item.signal === "traces")!.release();
      await until(() => transport.getReport().pendingSpans === 0);
      expect(settled).toBe(false);
      endpoint.arrived.find((item) => item.signal === "logs")!.release();
      await Promise.all(request.tasks);
      expect(transport.getReport()).toMatchObject({ acceptedSpans: 1, acceptedLogs: 1 });
      expect(providerFlushes).toBe(0);
    } finally {
      for (const item of endpoint.arrived) item.release();
      await hue.shutdownSafe();
      await tracer.shutdown();
      await logger.shutdown();
      await transport.shutdown();
      await endpoint.server.stop(true);
    }
  });

  test.each([200, 400])(
    "keeps the host alive through media delivery and its final report (PUT status %i)",
    async (status) => {
      const bytes = Buffer.alloc(96 * 1024, 42);
      const uploaded = Promise.withResolvers<void>();
      const completed = Promise.withResolvers<void>();
      let put = false;
      let completing = false;
      let body: Buffer | undefined;
      let reservation: { sha256: string; byteSize: number } | undefined;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request): Promise<Response> {
          const path = new URL(request.url).pathname;
          if (path === "/api/v1/otlp/blobs") {
            const value = (await request.json()) as {
              key: string;
              sha256: string;
              byteSize: number;
              contentType: string;
            };
            reservation = value;
            return Response.json({
              status: "upload",
              method: "PUT",
              url: `http://127.0.0.1:${server.port}/store`,
              expiresAt: new Date(Date.now() + 60000).toISOString(),
              headers: {
                "Content-Type": value.contentType,
                "Content-Length": String(value.byteSize),
              },
              ref: {
                key: value.key,
                sha256: value.sha256,
                size: value.byteSize,
                content_type: value.contentType,
              },
            });
          }
          if (path === "/store") {
            body = Buffer.from(await request.arrayBuffer());
            put = true;
            await uploaded.promise;
            return new Response(null, { status });
          }
          if (path === "/api/v1/otlp/blobs/complete") {
            await request.arrayBuffer();
            completing = true;
            await completed.promise;
            return Response.json({ status: "complete" });
          }
          await request.arrayBuffer();
          return new Response(null, { headers: { "hue-pending-spans": "1" } });
        },
      });
      const hue = client(`http://127.0.0.1:${server.port}`);
      const request = lifetime();
      let settled = false;
      try {
        await requests.run(request, () =>
          hue.withSpan("media", (span) => {
            span.setInput({ file: new Attachment({ data: bytes, contentType: "image/png" }) });
          }),
        );
        expect(request.tasks).toHaveLength(1);
        void Promise.all(request.tasks).then(() => (settled = true));
        await until(() => put && hue.transport.getReport().acceptedSpans === 1);
        expect(hue.transport.getReport().acceptedSpans).toBe(1);
        expect(settled).toBe(false);
        expect(body).toEqual(bytes);
        expect(reservation).toMatchObject({
          byteSize: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
        uploaded.resolve();
        if (status === 200) {
          await until(() => completing);
          expect(settled).toBe(false);
          completed.resolve();
        }
        await Promise.all(request.tasks);
        expect(hue.transport.getReport()).toMatchObject({
          uploadedValues: status === 200 ? 1 : 0,
          uploadFallbacks: status === 200 ? 0 : 1,
        });
      } finally {
        uploaded.resolve();
        completed.resolve();
        await hue.shutdownSafe();
        await server.stop(true);
      }
    },
  );

  test("a short explicit timeout does not settle the host's delivery promise", async () => {
    const endpoint = receiver();
    const hue = client(endpoint.url);
    const request = lifetime();
    let completed = false;
    try {
      requests.run(request, () => hue.tracer.startSpan("slow-ack").end());
      void Promise.all(request.tasks).then(() => (completed = true));
      expect((await hue.flushSafe({ timeoutMillis: 10 })).timedOut).toBe(true);
      await until(() => endpoint.arrived.length === 1);
      expect(completed).toBe(false);
      endpoint.arrived[0]!.release();
      await Promise.all(request.tasks);
      expect(hue.transport.getReport().acceptedSpans).toBe(1);
    } finally {
      for (const item of endpoint.arrived) item.release();
      await hue.shutdownSafe();
      await endpoint.server.stop(true);
    }
  });

  test("a throwing host hook does not undo an admitted record", async () => {
    const endpoint = receiver();
    const hue = client(endpoint.url);
    try {
      requests.run(
        {
          tasks: [],
          waitUntil: () => {
            throw new Error("synthetic host failure");
          },
        },
        () => {
          expect(() => hue.tracer.startSpan("host-hook-failure").end()).not.toThrow();
        },
      );
      expect(hue.transport.getReport().pendingSpans).toBe(1);
      const flushed = hue.flushSafe();
      await until(() => endpoint.arrived.length === 1);
      endpoint.arrived[0]!.release();
      expect((await flushed).ok).toBe(true);
    } finally {
      for (const item of endpoint.arrived) item.release();
      await hue.shutdownSafe();
      await endpoint.server.stop(true);
    }
  });

  test("outside a request context batching still sends records and disabled clients register nothing", async () => {
    const endpoint = receiver();
    const hue = client(endpoint.url);
    const disabled = createHueSafe({ enabled: false });
    const request = lifetime();
    try {
      requests.run(request, () => disabled.tracer.startSpan("disabled").end());
      expect(request.tasks).toHaveLength(0);
      hue.tracer.startSpan("outside-vercel").end();
      await until(() => endpoint.arrived.length === 1);
      endpoint.arrived[0]!.release();
      await until(() => hue.transport.getReport().pendingSpans === 0);
      expect(hue.transport.getReport().acceptedSpans).toBe(1);
      expect((await hue.flushSafe()).ok).toBe(true);
    } finally {
      for (const item of endpoint.arrived) item.release();
      await disabled.shutdownSafe();
      await hue.shutdownSafe();
      await endpoint.server.stop(true);
    }
  });
});
