import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs/light.js";
import { createHue } from "../src/index.js";
import { hostedToolActivity } from "../src/provider-tools.js";
import { withToolCatalogSummary } from "../src/tool-definitions.js";
import schema from "./fixtures/otlp-schema.json" with { type: "json" };

// Provider-executed tool spans as they reach Hue: the call position, the metadata-only catalog
// summary on `tools/list`, the provider's error text on a failed MCP call and `server.address`.

const root = protobuf.Root.fromJSON(schema);
const apiKey = "synthetic-provider-span-key";
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

const definitions = [
  {
    name: "search_threads",
    description: "private description marker",
    input_schema: { type: "object", properties: { private_schema_marker: { type: "string" } } },
  },
  { name: "create_draft", input_schema: { type: "object" } },
];
const errorText =
  "Upstream rejected Authorization: Bearer synthetic-bearer-secret at https://synthetic-user:synthetic-pass@mcp_server.internal:8443/mcp?key=synthetic-query-secret";

const openaiResponse = {
  output: [
    { type: "reasoning", summary: [] },
    { type: "mcp_list_tools", server_label: "gmail", tools: definitions },
    {
      type: "mcp_call",
      id: "mcp-1",
      name: "search_threads",
      server_label: "gmail",
      arguments: "{}",
    },
    { type: "message", content: [] },
    {
      type: "mcp_call",
      id: "mcp-2",
      name: "create_draft",
      server_label: "gmail",
      arguments: "{}",
      output: null,
      error: errorText,
    },
    { type: "web_search_call", id: "ws-1", action: { query: "q" } },
  ],
};
const openaiRequest = {
  tools: [{ type: "mcp", server_label: "gmail", server_url: "http://mcp_server:8080/sse" }],
};

async function record(captureContent: boolean) {
  const endpoint = receiver();
  const hue = createHue({
    apiKey,
    baseUrl: endpoint.url,
    serviceName: "provider-spans",
    captureContent,
  });
  try {
    await hue.model(
      "synthetic-model",
      async () => {
        hue.recordProviderToolCalls(openaiResponse, { request: openaiRequest });
        hue.recordProviderToolCalls(
          {
            content: [
              { type: "text", text: "Looking" },
              { type: "server_tool_use", id: "srv-1", name: "web_search", input: {} },
              { type: "web_search_tool_result", tool_use_id: "srv-1", content: [] },
              { type: "mcp_tool_use", id: "mcp-3", name: "post", server_name: "slack", input: {} },
              { type: "mcp_tool_result", tool_use_id: "mcp-3", content: [] },
            ],
          },
          { provider: "anthropic" },
        );
      },
      { provider: "openai" },
    );
    expect((await hue.flush()).instrumentationFailures).toBe(0);
  } finally {
    await hue.shutdown();
    endpoint.stop();
  }
  const byName = (name: string) => endpoint.spans.filter((span) => span.name === name);
  return { endpoint, byName, raw: endpoint.raw.join(" ") };
}

