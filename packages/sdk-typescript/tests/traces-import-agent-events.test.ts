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

// Synthetic exports only (see fixtures/import-agent-events/README.md): invented ids, users and
// content in the shapes each vendor's SDK or API writes. Nothing leaves the machine.

const FIXTURES = join(import.meta.dir, "fixtures", "import-agent-events");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const derived = (format: string, key: string) => sha256(`${format}.trace:${key}`).slice(0, 32);

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function scratch(files: Record<string, string> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hue-agent-events-"));
  directories.push(directory);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(directory, name, ".."), { recursive: true });
    await writeFile(join(directory, name), text);
  }
  return directory;
}

const fixture = (name: string) => readFile(join(FIXTURES, name), "utf8");
const lines = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, any>);

/** Runs prepare, writing the bundle to a scratch directory unless `--out` names one. */
async function prepare(input: string, ...flags: string[]) {
  let stdout = "";
  let stderr = "";
  const sink = (append: (text: string) => void) =>
    new Writable({ write: (chunk, _encoding, done) => (append(String(chunk)), done()) });
  if (!flags.includes("--out")) flags.push("--out", join(await scratch(), "bundle"));
  const code = await runTracesCommand(["import", "prepare", input, "--json", ...flags], {
    stdout: sink((text) => (stdout += text)),
    stderr: sink((text) => (stderr += text)),
  });
  if (code !== 0) throw new Error(`prepare exited ${code}: ${stderr}`);
  return JSON.parse(stdout) as Record<string, any>;
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
}

async function bundle(report: Record<string, any>) {
  const directory = report.output_directory as string;
  const manifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  ) as TraceImportManifest;
  const trace = (traceId: string) => {
    const found = manifest.traces.find((item) => item.trace_id === traceId);
    if (!found) throw new Error(`no trace ${traceId}`);
    return found;
  };
  const spans = async (traceId: string) => {
    const found: Span[] = [];
    for (const batch of trace(traceId).batches) {
      const body = await readFile(join(directory, `${traceId}.${batch.sha256}.json.gz`));
      const decoded = JSON.parse(zlib.gunzipSync(body).toString("utf8")) as {
        resourceSpans: { scopeSpans: { spans: Span[] }[] }[];
      };
      for (const group of decoded.resourceSpans)
        for (const scope of group.scopeSpans) found.push(...scope.spans);
    }
    return found;
  };
  return { manifest, trace, spans };
}

const attr = (span: Span, key: string) => span.attributes.find((item) => item.key === key)?.value;
const str = (span: Span, key: string) => attr(span, key)?.stringValue as string | undefined;
const json = (span: Span, key: string) => JSON.parse(str(span, key)!) as unknown;
const byName = (spans: Span[], name: string) => {
  const found = spans.find((span) => span.name === name);
  if (!found) throw new Error(`no span ${name} in ${spans.map((span) => span.name).join(", ")}`);
  return found;
};
const claims = (value: unknown) =>
  importAdapters.filter((adapter) => adapter.detect(value)).map((adapter) => adapter.id);

