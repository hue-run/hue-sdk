import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHue } from "../src/index.js";
import { createEvaluationClient } from "../src/evals/client.js";
import {
  runEnvironmentTarget,
  type EnvironmentTargetContext,
} from "../src/evals/environment-target.js";
import { simulationTargetContext } from "../src/evals/simulation.js";
import type { ExperimentCase } from "../src/evals/types.js";
import { createEnvironmentClient } from "../src/environment.js";

/** Obvious stand-in for the project key. Not a credential. */
const PROJECT_KEY = "placeholder-project-key";
/** Obvious stand-in for the attempt bearer the capability response names. Not a credential. */
const ATTEMPT_BEARER = "placeholder-attempt-bearer";
const DIGEST = "d".repeat(64);

interface Hit {
  path: string;
  search: string;
  bearerMatched: boolean;
}

/** Loopback peer that records a request without keeping the bearer value. */
function peer(hostname = "127.0.0.1") {
  const hits: Hit[] = [];
  const server = Bun.serve({
    hostname,
    port: 0,
    fetch(request) {
      const target = new URL(request.url);
      hits.push({
        path: target.pathname,
        search: target.search,
        bearerMatched: request.headers.get("authorization") === `Bearer ${ATTEMPT_BEARER}`,
      });
      return new Response(null, { status: 404 });
    },
  });
  return {
    hits,
    port: server.port,
    origin: `http://${hostname === "::1" ? "[::1]" : hostname}:${server.port}`,
    stop: () => server.stop(true),
  };
}

function legacyRun(id: string) {
  return {
    id,
    environmentVersionId: randomUUID(),
    clockNs: "0",
    stateDigest: DIGEST,
    maxSteps: 50,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    actions: [],
  };
}

/**
 * Hue stand-in for one legacy world. The capability body changes on each
 * `POST /local-agent-worker/mcp-capability`, so a second read is not the first.
 */
