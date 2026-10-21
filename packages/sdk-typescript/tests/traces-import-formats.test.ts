import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import * as zlib from "node:zlib";
import { runTracesCommand } from "../src/cli/traces-import.js";
import type { TraceImportManifest } from "../src/cli/traces-import-convert.js";
import { decodeContainer } from "../src/cli/import-formats/containers.js";
import { genAiMessages } from "../src/cli/import-formats/messages.js";
import { importAdapters } from "../src/cli/import-formats/registry.js";
import { RowTraceCollector, type SpanRow } from "../src/cli/import-formats/rows.js";

// Synthetic exports only: invented ids, users and content. Nothing leaves the machine; prepare
// writes a bundle to a scratch directory and the tests read it back.

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hue-formats-"));
  directories.push(directory);
  return directory;
}

async function writeFiles(root: string, files: Record<string, Uint8Array | string>) {
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), bytes);
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

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: Record<string, any> }[];
  status: { code: number; message?: string };
  events?: { name: string; timeUnixNano: string; attributes: unknown[] }[];
  [field: string]: unknown;
}

async function bundle(directory: string) {
  const manifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  ) as TraceImportManifest;
  const spans = async (traceId: string) => {
    const trace = manifest.traces.find((item) => item.trace_id === traceId)!;
    const found: (Span & { resource: Record<string, unknown>; scope: string })[] = [];
    for (const batch of trace.batches) {
      const body = await readFile(join(directory, `${traceId}.${batch.sha256}.json.gz`));
      const decoded = JSON.parse(zlib.gunzipSync(body).toString("utf8")) as {
        resourceSpans: {
          resource: { attributes: { key: string; value: Record<string, unknown> }[] };
          scopeSpans: { scope: { name: string }; spans: Span[] }[];
        }[];
      };
      for (const group of decoded.resourceSpans)
        for (const scope of group.scopeSpans)
          for (const span of scope.spans)
            found.push({
              ...span,
              resource: Object.fromEntries(
                group.resource.attributes.map((item) => [item.key, item.value.stringValue]),
              ),
              scope: scope.scope.name,
            });
    }
    return found;
  };
  return { manifest, spans };
}

const attr = (span: Span, key: string) => span.attributes.find((item) => item.key === key)?.value;
const str = (span: Span, key: string) => attr(span, key)?.stringValue as string | undefined;
const json = (span: Span, key: string) => JSON.parse(str(span, key)!) as unknown;

// --- OTLP fixtures ------------------------------------------------------------------------------

type Attributes = Record<string, string | number>;
const otlpAttributes = (values: Attributes) =>
  Object.entries(values).map(([key, value]) => ({
    key,
    value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value },
  }));
const otlpSpan = (
  traceId: string,
  spanId: string,
  parentSpanId: string | undefined,
  name: string,
  attributes: Attributes = {},
) => ({
  traceId,
  spanId,
  ...(parentSpanId ? { parentSpanId } : {}),
  name,
  kind: 1,
  startTimeUnixNano: "1760000000000000000",
  endTimeUnixNano: "1760000001000000000",
  attributes: otlpAttributes(attributes),
  status: { code: 0 },
});
const otlp = (spans: unknown[], resource: Attributes = { "service.name": "agent" }) => ({
  resourceSpans: [
    {
      resource: { attributes: otlpAttributes(resource) },
      scopeSpans: [{ scope: { name: "synthetic" }, spans }],
    },
  ],
});
const traceIds = (seed: string) => seed.repeat(32).slice(0, 32);
const spanIds = (seed: string) => seed.repeat(16).slice(0, 16);

// --- Braintrust fixtures ------------------------------------------------------------------------

const BT_TRACE = "4f1d0c9e7a3b2c18e5d6f7a8b9c0d1e2";
const BT_ROOT = "b7c1e2d4a9f03e11";
const BT_LLM = "c3a9d1f07b6e4a22";
const BT_TOOL = "d4b0e2a18c7f5b33";
const container = {
  _xact_id: "1000196051234567890",
  created: "2026-10-20T14:03:11.402Z",
  org_id: "org-synthetic",
  project_id: "project-synthetic",
  log_id: "g",
};
/** One production trace: an agent task, an LLM call that requests a tool, the tool call, and a
 * log row Braintrust stored for the LLM span. */
const braintrustRows = [
  {
    ...container,
    id: BT_ROOT,
    span_id: BT_ROOT,
    root_span_id: BT_TRACE,
    span_parents: [],
    is_root: true,
    span_attributes: { name: "support-agent", type: "task" },
    input: "Where is order 12?",
    output: "Order 12 ships tomorrow.",
    metadata: { user_id: "user-42", session_id: "conversation-7" },
    metrics: { start: 1792504991.402, end: 1792505003.877 },
    tags: ["beta"],
  },
  {
    ...container,
    id: BT_LLM,
    span_id: BT_LLM,
    root_span_id: BT_TRACE,
    span_parents: [BT_ROOT],
    span_attributes: { name: "Chat Completion", type: "llm" },
    input: [
      { role: "system", content: "You help with orders." },
      { role: "user", content: "Where is order 12?" },
    ],
    output: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup_order", arguments: '{"id":12}' },
            },
          ],
        },
      },
    ],
    metadata: { model: "gpt-5", provider: "openai" },
    metrics: {
      start: 1792504992.01,
      end: 1792504995.233,
      prompt_tokens: 1834,
      completion_tokens: 96,
      tokens: 1930,
      prompt_cached_tokens: 1024,
    },
  },
  {
    ...container,
    id: BT_TOOL,
    span_id: BT_TOOL,
    root_span_id: BT_TRACE,
    span_parents: [BT_ROOT],
    span_attributes: { name: "lookup_order", type: "tool" },
    input: { id: 12 },
    output: { status: "shipped", eta: "tomorrow" },
    // A tool's record may name the account it acted on; that is never the trace's user.
    metadata: { toolCallId: "call_1", user_id: "account-the-tool-touched" },
    metrics: { start: 1792504995.3, end: 1792504995.9 },
  },
  {
    ...container,
    id: "e5f6a7b8c9d0e1f2",
    span_id: BT_LLM,
    root_span_id: BT_TRACE,
    span_parents: [BT_ROOT],
    span_attributes: { type: "log" },
    output: "gen_ai.choice",
    metadata: { finish_reason: "tool_calls" },
    metrics: { start: 1792504995.2 },
  },
];

