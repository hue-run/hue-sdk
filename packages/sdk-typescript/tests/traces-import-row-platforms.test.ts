import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import * as zlib from "node:zlib";
import { runTracesCommand } from "../src/cli/traces-import.js";
import type { TraceImportManifest } from "../src/cli/traces-import-convert.js";
import { importAdapters } from "../src/cli/import-formats/registry.js";

// Row-platform exports: LangSmith runs, MLflow traces, Opik traces and W&B Weave calls. The
// fixtures are synthetic records in each platform's verified shape (see
// fixtures/import-row-platforms/README.md); nothing leaves the machine.

const FIXTURES = join(import.meta.dir, "fixtures", "import-row-platforms");
const fixture = async (name: string) => readFile(join(FIXTURES, name), "utf8");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hue-row-platforms-"));
  directories.push(directory);
  return directory;
}

async function prepare(input: string, ...flags: string[]) {
  let stdout = "";
  const sink = (append: (text: string) => void) =>
    new Writable({ write: (chunk, _encoding, done) => (append(String(chunk)), done()) });
  const code = await runTracesCommand(["import", "prepare", input, "--json", ...flags], {
    stdout: sink((text) => (stdout += text)),
    stderr: sink(() => {}),
  });
  return { code, report: code === 0 ? (JSON.parse(stdout) as Record<string, any>) : {} };
}

/** Prepares `files` written to a scratch directory (or one file, when given one). */
async function prepareFiles(files: Record<string, string>, ...flags: string[]) {
  const root = await scratch();
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  const names = Object.keys(files);
  const { code, report } = await prepare(
    names.length === 1 ? join(root, names[0]!) : root,
    "--out",
    join(root, "out"),
    ...flags,
  );
  expect(code).toBe(0);
  return report;
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
  events?: { name: string; timeUnixNano: string; attributes: { key: string }[] }[];
  resource: Record<string, unknown>;
  scope: string;
}

