import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import * as zlib from "node:zlib";
import protobuf from "protobufjs/light.js";
import { runTracesCommand } from "../src/cli/traces-import.js";
import { parseJsonText, type TraceImportManifest } from "../src/cli/traces-import-convert.js";
import { binaryValues } from "../src/cli/import-formats/otlp-protobuf.js";
import { importAdapters } from "../src/cli/import-formats/registry.js";
import schema from "./fixtures/otlp-schema.json" with { type: "json" };

// Synthetic exports only (see fixtures/otel-family/README.md): invented ids, users and content.
// Nothing leaves the machine; prepare writes a bundle to a scratch directory and the tests read
// it back.

const FIXTURES = join(import.meta.dir, "fixtures/otel-family");
const fixture = (name: string) => readFile(join(FIXTURES, name), "utf8");
/** A fixture parsed as the reader parses it: an integer past 2^53 kept as its decimal text. */
const fixtureJson = async (name: string) => parseJsonText(await fixture(name)).value as any;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const root = protobuf.Root.fromJSON(schema);
const ExportRequest = root.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hue-otel-family-"));
  directories.push(directory);
  return directory;
}

async function writeFiles(directory: string, files: Record<string, Uint8Array | string>) {
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(join(directory, name, ".."), { recursive: true });
    await writeFile(join(directory, name), bytes);
  }
}

async function prepare(input: string, ...flags: string[]) {
  let stdout = "";
  let stderr = "";
  const sink = (append: (text: string) => void) =>
    new Writable({ write: (chunk, _encoding, done) => (append(String(chunk)), done()) });
  const code = await runTracesCommand(["import", "prepare", input, "--json", ...flags], {
    stdout: sink((text) => (stdout += text)),
    stderr: sink((text) => (stderr += text)),
  });
  return { code, stderr, report: code === 0 ? (JSON.parse(stdout) as Record<string, any>) : {} };
}

/** Prepares one file and returns the report, the manifest and each trace's spans by id. */
async function prepareFile(name: string, content: Uint8Array | string, ...flags: string[]) {
  const directory = await scratch();
  await writeFiles(directory, { [name]: content });
  const result = await prepare(join(directory, name), ...flags);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  const out = result.report.output_directory as string;
  const manifest = JSON.parse(
    await readFile(join(out, "manifest.json"), "utf8"),
  ) as TraceImportManifest;
  const spans = async (traceId: string) => {
    const trace = manifest.traces.find((item) => item.trace_id === traceId);
    if (!trace) throw new Error(`no trace ${traceId}`);
    const found: Span[] = [];
    for (const batch of trace.batches) {
      const body = await readFile(join(out, `${traceId}.${batch.sha256}.json.gz`));
      const decoded = JSON.parse(zlib.gunzipSync(body).toString("utf8")) as {
        resourceSpans: {
          resource?: { attributes: Attribute[] };
          scopeSpans: { scope?: { name: string; version?: string }; spans: Span[] }[];
        }[];
      };
      for (const group of decoded.resourceSpans)
        for (const scope of group.scopeSpans)
          for (const span of scope.spans)
            found.push({ ...span, resource: group.resource?.attributes ?? [], scope: scope.scope });
    }
    return found;
  };
  return { report: result.report, manifest, spans };
}

interface Attribute {
  key: string;
  value: Record<string, any>;
}
interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attribute[];
  status?: { code?: number; message?: string };
  events?: { name: string; timeUnixNano: string; attributes: Attribute[] }[];
  links?: { traceId: string; spanId: string; attributes: Attribute[] }[];
  resource: Attribute[];
  scope?: { name: string; version?: string };
  [field: string]: unknown;
}

const attr = (attributes: Attribute[], key: string) =>
  attributes.find((item) => item.key === key)?.value;
const str = (span: Span, key: string) => attr(span.attributes, key)?.stringValue as string;
const json = (span: Span, key: string) => JSON.parse(str(span, key)) as unknown;
const byName = (spans: Span[], name: string) => spans.find((span) => span.name === name)!;

/** An OTLP/JSON request with hex ids as protobufjs encodes it. */
function encodeRequest(request: unknown): Uint8Array {
  const ids = new Set(["traceId", "spanId", "parentSpanId"]);
  const bytes = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(bytes);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        ids.has(key) && typeof item === "string" ? Buffer.from(item, "hex") : bytes(item),
      ]),
    );
  };
  return ExportRequest.encode(ExportRequest.fromObject(bytes(request) as object)).finish();
}

const lengthPrefixed = (...messages: Uint8Array[]) =>
  Buffer.concat(
    messages.flatMap((message) => {
      const size = Buffer.alloc(4);
      size.writeUInt32BE(message.byteLength);
      return [size, Buffer.from(message)];
    }),
  );