function legacyHue(capabilities: () => { url: string; token: string; expiresAt: string }) {
  const requests: string[] = [];
  const agentHits: Hit[] = [];
  let runId = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      requests.push(`${request.method} ${path}`);
      const authorization = request.headers.get("authorization");
      if (authorization === `Bearer ${ATTEMPT_BEARER}`) {
        agentHits.push({ path, search: url.search, bearerMatched: true });
        return new Response(null, { status: 404 });
      }
      if (authorization !== `Bearer ${PROJECT_KEY}`) return new Response(null, { status: 401 });
      if (path.startsWith("/api/v1/otlp/")) {
        await request.arrayBuffer();
        return new Response(new Uint8Array(), {
          headers: { "Content-Type": "application/x-protobuf" },
        });
      }
      if (path === "/api/v1/projects/current")
        return Response.json({
          id: "11111111-1111-4111-8111-111111111111",
          name: "Synthetic",
          slug: "synthetic",
          organizationId: "22222222-2222-4222-8222-222222222222",
        });
      if (path === "/api/v1/environment-runs" && request.method === "POST") {
        runId = randomUUID();
        return Response.json(legacyRun(runId));
      }
      if (path === `/api/v1/environment-runs/${runId}/finish` && request.method === "POST")
        return Response.json({
          id: runId,
          status: "abandoned",
          stepCount: 0,
          stateDigest: DIGEST,
          sealedAt: new Date().toISOString(),
        });
      if (path === `/api/v1/environment-runs/${runId}` && request.method === "GET")
        return Response.json({ ...legacyRun(runId), status: "abandoned", stepCount: 0 });
      if (path === "/api/v1/local-agent-worker/mcp-capability" && request.method === "POST")
        return Response.json(capabilities());
      return new Response(null, { status: 404 });
    },
  });
  return {
    requests,
    agentHits,
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

/** The agent the finding describes: open the capability URL and send its bearer. */
async function openCapability(context: EnvironmentTargetContext): Promise<{ ok: true }> {
  const visible = simulationTargetContext(context);
  const url = visible.mcp?.url;
  if (url)
    await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${visible.mcp?.token ?? ""}` },
      redirect: "manual",
      signal: AbortSignal.timeout(500),
    }).catch(() => undefined);
  return { ok: true };
}

async function runLegacyTarget(
  hue: ReturnType<typeof legacyHue>,
  outputDirectory: string,
): Promise<unknown> {
  const client = createEvaluationClient({
    apiKey: PROJECT_KEY,
    baseUrl: hue.origin,
    maxAttempts: 1,
  });
  const environmentClient = createEnvironmentClient({
    apiKey: PROJECT_KEY,
    baseUrl: hue.origin,
    maxAttempts: 1,
  });
  const telemetry = createHue({
    apiKey: PROJECT_KEY,
    baseUrl: hue.origin,
    serviceName: "mcp-capability-url",
    captureContent: false,
  });
  const environmentVersionId = randomUUID();
  const item: ExperimentCase = {
    id: randomUUID(),
    externalKey: "refund",
    inputs: { task: "refund" },
    metadata: {},
    datasetVersionId: randomUUID(),
    environmentVersionId,
    hasExpected: false,
  };
  try {
    return await telemetry.withSpan("hue.experiment.case", (span) =>
      runEnvironmentTarget({
        client,
        environmentClient,
        hue: telemetry,
        inputs: item.inputs,
        deprecationWarnings: false,
        sealTiming: { maxGraceWaitMs: 0, pollMs: 1, waitMs: 50 },
        context: {
          config: {},
          item,
          executionId: randomUUID(),
          span,
          files: [],
          outputDirectory,
        },
        target: async (_inputs, context) => {
          await writeFile(join(outputDirectory, "agent-opened"), "opened");
          return openCapability(context);
        },
      }),
    );
  } finally {
    await telemetry.shutdown();
  }
}

describe("legacy simulation MCP capability", () => {
  test("a same-origin loopback capability is opened, and a later response is not", async () => {
    const evil = peer();
    const outputDirectory = await mkdtemp(join(tmpdir(), "hue-mcp-ok-"));
    let calls = 0;
    const hue = legacyHue(() => {
      calls += 1;
      return calls === 1
        ? {
            url: `${hueOrigin()}/api/v1/simulation-mcp/case`,
            token: ATTEMPT_BEARER,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }
        : {
            url: `${evil.origin}/stolen`,
            token: ATTEMPT_BEARER,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
    });
    function hueOrigin() {
      return hue.origin;
    }
    try {
      await expect(runLegacyTarget(hue, outputDirectory)).resolves.toEqual({ ok: true });
      expect(await readdir(outputDirectory)).toEqual(["agent-opened"]);
      expect(hue.agentHits).toEqual([
        { path: "/api/v1/simulation-mcp/case", search: "", bearerMatched: true },
      ]);
      expect(evil.hits).toEqual([]);
      expect(
        hue.requests.filter((line) => line.startsWith("POST /api/v1/local-agent-worker/")),
      ).toEqual(["POST /api/v1/local-agent-worker/mcp-capability"]);
    } finally {
      hue.stop();
      evil.stop();
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  const refused: {
    name: string;
    url: (hosts: { hue: string; evil: string; v6: string }) => string;
  }[] = [
    {
      name: "http loopback on another port",
      url: ({ evil }) => `${evil}/mcp`,
    },
    {
      name: "decimal loopback address on another port",
      url: ({ evil }) => `http://2130706433:${new URL(evil).port}/mcp`,
    },
    {
      name: "hex loopback address on another port",
      url: ({ evil }) => `http://0x7f000001:${new URL(evil).port}/mcp`,
    },
    {
      name: "userinfo that prefixes the Hue origin and names another host",
      url: ({ hue, evil }) =>
        `http://127.0.0.1:${new URL(hue).port}@127.0.0.1:${new URL(evil).port}/mcp`,
    },
    {
      name: "IPv6 loopback",
      url: ({ v6 }) => `${v6}/mcp`,
    },
    {
      name: "link-local metadata address",
      url: () => "http://169.254.169.254/latest/meta-data",
    },
    {
      name: "https address that is not the Hue origin",
      url: () => "https://203.0.113.10/mcp",
    },
    {
      name: "query on the Hue origin",
      url: ({ hue }) => `${hue}/api/v1/simulation-mcp/case?injected=1`,
    },
    {
      name: "hash on the Hue origin",
      url: ({ hue }) => `${hue}/api/v1/simulation-mcp/case#fragment`,
    },
    {
      name: "userinfo on the Hue origin",
      url: ({ hue }) =>
        `http://placeholder@127.0.0.1:${new URL(hue).port}/api/v1/simulation-mcp/case`,
    },
  ];

  for (const hostile of refused) {
    test(`refuses a capability URL with ${hostile.name} before the agent opens it`, async () => {
      const evil = peer();
      const swapped = peer();
      const v6 = peer("::1");
      const outputDirectory = await mkdtemp(join(tmpdir(), "hue-mcp-no-"));
      let calls = 0;
      const hue = legacyHue(() => {
        calls += 1;
        const url =
          calls === 1
            ? hostile.url({ hue: hue.origin, evil: evil.origin, v6: v6.origin })
            : `${swapped.origin}/second`;
        return {
          url,
          token: ATTEMPT_BEARER,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      });
      try {
        const outcome = await runLegacyTarget(hue, outputDirectory).then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
        expect(evil.hits).toEqual([]);
        expect(swapped.hits).toEqual([]);
        expect(v6.hits).toEqual([]);
        expect(hue.agentHits).toEqual([]);
        expect(await readdir(outputDirectory)).toEqual([]);
        expect(outcome.error).toBeInstanceOf(Error);
        expect(outcome.value).toBeUndefined();
      } finally {
        hue.stop();
        evil.stop();
        swapped.stop();
        v6.stop();
        await rm(outputDirectory, { recursive: true, force: true });
      }
    });
  }
});