describe("containers", () => {
  test("reads gzip and zstd files, and bounds what they decompress to", async () => {
    const root = await scratch();
    const text = braintrustRows.map((row) => JSON.stringify(row)).join("\n");
    const files: Record<string, Uint8Array> = { "rows.jsonl.gz": zlib.gzipSync(text) };
    if (typeof zlib.zstdCompressSync === "function")
      files["copy/rows.jsonl.zst"] = zlib.zstdCompressSync(Buffer.from(text));
    await writeFiles(root, files);
    const { code, report } = await prepare(root);
    expect(code).toBe(0);
    expect(report.totals.traces).toBe(1);
    expect(
      report.files.supported.map((file: any) => [file.file, file.format, file.traces]),
    ).toEqual(
      Object.keys(files)
        .sort()
        .map((name) => [name, "braintrust", 1]),
    );
    // The source digest names the decompressed content, so both copies are one source.
    expect(report.files.unsupported).toEqual([]);
    const { manifest } = await bundle(report.output_directory);
    expect(manifest.traces[0]!.source_digest).toBe(sha256(text));

    expect(decodeContainer(zlib.gzipSync("x".repeat(2048)), 1024)).toEqual({
      unsupported: "a gzip file that decompresses to more than 1024 bytes",
    });
    expect(decodeContainer(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01]), 1024)).toEqual({
      unsupported: "a damaged gzip file",
    });
    expect(decodeContainer(zlib.gzipSync(zlib.gzipSync("{}")), 1024)).toEqual({
      unsupported: "a file compressed twice; decompress it first",
    });
  });

  test("reads JSON Lines line by line, naming a bad, truncated or unsupported line", async () => {
    const root = await scratch();
    const lines = [
      JSON.stringify(braintrustRows[0]),
      "",
      JSON.stringify(braintrustRows[1]),
      JSON.stringify({ resourceLogs: [] }),
      JSON.stringify(otlp([otlpSpan(traceIds("a1"), spanIds("b2"), undefined, "job")])),
      "not json at all",
      JSON.stringify(braintrustRows[2]).slice(0, 40),
    ];
    await writeFiles(root, {
      "export.jsonl": lines.join("\n"),
      "notes.jsonl": "one\ntwo\n",
      "cut.json": JSON.stringify(braintrustRows[0], null, 2).slice(0, 120),
    });
    const { code, report } = await prepare(root);
    expect(code).toBe(0);
    // One Braintrust trace and one OTLP trace from the readable lines of the same file.
    expect(report.formats).toEqual({ braintrust: 1, otlp_json: 1 });
    expect(report.files.supported).toEqual([
      { file: "export.jsonl", format: "braintrust", traces: 1 },
      { file: "export.jsonl", format: "otlp_json", traces: 1 },
    ]);
    expect(report.files.skipped).toEqual([
      { file: "export.jsonl", line: 4, reason: "an OTLP logs export; only traces are imported" },
      { file: "export.jsonl", line: 6, reason: "not JSON" },
      { file: "export.jsonl", line: 7, reason: "truncated JSON" },
    ]);
    // A file of which nothing is read is reported whole, not line by line.
    expect(report.files.unsupported).toEqual([
      { file: "cut.json", reason: "truncated JSON" },
      { file: "notes.jsonl", reason: "not JSON" },
    ]);
  });

  test("reads each record of a JSON array, naming the ones no format claims", async () => {
    const root = await scratch();
    await writeFiles(root, {
      "download.json": JSON.stringify([
        braintrustRows[0],
        { note: "not a span" },
        braintrustRows[1],
      ]),
    });
    const { code, report } = await prepare(root);
    expect(code).toBe(0);
    expect(report.totals.spans).toBe(2);
    expect(report.files.skipped).toEqual([
      { file: "download.json", record: 2, reason: "a JSON document of no recognized format" },
    ]);
  });
});

