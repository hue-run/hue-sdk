import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import * as zlib from "node:zlib";
import { runTracesCommand } from "../src/cli/traces-import.js";
import type { TraceImportManifest } from "../src/cli/traces-import-convert.js";
import { importAdapters } from "../src/cli/import-formats/registry.js";

// Synthetic Langfuse exports (tests/fixtures/langfuse-exports.json), one per shape Langfuse
// writes: the public API (v1 trace, trace and observation pages, v2 observations), UI downloads
// and blob storage files. Nothing leaves the machine.

type Records = Record<string, any>;
const fixture = JSON.parse(
  await readFile(new URL("./fixtures/langfuse-exports.json", import.meta.url), "utf8"),
) as Records;
const copy = <T>(value: T): T => structuredClone(value);
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const traceIdOf = (langfuseId: string) =>
  /^[0-9a-f]{32}$/.test(langfuseId)
    ? langfuseId
    : sha256(`langfuse.trace:${langfuseId}`).slice(0, 32);
const nanos = (iso: string) => String(BigInt(Date.parse(iso)) * 1_000_000n);

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function bundleOf(files: Record<string, string | Uint8Array>, ...flags: string[]) {
  const root = await mkdtemp(join(tmpdir(), "hue-langfuse-"));
  directories.push(root);
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(join(root, "in", name, ".."), { recursive: true });
    await writeFile(join(root, "in", name), bytes);
  }
  let stdout = "";
  let stderr = "";
  const sink = (append: (text: string) => void) =>
    new Writable({ write: (chunk, _encoding, done) => (append(String(chunk)), done()) });
  const code = await runTracesCommand(["import", "prepare", join(root, "in"), "--json", ...flags], {
    stdout: sink((text) => (stdout += text)),
    stderr: sink((text) => (stderr += text)),
  });
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const report = JSON.parse(stdout) as Records;
  const directory = report.output_directory as string;
  const manifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  ) as TraceImportManifest;
  const spans = async (traceId: string) => {
    const trace = manifest.traces.find((item) => item.trace_id === traceId);
    expect(trace).toBeDefined();
    const found: Span[] = [];
    for (const batch of trace!.batches) {
      const body = await readFile(join(directory, `${traceId}.${batch.sha256}.json.gz`));
      const decoded = JSON.parse(zlib.gunzipSync(body).toString("utf8")) as Records;
      for (const group of decoded.resourceSpans)
        for (const scope of group.scopeSpans)
          for (const span of scope.spans)
            found.push({
              ...span,
              resource: Object.fromEntries(
                group.resource.attributes.map((item: Records) => [
                  item.key,
                  item.value.stringValue,
                ]),
              ),
              scope: scope.scope.name,
            });
    }
    return found;
  };
  const identity = (traceId: string) =>
    manifest.traces.find((item) => item.trace_id === traceId)?.identity;
  return { report, manifest, spans, identity };
}

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: Records }[];
  status: { code: number; message?: string };
  resource: Record<string, string>;
  scope: string;
}

const attr = (span: Span, key: string) => span.attributes.find((item) => item.key === key)?.value;
const str = (span: Span, key: string) => attr(span, key)?.stringValue as string | undefined;
const int = (span: Span, key: string) => attr(span, key)?.intValue as string | undefined;
const json = (span: Span, key: string) => JSON.parse(str(span, key)!) as unknown;
const named = (spans: Span[], name: string) => spans.find((span) => span.name === name)!;