describe("the format registry", () => {
  test("lets exactly one format claim each record of this family, and none of another's", async () => {
    const jaegerUi = await fixtureJson("jaeger-ui.json");
    const zipkinSpans = await fixtureJson("zipkin-v2.json");
    const phoenixOtlp = await fixtureJson("phoenix-otlpv1.json");
    const phoenixSpans = await fixtureJson("phoenix-spans.json");
    const datadog = await fixtureJson("datadog-llmobs.json");
    const v3Lines = (await fixture("jaeger-api-v3.jsonl"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    const claims = (value: unknown) =>
      importAdapters.filter((adapter) => adapter.detect(value)).map((adapter) => adapter.id);
    const ours: [string, unknown][] = [
      ["jaeger", jaegerUi],
      ["jaeger", jaegerUi.data[0]],
      ["jaeger", { ...jaegerUi.data[0].spans[0], process: { serviceName: "agent" } }],
      ["jaeger_api_v3", v3Lines[0]],
      ["jaeger_api_v3", { result: { spans: { resourceSpans: [] }, nextPageToken: "n" } }],
      ["jaeger_api_v3", v3Lines[2]],
      ["jaeger_api_v3", { error: { httpCode: 404, message: "No traces found" } }],
      ["zipkin", zipkinSpans],
      ["zipkin", zipkinSpans[0]],
      ["phoenix_otlp", phoenixOtlp],
      ["phoenix_otlp", phoenixOtlp.data[0]],
      ["phoenix_spans", phoenixSpans],
      ["phoenix_spans", phoenixSpans.data[0]],
      ["datadog_llmobs", datadog],
      ["datadog_llmobs", datadog.data[0]],
    ];
    for (const [id, value] of ours) expect(claims(value)).toEqual([id]);
    // Other formats' records, including a Langfuse observation with OpenTelemetry-shaped ids and
    // a Braintrust row, which share field names with Zipkin and Phoenix spans.
    const others: [string, unknown][] = [
      ["otlp_json", { resourceSpans: [] }],
      [
        "langfuse_observations",
        {
          data: [
            {
              id: "a1b2c3d4e5f60718",
              traceId: "7a3c9e2f41b85d06c1e2f3a4b5c6d7e8",
              type: "SPAN",
              startTime: "2026-03-01T10:00:00.000Z",
            },
          ],
        },
      ],
      // A bare observation, as a Langfuse UI download line holds one.
      [
        "langfuse",
        {
          id: "a1b2c3d4e5f60718",
          traceId: "7a3c9e2f41b85d06c1e2f3a4b5c6d7e8",
          type: "SPAN",
          startTime: "2026-03-01T10:00:00.000Z",
        },
      ],
      ["braintrust", { span_id: "s", root_span_id: "r", trace_id: "t", metrics: {} }],
      ["atif", { schema_version: "ATIF-v1.7", session_id: "s", steps: [] }],
    ];
    for (const [id, value] of others) expect(claims(value)).toEqual([id]);
  });
});

describe("Jaeger", () => {
  test("converts a UI download to the OTLP spans it was and refuses only a malformed trace", async () => {
    const source = await fixtureJson("jaeger-ui.json");
    const { report, manifest, spans } = await prepareFile(
      "trace.json",
      await fixture("jaeger-ui.json"),
    );
    const traceId = "7a3c9e2f41b85d06c1e2f3a4b5c6d7e8";
    expect(report.formats).toEqual({ jaeger: 1 });
    expect(report.source.formats).toEqual(["otlp_json"]);
    // The 64-bit trace id of the malformed trace is padded, as the Collector pads it.
    expect(report.traces.refused).toEqual([
      {
        file: "trace.json",
        trace_id: "00000000000000005f2e1d0c9b8a7968",
        reason: "record 5: startTime is not a count of microseconds",
      },
    ]);
    expect(manifest.traces).toHaveLength(1);
    expect(manifest.traces[0]).toMatchObject({
      trace_id: traceId,
      span_count: 3,
      identity: { user: "user-42", session: "conversation-7" },
      origin: "production",
    });
    const all = await spans(traceId);
    const agent = byName(all, "invoke_agent support-agent");
    const chat = byName(all, "chat gpt-5");
    const tool = byName(all, "execute_tool lookup_order");
    expect([agent.spanId, chat.spanId, tool.spanId]).toEqual([
      "a1b2c3d4e5f60718",
      "b2c3d4e5f6071829",
      "c3d4e5f60718293a",
    ]);
    expect(agent.parentSpanId).toBeUndefined();
    expect(chat.parentSpanId).toBe(agent.spanId);
    expect(tool.parentSpanId).toBe(agent.spanId);
    expect([agent.kind, chat.kind, tool.kind]).toEqual([2, 3, 1]);
    expect(agent.startTimeUnixNano).toBe("1792504991402000000");
    expect(agent.endTimeUnixNano).toBe("1792505003877000000");
    expect(agent.scope).toEqual({ name: "support-agent", version: "1.4.0" });
    expect(agent.resource).toEqual([
      { key: "telemetry.sdk.language", value: { stringValue: "nodejs" } },
      { key: "deployment.environment.name", value: { stringValue: "production" } },
      { key: "service.name", value: { stringValue: "support-agent" } },
    ]);
    // Recorded attributes stay as they were, typed; the tags Jaeger derived are taken back out.
    expect(str(agent, "user.id")).toBe("user-42");
    expect(str(agent, "gen_ai.conversation.id")).toBe("conversation-7");
    expect(attr(agent.attributes, "span.kind")).toBeUndefined();
    expect(attr(agent.attributes, "otel.scope.name")).toBeUndefined();
    expect(str(agent, "hue.import.format")).toBe("jaeger");
    expect(json(agent, "hue.import.source_record")).toEqual(source.data[0].spans[0]);
    expect(agent.links).toEqual([
      {
        traceId: "00000000000000000000000000c0ffee",
        spanId: "00000000000000aa",
        attributes: [{ key: "opentracing.ref_type", value: { stringValue: "follows_from" } }],
      },
    ]);
    expect(str(chat, "gen_ai.request.model")).toBe("gpt-5");
    expect(json(chat, "gen_ai.input.messages")).toEqual([
      { role: "user", parts: [{ type: "text", content: "Where is order 12?" }] },
    ]);
    expect(attr(chat.attributes, "gen_ai.usage.input_tokens")).toEqual({ intValue: "1834" });
    expect(attr(chat.attributes, "gen_ai.request.temperature")).toEqual({ doubleValue: 0.2 });
    expect(chat.events).toEqual([
      {
        timeUnixNano: "1792504995200000000",
        name: "gen_ai.choice",
        attributes: [{ key: "finish_reason", value: { stringValue: "tool_calls" } }],
      },
    ]);
    expect(str(tool, "gen_ai.tool.name")).toBe("lookup_order");
    expect(json(tool, "gen_ai.tool.call.arguments")).toEqual({
      id: 12,
      user_id: "account-the-tool-touched",
    });
    expect(tool.status).toEqual({ code: 2, message: "carrier timeout, retried" });
    expect(attr(tool.attributes, "error")).toBeUndefined();
  });

  test("keeps an API v3 stream's OTLP as recorded and names an error line", async () => {
    const text = await fixture("jaeger-api-v3.jsonl");
    const { report, manifest, spans } = await prepareFile("stream.jsonl", text);
    const traceId = "2b4d6f8091a3c5e7f9081a2b3c4d5e6f";
    expect(report.formats).toEqual({ jaeger_api_v3: 1 });
    expect(report.files.skipped).toEqual([]);
    expect(manifest.traces[0]).toMatchObject({
      trace_id: traceId,
      span_count: 2,
      identity: { user: "user-77", session: "thread-5" },
    });
    const lines = text.trim().split("\n");
    const recorded = JSON.parse(lines[1]!).result.resourceSpans[0].scopeSpans[0].spans[0];
    const {
      resource: _resource,
      scope: _scope,
      ...chat
    } = byName(await spans(traceId), "chat claude-sonnet-4-5");
    expect(chat).toEqual(recorded);

    const failed = await scratch();
    await writeFiles(failed, {
      "failed.jsonl": `${lines[0]}\n{"error":{"httpCode":500,"message":"storage unavailable"}}\n`,
      "missing.json": '{"error":{"httpCode":404,"message":"No traces found"}}',
    });
    const both = await prepare(failed);
    expect(both.code).toBe(0);
    expect(both.report.files.skipped).toEqual([
      { file: "failed.jsonl", line: 2, reason: "a Jaeger API error: storage unavailable" },
    ]);
    expect(both.report.files.unsupported).toEqual([
      { file: "missing.json", reason: "a Jaeger API error: No traces found" },
    ]);
  });
});

describe("Zipkin", () => {
  test("converts v2 spans, nests a shared server span and fills a missing timestamp by rule", async () => {
    const source = await fixtureJson("zipkin-v2.json");
    const { report, manifest, spans } = await prepareFile(
      "trace.json",
      await fixture("zipkin-v2.json"),
    );
    const traceId = "0000000000000000463ac35c9f6413ad";
    expect(report.formats).toEqual({ zipkin: 1 });
    expect(report.traces.timing).toEqual({ end_at_start: 1, start_from_parent: 1 });
    expect(report.traces.remapped).toEqual({ traces: 1, spans: 1 });
    expect(manifest.traces[0]).toMatchObject({
      trace_id: traceId,
      span_count: 6,
      identity: { user: "user-42", session: "conversation-7" },
      origin: "production",
    });
    const all = await spans(traceId);
    for (const span of all)
      expect(str(span, "hue.import.original_trace_id")).toBe("463ac35c9f6413ad");
    const agent = byName(all, "invoke_agent support-agent");
    const client = byName(all, "chat gpt-5");
    const server = byName(all, "post /v1/chat/completions");
    const route = byName(all, "route provider");
    const tool = byName(all, "execute_tool lookup_order");
    const cache = byName(all, "cache lookup");
    expect(agent.resource).toEqual([
      { key: "service.name", value: { stringValue: "support-agent" } },
      { key: "deployment.environment.name", value: { stringValue: "production" } },
      { key: "telemetry.sdk.language", value: { stringValue: "python" } },
    ]);
    expect(agent.scope).toEqual({ name: "support-agent" });
    expect(str(agent, "net.host.ip")).toBe("10.0.0.5");
    // Both halves of the RPC recorded one id; the server nests under the client.
    expect(client.spanId).toBe("5b2c3d4e5f607182");
    expect(client.kind).toBe(3);
    expect(str(client, "peer.service")).toBe("model-gateway");
    expect(server.kind).toBe(2);
    expect(server.parentSpanId).toBe(client.spanId);
    expect(server.spanId).toBe(
      sha256(`zipkin.span:${traceId}:5b2c3d4e5f607182#shared:model-gateway`).slice(0, 16),
    );
    expect(str(server, "hue.import.original_span_id")).toBe("5b2c3d4e5f607182");
    expect(route.parentSpanId).toBe(server.spanId);
    expect(json(client, "gen_ai.output.messages")).toEqual([
      {
        role: "assistant",
        parts: [{ type: "tool_call", id: "call_1", name: "lookup_order", arguments: { id: 12 } }],
        finish_reason: "tool_call",
      },
    ]);
    expect(attr(client.attributes, "gen_ai.usage.input_tokens")).toEqual({ stringValue: "1834" });
    expect(client.events).toEqual([
      { timeUnixNano: "1792504995200000000", name: "gen_ai.choice", attributes: [] },
    ]);
    expect(tool.status).toEqual({ code: 2, message: "carrier timeout, retried" });
    expect(attr(tool.attributes, "error")).toBeUndefined();
    // No timestamp: the span starts with its parent and ends where it starts, and says so.
    expect(cache.startTimeUnixNano).toBe(agent.startTimeUnixNano);
    expect(cache.endTimeUnixNano).toBe(agent.startTimeUnixNano);
    expect(str(cache, "hue.import.timing")).toBe("start_from_parent; end_at_start");
    expect(json(cache, "hue.import.source_record")).toEqual(source[5]);
  });

  test("reads a list of traces and one span per line, refusing only a malformed span's trace", async () => {
    const source = (await fixtureJson("zipkin-v2.json")) as Record<string, unknown>[];
    const other = {
      ...source[0],
      traceId: "5af7183fb1d4cf5f5af7183fb1d4cf5f",
      id: "352bff9a74ca9ad2",
    };
    const broken = {
      ...source[1],
      traceId: "6b221d5bc9e6496c6b221d5bc9e6496c",
      parentId: undefined,
      timestamp: "later",
    };
    const directory = await scratch();
    await writeFiles(directory, {
      // A span of a listed trace needs no more than its ids.
      "traces.json": JSON.stringify([
        source,
        [other, { traceId: other.traceId, id: "1234567890abcdef", parentId: other.id }],
        [broken],
      ]),
      "spans.jsonl": source.map((span) => JSON.stringify(span)).join("\n"),
    });
    const { code, report } = await prepare(directory);
    expect(code).toBe(0);
    expect(report.formats).toEqual({ zipkin: 2 });
    expect(report.traces.refused).toEqual([
      {
        file: "traces.json",
        record: 3,
        trace_id: "6b221d5bc9e6496c6b221d5bc9e6496c",
        reason: "timestamp is not a count of microseconds",
      },
    ]);
    expect(report.totals.spans).toBe(8);
    expect(report.traces.timing).toEqual({ end_at_start: 2, start_from_parent: 2 });
    // The same spans from two files are one trace.
    expect(report.files.supported).toEqual([
      { file: "spans.jsonl", format: "zipkin", traces: 1 },
      { file: "traces.json", format: "zipkin", traces: 2 },
    ]);
  });

  test("--user-key reads a tag of the agent's spans and never a tool's", async () => {
    const [root, chat, , , tool] = (await fixtureJson("zipkin-v2.json")) as Record<string, any>[];
    const { "user.id": _user, ...rootTags } = root!.tags;
    // The key is on a model call beneath the root and on a tool call; were the tool read, the two
    // would disagree and the trace would name no user.
    const spans = [
      { ...root, tags: rootTags },
      { ...chat, tags: { ...chat!.tags, "app.customer_id": "customer-9" } },
      { ...tool, tags: { ...tool!.tags, "app.customer_id": "account-the-tool-touched" } },
    ];
    const {
      report,
      manifest,
      spans: read,
    } = await prepareFile("trace.json", JSON.stringify(spans), "--user-key", "app.customer_id");
    expect(report.traces.without_identity).toBe(0);
    expect(manifest.traces[0]!.identity).toEqual({
      user: "customer-9",
      session: "conversation-7",
    });
    const added = byName(await read(manifest.traces[0]!.trace_id), "hue.import.user");
    expect(added.parentSpanId).toBe("4a1b2c3d4e5f6071");
  });
});

describe("Arize Phoenix", () => {
  test("keeps the OpenInference attributes of an otlpv1 page and refuses only a malformed trace", async () => {
    const source = await fixtureJson("phoenix-otlpv1.json");
    const { report, manifest, spans } = await prepareFile(
      "spans.json",
      await fixture("phoenix-otlpv1.json"),
    );
    const traceId = "8c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f";
    expect(report.formats).toEqual({ phoenix_otlp: 1 });
    expect(report.traces.refused).toEqual([
      {
        file: "spans.json",
        trace_id: "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b",
        reason: "record 5: start_time_unix_nano is not a nanosecond instant",
      },
    ]);
    expect(manifest.traces[0]).toMatchObject({
      trace_id: traceId,
      span_count: 3,
      identity: { user: "user-42", session: "conversation-7" },
    });
    const all = await spans(traceId);
    const agent = byName(all, "support-agent");
    const llm = byName(all, "ChatCompletion");
    const tool = byName(all, "lookup_order");
    expect(agent.kind).toBe(1);
    expect(agent.startTimeUnixNano).toBe("1792504991402000128");
    expect(agent.status).toEqual({ code: 1 });
    expect(agent.scope).toEqual({ name: "hue.import.phoenix_otlp", version: "1" });
    expect(str(agent, "openinference.span.kind")).toBe("AGENT");
    expect(str(agent, "input.value")).toBe("Where is order 12?");
    expect(str(llm, "llm.output_messages.0.message.tool_calls.0.tool_call.function.name")).toBe(
      "lookup_order",
    );
    expect(attr(llm.attributes, "llm.token_count.prompt")).toEqual({ intValue: "1834" });
    expect(llm.events?.[0]?.name).toBe("gen_ai.choice");
    expect(tool.status).toEqual({ code: 2, message: "carrier timeout" });
    expect(attr(tool.attributes, "tag.tags")).toEqual({
      arrayValue: { values: [{ stringValue: "orders" }, { stringValue: "beta" }] },
    });
    expect(json(tool, "hue.import.source_record")).toEqual(source.data[2]);
  });

  test("puts a /spans page's span kind back and reads its zoned timestamps", async () => {
    const { report, manifest, spans } = await prepareFile(
      "spans.json",
      await fixture("phoenix-spans.json"),
    );
    const traceId = "9d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60";
    expect(report.formats).toEqual({ phoenix_spans: 1 });
    expect(manifest.traces[0]).toMatchObject({
      trace_id: traceId,
      span_count: 3,
      identity: { user: "user-42", session: "conversation-7" },
    });
    const all = await spans(traceId);
    const agent = byName(all, "support-agent");
    const tool = byName(all, "lookup_order");
    expect(agent.attributes[0]).toEqual({
      key: "openinference.span.kind",
      value: { stringValue: "AGENT" },
    });
    expect(agent.startTimeUnixNano).toBe("1792504991402000000");
    expect(tool.startTimeUnixNano).toBe("1792504995300000000");
    expect(tool.status).toEqual({ code: 2, message: "carrier timeout" });
    expect(str(tool, "openinference.span.kind")).toBe("TOOL");
    expect(byName(all, "ChatCompletion").events).toEqual([
      {
        timeUnixNano: "1792504995200000000",
        name: "gen_ai.choice",
        attributes: [{ key: "finish_reason", value: { stringValue: "tool_calls" } }],
      },
    ]);
  });
});

describe("Datadog LLM Observability", () => {
  test("reads an export page as canonical rows and refuses only a malformed span's trace", async () => {
    const source = await fixtureJson("datadog-llmobs.json");
    const { report, manifest, spans } = await prepareFile(
      "export.json",
      await fixture("datadog-llmobs.json"),
    );
    const traceId = "6903738200000000af2d3775dfc70530";
    expect(report.formats).toEqual({ datadog_llmobs: 1 });
    expect(report.traces.refused).toEqual([
      {
        file: "export.json",
        trace_id: "6903738200000000aaaaaaaaaaaaaaaa",
        reason: "record 5: metrics is not an object",
      },
    ]);
    expect(report.traces.remapped).toEqual({ traces: 1, spans: 3 });
    expect(manifest.traces[0]).toMatchObject({
      trace_id: traceId,
      span_count: 3,
      identity: { user: "user-42", session: "conversation-7" },
      origin: "production",
    });
    const all = await spans(traceId);
    const agent = byName(all, "support-agent");
    const llm = byName(all, "openai.request");
    const tool = byName(all, "lookup_order");
    const derived = (id: string) => sha256(`datadog_llmobs.span:${traceId}:${id}`).slice(0, 16);
    expect(agent.spanId).toBe(derived("5815242380127734912"));
    expect(str(agent, "hue.import.original_span_id")).toBe("5815242380127734912");
    expect(agent.parentSpanId).toBeUndefined();
    expect(llm.parentSpanId).toBe(agent.spanId);
    expect(agent.startTimeUnixNano).toBe("1792504991402000000");
    expect(agent.endTimeUnixNano).toBe("1792505003877000000");
    expect(agent.resource).toEqual([
      { key: "service.name", value: { stringValue: "support-agent" } },
      { key: "deployment.environment.name", value: { stringValue: "production" } },
    ]);
    expect(str(agent, "user.id")).toBe("user-42");
    expect(str(agent, "gen_ai.conversation.id")).toBe("conversation-7");
    expect(str(agent, "gen_ai.operation.name")).toBe("invoke_agent");
    expect(json(agent, "gen_ai.input.messages")).toEqual([
      { role: "user", parts: [{ type: "text", content: "Where is order 12?" }] },
    ]);
    expect(json(agent, "hue.import.source_record")).toEqual(source.data[0]);

    expect(str(llm, "gen_ai.operation.name")).toBe("chat");
    expect(str(llm, "gen_ai.request.model")).toBe("gpt-5");
    expect(str(llm, "gen_ai.provider.name")).toBe("openai");
    expect(json(llm, "gen_ai.input.messages")).toEqual([
      { role: "system", parts: [{ type: "text", content: "You help with orders." }] },
      { role: "user", parts: [{ type: "text", content: "Where is order 12?" }] },
    ]);
    expect(json(llm, "gen_ai.output.messages")).toEqual([
      {
        role: "assistant",
        parts: [{ type: "tool_call", id: "call_1", name: "lookup_order", arguments: { id: 12 } }],
      },
    ]);
    expect(attr(llm.attributes, "gen_ai.usage.input_tokens")).toEqual({ intValue: "1834" });
    expect(attr(llm.attributes, "gen_ai.usage.output_tokens")).toEqual({ intValue: "96" });
    expect(attr(llm.attributes, "gen_ai.usage.cache_read.input_tokens")).toEqual({
      intValue: "1024",
    });
    expect(json(llm, "gen_ai.tool.definitions")).toEqual(
      source.data[1].attributes.tool_definitions,
    );
    expect(attr(llm.attributes, "user.id")).toBeUndefined();

    // The tool span: its arguments and result, its error; the account it names is not the user.
    expect(str(tool, "gen_ai.operation.name")).toBe("execute_tool");
    expect(str(tool, "gen_ai.tool.name")).toBe("lookup_order");
    expect(json(tool, "gen_ai.tool.call.arguments")).toEqual({
      id: 12,
      user_id: "account-the-tool-touched",
    });
    expect(json(tool, "gen_ai.tool.call.result")).toEqual({ status: "shipped" });
    expect(tool.status).toEqual({ code: 2 });
    expect(str(tool, "error.type")).toBe("TimeoutError");
    expect(attr(tool.attributes, "user.id")).toBeUndefined();
  });

  test("reads a start_ns of millisecond size as milliseconds and says so", async () => {
    const span = {
      id: "14624140233640368324",
      type: "span",
      attributes: {
        span_id: "14624140233640368324",
        trace_id: "6903738200000000af2d3775dfc70531",
        parent_id: "undefined",
        name: "llm_call",
        span_kind: "llm",
        start_ns: 1761833858897,
        duration: 83000,
        status: "ok",
        input: { value: "hi", messages: [{ content: "hi", role: "user" }] },
        output: { value: "hello there", messages: [{ content: "hello there", role: "assistant" }] },
        metrics: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
        tags: ["session_id:s-1"],
      },
    };
    const { report, spans } = await prepareFile("span.json", JSON.stringify(span));
    // The duration beside a millisecond start_ns is read in milliseconds too: 83 s, not 83 µs.
    expect(report.traces.timing).toEqual({ start_ns_read_as_ms: 1, duration_read_as_ms: 1 });
    const [llm] = await spans("6903738200000000af2d3775dfc70531");
    expect(llm!.startTimeUnixNano).toBe("1761833858897000000");
    expect(llm!.endTimeUnixNano).toBe("1761833941897000000");
    expect(str(llm!, "hue.import.timing")).toBe("start_ns_read_as_ms; duration_read_as_ms");
  });
});

describe("Datadog LLM Observability experiments", () => {
  test("declares a span ddtrace tagged with its experiment evaluation traffic, root or not", async () => {
    // An export filtered to llm spans holds an experiment's model calls without their
    // `experiment` root; ddtrace tags every span of the experiment with its id.
    const span = {
      id: "1",
      type: "span",
      attributes: {
        span_id: "1",
        trace_id: "7903738200000000af2d3775dfc70531",
        parent_id: "2",
        name: "llm_call",
        span_kind: "llm",
        start_ns: 1_761_833_858_897_000_000,
        duration: 1000,
        status: "ok",
        tags: ["experiment_id:3b0c1f2a-0d6e-4f7a-9b8c-1d2e3f4a5b6c", "user_id:customer-1"],
      },
    };
    const { manifest } = await prepareFile("span.json", JSON.stringify(span));
    expect(manifest.traces[0]).toMatchObject({ origin: "evaluation" });
  });
});

describe("OTLP protobuf", () => {
  test("reads one binary request to the same spans as its OTLP/JSON form", async () => {
    const request = await fixtureJson("otlp-request.json");
    const traceId = "3c5e7f9081a2b3c4d5e6f708192a3b4c";
    const binary = await prepareFile("request.binpb", encodeRequest(request));
    const asJson = await prepareFile("request.json", JSON.stringify(request));
    expect(binary.report.formats).toEqual({ otlp_protobuf: 1 });
    expect(binary.report.source.formats).toEqual(["otlp_json"]);
    expect(binary.manifest.traces[0]).toMatchObject({
      trace_id: traceId,
      span_count: 3,
      identity: { user: "user-42", session: "conversation-7" },
      origin: "production",
    });
    // The spans are kept as recorded, exactly as an OTLP/JSON export's.
    expect(await binary.spans(traceId)).toEqual(await asJson.spans(traceId));
    const agent = byName(await binary.spans(traceId), "invoke_agent support-agent");
    expect(agent.startTimeUnixNano).toBe("1792504991402000123");
    expect(attr(agent.attributes, "app.request")).toEqual({
      kvlistValue: {
        values: [
          { key: "retries", value: { intValue: "-1" } },
          { key: "raw", value: { bytesValue: "AAEC" } },
        ],
      },
    });
  });

  test("reads collector file exports: length-prefixed protobuf, zstd messages and JSON lines", async () => {
    const request = await fixtureJson("otlp-request.json");
    const traceId = "3c5e7f9081a2b3c4d5e6f708192a3b4c";
    const [first, ...rest] = request.resourceSpans[0].scopeSpans[0].spans;
    const part = (spans: unknown[]) => ({
      resourceSpans: [
        {
          ...request.resourceSpans[0],
          scopeSpans: [{ ...request.resourceSpans[0].scopeSpans[0], spans }],
        },
      ],
    });
    const other = part([{ ...first, traceId: "4d6f8091a2b3c4d5e6f708192a3b4c5d" }]);
    const files: Record<string, Uint8Array | string> = {
      // `format: proto`: one message per batch, the last cut off by a collector still writing.
      "proto.bin": Buffer.concat([
        lengthPrefixed(
          encodeRequest(part([first])),
          encodeRequest(part(rest)),
          Buffer.from("not protobuf"),
        ),
        Buffer.from([0, 0, 1]),
      ]),
      // `format: json` without compression: OTLP/JSON lines, with a metrics line and a cut line.
      "lines.jsonl": [
        JSON.stringify(other),
        JSON.stringify({ resourceMetrics: [] }),
        JSON.stringify(other).slice(0, 50),
      ].join("\n"),
    };
    if (typeof zlib.zstdCompressSync === "function")
      // `compression: zstd`: each batch compressed alone, protobuf or JSON, then length-prefixed.
      files["zstd.bin"] = lengthPrefixed(
        zlib.zstdCompressSync(encodeRequest(part(rest))),
        zlib.zstdCompressSync(Buffer.from(JSON.stringify(other))),
      );
    const directory = await scratch();
    await writeFiles(directory, files);
    const { code, report } = await prepare(directory);
    expect(code).toBe(0);
    expect(report.totals.traces).toBe(2);
    expect(report.files.skipped).toEqual([
      {
        file: "lines.jsonl",
        line: 2,
        reason: "an OTLP metrics export; only traces are imported",
      },
      {
        file: "lines.jsonl",
        line: 3,
        reason: "truncated JSON",
      },
      {
        file: "proto.bin",
        line: 3,
        reason: "not an OTLP trace message: a protobuf field of wire type 6",
      },
      { file: "proto.bin", line: 4, reason: "a truncated length-prefixed message" },
    ]);
    const expected = [
      { file: "lines.jsonl", format: "otlp_json", traces: 1 },
      { file: "proto.bin", format: "otlp_protobuf", traces: 1 },
    ];
    if (files["zstd.bin"])
      expected.push(
        { file: "zstd.bin", format: "otlp_protobuf", traces: 1 },
        { file: "zstd.bin", format: "otlp_json", traces: 1 },
      );
    expect(report.files.supported).toEqual(expected);
    expect(report.formats).toEqual({ otlp_json: 1, otlp_protobuf: 1 });
    const manifest = JSON.parse(
      await readFile(join(report.output_directory, "manifest.json"), "utf8"),
    ) as TraceImportManifest;
    expect(manifest.traces.find((trace) => trace.trace_id === traceId)).toMatchObject({
      span_count: 3,
      identity: { user: "user-42", session: "conversation-7" },
    });
  });
  test("refuses only the trace of a span it cannot decode, and names a damaged request's fault", async () => {
    const request = await fixtureJson("otlp-request.json");
    const [first] = request.resourceSpans[0].scopeSpans[0].spans;
    const traces = ["5e7f9081a2b3c4d5e6f708192a3b4c5d", "6f8091a2b3c4d5e6f708192a3b4c5d6e"];
    const spanOf = (traceId: string, name: string) => ({ ...first, traceId, name });
    // A span whose name is not UTF-8: its trace id comes first, so its trace alone is refused.
    const encoded = Buffer.from(
      encodeRequest({
        resourceSpans: [
          {
            ...request.resourceSpans[0],
            scopeSpans: [
              {
                ...request.resourceSpans[0].scopeSpans[0],
                spans: [spanOf(traces[0]!, "good span"), spanOf(traces[1]!, "BROKEN!!")],
              },
            ],
          },
        ],
      }),
    );
    const at = encoded.indexOf("BROKEN!!");
    encoded.fill(0xff, at, at + 8);
    const directory = await scratch();
    await writeFiles(directory, {
      "request.pb": encoded,
      "cut.pb": encoded.subarray(0, encoded.byteLength - 5),
    });
    const { code, report } = await prepare(directory);
    expect(code).toBe(0);
    expect(report.totals.traces).toBe(1);
    expect(report.traces.refused).toEqual([
      {
        file: "request.pb",
        trace_id: traces[1],
        reason: "span 2 is not an OTLP span: protobuf text that is not UTF-8",
      },
    ]);
    expect(report.files.unsupported).toEqual([
      { file: "cut.pb", reason: "not an OTLP trace request: a truncated protobuf field" },
    ]);
  });

  test.skipIf(typeof zlib.zstdCompressSync !== "function")(
    "bounds what a file's zstd messages decompress to together, reading them one at a time",
    () => {
      const request = (traceId: string) => ({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId,
                    spanId: "0f1e2d3c4b5a6978",
                    name: "big",
                    startTimeUnixNano: "1792504991402000123",
                    endTimeUnixNano: "1792504991402000124",
                    attributes: [{ key: "pad", value: { stringValue: "x".repeat(400_000) } }],
                  },
                ],
              },
            ],
          },
        ],
      });
      // Each message compresses to a few hundred bytes and decompresses to about 400 KB.
      const frames = ["1", "2", "3", "4"].map((digit) =>
        zlib.zstdCompressSync(encodeRequest(request(digit.repeat(32)))),
      );
      const read = binaryValues(lengthPrefixed(...frames), 1_000_000);
      if (!read || "unsupported" in read) throw new Error("not read as binary OTLP");
      const iterator = read.values[Symbol.iterator]();
      expect(iterator.next().done).toBe(false);
      // Nothing past the message in hand is decompressed yet.
      expect(read.bytes()).toBeLessThan(500_000);
      expect(iterator.next().done).toBe(false);
      expect(iterator.next().done).toBe(true);
      expect(read.problems).toEqual([
        {
          line: 3,
          reason:
            "the messages decompress to more than 1000000 bytes; this message and the 1 after it were not read",
        },
      ]);
      expect(read.bytes()).toBeGreaterThan(800_000);
    },
  );

  test.skipIf(typeof zlib.zstdCompressSync !== "function")(
    "counts what a damaged zstd message decompressed to against the file's bound",
    () => {
      // Each decompresses to about 400 KB and then reads as neither JSON nor protobuf.
      const notJson = zlib.zstdCompressSync(Buffer.from(`{${"x".repeat(400_000)}`));
      const notProtobuf = zlib.zstdCompressSync(Buffer.alloc(400_000, 0xff));
      const read = binaryValues(
        lengthPrefixed(notJson, notProtobuf, notJson, notProtobuf),
        1_000_000,
      );
      if (!read || "unsupported" in read) throw new Error("not read as binary OTLP");
      expect([...read.values]).toEqual([]);
      expect(read.problems).toEqual([
        { line: 1, reason: "not an OTLP trace message: a message that is not JSON" },
        { line: 2, reason: "not an OTLP trace message: a protobuf varint over ten bytes" },
        {
          line: 3,
          reason:
            "the messages decompress to more than 1000000 bytes; this message and the 1 after it were not read",
        },
      ]);
      expect(read.bytes()).toBeGreaterThan(800_000);
    },
  );

  test.skipIf(typeof zlib.zstdCompressSync !== "function")(
    "counts what a zstd message that fails its checksum decompressed to against the file's bound",
    async () => {
      const checksummed = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
      const damage = (frame: Buffer) => {
        frame[frame.byteLength - 1]! ^= 0xff;
        return frame;
      };
      // Each decompresses whole, 1.5 MB, before its checksum fails.
      const damaged = damage(zlib.zstdCompressSync(Buffer.alloc(1_500_000, 0xff), checksummed));
      const read = binaryValues(lengthPrefixed(damaged, damaged, damaged), 4_000_000);
      if (!read || "unsupported" in read) throw new Error("not read as binary OTLP");
      expect([...read.values]).toEqual([]);
      expect(read.problems).toEqual([
        { line: 1, reason: "not an OTLP trace message: a damaged zstd message" },
        { line: 2, reason: "not an OTLP trace message: a damaged zstd message" },
        {
          line: 3,
          reason:
            "the messages decompress to more than 4000000 bytes; this message and the 0 after it were not read",
        },
      ]);
      expect(read.bytes()).toBe(3_000_000);
      // A frame compressed as a stream declares no size: it counts what it decompressed to, at
      // least the 1 MiB any damaged frame counts, and the message after it is read.
      const streamed = damage(
        await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          zlib
            .createZstdCompress(checksummed)
            .on("data", (chunk: Buffer) => chunks.push(chunk))
            .on("end", () => resolve(Buffer.concat(chunks)))
            .on("error", reject)
            .end(Buffer.alloc(1_000, 0xff));
        }),
      );
      const request = encodeRequest(await fixtureJson("otlp-request.json"));
      const rest = binaryValues(lengthPrefixed(streamed, request), 4_000_000);
      if (!rest || "unsupported" in rest) throw new Error("not read as binary OTLP");
      expect([...rest.values]).toHaveLength(1);
      expect(rest.problems).toEqual([
        { line: 1, reason: "not an OTLP trace message: a damaged zstd message" },
      ]);
      expect(rest.bytes()).toBe(1024 * 1024 + request.byteLength);
      // Each frame of a message counts, whichever runtime reads it: Node.js decompresses only the
      // first frame of a buffer on its own, Bun every one. A frame counts at least 1 KiB.
      const twoFrames = Buffer.concat([
        zlib.zstdCompressSync(Buffer.alloc(300, 0x0a), checksummed),
        damage(zlib.zstdCompressSync(Buffer.alloc(1_500_000, 0xff), checksummed)),
      ]);
      const both = binaryValues(lengthPrefixed(twoFrames, twoFrames, twoFrames), 2_000_000);
      if (!both || "unsupported" in both) throw new Error("not read as binary OTLP");
      expect([...both.values]).toEqual([]);
      expect(both.problems).toEqual([
        { line: 1, reason: "not an OTLP trace message: a damaged zstd message" },
        {
          line: 2,
          reason:
            "the messages decompress to more than 2000000 bytes; this message and the 1 after it were not read",
        },
      ]);
      expect(both.bytes()).toBe(1_024 + 1_500_000);
      const halves = [request.subarray(0, 40), request.subarray(40)];
      const split = binaryValues(
        lengthPrefixed(Buffer.concat(halves.map((half) => zlib.zstdCompressSync(half)))),
        1_000_000,
      );
      if (!split || "unsupported" in split) throw new Error("not read as binary OTLP");
      expect([...split.values]).toHaveLength(1);
      expect(split.problems).toEqual([]);
      // Content past the bound is over it, though its checksum fails before the bound is met.
      const over = binaryValues(
        lengthPrefixed(damage(zlib.zstdCompressSync(Buffer.alloc(10_000, 0xff), checksummed))),
        5_000,
      );
      if (!over || "unsupported" in over) throw new Error("not read as binary OTLP");
      expect([...over.values]).toEqual([]);
      expect(over.problems).toEqual([
        {
          line: 1,
          reason:
            "the messages decompress to more than 5000 bytes; this message and the 0 after it were not read",
        },
      ]);
    },
  );

  test.skipIf(typeof zlib.zstdCompressSync !== "function")(
    "counts a zstd message whose blocks do not decompress at least 1 MiB, so damage ends the file",
    () => {
      // Literals that name a table the frame never set: each message fails where it starts.
      const broken = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0x25, 0, 0, 0x03, 0, 0, 0]);
      const read = binaryValues(
        lengthPrefixed(...Array.from({ length: 10 }, () => broken)),
        4 * 1024 * 1024,
      );
      if (!read || "unsupported" in read) throw new Error("not read as binary OTLP");
      expect([...read.values]).toEqual([]);
      expect(read.problems).toEqual([
        ...[1, 2, 3, 4].map((line) => ({
          line,
          reason: "not an OTLP trace message: a damaged zstd message",
        })),
        {
          line: 5,
          reason:
            "the messages decompress to more than 4194304 bytes; this message and the 5 after it were not read",
        },
      ]);
      expect(read.bytes()).toBe(4 * 1024 * 1024);
    },
  );

  test.skipIf(typeof zlib.zstdCompressSync !== "function")(
    "reads a zstd message padded after its frames and names the padding",
    async () => {
      const request = encodeRequest(await fixtureJson("otlp-request.json"));
      // Zero padding after the frame, as a block device writes it.
      const padded = Buffer.concat([zlib.zstdCompressSync(request), Buffer.alloc(16)]);
      const note = "16 bytes after the message's last zstd frame are not zstd and were not read";
      const read = binaryValues(lengthPrefixed(padded), 1_000_000);
      if (!read || "unsupported" in read) throw new Error("not read as binary OTLP");
      expect([...read.values].map((value) => value.note)).toEqual([note]);
      expect(read.problems).toEqual([]);
      const { report } = await prepareFile("collector.binpb", lengthPrefixed(padded));
      expect(report.totals.traces).toBe(1);
      expect(report.files.skipped).toEqual([]);
      expect(report.files.notes).toEqual([{ file: "collector.binpb", line: 1, reason: note }]);
    },
  );
});