describe("the format registry", () => {
  test("lets exactly one format claim each format's records", () => {
    const observation = {
      id: "obs-1",
      traceId: "trace-1",
      type: "SPAN",
      startTime: "2026-03-01T10:00:00.000Z",
    };
    const fixtures: [string, unknown][] = [
      ["otlp_json", otlp([otlpSpan(traceIds("a1"), spanIds("b2"), undefined, "job")])],
      ["otlp_json", { resource_spans: [] }],
      ["langfuse_observations", { data: [observation], meta: { page: 1 } }],
      ["langfuse_observations", { observations: [observation] }],
      ["langfuse", { data: [{ ...observation, projectId: "p" }], meta: { cursor: "c" } }],
      [
        "langfuse",
        { id: "t", timestamp: "2026-03-01T10:00:00Z", bookmarked: false, public: false },
      ],
      [
        "langfuse",
        {
          id: "o",
          trace_id: "t",
          type: "SPAN",
          start_time: "2026-03-01 10:00:00",
          parent_observation_id: "",
        },
      ],
      ["atif", { schema_version: "ATIF-v1.7", session_id: "s", steps: [] }],
      ["braintrust", braintrustRows[0]],
      ["braintrust", { events: braintrustRows, cursor: "next" }],
      ["braintrust", { data: braintrustRows, schema: { type: "object" } }],
    ];
    for (const [id, value] of fixtures)
      expect(importAdapters.filter((adapter) => adapter.detect(value)).map((a) => a.id)).toEqual([
        id,
      ]);
    expect(new Set(importAdapters.map((adapter) => adapter.id)).size).toBe(importAdapters.length);
    for (const adapter of importAdapters) expect(adapter.id).toMatch(/^[a-z0-9_]+$/);
  });
});

