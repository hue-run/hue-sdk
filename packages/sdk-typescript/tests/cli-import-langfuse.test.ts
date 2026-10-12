import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs/light.js";
import { IMPORT_USAGE, runImportCommand, type ImportCommandIo } from "../src/cli/import.js";
import { hueSpanId, hueTraceId, parseMediaToken } from "../src/cli/langfuse.js";
import schema from "./fixtures/otlp-schema.json" with { type: "json" };

// Synthetic stand-ins written from the public contracts: Langfuse's public API (Basic auth,
// v2 observations with cursor pages and metadata cut at 200 characters unless expanded, v1
// traces and observations with numbered pages, media records answering a presigned download)
// and Hue's OTLP receiver and upload routes (an exact replay of a span is a duplicate, a
// different payload for a held span id is refused). Nothing leaves the loopback interface.

const cli = join(import.meta.dir, "../src/setup/cli.ts");
const root = protobuf.Root.fromJSON(schema);
const PUBLIC_KEY = "pk-lf-synthetic-import";
const SECRET_KEY = "sk-lf-synthetic-import-secret";
const HUE_KEY = "hue_sk_test_import_synthetic_key";

type Value = {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
  arrayValue?: { values: Value[] };
};
type Attribute = { key: string; value: Value };
interface WireSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status?: { code?: number; message?: string };
  attributes?: Attribute[];
  resource?: Attribute[];
  scope?: string;
}

const stops: (() => void)[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const hex = (base64: string | undefined) =>
  base64 ? Buffer.from(base64, "base64").toString("hex") : undefined;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function attr(span: WireSpan, key: string): Value | undefined {
  return span.attributes?.find((item) => item.key === key)?.value;
}
function str(span: WireSpan, key: string): string | undefined {
  return attr(span, key)?.stringValue;
}

/** A loopback Hue: the project route, the OTLP traces receiver and the upload routes. */
function hue(options: { key?: string; reserve?: () => number; otlpStatus?: number } = {}) {
  const spans = new Map<string, { span: WireSpan; canonical: string }>();
  const store = new Map<string, Buffer>();
  const reservations: Record<string, unknown>[] = [];
  const requests: string[] = [];
  let rejected = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      requests.push(url.pathname);
      if (url.pathname.startsWith("/store/")) {
        const bytes = Buffer.from(await request.arrayBuffer());
        expect(request.headers.get("authorization")).toBeNull();
        const key = url.pathname.slice("/store/".length);
        if (sha256(bytes) !== key.split("/")[1]) return new Response(null, { status: 400 });
        store.set(key, bytes);
        return new Response(null, { status: 200 });
      }
      if (request.headers.get("authorization") !== `Bearer ${options.key ?? HUE_KEY}`)
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (url.pathname === "/api/v1/projects/current")
        return Response.json({
          id: "p1",
          name: "Synthetic project",
          organizationId: "o1",
          slug: "synthetic",
        });
      if (url.pathname === "/api/v1/otlp/blobs") {
        const body = (await request.json()) as Record<string, unknown>;
        reservations.push(body);
        const status = options.reserve?.() ?? 200;
        if (status !== 200) return Response.json({ error: "Synthetic refusal." }, { status });
        const objectKey = `${String(body.traceId)}/${String(body.sha256)}`;
        const ref = {
          key: body.key,
          sha256: body.sha256,
          size: body.byteSize,
          content_type: body.contentType,
        };
        if (store.has(objectKey)) return Response.json({ status: "exists", ref });
        return Response.json({
          status: "upload",
          url: `http://127.0.0.1:${server.port}/store/${objectKey}`,
          method: "PUT",
          headers: { "Content-Type": body.contentType, "Content-Length": String(body.byteSize) },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          ref,
        });
      }
      if (url.pathname === "/api/v1/otlp/blobs/complete")
        return Response.json({ status: "complete" });
      if (url.pathname !== "/api/v1/otlp/v1/traces") return new Response(null, { status: 404 });
      if (options.otlpStatus)
        return Response.json({ error: "Synthetic refusal." }, { status: options.otlpStatus });
      let bytes = Buffer.from(await request.arrayBuffer());
      if (request.headers.get("content-encoding") === "gzip") bytes = gunzipSync(bytes);
      const type = root.lookupType(
        "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
      );
      const data = type.toObject(type.decode(bytes), { longs: String, bytes: String }) as {
        resourceSpans: {
          resource?: { attributes?: Attribute[] };
          scopeSpans: { scope?: { name?: string }; spans: WireSpan[] }[];
        }[];
      };
      let refused = 0;
      for (const group of data.resourceSpans)
        for (const scope of group.scopeSpans)
          for (const raw of scope.spans) {
            const span: WireSpan = {
              ...raw,
              traceId: hex(raw.traceId)!,
              spanId: hex(raw.spanId)!,
              ...(raw.parentSpanId ? { parentSpanId: hex(raw.parentSpanId) } : {}),
              resource: group.resource?.attributes,
              scope: scope.scope?.name,
            };
            const canonical = JSON.stringify(span);
            const key = `${span.traceId}/${span.spanId}`;
            const held = spans.get(key);
            // An exact replay is a duplicate; another payload for a held span is refused.
            if (held && held.canonical !== canonical) refused++;
            else spans.set(key, { span, canonical });
          }
      rejected += refused;
      const response = root.lookupType(
        "opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse",
      );
      return new Response(
        new Uint8Array(
          response
            .encode(
              response.fromObject(
                refused
                  ? { partialSuccess: { rejectedSpans: refused, errorMessage: "Changed span." } }
                  : {},
              ),
            )
            .finish(),
        ),
        { headers: { "content-type": "application/x-protobuf" } },
      );
    },
  });
  stops.push(() => void server.stop(true));
  return {
    url: `http://127.0.0.1:${server.port}`,
    spans,
    store,
    reservations,
    requests,
    rejected: () => rejected,
    span: (traceId: string, spanId: string) => spans.get(`${traceId}/${spanId}`)?.span,
    all: () => [...spans.values()].map(({ span }) => span),
  };
}

