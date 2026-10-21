import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { crc32, deflateRawSync, gunzipSync, gzipSync } from "node:zlib";
import { runTracesCommand, TRACES_USAGE, type TracesCommandIo } from "../src/cli/traces-import.js";
import {
  batchEntries,
  integerQuotient,
  manifestTotals,
  validateManifest,
  type TraceImportManifest,
} from "../src/cli/traces-import-convert.js";
import { decodeContainer, parseValues } from "../src/cli/import-formats/containers.js";
import { adapterFor, unrecognizedReason } from "../src/cli/import-formats/registry.js";
import { ZipArchive, unsafeZipPath } from "../src/cli/traces-import-zip.js";
import { Progress } from "../src/cli/traces-import-upload.js";
import { manifestTooLarge } from "../src/cli/traces-import-prepare.js";
import { textContentType } from "../src/blobs.js";

// Synthetic exports (OTLP/JSON, Langfuse observations, ATIF) and a loopback stand-in for Hue's
// import routes written from their contract: the manifest's exact bytes are registered once,
// declared values are reserved, stored and completed, declared batches are ingested with an
// exact replay of a span counted as a duplicate and another payload for a held span rejected,
// receipts answer for declared traces, and completion is refused while a trace is unverified.
// Nothing leaves the loopback interface, and no real credential is involved.

const cli = join(import.meta.dir, "../src/setup/cli.ts");
const TOKEN = `hue_it_${"a".repeat(43)}`;
/** Whether this process is refused a mode-000 file: false as root or in a sandbox that holds
 * CAP_DAC_OVERRIDE, where an unreadable fixture cannot be made. */
const PERMISSIONS_ENFORCED = (() => {
  const probe = mkdtempSync(join(tmpdir(), "hue-traces-perm-"));
  try {
    writeFileSync(join(probe, "f"), "x");
    chmodSync(join(probe, "f"), 0o000);
    try {
      readFileSync(join(probe, "f"));
      return false;
    } catch {
      return true;
    }
  } finally {
    chmodSync(join(probe, "f"), 0o600);
    rmSync(probe, { recursive: true, force: true });
  }
})();
const IMPORT_ID = "3f2c1a0e-5b6d-4c7e-8f90-a1b2c3d4e5f6";
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const directories: string[] = [];
const stops: (() => void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function scratch(prefix = "hue-traces-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

// --- Synthetic exports --------------------------------------------------------------------------

const T1 = "0af7651916cd43dd8448eb211c80319c";
const T1_ROOT = "b7ad6b7169203331";
const T1_CHILD = "00f067aa0ba902b7";
const T2_B64 = Buffer.from("5f2b6c1e7a1d4c5e9b0a3d2e1f4a5b6c", "hex").toString("base64");
const T2_SPAN_B64 = Buffer.from("8a3c1e2d0b4f4a6e", "hex").toString("base64");
const T3_UUID = "6c84fb90-12c4-11e1-840d-7b25c5ee775a";
const T3_SPAN_UUID = "9b4d2f3e-1c5a-4b7f-8d9e-2f3a4b5c6d7e";
const L1_UUID = "5f2b6c1e-7a1d-4c5e-9b0a-3d2e1f4a5b6c";
const L2 = "c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6";

type Attributes = Record<string, string | number | boolean | string[]>;
const attribute = (key: string, value: string | number | boolean | string[]) => ({
  key,
  value:
    typeof value === "number"
      ? { intValue: String(value) }
      : typeof value === "boolean"
        ? { boolValue: value }
        : Array.isArray(value)
          ? { arrayValue: { values: value.map((item) => ({ stringValue: item })) } }
          : { stringValue: value },
});

function otlpSpan(
  ids: { traceId: string; spanId: string; parentSpanId?: string },
  name: string,
  start: string,
  end: string,
  attributes: Attributes = {},
  extra: Record<string, unknown> = {},
) {
  return {
    ...ids,
    name,
    kind: 1,
    startTimeUnixNano: start,
    endTimeUnixNano: end,
    attributes: Object.entries(attributes).map(([key, value]) => attribute(key, value)),
    status: { code: 0 },
    ...extra,
  };
}

function envelope(resource: Attributes, spans: unknown[], scope = "synthetic-exporter") {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: Object.entries(resource).map(([key, value]) => attribute(key, value)),
        },
        scopeSpans: [{ scope: { name: scope, version: "1.0.0" }, spans }],
      },
    ],
  };
}

const T1_ROOT_SPAN = otlpSpan(
  { traceId: T1, spanId: T1_ROOT },
  "POST /chat",
  "1760000000000000000",
  "1760000002000000000",
  { "user.id": "user-7", "session.id": "session-3", "gen_ai.operation.name": "invoke_agent" },
  { events: [{ timeUnixNano: "1760000001000000000", name: "reply", attributes: [] }] },
);
const T1_CHILD_SPAN = otlpSpan(
  { traceId: T1, spanId: T1_CHILD, parentSpanId: T1_ROOT },
  "chat gpt-5",
  "1760000000500000000",
  "1760000001500000000",
  {
    "gen_ai.operation.name": "chat",
    "gen_ai.request.model": "gpt-5",
    "gen_ai.usage.input_tokens": 120,
    "gen_ai.usage.output_tokens": 30,
  },
);
/** Protobuf-JSON encoders write ids as base64; the receiver reads both forms. */
const T2_SPAN = otlpSpan(
  { traceId: T2_B64, spanId: T2_SPAN_B64 },
  "GET /health",
  "1760000010000000000",
  "1760000010100000000",
  { "hue.world.entity.namespace": "team", "hue.world.entity.id": "billing" },
);
/** An exporter that wrote vendor UUIDs: mapped to deterministic OpenTelemetry ids. */
const T3_SPAN = otlpSpan(
  { traceId: T3_UUID, spanId: T3_SPAN_UUID },
  "job",
  "1760000020000000000",
  "1760000021000000000",
  { "hue.execution.id": "exec-1" },
);

const otlpFile = JSON.stringify(
  envelope({ "service.name": "chatbot", "deployment.environment.name": "production" }, [
    T1_ROOT_SPAN,
    T2_SPAN,
  ]),
);
/** The rest of T1 and the UUID trace, one request a line. */
const otlpLines = [
  JSON.stringify(envelope({ "service.name": "chatbot" }, [T1_CHILD_SPAN])),
  JSON.stringify(envelope({ "service.name": "worker" }, [T3_SPAN])),
].join("\n");

function observation(
  id: string,
  traceId: string,
  type: string,
  name: string,
  startTime: string,
  endTime: string | null,
  fields: Record<string, unknown> = {},
) {
  return { id, traceId, type, name, startTime, endTime, parentObservationId: null, ...fields };
}

const langfuseData = {
  data: [
    observation(
      "8a3c1e2d-0b4f-4a6e-9c7d-1e2f3a4b5c6d",
      L1_UUID,
      "SPAN",
      "support-chat",
      "2026-03-01T10:00:00.000Z",
      "2026-03-01T10:00:02.000Z",
      {
        userId: "user-7",
        sessionId: "session-3",
        environment: "production",
        input: { question: "refund?" },
        output: "Refunded.",
        metadata: { "resourceAttributes.service.name": "langfuse-app", team: "support" },
      },
    ),
    observation(
      "9b4d2f3e-1c5a-4b7f-8d9e-2f3a4b5c6d7e",
      L1_UUID,
      "GENERATION",
      "gpt-5",
      "2026-03-01T10:00:00.500Z",
      "2026-03-01T10:00:01.500Z",
      {
        parentObservationId: "8a3c1e2d-0b4f-4a6e-9c7d-1e2f3a4b5c6d",
        model: "gpt-5",
        inputUsage: 120,
        outputUsage: 30,
        usageDetails: { input: 120, output: 30, input_cached_tokens: 20 },
        level: "ERROR",
        statusMessage: "rate limited once",
        input: [{ role: "user", content: "refund?" }],
        output: { role: "assistant", content: "Refunded." },
      },
    ),
    // A Langfuse event has no end time.
    observation(
      "1c5a4b7f8d9e2f3a-event",
      L1_UUID,
      "EVENT",
      "ticket-updated",
      "2026-03-01T10:00:01.800Z",
      null,
      { parentObservationId: "8a3c1e2d-0b4f-4a6e-9c7d-1e2f3a4b5c6d", input: "ticket 12" },
    ),
  ],
  meta: { page: 1, limit: 100 },
};
const langfuseNative = {
  traceId: L2,
  observations: [
    observation(
      "53995c3f42cd8ad8",
      L2,
      "SPAN",
      "nightly-report",
      "2026-03-02T01:00:00.000Z",
      "2026-03-02T01:00:05.000Z",
      { input: "run", output: "ok" },
    ),
  ],
};

function atifExport(options: { userId?: string; subagent?: boolean } = {}) {
  const subagentId = "sub-1";
  return {
    schema_version: "ATIF-v1.7",
    session_id: "session-42",
    trajectory_id: "traj-1",
    agent: { name: "support-agent", version: "3.1.0", model_name: "gpt-5" },
    steps: [
      { step_id: 1, timestamp: "2026-03-03T09:00:00Z", source: "system", message: "You help." },
      {
        step_id: 2,
        timestamp: "2026-03-03T09:00:01Z",
        source: "user",
        message: "Refund order 12.",
      },
      {
        step_id: 3,
        timestamp: "2026-03-03T09:00:02Z",
        source: "agent",
        message: "Looking it up.",
        llm_call_count: 1,
        metrics: { prompt_tokens: 100, completion_tokens: 20 },
        tool_calls: [
          { tool_call_id: "call-1", function_name: "lookup_order", arguments: { id: 12 } },
          ...(options.subagent
            ? [{ tool_call_id: "call-2", function_name: "delegate", arguments: { task: "check" } }]
            : []),
        ],
        observation: {
          results: [
            {
              source_call_id: "call-1",
              content: "Tool 'lookup_order' failed during execution: not found",
            },
            ...(options.subagent
              ? [
                  {
                    source_call_id: "call-2",
                    content: "done",
                    subagent_trajectory_ref: [{ trajectory_id: subagentId }],
                  },
                ]
              : []),
          ],
        },
      },
      {
        step_id: 4,
        timestamp: "2026-03-03T09:00:09Z",
        source: "agent",
        message: "Order 12 was not found.",
        llm_call_count: 1,
        metrics: { prompt_tokens: 150, completion_tokens: 10 },
      },
    ],
    final_metrics: { total_prompt_tokens: 250, total_completion_tokens: 30, total_steps: 4 },
    ...(options.subagent
      ? {
          subagent_trajectories: [
            {
              schema_version: "ATIF-v1.7",
              trajectory_id: subagentId,
              agent: { name: "checker", version: "1.0.0" },
              steps: [
                { step_id: 1, timestamp: "2026-03-03T09:00:03Z", source: "user", message: "check" },
                {
                  step_id: 2,
                  timestamp: "2026-03-03T09:00:05Z",
                  source: "agent",
                  message: "checked",
                  llm_call_count: 1,
                  metrics: { prompt_tokens: 10, completion_tokens: 5 },
                },
              ],
            },
          ],
        }
      : {}),
    ...(options.userId ? { extra: { user_id: options.userId } } : {}),
  };
}

const LARGE_OUTPUT = "x".repeat(1024 * 1024 + 10);
const langfuseLarge = {
  data: [
    observation(
      "a1b2c3d4e5f60718",
      "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9",
      "SPAN",
      "export-job",
      "2026-03-04T00:00:00.000Z",
      "2026-03-04T00:00:01.000Z",
      { output: LARGE_OUTPUT },
    ),
  ],
};

/** A ZIP archive from entries, as a tool such as `zip` writes it (deflate, no data descriptors). */
function buildZip(
  entries: { name: string; bytes: Uint8Array; stored?: boolean; flags?: number }[],
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.stored ? Buffer.from(entry.bytes) : deflateRawSync(entry.bytes);
    const method = entry.stored ? 0 : 8;
    const crc = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.byteLength, 18);
    local.writeUInt32LE(entry.bytes.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.byteLength, 20);
    central.writeUInt32LE(entry.bytes.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.byteLength + name.byteLength + data.byteLength;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const fixtureFiles = (): Record<string, Uint8Array> => ({
  "exports/batch-1.json": Buffer.from(otlpFile),
  "exports/batch-2.jsonl": Buffer.from(otlpLines),
  "langfuse/page-1.json": Buffer.from(JSON.stringify(langfuseData)),
  "langfuse/native.json": Buffer.from(JSON.stringify(langfuseNative)),
  "atif/run.json": Buffer.from(JSON.stringify(atifExport({ userId: "user-9", subagent: true }))),
  "notes.txt": Buffer.from("not json"),
  "logs.json": Buffer.from(JSON.stringify({ resourceLogs: [] })),
  "packed.json.gz": gzipSync(Buffer.from(otlpFile)),
});

async function writeFixtures(root: string, files: Record<string, Uint8Array>): Promise<void> {
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), bytes);
  }
}