describe("identity", () => {
  test("reads the owner as Hue does: roots first, then the agent's other spans, never a tool's", async () => {
    const root = await scratch();
    const ids = ["01", "02", "03", "04", "05", "06", "07", "08"].map(traceIds);
    const r = spanIds("aa");
    const c = spanIds("bb");
    const g = spanIds("cc");
    await writeFiles(root, {
      // A user on a child span under an HTTP root that names none.
      "child.json": JSON.stringify(
        otlp([
          otlpSpan(ids[0]!, r, undefined, "POST /chat"),
          otlpSpan(ids[0]!, c, r, "invoke_agent", {
            "gen_ai.operation.name": "invoke_agent",
            "user.id": "user-child",
          }),
        ]),
      ),
      // A user in metadata maps: a JSON object recorded whole, and a flattened JSON-quoted value.
      "metadata.json": JSON.stringify(
        otlp([otlpSpan(ids[1]!, r, undefined, "agent", { metadata: '{"user_id":"user-meta"}' })]),
      ),
      "quoted.json": JSON.stringify(
        otlp([
          otlpSpan(ids[2]!, r, undefined, "agent", {
            "langfuse.trace.metadata.userId": '"user-quoted"',
          }),
        ]),
      ),
      // Claude Code: user.id beside user.account_uuid names an installation; enduser.id is read.
      "claude.json": JSON.stringify(
        otlp([
          otlpSpan(ids[3]!, r, undefined, "claude_code.interaction", {
            "user.id": "installation-hash",
            "user.account_uuid": "account-1",
            "enduser.id": "customer-5",
          }),
        ]),
      ),
      "claude-only.json": JSON.stringify(
        otlp([
          otlpSpan(ids[4]!, r, undefined, "claude_code.interaction", {
            "user.id": "installation-hash",
            "user.account_uuid": "account-1",
          }),
        ]),
      ),
      // A user on a tool span, and beneath it, is not the owner.
      "tool.json": JSON.stringify(
        otlp([
          otlpSpan(ids[5]!, r, undefined, "agent"),
          otlpSpan(ids[5]!, c, r, "execute_tool send_email", {
            "gen_ai.operation.name": "execute_tool",
            "user.id": "recipient",
          }),
          otlpSpan(ids[5]!, g, c, "http", { "enduser.id": "recipient" }),
        ]),
      ),
      // A user on the resource alone; and two agent spans that disagree.
      "resource.json": JSON.stringify(
        otlp([otlpSpan(ids[6]!, r, undefined, "agent")], { "user.id": "user-resource" }),
      ),
      "ambiguous.json": JSON.stringify(
        otlp([
          otlpSpan(ids[7]!, r, undefined, "agent"),
          otlpSpan(ids[7]!, c, r, "step", { "user.id": "user-a" }),
          otlpSpan(ids[7]!, g, r, "step", { "user.id": "user-b" }),
        ]),
      ),
    });
    const { code, report } = await prepare(root);
    expect(code).toBe(0);
    const { manifest } = await bundle(report.output_directory);
    const owner = (traceId: string) =>
      manifest.traces.find((t) => t.trace_id === traceId)!.identity;
    expect(owner(ids[0]!)).toEqual({ user: "user-child" });
    expect(owner(ids[1]!)).toEqual({ user: "user-meta" });
    expect(owner(ids[2]!)).toEqual({ user: "user-quoted" });
    expect(owner(ids[3]!)).toEqual({ user: "customer-5" });
    expect(owner(ids[4]!)).toBeUndefined();
    expect(owner(ids[5]!)).toBeUndefined();
    expect(owner(ids[6]!)).toEqual({ user: "user-resource" });
    expect(owner(ids[7]!)).toBeUndefined();
    expect(report.traces.without_identity).toBe(3);
  });

  test("declares the conversation Hue's trace list shows, never one a tool names", async () => {
    const root = await scratch();
    const ids = ["11", "12", "13", "14", "15", "16", "17"].map(traceIds);
    const [a, b, c] = ["a1", "b2", "c3"].map(spanIds);
    const outside = spanIds("ff");
    const at = (span: ReturnType<typeof otlpSpan>, millis: number, nanos = 0) => ({
      ...span,
      startTimeUnixNano: String(
        1_760_000_000_000_000_000n + BigInt(millis) * 1_000_000n + BigInt(nanos),
      ),
    });
    const tool = { "gen_ai.operation.name": "execute_tool" };
    const agentOperation = { "gen_ai.operation.name": "invoke_agent" };
    const files = {
      // A tool span, or a span beneath one, names a conversation the agent's spans do not.
      "tool.json": otlp([
        at(otlpSpan(ids[0]!, a, undefined, "agent", { "app.thread": "keyed" }), 0),
        at(otlpSpan(ids[0]!, b, a, "execute_tool lookup", { ...tool, "session.id": "tool" }), 1),
      ]),
      "beneath.json": otlp([
        at(otlpSpan(ids[1]!, a, undefined, "agent"), 0),
        at(otlpSpan(ids[1]!, b, a, "execute_tool lookup", tool), 1),
        at(otlpSpan(ids[1]!, c, b, "GET /orders", { "session.id": "tool" }), 2),
      ]),
      // The span with no parent is the execution root, though a span whose parent is outside
      // the trace started earlier.
      "parentless.json": otlp([
        at(otlpSpan(ids[2]!, a, undefined, "agent", { "session.id": "root" }), 2),
        at(otlpSpan(ids[2]!, b, outside, "agent", { "session.id": "orphan" }), 1),
      ]),
      // Two roots in one millisecond: the lower span id is the earlier.
      "tie.json": otlp([
        at(otlpSpan(ids[3]!, a, undefined, "a", { "session.id": "first" }), 0, 900),
        at(otlpSpan(ids[3]!, b, undefined, "b", { "session.id": "second" }), 0, 100),
      ]),
      // A lone span whose parent is outside the trace is the root when it runs an agent;
      // otherwise the earliest span that names a conversation names it.
      "agent.json": otlp([
        at(otlpSpan(ids[4]!, a, outside, "agent", { ...agentOperation, "session.id": "run" }), 2),
        at(otlpSpan(ids[4]!, b, a, "step", { "session.id": "step" }), 1),
      ]),
      "request.json": otlp([
        at(otlpSpan(ids[5]!, a, outside, "POST /chat", { "session.id": "request" }), 2),
        at(otlpSpan(ids[5]!, b, a, "step", { "session.id": "step" }), 1),
      ]),
      // Hue keeps an id longer than the manifest holds: the manifest names none, not another.
      "long.json": otlp([
        at(
          otlpSpan(ids[6]!, a, undefined, "agent", {
            "session.id": "s".repeat(3_000),
            "app.thread": "keyed",
          }),
          0,
        ),
        at(otlpSpan(ids[6]!, b, a, "step", { "session.id": "step" }), 1),
      ]),
    };
    await writeFiles(
      root,
      Object.fromEntries(
        Object.entries(files).map(([name, value]) => [name, JSON.stringify(value)]),
      ),
    );
    const declared = async (...flags: string[]) => {
      const { code, report } = await prepare(root, ...flags);
      expect(code).toBe(0);
      const { manifest } = await bundle(report.output_directory);
      return ids.map((traceId) => manifest.traces.find((t) => t.trace_id === traceId)!);
    };
    expect((await declared()).map((trace) => trace.identity?.session)).toEqual([
      undefined,
      undefined,
      "root",
      "first",
      "run",
      "step",
      undefined,
    ]);
    // --session-key names the conversation of a trace whose agent spans name none, and keeps
    // the one they name, however long.
    const keyed = await declared("--session-key", "app.thread");
    expect(keyed[0]!.identity).toEqual({ session: "keyed" });
    expect(keyed[0]!.span_count).toBe(3);
    expect(keyed[6]!.identity).toBeUndefined();
    expect(keyed[6]!.span_count).toBe(2);
  });

  test("--user-key adds a hue.import.user span to an OTLP trace and leaves its spans unchanged", async () => {
    const root = await scratch();
    const traceId = traceIds("5e");
    const input = join(root, "export.json");
    await writeFile(
      input,
      JSON.stringify(
        otlp([
          otlpSpan(traceId, spanIds("a1"), undefined, "agent", {
            "app.customer_id": "customer-9",
            "app.thread": "thread-4",
          }),
          otlpSpan(traceId, spanIds("b2"), spanIds("a1"), "lookup", {
            "gen_ai.tool.name": "lookup",
            "app.customer_id": "other",
          }),
        ]),
      ),
    );
    const plain = await prepare(input, "--out", join(root, "plain"));
    const keyed = await prepare(
      input,
      "--out",
      join(root, "keyed"),
      "--user-key",
      "app.customer_id",
      "--session-key",
      "$.attributes[1].value.stringValue",
    );
    expect(plain.code).toBe(0);
    expect(keyed.code).toBe(0);
    expect(plain.report.traces.without_identity).toBe(1);
    expect(keyed.report.traces.without_identity).toBe(0);
    const before = await (await bundle(plain.report.output_directory)).spans(traceId);
    const after = await bundle(keyed.report.output_directory);
    const spans = await after.spans(traceId);
    expect(after.manifest.traces[0]!.identity).toEqual({ user: "customer-9", session: "thread-4" });
    expect(after.manifest.traces[0]!.span_count).toBe(4);
    // The recorded spans are byte for byte what they were.
    for (const span of before)
      expect(JSON.stringify(spans.find((item) => item.spanId === span.spanId))).toBe(
        JSON.stringify(span),
      );
    const user = spans.find((span) => span.name === "hue.import.user")!;
    expect(user.parentSpanId).toBe(spanIds("a1"));
    expect(user.attributes).toEqual([{ key: "user.id", value: { stringValue: "customer-9" } }]);
    expect(user.startTimeUnixNano).toBe("1760000000000000000");
    const session = spans.find((span) => span.name === "hue.import.session")!;
    expect(session.attributes).toEqual([
      { key: "gen_ai.conversation.id", value: { stringValue: "thread-4" } },
    ]);

    const refused = await runTracesCommand(["import", "prepare", input, "--user-key", "$.a..b"], {
      stdout: new Writable({ write: (_c, _e, done) => done() }),
      stderr: new Writable({ write: (_c, _e, done) => done() }),
    });
    expect(refused).toBe(2);
  });
});