interface V2Observation {
  id: string;
  traceId: string;
  type: string;
  name: string;
  startTime: string;
  endTime?: string | null;
  parentObservationId?: string | null;
  [field: string]: unknown;
}
interface V1Trace {
  id: string;
  timestamp: string;
  observations: Record<string, unknown>[];
  [field: string]: unknown;
}

/** A loopback Langfuse. `pageCap` bounds every page whatever the limit asked, so pagination is
 * exercised with a handful of records. */
function langfuse(
  data: {
    v2?: V2Observation[];
    v1?: V1Trace[];
    media?: Record<string, { bytes: Uint8Array; contentType: string } | "fails">;
    pageCap?: number;
  },
  hooks: { before?: (url: URL) => Response | undefined } = {},
) {
  const requests: URL[] = [];
  const downloads: { id: string; authorization: string | null }[] = [];
  const cap = data.pageCap ?? 1000;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request: Request): Response {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/s3/")) {
        const id = url.pathname.slice(4);
        downloads.push({ id, authorization: request.headers.get("authorization") });
        const file = data.media?.[id];
        if (file === "fails") return new Response("busy", { status: 503 });
        return file
          ? new Response(new Uint8Array(file.bytes))
          : new Response(null, { status: 404 });
      }
      requests.push(url);
      const hooked = hooks.before?.(url);
      if (hooked) return hooked;
      const expected = `Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64")}`;
      if (request.headers.get("authorization") !== expected)
        return Response.json({ message: "Invalid credentials" }, { status: 401 });
      const query = url.searchParams;
      const limit = Math.min(Number(query.get("limit") ?? 50), cap);
      if (url.pathname === "/api/public/v2/observations") {
        if (!data.v2) return Response.json({ message: "Not found" }, { status: 404 });
        let rows = [...data.v2].sort((a, b) => b.startTime.localeCompare(a.startTime));
        if (query.get("traceId")) rows = rows.filter((row) => row.traceId === query.get("traceId"));
        if (query.get("isRootObservation") === "true")
          rows = rows.filter((row) => !row.parentObservationId);
        const from = query.get("fromStartTime");
        const to = query.get("toStartTime");
        if (from) rows = rows.filter((row) => Date.parse(row.startTime) >= Date.parse(from));
        if (to) rows = rows.filter((row) => Date.parse(row.startTime) < Date.parse(to));
        const offset = Number(Buffer.from(query.get("cursor") ?? "MA==", "base64").toString());
        const expand = new Set((query.get("expandMetadata") ?? "").split(",").filter(Boolean));
        const page = rows.slice(offset, offset + limit).map((row) => {
          const metadata = row.metadata as Record<string, string> | undefined;
          return {
            ...row,
            ...(metadata
              ? {
                  metadata: Object.fromEntries(
                    Object.entries(metadata).map(([key, value]) => [
                      key,
                      expand.has(key) ? value : value.slice(0, 200),
                    ]),
                  ),
                }
              : {}),
          };
        });
        const next = offset + limit < rows.length;
        return Response.json({
          data: page,
          meta: next ? { cursor: Buffer.from(String(offset + limit)).toString("base64") } : {},
        });
      }
      if (url.pathname === "/api/public/traces" || url.pathname.startsWith("/api/public/traces/")) {
        if (!data.v1) return new Response(null, { status: 404 });
        const strip = ({ observations: _observations, ...trace }: V1Trace) => trace;
        if (url.pathname !== "/api/public/traces") {
          const trace = data.v1.find((item) => item.id === url.pathname.split("/").at(-1));
          return trace ? Response.json(strip(trace)) : Response.json({}, { status: 404 });
        }
        let rows = [...data.v1].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        const from = query.get("fromTimestamp");
        const to = query.get("toTimestamp");
        if (from) rows = rows.filter((row) => Date.parse(row.timestamp) >= Date.parse(from));
        if (to) rows = rows.filter((row) => Date.parse(row.timestamp) < Date.parse(to));
        const page = Number(query.get("page") ?? 1);
        return Response.json({
          data: rows.slice((page - 1) * limit, page * limit).map(strip),
          meta: {
            page,
            limit,
            totalItems: rows.length,
            totalPages: Math.ceil(rows.length / limit),
          },
        });
      }
      if (url.pathname === "/api/public/observations") {
        if (!data.v1) return new Response(null, { status: 404 });
        const rows = data.v1.find((trace) => trace.id === query.get("traceId"))?.observations ?? [];
        const page = Number(query.get("page") ?? 1);
        return Response.json({
          data: rows.slice((page - 1) * limit, page * limit),
          meta: {
            page,
            limit,
            totalItems: rows.length,
            totalPages: Math.ceil(rows.length / limit),
          },
        });
      }
      if (url.pathname.startsWith("/api/public/media/")) {
        const id = url.pathname.split("/").at(-1)!;
        const file = data.media?.[id];
        if (!file) return Response.json({ message: "Media not found" }, { status: 404 });
        return Response.json({
          mediaId: id,
          contentType: file === "fails" ? "image/png" : file.contentType,
          contentLength: file === "fails" ? 4 : file.bytes.byteLength,
          uploadedAt: "2026-03-01T00:00:00.000Z",
          url: `http://127.0.0.1:${server.port}/s3/${id}`,
          urlExpiry: "2026-03-01T01:00:00.000Z",
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  stops.push(() => void server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, requests, downloads };
}

/** Runs the command in a scratch directory and returns its exit code and output. */
async function run(
  args: string[],
  env: Record<string, string>,
  io: Partial<ImportCommandIo> = {},
): Promise<{ code: number; stdout: string; stderr: string; sleeps: number[] }> {
  const cwd = await mkdtemp(join(tmpdir(), "hue-import-"));
  directories.push(cwd);
  let stdout = "";
  let stderr = "";
  const sleeps: number[] = [];
  const code = await runImportCommand(args, {
    stdout: new Writable({
      write: (chunk, _encoding, done) => ((stdout += String(chunk)), done()),
    }),
    stderr: new Writable({
      write: (chunk, _encoding, done) => ((stderr += String(chunk)), done()),
    }),
    stdin: { isTTY: false } as never,
    env,
    cwd,
    sleep: async (ms) => void sleeps.push(ms),
    onInterrupt: () => () => {},
    now: () => new Date("2026-04-01T00:00:00.000Z"),
    ...io,
  });
  return { code, stdout, stderr, sleeps };
}

function environment(langfuseUrl: string, hueUrl: string): Record<string, string> {
  return {
    LANGFUSE_PUBLIC_KEY: PUBLIC_KEY,
    LANGFUSE_SECRET_KEY: SECRET_KEY,
    LANGFUSE_BASE_URL: langfuseUrl,
    HUE_API_KEY: HUE_KEY,
    HUE_BASE_URL: hueUrl,
  };
}

// Trace A: recorded by a Langfuse OpenTelemetry SDK (hex ids), three observations.
const TRACE_A = "0af7651916cd43dd8448eb211c80319c";
const ROOT_A = "b7ad6b7169203331";
const GENERATION_A = "00f067aa0ba902b7";
const TOOL_A = "53995c3f42cd8ad8";
// Trace B: recorded by an older Langfuse SDK (UUIDs), two observations.
const TRACE_B = "5f2b6c1e-7a1d-4c5e-9b0a-3d2e1f4a5b6c";
const ROOT_B = "8a3c1e2d-0b4f-4a6e-9c7d-1e2f3a4b5c6d";
const CHILD_B = "9b4d2f3e-1c5a-4b7f-8d9e-2f3a4b5c6d7e";
const LONG = "m".repeat(300);
const trace = {
  traceName: "support-chat",
  tags: ["prod", "eu"],
  userId: "user-7",
  sessionId: "session-3",
  environment: "production",
  release: "2026.3.1",
};

function v2Data(): V2Observation[] {
  return [
    {
      id: ROOT_A,
      traceId: TRACE_A,
      type: "AGENT",
      name: "support-agent",
      startTime: "2026-03-02T10:00:00.123456Z",
      endTime: "2026-03-02T10:00:02.500Z",
      parentObservationId: null,
      input: '{"question":"Where is my order?"}',
      output: '"It ships tomorrow."',
      metadata: { channel: "web", long: LONG },
      level: "DEFAULT",
      ...trace,
    },
    {
      id: GENERATION_A,
      traceId: TRACE_A,
      type: "GENERATION",
      name: "answer",
      startTime: "2026-03-02T10:00:00.200Z",
      endTime: "2026-03-02T10:00:01.900Z",
      completionStartTime: "2026-03-02T10:00:00.700Z",
      parentObservationId: ROOT_A,
      model: "gpt-4.1-mini",
      modelParameters: { temperature: 0.2 },
      usageDetails: { input: 120, output: 30, total: 150 },
      costDetails: { total: 0.0009 },
      input: '[{"role":"user","content":"Where is my order?"}]',
      output: '{"role":"assistant","content":"It ships tomorrow."}',
      promptName: "support",
      promptVersion: 4,
      level: "DEFAULT",
      ...trace,
    },
    {
      id: TOOL_A,
      traceId: TRACE_A,
      type: "TOOL",
      name: "lookup_order",
      startTime: "2026-03-02T10:00:00.300Z",
      endTime: null,
      parentObservationId: GENERATION_A,
      input: '{"orderId":"o-1"}',
      level: "ERROR",
      statusMessage: "order service timed out",
      ...trace,
    },
    {
      id: ROOT_B,
      traceId: TRACE_B,
      type: "SPAN",
      name: "pipeline",
      startTime: "2026-03-05T08:00:00.000Z",
      endTime: "2026-03-05T08:00:01.000Z",
      parentObservationId: null,
      traceName: "nightly",
    },
    {
      id: CHILD_B,
      traceId: TRACE_B,
      type: "EVENT",
      name: "checkpoint",
      startTime: "2026-03-05T08:00:00.500Z",
      parentObservationId: ROOT_B,
      traceName: "nightly",
    },
    {
      id: "c1c2c3c4c5c6c7c8",
      traceId: "1111111111111111111111111111111c",
      type: "SPAN",
      name: "newest",
      startTime: "2026-03-20T00:00:00.000Z",
      endTime: "2026-03-20T00:00:01.000Z",
      parentObservationId: null,
    },
    {
      id: "d1d2d3d4d5d6d7d8",
      traceId: "2222222222222222222222222222222d",
      type: "SPAN",
      name: "before the window",
      startTime: "2026-02-15T00:00:00.000Z",
      endTime: "2026-02-15T00:00:01.000Z",
      parentObservationId: null,
    },
  ];
}

describe("hue import langfuse through the v2 API", () => {
  test("converts every page of the window's traces into the spans Hue reads", async () => {
    const lf = langfuse({ v2: v2Data(), pageCap: 2 });
    const target = hue();
    const result = await run(
      ["langfuse", "--from", "2026-03-01", "--to", "2026-03-31T00:00:00Z", "--yes"],
      environment(lf.url, target.url),
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("(Langfuse API v2)");
    expect(result.stdout).toContain(
      'Imported 3 traces of 3 (6 spans sent, 6 accepted) into the Hue project "Synthetic project".',
    );
    // The window reached Langfuse; the trace before it was never read.
    const roots = lf.requests.filter((url) => url.searchParams.get("isRootObservation"));
    expect(roots.length).toBe(2);
    expect(roots[0]!.searchParams.get("fromStartTime")).toBe("2026-03-01T00:00:00.000Z");
    expect(roots[0]!.searchParams.get("toStartTime")).toBe("2026-03-31T00:00:00.000Z");
    expect(roots[1]!.searchParams.get("cursor")).toBeTruthy();
    expect(target.all().some((span) => span.name === "before the window")).toBe(false);
    // Trace A's three observations came in two pages; its ids are kept.
    expect(lf.requests.filter((url) => url.searchParams.get("traceId") === TRACE_A).length).toBe(
      3, // two pages, and the first again with the cut metadata key expanded
    );
    const agent = target.span(TRACE_A, ROOT_A)!;
    expect(agent.name).toBe("support-agent");
    expect(agent.parentSpanId).toBeUndefined();
    expect(agent.startTimeUnixNano).toBe("1772445600123456000");
    expect(agent.endTimeUnixNano).toBe("1772445602500000000");
    expect(str(agent, "langfuse.observation.type")).toBe("agent");
    expect(str(agent, "langfuse.observation.input")).toBe('{"question":"Where is my order?"}');
    expect(str(agent, "langfuse.observation.output")).toBe('"It ships tomorrow."');
    expect(str(agent, "langfuse.observation.metadata.channel")).toBe("web");
    // A metadata value Langfuse cut at 200 characters is read whole.
    expect(str(agent, "langfuse.observation.metadata.long")).toBe(LONG);
    expect(str(agent, "langfuse.trace.name")).toBe("support-chat");
    expect(
      attr(agent, "langfuse.trace.tags")?.arrayValue?.values.map((v) => v.stringValue),
    ).toEqual(["prod", "eu"]);
    expect(str(agent, "langfuse.user.id")).toBe("user-7");
    expect(str(agent, "langfuse.session.id")).toBe("session-3");
    expect(str(agent, "langfuse.environment")).toBe("production");
    expect(str(agent, "langfuse.release")).toBe("2026.3.1");
    expect(agent.resource?.find((item) => item.key === "service.name")?.value.stringValue).toBe(
      "langfuse",
    );
    const generation = target.span(TRACE_A, GENERATION_A)!;
    expect(generation.parentSpanId).toBe(ROOT_A);
    expect(str(generation, "langfuse.observation.type")).toBe("generation");
    expect(str(generation, "langfuse.observation.model.name")).toBe("gpt-4.1-mini");
    expect(str(generation, "gen_ai.request.model")).toBe("gpt-4.1-mini");
    expect(attr(generation, "gen_ai.usage.input_tokens")?.intValue).toBe("120");
    expect(attr(generation, "gen_ai.usage.output_tokens")?.intValue).toBe("30");
    expect(JSON.parse(str(generation, "langfuse.observation.usage_details")!)).toEqual({
      input: 120,
      output: 30,
      total: 150,
    });
    expect(str(generation, "langfuse.observation.model.parameters")).toBe('{"temperature":0.2}');
    expect(str(generation, "langfuse.observation.completion_start_time")).toBe(
      "2026-03-02T10:00:00.700Z",
    );
    expect(str(generation, "langfuse.observation.prompt.name")).toBe("support");
    expect(attr(generation, "langfuse.observation.prompt.version")?.intValue).toBe("4");
    // An ERROR observation is an error span; one without an end lasts no time.
    const tool = target.span(TRACE_A, TOOL_A)!;
    expect(tool.parentSpanId).toBe(GENERATION_A);
    expect(tool.status).toMatchObject({ code: 2, message: "order service timed out" });
    expect(tool.endTimeUnixNano).toBe(tool.startTimeUnixNano);
    // Trace B's UUIDs become ids derived from them, the same on every run.
    const traceB = hueTraceId(TRACE_B);
    expect(traceB).toMatch(/^[0-9a-f]{32}$/);
    const child = target.span(traceB, hueSpanId(TRACE_B, CHILD_B))!;
    expect(child.parentSpanId).toBe(hueSpanId(TRACE_B, ROOT_B));
    expect(str(child, "langfuse.trace.id")).toBe(TRACE_B);
    expect(str(child, "langfuse.observation.id")).toBe(CHILD_B);
    expect(str(child, "langfuse.observation.type")).toBe("event");
    expect(result.stdout + result.stderr).not.toContain(SECRET_KEY);
    expect(result.stdout + result.stderr).not.toContain(HUE_KEY);
  });

  test("--limit imports the newest traces only", async () => {
    const lf = langfuse({ v2: v2Data() });
    const target = hue();
    const result = await run(
      ["langfuse", "--from", "2026-03-01", "--limit", "2", "--yes"],
      environment(lf.url, target.url),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Imported 2 traces of 2 (3 spans sent, 3 accepted)");
    expect(new Set(target.all().map((span) => span.traceId))).toEqual(
      new Set(["1111111111111111111111111111111c", hueTraceId(TRACE_B)]),
    );
  });

  test("--dry-run counts without a Hue key and sends nothing", async () => {
    const lf = langfuse({ v2: v2Data() });
    const target = hue();
    const { HUE_API_KEY: _key, ...env } = environment(lf.url, target.url);
    const result = await run(["langfuse", "--dry-run", "--from", "2026-03-01"], env);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "Dry run: 3 traces, 6 spans and 0 media references would be imported; nothing was sent to Hue.",
    );
    expect(target.requests).toEqual([]);
  });

  test("running the same import again sends identical spans, which Hue keeps once", async () => {
    const lf = langfuse({ v2: v2Data() });
    const target = hue();
    const args = ["langfuse", "--from", "2026-03-01", "--yes"];
    const first = await run(args, environment(lf.url, target.url));
    expect(first.code).toBe(0);
    const held = new Map([...target.spans].map(([key, { canonical }]) => [key, canonical]));
    expect(held.size).toBe(6);
    const second = await run(args, environment(lf.url, target.url));
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("(6 spans sent, 6 accepted)");
    expect(target.rejected()).toBe(0);
    expect(new Map([...target.spans].map(([key, { canonical }]) => [key, canonical]))).toEqual(
      held,
    );
  });

  test("waits out Langfuse's rate limit for as long as Retry-After asks", async () => {
    let limited = 0;
    const lf = langfuse(
      { v2: v2Data() },
      {
        before: (url) =>
          url.searchParams.get("traceId") === TRACE_A && limited++ < 2
            ? new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "7" } })
            : undefined,
      },
    );
    const target = hue();
    const result = await run(
      ["langfuse", "--trace-id", TRACE_A, "--yes"],
      environment(lf.url, target.url),
    );
    expect(result.code).toBe(0);
    expect(result.sleeps).toEqual([7000, 7000]);
    expect(result.stderr).toContain("Langfuse rate limit; waiting 7 s.");
    expect(target.span(TRACE_A, TOOL_A)).toBeDefined();
  });

  test("--no-content sends metadata only", async () => {
    const lf = langfuse({ v2: v2Data() });
    const target = hue();
    const result = await run(
      ["langfuse", "--trace-id", TRACE_A, "--no-content", "--yes"],
      environment(lf.url, target.url),
    );
    expect(result.code).toBe(0);
    const generation = target.span(TRACE_A, GENERATION_A)!;
    expect(str(generation, "langfuse.observation.input")).toBeUndefined();
    expect(str(generation, "langfuse.observation.output")).toBeUndefined();
    expect(str(generation, "langfuse.observation.model.parameters")).toBeUndefined();
    expect(
      str(target.span(TRACE_A, TOOL_A)!, "langfuse.observation.status_message"),
    ).toBeUndefined();
    expect(str(generation, "langfuse.observation.model.name")).toBe("gpt-4.1-mini");
    expect(str(target.span(TRACE_A, ROOT_A)!, "langfuse.observation.metadata.channel")).toBe("web");
  });

  test("traces whose spans Hue refused are named, and the exit code says so", async () => {
    const lf = langfuse({ v2: v2Data() });
    const target = hue({ otlpStatus: 400 });
    const result = await run(
      ["langfuse", "--trace-id", TRACE_A, "--yes"],
      environment(lf.url, target.url),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Hue did not accept 3 spans");
    expect(result.stderr).toContain(`${TRACE_A}: Hue did not accept all of its spans`);
  });

  test("a stop request sends what was read and exits 130", async () => {
    let stop = () => {};
    const lf = langfuse(
      { v2: v2Data() },
      {
        // Stop while the second trace is being read.
        before: (url) => {
          if (url.searchParams.get("traceId") === TRACE_B) stop();
          return undefined;
        },
      },
    );
    const target = hue();
    const result = await run(
      ["langfuse", "--from", "2026-03-01", "--yes"],
      environment(lf.url, target.url),
      { onInterrupt: (listener) => ((stop = listener), () => {}) },
    );
    expect(result.code).toBe(130);
    expect(result.stderr).toContain("Stopping: sending what was read");
    expect(result.stderr).toContain("Run the same command again to resume");
    // The newest trace was sent before the stop.
    expect(target.span("1111111111111111111111111111111c", "c1c2c3c4c5c6c7c8")).toBeDefined();
  });

  test("asks before importing when a person is at the terminal", async () => {
    for (const [answer, code] of [
      ["n\n", 1],
      ["y\n", 0],
    ] as const) {
      const lf = langfuse({ v2: v2Data() });
      const target = hue();
      const stdin = Object.assign(new PassThrough(), { isTTY: true });
      stdin.end(answer);
      const result = await run(
        ["langfuse", "--trace-id", TRACE_A],
        environment(lf.url, target.url),
        {
          stdin,
        },
      );
      expect(result.stdout).toContain(
        `Import traces from ${lf.url} into the Hue project "Synthetic project" at ${target.url}? [y/N]`,
      );
      expect(result.code).toBe(code);
      expect(target.all().length).toBe(code === 0 ? 3 : 0);
    }
  });

  test("a page too large to answer is asked for again in smaller pages", async () => {
    const lf = langfuse(
      { v2: v2Data() },
      {
        before: (url) =>
          url.searchParams.get("traceId") === TRACE_A && url.searchParams.get("limit") === "100"
            ? new Response("Payload Too Large", { status: 413 })
            : undefined,
      },
    );
    const target = hue();
    const result = await run(
      ["langfuse", "--trace-id", TRACE_A, "--yes"],
      environment(lf.url, target.url),
    );
    expect(result.code).toBe(0);
    expect(
      lf.requests
        .filter((url) => url.searchParams.get("traceId") === TRACE_A)
        .map((url) => url.searchParams.get("limit")),
    ).toEqual(["100", "50", "50"]);
    expect(target.all()).toHaveLength(3);
  });

  test("refused Langfuse keys stop the import before anything is sent", async () => {
    const lf = langfuse({ v2: v2Data() });
    const target = hue();
    const result = await run(["langfuse", "--yes"], {
      ...environment(lf.url, target.url),
      LANGFUSE_SECRET_KEY: "sk-lf-wrong-secret",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Langfuse refused the keys (HTTP 401)");
    expect(result.stderr).not.toContain("sk-lf-wrong-secret");
    expect(target.all()).toEqual([]);
  });

  test("a refused Hue key stops the import before Langfuse is read", async () => {
    const lf = langfuse({ v2: v2Data() });
    const target = hue({ key: "another-key" });
    const result = await run(["langfuse", "--yes"], environment(lf.url, target.url));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Hue refused HUE_API_KEY (HTTP 401).");
    expect(lf.requests).toEqual([]);
  });
});

describe("hue import langfuse --media", () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452synthetic-png", "utf8");
  const wav = Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVEsynthetic-audio", "latin1");
  const pdf = Buffer.from("%PDF-1.7 synthetic", "utf8");
  const token = (type: string, id: string, source = "base64_data_uri") =>
    `@@@langfuseMedia:type=${type}|id=${id}|source=${source}@@@`;
  const input = JSON.stringify([
    {
      role: "user",
      content: [
        { type: "text", text: "What is in this image and recording?" },
        { type: "image_url", image_url: { url: token("image/png", "img001") } },
        { type: "input_audio", input_audio: { data: token("audio/wav", "aud001"), format: "wav" } },
      ],
    },
  ]);
  const observations = (): V2Observation[] => [
    {
      id: "e1e2e3e4e5e6e7e8",
      traceId: "3333333333333333333333333333333e",
      type: "GENERATION",
      name: "describe",
      startTime: "2026-03-10T00:00:00.000Z",
      endTime: "2026-03-10T00:00:01.000Z",
      parentObservationId: null,
      input,
      output: JSON.stringify(`See ${token("image/png", "img001", "bytes")} above.`),
      metadata: {
        attachment: token("application/pdf", "pdf001", "bytes"),
        gone: token("image/jpeg", "missing1", "bytes"),
      },
    },
    {
      id: "f1f2f3f4f5f6f7f8",
      traceId: "3333333333333333333333333333333e",
      type: "SPAN",
      name: "render",
      startTime: "2026-03-10T00:00:00.500Z",
      endTime: "2026-03-10T00:00:00.900Z",
      parentObservationId: "e1e2e3e4e5e6e7e8",
      // The whole value is one reference, recorded as a JSON string.
      output: JSON.stringify(token("image/png", "img001")),
    },
  ];
  const traceId = "3333333333333333333333333333333e";
  const spanId = "e1e2e3e4e5e6e7e8";

  test("uploads the referenced files under the trace and places them in digest form", async () => {
    const lf = langfuse({
      v2: observations(),
      media: {
        img001: { bytes: png, contentType: "image/png" },
        aud001: { bytes: wav, contentType: "audio/wav" },
        pdf001: { bytes: pdf, contentType: "application/pdf" },
      },
    });
    const target = hue();
    const result = await run(
      ["langfuse", "--trace-id", traceId, "--media", "--yes"],
      environment(lf.url, target.url),
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Media: 4 files uploaded, 2 left in Langfuse.");
    // Downloads went to the presigned link without the Langfuse keys.
    expect(lf.downloads.map((item) => item.id).sort()).toEqual(["aud001", "img001", "pdf001"]);
    expect(lf.downloads.every((item) => item.authorization === null)).toBe(true);
    expect([...target.store.keys()].sort()).toEqual(
      [png, wav, pdf].map((bytes) => `${traceId}/${sha256(bytes)}`).sort(),
    );
    // Each file was read once and reserved once, under the first place it was found in (the
    // newer observation, listed first).
    expect(target.reservations.map((item) => item.key).sort()).toEqual([
      "langfuse.observation.input#/0/content/2",
      "langfuse.observation.metadata.attachment#",
      "langfuse.observation.output#",
    ]);
    const render = target.span(traceId, "f1f2f3f4f5f6f7f8")!;
    expect(JSON.parse(str(render, "langfuse.observation.output")!)).toEqual({
      type: "blob",
      mime_type: "image/png",
      modality: "image",
      sha256: sha256(png),
      size: png.byteLength,
    });
    expect(
      attr(render, "hue.blobs")!.arrayValue!.values.map((item) => JSON.parse(item.stringValue!)),
    ).toEqual([
      {
        key: "langfuse.observation.output#",
        sha256: sha256(png),
        size: png.byteLength,
        content_type: "image/png",
      },
    ]);
    const span = target.span(traceId, spanId)!;
    // The provider parts keep their shape, their bytes replaced by the file's digest; every other
    // byte of the recorded text is kept.
    expect(JSON.parse(str(span, "langfuse.observation.input")!)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image and recording?" },
          { type: "image_url", image_url: {}, sha256: sha256(png), size: png.byteLength },
          {
            type: "input_audio",
            input_audio: { format: "wav" },
            sha256: sha256(wav),
            size: wav.byteLength,
          },
        ],
      },
    ]);
    expect(str(span, "langfuse.observation.input")!.startsWith('[{"role":"user","content":[')).toBe(
      true,
    );
    expect(JSON.parse(str(span, "langfuse.observation.metadata.attachment")!)).toEqual({
      type: "blob",
      mime_type: "application/pdf",
      modality: "document",
      sha256: sha256(pdf),
      size: pdf.byteLength,
    });
    // A file Langfuse holds no bytes for, and a reference inside longer text, stay as recorded.
    expect(str(span, "langfuse.observation.metadata.gone")).toBe(
      token("image/jpeg", "missing1", "bytes"),
    );
    expect(str(span, "langfuse.observation.output")).toBe(observations()[0]!.output as string);
    expect(
      attr(span, "hue.blobs")!.arrayValue!.values.map((item) => JSON.parse(item.stringValue!)),
    ).toEqual([
      {
        key: "langfuse.observation.input#/0/content/1",
        sha256: sha256(png),
        size: png.byteLength,
        content_type: "image/png",
      },
      {
        key: "langfuse.observation.input#/0/content/2",
        sha256: sha256(wav),
        size: wav.byteLength,
        content_type: "audio/wav",
      },
      {
        key: "langfuse.observation.metadata.attachment#",
        sha256: sha256(pdf),
        size: pdf.byteLength,
        content_type: "application/pdf",
      },
    ]);
    // A second run finds the files stored and sends the same span, which Hue keeps once.
    const again = await run(
      ["langfuse", "--trace-id", traceId, "--media", "--yes"],
      environment(lf.url, target.url),
    );
    expect(again.code).toBe(0);
    expect(target.rejected()).toBe(0);
  });

  test("without --media the references are sent as recorded", async () => {
    const lf = langfuse({ v2: observations() });
    const target = hue();
    const result = await run(
      ["langfuse", "--trace-id", traceId, "--yes"],
      environment(lf.url, target.url),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Media: 0 files uploaded, 6 left in Langfuse.");
    expect(str(target.span(traceId, spanId)!, "langfuse.observation.input")).toBe(input);
    expect(lf.downloads).toEqual([]);
  });

  test("a file that cannot be read now holds its span back for the next run", async () => {
    const media: Record<string, { bytes: Uint8Array; contentType: string } | "fails"> = {
      img001: "fails",
      aud001: { bytes: wav, contentType: "audio/wav" },
      pdf001: { bytes: pdf, contentType: "application/pdf" },
    };
    const lf = langfuse({ v2: observations(), media });
    const target = hue();
    const args = ["langfuse", "--trace-id", traceId, "--media", "--yes"];
    const first = await run(args, environment(lf.url, target.url));
    expect(first.code).toBe(1);
    expect(first.stderr).toContain(`Trace ${traceId} was not fully imported`);
    expect(first.stderr).toContain("Run the same command again to resume");
    expect(target.span(traceId, spanId)).toBeUndefined();
    media.img001 = { bytes: png, contentType: "image/png" };
    const second = await run(args, environment(lf.url, target.url));
    expect(second.code).toBe(0);
    expect(attr(target.span(traceId, spanId)!, "hue.blobs")!.arrayValue!.values).toHaveLength(3);
  });
});

describe("hue import langfuse through the v1 API", () => {
  const TRACE = "7c1d9e2a-4b3f-4e5d-8a6b-0c1d2e3f4a5b";
  const v1: V1Trace[] = [
    {
      id: TRACE,
      timestamp: "2026-03-03T12:00:00.000Z",
      name: "checkout",
      input: { cart: ["sku-1"] },
      output: "paid",
      metadata: { region: "eu", flags: { beta: true } },
      sessionId: "session-9",
      userId: "user-9",
      release: "v9",
      version: "3",
      tags: ["web"],
      public: false,
      environment: "default",
      observations: [
        {
          id: "obs-root",
          traceId: TRACE,
          type: "SPAN",
          name: "handle",
          // Recorded a moment before the trace's own timestamp.
          startTime: "2026-03-03T11:59:59.900Z",
          endTime: "2026-03-03T12:00:03.000Z",
          parentObservationId: null,
          input: { cart: ["sku-1"] },
          output: { status: "paid" },
          metadata: { step: 1 },
          level: "DEFAULT",
        },
        {
          id: "obs-llm",
          traceId: TRACE,
          type: "GENERATION",
          name: "summarize",
          startTime: "2026-03-03T12:00:01.000Z",
          endTime: "2026-03-03T12:00:04.000Z",
          parentObservationId: "obs-root",
          model: "claude-sonnet",
          usageDetails: { input: 10, output: 4 },
          input: [{ role: "user", content: "Summarize" }],
          output: "ok",
          level: "DEFAULT",
        },
      ],
    },
    {
      id: "older-trace",
      timestamp: "2026-01-03T12:00:00.000Z",
      name: "older",
      observations: [],
    },
  ];

  test("a deployment without the v2 API is read through v1, each trace as its own span", async () => {
    const lf = langfuse({ v1, pageCap: 1 });
    const target = hue();
    const result = await run(
      ["langfuse", "--from", "2026-03-01", "--yes"],
      environment(lf.url, target.url),
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("(Langfuse API v1)");
    expect(result.stdout).toContain("Imported 1 trace of 1 (3 spans sent, 3 accepted)");
    const listing = lf.requests.find((url) => url.pathname === "/api/public/traces")!;
    expect(listing.searchParams.get("fromTimestamp")).toBe("2026-03-01T00:00:00.000Z");
    expect(listing.searchParams.get("toTimestamp")).toBe("2026-04-01T00:00:00.000Z");
    // Observations came one per page.
    expect(
      lf.requests
        .filter((url) => url.pathname === "/api/public/observations")
        .map((url) => url.searchParams.get("page")),
    ).toEqual(["1", "2"]);
    const traceId = hueTraceId(TRACE);
    const spans = target.all().filter((span) => span.traceId === traceId);
    const top = spans.find((span) => span.parentSpanId === undefined)!;
    expect(top.name).toBe("checkout");
    expect(str(top, "langfuse.trace.name")).toBe("checkout");
    expect(str(top, "langfuse.trace.input")).toBe('{"cart":["sku-1"]}');
    expect(str(top, "langfuse.trace.output")).toBe("paid");
    expect(str(top, "langfuse.trace.metadata.region")).toBe("eu");
    expect(str(top, "langfuse.trace.metadata.flags")).toBe('{"beta":true}');
    expect(attr(top, "langfuse.trace.public")?.boolValue).toBe(false);
    expect(str(top, "langfuse.version")).toBe("3");
    // The trace's span covers its observations, from the earliest start to the last end.
    expect(top.startTimeUnixNano).toBe("1772539199900000000");
    expect(top.endTimeUnixNano).toBe("1772539204000000000");
    const handle = target.span(traceId, hueSpanId(TRACE, "obs-root"))!;
    expect(handle.parentSpanId).toBe(top.spanId);
    expect(str(handle, "langfuse.observation.input")).toBe('{"cart":["sku-1"]}');
    expect(str(handle, "langfuse.observation.metadata.step")).toBe("1");
    expect(str(handle, "langfuse.trace.name")).toBe("checkout");
    expect(str(handle, "langfuse.user.id")).toBe("user-9");
    const llm = target.span(traceId, hueSpanId(TRACE, "obs-llm"))!;
    expect(llm.parentSpanId).toBe(handle.spanId);
    expect(attr(llm, "gen_ai.usage.input_tokens")?.intValue).toBe("10");
    expect(str(llm, "langfuse.observation.output")).toBe("ok");
  });

  test("an unknown --trace-id is reported as not imported", async () => {
    const lf = langfuse({ v1 });
    const target = hue();
    const result = await run(
      ["langfuse", "--trace-id", "no-such-trace", "--yes"],
      environment(lf.url, target.url),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no-such-trace: Langfuse holds no trace with this id");
  });
});

describe("hue import usage", () => {
  const env = {
    LANGFUSE_PUBLIC_KEY: PUBLIC_KEY,
    LANGFUSE_SECRET_KEY: SECRET_KEY,
    HUE_API_KEY: HUE_KEY,
  };
  for (const [args, message] of [
    [["langfuse", "--trace-id", "t1", "--from", "2026-01-01", "--yes"], "--trace-id selects"],
    [["langfuse", "--media", "--no-content", "--yes"], "--media uploads content"],
    [["langfuse", "--from", "2026-01-01T09:00:00", "--yes"], "--from must be an ISO 8601 date"],
    [["langfuse", "--to", "2026-02-30", "--yes"], "--to must be an ISO 8601 date"],
    [
      ["langfuse", "--from", "2026-03-02", "--to", "2026-03-01", "--yes"],
      "--from must be before --to",
    ],
    [["langfuse", "--limit", "0", "--yes"], "--limit must be a positive integer"],
    [["braintrust", "--yes"], "Unknown source: braintrust"],
    [[], "Name the source to import: langfuse"],
    [["langfuse"], "Pass --yes to import without a terminal"],
    [["langfuse", "--langfuse-host", "http://langfuse.example.com", "--yes"], "must use https"],
    [["langfuse", "--langfuse-public-key", SECRET_KEY, "--yes"], "is a secret key"],
  ] as const)
    test(`${args.join(" ") || "no source"} is a usage error`, async () => {
      const result = await run([...args], env, { stdin: { isTTY: false } as never });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(message);
      expect(result.stderr).toContain("Usage: hue import langfuse");
      expect(result.stderr).not.toContain(SECRET_KEY);
    });

  test("--help prints the usage", async () => {
    const result = await run(["langfuse", "--help"], {});
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${IMPORT_USAGE}\n`);
  });

  test("parses only exact media references", () => {
    expect(parseMediaToken("@@@langfuseMedia:type=image/png|id=abc_1|source=bytes@@@")).toEqual({
      type: "image/png",
      id: "abc_1",
      source: "bytes",
    });
    for (const text of [
      "@@@langfuseMedia:type=image/png|id=abc|source=bytes@@@ ",
      "@@@langfuseMedia:type=image/png|id=a/b|source=bytes@@@",
      "@@@langfuseMedia:type=png|id=abc|source=bytes@@@",
      "@@@langfuseMedia:type=image/png|id=abc|id=def|source=bytes@@@",
      "@@@langfuseMedia:type=image/png|id=abc|source=bytes@@@\n@@@langfuseMedia:type=image/png|id=d|source=bytes@@@",
    ])
      expect(parseMediaToken(text)).toBeUndefined();
  });
});

describe("the hue binary", () => {
  test("runs hue import langfuse", async () => {
    const lf = langfuse({ v2: v2Data() });
    const child = spawn(
      process.execPath,
      [cli, "import", "langfuse", "--dry-run", "--from", "2026-03-01"],
      {
        env: {
          PATH: process.env.PATH ?? "",
          LANGFUSE_PUBLIC_KEY: PUBLIC_KEY,
          LANGFUSE_SECRET_KEY: SECRET_KEY,
          LANGFUSE_BASE_URL: lf.url,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    const code = await new Promise<number | null>((done) => child.on("close", done));
    expect(output).toContain("Dry run: 3 traces, 6 spans and 0 media references");
    expect(code).toBe(0);
  }, 30_000);
});