/** Runs the command with captured streams. */
async function run(
  args: string[],
  io: Partial<TracesCommandIo> = {},
): Promise<{ code: number; stdout: string; stderr: string; sleeps: number[] }> {
  let stdout = "";
  let stderr = "";
  const sleeps: number[] = [];
  const code = await runTracesCommand(args, {
    stdout: new Writable({
      write: (chunk, _encoding, done) => ((stdout += String(chunk)), done()),
    }),
    stderr: new Writable({
      write: (chunk, _encoding, done) => ((stderr += String(chunk)), done()),
    }),
    sleep: async (ms) => void sleeps.push(ms),
    onInterrupt: () => () => {},
    checkpointIntervalMs: 0,
    ...io,
  });
  return { code, stdout, stderr, sleeps };
}

async function readManifest(directory: string): Promise<TraceImportManifest> {
  return JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  ) as TraceImportManifest;
}

interface WireSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: Record<string, unknown> }[];
  status: { code: number; message?: string };
  [field: string]: unknown;
}
type PreparedSpan = WireSpan & { resource: Record<string, unknown>; scope: string };

/** Every span of a prepared trace, in batch order, with its resource and scope. */
async function spansOf(directory: string, manifest: TraceImportManifest, traceId: string) {
  const trace = manifest.traces.find((item) => item.trace_id === traceId)!;
  const spans: PreparedSpan[] = [];
  for (const batch of trace.batches) {
    const body = await readFile(join(directory, `${traceId}.${batch.sha256}.json.gz`));
    expect(sha256(body)).toBe(batch.sha256);
    expect(body.byteLength).toBe(batch.bytes);
    const decoded = JSON.parse(gunzipSync(body).toString("utf8")) as {
      resourceSpans: {
        resource?: { attributes?: { key: string; value: Record<string, unknown> }[] };
        scopeSpans: { scope?: { name?: string }; spans: WireSpan[] }[];
      }[];
    };
    for (const group of decoded.resourceSpans)
      for (const scope of group.scopeSpans)
        for (const span of scope.spans)
          spans.push({
            ...span,
            resource: Object.fromEntries(
              (group.resource?.attributes ?? []).map((item) => [item.key, item.value.stringValue]),
            ),
            scope: scope.scope?.name ?? "",
          });
  }
  return spans;
}

const attr = (span: WireSpan, key: string) =>
  span.attributes.find((item) => item.key === key)?.value;
const str = (span: WireSpan, key: string) => attr(span, key)?.stringValue as string | undefined;

// --- Prepare ----------------------------------------------------------------------------------

