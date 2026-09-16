import { describe, expect, test } from "bun:test";
import { createHue, HueTraceVerificationError, type VerifyTraceOptions } from "../src/index.js";

const traceId = "1234567890abcdef1234567890abcdef";
const spanId = "1234567890abcdef";
const childId = "2234567890abcdef";
const key = "synthetic-receipt-key";

function receiver(reply: (request: Request, attempt: number) => Response | Promise<Response>) {
  let hits = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
      expect(new URL(request.url).pathname).toBe(`/api/v1/traces/${traceId}/receipt`);
      return reply(request, ++hits);
    },
  });
  const hue = createHue({
    apiKey: key,
    serviceName: "receipt",
    captureContent: true,
    baseUrl: `http://127.0.0.1:${server.port}`,
  });
  return { server, hue, hits: () => hits };
}

function receipt(request: Request, overrides: Record<string, unknown> = {}) {
  return {
    traceId,
    spanCount: 2,
    revision: 1,
    fields: { input: true, output: true, model: true, usage: false, session: false },
    matchedSpanIds: new URL(request.url).searchParams.getAll("expectedSpanId"),
    missingSpanIds: [],
    traceUrl: `${new URL(request.url).origin}/traces/synthetic?projectId=synthetic`,
    ...overrides,
  };
}

async function failure(
  work: Promise<unknown>,
  code: HueTraceVerificationError["code"],
  status?: number,
) {
  try {
    await work;
    throw new Error("Expected verification failure");
  } catch (error) {
    expect(error).toBeInstanceOf(HueTraceVerificationError);
    expect((error as HueTraceVerificationError).code).toBe(code);
    expect((error as HueTraceVerificationError).status).toBe(status);
    expect(String(error)).not.toContain(key);
  }
}