async function bundle(directory: string) {
  const manifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  ) as TraceImportManifest;
  const trace = (traceId: string) => manifest.traces.find((item) => item.trace_id === traceId)!;
  const spans = async (traceId: string) => {
    const found: Span[] = [];
    for (const batch of trace(traceId).batches) {
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
  /** Every batch of the bundle, for comparing two preparations byte for byte. */
  const batches = () => manifest.traces.map((item) => [item.trace_id, item.batches]);
  return { manifest, trace, spans, batches };
}

const attr = (span: Span, key: string) => span.attributes.find((item) => item.key === key)?.value;
const str = (span: Span, key: string) => attr(span, key)?.stringValue as string | undefined;
const json = (span: Span, key: string) => JSON.parse(str(span, key)!) as unknown;
const int = (span: Span, key: string) => attr(span, key)?.intValue as string | undefined;
const named = (spans: Span[], name: string) => spans.find((span) => span.name === name)!;
/** A span without its kept source record, for comparing content across source shapes. */
const withoutRecord = (span: Span) => ({
  ...span,
  attributes: span.attributes.filter((item) => item.key !== "hue.import.source_record"),
});

/** A trace's emitted id when the source id is no OpenTelemetry id. */
const derivedTrace = (format: string, key: string) => sha256(`${format}.trace:${key}`).slice(0, 32);

const chatOutput = [
  {
    role: "assistant",
    parts: [{ type: "tool_call", id: "call_1", name: "lookup_order", arguments: { id: 12 } }],
    finish_reason: "tool_calls",
  },
];
const chatInput = [
  { role: "system", parts: [{ type: "text", content: "You help customers with their orders." }] },
  { role: "user", parts: [{ type: "text", content: "Where is order 12?" }] },
];

/** The model call and tool call every fixture records, as Hue reads them. */
function expectModelAndTool(llm: Span, tool: Span, model: string) {
  expect(str(llm, "gen_ai.operation.name")).toBe("chat");
  expect(str(llm, "gen_ai.request.model")).toBe(model);
  expect(json(llm, "gen_ai.input.messages")).toEqual(chatInput);
  expect(int(llm, "gen_ai.usage.input_tokens")).toBe("1834");
  expect(int(llm, "gen_ai.usage.output_tokens")).toBe("96");
  expect(attr(llm, "user.id")).toBeUndefined();
  expect(str(tool, "gen_ai.operation.name")).toBe("execute_tool");
  expect(str(tool, "gen_ai.tool.name")).toBe("lookup_order");
  expect(json(tool, "gen_ai.tool.call.arguments")).toEqual({ id: 12 });
  // The account a tool's record names is never the trace's user.
  expect(attr(tool, "user.id")).toBeUndefined();
}

// --- Fixtures in every shape each platform exports -------------------------------------------

const LANGSMITH_ROOT = "1f0c6a2e-3b4d-4c5e-8f60-7a8b9c0d1e01";
const LANGSMITH_PROJECT = "5b0d3c1e-7a2f-4e8b-9c6d-2f1a0e9b8c7d";
const MLFLOW_TRACE = "7d3c1f0a9b8e4d2c1a0f9e8d7c6b5a49";
const OPIK_TRACE = "019a0a1b-2c3d-7e4f-8a5b-6c7d8e9f0a01";
const WEAVE_TRACE = "019a0a1c-1111-7aaa-8bbb-0000000000f1";

const jsonl = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");

describe("the format registry", () => {
  test("lets exactly one format claim each row platform's records, and none another's", async () => {
    const langsmith = JSON.parse(await fixture("langsmith-runs.json")) as { runs: unknown[] };
    const langsmithV2 = JSON.parse(await fixture("langsmith-runs-v2.json")) as { items: unknown[] };
    const mlflow = JSON.parse(await fixture("mlflow-trace.json")) as Record<string, any>;
    const opik = JSON.parse(await fixture("opik-trace.json")) as { spans: unknown[] };
    const weave = (await fixture("weave-calls.jsonl"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    const claims = (value: unknown) =>
      importAdapters.filter((adapter) => adapter.detect(value)).map((adapter) => adapter.id);
    const fixtures: [string, unknown][] = [
      ["langsmith_runs", langsmith],
      ["langsmith_runs", langsmith.runs[0]],
      ["langsmith_runs", langsmithV2],
      ["langsmith_runs", langsmithV2.items[1]],
      ["mlflow_traces", mlflow],
      ["mlflow_traces", { traces: [mlflow], next_page_token: null }],
      ["opik_traces", opik],
      ["opik_traces", opik.spans[0]],
      ["opik_traces", { content: opik.spans, page: 1, size: 2, total: 2 }],
      ["weave_calls", weave[0]],
      ["weave_calls", { calls: weave }],
      ["weave_calls", { call: weave[2] }],
    ];
    for (const [id, value] of fixtures) expect(claims(value)).toEqual([id]);
    // Records of the other formats are not claimed by these.
    const others: unknown[] = [
      { resourceSpans: [] },
      { data: [{ id: "o", traceId: "t", type: "SPAN", startTime: "2026-03-01T10:00:00.000Z" }] },
      { schema_version: "ATIF-v1.7", session_id: "s", steps: [] },
      { id: "b", span_id: "b", root_span_id: "r", span_attributes: { type: "llm" } },
      // An MLflow span alone, without its trace's info, is not a trace.
      mlflow.data.spans[0],
    ];
    const ours = new Set(["langsmith_runs", "mlflow_traces", "opik_traces", "weave_calls"]);
    for (const value of others) expect(claims(value).filter((id) => ours.has(id))).toEqual([]);
  });
});

describe("LangSmith runs", () => {
  test("reads a runs page, an array, JSON Lines, a nested tree and bulk-export rows alike", async () => {
    const page = await fixture("langsmith-runs.json");
    const { runs } = JSON.parse(page) as { runs: Record<string, any>[] };
    const [root, llm, tool] = runs;
    // Bulk export writes Parquet whose JSON columns are text; converted to JSON Lines they stay so.
    const bulk = runs.map((run) => ({
      ...run,
      inputs: JSON.stringify(run.inputs),
      outputs: JSON.stringify(run.outputs),
      extra: JSON.stringify(run.extra),
      // A Python dump writes times with a space; zone-less times are UTC either way.
      start_time: (run.start_time as string).replace("T", " "),
    }));
    const shapes: Record<string, string> = {
      "page.json": page,
      "array.json": JSON.stringify(runs),
      "runs.jsonl": jsonl(runs),
      "tree.json": JSON.stringify({ ...root, child_runs: [llm, { ...tool, child_runs: [] }] }),
    };
    const reports: Record<string, any>[] = [];
    for (const [name, text] of Object.entries(shapes))
      reports.push(await prepareFiles({ [name]: text }));
    const first = await bundle(reports[0]!.output_directory);
    for (const report of reports.slice(1))
      expect((await bundle(report.output_directory)).batches()).toEqual(first.batches());

    const report = reports[0]!;
    expect(report.formats).toEqual({ langsmith_runs: 1 });
    expect(report.source.formats).toEqual(["otlp_json"]);
    expect(report.totals).toMatchObject({ traces: 1, spans: 3 });
    expect(report.traces.remapped).toEqual({ traces: 1, spans: 3 });
    expect(report.traces.timing).toEqual({});
    const traceId = derivedTrace("langsmith_runs", LANGSMITH_ROOT);
    // The conversation is the metadata's thread, never the run's session_id (its project).
    expect(first.trace(traceId).identity).toEqual({ user: "user-42", session: "thread-7" });
    const spans = await first.spans(traceId);
    const [agent, model, call] = ["support-agent", "ChatOpenAI", "lookup_order"].map((name) =>
      named(spans, name),
    );
    expect(agent!.scope).toBe("hue.import.langsmith_runs");
    expect(agent!.parentSpanId).toBeUndefined();
    expect(model!.parentSpanId).toBe(agent!.spanId);
    expect(str(agent!, "hue.import.original_span_id")).toBe(LANGSMITH_ROOT);
    expect(str(agent!, "hue.import.original_trace_id")).toBe(LANGSMITH_ROOT);
    // `2026-10-20T14:03:11.402000` records no zone: it is UTC.
    expect(agent!.startTimeUnixNano).toBe("1792504991402000000");
    expect(agent!.endTimeUnixNano).toBe("1792505003877000000");
    expect(str(agent!, "user.id")).toBe("user-42");
    expect(str(agent!, "gen_ai.conversation.id")).toBe("thread-7");
    expect(attr(agent!, "gen_ai.operation.name")).toBeUndefined();
    // A chain's summed token counts are not its own.
    expect(attr(agent!, "gen_ai.usage.input_tokens")).toBeUndefined();
    expect(str(agent!, "langsmith.span.kind")).toBe("chain");
    expect(json(agent!, "hue.import.source_record")).toEqual(root);
    expect(JSON.stringify(agent!.attributes)).not.toContain(`"${LANGSMITH_PROJECT}"`);

    expectModelAndTool(model!, call!, "gpt-5");
    expect(str(model!, "gen_ai.provider.name")).toBe("openai");
    expect(json(model!, "gen_ai.output.messages")).toEqual([
      { role: "assistant", parts: chatOutput[0]!.parts },
    ]);
    expect(int(model!, "gen_ai.usage.cache_read.input_tokens")).toBe("1024");
    expect(int(model!, "gen_ai.usage.reasoning.output_tokens")).toBe("64");
    expect(str(call!, "gen_ai.tool.call.id")).toBe("call_1");
    // The ToolMessage the tool answered is read as its content.
    expect(json(call!, "gen_ai.tool.call.result")).toBe('{"status":"shipped","eta":"tomorrow"}');

    const fromBulk = await bundle(
      (await prepareFiles({ "bulk.jsonl": jsonl(bulk) })).output_directory,
    );
    expect(fromBulk.trace(traceId).identity).toEqual({ user: "user-42", session: "thread-7" });
    expect((await fromBulk.spans(traceId)).map(withoutRecord)).toEqual(spans.map(withoutRecord));
  });

  test("reads the v2 runs page: parent_run_ids, upper-case types, thread_id and raw details", async () => {
    const report = await prepareFiles({
      "v2.json": await fixture("langsmith-runs-v2.json"),
    });
    const traceId = derivedTrace("langsmith_runs", "2a7e9c41-5d3b-4f86-a1c2-9e8d7f6a5b01");
    const { trace, spans } = await bundle(report.output_directory);
    // The user is the metadata's, not ls_user_id (the LangSmith account that traced the run).
    expect(trace(traceId).identity).toEqual({ user: "user-42", session: "thread-7" });
    const [root, model] = [
      named(await spans(traceId), "support-agent"),
      named(await spans(traceId), "ChatAnthropic"),
    ];
    expect(model!.parentSpanId).toBe(root!.spanId);
    expect(str(model!, "langsmith.span.kind")).toBe("llm");
    expect(str(model!, "gen_ai.operation.name")).toBe("chat");
    expect(str(model!, "gen_ai.request.model")).toBe("claude-sonnet-4-5");
    expect(str(model!, "gen_ai.provider.name")).toBe("anthropic");
    expect(json(model!, "gen_ai.output.messages")).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "Yes, until it ships." }] },
    ]);
    expect(int(model!, "gen_ai.usage.cache_read.input_tokens")).toBe("2048");
    expect(int(model!, "gen_ai.usage.cache_write.input_tokens")).toBe("150");
  });

  test("keeps a run's ended copy, marks experiments, and refuses only a malformed run's trace", async () => {
    const { runs } = JSON.parse(await fixture("langsmith-runs.json")) as {
      runs: Record<string, any>[];
    };
    const run = (id: string, fields: Record<string, unknown>) => ({
      id,
      trace_id: id,
      parent_run_id: null,
      name: "agent",
      run_type: "chain",
      start_time: "2026-10-20T15:00:00.000000",
      ...fields,
    });
    const pending = { ...runs[0], end_time: null, outputs: null, status: "pending" };
    const lines = [
      JSON.stringify(pending),
      ...runs.map((item) => JSON.stringify(item)),
      // An experiment's run, failed with the error LangChain records.
      JSON.stringify(
        run("3c000000-0000-4000-8000-000000000001", {
          end_time: "2026-10-20T15:00:01.000000",
          reference_example_id: "3c000000-0000-4000-8000-0000000000e1",
          error: "ValueError('no such order')\n\nTraceback (most recent call last):\n  ...",
          status: "error",
        }),
      ),
      // A run whose time is no instant refuses its own trace.
      JSON.stringify(run("3c000000-0000-4000-8000-000000000002", { start_time: "yesterday" })),
      // A child run that names no trace, and no parent that would, is reported alone.
      JSON.stringify({ ...runs[1], trace_id: null, dotted_order: "" }),
      "not json at all",
    ];
    const report = await prepareFiles({ "runs.jsonl": lines.join("\n") });
    expect(report.totals.traces).toBe(2);
    expect(report.traces.by_origin).toMatchObject({ evaluation: 1, unknown: 1 });
    expect(report.files.skipped).toEqual([{ file: "runs.jsonl", line: 8, reason: "not JSON" }]);
    expect(report.traces.refused).toEqual([
      {
        file: "runs.jsonl",
        line: 6,
        trace_id: derivedTrace("langsmith_runs", "3c000000-0000-4000-8000-000000000002"),
        reason: "Invalid source timestamp",
      },
      { file: "runs.jsonl", line: 7, reason: "a run without a trace_id" },
    ]);
    const { spans } = await bundle(report.output_directory);
    const agent = named(
      await spans(derivedTrace("langsmith_runs", LANGSMITH_ROOT)),
      "support-agent",
    );
    expect(agent.endTimeUnixNano).toBe("1792505003877000000");
    const failed = (
      await spans(derivedTrace("langsmith_runs", "3c000000-0000-4000-8000-000000000001"))
    )[0]!;
    expect(failed.status.code).toBe(2);
    expect(failed.status.message).toStartWith("ValueError('no such order')");
    expect(str(failed, "error.type")).toBe("ValueError");
  });

  test("--user-key reads a metadata key of each run onto the root", async () => {
    const { runs } = JSON.parse(await fixture("langsmith-runs.json")) as {
      runs: Record<string, any>[];
    };
    const keyed = runs.map((run, index) =>
      index === 0 ? { ...run, extra: { metadata: { customer: { id: "customer-77" } } } } : run,
    );
    const report = await prepareFiles(
      { "runs.json": JSON.stringify(keyed) },
      "--user-key",
      "customer.id",
    );
    const traceId = derivedTrace("langsmith_runs", LANGSMITH_ROOT);
    const { trace, spans } = await bundle(report.output_directory);
    expect(trace(traceId).identity).toEqual({ user: "customer-77", session: "thread-7" });
    expect(str(named(await spans(traceId), "support-agent"), "user.id")).toBe("customer-77");
  });
});