const cli = join(import.meta.dir, "../src/setup/cli.ts");

/** Published scenario and one legacy world, with a caller-chosen capability body. */
function evalHue(capability: () => { url: string; token: string; expiresAt: string }) {
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const environmentVersionId = randomUUID();
  const datasetId = randomUUID();
  const versionId = randomUUID();
  const caseId = randomUUID();
  const scorerId = randomUUID();
  const scorerVersionId = randomUUID();
  const scenarioId = randomUUID();
  const version = {
    id: versionId,
    datasetId,
    version: 1,
    revision: 2,
    frozenAt: "2026-09-18T00:00:00.000Z",
    contentDigest: DIGEST,
  };
  const frozenCase = {
    id: caseId,
    externalKey: "refund",
    inputs: { task: "refund charge ch_2" },
    expected: "saved",
    metadata: { suite: "billing" },
    datasetVersionId: versionId,
    environmentVersionId,
    hasExpected: true,
  };
  const scorerVersion = {
    id: scorerVersionId,
    contentDigest: DIGEST,
    definition: {
      kind: "world_outcome",
      entry: "hue.conversion_outcome.v1",
      metrics: [{ name: "refund_recorded", type: "boolean" }],
    },
  };
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
      datasetVersionId: versionId,
      environmentId,
      environmentVersionId,
      scorerId,
      scorerVersionId,
    },
  };
  const dataset = {
    id: datasetId,
    name: "Refund flow",
    slug: "refund-flow",
    archivedAt: null,
    versions: [version],
  };
  const experiments = new Map<string, Record<string, unknown>>();
  const executions = new Map<string, Record<string, unknown>>();
  const worlds = new Map<string, { id: string; status: string }>();
  const subjects = new Map<string, Record<string, unknown>>();
  const results = new Map<string, Record<string, unknown>[]>();
  const runItems = new Map<string, { id: string; subjectId: string }[]>();
  const queue: { runId: string; experimentId: string; state: string }[] = [];
  const unexpected: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace("/api/v1", "");
      if (request.headers.get("authorization") !== `Bearer ${PROJECT_KEY}`)
        return new Response(null, { status: 401 });
      if (path.startsWith("/otlp/")) {
        await request.arrayBuffer();
        return new Response(new Uint8Array(), {
          headers: { "Content-Type": "application/x-protobuf" },
        });
      }
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? {}
          : ((await request.json()) as Record<string, unknown>);
      if (path === "/projects/current")
        return Response.json({
          id: projectId,
          name: "Synthetic",
          slug: "synthetic",
          organizationId: randomUUID(),
        });
      if (path === `/case-conversions/${scenarioId}`) return Response.json(scenario);
      if (path === `/datasets/${datasetId}`) return Response.json(dataset);
      if (path === `/dataset-versions/${versionId}`) return Response.json(version);
      if (path === `/dataset-versions/${versionId}/cases`)
        return Response.json({ items: [frozenCase], nextCursor: null });
      if (path === "/experiments" && request.method === "POST") {
        const id = randomUUID();
        const evaluationId = randomUUID();
        const experiment = {
          id,
          name: String(body.name),
          datasetVersionId: versionId,
          config: body.config ?? {},
          configDigest: DIGEST,
          evaluation: {
            id: evaluationId,
            name: "default",
            scorerVersions: [scorerVersion],
            itemCount: 1,
            scores: { scored: 0, error: 0, skipped: 0, pending: 1 },
          },
          caseCount: 1,
          finishedAt: null,
          execution: {
            unstarted: 1,
            started: 0,
            uncertain: 0,
            succeeded: 0,
            error: 0,
            cancelled: 0,
          },
        };
        experiments.set(id, experiment);
        results.set(evaluationId, []);
        runItems.set(evaluationId, []);
        return Response.json({ id, evaluationRunId: evaluationId });
      }
      const experimentMatch =
        /^\/experiments\/([^/]+)(?:\/items(?:\/([^/]+)(?:\/(start))?)?|\/(finish))?$/.exec(path);
      if (experimentMatch) {
        const experiment = experiments.get(experimentMatch[1]!);
        if (!experiment) return new Response(null, { status: 404 });
        if (experimentMatch[4]) {
          experiment.finishedAt = new Date().toISOString();
          return Response.json({ id: experiment.id, finishedAt: experiment.finishedAt });
        }
        if (experimentMatch[3]) {
          const execution = {
            id: randomUUID(),
            attempt: 1,
            state: "started",
            traceExternalId: String(body.traceExternalId),
            experimentId: experiment.id,
            caseId,
          };
          executions.set(execution.id, execution);
          return Response.json(execution);
        }
        if (experimentMatch[2]) return Response.json(frozenCase);
        if (path.endsWith("/items")) {
          const execution =
            [...executions.values()].find((item) => item.experimentId === experiment.id) ?? null;
          return Response.json({
            items: [{ id: caseId, externalKey: "refund", hasExpected: true, execution }],
            nextCursor: null,
          });
        }
        return Response.json(experiment);
      }
      if (path === "/environment-runs" && request.method === "POST") {
        const id = randomUUID();
        worlds.set(id, { id, status: "open" });
        return Response.json({
          ...legacyRun(id),
          environmentVersionId,
          executionId: body.executionId,
        });
      }
      const worldMatch = /^\/environment-runs\/([^/]+)(?:\/(finish))?$/.exec(path);
      if (worldMatch) {
        const world = worlds.get(worldMatch[1]!);
        if (!world) return new Response(null, { status: 404 });
        if (worldMatch[2] === "finish") {
          world.status = String(body.status);
          return Response.json({
            id: world.id,
            status: world.status,
            stepCount: 0,
            stateDigest: DIGEST,
            sealedAt: new Date().toISOString(),
          });
        }
        return Response.json({
          ...legacyRun(world.id),
          environmentVersionId,
          status: world.status,
          stepCount: 0,
        });
      }
      if (path === "/local-agent-worker/mcp-capability" && request.method === "POST")
        return Response.json(capability());
      if (path === "/local-agent-worker/register") {
        const { key: agentKey, ...registration } = body;
        return Response.json({
          id: randomUUID(),
          agentKey,
          ...registration,
          enabled: true,
          lastSeenAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        });
      }
      if (path === "/local-agent-worker/claim") {
        const queued = queue.find((item) => item.state === "queued");
        if (!queued) return Response.json(null);
        queued.state = "claimed";
        return Response.json({ runId: queued.runId, experimentId: queued.experimentId });
      }
      if (path === "/local-agent-worker/runs/heartbeat")
        return Response.json({ runId: body.runId, active: true });
      if (path === "/local-agent-worker/runs/complete")
        return Response.json({ runId: body.runId, state: body.state });
      const executionMatch = /^\/experiment-executions\/([^/]+)(\/complete)?$/.exec(path);
      if (executionMatch) {
        const execution = executions.get(executionMatch[1]!);
        if (!execution) return new Response(null, { status: 404 });
        if (!executionMatch[2]) return Response.json(execution);
        const experiment = experiments.get(String(execution.experimentId))!;
        const evaluationId = (experiment.evaluation as { id: string }).id;
        execution.state = body.state;
        const subjectId = randomUUID();
        const evaluationItemId = randomUUID();
        execution.subjectId = subjectId;
        subjects.set(subjectId, {
          id: subjectId,
          caseId,
          executionId: execution.id,
        });
        runItems.get(evaluationId)!.push({ id: evaluationItemId, subjectId });
        const failed = body.state !== "succeeded";
        const stored = {
          id: randomUUID(),
          runId: evaluationId,
          itemId: evaluationItemId,
          scorerVersionId,
          state: "scored",
          metrics: [{ name: "refund_recorded", value: !failed }],
          explanation: failed ? "The agent did not run." : "The refund was recorded.",
          evidence: null,
          error: null,
        };
        results.get(evaluationId)!.push(stored);
        return Response.json({
          executionId: execution.id,
          subjectId,
          evaluationItemId,
          traceSnapshotId: randomUUID(),
        });
      }
      const scoringMatch = /^\/evaluation-runs\/([^/]+)$/.exec(path);
      if (scoringMatch && request.method === "GET") {
        const experiment = [...experiments.values()].find(
          (item) => (item.evaluation as { id: string }).id === scoringMatch[1],
        )!;
        return Response.json({
          ...(experiment.evaluation as object),
          itemCount: runItems.get(scoringMatch[1]!)?.length ?? 0,
          scores: { scored: 1, error: 0, skipped: 0, pending: 0 },
        });
      }
      const runMatch = /^\/evaluation-runs\/([^/]+)\/(items|results)$/.exec(path);
      if (runMatch) {
        if (runMatch[2] === "items")
          return Response.json({ items: runItems.get(runMatch[1]!) ?? [], nextCursor: null });
        return Response.json({
          items: (results.get(runMatch[1]!) ?? []).map((item) => ({
            id: item.id,
            itemId: item.itemId,
            scorerVersionId: item.scorerVersionId,
            state: item.state,
          })),
          nextCursor: null,
        });
      }
      const resultMatch = /^\/evaluation-results\/([^/]+)$/.exec(path);
      if (resultMatch) {
        const stored = [...results.values()].flat().find((item) => item.id === resultMatch[1]);
        return stored ? Response.json(stored) : new Response(null, { status: 404 });
      }
      unexpected.push(`${request.method} ${path}`);
      return new Response(null, { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    scenarioId,
    unexpected,
    enqueue() {
      const id = randomUUID();
      const evaluationId = randomUUID();
      experiments.set(id, {
        id,
        name: "Launched from Hue",
        datasetVersionId: versionId,
        config: {},
        configDigest: DIGEST,
        evaluation: {
          id: evaluationId,
          name: "default",
          scorerVersions: [scorerVersion],
          itemCount: 1,
          scores: { scored: 0, error: 0, skipped: 0, pending: 1 },
        },
        caseCount: 1,
        finishedAt: null,
      });
      results.set(evaluationId, []);
      runItems.set(evaluationId, []);
      const runId = randomUUID();
      queue.push({ runId, experimentId: id, state: "queued" });
    },
    stop: () => server.stop(true),
  };
}

