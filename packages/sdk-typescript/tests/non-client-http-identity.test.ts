import { expect, test } from "bun:test";
import { SpanKind } from "@opentelemetry/api";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { createHueTransport } from "../src/index.js";
import { apiKey, attr, receiver, type WireRecord } from "./sdk-receiver.js";

const query = "synthetic_oauth_code";
const userinfo = "synthetic_userinfo";
const pathSecret = "synthetic_path_secret";
const raw =
  `https://synthetic-user:${userinfo}@example.test` +
  `/token/${pathSecret}/callback?code=${query}#synthetic-fragment`;
const safe = "https://example.test/token/[redacted]/callback";
const safePath = "/token/[redacted]/callback";
const kinds = [SpanKind.SERVER, SpanKind.INTERNAL, SpanKind.PRODUCER, SpanKind.CONSUMER] as const;

function text(record: WireRecord, key: string): string | undefined {
  return attr(record, key)?.stringValue;
}

function secretsAbsent(body: string): void {
  for (const secret of [query, userinfo, pathSecret, "synthetic-fragment"])
    expect(body).not.toContain(secret);
}

async function exportSpan(
  kind: SpanKind,
  name: string,
  attributes: Record<string, string>,
  captureContent = true,
): Promise<{ record: WireRecord; raw: string }> {
  const endpoint = receiver();
  const transport = createHueTransport({
    apiKey,
    serviceName: "non-client-http",
    captureContent,
    captureHttp: false,
    liveSpans: false,
    baseUrl: endpoint.url,
  });
  const provider = new TracerProvider({ spanProcessors: [transport.spanProcessor] });
  try {
    const span = provider.getTracer("application-http").startSpan(name, { kind, attributes });
    span.end();
    await provider.forceFlush();
    await transport.flush();
    const request = endpoint.requests.find((item) => item.signal === "traces");
    expect(request).toBeDefined();
    const record = request!.records.find((item) => item.name !== undefined);
    expect(record).toBeDefined();
    return { record: record!, raw: request!.raw };
  } finally {
    await provider.shutdown();
    await transport.shutdown();
    endpoint.server.stop(true);
  }
}

for (const kind of kinds) {
  for (const captureContent of [true, false]) {
    test(`borrowed provider strips ${SpanKind[kind]} URL credentials (captureContent=${captureContent})`, async () => {
      const path = `/token/${pathSecret}/callback`;
      const { record, raw: body } = await exportSpan(
        kind,
        `GET ${raw}`,
        {
          "http.request.method": "GET",
          "url.full": raw,
          "http.url": raw,
          "http.target": `${path}?code=${query}`,
          "url.path": path,
          "url.query": `code=${query}`,
        },
        captureContent,
      );
      expect(text(record, "url.full")).toBe(safe);
      expect(text(record, "http.url")).toBe(safe);
      expect(text(record, "http.target")).toBe(safePath);
      expect(text(record, "url.path")).toBe(safePath);
      expect(text(record, "url.query")).toBeUndefined();
      expect(record.name).toBe(`GET ${safe}`);
      secretsAbsent(body);
    });
  }
}

test("server spans lose each URL alias instrumentation records", async () => {
  const cases: { attributes: Record<string, string>; urlKey?: string }[] = [
    {
      attributes: {
        "http.method": "GET",
        "http.url": raw,
        "http.target": `/token/${pathSecret}/callback`,
      },
      urlKey: "http.url",
    },
    {
      attributes: {
        "http.request.method": "GET",
        "url.path": `/token/${pathSecret}/callback`,
        "url.query": `code=${query}`,
      },
    },
    {
      attributes: {
        "http.method": "GET",
        "http.target": `/token/${pathSecret}/callback?code=${query}`,
      },
    },
  ];
  for (const item of cases) {
    const { record, raw: body } = await exportSpan(SpanKind.SERVER, "GET", item.attributes);
    expect(text(record, "url.query")).toBeUndefined();
    if (item.urlKey) expect(text(record, item.urlKey)).toBe(safe);
    if ("http.target" in item.attributes) expect(text(record, "http.target")).toBe(safePath);
    if ("url.path" in item.attributes) expect(text(record, "url.path")).toBe(safePath);
    secretsAbsent(body);
  }
});

test("an unsanitizable server URL is omitted", async () => {
  const unsafe = `https://synthetic-user:${userinfo}@/callback?code=${query}`;
  const { record, raw: body } = await exportSpan(SpanKind.SERVER, "GET", {
    "http.request.method": "GET",
    "url.full": unsafe,
    "http.url": unsafe,
  });
  expect(text(record, "url.full")).toBeUndefined();
  expect(text(record, "http.url")).toBeUndefined();
  expect(body).not.toContain(query);
});

test("a server span name does not keep the request URL", async () => {
  const { record, raw: body } = await exportSpan(SpanKind.SERVER, raw, {});
  expect(record.name).toBe(safe);
  secretsAbsent(body);
});
