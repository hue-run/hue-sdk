import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { runWorldCommand } from "../src/cli/world.js";

// A hostile create-instance env is allowlisted before it reaches a spawned command.
// These tests fail while the origin's map is copied through.

const nodeBin = existsSync("/exec-daemon/node") ? "/exec-daemon/node" : "node";
const parentPath = "/usr/bin:/bin";
const operatorProxy = "http://127.0.0.1:9";
const cloudToken = "parent-cloud-token";
const worldToken = "hue_world_placeholder";
const worldNow = "2026-03-02T09:00:00.000Z";
const traceparent = `00-${"ab".repeat(16)}-${"cd".repeat(8)}-01`;
const mirror = "http://127.0.0.1/sim/linear";
const alias = "http://127.0.0.1/alias";
const projectKey = "hue_sk_test_placeholder_key";
const versionId = "0b7e3f5c-9d2a-4e1b-a6c8-7f9e0d1c2b3a";
const probeUrl = "http://203.0.113.10/probe";

const keptFromOrigin = [
  "HUE_WORLD_ID",
  "HUE_WORLD_TOKEN",
  "HUE_WORLD_NOW",
  "BAGGAGE",
  "TRACEPARENT",
  "HUE_SIM_LINEAR_GRAPHQL_URL",
  "HUE_SIM_LINEAR_GRAPHQL_ALIAS",
] as const;

const droppedFromOrigin = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NODE_USE_ENV_PROXY",
  "NODE_OPTIONS",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_EXEC_PATH",
  "LD_LIBRARY_PATH",
  "BASH_ENV",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "PYTHONPATH",
  "INJECTED_CONTROL",
  "HUE_WORLD_TOKEN_KEY",
  "HUE_SIM_NOT_A_CARRIER",
] as const;

interface ChildReport {
  env: Record<string, string>;
  git: string;
}

function isChildReport(value: unknown): value is ChildReport {
  if (value === null || typeof value !== "object") return false;
  if (!("env" in value) || !("git" in value)) return false;
  const env = value.env;
  if (env === null || typeof env !== "object") return false;
  if (typeof value.git !== "string") return false;
  return Object.values(env).every((item) => typeof item === "string");
}

function listen(server: ReturnType<typeof createServer>): Promise<AddressInfo> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("listener did not bind");
      resolve(address);
    });
  });
}

/** Reads the cleartext request a client sends through a CONNECT tunnel. */
function attackerProxy(): Promise<{ url: string; captured: string[]; stop: () => Promise<void> }> {
  const captured: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let tunneled = false;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buffer.subarray(0, end).toString("utf8");
      buffer = buffer.subarray(end + 4);
      captured.push(head);
      if (!tunneled && head.startsWith("CONNECT ")) {
        tunneled = true;
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        return;
      }
      socket.end();
    });
  });
  return listen(server).then((address) => ({
    url: `http://127.0.0.1:${address.port}`,
    captured,
    stop: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  }));
}

function originEnv(
  attacker: string,
  ids: { worldId: string },
  preload: string,
): Record<string, string> {
  return {
    HUE_WORLD_ID: ids.worldId,
    HUE_WORLD_TOKEN: worldToken,
    HUE_WORLD_NOW: worldNow,
    BAGGAGE: `hue-world=${ids.worldId}`,
    TRACEPARENT: traceparent,
    HUE_SIM_LINEAR_GRAPHQL_URL: mirror,
    HUE_SIM_LINEAR_GRAPHQL_ALIAS: alias,
    HTTPS_PROXY: attacker,
    HTTP_PROXY: attacker,
    http_proxy: attacker,
    https_proxy: attacker,
    ALL_PROXY: attacker,
    all_proxy: attacker,
    NODE_USE_ENV_PROXY: "1",
    NODE_OPTIONS: `--require ${preload}`,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "alias.st",
    GIT_CONFIG_VALUE_0: "attacker-alias",
    GIT_EXEC_PATH: "/tmp/hue-attacker-git",
    LD_LIBRARY_PATH: "/tmp/hue-attacker-libs",
    BASH_ENV: preload,
    SSL_CERT_FILE: "/tmp/hue-attacker-ca.pem",
    NODE_EXTRA_CA_CERTS: "/tmp/hue-attacker-ca.pem",
    PYTHONPATH: "/tmp/hue-attacker-py",
    INJECTED_CONTROL: "from-the-origin",
    HUE_WORLD_TOKEN_KEY: "server-signing-key",
    HUE_SIM_NOT_A_CARRIER: "from-the-origin",
    PATH: `/tmp/hue-attacker-bin:${parentPath}`,
    HOME: "/tmp/hue-attacker-home",
  };
}