describe("LangSmith token details", () => {
  test("reads cache writes under every key LangSmith records them", async () => {
    const { runs } = JSON.parse(await fixture("langsmith-runs.json")) as {
      runs: Record<string, any>[];
    };
    const llm = runs.find((run) => run.run_type === "llm")!;
    const withDetails = (id: string, fields: Record<string, unknown>) => ({
      ...llm,
      id,
      trace_id: id,
      parent_run_id: null,
      dotted_order: undefined,
      prompt_tokens: undefined,
      prompt_token_details: undefined,
      ...fields,
    });
    const [wrapped, v2] = [
      "1f0c6a2e-3b4d-4c5e-8f60-7a8b9c0d1e21",
      "1f0c6a2e-3b4d-4c5e-8f60-7a8b9c0d1e22",
    ];
    const usage = (details: Record<string, number>) => ({
      ...llm.extra,
      metadata: {
        ...llm.extra.metadata,
        usage_metadata: { input_tokens: 1300, output_tokens: 20, input_token_details: details },
      },
    });
    const report = await prepareFiles({
      "runs.jsonl": jsonl([
        // LangSmith's own Anthropic wrapper records cache writes by their lifetime.
        withDetails(wrapped!, {
          extra: usage({
            cache_read: 1000,
            ephemeral_5m_input_tokens: 200,
            ephemeral_1h_input_tokens: 50,
          }),
        }),
        // The v2 runs API names them `cache_write` under `raw`.
        withDetails(v2!, {
          extra: usage({}),
          prompt_token_details: { raw: { cache_read: 1000, cache_write: 40 } },
        }),
      ]),
    });
    const { spans } = await bundle(report.output_directory);
    const cacheWrite = async (id: string) =>
      int(
        (await spans(derivedTrace("langsmith_runs", id)))[0]!,
        "gen_ai.usage.cache_write.input_tokens",
      );
    expect(await cacheWrite(wrapped!)).toBe("250");
    expect(await cacheWrite(v2!)).toBe("40");
  });
});