describe("stored trace verification", () => {
  test("waits for exact trace and expected spans, without export or implicit flush", async () => {
    const endpoint = receiver((request, attempt) => {
      expect(new URL(request.url).searchParams.getAll("expectedSpanId")).toEqual([spanId, childId]);
      if (attempt === 1)
        return Response.json(
          { error: "Trace not found.", code: "TRACE_NOT_FOUND" },
          { status: 404 },
        );
      return Response.json(
        receipt(
          request,
          attempt === 2
            ? { matchedSpanIds: [spanId], missingSpanIds: [childId], spanCount: 1 }
            : { matchedSpanIds: [childId, spanId] },
        ),
      );
    });
    try {
      const result = await endpoint.hue.verifyTrace(traceId, {
        expectedSpanIds: [spanId, childId],
        requiredFields: ["input", "output", "model"],
        timeoutMillis: 2500,
      });
      expect(result.verified).toBe(true);
      expect(result.receipt?.matchedSpanIds).toEqual([spanId, childId]);
      expect(endpoint.hits()).toBe(3);
    } finally {
      await endpoint.hue.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("returns latest evidence, not success, when required fields remain absent", async () => {
    const endpoint = receiver((request) => Response.json(receipt(request)));
    try {
      const result = await endpoint.hue.verifyTrace(traceId, {
        requiredFields: ["usage", "session"],
        timeoutMillis: 350,
      });
      expect(result.verified).toBe(false);
      expect(result.receipt?.fields.usage).toBe(false);
      expect(endpoint.hits()).toBeGreaterThanOrEqual(1);
      expect(endpoint.hits()).toBeLessThanOrEqual(2);
    } finally {
      await endpoint.hue.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("can verify arrival without requiring content or inferred usage", async () => {
    const endpoint = receiver((request) =>
      Response.json(
        receipt(request, {
          fields: { input: false, output: false, model: false, usage: false, session: false },
        }),
      ),
    );
    try {
      expect((await endpoint.hue.verifyTrace(traceId)).verified).toBe(true);
    } finally {
      await endpoint.hue.shutdown();
      endpoint.server.stop(true);
    }
  });

  test.each([401, 403, 400, 500])("fails promptly and safely for HTTP %s", async (status) => {
    const endpoint = receiver(() => new Response(`reflected ${key}`, { status }));
    try {
      await failure(
        endpoint.hue.verifyTrace(traceId),
        status === 401 || status === 403 ? "authentication" : "http",
        status,
      );
      expect(endpoint.hits()).toBe(1);
    } finally {
      await endpoint.hue.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("an unrelated 404 is unsupported, not waiting for a trace", async () => {
    const endpoint = receiver(() => Response.json({ error: key }, { status: 404 }));
    try {
      await failure(endpoint.hue.verifyTrace(traceId), "http", 404);
      expect(endpoint.hits()).toBe(1);
    } finally {
      await endpoint.hue.shutdown();
      endpoint.server.stop(true);
    }
  });

  test.each([429, 503])("retries HTTP %s within the bounded budget", async (status) => {
    const endpoint = receiver((request, attempt) =>
      attempt === 1
        ? new Response(key, { status, headers: { "retry-after": "0" } })
        : Response.json(receipt(request)),
    );
    try {
      expect((await endpoint.hue.verifyTrace(traceId, { timeoutMillis: 1000 })).verified).toBe(
        true,
      );
      expect(endpoint.hits()).toBe(2);
    } finally {
      await endpoint.hue.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("does not violate Retry-After to fit its deadline", async () => {
    const endpoint = receiver(
      () => new Response(key, { status: 503, headers: { "retry-after": "10" } }),
    );
    const start = performance.now();
    try {
      expect(await endpoint.hue.verifyTrace(traceId, { timeoutMillis: 100 })).toEqual({
        verified: false,
        receipt: null,
      });
      expect(endpoint.hits()).toBe(1);
      expect(performance.now() - start).toBeLessThan(1000);
    } finally {
      await endpoint.hue.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("deadline bounds a stalled response body", async () => {
    const endpoint = receiver(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"traceId":'));
            },
          }),
        ),
    );
    const start = performance.now();
    try {
      expect(await endpoint.hue.verifyTrace(traceId, { timeoutMillis: 100 })).toEqual({
        verified: false,
        receipt: null,
      });
      expect(performance.now() - start).toBeLessThan(1000);
    } finally {
      await endpoint.hue.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("deadline also bounds waiting for response headers", async () => {
    const endpoint = receiver(async (request) => {
      await Bun.sleep(1500);
      return Response.json(receipt(request));
    });
    const start = performance.now();
    try {
      expect(await endpoint.hue.verifyTrace(traceId, { timeoutMillis: 75 })).toEqual({
        verified: false,
        receipt: null,
      });
      expect(performance.now() - start).toBeLessThan(1000);
    } finally {
      await endpoint.hue.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("connection errors are actionable and do not echo the credential", async () => {
    const endpoint = receiver((request) => Response.json(receipt(request)));
    endpoint.server.stop(true);
    try {
      await failure(endpoint.hue.verifyTrace(traceId), "transport");
    } finally {
      await endpoint.hue.shutdown();
    }
  });

  test("returns only documented fields from an otherwise valid receipt", async () => {
    const endpoint = receiver((request) => Response.json(receipt(request, { extra: key })));
    try {
      expect(JSON.stringify(await endpoint.hue.verifyTrace(traceId))).not.toContain(key);
    } finally {
      await endpoint.hue.shutdown();
      endpoint.server.stop(true);
    }
  });

  test("refuses redirects without forwarding the key", async () => {
    let destinationHits = 0;
    const destination = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        destinationHits++;
        return new Response();
      },
    });
    const endpoint = receiver(
      () =>
        new Response(null, {
          status: 307,
          headers: { location: `http://127.0.0.1:${destination.port}` },
        }),
    );
    try {
      await failure(endpoint.hue.verifyTrace(traceId), "http", 307);
      expect(destinationHits).toBe(0);
    } finally {
      await endpoint.hue.shutdown();
      endpoint.server.stop(true);
      destination.stop(true);
    }
  });

  test.each([
    { traceId: "a".repeat(32) },
    { spanCount: -1 },
    { revision: 1.5 },
    { fields: { input: 1, output: true, model: true, usage: true, session: true } },
    { matchedSpanIds: [spanId], missingSpanIds: [spanId] },
    { matchedSpanIds: [], missingSpanIds: [] },
    { matchedSpanIds: [childId], missingSpanIds: [] },
    { traceUrl: "https://unrelated.invalid/traces" },
    { traceUrl: "javascript:alert(1)" },
  ])("rejects malformed or uncorrelated receipt %#", async (overrides) => {
    const endpoint = receiver((request) => Response.json(receipt(request, overrides)));
    try {
      await failure(
        endpoint.hue.verifyTrace(traceId, { expectedSpanIds: [spanId] }),
        "invalid_response",
      );
    } finally {
      await endpoint.hue.shutdown();
      endpoint.server.stop(true);
    }
  });

  test.each(["not JSON", " ".repeat(65537)])(
    "bounds and validates response bodies %#",
    async (body) => {
      const endpoint = receiver(() => new Response(body));
      try {
        await failure(endpoint.hue.verifyTrace(traceId), "invalid_response");
      } finally {
        await endpoint.hue.shutdown();
        endpoint.server.stop(true);
      }
    },
  );

  test("validates all options before making any request", async () => {
    const endpoint = receiver((request) => Response.json(receipt(request)));
    try {
      for (const id of ["0".repeat(32), "A".repeat(32), "wrong", `${traceId}\n`])
        await expect(endpoint.hue.verifyTrace(id)).rejects.toBeInstanceOf(TypeError);
      const bad: unknown[] = [
        null,
        { timeoutMillis: null },
        { timeoutMillis: NaN },
        { timeoutMillis: Infinity },
        { timeoutMillis: 0 },
        { timeoutMillis: 60001 },
        { expectedSpanIds: null },
        { expectedSpanIds: [`${spanId}\n`] },
        { expectedSpanIds: [spanId, spanId] },
        { expectedSpanIds: ["0".repeat(16)] },
        { requiredFields: null },
        { requiredFields: ["content"] },
        { requiredFields: ["input", "input"] },
      ];
      for (const options of bad)
        await expect(
          endpoint.hue.verifyTrace(traceId, options as VerifyTraceOptions),
        ).rejects.toBeInstanceOf(TypeError);
      expect(endpoint.hits()).toBe(0);
    } finally {
      await endpoint.hue.shutdown();
      endpoint.server.stop(true);
    }
  });
});