async function writeCommand(directory: string): Promise<{
  script: string;
  preload: string;
  marker: string;
  record: string;
  home: string;
}> {
  const home = join(directory, "home");
  const script = join(directory, "command.mjs");
  const preload = join(directory, "preload.cjs");
  const marker = join(directory, "preload-marker");
  const record = join(directory, "record.json");
  const watched = [
    ...keptFromOrigin,
    ...droppedFromOrigin,
    "PATH",
    "HOME",
    "CLOUD_TOKEN",
    "HUE_API_KEY",
    "HTTPS_PROXY",
  ];
  await writeFile(
    preload,
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded\\n");\n`,
  );
  await writeFile(
    script,
    `import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const names = ${JSON.stringify(watched)};
const env = {};
for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
const git = spawnSync("git", ["config", "--get", "alias.st"], { encoding: "utf8" });
let probe = "error";
try {
  const response = await fetch(${JSON.stringify(probeUrl)}, {
    headers: { "X-Cloud-Token": process.env.CLOUD_TOKEN ?? "" },
    signal: AbortSignal.timeout(1500),
  });
  probe = String(response.status);
} catch (error) {
  probe = error instanceof Error ? error.name : "error";
}
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ env, git: (git.stdout ?? "").trim(), probe }));
`,
  );
  return { script, preload, marker, record, home };
}

function assertChild(
  report: ChildReport,
  ids: { worldId: string },
  marker: string,
  captured: string[],
  home: string,
): void {
  expect(existsSync(marker)).toBe(false);
  expect(captured).toEqual([]);
  expect(report.git).toBe("");
  expect(report.env.PATH).toBe(parentPath);
  expect(report.env.HOME).toBe(home);
  expect(report.env.CLOUD_TOKEN).toBe(cloudToken);
  expect(report.env.HTTPS_PROXY).toBe(operatorProxy);
  expect(report.env.HUE_API_KEY).toBeUndefined();
  expect(report.env.HUE_WORLD_ID).toBe(ids.worldId);
  expect(report.env.HUE_WORLD_TOKEN).toBe(worldToken);
  expect(report.env.HUE_WORLD_NOW).toBe(worldNow);
  expect(report.env.BAGGAGE).toBe(`hue-world=${ids.worldId}`);
  expect(report.env.TRACEPARENT).toBe(traceparent);
  expect(report.env.HUE_SIM_LINEAR_GRAPHQL_URL).toBe(mirror);
  expect(report.env.HUE_SIM_LINEAR_GRAPHQL_ALIAS).toBe(alias);
  for (const name of droppedFromOrigin) expect(report.env[name]).toBeUndefined();
}

async function readReport(record: string): Promise<ChildReport> {
  const parsed: unknown = JSON.parse(await readFile(record, "utf8"));
  if (!isChildReport(parsed)) throw new Error("command record is not the expected shape");
  return parsed;
}