describe("format detection", () => {
  test("lets exactly one format claim each record of every agent-event fixture", async () => {
    const expected: Record<string, string> = {
      "openai-agents.jsonl": "openai_agents",
      "helicone-export.jsonl": "helicone",
      "openai-chat.jsonl": "openai_chat",
      "openai-responses.jsonl": "openai_responses",
      "anthropic-messages.jsonl": "anthropic_messages",
    };
    for (const [file, id] of Object.entries(expected))
      for (const record of lines(await fixture(file)))
        expect([file, claims(record)]).toEqual([file, [id]]);
    // A track payload is an array of events, each claimed on its own; a Query API page whole.
    const track = JSON.parse(await fixture("raindrop-track.json")) as unknown[];
    expect(claims(track)).toEqual([]);
    for (const event of track) expect(claims(event)).toEqual(["raindrop"]);
    const query = JSON.parse(await fixture("raindrop-query.json")) as Record<string, any>;
    expect(claims(query)).toEqual(["raindrop"]);
    expect(claims({ data: query.data[0] })).toEqual(["raindrop"]);
    // The ingest body an OpenAI Agents exporter posts, and a Helicone API answer.
    const agents = lines(await fixture("openai-agents.jsonl"));
    expect(claims({ data: agents })).toEqual(["openai_agents"]);
    const requests = lines(await fixture("helicone-export.jsonl"));
    expect(claims({ data: requests, error: null })).toEqual(["helicone"]);
    // A bare list of Responses items is one transcript; a list of Anthropic responses is not.
    const pair = lines(await fixture("openai-responses.jsonl"))[1]!;
    expect(claims(pair.input)).toEqual(["openai_responses"]);
    const anthropicResponse = lines(await fixture("anthropic-messages.jsonl"))[1]!;
    expect(claims([anthropicResponse, anthropicResponse])).toEqual([]);
  });

  test("reads a conversation with nothing vendor-specific as OpenAI chat, and never claims another format's record", () => {
    const plain = {
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
    };
    expect(claims(plain)).toEqual(["openai_chat"]);
    expect(claims({ ...plain, system: "Be brief." })).toEqual(["anthropic_messages"]);
    expect(claims({ ...plain, max_tokens: 64 })).toEqual(["openai_chat"]);
    // Other formats' records: OTLP, a Langfuse page, ATIF, Braintrust rows, a Langfuse
    // observation whose input and output are Responses items.
    const responsesItems = [{ type: "message", role: "user", content: "Hi" }];
    for (const [value, id] of [
      [{ resourceSpans: [] }, "otlp_json"],
      [
        {
          data: [{ id: "o", traceId: "t", type: "GENERATION", startTime: "2026-01-01T00:00:00Z" }],
        },
        "langfuse_observations",
      ],
      [{ schema_version: "ATIF-v1.7", session_id: "s", steps: [] }, "atif"],
      [
        { span_id: "a", root_span_id: "b", input: responsesItems, output: responsesItems },
        "braintrust",
      ],
    ] as const)
      expect(claims(value)).toEqual([id]);
    expect(
      claims({
        id: "o",
        traceId: "t",
        type: "GENERATION",
        input: responsesItems,
        output: responsesItems,
      }),
    ).toEqual([]);
    // Another tool's trace object with Responses items as its input and output.
    const traceObject = { id: "t", timestamp: "2026-01-01T00:00:00Z" };
    expect(claims({ ...traceObject, input: responsesItems, output: responsesItems })).toEqual([]);
    expect(claims({ model: "gpt-5", input: responsesItems })).toEqual(["openai_responses"]);
  });
});