describe("hue traces import prepare", () => {
  test("recognizes every format by content and lists what it cannot read", async () => {
    const root = await scratch();
    const input = join(root, "bundle");
    await writeFixtures(input, fixtureFiles());
    const result = await run(["import", "prepare", input, "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, any>;
    expect(report.output_directory).toBe(`${input}.hue-import`);
    expect((await stat(report.output_directory)).mode & 0o777).toBe(0o700);
    expect(report.formats).toEqual({ otlp_json: 3, langfuse_observations: 2, atif: 1 });
    expect(report.source).toEqual({
      formats: ["otlp_json", "langfuse_observations", "atif"],
      helper: "hue-sdk",
      helper_version: expect.any(String),
    });
    // T1 2 spans, T2 1, T3 1, L1 3, L2 1, the ATIF run 8 (its user span included).
    expect(report.totals).toEqual({
      traces: 6,
      batches: 6,
      spans: 16,
      blobs: 0,
      bytes: expect.any(Number),
    });
    expect(
      report.files.supported.map((file: any) => [file.file, file.format, file.traces]),
    ).toEqual([
      ["atif/run.json", "atif", 1],
      ["exports/batch-1.json", "otlp_json", 2],
      ["exports/batch-2.jsonl", "otlp_json", 2],
      ["langfuse/native.json", "langfuse_observations", 1],
      ["langfuse/page-1.json", "langfuse_observations", 1],
      // A gzip copy of batch-1.json: the same content, so the same traces and source digest.
      ["packed.json.gz", "otlp_json", 2],
    ]);
    expect(report.files.unsupported).toEqual([
      { file: "logs.json", reason: "an OTLP logs export; only traces are imported" },
      { file: "notes.txt", reason: "not JSON" },
    ]);
    expect(report.files.skipped).toEqual([]);
    // T2 names an entity, T1 and L1 a user, the ATIF export a user; T3 and L2 name nobody.
    expect(report.traces.without_identity).toBe(2);
    // T1 and T2 share a production resource, L1 says production; T3 is an evaluation's.
    expect(report.traces.by_origin).toEqual({
      production: 3,
      evaluation: 1,
      simulation: 0,
      unknown: 2,
    });
    expect(report.traces.remapped).toEqual({ traces: 2, spans: 4 });
    expect(report.traces.refused).toEqual([]);

    const manifest = await readManifest(report.output_directory);
    expect(validateManifest(manifest)).toBeUndefined();
    expect(manifestTotals(manifest)).toEqual(report.totals);
    expect(sha256(await readFile(join(report.output_directory, "manifest.json")))).toBe(
      report.manifest_digest,
    );
    expect(manifest.traces.map((trace) => trace.trace_id)).toEqual(
      [...manifest.traces.map((trace) => trace.trace_id)].sort(),
    );
    const t1 = manifest.traces.find((trace) => trace.trace_id === T1)!;
    expect(t1.identity).toEqual({ user: "user-7", session: "session-3" });
    expect(t1.origin).toBe("production");
    expect(t1.source_digest).toBeUndefined();
    expect(t1.span_count).toBe(2);
    const t2 = manifest.traces.find(
      (trace) => trace.trace_id === "5f2b6c1e7a1d4c5e9b0a3d2e1f4a5b6c",
    )!;
    expect(t2.identity).toEqual({ entity: { namespace: "team", id: "billing" } });
    expect(t2.source_digest).toBe(sha256(otlpFile));
    const t3 = manifest.traces.find(
      (trace) => trace.trace_id === sha256(`otlp.trace:${T3_UUID}`).slice(0, 32),
    )!;
    expect(t3.origin).toBe("evaluation");
    expect(t3.identity).toBeUndefined();

    // OTLP spans are kept as recorded, ids in lowercase hex, time order within the trace.
    const t1Spans = await spansOf(report.output_directory, manifest, T1);
    expect(t1Spans.map((span) => span.spanId)).toEqual([T1_ROOT, T1_CHILD]);
    expect(t1Spans[0]!.events).toEqual((T1_ROOT_SPAN as Record<string, unknown>).events);
    expect(t1Spans[0]!.resource["deployment.environment.name"]).toBe("production");
    expect(t1Spans[1]!.parentSpanId).toBe(T1_ROOT);
    expect(t1Spans[1]!.resource["service.name"]).toBe("chatbot");
    expect(str(t1Spans[1]!, "gen_ai.request.model")).toBe("gpt-5");
    const t2Spans = await spansOf(report.output_directory, manifest, t2.trace_id);
    expect(t2Spans[0]!.spanId).toBe("8a3c1e2d0b4f4a6e");
    expect(attr(t2Spans[0]!, "hue.import.original_span_id")).toBeUndefined();
    const t3Spans = await spansOf(report.output_directory, manifest, t3.trace_id);
    expect(t3Spans[0]!.spanId).toBe(
      sha256(`otlp.span:${t3.trace_id}:${T3_SPAN_UUID}`).slice(0, 16),
    );
    expect(str(t3Spans[0]!, "hue.import.original_trace_id")).toBe(T3_UUID);
    expect(str(t3Spans[0]!, "hue.import.original_span_id")).toBe(T3_SPAN_UUID);

    // Langfuse observations keep their record and envelope; an event lasts no time.
    const l1 = manifest.traces.find(
      (trace) => trace.trace_id === sha256(`langfuse.trace:${L1_UUID}`).slice(0, 32),
    )!;
    expect(l1.identity).toEqual({ user: "user-7", session: "session-3" });
    expect(l1.origin).toBe("production");
    const l1Spans = await spansOf(report.output_directory, manifest, l1.trace_id);
    expect(l1Spans.map((span) => span.name)).toEqual(["support-chat", "gpt-5", "ticket-updated"]);
    const [l1Root, l1Generation, l1Event] = l1Spans as unknown as [
      PreparedSpan,
      PreparedSpan,
      PreparedSpan,
    ];
    expect(l1Root.parentSpanId).toBeUndefined();
    expect(l1Generation.parentSpanId).toBe(l1Root.spanId);
    expect(l1Root.resource["service.name"]).toBe("langfuse-app");
    expect(JSON.parse(str(l1Root, "hue.import.source_record")!)).toEqual(langfuseData.data[0]);
    expect(JSON.parse(str(l1Root, "hue.import.source_envelope")!)).toEqual({
      meta: { page: 1, limit: 100 },
    });
    expect(str(l1Root, "hue.import.original_trace_id")).toBe(L1_UUID);
    expect(str(l1Root, "team")).toBe("support");
    expect(attr(l1Root, "langfuse.observation.input")).toEqual({
      kvlistValue: { values: [{ key: "question", value: { stringValue: "refund?" } }] },
    });
    expect(l1Generation.status).toEqual({ code: 2, message: "rate limited once" });
    expect(attr(l1Generation, "gen_ai.usage.input_tokens")).toEqual({ intValue: "120" });
    expect(attr(l1Generation, "gen_ai.usage.cache_read.input_tokens")).toEqual({ intValue: "20" });
    expect(str(l1Generation, "langfuse.observation.type")).toBe("generation");
    expect(l1Event.endTimeUnixNano).toBe(l1Event.startTimeUnixNano);
    const l2Spans = await spansOf(report.output_directory, manifest, L2);
    expect(l2Spans[0]!.spanId).toBe("53995c3f42cd8ad8");
    expect(attr(l2Spans[0]!, "hue.import.source_envelope")).toEqual({
      stringValue: `{"traceId":"${L2}"}`,
    });

    // ATIF: the run, a model span per agent step, a tool span per call, the embedded subagent
    // under the call that spawned it, and the export's user as its own span.
    const atif = manifest.traces.find(
      (trace) => trace.trace_id.length === 32 && trace.identity?.user === "user-9",
    )!;
    expect(atif.identity).toEqual({ user: "user-9", session: "session-42" });
    expect(atif.origin).toBe("unknown");
    const atifSpans = await spansOf(report.output_directory, manifest, atif.trace_id);
    expect(atifSpans.map((span) => span.name)).toEqual([
      "invoke_agent support-agent",
      "chat",
      "lookup_order",
      "delegate",
      "invoke_agent checker",
      "chat",
      "chat",
      "hue.import.user",
    ]);
    const [atifRoot, step3, lookup, delegate, subagent, subStep] = atifSpans as WireSpan[];
    expect(step3!.parentSpanId).toBe(atifRoot!.spanId);
    expect(lookup!.parentSpanId).toBe(step3!.spanId);
    // ATIF records a tool's result text, not its outcome: no exporter's failure wording is
    // read as an error status; the result stays in the record.
    expect(lookup!.status.code).toBe(0);
    expect(attr(lookup!, "hue.import.status_source")).toBeUndefined();
    expect(JSON.parse(str(lookup!, "gen_ai.tool.call.result")!)).toBe(
      "Tool 'lookup_order' failed during execution: not found",
    );
    expect(delegate!.status.code).toBe(0);
    expect(delegate!.endTimeUnixNano).toBe("1772528405000000000");
    expect(subagent!.parentSpanId).toBe(delegate!.spanId);
    expect(str(subagent!, "hue.agent.role")).toBe("subagent");
    expect(subStep!.parentSpanId).toBe(subagent!.spanId);
    expect(str(atifRoot!, "hue.import.format")).toBe("atif");
    expect(str(atifRoot!, "hue.agent.role")).toBe("orchestrator");
    expect(str(atifRoot!, "hue.import.source_record_scope")).toBe(
      "export_without_embedded_subagents",
    );
    expect(attr(atifRoot!, "gen_ai.usage.input_tokens")).toEqual({ intValue: "250" });
    expect(str(step3!, "hue.import.source_index")).toBeUndefined();
    expect(attr(step3!, "hue.import.source_index")).toEqual({ intValue: "2" });
    expect(atifSpans[0]!.scope).toBe("hue.import.atif");
    // No producer's name in any span name, format label or scope.
    for (const span of atifSpans) {
      expect(span.name).not.toMatch(/auctor/i);
      expect(span.scope).not.toMatch(/auctor/i);
      expect(str(span, "hue.import.format") ?? "").not.toMatch(/auctor/i);
    }
    expect(atifSpans.at(-1)!.attributes).toEqual([
      { key: "user.id", value: { stringValue: "user-9" } },
    ]);
    for (const span of [...t1Spans, ...l1Spans, ...atifSpans])
      for (const item of span.attributes)
        expect(item.key).not.toMatch(/^hue\.import\.(source_file|archive|salesforce|source_spec)/);
  });

  test("converts a renamed, reordered or zipped copy of the bundle to identical batches", async () => {
    const root = await scratch();
    const files = fixtureFiles();
    const first = join(root, "first");
    await writeFixtures(first, files);
    const second = join(root, "second");
    await writeFixtures(
      second,
      Object.fromEntries(
        Object.entries(files).map(([name, bytes], index) => [
          `other/${index}-${name.split("/").at(-1)}`,
          bytes,
        ]),
      ),
    );
    const zipped = join(root, "bundle.zip");
    await writeFile(
      zipped,
      buildZip(
        Object.entries(files)
          .reverse()
          .map(([name, bytes], index) => ({
            name: `archive/${name}`,
            bytes,
            stored: index % 2 === 0,
          })),
      ),
    );
    const reports = [];
    for (const input of [first, second, zipped]) {
      const result = await run(["import", "prepare", input, "--json", "--out", `${input}.out`]);
      expect(result.code).toBe(0);
      reports.push(JSON.parse(result.stdout) as Record<string, any>);
    }
    const [a, b, c] = reports as [Record<string, any>, Record<string, any>, Record<string, any>];
    expect(b.manifest_digest).toBe(a.manifest_digest);
    expect(c.manifest_digest).toBe(a.manifest_digest);
    expect(await readFile(join(b.output_directory, "manifest.json"))).toEqual(
      await readFile(join(a.output_directory, "manifest.json")),
    );
    const listing = async (directory: string) => (await readdir(directory)).sort();
    expect(await listing(b.output_directory)).toEqual(await listing(a.output_directory));
    expect(await listing(c.output_directory)).toEqual(await listing(a.output_directory));
    expect(c.files.supported.map((file: any) => file.file)).toContain(
      "bundle.zip/archive/atif/run.json",
    );
    expect(c.files.unsupported.map((file: any) => file.file)).toContain(
      "bundle.zip/archive/notes.txt",
    );
  });

  test("stores a value over the inline limit apart from its span and lists it", async () => {
    const root = await scratch();
    const input = join(root, "large.json");
    await writeFile(input, JSON.stringify(langfuseLarge));
    const result = await run(["import", "prepare", input, "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, any>;
    // The output, and the whole source record that carries it, are each stored apart.
    expect(report.totals.blobs).toBe(2);
    const manifest = await readManifest(report.output_directory);
    const digest = sha256(LARGE_OUTPUT);
    const record = JSON.stringify(langfuseLarge.data[0]);
    const recordDigest = sha256(record);
    // The manifest lists a trace's values in digest order.
    expect(manifest.traces[0]!.blobs).toEqual(
      [
        {
          sha256: recordDigest,
          byte_size: Buffer.byteLength(record),
          content_type: textContentType(record),
        },
        {
          sha256: digest,
          byte_size: LARGE_OUTPUT.length,
          content_type: "text/plain; charset=utf-8",
        },
      ].sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1)),
    );
    const blob = await readFile(join(report.output_directory, `${digest}.blob`));
    expect(blob.toString("utf8")).toBe(LARGE_OUTPUT);
    expect((await stat(join(report.output_directory, `${digest}.blob`))).mode & 0o777).toBe(0o600);
    expect(
      (await readFile(join(report.output_directory, `${recordDigest}.blob`))).toString("utf8"),
    ).toBe(record);
    const [span] = await spansOf(report.output_directory, manifest, manifest.traces[0]!.trace_id);
    expect(str(span!, "langfuse.observation.output")).toBe("x".repeat(16 * 1024));
    expect(str(span!, "hue.import.source_record")).toBe(record.slice(0, 16 * 1024));
    expect(attr(span!, "hue.blobs")).toEqual({
      arrayValue: {
        values: [
          {
            stringValue: JSON.stringify({
              key: "hue.import.source_record",
              sha256: recordDigest,
              size: Buffer.byteLength(record),
              content_type: textContentType(record),
            }),
          },
          {
            stringValue: JSON.stringify({
              key: "langfuse.observation.output",
              sha256: digest,
              size: LARGE_OUTPUT.length,
              content_type: "text/plain; charset=utf-8",
            }),
          },
        ],
      },
    });
    expect(attr(span!, "hue.truncated")).toEqual({
      arrayValue: {
        values: [
          { stringValue: "hue.import.source_record" },
          { stringValue: "langfuse.observation.output" },
        ],
      },
    });
  });

  test("refuses conflicting copies of a span and reports malformed records", async () => {
    const root = await scratch();
    const input = join(root, "bundle");
    const changed = { ...T1_ROOT_SPAN, name: "POST /chat (edited)" };
    await writeFixtures(input, {
      "a.json": Buffer.from(JSON.stringify(envelope({}, [T1_ROOT_SPAN, T1_CHILD_SPAN]))),
      "b.json": Buffer.from(JSON.stringify(envelope({}, [changed]))),
      "c.json": Buffer.from(
        JSON.stringify(
          envelope({}, [
            T2_SPAN,
            { ...T3_SPAN, endTimeUnixNano: "1" },
            { ...T3_SPAN, spanId: "0000000000000000" },
          ]),
        ),
      ),
    });
    const result = await run(["import", "prepare", input, "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, any>;
    // T1 is refused whole for its conflicting copies; T3 for its span whose end precedes its start,
    // named with the file, so no trace is prepared without one of its spans. T2 is prepared.
    expect(report.totals.traces).toBe(1);
    expect(report.traces.refused).toEqual([
      {
        file: "c.json",
        trace_id: sha256(`otlp.trace:${T3_UUID}`).slice(0, 32),
        reason: expect.stringContaining("has no valid end time"),
      },
      { trace_id: T1, reason: `span ${T1_ROOT} appears with different content` },
    ]);
    expect(report.traces.remapped).toEqual({ traces: 0, spans: 0 });
    const empty = join(root, "empty");
    await mkdir(empty);
    const nothing = await run(["import", "prepare", empty]);
    expect(nothing.code).toBe(1);
    expect(nothing.stderr).toContain("No trace was recognized");
    const taken = await run(["import", "prepare", input, "--out", input]);
    expect(taken.code).toBe(1);
    expect(taken.stderr).toContain("is not empty");
  });

  test("checks the manifest rules Hue applies", () => {
    const batch = { sha256: "a".repeat(64), bytes: 10, span_count: 1 };
    const trace = {
      trace_id: T1,
      span_count: 1,
      batches: [batch],
      blobs: [],
      origin: "unknown" as const,
    };
    const manifest = (traces: unknown[]) => ({
      version: 1,
      source: { formats: ["otlp_json"], helper: "hue-sdk" },
      traces,
    });
    expect(validateManifest(manifest([trace]))).toBeUndefined();
    expect(validateManifest(manifest([trace, trace]))).toContain("more than once");
    expect(validateManifest(manifest([trace, { ...trace, trace_id: L2 }]))).toContain(
      `batch ${"a".repeat(64)} more than once`,
    );
    expect(validateManifest(manifest([{ ...trace, span_count: 2 }]))).toContain("declares 2 spans");
    const blob = { sha256: "b".repeat(64), byte_size: 5, content_type: "text/plain" };
    expect(validateManifest(manifest([{ ...trace, blobs: [blob, blob] }]))).toContain(
      "lists value",
    );
    expect(validateManifest(manifest([{ ...trace, identity: { user: "" } }]))).toContain(
      "identity",
    );
    expect(validateManifest(manifest([]))).toContain("no traces");
    expect(validateManifest({ ...manifest([trace]), version: 2 })).toContain("version");
    // The ceilings current servers accept: 512 batches and 10,000 values a trace, 25,000 traces.
    const batches = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        sha256: sha256(`batch-${index}`),
        bytes: 10,
        span_count: 1,
      }));
    const withBatches = (count: number) => ({
      ...trace,
      span_count: count,
      batches: batches(count),
    });
    expect(validateManifest(manifest([withBatches(65)]))).toBeUndefined();
    expect(validateManifest(manifest([withBatches(512)]))).toBeUndefined();
    expect(validateManifest(manifest([withBatches(513)]))).toContain("invalid batch list");
    const values = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        sha256: sha256(`value-${index}`),
        byte_size: 5,
        content_type: "text/plain",
      }));
    expect(validateManifest(manifest([{ ...trace, blobs: values(1_001) }]))).toBeUndefined();
    expect(validateManifest(manifest([{ ...trace, blobs: values(10_000) }]))).toBeUndefined();
    expect(validateManifest(manifest([{ ...trace, blobs: values(10_001) }]))).toContain(
      "invalid value list",
    );
    const traces = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ...trace,
        trace_id: sha256(`trace-${index}`).slice(0, 32),
        batches: [{ ...batch, sha256: sha256(`trace-batch-${index}`) }],
      }));
    expect(validateManifest(manifest(traces(25_000)))).toBeUndefined();
    expect(validateManifest(manifest(traces(25_001)))).toContain("more than 25000 traces");
  });

  test("refuses an upload whose valid manifest Hue could not register, before any request", async () => {
    // Valid in every rule, and over the 32 MiB decoded bound: 2,100 traces whose history owner
    // is a 16 KiB identifier (the longest the manifest allows).
    const traces = Array.from({ length: 2_100 }, (_, index) => ({
      trace_id: sha256(`big-${index}`).slice(0, 32),
      span_count: 1,
      batches: [{ sha256: sha256(`big-batch-${index}`), bytes: 10, span_count: 1 }],
      blobs: [],
      identity: { user: "u".repeat(16_384) },
      origin: "unknown",
    }));
    const manifest = { version: 1, source: { formats: ["otlp_json"], helper: "hue-sdk" }, traces };
    expect(validateManifest(manifest)).toBeUndefined();
    const bytes = Buffer.from(JSON.stringify(manifest));
    expect(bytes.byteLength).toBeGreaterThan(32 * 1024 * 1024);
    const directory = await scratch();
    await writeFile(join(directory, "manifest.json"), bytes);
    const file = await authorizationFile(directory, [
      TOKEN,
      `http://127.0.0.1:9/api/v1/trace-imports/${IMPORT_ID}`,
    ]);
    let requests = 0;
    const result = await run(
      ["import", "upload", directory, "--authorization-file", file, "--json"],
      {
        fetch: async () => {
          requests++;
          throw new Error("no request was expected");
        },
      },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("over the 32 MiB");
    expect(result.stderr).toContain("prepare the input in smaller parts");
    expect(requests).toBe(0);
    expect(await readdir(directory)).not.toContain("progress.json");
  });

  test("refuses a manifest Hue could not register before anything is sent", () => {
    expect(manifestTooLarge(Buffer.from(JSON.stringify({ version: 1 })))).toBeUndefined();
    // Over the decoded bound, however well it compresses.
    expect(manifestTooLarge(Buffer.alloc(32 * 1024 * 1024 + 1))).toContain("over the 32 MiB");
    // Within the decoded bound, over the 4 MiB a gzip registration takes.
    expect(manifestTooLarge(randomBytes(5 * 1024 * 1024))).toContain("compressed, over the 4 MiB");
  });

  test("reads ZIP members in memory within bounds and refuses unsafe ones", async () => {
    const root = await scratch();
    const inner = buildZip([{ name: "inner.json", bytes: Buffer.from(otlpFile) }]);
    const archive = buildZip([
      { name: "ok/batch.json", bytes: Buffer.from(otlpFile) },
      { name: "../evil.json", bytes: Buffer.from(otlpFile) },
      { name: "/abs.json", bytes: Buffer.from(otlpFile) },
      { name: "locked.json", bytes: Buffer.from(otlpFile), flags: 0x801 },
      { name: "nested.zip", bytes: inner },
      { name: "folder/", bytes: new Uint8Array(0), stored: true },
    ]);
    const path = join(root, "bundle.zip");
    await writeFile(path, archive);
    const zip = await ZipArchive.open(path);
    expect(zip.members.map((member) => [member.path, member.refused])).toEqual([
      ["ok/batch.json", undefined],
      ["../evil.json", "a relative path segment"],
      ["/abs.json", "an absolute path"],
      ["locked.json", "an encrypted member"],
      ["nested.zip", undefined],
      ["folder/", undefined],
    ]);
    expect(Buffer.from(await zip.read(zip.members[0]!)).toString("utf8")).toBe(otlpFile);
    await zip.close();
    expect(unsafeZipPath("a\\b")).toBe("a backslash in the name");
    expect(unsafeZipPath("C:/x")).toBe("an absolute path");
    expect(unsafeZipPath("fine/name.json")).toBeUndefined();
    // A member whose bytes do not match its recorded CRC is refused when read.
    const corrupt = Buffer.from(archive);
    const data = deflateRawSync(Buffer.from(otlpFile));
    corrupt.set(Buffer.from([0xff]), 30 + "ok/batch.json".length + Math.floor(data.byteLength / 2));
    await writeFile(path, corrupt);
    const bad = await ZipArchive.open(path);
    await expect(bad.read(bad.members[0]!)).rejects.toThrow(/CRC-32|invalid|size/);
    await bad.close();
    await writeFile(path, archive);
    const result = await run(["import", "prepare", path, "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, any>;
    expect(report.files.unsupported).toEqual([
      { file: "bundle.zip/../evil.json", reason: "a relative path segment" },
      { file: "bundle.zip//abs.json", reason: "an absolute path" },
      { file: "bundle.zip/locked.json", reason: "an encrypted member" },
      { file: "bundle.zip/nested.zip", reason: "a ZIP archive inside the input; extract it first" },
    ]);
    expect(report.totals.traces).toBe(2);
  });

  test("detects formats from content", () => {
    /** The format of a file's first value (or its first record), or why none claims it. */
    const formatOf = (bytes: Uint8Array) => {
      const decoded = decodeContainer(bytes, 64 * 1024 * 1024);
      if ("unsupported" in decoded) return decoded.unsupported;
      const parsed = parseValues(decoded.bytes);
      if ("unsupported" in parsed) return parsed.unsupported;
      const value = parsed.values[0]!.value;
      const record = Array.isArray(value) ? value[0] : undefined;
      return adapterFor(value)?.id ?? adapterFor(record)?.id ?? unrecognizedReason(value);
    };
    expect(formatOf(Buffer.from(otlpFile))).toBe("otlp_json");
    expect(formatOf(Buffer.from(otlpLines))).toBe("otlp_json");
    expect(formatOf(Buffer.from(JSON.stringify([JSON.parse(otlpFile)])))).toBe("otlp_json");
    expect(formatOf(Buffer.from(JSON.stringify({ resource_spans: [] })))).toBe("otlp_json");
    expect(formatOf(Buffer.from(JSON.stringify(langfuseData)))).toBe("langfuse_observations");
    expect(formatOf(Buffer.from(JSON.stringify(langfuseNative)))).toBe("langfuse_observations");
    expect(formatOf(Buffer.from(JSON.stringify(atifExport())))).toBe("atif");
    expect(formatOf(Buffer.from("\uFEFF" + otlpFile))).toBe("otlp_json");
    expect(formatOf(gzipSync(Buffer.from(otlpFile)))).toBe("otlp_json");
    expect(formatOf(Buffer.from([0xc3, 0x28, 0x7b]))).toBe("not UTF-8 text (line 1)");
    // A UTF-16 byte order mark: UTF-16 text, or nothing readable.
    expect(formatOf(Buffer.from([0xff, 0xfe, 0x00]))).toBe("not UTF-16 text");
    expect(formatOf(Buffer.from(`\uFEFF${otlpFile}`, "utf16le"))).toBe("otlp_json");
    expect(formatOf(Buffer.from('{"data": [1]}'))).toBe("a JSON document of no recognized format");
    expect(formatOf(Buffer.from('{"data": []}'))).toBe("an export page with no records");
    expect(formatOf(Buffer.from("[]"))).toBe("an empty JSON array");
    expect(formatOf(new Uint8Array(0))).toBe("the file is empty");
  });

  test("lists a trace's large values in digest order, whatever order its sources are read in", async () => {
    const big = (fill: string) => fill.repeat(1024 * 1024 + 1);
    const spanA = otlpSpan(
      { traceId: T1, spanId: T1_ROOT },
      "a",
      "1760000000000000000",
      "1760000001000000000",
      { payload: big("a") },
    );
    const spanB = otlpSpan(
      { traceId: T1, spanId: T1_CHILD, parentSpanId: T1_ROOT },
      "b",
      "1760000000500000000",
      "1760000000600000000",
      { payload: big("b") },
    );
    const root = await scratch();
    const ordered = join(root, "ordered");
    await writeFixtures(ordered, {
      "1.json": Buffer.from(JSON.stringify(envelope({}, [spanA]))),
      "2.json": Buffer.from(JSON.stringify(envelope({}, [spanB]))),
    });
    const reversed = join(root, "reversed");
    await writeFixtures(reversed, {
      "1.json": Buffer.from(JSON.stringify(envelope({}, [spanB]))),
      "2.json": Buffer.from(JSON.stringify(envelope({}, [spanA]))),
    });
    const reports = [];
    for (const input of [ordered, reversed]) {
      const result = await run(["import", "prepare", input, "--json"]);
      expect(result.code).toBe(0);
      reports.push(JSON.parse(result.stdout) as Record<string, any>);
    }
    expect(reports[1]!.manifest_digest).toBe(reports[0]!.manifest_digest);
    const manifest = await readManifest(reports[0]!.output_directory);
    const digests = manifest.traces[0]!.blobs.map((blob) => blob.sha256);
    expect(digests).toHaveLength(2);
    expect(digests).toEqual([...digests].sort());
  });

  test("declares a Langfuse trace's origin from the markers its records carry, beyond its environment", async () => {
    const exportOf = (traceId: string, fields: Record<string, unknown>) => ({
      data: [
        observation(
          traceId.slice(0, 16),
          traceId,
          "SPAN",
          "run",
          "2026-03-01T10:00:00.000Z",
          "2026-03-01T10:00:01.000Z",
          { environment: "production", ...fields },
        ),
      ],
    });
    const root = await scratch();
    const input = join(root, "bundle");
    const ids = ["a1", "b2", "c3", "d4"].map((seed) => seed.repeat(16));
    await writeFixtures(input, {
      "evaluation.json": Buffer.from(
        JSON.stringify(exportOf(ids[0]!, { metadata: { "hue.execution.id": "exec-1" } })),
      ),
      "simulation-scope.json": Buffer.from(
        JSON.stringify(exportOf(ids[1]!, { metadata: { "scope.name": "hue.sim-gateway" } })),
      ),
      "simulation-resource.json": Buffer.from(
        JSON.stringify(
          exportOf(ids[2]!, { metadata: { "resourceAttributes.hue.world.id": "world-1" } }),
        ),
      ),
      "production.json": Buffer.from(JSON.stringify(exportOf(ids[3]!, {}))),
    });
    const result = await run(["import", "prepare", input, "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, any>;
    expect(report.traces.by_origin).toEqual({
      production: 1,
      evaluation: 1,
      simulation: 2,
      unknown: 0,
    });
    const manifest = await readManifest(report.output_directory);
    const originOf = (traceId: string) =>
      manifest.traces.find((trace) => trace.trace_id === traceId)!.origin;
    expect(ids.map(originOf)).toEqual(["evaluation", "simulation", "simulation", "production"]);
  });

  test("declares an explicit owner a Langfuse root names in its metadata or resource attributes", async () => {
    const exportOf = (traceId: string, fields: Record<string, unknown>) => ({
      data: [
        observation(
          traceId.slice(0, 16),
          traceId,
          "SPAN",
          "run",
          "2026-03-01T10:00:00.000Z",
          "2026-03-01T10:00:01.000Z",
          fields,
        ),
      ],
    });
    const root = await scratch();
    const input = join(root, "bundle");
    const ids = ["e5", "f6", "a7"].map((seed) => seed.repeat(16));
    await writeFixtures(input, {
      "metadata.json": Buffer.from(
        JSON.stringify(
          exportOf(ids[0]!, {
            metadata: { "hue.world.entity.namespace": "team", "hue.world.entity.id": "billing" },
          }),
        ),
      ),
      "resource.json": Buffer.from(
        JSON.stringify(
          exportOf(ids[1]!, {
            metadata: {
              "resourceAttributes.hue.world.entity.namespace": "org",
              "resourceAttributes.hue.world.entity.id": "acme",
            },
          }),
        ),
      ),
      "both.json": Buffer.from(
        JSON.stringify(
          exportOf(ids[2]!, {
            userId: "user-7",
            sessionId: "session-3",
            metadata: { "hue.world.entity.namespace": "team", "hue.world.entity.id": "support" },
          }),
        ),
      ),
    });
    const result = await run(["import", "prepare", input, "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, any>;
    expect(report.traces.without_identity).toBe(0);
    const manifest = await readManifest(report.output_directory);
    const identityOf = (traceId: string) =>
      manifest.traces.find((trace) => trace.trace_id === traceId)!.identity;
    expect(identityOf(ids[0]!)).toEqual({ entity: { namespace: "team", id: "billing" } });
    expect(identityOf(ids[1]!)).toEqual({ entity: { namespace: "org", id: "acme" } });
    // The explicit entity is the owner Hue captures, over the root's user.
    expect(identityOf(ids[2]!)).toEqual({
      entity: { namespace: "team", id: "support" },
      session: "session-3",
    });
  });

  test("reads an export that mixes proto field names with camelCase at any depth", async () => {
    const mixed = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { string_value: "mixed" } }] },
          scope_spans: [
            {
              scope: { name: "mixed-exporter" },
              spans: [
                {
                  trace_id: T1,
                  span_id: T1_ROOT,
                  name: "root",
                  kind: 1,
                  start_time_unix_nano: "1760000000000000000",
                  end_time_unix_nano: "1760000001000000000",
                  attributes: [],
                  status: { code: 0 },
                },
              ],
            },
          ],
        },
      ],
    };
    const root = await scratch();
    const input = join(root, "mixed.json");
    await writeFile(input, JSON.stringify(mixed));
    const result = await run(["import", "prepare", input, "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, any>;
    expect(report.totals).toMatchObject({ traces: 1, spans: 1 });
    const manifest = await readManifest(report.output_directory);
    const [span] = await spansOf(report.output_directory, manifest, T1);
    expect(span!.spanId).toBe(T1_ROOT);
    expect(span!.startTimeUnixNano).toBe("1760000000000000000");
    expect(span!.resource["service.name"]).toBe("mixed");
    expect(span!.scope).toBe("mixed-exporter");
  });

  test.skipIf(!PERMISSIONS_ENFORCED)(
    "reports a file or directory it cannot open and prepares the rest",
    async () => {
      const root = await scratch();
      const input = join(root, "bundle");
      await writeFixtures(input, {
        "a.json": Buffer.from(otlpFile),
        "locked.json": Buffer.from(otlpFile),
      });
      await chmod(join(input, "locked.json"), 0o000);
      await mkdir(join(input, "sealed"));
      await chmod(join(input, "sealed"), 0o000);
      try {
        const result = await run(["import", "prepare", input, "--json"]);
        expect(result.code).toBe(0);
        const report = JSON.parse(result.stdout) as Record<string, any>;
        expect(report.files.unsupported).toEqual([
          { file: "locked.json", reason: "the file could not be read (EACCES)" },
          { file: "sealed", reason: "the directory could not be read (EACCES)" },
        ]);
        expect(report.totals.traces).toBe(2);
      } finally {
        await chmod(join(input, "locked.json"), 0o600);
        await chmod(join(input, "sealed"), 0o700);
      }
    },
  );

  test("closes each archive once its members were read, before opening the next", async () => {
    const root = await scratch();
    const input = join(root, "bundle");
    const files: Record<string, Uint8Array> = {};
    for (let index = 0; index < 3; index++) {
      const traceId = `${index + 1}`.repeat(32);
      files[`${index}.zip`] = buildZip([
        {
          name: "a.json",
          bytes: Buffer.from(
            JSON.stringify(
              envelope({}, [
                otlpSpan(
                  { traceId, spanId: "1".repeat(16) },
                  "job",
                  "1760000000000000000",
                  "1760000001000000000",
                ),
              ]),
            ),
          ),
        },
      ]);
    }
    await writeFixtures(input, files);
    const events: string[] = [];
    const originalOpen = ZipArchive.open.bind(ZipArchive);
    const originalClose = ZipArchive.prototype.close;
    const openSpy = spyOn(ZipArchive, "open").mockImplementation(async (path: string) => {
      events.push("open");
      return originalOpen(path);
    });
    const closeSpy = spyOn(ZipArchive.prototype, "close").mockImplementation(async function (
      this: ZipArchive,
    ) {
      events.push("close");
      return originalClose.call(this);
    });
    try {
      const result = await run(["import", "prepare", input, "--json"]);
      expect(result.code).toBe(0);
      expect((JSON.parse(result.stdout) as Record<string, any>).totals.traces).toBe(3);
      expect(events).toEqual(["open", "close", "open", "close", "open", "close"]);
    } finally {
      openSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  test("refuses a ZIP member whose compressed size does not fit its decoded size", async () => {
    const root = await scratch();
    const archive = buildZip([
      { name: "a.json", bytes: Buffer.from(otlpFile) },
      { name: "b.json", bytes: Buffer.from(otlpFile), stored: true },
    ]);
    // The central directory starts where the end record says; each entry keeps its compressed
    // size at +20 and its name, extra and comment lengths at +28, +30 and +32.
    const end = archive.length - 22;
    const first = archive.readUInt32LE(end + 16);
    const patched = Buffer.from(archive);
    patched.writeUInt32LE(0x7fff0000, first + 20);
    const second =
      first +
      46 +
      patched.readUInt16LE(first + 28) +
      patched.readUInt16LE(first + 30) +
      patched.readUInt16LE(first + 32);
    patched.writeUInt32LE(patched.readUInt32LE(second + 20) + 1, second + 20);
    const path = join(root, "bundle.zip");
    await writeFile(path, patched);
    const zip = await ZipArchive.open(path);
    try {
      expect(zip.members.map((member) => member.refused)).toEqual([
        "a member whose compressed size does not fit its recorded size",
        "a member whose compressed size does not fit its recorded size",
      ]);
      // A member built past the bound is held to it before any of its bytes are allocated.
      await expect(
        zip.read({ ...zip.members[0]!, refused: undefined, compressedSize: 0x7fff0000 }),
      ).rejects.toThrow("compressed data exceeds");
    } finally {
      await zip.close();
    }
    const result = await run(["import", "prepare", path, "--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("compressed size does not fit");
  });

  test("packs incompressible entries into batches under the wire cap, the same way every time", () => {
    // Deterministic pseudo-random hex, about 120 KiB an entry, which gzip halves at best: twenty
    // entries exceed the wire cap and force the sealer to shrink by its observed ratio.
    let seed = "hue-import-seal";
    const chunk = () => {
      let out = "";
      while (out.length < 120 * 1024) {
        seed = sha256(seed);
        out += seed;
      }
      return out;
    };
    const entries = Array.from({ length: 20 }, (_, index) => ({
      resource: { attributes: [] },
      scopeSpans: [
        {
          scope: { name: "seal" },
          spans: [
            {
              traceId: T1,
              spanId: (index + 1).toString(16).padStart(16, "0"),
              name: "s",
              kind: 1,
              startTimeUnixNano: "1",
              endTimeUnixNano: "2",
              attributes: [{ key: "payload", value: { stringValue: chunk() } }],
              status: { code: 0 },
            },
          ],
        },
      ],
    }));
    const first = batchEntries(entries);
    const second = batchEntries(entries);
    expect(first.length).toBeGreaterThan(1);
    expect(first.map((batch) => batch.sha256)).toEqual(second.map((batch) => batch.sha256));
    for (const batch of first) expect(batch.body.byteLength).toBeLessThanOrEqual(900 * 1024);
    expect(first.flatMap((batch) => batch.spanIds)).toEqual(
      entries.map((entry) => entry.scopeSpans[0]!.spans[0]!.spanId),
    );
    expect(integerQuotient(7, 2)).toBe(3);
    expect(integerQuotient(0, 5)).toBe(0);
    expect(integerQuotient(2_621_440 * 921_600 * 9, 1_000_003 * 10)).toBe(
      Math.floor((2_621_440 * 921_600 * 9) / (1_000_003 * 10)),
    );
  });

  test("removes its own temporary files from an interrupted preparation and refuses other files", async () => {
    const { directory, manifest } = await preparedBundle({ "a.json": Buffer.from(otlpFile) });
    const input = directory.replace(/\.hue-import$/, "");
    const trace = manifest.traces[0]!;
    const leftovers = [
      "manifest.json.tmp",
      `${trace.trace_id}.${trace.batches[0]!.sha256}.json.gz.tmp`,
      `${"c".repeat(64)}.blob.tmp`,
      "progress.json.tmp",
    ];
    for (const name of leftovers) await writeFile(join(directory, name), "partial");
    const again = await run(["import", "prepare", input, "--out", directory, "--json"]);
    expect(again.code).toBe(0);
    const names = await readdir(directory);
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    const report = JSON.parse(again.stdout) as Record<string, any>;
    expect(report.manifest_digest).toBe(sha256(await readFile(join(directory, "manifest.json"))));
    // A file of another origin, even one ending in .tmp, still refuses the directory.
    await writeFile(join(directory, "notes.tmp"), "foreign");
    const refused = await run(["import", "prepare", input, "--out", directory]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("is not empty (notes.tmp)");
    await rm(join(directory, "notes.tmp"));
    // A directory wearing a temporary name is not this helper's file either.
    await mkdir(join(directory, "manifest.json.tmp"));
    const blocked = await run(["import", "prepare", input, "--out", directory]);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain("is not empty (manifest.json.tmp)");
  });

  test("prints usage for bad arguments", async () => {
    expect((await run(["import"])).code).toBe(2);
    expect((await run(["export", "prepare", "x"])).stderr).toContain("Unknown command");
    expect((await run(["import", "prepare"])).stderr).toContain("Name the file");
    expect((await run(["import", "prepare", "a", "b"])).stderr).toContain("Unexpected argument");
    expect((await run(["import", "upload", "dir"])).stderr).toContain(
      "--authorization-file is required",
    );
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toBe(`${TRACES_USAGE}\n`);
  });
});

// --- Upload ----------------------------------------------------------------------------------

interface HueOptions {
  /** Answers a request instead of the routes, when it returns one. */
  before?: (
    request: Request,
    url: URL,
    count: number,
  ) => Response | undefined | Promise<Response | undefined>;
  /** Answers the n-th batch request (from 1) after ingesting it, when it returns one. */
  afterBatch?: (index: number) => Response | undefined;
  /** Spans Hue already holds, keyed `<traceId>/<spanId>`, as canonical JSON. */
  held?: Record<string, string>;
}

/** A loopback Hue: the import routes under `/api/v1/trace-imports/<id>` and a store for values. */
function hue(options: HueOptions = {}) {
  const base = `/api/v1/trace-imports/${IMPORT_ID}`;
  const spans = new Map<string, string>(Object.entries(options.held ?? {}));
  const batches = new Map<
    string,
    { traceId: string; state: "pending" | "landed" | "conflict"; posts: number }
  >();
  const blobs = new Map<
    string,
    { byteSize: number; contentType: string; stored: boolean; completed: boolean }
  >();
  const store = new Map<string, Buffer>();
  const requests: { method: string; path: string; authorization: string | null }[] = [];
  let manifest: TraceImportManifest | undefined;
  let manifestDigest = "";
  let completed = false;
  let batchRequests = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const verifiedTraces = () =>
    (manifest?.traces ?? []).filter(
      (trace) =>
        trace.batches.every((batch) => batches.get(batch.sha256)?.state === "landed") &&
        trace.blobs.every((blob) => blobs.get(`${trace.trace_id}/${blob.sha256}`)?.completed),
    );
  const refusal = (
    status: number,
    error: string,
    code: string,
    headers: Record<string, string> = {},
  ) =>
    Response.json({ error, code }, { status, headers: { "Hue-Refusal-Code": code, ...headers } });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request: Request): Promise<Response> {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await handle(request);
      } finally {
        inFlight--;
      }
    },
  });
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    requests.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.get("authorization"),
    });
    const hooked = await options.before?.(request, url, requests.length);
    if (hooked) return hooked;
    if (url.pathname.startsWith("/store/")) {
      expect(request.headers.get("authorization")).toBeNull();
      const bytes = Buffer.from(await request.arrayBuffer());
      const key = url.pathname.slice("/store/".length);
      const [, digest] = key.split("/");
      if (sha256(bytes) !== digest) return new Response("checksum", { status: 400 });
      if (
        request.headers.get("x-amz-checksum-sha256") !==
        Buffer.from(digest!, "hex").toString("base64")
      )
        return new Response("signature", { status: 403 });
      if (store.has(key)) return new Response(null, { status: 412 });
      store.set(key, bytes);
      return new Response(null, { status: 200 });
    }
    if (!url.pathname.startsWith(base))
      return refusal(404, "Import not found.", "import_not_found");
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`)
      return refusal(401, "A valid import authorization is required.", "unauthorized");
    if (completed) return refusal(410, "This import already completed.", "import_completed");
    const action = url.pathname.slice(base.length);
    if (request.method === "PUT" && action === "/manifest") {
      let bytes = Buffer.from(await request.arrayBuffer());
      if (request.headers.get("content-encoding") === "gzip") bytes = gunzipSync(bytes);
      if (manifest) {
        if (sha256(bytes) !== manifestDigest)
          return refusal(
            409,
            "The manifest's SHA-256 is not the digest this import was prepared with.",
            "digest_mismatch",
          );
        return Response.json({
          trace_import: { id: IMPORT_ID, state: "registered" },
          registered: false,
        });
      }
      manifest = JSON.parse(bytes.toString("utf8")) as TraceImportManifest;
      manifestDigest = sha256(bytes);
      for (const trace of manifest.traces) {
        for (const batch of trace.batches)
          batches.set(batch.sha256, { traceId: trace.trace_id, state: "pending", posts: 0 });
        for (const blob of trace.blobs)
          blobs.set(`${trace.trace_id}/${blob.sha256}`, {
            byteSize: blob.byte_size,
            contentType: blob.content_type,
            stored: false,
            completed: false,
          });
      }
      return Response.json(
        { trace_import: { id: IMPORT_ID, state: "registered" }, registered: true },
        { status: 201 },
      );
    }
    if (!manifest) return refusal(409, "Register the import manifest first.", "unregistered");
    if (request.method === "POST" && action === "/blobs") {
      const body = (await request.json()) as {
        traceId: string;
        sha256: string;
        byteSize: number;
        contentType: string;
      };
      const key = `${body.traceId}/${body.sha256}`;
      const declared = blobs.get(key);
      if (!declared)
        return refusal(
          403,
          "The value is not declared by this import's manifest.",
          "blob_undeclared",
        );
      if (declared.byteSize !== body.byteSize)
        return Response.json(
          { error: "This sha256 was reserved with a different byteSize.", status: "size" },
          { status: 409 },
        );
      if (store.has(key)) return Response.json({ status: "exists", ref: {} });
      return Response.json({
        status: "upload",
        url: `http://127.0.0.1:${server.port}/store/${key}`,
        method: "PUT",
        headers: {
          "Content-Type": body.contentType,
          "Content-Length": String(body.byteSize),
          "x-amz-checksum-sha256": Buffer.from(body.sha256, "hex").toString("base64"),
          "If-None-Match": "*",
        },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ref: {},
      });
    }
    if (request.method === "POST" && action === "/blobs/complete") {
      const body = (await request.json()) as { traceId: string; sha256: string };
      const key = `${body.traceId}/${body.sha256}`;
      const declared = blobs.get(key);
      if (!declared)
        return refusal(
          403,
          "The value is not declared by this import's manifest.",
          "blob_undeclared",
        );
      if (!store.has(key))
        return Response.json(
          { error: "The value was not uploaded.", status: "missing" },
          { status: 409 },
        );
      declared.completed = true;
      return Response.json({ status: "complete" });
    }
    if (request.method === "POST" && action === "/batches") {
      const digest = request.headers.get("hue-import-batch") ?? "";
      const body = Buffer.from(await request.arrayBuffer());
      const declared = batches.get(digest);
      if (!declared)
        return refusal(
          403,
          "The batch is not declared by this import's manifest.",
          "batch_undeclared",
        );
      if (sha256(body) !== digest)
        return refusal(
          409,
          "The body's SHA-256 is not the declared batch digest.",
          "batch_digest_mismatch",
        );
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(request.headers.get("content-encoding")).toBe("gzip");
      const decoded = JSON.parse(gunzipSync(body).toString("utf8")) as {
        resourceSpans: { scopeSpans: { spans: WireSpan[] }[] }[];
      };
      let rejected = 0;
      for (const group of decoded.resourceSpans)
        for (const scope of group.scopeSpans)
          for (const span of scope.spans) {
            if (span.traceId !== declared.traceId)
              return refusal(
                409,
                "The batch carries records of a trace it was not declared for.",
                "batch_trace_mismatch",
              );
            const key = `${span.traceId}/${span.spanId}`;
            const canonical = JSON.stringify(span);
            const held = spans.get(key);
            if (held !== undefined && held !== canonical) rejected++;
            else spans.set(key, canonical);
          }
      declared.posts++;
      if (rejected) declared.state = "conflict";
      else declared.state = "landed";
      const answer = options.afterBatch?.(++batchRequests);
      if (answer) return answer;
      return Response.json(
        rejected
          ? { partialSuccess: { rejectedSpans: String(rejected), errorMessage: "Changed span." } }
          : {},
        { headers: { "Hue-Pending-Spans": "1" } },
      );
    }
    const receipt = /^\/traces\/([0-9a-f]{32})\/receipt$/.exec(action);
    if (request.method === "GET" && receipt) {
      const traceId = receipt[1]!;
      if (!manifest.traces.some((trace) => trace.trace_id === traceId))
        return refusal(404, "Trace not found.", "trace_undeclared");
      const expected = url.searchParams.getAll("expectedSpanId");
      expect(expected.length).toBeLessThanOrEqual(100);
      const held = [...spans.keys()]
        .filter((key) => key.startsWith(`${traceId}/`))
        .map((key) => key.slice(33));
      if (!held.length)
        return Response.json(
          { error: "Trace not found.", code: "TRACE_NOT_FOUND" },
          { status: 404 },
        );
      return Response.json({
        traceId,
        spanCount: held.length,
        revision: 1,
        fields: { input: true, output: true, model: false, usage: false, session: false },
        matchedSpanIds: expected.filter((id) => held.includes(id)),
        missingSpanIds: expected.filter((id) => !held.includes(id)),
        traceUrl: `http://127.0.0.1:${server.port}/traces/${traceId}`,
      });
    }
    if (request.method === "POST" && action === "/reconcile")
      return Response.json({ blobs_stored: 0, traces_verified: verifiedTraces().length });
    if (request.method === "POST" && action === "/complete") {
      const unverified = manifest.traces.length - verifiedTraces().length;
      const conflicts = [...batches.values()].filter((batch) => batch.state === "conflict").length;
      if (unverified)
        return refusal(
          409,
          `${unverified} trace(s) are not verified yet${conflicts ? `, ${conflicts} batch(es) conflicted` : ""}.`,
          "incomplete",
        );
      completed = true;
      return Response.json({ trace_import: { id: IMPORT_ID, state: "completed" } });
    }
    if (request.method === "GET" && action === "") {
      const verified = new Set(verifiedTraces().map((trace) => trace.trace_id));
      return Response.json({
        trace_import: { id: IMPORT_ID, state: "registered" },
        progress: { traces: { declared: manifest.traces.length, verified: verified.size } },
        traces: manifest.traces
          .filter((trace) => !verified.has(trace.trace_id))
          .map((trace) => ({
            trace_id: trace.trace_id,
            pending_batches: trace.batches
              .filter((batch) => batches.get(batch.sha256)?.state !== "landed")
              .map((batch) => ({
                sha256: batch.sha256,
                state: batches.get(batch.sha256)?.state,
              })),
          })),
        next_after: null,
      });
    }
    return refusal(404, "Import route not found.", "not_found");
  }
  stops.push(() => void server.stop(true));
  return {
    url: `http://127.0.0.1:${server.port}${base}`,
    requests,
    batches,
    store,
    spans,
    completed: () => completed,
    posts: (sha: string) => batches.get(sha)?.posts ?? 0,
    /** The most requests the helper had open at once, the store's PUTs included. */
    maxInFlight: () => maxInFlight,
  };
}