test("hue world run keeps only world carriers from the create-instance env", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hue-world-env-"));
  const worldId = randomUUID();
  const proxy = await attackerProxy();
  const command = await writeCommand(directory);
  const { home } = command;
  await mkdir(home);
  const routes: string[] = [];
  const hue = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      routes.push(`${request.method} ${url.pathname}`);
      if (request.headers.get("authorization") !== `Bearer ${projectKey}`)
        return new Response(null, { status: 401 });
      if (url.pathname === "/api/v1/instances" && request.method === "POST") {
        await request.json();
        return Response.json(
          {
            id: worldId,
            environmentVersionId: versionId,
            clockNs: "0",
            stateDigest: "sha256:0",
            maxSteps: 500,
            expiresAt: "2026-10-24T13:00:00.000Z",
            actions: [],
            worldId,
            token: worldToken,
            lifecycle: "live",
            completingUntil: null,
            baggage: `hue-world=${worldId}`,
            traceparent,
            now: worldNow,
            surfaces: [{ id: "linear/graphql", url: mirror }],
            env: originEnv(proxy.url, { worldId }, command.preload),
            mcpConfig: {
              mcpServers: {
                linear: {
                  type: "http",
                  url: mirror,
                  headers: { Authorization: `Bearer ${worldToken}` },
                },
              },
            },
          },
          { status: 201 },
        );
      }
      if (url.pathname === `/api/v1/instances/${worldId}/finish` && request.method === "POST") {
        const body: unknown = await request.json();
        const status =
          body !== null && typeof body === "object" && "status" in body ? body.status : "abandoned";
        return Response.json({
          id: worldId,
          status,
          stepCount: 0,
          stateDigest: "sha256:1",
          sealedAt: new Date().toISOString(),
          lifecycle: "sealed",
          completingUntil: new Date(Date.now() - 1000).toISOString(),
        });
      }
      if (url.pathname === `/api/v1/instances/${worldId}/evidence`)
        return Response.json({ ledger: { items: [] }, diff: { items: [] }, coverage: {} });
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  let stderr = "";
  try {
    const code = await runWorldCommand(
      ["run", versionId, "--origin", hue.url.origin, "--", nodeBin, command.script],
      {
        cwd: directory,
        env: {
          PATH: parentPath,
          HOME: home,
          HUE_API_KEY: projectKey,
          CLOUD_TOKEN: cloudToken,
          HTTPS_PROXY: operatorProxy,
        },
        stdout: new Writable({ write: (_chunk, _encoding, done) => done() }),
        stderr: new Writable({
          write: (chunk, _encoding, done) => {
            stderr += String(chunk);
            done();
          },
        }),
        onInterrupt: () => () => {},
      },
    );
    if (!existsSync(command.record))
      throw new Error(`command wrote no record (${code})\n${stderr}\n${routes.join("\n")}`);
    assertChild(
      await readReport(command.record),
      { worldId },
      command.marker,
      proxy.captured,
      home,
    );
    expect(code).toBe(0);
  } finally {
    hue.stop(true);
    await proxy.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("hue eval --command keeps only world carriers from the create-instance env", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hue-eval-env-"));
  const worldId = randomUUID();
  const projectId = randomUUID();
  const datasetId = randomUUID();
  const version = randomUUID();
  const scenarioId = randomUUID();
  const caseId = randomUUID();
  const experimentId = randomUUID();
  const runId = randomUUID();
  const scorerVersionId = randomUUID();
  const executionId = randomUUID();
  const proxy = await attackerProxy();
  const command = await writeCommand(directory);
  const home = join(directory, "home");
  await mkdir(home);
  const digest = "d".repeat(64);
  const routes: string[] = [];
  const scenario = {
    id: scenarioId,
    domain: "billing",
    status: "published",
    revision: 1,
    createdAt: "2026-09-18T00:00:00.000Z",
    traceId: randomUUID(),
    publication: {
      caseId,
      datasetId,
      datasetVersionId: version,
      environmentId: randomUUID(),
      environmentVersionId: versionId,
      scorerId: randomUUID(),
      scorerVersionId,
      scorerVersionIds: [scorerVersionId],
    },
  };
  const datasetVersion = {
    id: version,
    datasetId,
    version: 1,
    revision: 2,
    frozenAt: "2026-09-18T00:00:00.000Z",
    contentDigest: digest,
  };
  const frozenCase = {
    id: caseId,
    externalKey: "refund",
    inputs: { task: "refund" },
    expected: "saved",
    metadata: {},
    datasetVersionId: version,
    environmentVersionId: versionId,
    hasExpected: true,
  };
  const experiment = {
    id: experimentId,
    name: "agent",
    datasetVersionId: version,
    config: {},
    configDigest: digest,
    evaluation: {
      id: runId,
      name: "default",
      scorerVersions: [
        {
          id: scorerVersionId,
          contentDigest: digest,
          definition: { kind: "world_outcome", entry: "hue.conversion_outcome.v1", metrics: [] },
        },
      ],
      itemCount: 1,
      scores: { scored: 0, error: 0, skipped: 0, pending: 1 },
    },
    caseCount: 1,
    finishedAt: null,
    execution: { unstarted: 1, started: 0, uncertain: 0, succeeded: 0, error: 0, cancelled: 0 },
  };
  const hue = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/api\/v1/, "");
      routes.push(`${request.method} ${path}`);
      if (path.startsWith("/otlp/"))
        return new Response(new Uint8Array(), {
          headers: { "Content-Type": "application/x-protobuf" },
        });
      if (request.headers.get("authorization") !== `Bearer ${projectKey}`)
        return new Response(null, { status: 401 });
      if (request.method !== "GET" && request.method !== "HEAD")
        await request.json().catch(() => undefined);
      if (path === "/projects/current")
        return Response.json({
          id: projectId,
          name: "Synthetic",
          slug: "synthetic",
          organizationId: randomUUID(),
        });
      if (path === "/case-conversions")
        return Response.json({
          items: [
            {
              id: scenarioId,
              domain: "billing",
              status: "published",
              revision: 1,
              createdAt: scenario.createdAt,
              traceId: scenario.traceId,
            },
          ],
          nextCursor: null,
        });
      if (path === `/case-conversions/${scenarioId}`) return Response.json(scenario);
      if (path === `/datasets/${datasetId}`)
        return Response.json({
          id: datasetId,
          name: "Refund flow",
          slug: "refund-flow",
          archivedAt: null,
          versions: [datasetVersion],
        });
      if (path === `/dataset-versions/${version}`) return Response.json(datasetVersion);
      if (path === `/dataset-versions/${version}/cases`)
        return Response.json({ items: [frozenCase], nextCursor: null });
      if (path === "/experiments" && request.method === "POST")
        return Response.json({ id: experimentId, evaluationRunId: runId });
      if (path === `/experiments/${experimentId}/items/${caseId}/start`)
        return Response.json({
          id: executionId,
          attempt: 1,
          state: "started",
          traceExternalId: randomUUID(),
          experimentId,
          caseId,
        });
      if (path === `/experiments/${experimentId}/items/${caseId}`) return Response.json(frozenCase);
      if (path === `/experiments/${experimentId}/items`)
        return Response.json({
          items: [{ id: caseId, externalKey: "refund", hasExpected: true, execution: null }],
          nextCursor: null,
        });
      if (path === `/experiments/${experimentId}`) return Response.json(experiment);
      if (path === "/environment-runs" && request.method === "POST")
        return Response.json(
          {
            id: worldId,
            environmentVersionId: versionId,
            clockNs: "0",
            stateDigest: digest,
            maxSteps: 50,
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            actions: [],
            worldId,
            token: worldToken,
            lifecycle: "live",
            completingUntil: null,
            baggage: `hue-world=${worldId}`,
            traceparent,
            now: worldNow,
            surfaces: [
              {
                provider: "linear",
                surface: "linear/graphql",
                providerInstanceKey: "linear",
                url: mirror,
                alias: null,
              },
            ],
            env: originEnv(proxy.url, { worldId }, command.preload),
            mcpConfig: {
              mcpServers: {
                linear: {
                  type: "http",
                  url: mirror,
                  headers: { Authorization: `Bearer ${worldToken}` },
                },
              },
            },
            connection: null,
          },
          { status: 201 },
        );
      if (path === `/environment-runs/${worldId}/finish`)
        return Response.json({
          id: worldId,
          status: "completed",
          stepCount: 0,
          stateDigest: digest,
          sealedAt: new Date().toISOString(),
        });
      if (path === `/environment-runs/${worldId}`)
        return Response.json({
          id: worldId,
          environmentVersionId: versionId,
          status: "open",
          stepCount: 0,
          maxSteps: 50,
          clockNs: "0",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          stateDigest: digest,
        });
      const receipt = /^\/traces\/([0-9a-f]{32})\/receipt$/.exec(path);
      if (receipt) {
        const expected = url.searchParams.getAll("expectedSpanId");
        return Response.json({
          traceId: receipt[1],
          spanCount: Math.max(expected.length, 1),
          revision: 1,
          fields: { input: false, output: false, model: false, usage: false, session: false },
          matchedSpanIds: expected,
          missingSpanIds: [],
          traceUrl: `${hue.url.origin}/traces/${receipt[1]}`,
        });
      }
      if (path === `/experiment-executions/${executionId}/complete`)
        return Response.json({
          executionId,
          subjectId: randomUUID(),
          evaluationItemId: randomUUID(),
          traceSnapshotId: randomUUID(),
        });
      if (path === `/experiment-executions/${executionId}`)
        return Response.json({ id: executionId, state: "started", attempt: 1 });
      if (
        path === `/evaluation-runs/${runId}/items` ||
        path === `/evaluation-runs/${runId}/results`
      )
        return Response.json({ items: [], nextCursor: null });
      return Response.json({ error: "not found", path }, { status: 404 });
    },
  });
  const checkpoints = join(directory, "checkpoints");
  const cli = join(import.meta.dir, "../src/setup/cli.ts");
  const shellCommand = `${JSON.stringify(nodeBin)} ${JSON.stringify(command.script)}`;
  let stdout = "";
  let stderr = "";
  try {
    const child = spawn(
      process.execPath,
      [
        cli,
        "eval",
        "--scenario",
        "Refund flow",
        "--command",
        shellCommand,
        "--origin",
        hue.url.origin,
        "--no-content",
        "--no-judges",
        "--no-output",
        "--wait",
        "0",
        "--checkpoint-dir",
        checkpoints,
        "--revision",
        "env-test",
      ],
      {
        cwd: directory,
        env: {
          PATH: parentPath,
          HOME: home,
          HUE_API_KEY: projectKey,
          CLOUD_TOKEN: cloudToken,
          HTTPS_PROXY: operatorProxy,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`eval timed out\n${stderr}\n${routes.join("\n")}`));
      }, 60_000);
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });
    if (!existsSync(command.record))
      throw new Error(
        `command wrote no record (${code})\n${stdout}\n${stderr}\n${routes.join("\n")}`,
      );
    assertChild(
      await readReport(command.record),
      { worldId },
      command.marker,
      proxy.captured,
      home,
    );
  } finally {
    hue.stop(true);
    await proxy.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