describe("MLflow traces", () => {
  test("reads a trace, a list, JSON Lines and a search answer alike, keeping exact ids and times", async () => {
    const text = await fixture("mlflow-trace.json");
    const trace = JSON.parse(text) as Record<string, any>;
    const reports = [
      await prepareFiles({ "trace.json": text }),
      await prepareFiles({ "traces.json": `[${text}]` }),
      await prepareFiles({ "traces.jsonl": `${JSON.stringify(trace)}\n${JSON.stringify(trace)}` }),
      await prepareFiles({ "search.json": `{"traces": [${text}], "next_page_token": null}` }),
    ];
    const first = await bundle(reports[0]!.output_directory);
    for (const report of reports.slice(1))
      expect((await bundle(report.output_directory)).batches()).toEqual(first.batches());
    const report = reports[0]!;
    expect(report.formats).toEqual({ mlflow_traces: 1 });
    expect(report.traces.remapped).toEqual({ traces: 0, spans: 0 });
    expect(first.trace(MLFLOW_TRACE).identity).toEqual({ user: "user-42", session: "thread-7" });
    const spans = await first.spans(MLFLOW_TRACE);
    const [agent, model, call] = ["support_agent", "Completions", "lookup_order"].map((name) =>
      named(spans, name),
    );
    // Base64 ids decode to the OpenTelemetry ids; nanosecond times beyond 2^53 stay exact.
    expect([agent!.spanId, model!.spanId, call!.spanId]).toEqual([
      "a1b2c3d4e5f60718",
      "b2c3d4e5f6071829",
      "c3d4e5f60718293a",
    ]);
    expect(model!.parentSpanId).toBe("a1b2c3d4e5f60718");
    expect(agent!.startTimeUnixNano).toBe("1792504991402000000");
    expect(str(agent!, "gen_ai.operation.name")).toBe("invoke_agent");
    expect(str(agent!, "user.id")).toBe("user-42");
    expect(str(agent!, "gen_ai.conversation.id")).toBe("thread-7");
    expect(json(agent!, "input.value")).toEqual({ question: "Where is order 12?" });
    expect(str(agent!, "mlflow.spanType")).toBe("AGENT");
    // The root keeps the trace's info beside its span; the other spans keep the span alone.
    expect(json(agent!, "hue.import.source_record")).toEqual({
      info: trace.info,
      span: JSON.parse(JSON.stringify(trace.data.spans[0]).replace(/(_nano":)(\d+)/g, '$1"$2"')),
    });
    expectModelAndTool(model!, call!, "gpt-5");
    expect(json(model!, "gen_ai.output.messages")).toEqual(chatOutput);
    expect(int(model!, "gen_ai.usage.cache_read.input_tokens")).toBe("1024");
    expect(str(model!, "gen_ai.provider.name")).toBe("openai");
    expect(attr(model!, "mlflow.spanInputs")).toBeUndefined();
    expect(json(call!, "gen_ai.tool.call.result")).toEqual({ status: "shipped", eta: "tomorrow" });
  });

  test("reads MLflow 2's trace form, errors and evaluation traces, refusing only a malformed trace", async () => {
    const trace = JSON.parse(await fixture("mlflow-trace.json")) as Record<string, any>;
    const v3 = await bundle(
      (await prepareFiles({ "v3.json": JSON.stringify(trace) })).output_directory,
    );
    // MLflow 2: request_id and request_metadata; spans with context, parent_id and start_time.
    const hex = (base64: string) => `0x${Buffer.from(base64, "base64").toString("hex")}`;
    const v2 = {
      info: {
        request_id: trace.info.trace_id,
        experiment_id: "1",
        timestamp_ms: 1792504991402,
        execution_time_ms: 12475,
        status: "OK",
        request_metadata: trace.info.trace_metadata,
        tags: trace.info.tags,
      },
      data: {
        spans: trace.data.spans.map((span: Record<string, any>) => ({
          name: span.name,
          context: { trace_id: hex(span.trace_id), span_id: hex(span.span_id) },
          parent_id: span.parent_span_id ? hex(span.parent_span_id) : null,
          start_time: span.start_time_unix_nano,
          end_time: span.end_time_unix_nano,
          status_code: "OK",
          status_message: "",
          attributes: span.attributes,
          events: [],
        })),
      },
    };
    const failed = structuredClone(trace);
    failed.info.trace_id = `tr-${"e".repeat(32)}`;
    failed.info.tags["mlflow.eval.requestId"] = "eval-request-1";
    failed.data.spans[2].status = { code: "STATUS_CODE_ERROR", message: "order service down" };
    failed.data.spans[2].events = [
      {
        name: "exception",
        time_unix_nano: 1792504995800000000,
        attributes: { "exception.type": "ConnectionError", "exception.message": "down" },
      },
    ];
    const broken = structuredClone(trace);
    broken.info.trace_id = `tr-${"f".repeat(32)}`;
    broken.data.spans[1].attributes = "not attributes";
    const empty = {
      info: { ...trace.info, trace_id: `tr-${"d".repeat(32)}` },
      data: { spans: [] },
    };
    const report = await prepareFiles({
      "v2.json": JSON.stringify(v2),
      "more.jsonl": [failed, broken, empty].map((item) => JSON.stringify(item)).join("\n"),
    });
    expect(report.totals.traces).toBe(2);
    expect(report.traces.by_origin).toMatchObject({ evaluation: 1, unknown: 1 });
    expect(report.traces.refused).toEqual([
      {
        file: "more.jsonl",
        line: 2,
        trace_id: "f".repeat(32),
        reason: "a span's attributes are not an object",
      },
      {
        file: "more.jsonl",
        line: 3,
        trace_id: "d".repeat(32),
        reason: "a trace exported without its spans; export it with its spans",
      },
    ]);
    const { spans } = await bundle(report.output_directory);
    const fromV2 = await spans(MLFLOW_TRACE);
    expect(fromV2.map(withoutRecord)).toEqual((await v3.spans(MLFLOW_TRACE)).map(withoutRecord));
    const lookup = named(await spans("e".repeat(32)), "lookup_order");
    expect(lookup.status).toEqual({ code: 2, message: "order service down" });
    expect(str(lookup, "error.type")).toBe("ConnectionError");
    expect(lookup.events?.map((event) => [event.name, event.timeUnixNano])).toEqual([
      ["exception", "1792504995800000000"],
    ]);
  });

  test("--user-key reads a trace metadata key", async () => {
    const trace = JSON.parse(await fixture("mlflow-trace.json")) as Record<string, any>;
    delete trace.info.trace_metadata["mlflow.trace.user"];
    trace.info.trace_metadata["app.customer"] = "customer-9";
    const plain = await prepareFiles({ "trace.json": JSON.stringify(trace) });
    expect(plain.traces.without_identity).toBe(1);
    expect((await bundle(plain.output_directory)).trace(MLFLOW_TRACE).identity).toEqual({
      session: "thread-7",
    });
    const keyed = await prepareFiles(
      { "trace.json": JSON.stringify(trace) },
      "--user-key",
      "app.customer",
    );
    expect((await bundle(keyed.output_directory)).trace(MLFLOW_TRACE).identity).toEqual({
      user: "customer-9",
      session: "thread-7",
    });
  });

  test("--user-key and --session-key read a span's own attributes, the trace's metadata and tags", async () => {
    const trace = JSON.parse(await fixture("mlflow-trace.json")) as Record<string, any>;
    delete trace.info.trace_metadata["mlflow.trace.user"];
    delete trace.info.trace_metadata["mlflow.trace.session"];
    trace.info.tags["app.customer"] = "tag-customer";
    trace.info.tags["app.thread"] = "tag-thread";
    const identity = async (...flags: string[]) =>
      (
        await bundle(
          (await prepareFiles({ "trace.json": JSON.stringify(trace) }, ...flags)).output_directory,
        )
      ).trace(MLFLOW_TRACE).identity;
    expect(await identity("--user-key", "app.customer", "--session-key", "app.thread")).toEqual({
      user: "tag-customer",
      session: "tag-thread",
    });
    // The trace's metadata comes before its tags, and a span's own attribute before both.
    trace.info.trace_metadata["app.customer"] = "metadata-customer";
    expect(await identity("--user-key", "app.customer")).toEqual({ user: "metadata-customer" });
    trace.data.spans[0].attributes["app.customer"] = JSON.stringify("span-customer");
    expect(await identity("--user-key", "app.customer")).toEqual({ user: "span-customer" });
    // A JSONPath or JSON Pointer reads the trace's info.
    expect(await identity("--user-key", "$.info.tags['app.customer']")).toEqual({
      user: "tag-customer",
    });
    expect(await identity("--user-key", "/info/trace_metadata/app.customer")).toEqual({
      user: "metadata-customer",
    });
    // So does a trace whose top span's parent is outside the export: that span is its root.
    trace.data.spans[0].parent_span_id = Buffer.from("1122334455667788", "hex").toString("base64");
    expect(await identity("--user-key", "/info/tags/app.customer")).toEqual({
      user: "tag-customer",
    });
  });

  test("reads once a trace two exports hold though the later one adds to its info", async () => {
    const monday = JSON.parse(await fixture("mlflow-trace.json")) as Record<string, any>;
    const tuesday = structuredClone(monday);
    tuesday.info.tags.reviewed = "true";
    for (const parent of [undefined, Buffer.from("1122334455667788", "hex").toString("base64")]) {
      // A root without a parent, then one whose parent is outside the export.
      for (const trace of [monday, tuesday]) trace.data.spans[0].parent_span_id = parent;
      const prepared = [];
      for (const [first, second] of [
        [monday, tuesday],
        [tuesday, monday],
      ]) {
        const report = await prepareFiles({
          "a.json": JSON.stringify(first),
          "b.json": JSON.stringify(second),
        });
        expect(report.traces.refused).toEqual([]);
        // Tuesday's info sorts first, so its copy is the one read, and the note says so when it
        // is the later file's.
        const kept = second === tuesday ? " from this copy" : "";
        expect(report.files.notes).toEqual([
          { file: "b.json", reason: `the same records as a.json, read once${kept}` },
        ]);
        prepared.push(await bundle(report.output_directory));
      }
      // One export's info is kept, the same whichever is read first.
      expect(prepared[1]!.batches()).toEqual(prepared[0]!.batches());
      const agent = named(await prepared[0]!.spans(MLFLOW_TRACE), "support_agent");
      expect((json(agent, "hue.import.source_record") as { info: unknown }).info).toEqual(
        tuesday.info,
      );
      // A third copy names the file whose copy is kept.
      const three = await prepareFiles({
        "a.json": JSON.stringify(monday),
        "b.json": JSON.stringify(tuesday),
        "c.json": JSON.stringify(monday),
      });
      expect(three.files.notes).toEqual([
        { file: "b.json", reason: "the same records as a.json, read once from this copy" },
        { file: "c.json", reason: "the same records as b.json, read once" },
      ]);
    }
  });
});

describe("MLflow trace info", () => {
  test("refuses a trace whose info a source record cannot hold, with its root or without", async () => {
    // The info is part of the record of each root, a span whose parent is outside the export
    // included, so a NUL in its text refuses the trace either way.
    const trace = JSON.parse(await fixture("mlflow-trace.json")) as Record<string, any>;
    const broken = (hex: string, root: boolean) => {
      const copy = structuredClone(trace);
      copy.info.trace_id = `tr-${hex}`;
      copy.info.tags["probe.tag"] = "a\u0000b";
      for (const span of copy.data.spans)
        span.trace_id = Buffer.from(hex, "hex").toString("base64");
      if (!root) copy.data.spans = copy.data.spans.slice(1);
      return copy;
    };
    const rooted = "0123456789abcdef0123456789abcdef";
    const rootless = "fedcba9876543210fedcba9876543210";
    const report = await prepareFiles({
      "a.json": JSON.stringify(broken(rooted, true)),
      "b.json": JSON.stringify(broken(rootless, false)),
      "c.json": JSON.stringify(trace),
    });
    expect(report.totals.traces).toBe(1);
    expect(report.traces.refused).toEqual([
      { file: "a.json", trace_id: rooted, reason: "Source JSON contains invalid text" },
      { file: "b.json", trace_id: rootless, reason: "Source JSON contains invalid text" },
    ]);
  });
});

describe("MLflow span links", () => {
  test("keeps a span's links, to its own trace or another, as span links", async () => {
    const trace = JSON.parse(await fixture("mlflow-trace.json")) as Record<string, any>;
    const otherTrace = "0123456789abcdef0123456789abcdef";
    const [, completions, tool] = trace.data.spans;
    completions.links = [
      {
        trace_id: `tr-${otherTrace}`,
        span_id: "1122334455667788",
        attributes: { kind: "follows" },
      },
    ];
    // A link to a span of the same trace, its id as Span.to_dict writes it (base64).
    tool.links = [
      { trace_id: `tr-${MLFLOW_TRACE}`, span_id: completions.span_id, attributes: null },
    ];
    const report = await prepareFiles({ "trace.json": JSON.stringify(trace) });
    const { spans } = await bundle(report.output_directory);
    const emitted = await spans(MLFLOW_TRACE);
    const linksOf = (span: Span) => (span as Span & { links?: unknown[] }).links;
    const model = named(emitted, completions.name);
    expect(linksOf(model)).toEqual([
      {
        traceId: otherTrace,
        spanId: "1122334455667788",
        attributes: [{ key: "kind", value: { stringValue: "follows" } }],
      },
    ]);
    expect(linksOf(named(emitted, "lookup_order"))).toEqual([
      { traceId: MLFLOW_TRACE, spanId: model.spanId, attributes: [] },
    ]);
  });
});

describe("Opik traces", () => {
  test("reads an export file: the trace as the root, its spans beneath it", async () => {
    const text = await fixture("opik-trace.json");
    const exported = JSON.parse(text) as {
      trace: Record<string, any>;
      spans: Record<string, any>[];
    };
    const report = await prepareFiles({ [`trace_${OPIK_TRACE}.json`]: text });
    expect(report.formats).toEqual({ opik_traces: 1 });
    expect(report.traces.by_origin).toMatchObject({ production: 1 });
    const traceId = derivedTrace("opik_traces", OPIK_TRACE);
    const { trace, spans } = await bundle(report.output_directory);
    expect(trace(traceId).identity).toEqual({ user: "user-42", session: "thread-7" });
    const all = await spans(traceId);
    const [root, model, call] = ["support-agent", "chat_completion_create", "lookup_order"].map(
      (name) => named(all, name),
    );
    expect(root!.parentSpanId).toBeUndefined();
    expect(model!.parentSpanId).toBe(root!.spanId);
    expect(call!.parentSpanId).toBe(root!.spanId);
    // `str(datetime)` writes a space and an offset.
    expect(root!.startTimeUnixNano).toBe("1792504991402000000");
    expect(root!.resource).toEqual({ "deployment.environment.name": "production" });
    expect(str(root!, "user.id")).toBe("user-42");
    expect(str(root!, "gen_ai.conversation.id")).toBe("thread-7");
    expect(json(root!, "hue.import.source_record")).toEqual(exported.trace);
    expectModelAndTool(model!, call!, "gpt-5-2025-08-07");
    expect(json(model!, "gen_ai.output.messages")).toEqual(chatOutput);
    expect(int(model!, "gen_ai.usage.cache_read.input_tokens")).toBe("1024");
    expect(int(model!, "gen_ai.usage.reasoning.output_tokens")).toBe("64");
    expect(json(call!, "gen_ai.tool.call.result")).toEqual({ status: "shipped", eta: "tomorrow" });
  });

  test("reads span pages without their trace, keeps the last update, and refuses a malformed export", async () => {
    const exported = JSON.parse(await fixture("opik-trace.json")) as {
      trace: Record<string, any>;
      spans: Record<string, any>[];
    };
    const [llm, tool] = exported.spans;
    const updated = {
      ...tool,
      output: { status: "delivered" },
      last_updated_at: "2026-10-20 18:00:00.000000+00:00",
    };
    const experiment = structuredClone(exported);
    experiment.trace.id = "019a0a1b-2c3d-7e4f-8a5b-6c7d8e9f0a02";
    experiment.trace.source = "experiment";
    experiment.spans = [];
    const broken = structuredClone(exported);
    broken.trace.id = "019a0a1b-2c3d-7e4f-8a5b-6c7d8e9f0a03";
    broken.spans = broken.spans.map((span: Record<string, any>) => ({
      ...span,
      trace_id: broken.trace.id,
      error_info: "boom",
    }));
    const report = await prepareFiles({
      "page.json": JSON.stringify({ content: [llm, tool], page: 1, size: 2, total: 2 }),
      "later.jsonl": `${JSON.stringify(updated)}\n${JSON.stringify(tool)}`,
      "experiment.json": JSON.stringify(experiment),
      "broken.json": JSON.stringify(broken),
    });
    expect(report.totals.traces).toBe(2);
    // The spans record the production environment; the experiment's trace is evaluation traffic.
    expect(report.traces.by_origin).toMatchObject({ evaluation: 1, production: 1 });
    expect(report.traces.refused).toEqual([
      {
        file: "broken.json",
        trace_id: derivedTrace("opik_traces", broken.trace.id),
        reason: "error_info is not an object",
      },
    ]);
    const traceId = derivedTrace("opik_traces", OPIK_TRACE);
    const { trace, spans } = await bundle(report.output_directory);
    // Without the trace record, its spans are roots that keep the trace as their missing parent;
    // the trace's metadata, and so its user, is not in the export.
    expect(trace(traceId).identity).toBeUndefined();
    const call = named(await spans(traceId), "lookup_order");
    expect(call.parentSpanId).toBeUndefined();
    expect(str(call, "hue.import.original_parent_span_id")).toBe(OPIK_TRACE);
    expect(json(call, "gen_ai.tool.call.result")).toEqual({ status: "delivered" });
  });
});

describe("W&B Weave calls", () => {
  test("reads the calls stream and query answers alike, never wb_user_id as the user", async () => {
    const text = await fixture("weave-calls.jsonl");
    const calls = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, any>);
    const reports = [
      await prepareFiles({ "calls.jsonl": text }),
      await prepareFiles({ "query.json": JSON.stringify({ calls }) }),
      await prepareFiles({ "calls.json": JSON.stringify(calls) }),
    ];
    const first = await bundle(reports[0]!.output_directory);
    for (const report of reports.slice(1))
      expect((await bundle(report.output_directory)).batches()).toEqual(first.batches());
    expect(reports[0]!.formats).toEqual({ weave_calls: 1 });
    const traceId = derivedTrace("weave_calls", WEAVE_TRACE);
    expect(first.trace(traceId).identity).toEqual({ user: "user-42", session: "thread-7" });
    const spans = await first.spans(traceId);
    const [agent, model, call] = [
      "support_agent",
      "openai.chat.completions.create",
      "lookup_order",
    ].map((name) => named(spans, name));
    expect(str(agent!, "gen_ai.operation.name")).toBe("invoke_agent");
    expect(str(agent!, "user.id")).toBe("user-42");
    // A parent's summed usage is not its own.
    expect(attr(agent!, "gen_ai.usage.input_tokens")).toBeUndefined();
    // wb_user_id, the W&B account that logged the calls, stays in the source record alone.
    expect(JSON.stringify(spans.map(withoutRecord))).not.toContain("VXNlcjoxMjM0NQ==");
    expectModelAndTool(model!, call!, "gpt-5");
    expect(str(model!, "gen_ai.response.model")).toBe("gpt-5-2025-08-07");
    expect(json(model!, "gen_ai.output.messages")).toEqual(chatOutput);
    expect(json(call!, "gen_ai.tool.call.result")).toEqual({ status: "shipped", eta: "tomorrow" });
    expect(json(agent!, "hue.import.source_record")).toEqual(calls[0]);
  });

  test("keeps a call's ended copy, marks evaluations and errors, and refuses only a malformed trace", async () => {
    const calls = (await fixture("weave-calls.jsonl"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, any>);
    const running = { ...calls[0], ended_at: null, output: null, summary: null };
    const evaluation = {
      ...calls[0],
      id: "019a0a1c-2222-7aaa-8bbb-000000000001",
      trace_id: "019a0a1c-2222-7aaa-8bbb-0000000000f2",
      op_name: "weave:///synthetic-team/support-agent/op/Evaluation.evaluate:aGFzaA",
      thread_id: null,
      exception: "KeyError: 'expected'",
    };
    const broken = {
      ...calls[1],
      id: "019a0a1c-3333-7aaa-8bbb-000000000002",
      trace_id: "019a0a1c-3333-7aaa-8bbb-0000000000f3",
      summary: "none",
    };
    const report = await prepareFiles({
      "calls.jsonl": [running, ...calls, evaluation, broken]
        .map((call) => JSON.stringify(call))
        .join("\n"),
    });
    expect(report.totals.traces).toBe(2);
    expect(report.traces.by_origin).toMatchObject({ evaluation: 1, unknown: 1 });
    expect(report.traces.refused).toEqual([
      {
        file: "calls.jsonl",
        line: 6,
        trace_id: derivedTrace("weave_calls", broken.trace_id),
        reason: "summary is not an object",
      },
    ]);
    const { spans } = await bundle(report.output_directory);
    const agent = named(await spans(derivedTrace("weave_calls", WEAVE_TRACE)), "support_agent");
    expect(agent.endTimeUnixNano).toBe("1792505003877000000");
    const failed = (await spans(derivedTrace("weave_calls", evaluation.trace_id)))[0]!;
    expect(failed.name).toBe("Evaluation.evaluate");
    expect(failed.status).toEqual({ code: 2, message: "KeyError: 'expected'" });
  });
  test("reads the kind of an integration's op from before Weave recorded kinds", async () => {
    // Calls logged before op kinds existed carry no `attributes.weave.kind`.
    const calls = (await fixture("weave-calls.jsonl"))
      .trim()
      .split("\n")
      .map((line) => {
        const call = JSON.parse(line) as Record<string, any>;
        delete call.attributes.weave.kind;
        return call;
      });
    const report = await prepareFiles({ "calls.jsonl": jsonl(calls) });
    const { spans } = await bundle(report.output_directory);
    const emitted = await spans(derivedTrace("weave_calls", WEAVE_TRACE));
    const model = named(emitted, "openai.chat.completions.create");
    expect(str(model, "gen_ai.operation.name")).toBe("chat");
    expect(str(model, "gen_ai.request.model")).toBe("gpt-5");
    expect(int(model, "gen_ai.usage.input_tokens")).toBe("1834");
    // An op of the application's own records no kind it did not record.
    expect(str(named(emitted, "support_agent"), "gen_ai.operation.name")).toBeUndefined();
  });

  test("declares a trace evaluation traffic for a root scorer, never for a guardrail inside it", async () => {
    const calls = (await fixture("weave-calls.jsonl"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, any>);
    const scorer = (id: string, traceId: string, parent: string | null) => ({
      ...calls[2],
      id,
      trace_id: traceId,
      parent_id: parent,
      op_name: "weave:///synthetic-team/support-agent/op/ToxicityScorer.score:aGFzaA",
      attributes: { weave: { kind: "scorer" } },
    });
    const standalone = "019a0a1c-4444-7aaa-8bbb-0000000000f4";
    const report = await prepareFiles({
      "calls.jsonl": jsonl([
        ...calls,
        // A guardrail the agent applied inside its own op: a span of its production trace.
        scorer("019a0a1c-1111-7aaa-8bbb-000000000009", WEAVE_TRACE, calls[0]!.id),
        scorer("019a0a1c-4444-7aaa-8bbb-000000000001", standalone, null),
      ]),
    });
    const { trace } = await bundle(report.output_directory);
    expect(trace(derivedTrace("weave_calls", WEAVE_TRACE)).origin).toBe("unknown");
    expect(trace(derivedTrace("weave_calls", standalone)).origin).toBe("evaluation");
  });
});