async function preparedBundle(
  files = fixtureFiles(),
): Promise<{ directory: string; manifest: TraceImportManifest; report: Record<string, any> }> {
  const root = await scratch();
  const input = join(root, "bundle");
  await writeFixtures(input, files);
  const result = await run(["import", "prepare", input, "--json"]);
  expect(result.code).toBe(0);
  const report = JSON.parse(result.stdout) as Record<string, any>;
  return {
    directory: report.output_directory as string,
    manifest: await readManifest(report.output_directory),
    report,
  };
}

async function authorizationFile(root: string, lines: string[]): Promise<string> {
  const path = join(root, "authorization.txt");
  await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  return path;
}

describe("hue traces import upload", () => {
  test("registers the manifest, sends values and batches in order, confirms receipts and completes", async () => {
    const { directory, manifest } = await preparedBundle({
      ...fixtureFiles(),
      "large.json": Buffer.from(JSON.stringify(langfuseLarge)),
    });
    const server = hue();
    const file = await authorizationFile(directory, [TOKEN, server.url]);
    const result = await run([
      "import",
      "upload",
      directory,
      "--authorization-file",
      file,
      "--json",
    ]);
    expect(result.stderr).not.toContain(TOKEN);
    expect(result.stdout).not.toContain(TOKEN);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, any>;
    expect(report.state).toBe("completed");
    expect(report.traces).toEqual({ declared: 7, verified: 7, conflicted: 0, unverified: 0 });
    expect(report.batches).toEqual({ declared: 7, landed: 7, conflicted: 0, pending: 0 });
    expect(report.blobs).toEqual({ declared: 2, stored: 2, pending: 0 });
    expect(report.next_action).toContain(IMPORT_ID);
    expect(server.completed()).toBe(true);
    const events = result.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events[0]).toEqual({
      event: "manifest.registered",
      registered: true,
      import_id: IMPORT_ID,
    });
    expect(events.filter((event) => event.event === "trace.verified")).toHaveLength(7);
    expect(events.at(-1)).toEqual({ event: "completed", import_id: IMPORT_ID });
    // The manifest went first, reconcile and complete last; every batch was posted once.
    expect(server.requests[0]!.path.endsWith("/manifest")).toBe(true);
    expect(server.requests.slice(-2).map((item) => item.path.split("/").at(-1))).toEqual([
      "reconcile",
      "complete",
    ]);
    for (const trace of manifest.traces)
      for (const batch of trace.batches) expect(server.posts(batch.sha256)).toBe(1);
    // The value went through reservation, the presigned PUT (no authorization) and completion,
    // before its trace's batch.
    const large = manifest.traces.find((trace) => trace.blobs.length)!;
    const paths = server.requests.map((item) => item.path);
    const presign = paths.indexOf(`/api/v1/trace-imports/${IMPORT_ID}/blobs`);
    const put = paths.findIndex((path) => path.startsWith("/store/"));
    const complete = paths.indexOf(`/api/v1/trace-imports/${IMPORT_ID}/blobs/complete`);
    expect(presign).toBeGreaterThan(0);
    expect(put).toBeGreaterThan(presign);
    expect(complete).toBeGreaterThan(put);
    expect(server.store.get(`${large.trace_id}/${sha256(LARGE_OUTPUT)}`)!.byteLength).toBe(
      LARGE_OUTPUT.length,
    );
    expect(
      server.requests.every(
        (item) => item.path.startsWith("/store/") || item.authorization === `Bearer ${TOKEN}`,
      ),
    ).toBe(true);
    // Progress marks every trace verified, in a private file.
    const progressPath = join(directory, "progress.json");
    expect((await stat(progressPath)).mode & 0o777).toBe(0o600);
    const progress = JSON.parse(await readFile(progressPath, "utf8")) as Record<string, any>;
    expect(progress.manifest_digest).toBe(report.manifest_digest);
    expect(progress.import_url).toBe(server.url);
    expect(Object.values(progress.traces).every((trace: any) => trace.state === "verified")).toBe(
      true,
    );
    // Receipts asked for every span id, at most 100 a call.
    const receipts = server.requests.filter((item) => item.path.endsWith("/receipt"));
    expect(receipts).toHaveLength(7);
    // Running again sends nothing twice: the import already completed answers 410 at the manifest.
    const again = await run([
      "import",
      "upload",
      directory,
      "--authorization-file",
      file,
      "--json",
    ]);
    expect(again.code).toBe(0);
    const second = JSON.parse(again.stdout) as Record<string, any>;
    expect(second.state).toBe("completed");
    expect(second.error).toBeUndefined();
    expect(second.note).toContain("already completed");
    expect(second.next_action).toContain(`get_trace_import with trace_import_id ${IMPORT_ID}`);
    expect(server.requests.filter((item) => item.path.endsWith("/batches"))).toHaveLength(7);
    // Two requests at a time, the store's PUT included.
    expect(server.maxInFlight()).toBeLessThanOrEqual(2);
    expect(server.maxInFlight()).toBeGreaterThan(0);
  });

  test("resumes after an interruption without sending a landed batch again", async () => {
    const { directory, manifest } = await preparedBundle();
    let interrupt: (() => void) | undefined;
    let batchesSeen = 0;
    const server = hue({
      before: (request, url) => {
        if (request.method === "POST" && url.pathname.endsWith("/batches") && ++batchesSeen === 2)
          interrupt?.();
        return undefined;
      },
    });
    const file = await authorizationFile(directory, [TOKEN]);
    const first = await run(
      [
        "import",
        "upload",
        directory,
        "--authorization-file",
        file,
        "--import-url",
        server.url,
        "--json",
      ],
      {
        onInterrupt: (listener) => {
          interrupt = listener;
          return () => {};
        },
      },
    );
    expect(first.code).toBe(130);
    const stopped = JSON.parse(first.stdout) as Record<string, any>;
    expect(stopped.state).toBe("stopped");
    expect(stopped.next_action).toContain("Run the same command again");
    const landedFirst = stopped.batches.landed as number;
    expect(landedFirst).toBeGreaterThanOrEqual(1);
    expect(landedFirst).toBeLessThan(manifest.traces.length);
    const progress = JSON.parse(await readFile(join(directory, "progress.json"), "utf8")) as Record<
      string,
      any
    >;
    const landedBatches = Object.values(
      progress.traces as Record<string, { batches: string[] }>,
    ).flatMap((trace) => trace.batches);
    expect(landedBatches).toHaveLength(landedFirst);
    const second = await run([
      "import",
      "upload",
      directory,
      "--authorization-file",
      file,
      "--import-url",
      server.url,
      "--json",
    ]);
    expect(second.code).toBe(0);
    expect((JSON.parse(second.stdout) as Record<string, any>).state).toBe("completed");
    for (const trace of manifest.traces)
      for (const batch of trace.batches) expect(server.posts(batch.sha256)).toBe(1);
    expect(server.requests.filter((item) => item.path.endsWith("/manifest"))).toHaveLength(2);
  });

  test("retries a lost acknowledgement and a network failure; Hue takes the replay as duplicates", async () => {
    const { directory, manifest } = await preparedBundle();
    const server = hue({
      // The first batch is stored, then its acknowledgement is lost behind a 503.
      afterBatch: (index) =>
        index === 1
          ? new Response(null, { status: 503, headers: { "Retry-After": "2" } })
          : undefined,
    });
    let dropped = false;
    const file = await authorizationFile(directory, [TOKEN, server.url]);
    const result = await run(
      ["import", "upload", directory, "--authorization-file", file, "--json"],
      {
        fetch: async (input, init) => {
          const url = new URL(input);
          if (!dropped && url.pathname.endsWith("/receipt")) {
            dropped = true;
            throw new TypeError("fetch failed");
          }
          return fetch(input, init);
        },
      },
    );
    expect(result.code).toBe(0);
    expect(result.sleeps).toEqual([2000, 1000]);
    const posts = manifest.traces.flatMap((trace) =>
      trace.batches.map((batch) => server.posts(batch.sha256)),
    );
    expect(posts.filter((count) => count === 2)).toHaveLength(1);
    expect(posts.filter((count) => count === 1)).toHaveLength(manifest.traces.length - 1);
    expect(server.completed()).toBe(true);
  });

  test("leaves a batch pending when its acknowledgement cannot be read, and sends it next run", async () => {
    const { directory, manifest } = await preparedBundle({
      "a.json": Buffer.from(JSON.stringify(envelope({}, [T1_ROOT_SPAN, T1_CHILD_SPAN]))),
    });
    expect(manifest.traces).toHaveLength(1);
    const [batch] = manifest.traces[0]!.batches;
    // Stored, then answered with something that is no acknowledgement (a proxy's page).
    const server = hue({
      afterBatch: (index) =>
        index === 1
          ? new Response("<html>busy</html>", {
              status: 200,
              headers: { "content-type": "text/html" },
            })
          : undefined,
    });
    const file = await authorizationFile(directory, [TOKEN, server.url]);
    const first = await run([
      "import",
      "upload",
      directory,
      "--authorization-file",
      file,
      "--json",
    ]);
    expect(first.code).toBe(1);
    const report = JSON.parse(first.stdout) as Record<string, any>;
    expect(report.state).toBe("failed");
    expect(report.error.code).toBe("protocol");
    expect(report.error.message).toContain("stays pending");
    expect(report.next_action).toContain("Run the same command again");
    expect(report.batches).toEqual({ declared: 1, landed: 0, conflicted: 0, pending: 1 });
    // Nothing landed, so nothing was checkpointed: no progress file, or one without the batch.
    const progress = JSON.parse(
      await readFile(join(directory, "progress.json"), "utf8").catch(() => '{"traces":{}}'),
    ) as Record<string, any>;
    expect(progress.traces[T1]?.batches ?? []).toEqual([]);
    expect(server.posts(batch!.sha256)).toBe(1);
    // The next run sends the same bytes again; Hue takes the replay as duplicates and completes.
    const second = await run([
      "import",
      "upload",
      directory,
      "--authorization-file",
      file,
      "--json",
    ]);
    expect(second.code).toBe(0);
    expect(server.posts(batch!.sha256)).toBe(2);
    expect(server.completed()).toBe(true);
  });

  test("asks again for an answer whose body breaks off after its headers", async () => {
    const { directory, manifest } = await preparedBundle({
      "a.json": Buffer.from(JSON.stringify(envelope({}, [T1_ROOT_SPAN, T1_CHILD_SPAN]))),
    });
    const [batch] = manifest.traces[0]!.batches;
    const server = hue();
    const file = await authorizationFile(directory, [TOKEN, server.url]);
    let broken = false;
    const result = await run(
      ["import", "upload", directory, "--authorization-file", file, "--json"],
      {
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (broken || !new URL(input).pathname.endsWith("/batches")) return response;
          // Hue stored the batch and answered 200; the connection drops before the body ends.
          broken = true;
          await response.body?.cancel();
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("{"));
                controller.error(new Error("connection reset"));
              },
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(result.code).toBe(0);
    expect(result.sleeps).toEqual([1000]);
    expect(server.posts(batch!.sha256)).toBe(2);
    expect(server.completed()).toBe(true);
  });

  test("stops and reports when progress.json cannot be written, letting no rejection escape", async () => {
    const { directory } = await preparedBundle();
    const server = hue();
    const file = await authorizationFile(directory, [TOKEN, server.url]);
    // The checkpoint's temporary path is taken by a directory: every write fails with EISDIR,
    // whatever this process may read or write (permissions are not relied on).
    await mkdir(join(directory, "progress.json.tmp"));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const result = await run([
        "import",
        "upload",
        directory,
        "--authorization-file",
        file,
        "--json",
      ]);
      expect(result.code).toBe(1);
      const report = JSON.parse(result.stdout) as Record<string, any>;
      expect(report.state).toBe("failed");
      expect(report.error.code).toBe("progress_write_failed");
      expect(report.error.message).toContain("EISDIR");
      expect(report.error.message).toContain(directory);
      expect(report.next_action).toContain("Fix the reported problem");
      expect(server.completed()).toBe(false);
      // Nothing was scheduled after the failure: most of the six traces were never sent.
      expect(server.requests.filter((item) => item.path.endsWith("/batches")).length).toBeLessThan(
        6,
      );
      expect(server.requests.some((item) => item.path.endsWith("/complete"))).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("remembers a delayed progress write that fails instead of rejecting from its timer", async () => {
    const root = await scratch();
    const path = join(root, "progress.json");
    const progress = new Progress(
      path,
      {
        version: 1,
        manifest_digest: "f".repeat(64),
        import_url: `https://hue.example/api/v1/trace-imports/${IMPORT_ID}`,
        traces: {},
      },
      100,
    );
    let failures = 0;
    progress.onFailure = () => failures++;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      progress.trace("a".repeat(32)).state = "verified";
      await progress.changed();
      expect(JSON.parse(await readFile(path, "utf8")).traces).toHaveProperty("a".repeat(32));
      await mkdir(`${path}.tmp`);
      // Within the interval: scheduled on the timer, not awaited by the caller.
      progress.trace("b".repeat(32));
      await progress.changed();
      expect(progress.failure).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(progress.failure?.code).toBe("EISDIR");
      expect(failures).toBe(1);
      // Nothing more is written or reported twice; the earlier file stands.
      progress.trace("c".repeat(32));
      await progress.changed();
      await progress.flush();
      expect(failures).toBe(1);
      expect(Object.keys(JSON.parse(await readFile(path, "utf8")).traces)).toEqual([
        "a".repeat(32),
      ]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("records a conflict, completes what it can and reports what Hue still lists", async () => {
    const { directory, manifest } = await preparedBundle();
    const server = hue({ held: { [`${T1}/${T1_ROOT}`]: JSON.stringify({ different: true }) } });
    const file = await authorizationFile(directory, [TOKEN, server.url]);
    const result = await run([
      "import",
      "upload",
      directory,
      "--authorization-file",
      file,
      "--json",
    ]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as Record<string, any>;
    expect(report.state).toBe("incomplete");
    expect(report.traces).toEqual({ declared: 6, verified: 5, conflicted: 1, unverified: 0 });
    const t1 = manifest.traces.find((trace) => trace.trace_id === T1)!;
    expect(report.conflicts).toEqual([
      { trace_id: T1, sha256: t1.batches[0]!.sha256, message: "1 span(s) rejected: Changed span." },
    ]);
    expect(report.error).toEqual({
      code: "incomplete",
      message: "1 trace(s) are not verified yet, 1 batch(es) conflicted.",
    });
    expect(report.pending).toEqual([
      { trace_id: T1, pending_batches: [{ sha256: t1.batches[0]!.sha256, state: "conflict" }] },
    ]);
    expect(report.next_action).toContain("get_trace_import");
    expect(server.completed()).toBe(false);
    // A rerun does not send the conflicting bytes again.
    const again = await run([
      "import",
      "upload",
      directory,
      "--authorization-file",
      file,
      "--json",
    ]);
    expect(again.code).toBe(1);
    expect(server.posts(t1.batches[0]!.sha256)).toBe(1);
  });

  test("stops when the authorization or the import is no longer usable, naming the next step", async () => {
    const cases: [number, string, string][] = [
      [
        401,
        "token_expired",
        "This import authorization expired. Renew it with prepare_trace_import.",
      ],
      [401, "token_revoked", "This import authorization was replaced."],
      [
        403,
        "authority_lapsed",
        "The connection that authorized this import can no longer write the project.",
      ],
      [410, "import_expired", "This import expired. Prepare it again to continue."],
    ];
    for (const [status, code, message] of cases) {
      const { directory } = await preparedBundle({ "a.json": Buffer.from(otlpFile) });
      const server = hue({
        before: (request, url) =>
          request.method === "POST" && url.pathname.endsWith("/batches")
            ? Response.json(
                { error: message, code },
                { status, headers: { "Hue-Refusal-Code": code } },
              )
            : undefined,
      });
      const file = await authorizationFile(directory, [TOKEN, server.url]);
      const result = await run([
        "import",
        "upload",
        directory,
        "--authorization-file",
        file,
        "--json",
      ]);
      expect(result.code).toBe(1);
      const report = JSON.parse(result.stdout) as Record<string, any>;
      expect(report.state).toBe("failed");
      expect(report.error.code).toBe(code);
      expect(report.error.message).toContain(message);
      expect(report.next_action).toContain("prepare_trace_import again");
      expect(server.completed()).toBe(false);
    }
    // The batch route answers an OTLP status body; the code travels in the header.
    const { directory } = await preparedBundle({ "a.json": Buffer.from(otlpFile) });
    const server = hue({
      before: (request, url) =>
        request.method === "POST" && url.pathname.endsWith("/batches")
          ? Response.json(
              { code: 16, message: "This import authorization expired." },
              { status: 401, headers: { "Hue-Refusal-Code": "token_expired" } },
            )
          : undefined,
    });
    const file = await authorizationFile(directory, [TOKEN, server.url]);
    const result = await run([
      "import",
      "upload",
      directory,
      "--authorization-file",
      file,
      "--json",
    ]);
    const status = JSON.parse(result.stdout) as Record<string, any>;
    expect(status.error.code).toBe("token_expired");
    expect(status.error.message).toContain("This import authorization expired.");
  });

  test("surfaces every fixed refusal code of the import routes in the report", async () => {
    // The status and `Hue-Refusal-Code` of each refusal the routes answer, and whether the next
    // step is a renewed authorization (401, a lapsed credential, an expired import) or not.
    const refusals: [number, string, "renew" | "final"][] = [
      [401, "unauthorized", "renew"],
      [401, "token_revoked", "renew"],
      [401, "token_expired", "renew"],
      [403, "import_mismatch", "final"],
      [403, "authority_lapsed", "renew"],
      [404, "import_not_found", "final"],
      [404, "project_archived", "final"],
      [409, "digest_mismatch", "final"],
      [409, "totals_differ", "final"],
      [409, "import_closed", "final"],
      [409, "unregistered", "final"],
      [410, "import_expired", "renew"],
      [410, "import_canceled", "final"],
      [413, "manifest_too_large", "final"],
      [415, "encoding_unsupported", "final"],
      [422, "manifest_invalid", "final"],
      [400, "body_invalid", "final"],
    ];
    for (const [status, code, next] of refusals) {
      const { directory } = await preparedBundle({ "a.json": Buffer.from(otlpFile) });
      const server = hue({
        before: (request, url) =>
          request.method === "PUT" && url.pathname.endsWith("/manifest")
            ? Response.json(
                { error: `Refused as ${code}.`, code },
                { status, headers: { "Hue-Refusal-Code": code } },
              )
            : undefined,
      });
      const file = await authorizationFile(directory, [TOKEN, server.url]);
      const result = await run([
        "import",
        "upload",
        directory,
        "--authorization-file",
        file,
        "--json",
      ]);
      expect(result.code, code).toBe(1);
      const report = JSON.parse(result.stdout) as Record<string, any>;
      expect(report.state, code).toBe("failed");
      expect(report.error.code, code).toBe(code);
      expect(report.error.message, code).toContain(`Refused as ${code}.`);
      if (next === "renew")
        expect(report.next_action, code).toContain("prepare_trace_import again");
      else expect(report.next_action, code).not.toContain("prepare_trace_import again");
      if (code === "import_canceled") expect(report.next_action).toContain("canceled");
      if (code === "digest_mismatch" || code === "totals_differ")
        expect(report.error.message, code).toContain("manifest_digest and totals");
      expect(result.sleeps, code).toEqual([]);
      expect(server.requests, code).toHaveLength(1);
      expect(server.completed()).toBe(false);
    }
  });

  test("records a batch or value Hue refuses with a fixed code as the trace's conflict and goes on", async () => {
    const { directory, manifest } = await preparedBundle({
      ...fixtureFiles(),
      "large.json": Buffer.from(JSON.stringify(langfuseLarge)),
    });
    const t1 = manifest.traces.find((trace) => trace.trace_id === T1)!;
    const large = manifest.traces.find((trace) => trace.blobs.length)!;
    let refusedBatch = 0;
    const server = hue({
      before: (request, url) => {
        if (
          request.method === "POST" &&
          url.pathname.endsWith("/batches") &&
          request.headers.get("hue-import-batch") === t1.batches[0]!.sha256
        ) {
          refusedBatch++;
          // The batch route answers an OTLP Status; the fixed code is in the header.
          return Response.json(
            {
              code: 9,
              message:
                "The body does not hold the finished spans the manifest declares for this batch.",
            },
            { status: 409, headers: { "Hue-Refusal-Code": "batch_span_count_mismatch" } },
          );
        }
        if (request.method === "POST" && url.pathname.endsWith("/blobs"))
          return Response.json(
            {
              error: "The value's size or type differs from the manifest's declaration.",
              code: "blob_mismatch",
            },
            { status: 409, headers: { "Hue-Refusal-Code": "blob_mismatch" } },
          );
        return undefined;
      },
    });
    const file = await authorizationFile(directory, [TOKEN, server.url]);
    const result = await run([
      "import",
      "upload",
      directory,
      "--authorization-file",
      file,
      "--json",
    ]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as Record<string, any>;
    expect(report.state).toBe("incomplete");
    expect(report.traces).toEqual({ declared: 7, verified: 5, conflicted: 2, unverified: 0 });
    expect(report.conflicts).toEqual(
      expect.arrayContaining([
        {
          trace_id: T1,
          sha256: t1.batches[0]!.sha256,
          message:
            "The body does not hold the finished spans the manifest declares for this batch. (batch_span_count_mismatch)",
        },
        ...large.blobs.map((blob) => ({
          trace_id: large.trace_id,
          sha256: blob.sha256,
          message:
            "The value's size or type differs from the manifest's declaration. (blob_mismatch)",
        })),
      ]),
    );
    expect(report.conflicts).toHaveLength(1 + large.blobs.length);
    expect(report.error.code).toBe("incomplete");
    expect(report.pending.map((trace: any) => trace.trace_id).sort()).toEqual(
      [T1, large.trace_id].sort(),
    );
    expect(server.completed()).toBe(false);
    // The value's batch was never sent, and the refused bytes are not sent again on a rerun.
    expect(server.posts(large.batches[0]!.sha256)).toBe(0);
    expect(refusedBatch).toBe(1);
    const again = await run([
      "import",
      "upload",
      directory,
      "--authorization-file",
      file,
      "--json",
    ]);
    expect(again.code).toBe(1);
    expect(refusedBatch).toBe(1);
    expect((JSON.parse(again.stdout) as Record<string, any>).traces.conflicted).toBe(2);
  });

  test("takes an import Hue reports completed as done, and a canceled one as final", async () => {
    const { directory } = await preparedBundle({ "a.json": Buffer.from(otlpFile) });
    const done = hue({
      before: (request, url) =>
        request.method === "PUT" && url.pathname.endsWith("/manifest")
          ? Response.json(
              { error: "This import already completed.", code: "import_completed" },
              { status: 410, headers: { "Hue-Refusal-Code": "import_completed" } },
            )
          : undefined,
    });
    const file = await authorizationFile(directory, [TOKEN, done.url]);
    const result = await run([
      "import",
      "upload",
      directory,
      "--authorization-file",
      file,
      "--json",
    ]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, any>;
    expect(report.state).toBe("completed");
    expect(report.note).toContain("already completed");
    expect(report.next_action).toContain("get_trace_import");
    const events = result.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.at(-1)).toEqual({ event: "completed", import_id: IMPORT_ID, already: true });
    const readable = await run(["import", "upload", directory, "--authorization-file", file]);
    expect(readable.code).toBe(0);
    expect(readable.stdout).toContain("Completed:");
    expect(readable.stdout).toContain("already completed");
    const canceled = hue({
      before: () =>
        Response.json(
          { error: "This import was canceled.", code: "import_canceled" },
          { status: 410, headers: { "Hue-Refusal-Code": "import_canceled" } },
        ),
    });
    const canceledFile = await authorizationFile(directory, [TOKEN, canceled.url]);
    const refused = await run([
      "import",
      "upload",
      directory,
      "--authorization-file",
      canceledFile,
      "--json",
    ]);
    expect(refused.code).toBe(1);
    const final = JSON.parse(refused.stdout) as Record<string, any>;
    expect(final.state).toBe("failed");
    expect(final.error).toEqual({
      code: "import_canceled",
      message: "This import was canceled. It cannot be resumed.",
    });
    expect(final.next_action).toContain("canceled");
    expect(final.next_action).not.toContain("prepare_trace_import again");
  });

  test("reads the authorization file as prepare_trace_import's JSON answer too", async () => {
    const { directory } = await preparedBundle({ "a.json": Buffer.from(otlpFile) });
    const server = hue();
    const answer = {
      trace_import: { id: IMPORT_ID, state: "authorized" },
      upload_url: server.url,
      authorization: TOKEN,
      authorization_expires_at: "2026-10-18T12:00:00.000Z",
      concurrency: 2,
    };
    const file = await authorizationFile(directory, [JSON.stringify(answer, null, 2)]);
    const result = await run([
      "import",
      "upload",
      directory,
      "--authorization-file",
      file,
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(TOKEN);
    expect((JSON.parse(result.stdout) as Record<string, any>).state).toBe("completed");
    // The URL may come from the command line when the file holds the authorization alone.
    const { directory: other } = await preparedBundle({ "a.json": Buffer.from(otlpFile) });
    const second = hue();
    const bare = await authorizationFile(other, [JSON.stringify({ authorization: TOKEN })]);
    expect((await run(["import", "upload", other, "--authorization-file", bare])).stderr).toContain(
      "--import-url",
    );
    expect(
      (
        await run([
          "import",
          "upload",
          other,
          "--authorization-file",
          bare,
          "--import-url",
          second.url,
        ])
      ).code,
    ).toBe(0);
    const wrong = await authorizationFile(other, [
      JSON.stringify({ authorization: "hue_sk_live_not_an_import_token", upload_url: second.url }),
    ]);
    const refused = await run(["import", "upload", other, "--authorization-file", wrong]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("hue_it_");
    const missing = await run([
      "import",
      "upload",
      other,
      "--authorization-file",
      join(other, "absent.json"),
    ]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("could not be read");
    expect(second.requests.filter((item) => item.path.endsWith("/manifest"))).toHaveLength(1);
  });

  test("never prints an import authorization, even one Hue echoes back", async () => {
    const { directory } = await preparedBundle({ "a.json": Buffer.from(otlpFile) });
    const server = hue({
      before: (request, url) =>
        request.method === "PUT" && url.pathname.endsWith("/manifest")
          ? Response.json(
              { error: `The authorization ${TOKEN} expired.`, code: "token_expired" },
              { status: 401, headers: { "Hue-Refusal-Code": "token_expired" } },
            )
          : undefined,
    });
    const file = await authorizationFile(directory, [TOKEN, server.url]);
    for (const flags of [["--json"], []]) {
      const result = await run([
        "import",
        "upload",
        directory,
        "--authorization-file",
        file,
        ...flags,
      ]);
      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).not.toContain(TOKEN);
      expect(result.stdout + result.stderr).toContain("[redacted]");
    }
  });

  test("counts a trace unverified when its receipt lacks a span, and leaves it for the next run", async () => {
    const { directory, manifest } = await preparedBundle();
    const t1 = manifest.traces.find((trace) => trace.trace_id === T1)!;
    const server = hue({
      before: (request, url) => {
        if (request.method === "GET" && url.pathname.endsWith(`/traces/${T1}/receipt`)) {
          const expected = url.searchParams.getAll("expectedSpanId");
          return Response.json({
            traceId: T1,
            spanCount: 1,
            revision: 1,
            fields: { input: false, output: false, model: false, usage: false, session: false },
            matchedSpanIds: expected.slice(1),
            missingSpanIds: expected.slice(0, 1),
            traceUrl: `http://127.0.0.1/traces/${T1}`,
          });
        }
        if (request.method === "POST" && url.pathname.endsWith("/complete"))
          return Response.json(
            { error: "1 trace(s) are not verified yet.", code: "incomplete" },
            { status: 409, headers: { "Hue-Refusal-Code": "incomplete" } },
          );
        return undefined;
      },
    });
    const file = await authorizationFile(directory, [TOKEN, server.url]);
    const result = await run([
      "import",
      "upload",
      directory,
      "--authorization-file",
      file,
      "--json",
    ]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as Record<string, any>;
    expect(report.state).toBe("incomplete");
    expect(report.traces).toEqual({
      declared: manifest.traces.length,
      verified: manifest.traces.length - 1,
      conflicted: 0,
      unverified: 1,
    });
    expect(report.batches.landed).toBe(manifest.traces.length);
    expect(report.next_action).toContain("Run the same command again");
    // The receipt was read again once before the span was counted missing.
    expect(result.sleeps).toEqual([1000]);
    const events = result.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.find((event) => event.event === "trace.unverified")).toMatchObject({
      trace_id: T1,
      missing_spans: 1,
    });
    const progress = JSON.parse(await readFile(join(directory, "progress.json"), "utf8")) as Record<
      string,
      any
    >;
    expect(progress.traces[T1]).toMatchObject({
      state: "pending",
      batches: t1.batches.map((batch) => batch.sha256),
    });
  });

  test("waits for Retry-After and gives up after bounded attempts, resumable", async () => {
    const { directory } = await preparedBundle({ "a.json": Buffer.from(otlpFile) });
    let refusals = 0;
    const server = hue({
      before: (request, url) =>
        request.method === "POST" && url.pathname.endsWith("/batches") && ++refusals <= 2
          ? Response.json({ error: "busy" }, { status: 429, headers: { "Retry-After": "3" } })
          : undefined,
    });
    const file = await authorizationFile(directory, [TOKEN, server.url]);
    const result = await run([
      "import",
      "upload",
      directory,
      "--authorization-file",
      file,
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(result.sleeps).toEqual([3000, 3000]);
    const { directory: other } = await preparedBundle({ "a.json": Buffer.from(otlpFile) });
    const down = hue({ before: () => Response.json({ error: "down" }, { status: 503 }) });
    const downFile = await authorizationFile(other, [TOKEN, down.url]);
    const failed = await run([
      "import",
      "upload",
      other,
      "--authorization-file",
      downFile,
      "--json",
    ]);
    expect(failed.code).toBe(1);
    const report = JSON.parse(failed.stdout) as Record<string, any>;
    expect(report.state).toBe("failed");
    expect(report.error.code).toBe("busy");
    expect(report.next_action).toContain("Run the same command again");
    expect(failed.sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  test("refuses a progress file of another manifest or import, and a bad authorization or URL", async () => {
    const { directory } = await preparedBundle({ "a.json": Buffer.from(otlpFile) });
    const server = hue();
    const file = await authorizationFile(directory, [TOKEN, server.url]);
    await writeFile(
      join(directory, "progress.json"),
      JSON.stringify({
        version: 1,
        manifest_digest: "f".repeat(64),
        import_url: server.url,
        traces: {},
      }),
    );
    const mismatch = await run(["import", "upload", directory, "--authorization-file", file]);
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toContain("belongs to another manifest");
    const manifestDigest = sha256(await readFile(join(directory, "manifest.json")));
    await writeFile(
      join(directory, "progress.json"),
      JSON.stringify({
        version: 1,
        manifest_digest: manifestDigest,
        import_url: `https://other.example/api/v1/trace-imports/${IMPORT_ID}`,
        traces: {},
      }),
    );
    const otherImport = await run(["import", "upload", directory, "--authorization-file", file]);
    expect(otherImport.code).toBe(1);
    expect(otherImport.stderr).toContain("belongs to another import");
    expect(server.requests).toHaveLength(0);
    await rm(join(directory, "progress.json"));
    const badToken = await authorizationFile(directory, ["hue_sk_live_not_an_import_token"]);
    const refused = await run([
      "import",
      "upload",
      directory,
      "--authorization-file",
      badToken,
      "--import-url",
      server.url,
    ]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("first line");
    const noUrl = await authorizationFile(directory, [TOKEN]);
    expect(
      (await run(["import", "upload", directory, "--authorization-file", noUrl])).stderr,
    ).toContain("--import-url");
    const insecure = await run([
      "import",
      "upload",
      directory,
      "--authorization-file",
      noUrl,
      "--import-url",
      `http://example.com/api/v1/trace-imports/${IMPORT_ID}`,
    ]);
    expect(insecure.code).toBe(2);
    expect(insecure.stderr).toContain("https");
    const wrongPath = await run([
      "import",
      "upload",
      directory,
      "--authorization-file",
      noUrl,
      "--import-url",
      "https://app.hue.run/api/v1/traces",
    ]);
    expect(wrongPath.stderr).toContain("/api/v1/trace-imports/");
    const wrongOrigin = await run([
      "import",
      "upload",
      directory,
      "--authorization-file",
      noUrl,
      "--import-url",
      server.url,
      "--origin",
      "https://app.hue.run",
    ]);
    expect(wrongOrigin.code).toBe(2);
    expect(wrongOrigin.stderr).toContain("is not on https://app.hue.run");
    // A bundle whose batch file changed after preparation is refused before anything is sent.
    const [batchFile] = (await readdir(directory)).filter((name) => name.endsWith(".json.gz"));
    await rename(join(directory, batchFile!), join(directory, `${batchFile}.moved`));
    const altered = await run([
      "import",
      "upload",
      directory,
      "--authorization-file",
      noUrl,
      "--import-url",
      server.url,
    ]);
    expect(altered.code).toBe(1);
    expect(altered.stderr).toContain("lacks batch");
    expect(server.requests).toHaveLength(0);
  });

  test("prints a readable summary without --json", async () => {
    const { directory } = await preparedBundle({ "a.json": Buffer.from(otlpFile) });
    const server = hue();
    const file = await authorizationFile(directory, [TOKEN, server.url]);
    const result = await run(["import", "upload", directory, "--authorization-file", file]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Registered the manifest with import ${IMPORT_ID}.`);
    expect(result.stdout).toContain(
      "Completed: 2 of 2 traces verified, 0 conflicted, 2 of 2 batches landed, 0 of 0 large values stored.",
    );
    expect(result.stdout).not.toContain(TOKEN);
  });
});

/** Runs the `hue` entry point with no key in its environment. */
async function hueBinary(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cli, ...args], {
    env: { PATH: process.env.PATH ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const code = await new Promise<number | null>((done) => child.on("close", done));
  return { code, stdout, stderr };
}

describe("the hue binary", () => {
  test("lists traces among its commands and routes hue traces to the import helper", async () => {
    const help = await hueBinary(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain(
      "Usage: hue <setup|resume|status|claim|login|eval|mcp|listen|import|traces>",
    );
    const traces = await hueBinary(["traces", "--help"]);
    expect(traces.code).toBe(0);
    expect(traces.stdout).toBe(`${TRACES_USAGE}\n`);
    const unknown = await hueBinary(["traces", "export"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("Unknown command: hue traces export");
  });

  test("runs hue traces import prepare", async () => {
    const root = await scratch();
    const input = join(root, "bundle");
    await writeFixtures(input, { "a.json": Buffer.from(otlpFile) });
    const child = spawn(process.execPath, [cli, "traces", "import", "prepare", input, "--json"], {
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const code = await new Promise<number | null>((done) => child.on("close", done));
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as Record<string, any>;
    expect(report.totals.traces).toBe(2);
    expect(await readFile(join(report.output_directory, "manifest.json"), "utf8")).toContain(
      '"version":1',
    );
    await cp(report.output_directory, join(root, "copy"), { recursive: true });
  });
});