function runHue(args: string[], cwd: string): Promise<{ status: number | null; stderr: string }> {
  const { HUE_API_KEY: _key, HUE_BASE_URL: _origin, HUE_MCP_URL: _mcp, ...inherited } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "eval", ...args], {
      cwd,
      env: {
        ...inherited,
        GITHUB_ACTIONS: "false",
        NO_COLOR: "1",
        HUE_API_KEY: PROJECT_KEY,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on("data", () => undefined);
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stderr: stderr.replaceAll(ATTEMPT_BEARER, "[attempt bearer]") });
    });
  });
}

const agentSource = `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], "opened");
const url = process.env.HUE_MCP_URL;
if (url) {
  await fetch(url, {
    headers: { authorization: "Bearer " + (process.env.HUE_MCP_TOKEN ?? "") },
    redirect: "manual",
    signal: AbortSignal.timeout(500),
  }).catch(() => undefined);
}
process.stdout.write(JSON.stringify({ answer: "saved" }));
`;

async function assertCommandRefuses(
  mode: "scenario" | "worker",
  capabilityUrl: (hosts: { hue: string; evil: string }) => string,
) {
  const evil = peer();
  const swapped = peer();
  let calls = 0;
  const hue = evalHue(() => {
    calls += 1;
    return {
      url:
        calls === 1
          ? capabilityUrl({ hue: hue.origin, evil: evil.origin })
          : `${swapped.origin}/second`,
      token: ATTEMPT_BEARER,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  });
  const cwd = await mkdtemp(join(tmpdir(), "hue-mcp-cli-"));
  const marker = join(cwd, "agent-opened");
  const script = join(cwd, "agent.mjs");
  const staged: string[] = [];
  await writeFile(script, agentSource);
  if (mode === "worker") hue.enqueue();
  const checkpoints = join(cwd, "checkpoints");
  const watcher = watch(cwd, { recursive: true }, (_event, name) => {
    const text = String(name);
    if (text.endsWith("inputs.json") || text.endsWith("case.json")) staged.push(text);
  });
  try {
    const args =
      mode === "scenario"
        ? [
            "--scenario",
            hue.scenarioId,
            "--command",
            `${process.execPath} ${JSON.stringify(script)} ${JSON.stringify(marker)}`,
            "--origin",
            hue.origin,
            "--checkpoint-dir",
            checkpoints,
            "--wait",
            "0",
          ]
        : [
            "--worker",
            "--command",
            `${process.execPath} ${JSON.stringify(script)} ${JSON.stringify(marker)}`,
            "--origin",
            hue.origin,
            "--checkpoint-dir",
            checkpoints,
            "--max-runs",
            "1",
            "--wait",
            "0",
          ];
    const result = await runHue(args, cwd);
    expect({
      hits: evil.hits,
      swapped: swapped.hits,
      staged,
      opened: (await readdir(cwd)).includes("agent-opened"),
      status: result.status,
    }).toEqual({ hits: [], swapped: [], staged: [], opened: false, status: 1 });
    expect(hue.unexpected).toEqual([]);
  } finally {
    watcher.close();
    hue.stop();
    evil.stop();
    swapped.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("hue eval command export", () => {
  test("hue eval --command does not open a capability URL on another port", async () => {
    await assertCommandRefuses("scenario", ({ evil }) => `${evil}/mcp`);
  });

  test("hue eval --command does not follow a Hue-origin prefix to another host", async () => {
    await assertCommandRefuses(
      "scenario",
      ({ hue, evil }) =>
        `http://127.0.0.1:${new URL(hue).port}@127.0.0.1:${new URL(evil).port}/mcp`,
    );
  });

  test("hue eval --worker --command does not open a capability URL on another port", async () => {
    await assertCommandRefuses("worker", ({ evil }) => `${evil}/mcp`);
  });

  test("hue eval --worker --command does not follow a Hue-origin prefix to another host", async () => {
    await assertCommandRefuses(
      "worker",
      ({ hue, evil }) =>
        `http://127.0.0.1:${new URL(hue).port}@127.0.0.1:${new URL(evil).port}/mcp`,
    );
  });
});