describe("OpenAI Agents SDK", () => {
  const TRACE = "trace_0f3c5a8e9b1d4c7aa2e6f8b0c4d2e1a9";
  const traceId = derived("openai_agents", TRACE);

  test("reads a processor's trace and span records as one trace under the GenAI conventions", async () => {
    const text = await fixture("openai-agents.jsonl");
    const root = await scratch({
      "spans.jsonl": text,
      // The ingest body the SDK's exporter posts holds the same records.
      "ingest/body.json": JSON.stringify({ data: lines(text) }),
    });
    const report = await prepare(join(root, "spans.jsonl"), "--out", join(root, "a"));
    const ingest = await prepare(join(root, "ingest", "body.json"), "--out", join(root, "b"));
    expect(report.formats).toEqual({ openai_agents: 1 });
    expect(report.source.formats).toEqual(["otlp_json"]);
    expect(report.totals).toMatchObject({ traces: 1, spans: 7 });
    expect(report.traces.timing).toEqual({ end_from_children: 1, start_from_trace: 1 });
    const { trace, spans } = await bundle(report);
    const copy = await bundle(ingest);
    expect(copy.trace(traceId).batches).toEqual(trace(traceId).batches);

    // The trace record is the root, the end user and conversation on it.
    expect(trace(traceId).identity).toEqual({ user: "customer-3307", session: "thread_5d1e8a" });
    const all = await spans(traceId);
    const workflow = all.find((span) => span.parentSpanId === undefined)!;
    expect(workflow.name).toBe("Order support");
    expect(str(workflow, "user.id")).toBe("customer-3307");
    expect(str(workflow, "gen_ai.conversation.id")).toBe("thread_5d1e8a");
    expect(str(workflow, "hue.import.original_trace_id")).toBe(TRACE);
    expect(str(workflow, "hue.import.timing")).toBe("start_from_trace; end_from_children");
    expect(workflow.startTimeUnixNano).toBe("1792504991401220000");
    expect(workflow.endTimeUnixNano).toBe("1792504994120774000");

    const agent = all.find((span) => str(span, "gen_ai.operation.name") === "invoke_agent")!;
    expect(agent.parentSpanId).toBe(workflow.spanId);
    expect(str(agent, "gen_ai.agent.name")).toBe("Order support");
    expect(str(agent, "hue.import.original_span_id")).toBe("span_5b2e9c1d7a4f8e3b6c0d2a1f");
    expect(attr(agent, "user.id")).toBeUndefined();

    // The model call: messages, model and usage; its microsecond instants kept exactly.
    const generation = byName(all, "generation");
    expect(generation.parentSpanId).toBe(agent.spanId);
    expect(generation.startTimeUnixNano).toBe("1792504991512330000");
    expect(str(generation, "gen_ai.operation.name")).toBe("chat");
    expect(str(generation, "gen_ai.request.model")).toBe("gpt-4.1-mini");
    expect(json(generation, "gen_ai.input.messages")).toEqual([
      { role: "system", parts: [{ type: "text", content: "You answer questions about orders." }] },
      { role: "user", parts: [{ type: "text", content: "Where is order 12?" }] },
    ]);
    expect(json(generation, "gen_ai.output.messages")).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "tool_call", id: "call_order_12", name: "lookup_order", arguments: { id: 12 } },
        ],
      },
    ]);
    expect(attr(generation, "gen_ai.usage.input_tokens")).toEqual({ intValue: "182" });
    expect(attr(generation, "gen_ai.usage.output_tokens")).toEqual({ intValue: "21" });
    expect(attr(generation, "gen_ai.usage.cache_read.input_tokens")).toEqual({ intValue: "64" });

    // The tool call, its arguments parsed and its result as the SDK wrote it.
    const tool = byName(all, "lookup_order");
    expect(str(tool, "gen_ai.operation.name")).toBe("execute_tool");
    expect(str(tool, "gen_ai.tool.name")).toBe("lookup_order");
    expect(json(tool, "gen_ai.tool.call.arguments")).toEqual({ id: 12 });
    expect(json(tool, "gen_ai.tool.call.result")).toBe("{'status': 'shipped', 'eta': 'tomorrow'}");

    // A Responses call exports only its id and usage; a failed handoff is an error.
    const response = byName(all, "response");
    expect(str(response, "gen_ai.response.id")).toBe("resp_68f6c1d2e3a4b5c6");
    expect(attr(response, "gen_ai.usage.input_tokens")).toEqual({ intValue: "240" });
    const handoff = byName(all, "handoff");
    expect(handoff.status).toEqual({ code: 2, message: "Handoff target is unavailable" });
    expect(attr(handoff, "gen_ai.operation.name")).toBeUndefined();
    expect(str(handoff, "openai_agents.handoff.to_agent")).toBe("Billing");
    expect(json(byName(all, "no_payment_details"), "hue.import.source_record")).toEqual(
      lines(text)[1],
    );
  });

  test("leaves top-level spans as roots without their trace record, reads a span's ended copy, and refuses only a malformed span's trace", async () => {
    const records = lines(await fixture("openai-agents.jsonl")).slice(1);
    const other = "trace_" + "ab".repeat(16);
    // A processor that also writes each span when it starts: the copy without `ended_at` loses.
    const started = { ...records[1], ended_at: null, span_data: { type: "generation" } };
    const root = await scratch({
      "spans.jsonl": [
        started,
        ...records,
        { ...records[0], id: "span_broken", trace_id: other, span_data: "generation" },
        { ...records[1], id: "span_sibling", trace_id: other },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    });
    const report = await prepare(join(root, "spans.jsonl"));
    expect(report.totals.traces).toBe(1);
    expect(report.traces.refused).toEqual([
      {
        file: "spans.jsonl",
        line: 8,
        trace_id: derived("openai_agents", other),
        reason: "span_data has no type",
      },
    ]);
    const { trace, spans } = await bundle(report);
    // No trace record: no workflow span, no user; the agent span is a root naming the trace.
    expect(trace(traceId).identity).toBeUndefined();
    const roots = (await spans(traceId)).filter((span) => span.parentSpanId === undefined);
    expect(roots.map((span) => span.name).sort()).toEqual(["Order support", "no_payment_details"]);
    for (const span of roots) expect(str(span, "hue.import.original_parent_span_id")).toBe(TRACE);
    expect(report.traces.without_identity).toBe(1);
    const generation = byName(await spans(traceId), "generation");
    expect(generation.endTimeUnixNano).toBe("1792504992904518000");
    expect(str(generation, "gen_ai.request.model")).toBe("gpt-4.1-mini");
  });
});