describe("message conversion", () => {
  test("reads the common chat shapes as GenAI message parts", () => {
    expect(
      genAiMessages([
        { role: "user", content: [{ type: "text", text: "Weather in Paris?" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Look it up." },
            { type: "tool_use", id: "toolu_1", name: "weather", input: { city: "Paris" } },
          ],
          stop_reason: "tool_use",
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "18C" }],
        },
      ]),
    ).toEqual([
      { role: "user", parts: [{ type: "text", content: "Weather in Paris?" }] },
      {
        role: "assistant",
        parts: [
          { type: "reasoning", content: "Look it up." },
          { type: "tool_call", id: "toolu_1", name: "weather", arguments: { city: "Paris" } },
        ],
        finish_reason: "tool_use",
      },
      { role: "user", parts: [{ type: "tool_call_response", id: "toolu_1", response: "18C" }] },
    ]);
    expect(
      genAiMessages([
        [
          {
            lc: 1,
            type: "constructor",
            id: ["langchain", "schema", "messages", "HumanMessage"],
            kwargs: { content: "Hi" },
          },
          { type: "ai", content: "", tool_calls: [{ id: "c1", name: "search", args: { q: "x" } }] },
          { type: "tool", content: "found", tool_call_id: "c1" },
        ],
      ]),
    ).toEqual([
      { role: "user", parts: [{ type: "text", content: "Hi" }] },
      {
        role: "assistant",
        parts: [{ type: "tool_call", id: "c1", name: "search", arguments: { q: "x" } }],
      },
      { role: "tool", parts: [{ type: "tool_call_response", id: "c1", response: "found" }] },
    ]);
    expect(
      genAiMessages({
        generations: [[{ text: "Done.", message: { type: "ai", content: "Done." } }]],
      }),
    ).toEqual([{ role: "assistant", parts: [{ type: "text", content: "Done." }] }]);
    expect(genAiMessages("Hello", "user")).toEqual([
      { role: "user", parts: [{ type: "text", content: "Hello" }] },
    ]);
    expect(genAiMessages("Hello")).toBeUndefined();
    expect(genAiMessages({ question: "refund?" })).toBeUndefined();
    expect(
      genAiMessages([
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBO" } }],
        },
      ]),
    ).toEqual([
      {
        role: "user",
        parts: [{ type: "blob", modality: "image", mime_type: "image/png", content: "iVBO" }],
      },
    ]);
  });
});

describe("the row emitter", () => {
  const row = (spanKey: string, fields: Partial<SpanRow> = {}): SpanRow => ({
    traceKey: "trace-untimed",
    spanKey,
    name: spanKey,
    record: { id: spanKey },
    ...fields,
  });
  const emit = (rows: SpanRow[]) => {
    const collector = new RowTraceCollector("synthetic");
    for (const item of rows) collector.add(item, "d".repeat(64));
    return collector.finish();
  };
  const times = (entries: { scopeSpans: { spans: Record<string, unknown>[] }[] }[]) =>
    Object.fromEntries(
      entries.map((entry) => {
        const span = entry.scopeSpans[0]!.spans[0]!;
        const timing = (span.attributes as { key: string; value: { stringValue?: string } }[]).find(
          (item) => item.key === "hue.import.timing",
        )?.value.stringValue;
        return [span.name, [span.startTimeUnixNano, span.endTimeUnixNano, timing]];
      }),
    );

  test("fills instants a source did not record by its documented rules and names them", () => {
    const untimed = emit([
      row("root", { sequence: 0 }),
      row("reply", { parentKey: "root", sequence: 1 }),
    ]);
    expect(untimed.traces[0]!.inferredTiming).toEqual([
      "end_at_start",
      "end_from_children",
      "untimed_trace",
    ]);
    expect(times(untimed.traces[0]!.entries)).toEqual({
      root: ["946684800000000000", "946684800001000000", "untimed_trace; end_from_children"],
      reply: ["946684800001000000", "946684800001000000", "untimed_trace; end_at_start"],
    });
    const partial = emit([
      row("root", { start: 1_000n, end: 9_000n }),
      row("child", { parentKey: "root" }),
      row("late", { parentKey: "root", end: 5_000n }),
    ]);
    expect(times(partial.traces[0]!.entries)).toEqual({
      root: ["1000", "9000", undefined],
      child: ["1000", "1000", "start_from_parent; end_at_start"],
      late: ["5000", "5000", "start_at_end"],
    });
    const backwards = emit([row("root", { start: 9_000n, end: 1_000n })]);
    expect(backwards.traces).toEqual([]);
    expect(backwards.refused[0]!.reason).toBe("span root ends before it starts");
  });

  test("keeps the latest revision of a row exported twice and refuses copies that disagree", () => {
    const kept = emit([
      row("root", { start: 1_000n, revision: "10", record: { v: 1 }, name: "old" }),
      row("root", { start: 1_000n, revision: "9", record: { v: 0 }, name: "older" }),
      row("root", { start: 1_000n, revision: "11", record: { v: 2 }, name: "new" }),
    ]);
    expect(kept.traces[0]!.entries[0]!.scopeSpans[0]!.spans[0]!.name).toBe("new");
    const conflict = emit([
      row("root", { start: 1_000n, record: { v: 1 } }),
      row("root", { start: 1_000n, record: { v: 2 } }),
    ]);
    expect(conflict.refused[0]!.reason).toBe("span root appears with different content");
  });
});

