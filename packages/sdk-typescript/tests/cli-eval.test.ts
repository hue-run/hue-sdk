import { describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs/light.js";
import schema from "./fixtures/otlp-schema.json" with { type: "json" };
import { explain, renderTable, spawnAgentCommand } from "../src/cli/eval.js";
import { CheckpointIdentityError } from "../src/evals/checkpoint.js";
import { TargetCancelledError } from "../src/evals.js";
import type { Completion, Execution, Experiment, StoredResult, Subject } from "../src/evals.js";

const cli = join(import.meta.dir, "../src/setup/cli.ts");
const key = "synthetic-eval-key-canary";
const mcpToken = "hue_sim_synthetic_token_canary";
const worldToken = `hue_world_${"c".repeat(64)}.${"s".repeat(43)}`;
const digest = "d".repeat(64);
const SPAWN_TIMEOUT = 90_000;

type Verdict = "pass" | "fail" | "error" | "none";

const traceRequest = protobuf.Root.fromJSON(schema).lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);

/** Loopback Hue stand-in: one published Scenario, worlds, executions and deferred verdicts. */
function hueStandIn(
  options: {
    verdict?: Verdict;
    deferredPolls?: number;
    frozen?: boolean;
    /** Answer creates as a deployment whose simulation gateway serves the world. */
    gateway?: boolean;
    /** Refuse trace exports with 400, or drop their connection without an answer. */
    traces?: "refuse" | "drop";
    /** Grade as a scorer that never reads the execution state. */
    ignoreExecutionState?: boolean;
  } = {},
) {
  const state = { verdict: options.verdict ?? "pass", deferredPolls: options.deferredPolls ?? 0 };
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const environmentVersionId = randomUUID();
  const dataset = {
    id: randomUUID(),
    name: "Refund flow",
    slug: "refund-flow",
    archivedAt: null,
    versions: [
      {
        id: randomUUID(),
        datasetId: "",
        version: 1,
        revision: 2,
        frozenAt: options.frozen === false ? null : "2026-09-18T00:00:00.000Z",
        contentDigest: options.frozen === false ? null : digest,
      },
    ],
  };
  dataset.versions[0]!.datasetId = dataset.id;
  const version = dataset.versions[0]!;
  const frozenCase = {
    id: randomUUID(),
    externalKey: "refund",
    inputs: { task: "refund charge ch_2" },
    expected: "saved",
    metadata: { suite: "billing" },
    datasetVersionId: version.id,
    environmentVersionId,
    hasExpected: true,
  };
  const scorerId = randomUUID();
  const scorerVersion = {
    id: randomUUID(),
    contentDigest: digest,
    definition: {
      kind: "world_outcome",
      entry: "hue.conversion_outcome.v1",
      metrics: [
        { name: "refund_recorded", type: "boolean" },
        { name: "tone", type: "text" },
      ],
    },
  };
  const scenario = {
    id: randomUUID(),
    domain: "billing",
    status: "published",
    revision: 1,
    createdAt: "2026-09-18T00:00:00.000Z",
    traceId: randomUUID(),
    publication: {
      caseId: frozenCase.id,
      datasetId: dataset.id,
      datasetVersionId: version.id,
      environmentId,
      environmentVersionId,
      scorerId,
      scorerVersionId: scorerVersion.id,
    },
  };
  const draftScenario = { ...scenario, id: randomUUID(), status: "draft", publication: null };
  const experiments = new Map<string, Experiment>();
  const executions = new Map<string, Execution & { experimentId: string; caseId: string }>();
  const worlds = new Map<
    string,
    { id: string; executionId: string; status: string; steps: Record<string, unknown>[] }
  >();
  const subjects = new Map<string, Subject>();
  const runItems = new Map<
    string,
    { id: string; subjectId: string; hasOutput: boolean; traceSnapshotId: string | null }[]
  >();
  const results = new Map<string, StoredResult[]>();
  const resultPolls = new Map<string, number>();
  const calls = {
    requests: [] as string[],
    otlp: 0,
    frozen: [] as number[],
    completions: [] as Record<string, unknown>[],
    /** Trace evidence each completion declared, in completion order. */
    evidence: [] as Record<string, unknown>[],
    /** Exported spans, decoded: name and attribute keys. */
    spans: [] as { name: string; attributes: string[] }[],
    worldCreates: [] as Record<string, unknown>[],
    experiments: [] as Record<string, unknown>[],
    register: [] as Record<string, unknown>[],
    claims: 0,
    localRuns: [] as Record<string, unknown>[],
  };
  const queue: { runId: string; experimentId: string; state: string; workerId?: string }[] = [];
  const agentId = randomUUID();
  function createExperiment(body: Record<string, unknown>) {
    const experiment = {
      id: randomUUID(),
      name: String(body.name),
      datasetVersionId: String(body.datasetVersionId),
      config: (body.config ?? {}) as Experiment["config"],
      configDigest: digest,
      evaluation: {
        id: randomUUID(),
        name: "default",
        scorerVersions: (body.scorerVersionIds as string[]).map((id) => ({
          ...scorerVersion,
          id,
        })) as Experiment["evaluation"]["scorerVersions"],
        itemCount: 1,
        scores: { scored: 0, error: 0, skipped: 0, pending: 1 },
      },
      caseCount: 1,
      finishedAt: null,
      execution: { unstarted: 1, started: 0, uncertain: 0, succeeded: 0, error: 0, cancelled: 0 },
    } satisfies Experiment;
    experiments.set(experiment.id, experiment);
    runItems.set(experiment.evaluation.id, []);
    results.set(experiment.evaluation.id, []);
    return experiment;
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace("/api/v1", "");
      calls.requests.push(`${request.method} ${path}`);
      if (request.headers.get("authorization") !== `Bearer ${key}`)
        return new Response(null, { status: 401 });
      if (path === "/projects/current")
        return Response.json({
          id: projectId,
          name: "Synthetic",
          slug: "synthetic",
          organizationId: randomUUID(),
        });
      if (path.startsWith("/otlp/")) {
        calls.otlp++;
        let bytes = Buffer.from(await request.arrayBuffer());
        if (path.endsWith("/traces")) {
          if (request.headers.get("content-encoding") === "gzip") bytes = gunzipSync(bytes);
          const decoded = traceRequest.toObject(traceRequest.decode(bytes)) as {
            resourceSpans?: {
              scopeSpans?: { spans?: { name: string; attributes?: { key: string }[] }[] }[];
            }[];
          };
          for (const resource of decoded.resourceSpans ?? [])
            for (const scope of resource.scopeSpans ?? [])
              for (const span of scope.spans ?? [])
                calls.spans.push({
                  name: span.name,
                  attributes: (span.attributes ?? []).map((attribute) => attribute.key),
                });
        }
        if (path.endsWith("/traces") && options.traces === "refuse")
          return new Response(null, { status: 400 });
        if (path.endsWith("/traces") && options.traces === "drop")
          // A body that fails after the headers: the server ends the connection mid-answer.
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("Dropped"));
              },
            }),
            { headers: { "Content-Type": "application/x-protobuf" } },
          );
        return new Response(new Uint8Array(), {
          headers: { "Content-Type": "application/x-protobuf" },
        });
      }
      const body =
        request.method === "GET" ? {} : ((await request.json()) as Record<string, unknown>);
      if (path === "/case-conversions") {
        const summaries = [scenario, draftScenario].map(({ publication: _pins, ...item }) => item);
        return Response.json({ items: summaries, nextCursor: null });
      }
      if (path === `/case-conversions/${scenario.id}`) return Response.json(scenario);
      if (path === `/case-conversions/${draftScenario.id}`) return Response.json(draftScenario);
      if (path === "/datasets") {
        const { versions: _versions, ...summary } = dataset;
        return Response.json({ items: [summary], nextCursor: null });
      }
      if (path === `/datasets/${dataset.id}`) return Response.json(dataset);
      if (path === `/dataset-versions/${version.id}`) return Response.json(version);
      // The case pins a world, so `hue eval --set` on this stand-in stays a simulation run.
      if (path === `/dataset-versions/${version.id}/cases`)
        return Response.json({ items: [frozenCase], nextCursor: null });
      if (path === `/dataset-versions/${version.id}/freeze`) {
        calls.frozen.push(Number(body.expectedRevision));
        if (body.expectedRevision !== version.revision) return new Response(null, { status: 409 });
        version.frozenAt = new Date().toISOString();
        version.contentDigest = digest;
        version.revision++;
        return Response.json(version);
      }
      if (path === "/experiments") {
        calls.experiments.push(body);
        if (body.datasetVersionId !== version.id) return new Response(null, { status: 404 });
        if (!version.frozenAt) return new Response(null, { status: 409 });
        const experiment = createExperiment(body);
        return Response.json({ id: experiment.id, evaluationRunId: experiment.evaluation.id });
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
          const existing = [...executions.values()].find(
            (execution) =>
              execution.experimentId === experiment.id && execution.caseId === frozenCase.id,
          );
          if (existing) return Response.json(existing);
          const execution = {
            id: randomUUID(),
            attempt: 1,
            state: "started" as const,
            traceExternalId: String(body.traceExternalId),
            experimentId: experiment.id,
            caseId: frozenCase.id,
          };
          executions.set(execution.id, execution);
          return Response.json(execution);
        }
        if (experimentMatch[2]) {
          if (experimentMatch[2] !== frozenCase.id) return new Response(null, { status: 404 });
          return Response.json(frozenCase);
        }
        if (path.endsWith("/items"))
          return Response.json({
            items: [
              {
                id: frozenCase.id,
                externalKey: frozenCase.externalKey,
                hasExpected: true,
                execution:
                  [...executions.values()].find(
                    (execution) => execution.experimentId === experiment.id,
                  ) ?? null,
              },
            ],
            nextCursor: null,
          });
        return Response.json(experiment);
      }
      if (path === "/environment-runs") {
        calls.worldCreates.push(body);
        const world = {
          id: randomUUID(),
          executionId: String(body.executionId),
          status: "open",
          steps: [] as Record<string, unknown>[],
        };
        worlds.set(world.id, world);
        const mirror = `${url.origin}/api/sim/gmailmcp.googleapis.com/mcp/v1`;
        const expiresAt = new Date(Date.now() + 600_000).toISOString();
        const gateway = options.gateway
          ? {
              worldId: world.id,
              token: worldToken,
              lifecycle: "live",
              completingUntil: null,
              baggage: `hue-world=${world.id}`,
              traceparent: body.traceparent ?? null,
              surfaces: [
                {
                  provider: "google.gmail",
                  surface: "google.gmail/mcp",
                  providerInstanceKey: "gmail-primary",
                  url: mirror,
                  alias: null,
                },
              ],
              env: {
                HUE_WORLD_ID: world.id,
                HUE_WORLD_TOKEN: worldToken,
                BAGGAGE: `hue-world=${world.id}`,
                HUE_SIM_GOOGLE_GMAIL_MCP_URL: mirror,
              },
              mcpConfig: {
                mcpServers: {
                  "gmail-primary": {
                    type: "http",
                    url: mirror,
                    headers: { Authorization: `Bearer ${worldToken}` },
                  },
                },
              },
              connection: null,
            }
          : {};
        return Response.json({
          ...gateway,
          id: world.id,
          environmentVersionId,
          clockNs: "0",
          stateDigest: digest,
          maxSteps: 50,
          expiresAt,
          actions: [
            {
              name: "save",
              description: "Record the refund",
              inputSchema: {
                type: "object",
                properties: { note: { type: "string" } },
                required: [],
                additionalProperties: false,
              },
            },
          ],
        });
      }
      const worldMatch = /^\/environment-runs\/([^/]+)(?:\/(actions|finish))?$/.exec(path);
      if (worldMatch) {
        const world = worlds.get(worldMatch[1]!);
        if (!world) return new Response(null, { status: 404 });
        if (worldMatch[2] === "actions") {
          if (world.status !== "open") return new Response(null, { status: 409 });
          world.steps.push({ action: body.action, args: body.args });
          return Response.json({
            runId: world.id,
            stepOrdinal: world.steps.length - 1,
            observation: { status: "ok", data: { recorded: true } },
            effects: [],
            stateDigest: digest,
            clockNs: String(world.steps.length),
            replayed: false,
            stepsRemaining: 50 - world.steps.length,
          });
        }
        if (worldMatch[2] === "finish") {
          if (world.status !== "open") return new Response(null, { status: 409 });
          world.status = String(body.status);
          return Response.json({
            id: world.id,
            status: world.status,
            stepCount: world.steps.length,
            stateDigest: digest,
            sealedAt: new Date().toISOString(),
          });
        }
        return Response.json({
          id: world.id,
          environmentVersionId,
          executionId: world.executionId,
          seed: "e".repeat(32),
          status: world.status,
          stepCount: world.steps.length,
          maxSteps: 50,
          clockNs: "0",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          createdAt: new Date().toISOString(),
          sealedAt: world.status === "open" ? null : new Date().toISOString(),
          stateDigest: digest,
          finalState: { collections: {} },
          validity: "not_assessed",
          coverageGap: null,
        });
      }
      if (path === "/local-agent-worker/mcp-capability")
        return Response.json({
          url: `${url.origin}/api/v1/simulation-mcp/${String(body.runId)}`,
          token: mcpToken,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      if (path === "/local-agent-worker/register") {
        calls.register.push(body);
        // Hue answers with the key as `agentKey`, not the registration's `key`.
        const { key: agentKey, ...registration } = body;
        return Response.json({
          id: agentId,
          agentKey,
          ...registration,
          enabled: true,
          lastSeenAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        });
      }
      if (path === "/local-agent-worker/claim") {
        calls.claims++;
        const queued = queue.find((item) => item.state === "queued");
        if (!queued) return Response.json(null);
        queued.state = "claimed";
        queued.workerId = String(body.workerId);
        return Response.json({ runId: queued.runId, experimentId: queued.experimentId });
      }
      if (path === "/local-agent-worker/runs/heartbeat")
        return Response.json({ runId: body.runId, active: true });
      if (path === "/local-agent-worker/runs/complete") {
        calls.localRuns.push(body);
        const claimed = queue.find((item) => item.runId === body.runId);
        if (claimed) claimed.state = String(body.state);
        return Response.json({ runId: body.runId, state: body.state });
      }
      const executionMatch = /^\/experiment-executions\/([^/]+)(\/complete)?$/.exec(path);
      if (executionMatch) {
        const execution = executions.get(executionMatch[1]!);
        if (!execution) return new Response(null, { status: 404 });
        if (!executionMatch[2]) return Response.json(execution);
        const world = [...worlds.values()].find((item) => item.executionId === execution.id);
        if (world?.status === "open") return new Response(null, { status: 409 });
        const experiment = experiments.get(execution.experimentId)!;
        execution.state = body.state as Execution["state"];
        const subjectId = randomUUID();
        const evaluationItemId = randomUUID();
        const hasOutput = Object.hasOwn(body, "output");
        calls.completions.push({
          executionId: execution.id,
          state: body.state,
          ...(hasOutput ? { output: body.output } : {}),
          ...(body.error ? { error: body.error } : {}),
        });
        calls.evidence.push({
          traceEvidence: body.traceEvidence,
          ...(body.omissionReason === undefined ? {} : { omissionReason: body.omissionReason }),
        });
        execution.subjectId = subjectId;
        subjects.set(subjectId, {
          id: subjectId,
          executionId: execution.id,
          inputs: frozenCase.inputs,
          hasOutput,
          ...(hasOutput ? { output: body.output as Subject["output"] } : {}),
          hasExpected: true,
          expected: frozenCase.expected,
          metadata: frozenCase.metadata,
          contentDigest: digest,
          outputEvidence: hasOutput ? "available" : "unavailable",
          executionState: body.state as Subject["executionState"],
          traceSnapshotId: randomUUID(),
          caseId: frozenCase.id,
          datasetVersionId: version.id,
          caseExternalKey: frozenCase.externalKey,
          experimentId: experiment.id,
          attempt: 1,
          traceEvidence: "captured",
          traceExternalId: execution.traceExternalId,
          omissionReason: null,
        });
        runItems
          .get(experiment.evaluation.id)!
          .push({ id: evaluationItemId, subjectId, hasOutput, traceSnapshotId: randomUUID() });
        // Hue grades world_outcome pins after the seal; the CLI must wait for them.
        const verdict = state.verdict;
        const failed =
          verdict === "fail" || (!options.ignoreExecutionState && body.state !== "succeeded");
        if (verdict !== "none")
          results.get(experiment.evaluation.id)!.push({
            id: randomUUID(),
            runId: experiment.evaluation.id,
            itemId: evaluationItemId,
            scorerVersionId: scorerVersion.id,
            state: verdict === "error" ? "error" : "scored",
            metrics:
              verdict === "error"
                ? []
                : [
                    { name: "refund_recorded", value: !failed },
                    { name: "tone", value: "polite" },
                  ],
            explanation:
              verdict === "error"
                ? null
                : failed
                  ? "No refund was recorded in the world journal."
                  : "The refund was recorded in the world journal.",
            evidence: null,
            error: verdict === "error" ? { type: "OutcomeEvaluatorUnavailable" } : null,
            sourceDigest: null,
          });
        return Response.json({
          executionId: execution.id,
          subjectId,
          evaluationItemId,
          traceSnapshotId: randomUUID(),
        } satisfies Completion);
      }
      const runMatch = /^\/evaluation-runs\/([^/]+)\/(items|results)$/.exec(path);
      if (runMatch) {
        if (runMatch[2] === "items")
          return Response.json({ items: runItems.get(runMatch[1]!) ?? [], nextCursor: null });
        if (request.method === "POST") return Response.json({ ids: [randomUUID()] });
        const polls = (resultPolls.get(runMatch[1]!) ?? 0) + 1;
        resultPolls.set(runMatch[1]!, polls);
        if (polls <= state.deferredPolls) return Response.json({ items: [], nextCursor: null });
        return Response.json({
          items: (results.get(runMatch[1]!) ?? []).map(
            ({ id, itemId, scorerVersionId, state }) => ({
              id,
              itemId,
              scorerVersionId,
              state,
            }),
          ),
          nextCursor: null,
        });
      }
      const resultMatch = /^\/evaluation-results\/([^/]+)$/.exec(path);
      if (resultMatch) {
        const stored = [...results.values()].flat().find((item) => item.id === resultMatch[1]);
        return stored ? Response.json(stored) : new Response(null, { status: 404 });
      }
      const subjectMatch = /^\/evaluation-subjects\/([^/]+)$/.exec(path);
      if (subjectMatch) {
        const subject = subjects.get(subjectMatch[1]!);
        return subject ? Response.json(subject) : new Response(null, { status: 404 });
      }
      throw new Error(`Unexpected request ${request.method} ${path}`);
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return {
    server,
    baseUrl,
    state,
    calls,
    scenario,
    version,
    scorerVersion,
    experiments,
    worlds,
    enqueueRun() {
      const experiment = createExperiment({
        name: "Launched from Hue",
        datasetVersionId: version.id,
        scorerVersionIds: [scorerVersion.id],
        config: { launched: true },
      });
      const runId = randomUUID();
      queue.push({ runId, experimentId: experiment.id, state: "queued" });
      return { runId, experimentId: experiment.id };
    },
    stop: () => server.stop(true),
  };
}

/** Spawns the CLI asynchronously so the in-process stand-in keeps serving while it runs. */
function hue(
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string>;
    dropKey?: boolean;
    /** Sends SIGINT once the CLI prints a line matching this, standing in for Ctrl+C. */
    interruptOn?: RegExp;
    /** Sends SIGINT this many times, 100 ms apart, once this file exists. */
    interruptAfter?: { file: string; times: number; gapMillis?: number };
  },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const { HUE_API_KEY: _key, HUE_BASE_URL: _origin, ...inherited } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "eval", ...args], {
      cwd: options.cwd,
      env: {
        ...inherited,
        NO_COLOR: "1",
        ...(options.dropKey ? {} : { HUE_API_KEY: key }),
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let interrupted = false;
    const maybeInterrupt = (text: string) => {
      if (!interrupted && options.interruptOn?.test(text)) {
        interrupted = true;
        child.kill("SIGINT");
      }
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      maybeInterrupt(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      maybeInterrupt(chunk);
    });
    if (options.interruptAfter) {
      const { file, times, gapMillis = 100 } = options.interruptAfter;
      const waiting = setInterval(() => {
        if (!existsSync(file)) return;
        clearInterval(waiting);
        for (let index = 0; index < times; index++)
          setTimeout(() => child.kill("SIGINT"), index * gapMillis);
      }, 50);
      child.on("close", () => clearInterval(waiting));
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), SPAWN_TIMEOUT);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

const adapterSource = `type Tool = { execute(args?: Record<string, unknown>): Promise<unknown> };
type Context = {
  tools: Record<string, Tool>;
  mcp: { url: string; token: string; expiresAt: string };
  item: { id: string; externalKey: string };
  config: unknown;
};
export default async function runMyAgent(inputs: { task: string }, context: Context) {
  const observation = await context.tools.save!.execute({ note: inputs.task });
  return {
    answer: "saved",
    caseKey: context.item.externalKey,
    observation,
    hasMcp: typeof context.mcp.token === "string" && context.mcp.url.includes("/simulation-mcp/"),
  };
}
`;

const commandSource = `import { readFileSync } from "node:fs";
let data = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) data += chunk;
const { inputs, config } = JSON.parse(data);
if (process.env.FAIL_AGENT) process.exit(3);
process.stdout.write(JSON.stringify({
  answer: "saved",
  task: inputs.task,
  config,
  env: {
    hasToken: process.env.HUE_MCP_TOKEN === ${JSON.stringify(mcpToken)},
    url: process.env.HUE_MCP_URL,
    expiresAt: typeof process.env.HUE_MCP_EXPIRES_AT,
    caseKey: process.env.HUE_CASE_KEY,
    caseId: process.env.HUE_CASE_ID,
    executionId: process.env.HUE_EXECUTION_ID,
    worldId: process.env.HUE_ENVIRONMENT_RUN_ID,
    hasApiKey: "HUE_API_KEY" in process.env,
    worldToken: process.env.HUE_WORLD_TOKEN,
    gmailMirror: process.env.HUE_SIM_GOOGLE_GMAIL_MCP_URL,
    mcpConfig: process.env.HUE_MCP_CONFIG
      ? JSON.parse(readFileSync(process.env.HUE_MCP_CONFIG, "utf8"))
      : null,
    mcpConfigPath: process.env.HUE_MCP_CONFIG,
  },
}));
`;

/** Never answers: leaves a grandchild that writes a marker unless the whole group is stopped. */
const spawnerSource = `import { spawn } from "node:child_process";
spawn(
  process.execPath,
  ["-e", 'setTimeout(() => require("fs").writeFileSync(process.env.HUE_TEST_SURVIVOR, "alive"), 2500)'],
  { stdio: "ignore" },
);
setTimeout(() => {}, 60_000);
`;

/** Never answers and ignores SIGTERM; records its pid so a test can see whether it survived. */
const stubbornSource = `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(process.env.HUE_TEST_SURVIVOR, String(process.pid));
if (process.env.HUE_TEST_CONFIG_RECORD)
  writeFileSync(process.env.HUE_TEST_CONFIG_RECORD, process.env.HUE_MCP_CONFIG ?? "");
setInterval(() => {}, 1_000);
`;

/** Prints its credentials, as a careless agent or a debug log would. */
const leakySource = `import { readFileSync } from "node:fs";
process.stdout.write(JSON.stringify({
  worldToken: process.env.HUE_WORLD_TOKEN ?? null,
  mcpToken: process.env.HUE_MCP_TOKEN ?? null,
  apiKey: process.env.HUE_API_KEY ?? null,
  config: process.env.HUE_MCP_CONFIG ? readFileSync(process.env.HUE_MCP_CONFIG, "utf8") : null,
}));
`;

/** Answers through a result file that carries the world token. */
const resultFileSource = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(
  join(process.env.HUE_CASE_OUTPUT_DIR, "result.json"),
  JSON.stringify({ token: process.env.HUE_WORLD_TOKEN }),
);
`;

/** Throws with the world token in its message. */
const throwingAdapterSource = `export default async function runMyAgent(_inputs, context) {
  throw new Error("could not reach the mirror with " + context.world.token + " and " + process.env.HUE_API_KEY);
}
`;

/** Throws errors whose message cannot be reassigned, with the world token and the key. */
const frozenAdapterSource = `export default async function runMyAgent(_inputs, context) {
  const text = "mirror refused " + context.world.token + " for " + process.env.HUE_API_KEY;
  if (process.env.HUE_TEST_DOM_EXCEPTION) throw new DOMException(text, "DataCloneError");
  throw Object.freeze(new Error(text));
}
`;

/** Answers a word that contains a too-short credential value many times. */
const bananaSource = `process.stdout.write(JSON.stringify({ fruit: "banana" }));
`;

/** Every file under a directory whose text contains one of the values. */
async function filesContaining(directory: string, values: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true }))
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      const text = await readFile(path, "utf8");
      if (values.some((value) => text.includes(value))) found.push(path);
    }
  return found;
}

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "hue-cli-eval-"));
  await writeFile(join(directory, "hue-agent.ts"), adapterSource);
  await writeFile(join(directory, "agent-command.mjs"), commandSource);
  await writeFile(join(directory, "agent-spawner.mjs"), spawnerSource);
  await writeFile(join(directory, "agent-stubborn.mjs"), stubbornSource);
  await writeFile(join(directory, "agent-leaky.mjs"), leakySource);
  await writeFile(join(directory, "hue-frozen.mjs"), frozenAdapterSource);
  await writeFile(join(directory, "agent-banana.mjs"), bananaSource);
  await writeFile(join(directory, "agent-result-file.mjs"), resultFileSource);
  await writeFile(join(directory, "hue-throwing.mjs"), throwingAdapterSource);
  return directory;
}

/** Whether the process can still run. A killed process nobody has reaped yet is a zombie that
 * `kill(pid, 0)` still finds; on Linux its state says so. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (!existsSync("/proc/self/stat")) return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).charAt(0);
    return state !== "Z" && state !== "X";
  } catch {
    return false; // Gone between the two checks.
  }
}

function expectNoSecrets(result: { stdout: string; stderr: string }) {
  expect(result.stdout).not.toContain(key);
  expect(result.stderr).not.toContain(key);
  expect(result.stdout).not.toContain(mcpToken);
  expect(result.stderr).not.toContain(mcpToken);
}

describe("hue eval", () => {
  test(
    "runs a published case by name with an adapter file and prints Hue's verdicts",
    async () => {
      const f = hueStandIn({ deferredPolls: 1 });
      const cwd = await workspace();
      try {
        await writeFile(join(cwd, ".env.hue"), `HUE_API_KEY=${key}\nHUE_BASE_URL=${f.baseUrl}\n`);
        const result = await hue(
          ["--case", "refund FLOW", "./hue-agent.ts", "--env-file", ".env.hue", "--revision", "v1"],
          { cwd, dropKey: true },
        );
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expectNoSecrets(result);
        const [experiment] = [...f.experiments.values()];
        expect(experiment).toMatchObject({
          name: "hue-agent @ v1",
          datasetVersionId: f.version.id,
          config: {},
        });
        expect(f.calls.experiments[0]).toMatchObject({ scorerVersionIds: [f.scorerVersion.id] });
        expect(experiment!.finishedAt).toBeTruthy();
        const lines = result.stdout.split("\n");
        expect(lines[0]).toBe(`Run: ${f.baseUrl}/experiments/${experiment!.id}`);
        expect(lines[1]).toBe(`Experiment: ${experiment!.id}`);
        expect(lines.slice(2, 6)).toEqual([
          "[refund] world created",
          "[refund] agent started",
          "[refund] world sealed",
          "Waiting for Hue checks...",
        ]);
        expect(result.stdout).toContain("Case    refund_recorded  tone    Result");
        expect(result.stdout).toContain("refund  PASS             polite  PASSED");
        expect(result.stdout).toContain("1 of 1 case passed");
        expect(result.stdout.trim().split("\n").at(-1)).toBe(
          `Run: ${f.baseUrl}/experiments/${experiment!.id}`,
        );
        expect([...f.worlds.values()].map((world) => [world.status, world.steps])).toEqual([
          ["completed", [{ action: "save", args: { note: "refund charge ch_2" } }]],
        ]);
        // The output is stored by default, while span content stays off without --content.
        expect(f.calls.completions).toEqual([expect.objectContaining({ state: "succeeded" })]);
        expect(f.calls.evidence).toEqual([{ traceEvidence: "required" }]);
        expect(f.calls.completions[0]).toMatchObject({
          output: { answer: "saved", caseKey: "refund", hasMcp: true },
        });
        expect(f.calls.otlp).toBeGreaterThan(0);
        const caseSpan = f.calls.spans.find((span) => span.name === "hue.experiment.case")!;
        expect(caseSpan).toBeDefined();
        expect(caseSpan.attributes).not.toContain("input.value");
        expect(caseSpan.attributes).not.toContain("output.value");
        expect(await readFile(join(cwd, ".hue", "eval", ".gitignore"), "utf8")).toBe("*\n");
        expect(f.calls.requests.filter((line) => line === "GET /case-conversions")).toHaveLength(1);
      } finally {
        f.stop();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT,
  );

  test(
    "spawns --command per case with the scoped environment and emits JSON",
    async () => {
      const f = hueStandIn();
      const cwd = await workspace();
      const checkpoints = join(cwd, "checkpoints");
      try {
        const result = await hue(
          [
            "--scenario",
            f.scenario.id,
            "--command",
            `${process.execPath} agent-command.mjs`,
            "--origin",
            f.baseUrl,
            "--content",
            "--json",
            "--checkpoint-dir",
            checkpoints,
            "--revision",
            "cmd",
          ],
          { cwd },
        );
        expect(result.status).toBe(0);
        expectNoSecrets(result);
        expect(result.stderr).toContain("[refund] agent started");
        const document = JSON.parse(result.stdout) as Record<string, any>;
        const [experiment] = [...f.experiments.values()];
        expect(experiment?.name).toBe("agent-command @ cmd");
        expect(document).toMatchObject({
          experimentId: experiment!.id,
          runId: experiment!.evaluation.id,
          runUrl: `${f.baseUrl}/experiments/${experiment!.id}`,
          complete: true,
          totals: { cases: 1, passed: 1, failed: 0, error: 0, skipped: 0, pending: 1 - 1 },
        });
        expect(document.cases).toEqual([
          expect.objectContaining({
            externalKey: "refund",
            state: "passed",
            passed: true,
            metrics: [
              { name: "refund_recorded", value: true, scorerVersionId: f.scorerVersion.id },
              { name: "tone", value: "polite", scorerVersionId: f.scorerVersion.id },
            ],
          }),
        ]);
        const [world] = [...f.worlds.values()];
        const [completion] = f.calls.completions;
        expect(completion).toMatchObject({ state: "succeeded" });
        expect(completion!.output).toEqual({
          answer: "saved",
          task: "refund charge ch_2",
          config: {},
          env: {
            hasToken: true,
            url: `${f.baseUrl}/api/v1/simulation-mcp/${world!.id}`,
            expiresAt: "string",
            caseKey: "refund",
            caseId: f.scenario.publication.caseId,
            executionId: world!.executionId,
            worldId: world!.id,
            // The project key never reaches the agent unless the caller opts in.
            hasApiKey: false,
            mcpConfig: null,
          },
        });
        expect(result.stdout.trim().split("\n")).toHaveLength(1);
      } finally {
        f.stop();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT,
  );

  test(
    "--allow-hue-credentials keeps the project key in the --command child",
    async () => {
      const cwd = await workspace();
      const f = hueStandIn();
      try {
        const result = await hue(
          [
            "--scenario",
            "Refund flow",
            "--command",
            `${process.execPath} agent-command.mjs`,
            "--allow-hue-credentials",
            "--origin",
            f.baseUrl,
            "--json",
            "--content",
          ],
          { cwd },
        );
        expect(result.status).toBe(0);
        expectNoSecrets(result);
        const [completion] = f.calls.completions;
        expect((completion!.output as { env: { hasApiKey: boolean } }).env.hasApiKey).toBe(true);
      } finally {
        f.stop();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT,
  );

  test(
    "a gateway world hands the --command child its mirrors, token and MCP configuration file",
    async () => {
      const cwd = await workspace();
      const f = hueStandIn({ gateway: true });
      try {
        const result = await hue(
          [
            "--scenario",
            "Refund flow",
            "--command",
            `${process.execPath} agent-command.mjs`,
            "--revision",
            "tester@abc123",
            "--origin",
            f.baseUrl,
            "--json",
            "--content",
          ],
          { cwd },
        );
        expect(result.status).toBe(0);
        expectNoSecrets(result);
        expect(result.stdout).not.toContain(worldToken);
        expect(result.stderr).not.toContain(worldToken);
        const [world] = [...f.worlds.values()];
        const mirror = `${f.baseUrl}/api/sim/gmailmcp.googleapis.com/mcp/v1`;
        const [completion] = f.calls.completions;
        const env = (completion!.output as { env: Record<string, unknown> }).env;
        // The agent saw the token; the stored output does not keep it, nor its MCP header.
        expect(env).toMatchObject({
          hasToken: false,
          url: mirror,
          worldToken: "[redacted]",
          gmailMirror: mirror,
          hasApiKey: false,
          executionId: world!.executionId,
          worldId: world!.id,
          mcpConfig: {
            mcpServers: {
              "gmail-primary": {
                type: "http",
                url: mirror,
                headers: { Authorization: "[redacted]" },
              },
            },
          },
        });
        expect(JSON.stringify(f.calls.completions)).not.toContain(worldToken);
        expect(await filesContaining(join(cwd, ".hue"), [worldToken])).toEqual([]);
        // The owner-only file is gone after the case; no legacy capability was minted; the
        // world was created with the agent revision and the case span's context.
        expect(existsSync(String(env.mcpConfigPath))).toBe(false);
        expect(f.calls.requests).not.toContain("POST /local-agent-worker/mcp-capability");
        expect(f.calls.worldCreates[0]).toMatchObject({ agentRevision: "tester@abc123" });
        expect(String(f.calls.worldCreates[0]!.traceparent)).toMatch(
          /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
        );
      } finally {
        f.stop();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT,
  );

  test(
    "exits 1 for failing verdicts, failing commands and incomplete checks",
    async () => {
      const cwd = await workspace();
      const failing = hueStandIn({ verdict: "fail" });
      try {
        const result = await hue(
          ["--scenario", "Refund flow", "./hue-agent.ts", "--origin", failing.baseUrl],
          { cwd, env: { AGENT_REVISION: "env-rev" } },
        );
        expect(result.status).toBe(1);
        expectNoSecrets(result);
        expect(result.stdout).toContain("refund  FAIL             polite  FAILED");
        expect(result.stdout).toContain("  refund: No refund was recorded in the world journal.");
        expect(result.stdout).toContain("0 of 1 case passed");
        expect([...failing.experiments.values()][0]?.name).toBe("hue-agent @ env-rev");
      } finally {
        failing.stop();
      }
      const crashing = hueStandIn();
      try {
        const result = await hue(
          [
            "--scenario",
            "Refund flow",
            "--command",
            `${process.execPath} agent-command.mjs`,
            "--origin",
            crashing.baseUrl,
            "--json",
          ],
          { cwd, env: { FAIL_AGENT: "1" } },
        );
        expect(result.status).toBe(1);
        expectNoSecrets(result);
        // Error messages are stored by default too.
        expect(crashing.calls.completions).toEqual([
          expect.objectContaining({
            state: "error",
            error: { type: "TargetError", message: "The agent command exited with code 3" },
          }),
        ]);
        expect([...crashing.worlds.values()][0]?.status).toBe("abandoned");
        const document = JSON.parse(result.stdout) as Record<string, any>;
        expect(document.cases[0]).toMatchObject({ state: "failed", passed: false });
      } finally {
        crashing.stop();
      }
      const silent = hueStandIn({ verdict: "none" });
      try {
        const result = await hue(
          [
            "--scenario",
            "Refund flow",
            "./hue-agent.ts",
            "--origin",
            silent.baseUrl,
            "--wait",
            "0",
            "--json",
          ],
          { cwd },
        );
        expect(result.status).toBe(1);
        const document = JSON.parse(result.stdout) as Record<string, any>;
        expect(document).toMatchObject({ complete: false, totals: { pending: 1, passed: 0 } });
        expect(document.cases[0]).toMatchObject({ state: "pending" });
      } finally {
        silent.stop();
      }
      const errored = hueStandIn({ verdict: "error" });
      try {
        const result = await hue(
          ["--scenario", "Refund flow", "./hue-agent.ts", "--origin", errored.baseUrl],
          { cwd },
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toContain("refund  ERROR");
        expect(result.stdout).toContain("  refund: scorer error OutcomeEvaluatorUnavailable");
        expect(result.stdout).toContain("0 of 1 case passed (1 error)");
      } finally {
        errored.stop();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT * 4,
  );

  test(
    "a timed-out --command stops the agent's whole process group",
    async () => {
      const f = hueStandIn();
      const cwd = await workspace();
      const survivor = join(cwd, "survivor.txt");
      try {
        const result = await hue(
          [
            "--scenario",
            "Refund flow",
            "--command",
            `${process.execPath} agent-spawner.mjs`,
            "--origin",
            f.baseUrl,
            "--timeout",
            "1",
            "--wait",
            "0",
          ],
          { cwd, env: { HUE_TEST_SURVIVOR: survivor } },
        );
        expect(result.status).toBe(1);
        expectNoSecrets(result);
        expect(f.calls.completions).toEqual([
          expect.objectContaining({
            state: "error",
            error: { type: "TargetError", message: "The agent command timed out after 1 seconds" },
          }),
        ]);
        // The grandchild writes 2500 ms after the agent starts. Signalling only the shell
        // would leave it holding HUE_MCP_TOKEN and writing after Hue failed the case.
        await new Promise((done) => setTimeout(done, 3_000));
        await expect(readFile(survivor, "utf8")).rejects.toThrow();
      } finally {
        f.stop();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT * 2,
  );

  for (const [form, command] of [
    ["x; y", `${process.execPath} agent-stubborn.mjs >/dev/null 2>&1; true`],
    ["a | b", `${process.execPath} agent-stubborn.mjs 2>/dev/null | cat >/dev/null`],
  ] as const) {
    test(
      `a timed-out compound --command (${form}) leaves no agent that ignores SIGTERM`,
      async () => {
        const f = hueStandIn();
        const cwd = await workspace();
        const survivor = join(cwd, "survivor.txt");
        let pid: number | undefined;
        try {
          const result = await hue(
            [
              "--scenario",
              "Refund flow",
              "--command",
              command,
              "--origin",
              f.baseUrl,
              "--timeout",
              "1",
              "--wait",
              "0",
            ],
            { cwd, env: { HUE_TEST_SURVIVOR: survivor } },
          );
          expect(result.status).toBe(1);
          expectNoSecrets(result);
          expect(f.calls.completions).toEqual([
            expect.objectContaining({
              state: "error",
              error: {
                type: "TargetError",
                message: "The agent command timed out after 1 seconds",
              },
            }),
          ]);
          pid = Number(await readFile(survivor, "utf8"));
          // The shell exits on SIGTERM; the agent it started does not, and would keep its world
          // token. It is killed after the grace, and the case fails only once it is gone.
          expect(alive(pid)).toBe(false);
        } finally {
          if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
          f.stop();
          await rm(cwd, { recursive: true, force: true });
        }
      },
      SPAWN_TIMEOUT * 2,
    );
  }

  for (const traces of ["refuse", "drop"] as const)
    test(
      `a case whose trace Hue ${traces === "refuse" ? "refuses" : "drops"} is completed as failed, with its counts`,
      async () => {
        // The grader never reads the execution state, so only the CLI can keep the case failing.
        const f = hueStandIn({ traces, ignoreExecutionState: true });
        const cwd = await workspace();
        try {
          const run = (json: boolean) =>
            hue(
              [
                "--scenario",
                "Refund flow",
                "--command",
                `${process.execPath} agent-command.mjs`,
                "--origin",
                f.baseUrl,
                "--wait",
                "0",
                "--checkpoint-dir",
                join(cwd, json ? "json" : "text"),
                ...(json ? ["--json"] : []),
              ],
              { cwd },
            );
          const text = await run(false);
          expectNoSecrets(text);
          expect(text.status).toBe(1);
          // The case is failed, not left started: the outcome is kept and the evidence omitted.
          expect(f.calls.completions).toEqual([
            expect.objectContaining({
              state: "error",
              error: {
                type: "TelemetryNotAccepted",
                message: expect.stringMatching(/^telemetry_not_accepted: traces failed/),
              },
            }),
          ]);
          // Without its evidence the case keeps no output a grader could pass.
          expect(f.calls.completions[0]).not.toHaveProperty("output");
          expect(f.calls.evidence).toEqual([
            {
              traceEvidence: "omit",
              omissionReason: expect.stringMatching(/^telemetry_not_accepted: traces /),
            },
          ]);
          const issue =
            traces === "refuse" ? "traces failed \\d+ \\(HTTP 400\\)" : "traces failed \\d+";
          expect(text.stderr).toMatch(
            new RegExp(
              `\\[refund\\] telemetry not accepted, case failed: telemetry_not_accepted: ${issue}`,
            ),
          );
          expect(text.stderr).not.toContain("Inspect issues and report");
          const json = await run(true);
          expectNoSecrets(json);
          expect(json.status).toBe(1);
          const [entry] = (JSON.parse(json.stdout) as { cases: Record<string, unknown>[] }).cases;
          expect(entry).toMatchObject({
            externalKey: "refund",
            state: "error",
            passed: false,
            telemetry: {
              code: "telemetry_not_accepted",
              issues: [
                traces === "refuse"
                  ? { signal: "traces", kind: "failed", status: 400, count: expect.any(Number) }
                  : { signal: "traces", kind: "failed", count: expect.any(Number) },
              ],
            },
          });
        } finally {
          f.stop();
          await rm(cwd, { recursive: true, force: true });
        }
      },
      SPAWN_TIMEOUT * 2,
    );

  test(
    "--no-output keeps outputs and error messages out of Hue; --worker refuses it",
    async () => {
      const f = hueStandIn();
      const cwd = await workspace();
      try {
        const args = [
          "--scenario",
          "Refund flow",
          "--command",
          `${process.execPath} agent-command.mjs`,
          "--origin",
          f.baseUrl,
          "--wait",
          "0",
          "--no-output",
        ];
        const answered = await hue([...args, "--checkpoint-dir", join(cwd, "answered")], { cwd });
        expect(answered.status).toBe(0);
        const crashed = await hue([...args, "--checkpoint-dir", join(cwd, "crashed")], {
          cwd,
          env: { FAIL_AGENT: "1" },
        });
        expect(crashed.status).toBe(1);
        expect(f.calls.completions).toEqual([
          expect.objectContaining({ state: "succeeded" }),
          expect.objectContaining({ state: "error", error: { type: "TargetError" } }),
        ]);
        expect(f.calls.completions[0]).not.toHaveProperty("output");
        expect(f.calls.completions[1]).not.toHaveProperty("error.message");
        const worker = await hue(
          ["--worker", "./hue-agent.ts", "--origin", f.baseUrl, "--no-output"],
          {
            cwd,
          },
        );
        expect(worker.status).toBe(2);
        expect(worker.stderr).toContain("--no-output applies to one-shot runs");
      } finally {
        f.stop();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT * 2,
  );

  test("the verdict table shows n/a where an evaluator does not apply to the case", () => {
    const [outcome, rubric, judge] = [randomUUID(), randomUUID(), randomUUID()];
    const row = (externalKey: string, metric: string, pin: string, skip: string) => ({
      caseId: randomUUID(),
      externalKey,
      subjectId: randomUUID(),
      state: "passed" as const,
      passed: true,
      notApplicable: [skip],
      metrics: [{ name: metric, value: true, scorerVersionId: pin }],
      explanations: [],
      errors: [],
    });
    const lines: string[] = [];
    renderTable(
      {
        experimentId: randomUUID(),
        runId: randomUUID(),
        scorerVersionIds: [outcome, rubric, judge],
        results: { complete: true, items: [], results: [] },
        summary: {
          cases: [
            row("trace-built", "outcome", outcome, rubric),
            row("hand-authored", "rubric", rubric, outcome),
            // A second evaluator reports a metric of the same name.
            row("judged", "outcome", judge, rubric),
          ],
          totals: {
            cases: 3,
            passed: 3,
            failed: 0,
            error: 0,
            skipped: 0,
            pending: 0,
            notApplicable: 3,
          },
        },
      },
      { log: (line) => lines.push(line), error: (line) => lines.push(line) },
    );
    expect(lines[0]).toBe("Case           outcome  rubric  Result");
    expect(lines[2]).toBe("trace-built    PASS     n/a     PASSED");
    expect(lines[3]).toBe("hand-authored  n/a      PASS    PASSED");
    expect(lines[4]).toBe("judged         PASS     n/a     PASSED");
    expect(lines.at(-1)).toBe("3 of 3 cases passed (3 evaluator results not applicable)");
  });

  test("a resume with another --no-output or --content choice names the flags to repeat", () => {
    // An unfinished run keeps its content policy (the checkpoint refuses a change); the message
    // says which flags resume it.
    const message = (persistResultContent: boolean, captureContent: boolean) =>
      explain(new CheckpointIdentityError({ persistResultContent, captureContent }));
    expect(message(false, false)).toBe(
      "This unfinished run was started with --no-output; rerun with the same flags to resume it, or remove its checkpoint directory to start over",
    );
    expect(message(false, true)).toStartWith(
      "This unfinished run was started with --no-output and --content;",
    );
    expect(message(true, false)).toStartWith(
      "This unfinished run was started without --no-output or --content;",
    );
    expect(explain(new CheckpointIdentityError())).toBe(
      "Checkpoint identity differs from this project, run, pins or content policy",
    );
  });

  test(
    "credentials the case handed the agent are never stored with its answer or error",
    async () => {
      const cwd = await workspace();
      const legacy = hueStandIn();
      const gateway = hueStandIn({ gateway: true });
      try {
        // A legacy world's hue_sim_ token and, with --allow-hue-credentials, the project key.
        const leaky = await hue(
          [
            "--scenario",
            "Refund flow",
            "--command",
            `${process.execPath} agent-leaky.mjs`,
            "--origin",
            legacy.baseUrl,
            "--allow-hue-credentials",
            "--wait",
            "0",
          ],
          { cwd },
        );
        expect(leaky.status).toBe(0);
        expect(legacy.calls.completions[0]).toMatchObject({
          output: { mcpToken: "[redacted]", apiKey: "[redacted]" },
        });
        // An adapter that throws with the world token and the key in its message.
        const throwing = await hue(
          [
            "--scenario",
            "Refund flow",
            "./hue-throwing.mjs",
            "--origin",
            gateway.baseUrl,
            "--wait",
            "0",
          ],
          { cwd },
        );
        expect(throwing.status).toBe(1);
        expect(gateway.calls.completions[0]).toMatchObject({
          state: "error",
          error: {
            type: "TargetError",
            message: "could not reach the mirror with [redacted] and [redacted]",
          },
        });
        const stored = JSON.stringify([legacy.calls.completions, gateway.calls.completions]);
        for (const secret of [key, mcpToken, worldToken]) expect(stored).not.toContain(secret);
        expect(await filesContaining(join(cwd, ".hue"), [key, mcpToken, worldToken])).toEqual([]);
        // A world case's command answering through a result file is redacted the same way.
        const filed = hueStandIn({ gateway: true });
        try {
          const written = await hue(
            [
              "--scenario",
              "Refund flow",
              "--command",
              `${process.execPath} agent-result-file.mjs`,
              "--origin",
              filed.baseUrl,
              "--wait",
              "0",
            ],
            { cwd },
          );
          expect(written.status).toBe(0);
          expect(filed.calls.completions[0]).toMatchObject({ output: { token: "[redacted]" } });
          expect(JSON.stringify(filed.calls.completions)).not.toContain(worldToken);
        } finally {
          filed.stop();
        }
      } finally {
        legacy.stop();
        gateway.stop();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT * 2,
  );

  test(
    "an error whose message cannot be reassigned is replaced, and short values are left alone",
    async () => {
      const cwd = await workspace();
      try {
        for (const dom of [false, true]) {
          const f = hueStandIn({ gateway: true });
          try {
            const result = await hue(
              [
                "--scenario",
                "Refund flow",
                "./hue-frozen.mjs",
                "--origin",
                f.baseUrl,
                "--wait",
                "0",
              ],
              { cwd, env: dom ? { HUE_TEST_DOM_EXCEPTION: "1" } : {} },
            );
            expect(result.status).toBe(1);
            expect(f.calls.completions[0]).toMatchObject({
              state: "error",
              error: {
                type: "TargetError",
                message: "mirror refused [redacted] for [redacted]",
              },
            });
          } finally {
            f.stop();
          }
        }
        expect(await filesContaining(join(cwd, ".hue"), [key, worldToken])).toEqual([]);
        // A credential shorter than any Hue issues is not redacted out of ordinary text.
        const f = hueStandIn();
        try {
          const result = await hue(
            [
              "--scenario",
              "Refund flow",
              "--command",
              `${process.execPath} agent-banana.mjs`,
              "--origin",
              f.baseUrl,
              "--wait",
              "0",
            ],
            { cwd, env: { HUE_SERVICE_KEY: "a" } },
          );
          expect(result.status).toBe(0);
          expect(f.calls.completions[0]).toMatchObject({ output: { fruit: "banana" } });
        } finally {
          f.stop();
        }
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT * 2,
  );

  test(
    "a second interrupt during the stop kills the agent's whole group at once",
    async () => {
      const f = hueStandIn();
      const cwd = await workspace();
      const survivor = join(cwd, "survivor.txt");
      let pid: number | undefined;
      try {
        const result = await hue(
          [
            "--scenario",
            "Refund flow",
            "--command",
            `${process.execPath} agent-stubborn.mjs >/dev/null 2>&1; true`,
            "--origin",
            f.baseUrl,
            "--wait",
            "0",
          ],
          {
            cwd,
            env: { HUE_TEST_SURVIVOR: survivor },
            interruptAfter: { file: survivor, times: 2 },
          },
        );
        pid = Number(await readFile(survivor, "utf8"));
        expect(result.status).toBe(130);
        expect(result.stderr).toContain("Stopping the agent; press Ctrl+C again to force.");
        expectNoSecrets(result);
        // The agent ignores SIGTERM; the second interrupt SIGKILLs its group before the CLI exits.
        for (let waited = 0; alive(pid) && waited < 1_000; waited += 50)
          await new Promise((done) => setTimeout(done, 50));
        expect(alive(pid)).toBe(false);
      } finally {
        if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
        f.stop();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT,
  );

  test(
    "a repeated SIGINT within 50 ms is the same Ctrl+C and stops the agent gracefully",
    async () => {
      // `npm run` and `npx` forward the terminal's SIGINT a moment after the terminal's own.
      const f = hueStandIn();
      const cwd = await workspace();
      const survivor = join(cwd, "survivor.txt");
      let pid: number | undefined;
      try {
        const result = await hue(
          [
            "--scenario",
            "Refund flow",
            "--command",
            `${process.execPath} agent-stubborn.mjs >/dev/null 2>&1; true`,
            "--origin",
            f.baseUrl,
            "--wait",
            "0",
          ],
          {
            cwd,
            env: { HUE_TEST_SURVIVOR: survivor },
            interruptAfter: { file: survivor, times: 2, gapMillis: 5 },
          },
        );
        pid = Number(await readFile(survivor, "utf8"));
        expect(result.status).toBe(130);
        // Not forced: the case was reported cancelled after the grace killed the agent.
        expect(f.calls.completions).toEqual([expect.objectContaining({ state: "cancelled" })]);
        expect(alive(pid)).toBe(false);
      } finally {
        if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
        f.stop();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT,
  );

  test(
    "a forced exit removes the MCP configuration that holds the world token",
    async () => {
      const f = hueStandIn({ gateway: true });
      const cwd = await workspace();
      const survivor = join(cwd, "survivor.txt");
      const record = join(cwd, "config-path.txt");
      let pid: number | undefined;
      try {
        const result = await hue(
          [
            "--scenario",
            "Refund flow",
            "--command",
            `${process.execPath} agent-stubborn.mjs >/dev/null 2>&1; true`,
            "--origin",
            f.baseUrl,
            "--wait",
            "0",
          ],
          {
            cwd,
            env: { HUE_TEST_SURVIVOR: survivor, HUE_TEST_CONFIG_RECORD: record },
            interruptAfter: { file: survivor, times: 2 },
          },
        );
        pid = Number(await readFile(survivor, "utf8"));
        expect(result.status).toBe(130);
        const configPath = await readFile(record, "utf8");
        expect(configPath).toMatch(/mcp\.json$/);
        expect(existsSync(configPath)).toBe(false);
        expect(existsSync(join(configPath, ".."))).toBe(false);
      } finally {
        if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
        f.stop();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT,
  );

  test("a signal error other than ESRCH is reported once per command", async () => {
    const kill = process.kill.bind(process);
    let refused = 0;
    const killSpy = spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: string | number,
    ) => {
      // The group's probes are refused a few times before it is found gone.
      if (pid < 0 && signal === 0 && refused < 5) {
        refused++;
        throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
      }
      return kill(pid, signal);
    }) as typeof process.kill);
    const warnings: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      if (String(chunk).startsWith("Warning:")) warnings.push(String(chunk));
      return write(chunk);
    }) as typeof process.stderr.write);
    try {
      await expect(
        spawnAgentCommand("sleep 5", { env: process.env, timeoutSeconds: 0.2 }),
      ).rejects.toThrow("timed out");
      expect(refused).toBe(5);
      expect(warnings).toEqual([
        "Warning: could not signal the agent command's process group (0, EPERM)\n",
      ]);
    } finally {
      killSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  test("an abort that lands before the command starts stops it at once", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = performance.now();
    await expect(
      spawnAgentCommand("sleep 5", {
        env: process.env,
        timeoutSeconds: 30,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(TargetCancelledError);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("a stop never signals the agent's group again once it has emptied", async () => {
    // The shell and its group are gone at once, but a process that left the group keeps stdout
    // open, so the command times out after its group emptied: its ID must not be signalled.
    const calls: [number, string | number | undefined, string?][] = [];
    const kill = process.kill.bind(process);
    const spy = spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: string | number,
    ) => {
      try {
        const sent = kill(pid, signal);
        if (pid < 0) calls.push([pid, signal]);
        return sent;
      } catch (error) {
        if (pid < 0) calls.push([pid, signal, (error as NodeJS.ErrnoException).code]);
        throw error;
      }
    }) as typeof process.kill);
    const escaped = `require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], { detached: true, stdio: "inherit" }).unref()`;
    try {
      await expect(
        spawnAgentCommand(`${process.execPath} -e '${escaped}'`, {
          env: process.env,
          timeoutSeconds: 0.5,
        }),
      ).rejects.toThrow("timed out");
      const emptied = calls.findIndex(([, , code]) => code === "ESRCH");
      expect(emptied).toBeGreaterThanOrEqual(0);
      expect(calls.slice(emptied + 1)).toEqual([]);
      expect(calls.filter(([, signal]) => signal !== 0)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test(
    "an interrupt while waiting for Hue's checks exits 130 without a verdict",
    async () => {
      // Verdicts that never land, so the interrupt always arrives during the wait.
      const f = hueStandIn({ deferredPolls: 1_000 });
      const cwd = await workspace();
      try {
        const result = await hue(
          ["--scenario", "Refund flow", "./hue-agent.ts", "--origin", f.baseUrl, "--wait", "600"],
          { cwd, interruptOn: /Waiting for Hue checks/ },
        );
        expect(result.status).toBe(130);
        expectNoSecrets(result);
        expect(result.stderr).toContain("Interrupted.");
        expect(result.stdout).not.toContain("case passed");
        expect(result.stdout).not.toContain("refund_recorded");
      } finally {
        f.stop();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT * 2,
  );

  test(
    "refuses missing keys and invalid selections with exit 2 before contacting Hue",
    async () => {
      const f = hueStandIn();
      const cwd = await workspace();
      try {
        const missingKey = await hue(
          ["--scenario", "Refund flow", "./hue-agent.ts", "--origin", f.baseUrl],
          {
            cwd,
            dropKey: true,
          },
        );
        expect(missingKey.status).toBe(2);
        expect(missingKey.stdout).toBe("");
        expect(missingKey.stderr).toContain("HUE_API_KEY is required");
        expect(f.calls.requests).toEqual([]);
        for (const args of [
          ["./hue-agent.ts"],
          ["--scenario", "Refund flow"],
          ["--scenario", "Refund flow", "--set", "Refund flow", "./hue-agent.ts"],
          ["--case", "Refund flow", "--scenario", "Refund flow", "./hue-agent.ts"],
          ["--scenario", "Refund flow", "./hue-agent.ts", "--command", "true"],
          ["--worker", "--scenario", "Refund flow", "./hue-agent.ts"],
          ["--set", "Refund flow", "./hue-agent.ts"],
          ["--scenario", "Refund flow", "./hue-agent.ts", "--wait", "-1"],
          ["--scenario", "Refund flow", "./missing-adapter.ts"],
          ["--scenario", "Refund flow", "./hue-agent.ts", "--unknown"],
          ["--scenario", "Refund flow", "./hue-agent.ts", "--env-file", "a", "--env-path", "b"],
        ]) {
          const result = await hue([...args, "--origin", f.baseUrl], { cwd });
          expect(result.status).toBe(2);
          expect(result.stderr).toContain("Usage: hue eval");
        }
        expect(f.calls.requests).toEqual([]);
        // --env-path loads like --env-file: a missing file is refused before Hue is contacted.
        const missingEnv = await hue(
          ["--scenario", "Refund flow", "./hue-agent.ts", "--env-path", ".env.missing"],
          { cwd, dropKey: true },
        );
        expect(missingEnv.status).toBe(2);
        expect(missingEnv.stderr).toContain("Unable to load .env.missing");
        expect(f.calls.requests).toEqual([]);
        const help = await hue(["--help"], { cwd, dropKey: true });
        expect(help.status).toBe(0);
        expect(help.stdout).toContain("Usage: hue eval [adapter-file] [options]");
        expect(help.stdout).toContain("--case <name|id|url>");
        const unauthorized = await hue(
          ["--scenario", "Refund flow", "./hue-agent.ts", "--origin", f.baseUrl],
          { cwd, env: { HUE_API_KEY: "wrong-key" } },
        );
        expect(unauthorized.status).toBe(1);
        expect(unauthorized.stderr).toContain("HTTP 401");
        expect(unauthorized.stderr).toContain("Read and write");
        expect(unauthorized.stderr).not.toContain("wrong-key");
      } finally {
        f.stop();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT * 2,
  );

  test(
    "requires a saved version and freezes it only with --save-version",
    async () => {
      const f = hueStandIn({ frozen: false });
      const cwd = await workspace();
      try {
        const refused = await hue(
          [
            "--set",
            "Refund flow",
            "--scorer-version",
            f.scorerVersion.id,
            "./hue-agent.ts",
            "--origin",
            f.baseUrl,
          ],
          { cwd },
        );
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain('Choose "Save eval-set version" in Hue');
        expect(refused.stderr).toContain("--save-version");
        expect(f.calls.frozen).toEqual([]);
        expect(f.experiments.size).toBe(0);
        const saved = await hue(
          [
            "--dataset-version",
            f.version.id,
            "--scorer-version",
            f.scorerVersion.id,
            "./hue-agent.ts",
            "--origin",
            f.baseUrl,
            "--save-version",
            "--name",
            "Saved on demand",
          ],
          { cwd },
        );
        expect(saved.status).toBe(0);
        expect(saved.stdout).toContain('Saved "Refund flow" version 1.');
        expect(f.calls.frozen).toEqual([2]);
        expect([...f.experiments.values()][0]?.name).toBe("Saved on demand");
      } finally {
        f.stop();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT * 2,
  );

  test(
    "compares verdicts with a --baseline experiment",
    async () => {
      const f = hueStandIn();
      const cwd = await workspace();
      const common = ["--scenario", "Refund flow", "./hue-agent.ts", "--origin", f.baseUrl];
      try {
        const first = await hue(common, { cwd });
        expect(first.status).toBe(0);
        const firstId = /^Experiment: (.+)$/m.exec(first.stdout)?.[1];
        expect(firstId).toBeTruthy();
        f.state.verdict = "fail";
        const second = await hue([...common, "--baseline", `${f.baseUrl}/experiments/${firstId}`], {
          cwd,
        });
        expect(second.status).toBe(1);
        expect(second.stdout).toContain(
          `Baseline ${firstId}: 0 improved, 1 regressed, 0 unchanged`,
        );
        expect(second.stdout).toContain("  refund: passed -> failed (regressed)");
        const secondId = /^Experiment: (.+)$/m.exec(second.stdout)?.[1];
        f.state.verdict = "pass";
        const third = await hue([...common, "--baseline", secondId!, "--json"], { cwd });
        expect(third.status).toBe(0);
        const document = JSON.parse(third.stdout) as Record<string, any>;
        expect(document.baseline).toEqual({
          experimentId: secondId,
          improvements: 1,
          regressions: 0,
          unchanged: 0,
          cases: [{ externalKey: "refund", before: "failed", after: "passed", change: "improved" }],
        });
        expect(f.experiments.size).toBe(3);
      } finally {
        f.stop();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT * 3,
  );

  test(
    "--worker registers the agent, claims a queued run and reports it",
    async () => {
      const f = hueStandIn();
      const queued = f.enqueueRun();
      const cwd = await workspace();
      try {
        const result = await hue(
          [
            "--worker",
            "./hue-agent.ts",
            "--origin",
            f.baseUrl,
            "--max-runs",
            "1",
            "--agent-key",
            "refund-bot",
            "--agent-name",
            "Refund bot",
            "--revision",
            "v7",
            "--checkpoint-dir",
            join(cwd, "worker-state"),
          ],
          { cwd },
        );
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expectNoSecrets(result);
        expect(f.calls.register[0]).toEqual({
          key: "refund-bot",
          name: "Refund bot",
          revision: "v7",
          capabilities: ["environment:v1"],
          scorerDigests: [],
        });
        expect(f.calls.claims).toBeGreaterThanOrEqual(1);
        expect(f.calls.localRuns).toEqual([
          { runId: queued.runId, workerId: expect.any(String), state: "completed" },
        ]);
        expect(result.stdout).toContain(
          `Registered agent refund-bot (revision v7) with ${f.baseUrl}; waiting for runs launched from Hue (stops after 1)`,
        );
        expect(result.stdout).toContain(
          `Claimed run ${queued.runId}: ${f.baseUrl}/experiments/${queued.experimentId}`,
        );
        expect(result.stdout).toContain("[refund] agent started");
        expect(result.stdout).toContain("completed: 1 case");
        expect(result.stdout).toContain("refund  PASS             polite  PASSED");
        expect(f.experiments.get(queued.experimentId)?.finishedAt).toBeTruthy();
        expect([...f.worlds.values()][0]?.status).toBe("completed");
      } finally {
        f.stop();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT,
  );

  test(
    "an interrupted worker verdict wait exits 130 without printing partial verdicts",
    async () => {
      const f = hueStandIn({ deferredPolls: 100 });
      f.enqueueRun();
      const cwd = await workspace();
      try {
        const result = await hue(
          ["--worker", "./hue-agent.ts", "--origin", f.baseUrl, "--max-runs", "1", "--wait", "30"],
          { cwd, interruptOn: /Waiting for Hue checks\.\.\./ },
        );
        expect(result.status).toBe(130);
        expect(result.stderr).toContain("Interrupted.");
        expect(result.stdout).toContain("Waiting for Hue checks...");
        expect(result.stdout).not.toContain("PASS");
        expect(result.stdout).not.toContain('"totals"');
      } finally {
        f.stop();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT,
  );
});