describe("Raindrop", () => {
  test("reads a track payload as one trace per event, its user and conversation on the root", async () => {
    const report = await prepare(join(FIXTURES, "raindrop-track.json"));
    expect(report.formats).toEqual({ raindrop: 1 });
    // The analytics event is reported on its own; the agent turn imports.
    expect(report.traces.refused).toEqual([
      {
        file: "raindrop-track.json",
        record: 2,
        reason: "a Raindrop event without ai_data records no agent turn",
      },
    ]);
    const traceId = derived("raindrop", "turn_7731");
    const { trace, spans } = await bundle(report);
    expect(trace(traceId).identity).toEqual({ user: "customer-3307", session: "thread_5d1e8a" });
    const all = await spans(traceId);
    const event = byName(all, "order_question");
    expect(event.parentSpanId).toBeUndefined();
    expect(event.startTimeUnixNano).toBe("1792509604118000000");
    expect(str(event, "gen_ai.operation.name")).toBe("invoke_agent");
    expect(str(event, "gen_ai.request.model")).toBe("gpt-4.1-mini");
    expect(str(event, "user.id")).toBe("customer-3307");
    expect(json(event, "gen_ai.input.messages")).toEqual([
      { role: "user", parts: [{ type: "text", content: "Where is order 12?" }] },
    ]);
    expect(json(event, "gen_ai.output.messages")).toEqual([
      {
        role: "assistant",
        parts: [{ type: "text", content: "Order 12 shipped and arrives tomorrow." }],
      },
    ]);
    expect(json(event, "raindrop.properties")).toEqual({
      agent: "order-support",
      release: "2026.10.2",
    });

    const lookup = byName(all, "lookup_order");
    expect(lookup.parentSpanId).toBe(event.spanId);
    expect(str(lookup, "gen_ai.tool.call.id")).toBe("call_1");
    expect(json(lookup, "gen_ai.tool.call.arguments")).toEqual({ id: 12 });
    expect(json(lookup, "gen_ai.tool.call.result")).toEqual({ status: "shipped", eta: "tomorrow" });
    expect(attr(lookup, "user.id")).toBeUndefined();
    // A tool call records no instant: it starts with its event, and says so.
    expect(str(lookup, "hue.import.timing")).toBe("start_from_parent; end_at_start");
    const notify = byName(all, "notify_customer");
    expect(notify.status).toEqual({ code: 2, message: "mail service timed out after 5s" });
  });

  test("reads a Query API page with tool call timing, and refuses only a malformed event's trace", async () => {
    const page = JSON.parse(await fixture("raindrop-query.json")) as Record<string, any>;
    const broken = { ...page.data[0], id: "evt_broken", tool_calls: { tool_name: "x" } };
    const untimed = {
      event_id: "evt_untimed",
      user_id: 41,
      event: "chat",
      ai_data: { input: "Hi", output: "Hello" },
    };
    const root = await scratch({
      "page.json": JSON.stringify({ ...page, data: [...page.data, broken] }),
      // The same turn sent while pending, then finished: the finished copy is read.
      "untimed.jsonl": [
        { ...untimed, is_pending: true, ai_data: { input: "Hi" } },
        untimed,
        { ...untimed, event_id: "evt_untimed_2" },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    });
    const report = await prepare(root);
    expect(report.totals.traces).toBe(3);
    expect(report.traces.refused).toEqual([
      {
        file: "page.json",
        trace_id: derived("raindrop", "evt_broken"),
        reason: "record 2: tool_calls is not a list",
      },
    ]);
    const { trace, spans } = await bundle(report);
    const traceId = derived("raindrop", "evt_q_4410");
    expect(trace(traceId).identity).toEqual({ user: "customer-5120", session: "conv_91c2" });
    const [event, refund] = await spans(traceId);
    expect(event!.name).toBe("refund_request");
    expect(refund!.name).toBe("refund_charge");
    // Raindrop's own span id is an OpenTelemetry id and is kept.
    expect(refund!.spanId).toBe("8a3f1c9e2b7d4a60");
    expect(refund!.startTimeUnixNano).toBe("1792401175900000000");
    expect(refund!.endTimeUnixNano).toBe("1792401176312500000");
    expect(json(event!, "raindrop.topics")).toEqual(["billing"]);
    // An event with no timestamp is placed by the untimed rule; a numeric user id is read.
    const quiet = await spans(derived("raindrop", "evt_untimed"));
    expect(quiet[0]!.startTimeUnixNano).toBe("946684800000000000");
    expect(json(quiet[0]!, "gen_ai.output.messages")).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "Hello" }] },
    ]);
    expect(trace(derived("raindrop", "evt_untimed")).identity).toEqual({ user: "41" });
    expect(report.traces.timing).toMatchObject({ untimed_trace: 2 });
  });
});