describe("One trace across files of several formats", () => {
  const traceId = "3c5e7f9081a2b3c4d5e6f708192a3b4c";
  /** The fixture request holding only `spans`. */
  const part = (request: any, spans: unknown[]) => ({
    resourceSpans: [
      {
        ...request.resourceSpans[0],
        scopeSpans: [{ ...request.resourceSpans[0].scopeSpans[0], spans }],
      },
    ],
  });

  test("joins a trace whose spans are split across OTLP/JSON, binary OTLP and Jaeger API v3", async () => {
    const request = await fixtureJson("otlp-request.json");
    const [first, second, third] = request.resourceSpans[0].scopeSpans[0].spans;
    const whole = await prepareFile("whole.json", JSON.stringify(request));
    const directory = await scratch();
    await writeFiles(directory, {
      "agent.json": JSON.stringify(part(request, [first])),
      "chat.binpb": encodeRequest(part(request, [second])),
      "tool.jsonl": `${JSON.stringify({ result: part(request, [third]) })}\n{"end":true}\n`,
      // The same span in an OTLP/JSON file: a copy that agrees is read once.
      "tool-copy.json": JSON.stringify(part(request, [third])),
    });
    const { code, report, stderr } = await prepare(directory);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(report.traces.refused).toEqual([]);
    expect(report.totals).toMatchObject({ traces: 1, spans: 3 });
    expect(report.formats).toEqual({ otlp_json: 1 });
    expect(report.files.supported).toEqual([
      { file: "agent.json", format: "otlp_json", traces: 1 },
      { file: "chat.binpb", format: "otlp_protobuf", traces: 1 },
      { file: "tool-copy.json", format: "otlp_json", traces: 1 },
      { file: "tool.jsonl", format: "jaeger_api_v3", traces: 1 },
    ]);
    const out = report.output_directory as string;
    const manifest = JSON.parse(
      await readFile(join(out, "manifest.json"), "utf8"),
    ) as TraceImportManifest;
    expect(manifest.traces[0]).toMatchObject({
      trace_id: traceId,
      span_count: 3,
      identity: { user: "user-42", session: "conversation-7" },
    });
    const spans: Record<string, unknown>[] = [];
    for (const batch of manifest.traces[0]!.batches) {
      const body = await readFile(join(out, `${traceId}.${batch.sha256}.json.gz`));
      const decoded = JSON.parse(zlib.gunzipSync(body).toString("utf8"));
      for (const group of decoded.resourceSpans)
        for (const scope of group.scopeSpans)
          for (const span of scope.spans)
            spans.push({ ...span, resource: group.resource?.attributes ?? [], scope: scope.scope });
    }
    // The spans the trace's one-file export holds.
    expect(spans).toEqual(await whole.spans(traceId));
  });

  test("reads once a span binary OTLP and OTLP/JSON both hold, whichever is read first", async () => {
    // The root's span id has `+` and `/` in base64, which URL-safe base64 writes as `-` and `_`.
    const request = JSON.parse(
      JSON.stringify(await fixtureJson("otlp-request.json")).replaceAll(
        "0f1e2d3c4b5a6978",
        "fbff0f1e2d3c4b5a",
      ),
    );
    const [first] = request.resourceSpans[0].scopeSpans[0].spans;
    // Bytes whose base64 has `+` and `/`, and a double JSON has no number for.
    first.attributes.find(
      (item: Attribute) => item.key === "app.request",
    ).value.kvlistValue.values[1].value.bytesValue = "+//+AQ==";
    first.attributes
      .find((item: Attribute) => item.key === "app.flags")
      .value.arrayValue.values.push({ doubleValue: "NaN" });
    // A span's flags and dropped counts, which binary OTLP writes as numbers.
    for (const span of request.resourceSpans[0].scopeSpans[0].spans)
      Object.assign(span, {
        flags: 257,
        droppedAttributesCount: 2,
        droppedEventsCount: 1,
        droppedLinksCount: 3,
      });
    // OTLP/JSON as a ProtoJSON encoder may write it: int64 values as numbers, doubles as text,
    // bytes and span ids as URL-safe base64 without padding (the trace id padded), a uint32 as
    // decimal text, enums by name or as text, and fields at their defaults, which binary OTLP
    // leaves out.
    const urlSafe = (base64: string) => base64.replace(/\+/g, "-").replace(/\//g, "_");
    const base64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");
    const protoJson = (value: any): any =>
      Array.isArray(value)
        ? value.map(protoJson)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([key, item]) => [
                key,
                key === "intValue"
                  ? Number(item)
                  : key === "doubleValue"
                    ? String(item)
                    : key === "bytesValue"
                      ? urlSafe(item as string).replace(/=+$/, "")
                      : key === "traceId"
                        ? urlSafe(base64(item as string))
                        : key === "spanId" || key === "parentSpanId"
                          ? urlSafe(base64(item as string)).replace(/=+$/, "")
                          : protoJson(item),
              ]),
            )
          : value;
    const exported = protoJson(request);
    const kinds = ["SPAN_KIND_UNSPECIFIED", "SPAN_KIND_INTERNAL", "SPAN_KIND_SERVER"];
    const codes = ["STATUS_CODE_UNSET", "STATUS_CODE_OK", "STATUS_CODE_ERROR"];
    for (const group of exported.resourceSpans) {
      Object.assign(group, { schemaUrl: "" });
      Object.assign(group.resource, { droppedAttributesCount: 0 });
      for (const scope of group.scopeSpans) {
        Object.assign(scope.scope, { attributes: [], droppedAttributesCount: 0 });
        for (const span of scope.spans)
          Object.assign(span, {
            kind: span === scope.spans[0] ? String(span.kind) : (kinds[span.kind] ?? span.kind),
            traceState: "",
            droppedAttributesCount: String(span.droppedAttributesCount),
            events: span.events ?? [],
            droppedEventsCount: String(span.droppedEventsCount),
            links: span.links ?? [],
            droppedLinksCount: String(span.droppedLinksCount),
            flags: String(span.flags),
            status: { message: "", ...span.status, code: codes[span.status.code ?? 0] },
          });
      }
    }
    expect(JSON.stringify(exported)).toContain('"traceId":"PF5_kIGis8TV5vcIGSo7TA=="');
    expect(JSON.stringify(exported)).toContain('"spanId":"-_8PHi08S1o"');
    const batches: unknown[] = [];
    for (const [json, binary, jaeger] of [
      ["a.json", "b.binpb", "c.jsonl"],
      ["c.json", "a.binpb", "b.jsonl"],
    ] as const) {
      const directory = await scratch();
      await writeFiles(directory, {
        [json]: JSON.stringify(exported),
        [binary]: encodeRequest(request),
        [jaeger]: `${JSON.stringify({ result: part(request, [first]) })}\n`,
      });
      const { code, report, stderr } = await prepare(directory);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(report.traces.refused).toEqual([]);
      expect(report.totals).toMatchObject({ traces: 1, spans: 3 });
      const manifest = JSON.parse(
        await readFile(join(report.output_directory as string, "manifest.json"), "utf8"),
      ) as TraceImportManifest;
      batches.push(manifest.traces[0]!.batches);
    }
    // The copy kept does not depend on the order the files were read in.
    expect(batches[1]).toEqual(batches[0]);
    // A value at its default is still a value: a zero is not an absent value.
    const retries = (value: unknown) => {
      const copy = structuredClone(request);
      const attributes = copy.resourceSpans[0].scopeSpans[0].spans[0].attributes;
      attributes.find(
        (item: Attribute) => item.key === "app.request",
      ).value.kvlistValue.values[0].value = value;
      return copy;
    };
    const directory = await scratch();
    await writeFiles(directory, {
      "a.json": JSON.stringify(retries({})),
      "b.binpb": encodeRequest(retries({ intValue: "0" })),
    });
    const { code, stderr } = await prepare(directory);
    expect(code).not.toBe(0);
    expect(stderr).toContain(`span ${first.spanId} appears with different content`);
  });

  test("reads a user and conversation alike from every ProtoJSON spelling of their values", async () => {
    const request = await fixtureJson("otlp-request.json");
    const [first] = request.resourceSpans[0].scopeSpans[0].spans;
    const other = "4d6f8091a2b3c4d5e6f708192a3b4c5d";
    request.resourceSpans[0].scopeSpans[0].spans = [
      first,
      { ...structuredClone(first), traceId: other },
    ];
    const set = (copy: any, span: number, key: string, value: unknown) =>
      (copy.resourceSpans[0].scopeSpans[0].spans[span].attributes.find(
        (item: Attribute) => item.key === key,
      ).value = value);
    // Binary OTLP holds a double, an int64 and bytes one way; ProtoJSON may write each as text.
    set(request, 0, "user.id", { doubleValue: 42 });
    set(request, 0, "gen_ai.conversation.id", { bytesValue: "+//+AQ==" });
    set(request, 1, "user.id", { intValue: "42" });
    const exported = structuredClone(request);
    set(exported, 0, "user.id", { doubleValue: "42" });
    set(exported, 0, "gen_ai.conversation.id", { bytesValue: "-__-AQ" });
    set(exported, 1, "user.id", { intValue: "0042" });
    const identities = async (name: string, content: Uint8Array | string) =>
      (await prepareFile(name, content)).manifest.traces.map((trace) => [
        trace.trace_id,
        trace.identity,
      ]);
    // Whichever copy of a span is kept names the same user and conversation.
    const expected = [
      [traceId, { user: "42", session: "+//+AQ==" }],
      [other, { user: "42", session: "conversation-7" }],
    ];
    expect(await identities("request.binpb", encodeRequest(request))).toEqual(expected);
    expect(await identities("request.json", JSON.stringify(exported))).toEqual(expected);
  });

  test("reads an unpadded base64 id only as an encoder writes it", async () => {
    // Eleven letters and digits that differ only in bits base64 leaves unused: read as base64
    // they would be one span id, so each is mapped as an id that is no OpenTelemetry id is.
    const request = await fixtureJson("otlp-request.json");
    const [first] = request.resourceSpans[0].scopeSpans[0].spans;
    request.resourceSpans[0].scopeSpans[0].spans = ["span-000001", "span-000002"].map((spanId) => ({
      ...structuredClone(first),
      spanId,
    }));
    const { report, spans } = await prepareFile("request.json", JSON.stringify(request));
    expect(report.traces.refused).toEqual([]);
    expect(report.traces.remapped).toEqual({ traces: 1, spans: 2 });
    expect(
      (await spans(traceId)).map((span) => str(span, "hue.import.original_span_id")).sort(),
    ).toEqual(["span-000001", "span-000002"]);
  });

  test("refuses the trace when two formats hold one span with different content", async () => {
    const request = await fixtureJson("otlp-request.json");
    const [first, second] = request.resourceSpans[0].scopeSpans[0].spans;
    const directory = await scratch();
    await writeFiles(directory, {
      "agent.json": JSON.stringify(part(request, [first, second])),
      "chat.jsonl": JSON.stringify({ result: part(request, [{ ...second, name: "renamed" }]) }),
    });
    const { code, stderr } = await prepare(directory);
    expect(code).not.toBe(0);
    expect(stderr).toContain(`span ${second.spanId} appears with different content`);
  });

  test("leaves out a trace one format refuses after another read it whole", async () => {
    const request = await fixtureJson("otlp-request.json");
    const other = "4d6f8091a2b3c4d5e6f708192a3b4c5d";
    const [first] = request.resourceSpans[0].scopeSpans[0].spans;
    const zipkinSpan = (id: string, parentId: string) => ({
      traceId,
      id,
      parentId,
      name: "cycle",
      timestamp: 1_792_504_991_402_000,
      duration: 5,
    });
    const directory = await scratch();
    await writeFiles(directory, {
      "trace.json": JSON.stringify(part(request, request.resourceSpans[0].scopeSpans[0].spans)),
      "other.json": JSON.stringify(part(request, [{ ...first, traceId: other }])),
      // Zipkin spans of the same trace whose parents close on themselves: the trace is refused.
      "zipkin.json": JSON.stringify([
        zipkinSpan("aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"),
        zipkinSpan("bbbbbbbbbbbbbbbb", "aaaaaaaaaaaaaaaa"),
      ]),
    });
    const { code, report } = await prepare(directory);
    expect(code).toBe(0);
    expect(report.traces.refused).toEqual([
      { trace_id: traceId, reason: "The source hierarchy contains a cycle" },
    ]);
    const manifest = JSON.parse(
      await readFile(join(report.output_directory, "manifest.json"), "utf8"),
    ) as TraceImportManifest;
    expect(manifest.traces.map((trace) => trace.trace_id)).toEqual([other]);
    expect(report.formats).toEqual({ otlp_json: 1 });
  });
});