describe("Langfuse exports", () => {
  test("roots a v1 trace's observations under its own span, with its user and session", async () => {
    const trace = fixture.traceWithObservations;
    const { report, manifest, spans, identity } = await bundleOf({
      "trace.json": JSON.stringify(trace),
    });
    expect(report.formats).toEqual({ langfuse: 1 });
    expect(report.source.formats).toEqual(["otlp_json"]);
    expect(report.traces.refused).toEqual([]);
    const traceId = traceIdOf(trace.id);
    expect(manifest.traces[0]!.trace_id).toBe(traceId);
    expect(manifest.traces[0]!.origin).toBe("production");
    expect(identity(traceId)).toEqual({ user: "user-ada", session: "session-ada-1" });

    const all = await spans(traceId);
    expect(all.map((span) => span.name)).toEqual(["support-chat", "draft-reply", "lookup_refund"]);
    const [root, generation, tool] = all as [Span, Span, Span];
    // Two top-level observations, the pre-OpenTelemetry pattern, both under the trace's span.
    expect(root.parentSpanId).toBeUndefined();
    expect(generation.parentSpanId).toBe(root.spanId);
    expect(tool.parentSpanId).toBe(root.spanId);
    expect(str(root, "hue.import.original_span_id")).toBe(`t-${trace.id}`);
    expect(str(root, "hue.import.original_trace_id")).toBe(trace.id);
    expect(str(root, "user.id")).toBe("user-ada");
    expect(str(root, "gen_ai.conversation.id")).toBe("session-ada-1");
    expect(str(root, "langfuse.trace.name")).toBe("support-chat");
    expect(attr(root, "langfuse.trace.tags")).toEqual({
      arrayValue: { values: [{ stringValue: "support" }, { stringValue: "refunds" }] },
    });
    expect(str(root, "langfuse.release")).toBe("2026.03.1");
    expect(root.resource["deployment.environment.name"]).toBe("production");
    expect(root.startTimeUnixNano).toBe(nanos(trace.timestamp));
    expect(root.endTimeUnixNano).toBe(tool.endTimeUnixNano);
    expect(str(root, "hue.import.timing")).toBe("end_from_children");
    // The root keeps the trace record; each observation is its own span's record.
    const rootRecord = json(root, "hue.import.source_record") as Records;
    expect(rootRecord.observations).toBeUndefined();
    expect(rootRecord.htmlPath).toBe(trace.htmlPath);
    expect(json(generation, "hue.import.source_record")).toEqual(trace.observations[0]);

    expect(str(generation, "hue.import.format")).toBe("langfuse");
    expect(generation.scope).toBe("hue.import.langfuse");
    expect(str(generation, "gen_ai.operation.name")).toBe("chat");
    expect(str(generation, "gen_ai.request.model")).toBe("gpt-4o-mini");
    expect(json(generation, "gen_ai.input.messages")).toEqual([
      { role: "system", parts: [{ type: "text", content: "You answer billing questions." }] },
      {
        role: "user",
        parts: [{ type: "text", content: "Where is my refund for order A-1001?" }],
      },
    ]);
    expect(int(generation, "gen_ai.usage.input_tokens")).toBe("42");
    expect(int(generation, "gen_ai.usage.output_tokens")).toBe("17");
    expect(str(generation, "user.id")).toBeUndefined();
    expect(str(generation, "hue.import.original_span_id")).toBe(trace.observations[0].id);

    // A Python `@observe` tool's `{args: [], kwargs}` input is its keyword arguments.
    expect(str(tool, "gen_ai.operation.name")).toBe("execute_tool");
    expect(str(tool, "gen_ai.tool.name")).toBe("lookup_refund");
    expect(json(tool, "gen_ai.tool.call.arguments")).toEqual({ order_id: "A-1001" });
    expect(json(tool, "gen_ai.tool.call.result")).toEqual({
      status: "issued",
      issued_on: "2026-03-03",
    });

    // Trace objects gathered in a list page read the same.
    const listed = await bundleOf({ "traces.json": JSON.stringify({ data: [trace] }) });
    const shape = (spans: Span[]) =>
      spans.map(({ spanId, parentSpanId }) => [spanId, parentSpanId]);
    expect(shape(await listed.spans(traceId))).toEqual(shape(all));
  });

  test("joins v1 trace pages with observation pages in the same bundle, whatever their order", async () => {
    const files = {
      "a/traces-1.json": JSON.stringify(fixture.tracesPage),
      "b/observations-1.json": JSON.stringify(fixture.observationsPage),
    };
    const { report, spans, identity } = await bundleOf(files);
    const traceId = traceIdOf(fixture.tracesPage.data[0].id);
    expect(report.files.supported).toEqual([
      { file: "a/traces-1.json", format: "langfuse", traces: 1 },
      { file: "b/observations-1.json", format: "langfuse", traces: 1 },
    ]);
    // v1 observations carry no user: the trace page's user and session own the trace.
    expect(identity(traceId)).toEqual({ user: "user-grace", session: "session-grace-7" });
    const all = await spans(traceId);
    const root = named(all, "docs-question");
    expect(named(all, "retrieve-docs").parentSpanId).toBe(root.spanId);
    expect(str(named(all, "retrieve-docs"), "gen_ai.operation.name")).toBe("retrieval");
    expect(named(all, "answer").parentSpanId).toBe(root.spanId);

    const reversed = await bundleOf({
      "a/observations-1.json": files["b/observations-1.json"],
      "b/traces-1.json": files["a/traces-1.json"],
    });
    expect(reversed.report.manifest_digest).toBe(report.manifest_digest);
  });

  test("reads v2 observations: app roots, usage details, raw-string content and resource", async () => {
    const page = fixture.observationsV2Page;
    const { manifest, spans, identity } = await bundleOf({ "v2.json": JSON.stringify(page) });
    const traceId = page.data[0].traceId as string;
    expect(identity(traceId)).toEqual({ user: "user-lin", session: "thread-42" });
    // Langfuse's `default` environment names no deployment environment.
    expect(manifest.traces[0]!.origin).toBe("unknown");
    const all = await spans(traceId);
    const agent = named(all, "refund-agent");
    const generation = named(all, "plan-refund");
    const tool = named(all, "issue_refund");
    // The app root's parent was not exported: it is a root, its recorded parent kept.
    expect(agent.parentSpanId).toBeUndefined();
    expect(str(agent, "hue.import.original_parent_span_id")).toBe("aaaaaaaaaaaaaaaa");
    expect(agent.spanId).toBe("1f2e3d4c5b6a7980");
    expect(str(agent, "hue.import.original_span_id")).toBeUndefined();
    expect(str(agent, "gen_ai.operation.name")).toBe("invoke_agent");
    expect(str(agent, "user.id")).toBe("user-lin");
    expect(str(agent, "langfuse.trace.name")).toBe("refund-flow");
    expect(agent.resource).toEqual({ "service.name": "refund-agent" });
    expect(json(agent, "gen_ai.input.messages")).toEqual([
      {
        role: "user",
        parts: [{ type: "text", content: "Refund my order A-2002, it arrived broken." }],
      },
    ]);
    expect(generation.parentSpanId).toBe(agent.spanId);
    // Input and output as Langfuse totals them; cache reads and reasoning on their own.
    expect(int(generation, "gen_ai.usage.input_tokens")).toBe("100");
    expect(int(generation, "gen_ai.usage.cache_read.input_tokens")).toBe("20");
    expect(int(generation, "gen_ai.usage.output_tokens")).toBe("40");
    expect(int(generation, "gen_ai.usage.reasoning.output_tokens")).toBe("10");
    expect(json(generation, "gen_ai.output.messages")).toEqual([
      {
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            id: "call_7",
            name: "issue_refund",
            arguments: { order_id: "A-2002", amount: 25 },
          },
        ],
      },
    ]);
    expect(json(tool, "gen_ai.tool.call.arguments")).toEqual({ order_id: "A-2002", amount: 25 });
    expect(str(tool, "user.id")).toBeUndefined();
  });

  test("reads blob storage exports: gzip JSON Lines, snake_case columns, ClickHouse instants", async () => {
    const { report, spans, identity } = await bundleOf({
      "proj-demo/traces/2026-03-07.jsonl.gz": zlib.gzipSync(jsonl(fixture.blobTraces)),
      "proj-demo/observations/2026-03-07.jsonl.gz": zlib.gzipSync(jsonl(fixture.blobObservations)),
      "proj-demo/observations_v2/2026-03-08.json.gz": zlib.gzipSync(
        JSON.stringify(fixture.blobObservationsV2),
      ),
    });
    expect(report.formats).toEqual({ langfuse: 2 });
    expect(report.traces.refused).toEqual([]);

    // The legacy traces table names the user; its observations sit in another file.
    const legacy = traceIdOf(fixture.blobTraces[0].id);
    expect(identity(legacy)).toEqual({ user: "user-mo" });
    const legacySpans = await spans(legacy);
    const root = named(legacySpans, "nightly-summary");
    const summarize = named(legacySpans, "summarize");
    expect(summarize.parentSpanId).toBe(root.spanId);
    // A ClickHouse instant has no zone: it is UTC.
    expect(root.startTimeUnixNano).toBe(nanos("2026-03-07T08:00:00.000Z"));
    expect(summarize.startTimeUnixNano).toBe(nanos("2026-03-07T08:00:00.250Z"));
    // ClickHouse writes 64-bit counts as decimal text.
    expect(int(summarize, "gen_ai.usage.input_tokens")).toBe("50");
    expect(int(summarize, "gen_ai.usage.output_tokens")).toBe("12");
    expect(json(summarize, "gen_ai.output.messages")).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "Three incidents, all resolved." }] },
    ]);

    // Enriched observations carry the trace's user on every row; `""` is no parent.
    const enriched = fixture.blobObservationsV2[0].trace_id as string;
    expect(identity(enriched)).toEqual({ user: "user-kim", session: "chat-9" });
    const enrichedSpans = await spans(enriched);
    const agent = named(enrichedSpans, "order-agent");
    expect(agent.parentSpanId).toBeUndefined();
    expect(agent.startTimeUnixNano).toBe("1772971200123456000");
    expect(agent.endTimeUnixNano).toBe("1772971203654321000");
    expect(named(enrichedSpans, "get_order").parentSpanId).toBe(agent.spanId);
  });

  test("reads UI downloads of the traces, observations and events tables", async () => {
    const { report, spans, identity } = await bundleOf({
      "lf-traces-export.jsonl": jsonl(fixture.uiTraces),
      "lf-observations-export.json": JSON.stringify(fixture.uiObservations),
      "lf-events-export.jsonl": jsonl(fixture.uiEvents),
    });
    expect(report.formats).toEqual({ langfuse: 2 });
    const joined = traceIdOf(fixture.uiTraces[0].id);
    expect(identity(joined)).toEqual({ user: "user-noor", session: "inbox-3" });
    const all = await spans(joined);
    const root = named(all, "spam-check");
    const classify = named(all, "classify");
    expect(classify.parentSpanId).toBe(root.spanId);
    expect(classify.status).toEqual({ code: 2, message: "upstream timeout, retried" });
    expect(str(root, "input.value")).toBe("Is this message spam?");

    const events = fixture.uiEvents[0].traceId as string;
    expect(identity(events)).toEqual({ user: "user-ines" });
    const [translate] = await spans(events);
    expect(translate!.startTimeUnixNano).toBe("1773214200000250000");
    expect(str(translate!, "gen_ai.request.model")).toBe("gpt-4o-mini");
    expect(int(translate!, "gen_ai.usage.input_tokens")).toBe("30");
  });

  test("a malformed record refuses only its trace, and the rest of the page is read", async () => {
    const page = copy(fixture.observationsV2Page);
    const broken = { ...copy(page.data[1]), traceId: "deadbeefdeadbeefdeadbeefdeadbeef" };
    broken.startTime = "yesterday";
    page.data.push(broken, { note: "not a Langfuse record" });
    const { report, manifest } = await bundleOf({
      "v2.json": JSON.stringify(page),
      "events.jsonl": jsonl(fixture.uiEvents) + "{ cut off\n",
    });
    expect(manifest.traces.map((trace) => trace.trace_id).sort()).toEqual(
      [page.data[0].traceId, fixture.uiEvents[0].traceId].sort(),
    );
    expect(report.traces.refused).toEqual([
      {
        file: "v2.json",
        trace_id: "deadbeefdeadbeefdeadbeefdeadbeef",
        reason: "record 4: startTime is not a timestamp",
      },
      {
        file: "v2.json",
        reason: "record 5: a record that is neither a Langfuse trace nor an observation",
      },
    ]);
    expect(report.files.skipped).toEqual([
      { file: "events.jsonl", line: 2, reason: "truncated JSON" },
    ]);
  });

  test("never takes the owner from a tool observation", async () => {
    const page = copy(fixture.observationsV2Page);
    for (const observation of page.data) {
      observation.userId = observation.type === "TOOL" ? "account-acted-on" : null;
      observation.sessionId = null;
    }
    const { report, identity } = await bundleOf({ "v2.json": JSON.stringify(page) });
    expect(identity(page.data[0].traceId)).toBeUndefined();
    expect(report.traces.without_identity).toBe(1);
  });

  test("declares Langfuse experiment and evaluator traffic as evaluation", async () => {
    const page = copy(fixture.observationsV2Page);
    for (const observation of page.data) observation.environment = "sdk-experiment";
    const judge = copy(fixture.uiEvents[0]);
    judge.environment = "langfuse-llm-as-a-judge";
    const { report } = await bundleOf({
      "v2.json": JSON.stringify(page),
      "events.jsonl": jsonl([judge]),
    });
    expect(report.traces.by_origin).toEqual({
      production: 0,
      evaluation: 2,
      simulation: 0,
      unknown: 0,
    });
  });

  test("names a user recorded under a key of its own with --user-key", async () => {
    const page = copy(fixture.observationsPage);
    for (const observation of page.data) observation.metadata = { customer: { id: "c-9" } };
    const { identity } = await bundleOf(
      { "observations.json": JSON.stringify(page) },
      "--user-key",
      "customer.id",
    );
    expect(identity(traceIdOf(page.data[0].traceId))).toEqual({ user: "c-9" });
  });

  test("--user-key replaces the user a Langfuse trace names, on its root", async () => {
    const trace = copy(fixture.traceWithObservations);
    trace.userId = "own-user";
    trace.metadata = { customer: "key-user" };
    const { identity, spans } = await bundleOf(
      { "trace.json": JSON.stringify(trace) },
      "--user-key",
      "customer",
    );
    const traceId = traceIdOf(trace.id);
    expect(identity(traceId)).toMatchObject({ user: "key-user" });
    const emitted = await spans(traceId);
    expect(str(named(emitted, trace.name), "user.id")).toBe("key-user");
    expect(emitted.some((span) => span.name === "hue.import.user")).toBe(false);
  });

  test("reads an EVALUATOR and everything beneath it as Langfuse's evaluation, not the agent's", async () => {
    const trace = copy(fixture.traceWithObservations);
    trace.userId = null;
    const [generation] = trace.observations;
    const evaluator = {
      ...copy(generation),
      id: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
      type: "EVALUATOR",
      name: "helpfulness",
      model: null,
      metadata: { userId: "judge-user" },
    };
    const judge = {
      ...copy(generation),
      id: "d2e3f4a5-b6c7-4d8e-9fa0-1b2c3d4e5f60",
      parentObservationId: evaluator.id,
      name: "judge-call",
      userId: "judge-user",
      input: [{ role: "user", content: "Rate this reply from 1 to 5." }],
    };
    trace.observations.push(evaluator, judge);
    const { report, identity, spans } = await bundleOf({ "trace.json": JSON.stringify(trace) });
    const traceId = traceIdOf(trace.id);
    // The judge's user never owns the trace; nothing else names one.
    expect(identity(traceId)?.user).toBeUndefined();
    expect(report.traces.by_origin.evaluation).toBe(0);
    const emitted = await spans(traceId);
    const call = named(emitted, "judge-call");
    for (const key of [
      "gen_ai.operation.name",
      "gen_ai.request.model",
      "gen_ai.input.messages",
      "gen_ai.usage.input_tokens",
    ])
      expect(attr(call, key)).toBeUndefined();
    expect(json(call, "input.value")).toEqual(judge.input);
    expect(attr(named(emitted, "helpfulness"), "langfuse.observation.metadata")).toBeUndefined();
    // The agent's own model call keeps its GenAI attributes.
    expect(str(named(emitted, generation.name), "gen_ai.operation.name")).toBe("chat");
  });

  test("reads the documented list's experiment environments and unsafe integers per trace", async () => {
    const strip = ({ projectId: _projectId, ...observation }: Records) => observation;
    const [first, second] = fixture.observationsPage.data.map(strip);
    const experiment = { ...first, environment: "sdk-experiment", userId: "u-exp" };
    const big = { ...second, traceId: "trace-with-big-id", metadata: { message_id: "__BIG__" } };
    const text = JSON.stringify({ data: [experiment, big] }).replace(
      '"__BIG__"',
      "1234567890123456789",
    );
    const { report, manifest } = await bundleOf({ "observations.json": text });
    expect(report.formats).toEqual({ langfuse_observations: 1 });
    expect(manifest.traces).toHaveLength(1);
    expect(manifest.traces[0]).toMatchObject({ origin: "evaluation", identity: { user: "u-exp" } });
    // Only the trace whose observation holds the integer is refused; the page's others are read.
    expect(report.traces.refused).toEqual([
      { trace_id: traceIdOf("trace-with-big-id"), reason: "Source JSON contains an unsafe number" },
    ]);
  });

  test("leaves Hue's documented observation list to langfuse_observations", () => {
    const record = fixture.observationsPage.data[0];
    const { projectId: _projectId, ...documented } = record;
    const claims = (value: unknown) =>
      importAdapters.filter((adapter) => adapter.detect(value)).map((adapter) => adapter.id);
    expect(claims({ data: [documented] })).toEqual(["langfuse_observations"]);
    expect(claims({ traceId: record.traceId, observations: [documented] })).toEqual([
      "langfuse_observations",
    ]);
    // Langfuse's own answers, downloads and files.
    expect(claims(fixture.observationsPage)).toEqual(["langfuse"]);
    expect(claims(fixture.observationsV2Page)).toEqual(["langfuse"]);
    expect(claims(fixture.traceWithObservations)).toEqual(["langfuse"]);
    expect(claims(fixture.tracesPage)).toEqual(["langfuse"]);
    expect(claims({ id: "session-1", traces: fixture.tracesPage.data })).toEqual(["langfuse"]);
    for (const row of [
      fixture.blobTraces[0],
      fixture.blobObservations[0],
      fixture.blobObservationsV2[0],
      fixture.uiTraces[0],
      fixture.uiObservations[0],
      fixture.uiEvents[0],
    ])
      expect(claims(row)).toEqual(["langfuse"]);
    // One malformed observation no longer hides the rest of the page.
    expect(claims({ data: [documented, { ...documented, startTime: undefined }] })).toEqual([
      "langfuse",
    ]);
  });
});