describe("Helicone", () => {
  test("groups a session's requests into one trace of model calls and reads the user", async () => {
    const report = await prepare(join(FIXTURES, "helicone-export.jsonl"));
    expect(report.formats).toEqual({ helicone: 2 });
    expect(report.traces.timing).toEqual({ end_from_latency: 1 });
    const { trace, spans } = await bundle(report);
    const session = derived("helicone", "sess-2c7e91");
    expect(trace(session).identity).toEqual({ user: "customer-3307", session: "sess-2c7e91" });
    const [lookup, answer] = await spans(session);
    for (const span of [lookup!, answer!]) {
      expect(span.parentSpanId).toBeUndefined();
      expect(str(span, "user.id")).toBe("customer-3307");
      expect(str(span, "gen_ai.provider.name")).toBe("openai");
    }
    expect(lookup!.startTimeUnixNano).toBe("1792317601120000000");
    expect(lookup!.endTimeUnixNano).toBe("1792317602044000000");
    expect(str(lookup!, "gen_ai.operation.name")).toBe("chat");
    expect(str(lookup!, "gen_ai.request.model")).toBe("gpt-4.1-mini");
    expect(str(lookup!, "helicone.session.path")).toBe("/support/lookup");
    expect(json(lookup!, "gen_ai.output.messages")).toEqual([
      {
        role: "assistant",
        parts: [{ type: "tool_call", id: "call_1", name: "lookup_order", arguments: { id: 12 } }],
        finish_reason: "tool_calls",
      },
    ]);
    expect(attr(lookup!, "gen_ai.usage.input_tokens")).toEqual({ intValue: "96" });
    expect(attr(lookup!, "gen_ai.usage.cache_read.input_tokens")).toEqual({ intValue: "32" });
    expect(str(lookup!, "hue.import.original_span_id")).toBe(
      "6c1f2a9e-3b7d-4e8a-9f0c-1d2e3f4a5b6c",
    );

    // A request with no session is a trace of its own; with no response time it ends after its
    // recorded latency.
    const single = derived("helicone", "8e3b4c1a-5d9f-4a0c-9b2e-3f4a5b6c7d8e");
    expect(trace(single).identity).toEqual({ user: "customer-5120" });
    const [draft] = await spans(single);
    expect(draft!.endTimeUnixNano).toBe("1792323001200000000");
    expect(str(draft!, "hue.import.timing")).toBe("end_from_latency");
    expect(json(draft!, "gen_ai.system_instructions")).toEqual([
      { type: "text", content: "You draft short replies." },
    ]);
    // `helicone_user` is the Helicone account, never the end user.
    expect(str(draft!, "user.id")).toBe("customer-5120");
  });

  test("keeps a request's latest export, marks a failed one, and refuses only a malformed request's trace", async () => {
    const [first, second, third] = lines(await fixture("helicone-export.jsonl"));
    const failed = {
      ...third!,
      request_id: "9f4c5d2b-6e0a-4b1d-8c3f-4a5b6c7d8e9f",
      response_status: 429,
      response_body: { error: { message: "Rate limit reached", type: "rate_limit_error" } },
    };
    const broken = {
      ...third!,
      request_id: "a05d6e3c-7f1b-4c2e-9d4a-5b6c7d8e9f0a",
      request_created_at: "yesterday",
    };
    const root = await scratch({
      "old.jsonl": [first, second].map((record) => JSON.stringify(record)).join("\n"),
      "new.jsonl": [
        { ...second!, response_body: { choices: [] }, updated_at: "2026-10-18T10:05:00.000Z" },
        failed,
        broken,
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    });
    const report = await prepare(root);
    expect(report.traces.refused).toEqual([
      {
        file: "new.jsonl",
        line: 3,
        trace_id: derived("helicone", broken.request_id),
        reason: "Invalid source timestamp",
      },
    ]);
    const { spans } = await bundle(report);
    const [, latest] = await spans(derived("helicone", "sess-2c7e91"));
    expect(json(latest!, "hue.import.source_record")).toMatchObject({
      updated_at: "2026-10-18T10:05:00.000Z",
    });
    const [limited] = await spans(derived("helicone", failed.request_id));
    expect(limited!.status).toEqual({ code: 2, message: "Rate limit reached" });
    expect(str(limited!, "error.type")).toBe("429");
  });
});

describe("chat transcripts", () => {
  test("reads an OpenAI chat line as an agent, a model span per turn and paired tool calls", async () => {
    const report = await prepare(join(FIXTURES, "openai-chat.jsonl"));
    expect(report.formats).toEqual({ openai_chat: 2 });
    expect(report.traces.without_identity).toBe(1);
    expect(report.traces.timing).toEqual({
      end_at_start: 2,
      end_from_children: 2,
      untimed_trace: 2,
    });
    const [line] = lines(await fixture("openai-chat.jsonl"));
    const content = sha256(canonical(line));
    const traceId = derived("openai_chat", content);
    const { trace, spans } = await bundle(report);
    expect(trace(traceId).identity).toEqual({ user: "customer-3307" });
    const all = await spans(traceId);
    expect(all.map((span) => [span.name, str(span, "hue.import.original_span_id")])).toEqual([
      ["invoke_agent", "agent"],
      ["chat gpt-4.1-mini", "turn-1"],
      ["execute_tool lookup_order", "turn-1.tool-1"],
      ["chat gpt-4.1-mini", "turn-2"],
      ["chat gpt-4.1-mini", "turn-3"],
    ]);
    const [agent, first, tool, second] = all;
    expect(str(agent!, "hue.import.original_trace_id")).toBe(content);
    expect(json(agent!, "hue.import.source_record")).toEqual(line);
    expect(str(agent!, "user.id")).toBe("customer-3307");
    expect(json(agent!, "gen_ai.tool.definitions")).toEqual(line!.tools);
    // No instants: 2000-01-01, a millisecond per span in conversation order.
    expect(all.map((span) => span.startTimeUnixNano)).toEqual(
      [0, 1, 2, 3, 4].map((ms) => String(946_684_800_000_000_000n + BigInt(ms) * 1_000_000n)),
    );
    expect(str(first!, "hue.import.timing")).toBe("untimed_trace; end_at_start");
    expect(json(first!, "gen_ai.output.messages")).toEqual([
      {
        role: "assistant",
        parts: [{ type: "tool_call", id: "call_1", name: "lookup_order", arguments: { id: 12 } }],
      },
    ]);
    expect(str(tool!, "gen_ai.tool.call.id")).toBe("call_1");
    expect(json(tool!, "gen_ai.tool.call.result")).toBe('{"status":"shipped","eta":"tomorrow"}');
    expect(tool!.parentSpanId).toBe(agent!.spanId);
    // The second turn's input is the conversation so far, the tool's answer included.
    expect((json(second!, "gen_ai.input.messages") as unknown[]).length).toBe(4);
  });

  test("reads Anthropic requests and responses: system, failed tool results, cache usage", async () => {
    const report = await prepare(join(FIXTURES, "anthropic-messages.jsonl"));
    expect(report.formats).toEqual({ anthropic_messages: 2 });
    const [request, response] = lines(await fixture("anthropic-messages.jsonl"));
    const { trace, spans } = await bundle(report);
    const requestId = derived("anthropic_messages", sha256(canonical(request)));
    expect(trace(requestId).identity).toEqual({ user: "customer-5120" });
    const [agent, turn, found, missing, answer] = await spans(requestId);
    expect(json(agent!, "gen_ai.system_instructions")).toEqual([
      { type: "text", content: "You help with orders." },
    ]);
    expect(json(turn!, "gen_ai.output.messages")).toMatchObject([
      {
        role: "assistant",
        parts: [{ type: "text" }, { type: "tool_call" }, { type: "tool_call" }],
      },
    ]);
    expect(found!.status).toEqual({ code: 0 });
    expect(json(found!, "gen_ai.tool.call.result")).toBe("shipped");
    expect(missing!.status).toEqual({ code: 2 });
    expect(str(missing!, "gen_ai.tool.call.id")).toBe("toolu_41");
    expect(answer!.name).toBe("chat claude-sonnet-4-5");

    // A response names its own trace; Anthropic's input count gains its cached tokens back.
    const responseId = derived("anthropic_messages", response!.id as string);
    expect(trace(responseId).identity).toBeUndefined();
    const [, reply] = await spans(responseId);
    expect(str(reply!, "gen_ai.response.model")).toBe("claude-sonnet-4-5-20250929");
    expect(attr(reply!, "gen_ai.usage.input_tokens")).toEqual({ intValue: "252" });
    expect(attr(reply!, "gen_ai.usage.cache_read.input_tokens")).toEqual({ intValue: "200" });
    expect(attr(reply!, "gen_ai.usage.cache_write.input_tokens")).toEqual({ intValue: "40" });
    expect(json(reply!, "gen_ai.output.messages")).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "reasoning", content: "The customer wants a summary." },
          { type: "text", content: "Your refund was issued." },
        ],
        finish_reason: "end_turn",
      },
    ]);
  });

  test("reads Responses objects and requests: created_at, conversation, hosted tools, usage", async () => {
    const report = await prepare(join(FIXTURES, "openai-responses.jsonl"));
    expect(report.formats).toEqual({ openai_responses: 2 });
    const [object, pair] = lines(await fixture("openai-responses.jsonl"));
    const { trace, spans } = await bundle(report);
    const objectId = derived("openai_responses", object!.id as string);
    expect(trace(objectId).identity).toEqual({
      user: "customer-3307",
      session: "conv_68f6a0b1c2d3",
    });
    const reply = (await spans(objectId)).find((span) => span.name.startsWith("chat"))!;
    expect(reply.startTimeUnixNano).toBe("1760973791000000000");
    expect(attr(reply, "gen_ai.usage.cache_read.input_tokens")).toEqual({ intValue: "128" });
    expect(attr(reply, "gen_ai.usage.reasoning.output_tokens")).toEqual({ intValue: "24" });
    expect(json(reply, "gen_ai.output.messages")).toEqual([
      { role: "assistant", parts: [{ type: "reasoning", content: "The order lookup succeeded." }] },
      { role: "assistant", parts: [object!.output[1]] },
      { role: "assistant", parts: [{ type: "text", content: "Order 12 has shipped." }] },
    ]);

    const pairId = derived("openai_responses", sha256(canonical(pair)));
    const [, turn, cancel, answer] = await spans(pairId);
    expect(str(turn!, "gen_ai.request.model")).toBe("gpt-4.1-mini");
    expect(json(cancel!, "gen_ai.tool.call.arguments")).toEqual({ id: 40 });
    expect(json(cancel!, "gen_ai.tool.call.result")).toBe('{"cancelled":true}');
    expect(attr(answer!, "gen_ai.usage.input_tokens")).toEqual({ intValue: "90" });
    expect(attr(answer!, "gen_ai.response.model")).toBeUndefined();
  });

  test("refuses only a malformed transcript, reads one copy of a repeated one, and takes --user-key", async () => {
    const [line] = lines(await fixture("openai-chat.jsonl"));
    const anonymous = {
      ...line,
      safety_identifier: undefined,
      metadata: { customer: "customer-9" },
    };
    const broken = { messages: [{ role: "user", content: "Hi" }, { content: "no role" }] };
    const root = await scratch({
      "a.jsonl": [anonymous, broken].map((record) => JSON.stringify(record)).join("\n"),
      "copy/a.jsonl": JSON.stringify(anonymous),
    });
    const report = await prepare(root, "--user-key", "$.metadata.customer");
    expect(report.totals.traces).toBe(1);
    expect(report.files.supported).toEqual([
      { file: "a.jsonl", format: "openai_chat", traces: 1 },
      { file: "copy/a.jsonl", format: "openai_chat", traces: 1 },
    ]);
    expect(report.traces.refused).toEqual([
      {
        file: "a.jsonl",
        line: 2,
        trace_id: derived("openai_chat", sha256(canonical(broken))),
        reason: "message 2 is not a chat message",
      },
    ]);
    const traceId = derived(
      "openai_chat",
      sha256(canonical(JSON.parse(JSON.stringify(anonymous)))),
    );
    const { trace, spans } = await bundle(report);
    expect(trace(traceId).identity).toEqual({ user: "customer-9" });
    const [agent] = await spans(traceId);
    expect(str(agent!, "user.id")).toBe("customer-9");
  });
});

/** JSON with sorted keys, as the importer derives a transcript's content id. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
