import { describe, expect, test } from "bun:test";
import { request } from "node:http";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { createHue, createHueTransport, type HueOptions } from "../src/index.js";
import { apiKey, attr, receiver } from "./sdk-receiver.js";

function provider() {
  const requests: { headers: Headers; body: string }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({ headers: request.headers, body: await request.text() });
      return Response.json({ ok: true, password: "synthetic-response-password" });
    },
  });
  return { requests, server, url: `http://127.0.0.1:${server.port}/call` };
}

const compressors = { gzip: gzipSync, br: brotliCompressSync, deflate: deflateSync } as const;
function compressedProvider(
  encoding: keyof typeof compressors,
  payload: unknown = { ok: true, text: "synthetic ".repeat(400) },
  wire: ReturnType<typeof gzipSync> = compressors[encoding](JSON.stringify(payload)),
) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(wire, {
        headers: { "content-type": "application/json", "content-encoding": encoding },
      }),
  });
  return { payload, wire, server, url: `http://127.0.0.1:${server.port}/compressed` };
}

function nodeHttpGet(url: string): Promise<{ encoding: string | undefined; body: Buffer }> {
  return new Promise((resolve, reject) => {
    request(url, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({ encoding: response.headers["content-encoding"], body: Buffer.concat(chunks) }),
      );
      response.on("error", reject);
    })
      .on("error", reject)
      .end();
  });
}

