import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs/light.js";
import {
  createHue,
  instrumentComposio,
  instrumentPipedream,
  type HueOptions,
} from "../src/index.js";
import schema from "./fixtures/otlp-schema.json" with { type: "json" };

// Platform SDK calls as they reach Hue: one execute_tool span per Composio tools.execute,
// Tool Router session execute and Pipedream actions.run, with the REST field names Hue's
// platform translators read, the SDK's own response as the result, and the original return
// value handed back to the caller unchanged.

const root = protobuf.Root.fromJSON(schema);
const apiKey = "synthetic-platform-key";
type Value = { stringValue?: string; intValue?: string };
type Span = {
  name: string;
  spanId?: string;
  parentSpanId?: string;
  attributes?: { key: string; value: Value }[];
  status?: { code?: number; message?: string };
};

function receiver() {
  const spans: Span[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/logs")) return new Response(new Uint8Array());
      let bytes = Buffer.from(await request.arrayBuffer());
      if (request.headers.get("content-encoding") === "gzip") bytes = gunzipSync(bytes);
      const namespace = "opentelemetry.proto.collector.trace.v1.ExportTraceService";
      const type = root.lookupType(`${namespace}Request`);
      const data = type.toObject(type.decode(bytes), { longs: String, bytes: String });
      for (const group of data.resourceSpans as { scopeSpans: { spans: Span[] }[] }[])
        for (const scope of group.scopeSpans) spans.push(...scope.spans);
      const response = root.lookupType(`${namespace}Response`);
      return new Response(new Uint8Array(response.encode(response.fromObject({})).finish()), {
        headers: { "content-type": "application/x-protobuf" },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, spans, stop: () => server.stop(true) };
}

const attr = (span: Span, key: string) => span.attributes?.find((item) => item.key === key)?.value;
const json = (span: Span, key: string) => JSON.parse(attr(span, key)!.stringValue!);

async function exported(
  run: (hue: ReturnType<typeof createHue>) => Promise<void>,
  options: Partial<HueOptions> = {},
) {
  const collector = receiver();
  const hue = createHue({
    apiKey,
    baseUrl: collector.url,
    serviceName: "platforms",
    captureContent: true,
    ...options,
  });
  try {
    await run(hue);
    const { report } = await hue.flushSafe();
    return { spans: collector.spans, report };
  } finally {
    await hue.shutdownSafe();
    collector.stop();
  }
}

const composioReceipt = {
  data: { messages: [{ id: "synthetic-message" }] },
  error: null,
  successful: true,
  logId: "log_synthetic",
};

function fakeComposio(execute = async () => composioReceipt) {
  const calls: unknown[][] = [];
  return {
    calls,
    client: { baseURL: "https://backend.composio.dev" },
    tools: {
      execute(...args: unknown[]) {
        calls.push(args);
        return execute();
      },
    },
  };
}

const pipedreamResult = { exports: { $summary: "Sent" }, os: [], ret: { id: "msg_synthetic" } };

function fakePipedream() {
  const calls: unknown[][] = [];
  return {
    calls,
    _options: { projectId: "proj_synthetic", baseUrl: "https://api.pipedream.com" },
    actions: {
      run(...args: unknown[]) {
        calls.push(args);
        return Object.assign(Promise.resolve(pipedreamResult), {
          withRawResponse: () =>
            Promise.resolve({ data: pipedreamResult, rawResponse: { statusCode: 200 } }),
        });
      },
    },
  };
}

test("composio.tools.execute records the REST body, the raw receipt and the configured endpoint", async () => {
  const composio = fakeComposio();
  const params = {
    userId: "user_synthetic",
    connectedAccountId: "ca_synthetic",
    version: "20261015_00",
    arguments: { max_results: 5 },
    customAuthParams: {
      parameters: [{ in: "header", name: "Authorization", value: "synthetic-secret" }],
    },
  };
  const { spans, report } = await exported(async (hue) => {
    expect(instrumentComposio(hue, composio)).toBe(composio);
    const result = await composio.tools.execute("GMAIL_FETCH_EMAILS", params, {
      dangerouslySkipVersionCheck: false,
    });
    expect(result).toBe(composioReceipt);
    expect(composio.calls).toEqual([
      ["GMAIL_FETCH_EMAILS", params, { dangerouslySkipVersionCheck: false }],
    ]);
  });
  const span = spans.find((item) => item.name === "execute_tool GMAIL_FETCH_EMAILS")!;
  expect(attr(span, "gen_ai.operation.name")?.stringValue).toBe("execute_tool");
  expect(attr(span, "gen_ai.tool.name")?.stringValue).toBe("GMAIL_FETCH_EMAILS");
  expect(attr(span, "hue.integration.platform")?.stringValue).toBe("composio");
  expect(attr(span, "hue.integration.version")?.stringValue).toBe("20261015_00");
  expect(attr(span, "url.full")?.stringValue).toBe(
    "https://backend.composio.dev/api/v3.1/tools/execute/GMAIL_FETCH_EMAILS",
  );
  expect(attr(span, "http.request.method")?.stringValue).toBe("POST");
  expect(attr(span, "hue.tool.endpoint.source")?.stringValue).toBe("client_config");
  expect(json(span, "gen_ai.tool.call.arguments")).toEqual({
    connected_account_id: "ca_synthetic",
    arguments: { max_results: 5 },
    user_id: "user_synthetic",
    version: "20261015_00",
  });
  expect(json(span, "gen_ai.tool.call.result")).toEqual(composioReceipt);
  expect(JSON.stringify(spans)).not.toContain("synthetic-secret");
  expect(report.instrumentationFailures).toBe(0);
});

test("a Tool Router session execute records tool_slug and arguments under the session route", async () => {
  const session = {
    sessionId: "sess_synthetic",
    execute: async (_slug: string, _args: Record<string, unknown>) => composioReceipt,
  };
  const { spans } = await exported(async (hue) => {
    instrumentComposio(hue, session);
    expect(await session.execute("SLACK_SEND_MESSAGE", { channel: "C1", text: "hi" })).toBe(
      composioReceipt,
    );
  });
  const span = spans.find((item) => item.name === "execute_tool SLACK_SEND_MESSAGE")!;
  expect(attr(span, "hue.integration.platform")?.stringValue).toBe("composio");
  expect(attr(span, "hue.integration.version")).toBeUndefined();
  expect(attr(span, "url.full")?.stringValue).toBe(
    "https://backend.composio.dev/api/v3.1/tool_router/session/sess_synthetic/execute",
  );
  expect(json(span, "gen_ai.tool.call.arguments")).toEqual({
    tool_slug: "SLACK_SEND_MESSAGE",
    arguments: { channel: "C1", text: "hi" },
  });
});

test("the platform call runs inside its span, so spans it creates parent under it", async () => {
  let hueRef: ReturnType<typeof createHue> | undefined;
  const composio = fakeComposio(() => hueRef!.withSpan("inner_http", async () => composioReceipt));
  const { spans } = await exported(async (hue) => {
    hueRef = hue;
    instrumentComposio(hue, composio);
    await composio.tools.execute("GMAIL_FETCH_EMAILS", { userId: "u" });
  });
  const tool = spans.find((item) => item.name === "execute_tool GMAIL_FETCH_EMAILS")!;
  const inner = spans.find((item) => item.name === "inner_http")!;
  expect(inner.parentSpanId).toBe(tool.spanId);
});

test("a throwing argument getter and a synchronous throw reach the caller unchanged", async () => {
  const composio = fakeComposio();
  const hostile = Object.defineProperty({}, "userId", {
    get() {
      throw new Error("synthetic getter");
    },
    enumerable: true,
  });
  const { spans } = await exported(async (hue) => {
    instrumentComposio(hue, composio);
    expect(await composio.tools.execute("GMAIL_FETCH_EMAILS", hostile)).toBe(composioReceipt);
    expect(composio.calls).toEqual([["GMAIL_FETCH_EMAILS", hostile]]);
  });
  expect(spans.filter((item) => item.name.startsWith("execute_tool"))).toHaveLength(0);
  const throwing = fakeComposio(() => {
    throw new Error("synthetic sync throw");
  });
  const second = await exported(async (hue) => {
    instrumentComposio(hue, throwing);
    expect(() => throwing.tools.execute("GMAIL_FETCH_EMAILS", { userId: "u" })).toThrow(
      "synthetic sync throw",
    );
  });
  expect(
    second.spans.find((item) => item.name === "execute_tool GMAIL_FETCH_EMAILS")?.status?.code,
  ).toBe(2);
});

test("a rejected Composio call marks the span as an error and stays the caller's rejection", async () => {
  const composio = fakeComposio(() => Promise.reject(new Error("synthetic failure")));
  const { spans } = await exported(async (hue) => {
    instrumentComposio(hue, composio);
    await expect(composio.tools.execute("GMAIL_FETCH_EMAILS", { userId: "u" })).rejects.toThrow(
      "synthetic failure",
    );
  });
  const span = spans.find((item) => item.name === "execute_tool GMAIL_FETCH_EMAILS")!;
  expect(span.status?.code).toBe(2);
  expect(attr(span, "gen_ai.tool.call.result")).toBeUndefined();
});

test("pipedream actions.run records the REST body, the {exports, os, ret} result and keeps withRawResponse", async () => {
  const pipedream = fakePipedream();
  const request = {
    id: "gmail-send-email",
    externalUserId: "user_synthetic",
    version: "0.1.2",
    configuredProps: { gmail: { authProvisionId: "apn_synthetic" }, to: "a@example.com" },
    dynamicPropsId: "dyp_synthetic",
  };
  const { spans, report } = await exported(async (hue) => {
    expect(instrumentPipedream(hue, pipedream)).toBe(pipedream);
    const pending = pipedream.actions.run(request);
    expect(typeof pending.withRawResponse).toBe("function");
    expect(await pending).toBe(pipedreamResult);
    expect(pipedream.calls).toEqual([[request]]);
  });
  const span = spans.find((item) => item.name === "execute_tool gmail-send-email")!;
  expect(attr(span, "gen_ai.tool.name")?.stringValue).toBe("gmail-send-email");
  expect(attr(span, "hue.integration.platform")?.stringValue).toBe("pipedream");
  expect(attr(span, "hue.integration.version")?.stringValue).toBe("0.1.2");
  expect(attr(span, "url.full")?.stringValue).toBe(
    "https://api.pipedream.com/v1/connect/proj_synthetic/actions/run",
  );
  expect(attr(span, "http.request.method")?.stringValue).toBe("POST");
  expect(json(span, "gen_ai.tool.call.arguments")).toEqual({
    id: "gmail-send-email",
    version: "0.1.2",
    external_user_id: "user_synthetic",
    configured_props: { gmail: { authProvisionId: "apn_synthetic" }, to: "a@example.com" },
  });
  expect(json(span, "gen_ai.tool.call.result")).toEqual(pipedreamResult);
  expect(report.instrumentationFailures).toBe(0);
});

test("metadata-only capture keeps the span, platform and tool name but no body, result or URL", async () => {
  const pipedream = fakePipedream();
  const { spans } = await exported(
    async (hue) => {
      instrumentPipedream(hue, pipedream);
      await pipedream.actions.run({ id: "gmail-send-email", externalUserId: "u" });
    },
    { captureContent: false },
  );
  const span = spans.find((item) => item.name === "execute_tool gmail-send-email")!;
  expect(attr(span, "hue.integration.platform")?.stringValue).toBe("pipedream");
  for (const key of ["gen_ai.tool.call.arguments", "gen_ai.tool.call.result", "url.full"])
    expect(attr(span, key)).toBeUndefined();
});

test("a disabled client and a second instrumentation leave the client untouched", async () => {
  const composio = fakeComposio();
  const execute = composio.tools.execute;
  const disabled = createHue({ enabled: false });
  expect(instrumentComposio(disabled, composio).tools.execute).toBe(execute);
  await disabled.shutdownSafe();
  const { spans } = await exported(async (hue) => {
    instrumentComposio(hue, composio);
    const once = composio.tools.execute;
    instrumentComposio(hue, composio);
    expect(composio.tools.execute).toBe(once);
    await composio.tools.execute("GMAIL_FETCH_EMAILS", { userId: "u" });
  });
  expect(spans.filter((item) => item.name === "execute_tool GMAIL_FETCH_EMAILS")).toHaveLength(1);
});