describe("Braintrust", () => {
  test("reads a UI download, a fetch answer, a query answer and JSON Lines to the same spans", async () => {
    const root = await scratch();
    const shapes: Record<string, string> = {
      "download.json": JSON.stringify(braintrustRows),
      "fetch.json": JSON.stringify({ events: braintrustRows, cursor: "c-2" }),
      "query.json": JSON.stringify({ data: braintrustRows, schema: { type: "object" } }),
      "sync.jsonl": braintrustRows.map((item) => JSON.stringify(item)).join("\n"),
    };
    const reports: Record<string, any>[] = [];
    for (const [name, text] of Object.entries(shapes)) {
      await writeFile(join(root, name), text);
      const { code, report } = await prepare(join(root, name));
      expect(code).toBe(0);
      reports.push(report);
    }
    const batches = async (report: Record<string, any>) =>
      (await bundle(report.output_directory)).manifest.traces.map((trace) => trace.batches);
    for (const report of reports.slice(1))
      expect(await batches(report)).toEqual(await batches(reports[0]!));

    const report = reports[0]!;
    expect(report.formats).toEqual({ braintrust: 1 });
    expect(report.source.formats).toEqual(["otlp_json"]);
    expect(report.totals).toMatchObject({ traces: 1, spans: 3 });
    expect(report.traces.without_identity).toBe(0);
    expect(report.traces.remapped).toEqual({ traces: 0, spans: 0 });
    expect(report.traces.timing).toEqual({});
    expect(report.traces.by_origin).toMatchObject({ unknown: 1 });
    const { manifest, spans } = await bundle(report.output_directory);
    expect(manifest.traces[0]!.trace_id).toBe(BT_TRACE);
    expect(manifest.traces[0]!.identity).toEqual({ user: "user-42", session: "conversation-7" });
    const [agent, llm, tool] = await spans(BT_TRACE);
    expect([agent!.spanId, llm!.spanId, tool!.spanId]).toEqual([BT_ROOT, BT_LLM, BT_TOOL]);
    expect(agent!.parentSpanId).toBeUndefined();
    expect(llm!.parentSpanId).toBe(BT_ROOT);
    expect(tool!.parentSpanId).toBe(BT_ROOT);
    expect(agent!.startTimeUnixNano).toBe("1792504991402000000");
    expect(agent!.endTimeUnixNano).toBe("1792505003877000000");
    expect(agent!.scope).toBe("hue.import.braintrust");

    // The end user and conversation on the root; the content raw, as it is no chat.
    expect(str(agent!, "user.id")).toBe("user-42");
    expect(str(agent!, "gen_ai.conversation.id")).toBe("conversation-7");
    expect(str(agent!, "input.value")).toBe("Where is order 12?");
    expect(str(agent!, "input.mime_type")).toBe("text/plain");
    expect(attr(agent!, "gen_ai.operation.name")).toBeUndefined();
    expect(attr(agent!, "braintrust.tags")).toEqual({
      arrayValue: { values: [{ stringValue: "beta" }] },
    });
    expect(json(agent!, "hue.import.source_record")).toEqual(braintrustRows[0]);
    expect(str(agent!, "hue.import.format")).toBe("braintrust");

    // The model call under the GenAI conventions, its log row as an event.
    expect(str(llm!, "gen_ai.operation.name")).toBe("chat");
    expect(str(llm!, "gen_ai.request.model")).toBe("gpt-5");
    expect(str(llm!, "gen_ai.provider.name")).toBe("openai");
    expect(json(llm!, "gen_ai.input.messages")).toEqual([
      { role: "system", parts: [{ type: "text", content: "You help with orders." }] },
      { role: "user", parts: [{ type: "text", content: "Where is order 12?" }] },
    ]);
    expect(json(llm!, "gen_ai.output.messages")).toEqual([
      {
        role: "assistant",
        parts: [{ type: "tool_call", id: "call_1", name: "lookup_order", arguments: { id: 12 } }],
        finish_reason: "tool_calls",
      },
    ]);
    expect(attr(llm!, "gen_ai.usage.input_tokens")).toEqual({ intValue: "1834" });
    expect(attr(llm!, "gen_ai.usage.output_tokens")).toEqual({ intValue: "96" });
    expect(attr(llm!, "gen_ai.usage.cache_read.input_tokens")).toEqual({ intValue: "1024" });
    expect(attr(llm!, "user.id")).toBeUndefined();
    expect(llm!.events?.map((event) => [event.name, event.timeUnixNano])).toEqual([
      ["gen_ai.choice", "1792504995200000000"],
    ]);

    // The tool call; the account its record names is not the trace's user.
    expect(str(tool!, "gen_ai.operation.name")).toBe("execute_tool");
    expect(str(tool!, "gen_ai.tool.name")).toBe("lookup_order");
    expect(str(tool!, "gen_ai.tool.call.id")).toBe("call_1");
    expect(json(tool!, "gen_ai.tool.call.arguments")).toEqual({ id: 12 });
    expect(json(tool!, "gen_ai.tool.call.result")).toEqual({ status: "shipped", eta: "tomorrow" });
    expect(attr(tool!, "user.id")).toBeUndefined();
  });

  test("reads Mastra, OpenAI Agents and experiment rows, and refuses only a malformed row's trace", async () => {
    const root = await scratch();
    const mastraTrace = "a".repeat(31) + "1";
    const agentsTrace = `trace_${"b".repeat(32)}`;
    const experimentTrace = "6c84fb90-12c4-11e1-840d-7b25c5ee775a";
    const broken = "c".repeat(31) + "2";
    const base = { created: "2026-10-20T12:40:00.000Z", project_id: "project-synthetic" };
    const rows = [
      {
        ...base,
        id: "m1",
        span_id: "1".repeat(16),
        root_span_id: mastraTrace,
        span_parents: [],
        span_attributes: { name: "agent run: 'assistant'", type: "task" },
        input: "Summarize my inbox.",
        metadata: { spanType: "agent_run", resourceId: "owner-1", threadId: "thread-9" },
        metrics: { start: 1792500000, end: 1792500010 },
      },
      {
        ...base,
        id: "m2",
        span_id: "2".repeat(16),
        root_span_id: mastraTrace,
        span_parents: ["1".repeat(16)],
        span_attributes: { name: "mcp tool: 'search_threads'", type: "tool" },
        input: [
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_9",
                type: "function",
                function: { name: "search_threads", arguments: '{"query":"is:unread"}' },
              },
            ],
          },
        ],
        output: { role: "tool", content: '{"threads":[]}', tool_call_id: "call_9" },
        metadata: { spanType: "mcp_tool_call", resourceId: "owner-1" },
        metrics: { start: 1792500001, end: 1792500002 },
      },
      // An OpenAI Agents trace: its ids are no OpenTelemetry ids, its conversation is group_id;
      // its child has no metrics.start and starts at `created`.
      {
        ...base,
        id: "a1",
        span_id: agentsTrace,
        root_span_id: agentsTrace,
        span_parents: [],
        span_attributes: { name: "Agent workflow", type: "task" },
        metadata: { group_id: "thread-3" },
        metrics: { start: 1792500100, end: 1792500105 },
      },
      {
        ...base,
        id: "a2",
        span_id: "span_0123456789abcdef01234567",
        root_span_id: agentsTrace,
        span_parents: ["span_missing_parent"],
        span_attributes: { name: "Triage", type: "task" },
        created: "2026-10-20T12:41:41.500Z",
      },
      // An experiment's row: evaluation traffic, with legacy UUID ids.
      {
        ...base,
        id: experimentTrace,
        span_id: experimentTrace,
        root_span_id: experimentTrace,
        span_parents: [],
        experiment_id: "experiment-synthetic",
        span_attributes: { name: "eval", type: "eval" },
        input: { question: "2+2" },
        expected: "4",
        scores: { exact: 1 },
        metadata: { user_id: "dataset-user" },
        metrics: { start: 1792500200, end: 1792500201 },
      },
      // A malformed row refuses its own trace and nothing else.
      {
        ...base,
        id: "x1",
        span_id: "3".repeat(16),
        root_span_id: broken,
        span_parents: [],
        metrics: { start: 1792500300 },
      },
      {
        ...base,
        id: "x2",
        span_id: "4".repeat(16),
        root_span_id: broken,
        span_parents: ["3".repeat(16)],
        metrics: "soon",
      },
    ];
    const input = join(root, "rows.jsonl");
    await writeFile(input, rows.map((item) => JSON.stringify(item)).join("\n"));
    const { code, report } = await prepare(input);
    expect(code).toBe(0);
    expect(report.totals.traces).toBe(3);
    expect(report.traces.refused).toEqual([
      { file: "rows.jsonl", line: 7, trace_id: broken, reason: "metrics is not an object" },
    ]);
    expect(report.traces.by_origin).toMatchObject({ evaluation: 1, unknown: 2 });
    expect(report.traces.timing).toEqual({ end_at_start: 1, start_from_created: 1 });
    const { manifest, spans } = await bundle(report.output_directory);
    const traceOf = (id: string) => manifest.traces.find((trace) => trace.trace_id === id)!;

    expect(traceOf(mastraTrace).identity).toEqual({ user: "owner-1", session: "thread-9" });
    const [run, search] = await spans(mastraTrace);
    expect(str(run!, "gen_ai.operation.name")).toBe("invoke_agent");
    expect(json(run!, "gen_ai.input.messages")).toEqual([
      { role: "user", parts: [{ type: "text", content: "Summarize my inbox." }] },
    ]);
    expect(str(search!, "gen_ai.tool.name")).toBe("search_threads");
    expect(str(search!, "gen_ai.tool.call.id")).toBe("call_9");
    expect(json(search!, "gen_ai.tool.call.arguments")).toEqual({ query: "is:unread" });
    expect(json(search!, "gen_ai.tool.call.result")).toBe('{"threads":[]}');

    const agentsId = sha256(`braintrust.trace:${agentsTrace}`).slice(0, 32);
    expect(traceOf(agentsId).identity).toEqual({ session: "thread-3" });
    const agentSpans = await spans(agentsId);
    expect(agentSpans.map((span) => str(span, "hue.import.original_span_id"))).toEqual([
      agentsTrace,
      "span_0123456789abcdef01234567",
    ]);
    expect(str(agentSpans[0]!, "hue.import.original_trace_id")).toBe(agentsTrace);
    // A parent the export does not hold leaves the span a root, the original kept.
    expect(agentSpans[1]!.parentSpanId).toBeUndefined();
    expect(str(agentSpans[1]!, "hue.import.original_parent_span_id")).toBe("span_missing_parent");
    expect(agentSpans[1]!.startTimeUnixNano).toBe("1792500101500000000");
    expect(str(agentSpans[1]!, "hue.import.timing")).toBe("start_from_created; end_at_start");

    const experiment = traceOf(sha256(`braintrust.trace:${experimentTrace}`).slice(0, 32));
    expect(experiment.origin).toBe("evaluation");
  });

  test("--user-key reads a custom key of each row and names the user on the root", async () => {
    const root = await scratch();
    const input = join(root, "rows.json");
    const rows = braintrustRows.slice(0, 3).map((item, index) => ({
      ...item,
      metadata: index === 0 ? { customer: { id: "customer-77" } } : item.metadata,
    }));
    await writeFile(input, JSON.stringify(rows));
    const { code, report } = await prepare(input, "--user-key", "$.metadata.customer.id");
    expect(code).toBe(0);
    const { manifest, spans } = await bundle(report.output_directory);
    expect(manifest.traces[0]!.identity).toEqual({ user: "customer-77" });
    expect(str((await spans(BT_TRACE))[0]!, "user.id")).toBe("customer-77");
  });

  test("reads online scoring inside a production trace as Braintrust's, never the agent's", async () => {
    // A scorer span under the production root holds the judge's own model call and a user.
    const scorer = {
      ...container,
      id: "e1f2a3b4c5d6e7f8",
      span_id: "e1f2a3b4c5d6e7f8",
      root_span_id: BT_TRACE,
      span_parents: [BT_ROOT],
      span_attributes: { name: "Factuality", type: "score", purpose: "scorer" },
      input: { output: "Order 12 ships tomorrow." },
      output: { score: 1 },
      metadata: { user_id: "scorer-user" },
      metrics: { start: 1792505004.1, end: 1792505005.2 },
    };
    const judge = {
      ...braintrustRows[1]!,
      id: "f2a3b4c5d6e7f809",
      span_id: "f2a3b4c5d6e7f809",
      span_parents: [scorer.span_id],
      span_attributes: { name: "judge", type: "llm" },
      metadata: { model: "gpt-5", user_id: "judge-user" },
      metrics: { start: 1792505004.2, end: 1792505005.1, prompt_tokens: 300 },
    };
    const root = await scratch();
    await writeFiles(root, {
      "rows.jsonl": [{ ...braintrustRows[0]!, metadata: {} }, braintrustRows[1], scorer, judge]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    });
    const { code, report } = await prepare(root);
    expect(code).toBe(0);
    const { manifest, spans } = await bundle(report.output_directory);
    // Neither the scorer's nor its judge's user owns the trace, and it stays production traffic.
    expect(manifest.traces[0]!.identity).toBeUndefined();
    expect(manifest.traces[0]!.origin).toBe("unknown");
    const emitted = await spans(BT_TRACE);
    const call = emitted.find((span) => span.name === "judge")!;
    for (const key of [
      "gen_ai.operation.name",
      "gen_ai.request.model",
      "gen_ai.input.messages",
      "gen_ai.usage.input_tokens",
      "braintrust.metadata",
    ])
      expect(attr(call, key)).toBeUndefined();
    expect(json(call, "input.value")).toEqual((judge as Record<string, unknown>).input);
    expect(str(call, "braintrust.span_attributes")).toContain('"type":"llm"');
    // The agent's own model call is read as one.
    const agentCall = emitted.find((span) => span.name === "Chat Completion")!;
    expect(str(agentCall, "gen_ai.operation.name")).toBe("chat");
  });

  test("reads dataset records as evaluation traffic and metadata users as Hue reads them", async () => {
    const row = (spanId: string, fields: Record<string, unknown>) => ({
      ...container,
      id: spanId,
      span_id: spanId,
      root_span_id: spanId,
      span_parents: [],
      span_attributes: { name: "task", type: "task" },
      input: "Where is order 12?",
      metrics: { start: 1792504991.402, end: 1792504992.402 },
      ...fields,
    });
    const traces = ["a1", "b2", "c3"].map((seed) => spanIds(seed));
    const root = await scratch();
    await writeFiles(root, {
      "rows.jsonl": [
        // A dataset record (`bt sync pull dataset:…`): test data, never a user's history.
        row(traces[0]!, {
          dataset_id: "0c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
          expected: "Tomorrow",
          metadata: { user_id: "dataset-user" },
        }),
        // A metadata map's `userId` before its `user_id`, as Hue reads `braintrust.metadata`.
        row(traces[1]!, { metadata: { userId: "camel", user_id: "snake" } }),
        // A Claude Code span ingested by Braintrust: `user.id` beside `user.account_uuid` names
        // an installation, so `enduser.id` is read.
        row(traces[2]!, {
          metadata: {
            "user.id": "installation-1",
            "user.account_uuid": "account-1",
            "enduser.id": "customer-5",
          },
        }),
      ]
        .map((item) => JSON.stringify(item))
        .join("\n"),
    });
    const { code, report } = await prepare(root);
    expect(code).toBe(0);
    const { manifest } = await bundle(report.output_directory);
    const traceOf = (spanId: string) =>
      manifest.traces.find(
        (trace) => trace.trace_id === sha256(`braintrust.trace:${spanId}`).slice(0, 32),
      )!;
    expect(traceOf(traces[0]!).origin).toBe("evaluation");
    expect(traceOf(traces[1]!).identity).toEqual({ user: "camel" });
    expect(traceOf(traces[2]!).identity).toEqual({ user: "customer-5" });
  });
});