describe("default outbound HTTP capture", () => {
  test("records query and JSON bodies through the normal export privacy path without changing headers", async () => {
    const endpoint = receiver();
    const target = provider();
    const hue = createHue({
      apiKey,
      baseUrl: endpoint.url,
      serviceName: "http-default",
      liveSpans: false,
    });
    try {
      await hue.withSpan("request", async () => {
        const response = await fetch(`${target.url}?q=one&q=two&token=synthetic-query-token`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer synthetic-auth" },
          body: JSON.stringify({ text: "synthetic-input", password: "synthetic-input-password" }),
        });
        expect(response.bodyUsed).toBe(false);
        expect(response.body?.locked).toBe(false);
        expect(await response.json()).toEqual({
          ok: true,
          password: "synthetic-response-password",
        });
      });
      await hue.flush();
      const records = endpoint.accepted().filter((span) => attr(span, "http.request.method"));
      expect(records).toHaveLength(1);
      const span = records[0]!;
      expect(attr(span, "url.full")?.stringValue).toBe(target.url);
      expect(attr(span, "http.request.method")?.stringValue).toBe("POST");
      const input: unknown = JSON.parse(attr(span, "input.value")!.stringValue!);
      expect(input).toMatchObject({ q: ["one", "two"], text: "synthetic-input" });
      const output: unknown = JSON.parse(attr(span, "output.value")!.stringValue!);
      expect(output).toMatchObject({ ok: true });
      const wire = JSON.stringify(endpoint.accepted());
      for (const secret of [
        "synthetic-query-token",
        "synthetic-auth",
        "synthetic-input-password",
        "synthetic-response-password",
      ])
        expect(wire).not.toContain(secret);
      expect(target.requests[0]!.headers.get("traceparent")).toBeNull();
      expect(target.requests[0]!.headers.get("authorization")).toBe("Bearer synthetic-auth");
      const exports = endpoint.requests.length;
      await hue.flush();
      expect(endpoint.requests).toHaveLength(exports);
    } finally {
      await hue.shutdownSafe();
      await target.server.stop(true);
      await endpoint.server.stop(true);
    }
  });

  test.each([
    [{ captureHttp: false }, 0],
    [{ captureHttpBodies: false }, 1],
    [{ captureContent: false }, 1],
    [{ captureContent: false, captureHttpBodies: true }, 1],
    [{ enabled: false }, 0],
  ] satisfies [Partial<HueOptions>, number][])(
    "honors capture settings %p",
    async (settings, count) => {
      const endpoint = receiver();
      const target = provider();
      const hue = createHue({
        apiKey,
        baseUrl: endpoint.url,
        serviceName: "http-switch",
        liveSpans: false,
        ...settings,
      });
      try {
        expect(await fetch(target.url).then((response) => response.json())).toEqual({
          ok: true,
          password: "synthetic-response-password",
        });
        await hue.flush();
        const records = endpoint.accepted().filter((span) => attr(span, "http.request.method"));
        expect(records).toHaveLength(count);
        for (const span of records) {
          expect(attr(span, "input.value")).toBeUndefined();
          expect(attr(span, "output.value")).toBeUndefined();
        }
      } finally {
        await hue.shutdownSafe();
        await target.server.stop(true);
        await endpoint.server.stop(true);
      }
    },
  );

  test.each(Object.keys(compressors) as (keyof typeof compressors)[])(
    "decodes a %s response for capture while fetch and node:http callers see their usual bytes",
    async (encoding) => {
      const endpoint = receiver();
      const target = compressedProvider(encoding);
      const hue = createHue({
        apiKey,
        baseUrl: endpoint.url,
        serviceName: "http-compressed",
        liveSpans: false,
      });
      try {
        const response = await fetch(target.url);
        expect(response.headers.get("content-encoding")).toBe(encoding);
        expect(await response.json()).toEqual(target.payload);
        const raw = await nodeHttpGet(target.url);
        expect(raw.encoding).toBe(encoding);
        expect(raw.body.equals(target.wire)).toBe(true);
        await hue.flush();
        const records = endpoint.accepted().filter((span) => attr(span, "http.request.method"));
        expect(records).toHaveLength(2);
        for (const span of records) {
          expect(JSON.parse(attr(span, "output.value")!.stringValue!)).toEqual(target.payload);
          expect(attr(span, "http.response.body.size")?.intValue).toBeDefined();
          expect(attr(span, "hue.truncated")).toBeUndefined();
        }
      } finally {
        await hue.shutdownSafe();
        await target.server.stop(true);
        await endpoint.server.stop(true);
      }
    },
  );

  test.each([
    ["corrupt gzip bytes", Buffer.from("not a gzip member")],
    ["a gzip body over the value cap once decoded", gzipSync("x".repeat(1024 * 1024 + 1))],
  ])(
    "records a truncation marker for %s while the node:http caller sees the wire bytes",
    async (_label, wire) => {
      const endpoint = receiver();
      const target = compressedProvider("gzip", undefined, wire);
      const hue = createHue({
        apiKey,
        baseUrl: endpoint.url,
        serviceName: "http-compressed-undecodable",
        liveSpans: false,
      });
      try {
        const raw = await nodeHttpGet(target.url);
        expect(raw.body.equals(wire)).toBe(true);
        await hue.flush();
        const records = endpoint.accepted().filter((span) => attr(span, "http.request.method"));
        expect(records).toHaveLength(1);
        expect(attr(records[0]!, "output.value")?.kvlistValue?.values).toEqual([
          { key: "hue.truncated", value: { boolValue: true } },
          { key: "hue.truncated_bytes", value: { intValue: String(wire.byteLength) } },
        ]);
        expect(attr(records[0]!, "hue.truncated")?.arrayValue?.values).toEqual([
          { stringValue: "output.value" },
        ]);
      } finally {
        await hue.shutdownSafe();
        await target.server.stop(true);
        await endpoint.server.stop(true);
      }
    },
  );

  test.each([
    [{ captureHttpBodies: false }, 1],
    [{ captureHttp: false }, 0],
  ] satisfies [Partial<HueOptions>, number][])(
    "keeps a compressed response body out of the span when capture is off %p",
    async (settings, count) => {
      const endpoint = receiver();
      const target = compressedProvider("gzip");
      const hue = createHue({
        apiKey,
        baseUrl: endpoint.url,
        serviceName: "http-compressed-off",
        liveSpans: false,
        ...settings,
      });
      try {
        expect(await fetch(target.url).then((response) => response.json())).toEqual(target.payload);
        await hue.flush();
        const records = endpoint.accepted().filter((span) => attr(span, "http.request.method"));
        expect(records).toHaveLength(count);
        for (const span of records) expect(attr(span, "output.value")).toBeUndefined();
      } finally {
        await hue.shutdownSafe();
        await target.server.stop(true);
        await endpoint.server.stop(true);
      }
    },
  );

  test.each([true, false])("rejects invalid HTTP options even when enabled=%p", (enabled) => {
    for (const key of ["captureHttp", "captureHttpBodies"]) {
      expect(() =>
        createHueTransport({ apiKey, serviceName: "http-options", enabled, [key]: "false" }),
      ).toThrow();
    }
  });
});