describe("provider tool spans", () => {
  for (const captureContent of [true, false])
    test(`record each call's position in the response (captureContent ${captureContent})`, async () => {
      const { byName } = await record(captureContent);
      const position = (name: string) =>
        byName(name).map((span) => Number(attr(span, "hue.tool.call.position")?.intValue));
      expect(position("execute_tool search_threads")).toEqual([2]);
      expect(position("execute_tool create_draft")).toEqual([4]);
      expect(position("execute_tool web_search")).toEqual([5, 1]);
      expect(position("execute_tool post")).toEqual([3]);
    });

  test("a metadata-only tools/list carries tool names and the digest content export would summarize", async () => {
    const content = await record(true);
    const metadata = await record(false);
    const [captured] = content.byName("tools/list");
    const [summarized] = metadata.byName("tools/list");
    // Content capture is unchanged: the definitions themselves, no summary.
    const exported = attr(captured!, "gen_ai.tool.definitions")?.stringValue;
    expect(exported).toBeDefined();
    expect(attr(captured!, "hue.tool.names")).toBeUndefined();
    // Metadata-only: the summary #90 gives any record's definitions, and nothing more.
    const expected: Record<string, unknown> = withToolCatalogSummary<Record<string, unknown>>({
      "gen_ai.tool.definitions": exported!,
    });
    expect(
      attr(summarized!, "hue.tool.names")?.arrayValue?.values?.map((value) => value.stringValue),
    ).toEqual(["search_threads", "create_draft"]);
    expect(attr(summarized!, "hue.tool.definitions.sha256")?.stringValue).toBe(
      expected["hue.tool.definitions.sha256"] as string,
    );
    expect(attr(summarized!, "gen_ai.tool.definitions")).toBeUndefined();
    for (const marker of ["private description marker", "private_schema_marker"]) {
      expect(content.raw).toContain(marker);
      expect(metadata.raw).not.toContain(marker);
    }
  });

  test("a failed MCP call exports the provider's scrubbed error text only under content capture", async () => {
    const content = await record(true);
    const metadata = await record(false);
    const [failed] = content.byName("execute_tool create_draft");
    expect(attr(failed!, "error.type")?.stringValue).toBe("mcp_error");
    expect(failed!.status).toEqual({
      code: 2,
      message:
        "Upstream rejected Authorization: Bearer [redacted] at https://mcp_server.internal:8443/mcp?key=%5Bredacted%5D",
    });
    for (const secret of ["synthetic-bearer-secret", "synthetic-query-secret", "synthetic-pass"])
      expect(content.raw).not.toContain(secret);
    const [typeOnly] = metadata.byName("execute_tool create_draft");
    expect(attr(typeOnly!, "error.type")?.stringValue).toBe("mcp_error");
    expect(typeOnly!.status?.code).toBe(2);
    expect(typeOnly!.status?.message ?? "").toBe("");
    expect(metadata.raw).not.toContain("Upstream rejected");
  });

  test("a metadata-only catalog over one content field's bound keeps its summary", async () => {
    // About 420 KB of definitions: over one content field's 256 KiB, within one export request.
    const tools = Array.from({ length: 300 }, (_, index) => ({
      name: `tool_${index}`,
      description: "d".repeat(1_300),
      input_schema: { type: "object" },
    }));
    const response = { output: [{ type: "mcp_list_tools", server_label: "big", tools }] };
    const endpoint = receiver();
    const hue = createHue({
      apiKey,
      baseUrl: endpoint.url,
      serviceName: "provider-spans",
      captureContent: false,
    });
    try {
      await hue.model(
        "synthetic-model",
        async () => {
          hue.recordProviderToolCalls(response);
        },
        { provider: "openai" },
      );
      expect((await hue.flush()).instrumentationFailures).toBe(0);
    } finally {
      await hue.shutdown();
      endpoint.stop();
    }
    const [listing] = endpoint.spans.filter((span) => span.name === "tools/list");
    const [parsed] = hostedToolActivity("openai", response).listings;
    const expected: Record<string, unknown> = withToolCatalogSummary<Record<string, unknown>>({
      "gen_ai.tool.definitions": JSON.stringify(parsed!.definitions),
    });
    expect(
      attr(listing!, "hue.tool.names")?.arrayValue?.values?.map((value) => value.stringValue),
    ).toEqual(tools.map((tool) => tool.name));
    expect(attr(listing!, "hue.tool.definitions.sha256")?.stringValue).toBe(
      expected["hue.tool.definitions.sha256"] as string,
    );
  });

  test("server.address keeps an underscore in the MCP server's host name", async () => {
    const { byName } = await record(false);
    expect(attr(byName("execute_tool search_threads")[0]!, "server.address")?.stringValue).toBe(
      "mcp_server",
    );
  });
});
