import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs/light.js";
import { createHue, type HueOptions, type ToolEndpoint } from "../src/index.js";
import schema from "./fixtures/otlp-schema.json" with { type: "json" };

const root = protobuf.Root.fromJSON(schema);
const apiKey = "synthetic-endpoint-key";
type Value = { stringValue?: string; intValue?: string; arrayValue?: { values?: Value[] } };
type Span = {
  name: string;
  attributes?: { key: string; value: Value }[];
  status?: { code?: number; message?: string };
};

function receiver() {
  const spans: Span[] = [];
  const raw: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/logs")) return new Response(new Uint8Array());
      let bytes = Buffer.from(await request.arrayBuffer());
      if (request.headers.get("content-encoding") === "gzip") bytes = gunzipSync(bytes);
      const namespace = "opentelemetry.proto.collector.trace.v1.ExportTraceService";
      const type = root.lookupType(`${namespace}Request`);
      const data = type.toObject(type.decode(bytes), { longs: String, bytes: String });
      raw.push(JSON.stringify(data));
      for (const group of data.resourceSpans as { scopeSpans: { spans: Span[] }[] }[])
        for (const scope of group.scopeSpans) spans.push(...scope.spans);
      const response = root.lookupType(`${namespace}Response`);
      return new Response(new Uint8Array(response.encode(response.fromObject({})).finish()), {
        headers: { "content-type": "application/x-protobuf" },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, spans, raw, stop: () => server.stop(true) };
}

const attr = (span: Span, key: string) => span.attributes?.find((item) => item.key === key)?.value;

const url = "https://backend.composio.dev/v3/mcp/synthetic-server/mcp?user_id=synthetic-user";
const endpoint: ToolEndpoint = {
  url,
  source: "client_config",
  method: "POST",
  captureQueryParameters: ["user_id"],
};
const result = { kind: "sync", result: JSON.stringify({ successful: true, data: { items: [] } }) };

async function record(evidence?: ToolEndpoint, options: Partial<HueOptions> = {}) {
  const collector = receiver();
  const hue = createHue({
    apiKey,
    baseUrl: collector.url,
    serviceName: "endpoint-test",
    captureContent: true,
    ...options,
  });
  let calls = 0;
  try {
    const returned = await hue.tool(
      "mcp_read",
      { tool: "SYNTHETIC_LIST", arguments: {} },
      () => {
        calls++;
        return result;
      },
      { endpoint: evidence },
    );
    expect(returned).toBe(result);
    expect(calls).toBe(1);
    const { report } = await hue.flushSafe();
    return { span: collector.spans[0]!, raw: collector.raw.join(" "), report };
  } finally {
    await hue.shutdownSafe();
    collector.stop();
  }
}

test("tool endpoint is opt-in: baseline records the unchanged sync wrapper only", async () => {
  const { span } = await record();
  expect(attr(span, "url.full")).toBeUndefined();
  expect(JSON.parse(attr(span, "gen_ai.tool.call.result")!.stringValue!)).toEqual(result);
});

for (const path of [
  "/api/v3/tools/execute/SYNTHETIC_LIST",
  "/tool_router/session/synthetic-session/mcp",
  "/v3/mcp/synthetic-server/mcp",
])
  test(`captures actual configured endpoint with provenance: ${path}`, async () => {
    const target = `https://backend.composio.dev${path}?user_id=synthetic-user`;
    const { span, report } = await record({ ...endpoint, url: target });
    expect(attr(span, "url.full")?.stringValue).toBe(target);
    expect(attr(span, "http.request.method")?.stringValue).toBe("POST");
    expect(attr(span, "hue.tool.endpoint.source")?.stringValue).toBe("client_config");
    expect(report.instrumentationFailures).toBe(0);
  });

test("retains every allowed query occurrence but strips credentials, fragment and other parameters", async () => {
  const target =
    url.replace("https://", "https://synthetic-login:synthetic-password@") +
    "&user_id=second&user_id=&api_key=synthetic-secret&other=synthetic-private#synthetic-fragment";
  const { span, raw } = await record({ ...endpoint, url: target });
  expect(attr(span, "url.full")?.stringValue).toBe(url + "&user_id=second&user_id=");
  for (const marker of [
    "synthetic-login",
    "synthetic-password",
    "synthetic-secret",
    "synthetic-private",
    "synthetic-fragment",
  ])
    expect(raw).not.toContain(marker);
});

test("no query allowlist, absent selector and unknown method stay absent", async () => {
  const { span } = await record({ url, source: "receipt" });
  expect(attr(span, "url.full")?.stringValue).toBe(url.split("?")[0]);
  expect(attr(span, "http.request.method")).toBeUndefined();
  const missing = await record({ ...endpoint, url: url.split("?")[0]! });
  expect(attr(missing.span, "url.full")?.stringValue).toBe(url.split("?")[0]);
});

test("metadata-only capture omits all endpoint evidence", async () => {
  const { span, raw } = await record(endpoint, { captureContent: false });
  expect(attr(span, "url.full")).toBeUndefined();
  expect(attr(span, "hue.tool.endpoint.source")).toBeUndefined();
  expect(attr(span, "http.request.method")).toBeUndefined();
  expect(raw).not.toContain("synthetic-user");
});

test("existing redactor controls URL evidence without changing tool output", async () => {
  const { span, raw } = await record(endpoint, {
    redact: (value, path) =>
      path === "attributes.url.full" && typeof value === "string"
        ? value.replace("synthetic-user", "[redacted]")
        : value,
  });
  expect(attr(span, "url.full")?.stringValue).toBe(url.replace("synthetic-user", "[redacted]"));
  expect(raw).not.toContain("synthetic-user");
});

test("invalid evidence and failing redaction cannot interrupt or retry the tool", async () => {
  for (const evidence of [
    { ...endpoint, url: "not a URL" },
    { ...endpoint, url: url + "%GG" },
    { ...endpoint, url: "https://backend.composio.dev/\nsynthetic" },
    { ...endpoint, captureQueryParameters: ["api_key"] },
    { ...endpoint, method: "POST\r\nX: bad" },
  ]) {
    const { span, report } = await record(evidence);
    expect(attr(span, "url.full")).toBeUndefined();
    expect(report.instrumentationFailures).toBeGreaterThan(0);
  }
  const failed = await record(endpoint, {
    redact: (value, path) => {
      if (path === "attributes.url.full") throw new Error("synthetic-redactor");
      return value;
    },
  });
  expect(failed.raw).not.toContain("synthetic-user");
  expect(failed.report.failedSpans).toBeGreaterThan(0);
});

test("application errors retain their identity and the tool runs once", async () => {
  const collector = receiver();
  const hue = createHue({
    apiKey,
    baseUrl: collector.url,
    serviceName: "endpoint-error",
    captureContent: true,
  });
  const error = new Error("synthetic-business-error");
  let calls = 0;
  try {
    await expect(
      hue.tool(
        "mcp_read",
        {},
        () => {
          calls++;
          throw error;
        },
        { endpoint },
      ),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
    await hue.flush();
    expect(attr(collector.spans[0]!, "url.full")?.stringValue).toBe(url);
  } finally {
    await hue.shutdownSafe();
    collector.stop();
  }
});

test("request evidence describes the same local HTTP call executed once", async () => {
  let calls = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.method).toBe("POST");
      expect(new URL(request.url).searchParams.get("user_id")).toBe("synthetic-local-user");
      calls++;
      return Response.json(result);
    },
  });
  const collector = receiver();
  const hue = createHue({
    apiKey,
    baseUrl: collector.url,
    serviceName: "endpoint-local",
    captureContent: true,
  });
  const request = new Request(`${upstream.url.origin}/mcp?user_id=synthetic-local-user`, {
    method: "POST",
  });
  let observed: unknown;
  try {
    const returned = await hue.tool(
      "mcp_read",
      {},
      async () => {
        observed = await (await fetch(request)).json();
        return observed;
      },
      {
        endpoint: {
          url: request.url,
          method: request.method,
          source: "request",
          captureQueryParameters: ["user_id"],
        },
      },
    );
    expect(returned).toBe(observed);
    expect(returned).toEqual(result);
    expect(calls).toBe(1);
    await hue.flush();
    expect(attr(collector.spans[0]!, "url.full")?.stringValue).toBe(request.url);
  } finally {
    await hue.shutdownSafe();
    collector.stop();
    upstream.stop(true);
  }
});
