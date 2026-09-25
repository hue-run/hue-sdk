import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHue } from "../src/index.js";
import { createEnvironmentClient } from "../src/environment.js";
import {
  createEvaluationClient,
  defineLocalScorer,
  localAgentCapabilities,
  registeredCapabilities,
  runLocalAgent,
  withFiles,
  type CaseFile,
  type Completion,
  type Execution,
  type Experiment,
  type ExperimentCase,
  type LocalAgentTargetContext,
  type LocalScorer,
  type RunLocalAgentOptions,
  type ScoreContext,
  type ScorerVersion,
  type StoredResult,
  type Subject,
} from "../src/evals.js";
import { runForcedExitCleanups } from "../src/evals/exit-cleanup.js";
import { isSafeFileName } from "../src/evals/files.js";

const cli = join(import.meta.dir, "../src/setup/cli.ts");
const evalsModule = join(import.meta.dir, "../src/evals.ts");
const key = "synthetic-environment-files-key";
const worldToken = `hue_world_${"c".repeat(64)}.${"s".repeat(43)}`;
const digest = "d".repeat(64);
const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const SPAWN_TIMEOUT = 90_000;

type Stored = {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  state: "reserved" | "ready";
  bytes?: Uint8Array;
};

/**
 * Loopback platform for one world case that carries two pinned files: an agent-visible report
 * and an evaluator-only answer key. It serves the item read with both, as it does for a run with a
 * local code evaluator, gateway worlds with a world token, artifacts, the worker queue and a
 * Hue-graded verdict after completion.
 */
function platform(
  options: {
    /** Name the manifest gives the agent-visible file. */
    sourceName?: string;
    /** Serve this file's bytes altered, with the pinned size. */
    tamper?: "source" | "answerKey";
    /** Pin this local scorer instead of the Hue-graded world outcome. */
    scorer?: LocalScorer;
    /** Refuse this many generated-artifact completions with 500 first. */
    failArtifactCompletions?: number;
  } = {},
) {
  const projectId = randomUUID();
  const environmentVersionId = randomUUID();
  const agentId = randomUUID();
  const dataset = {
    id: randomUUID(),
    name: "Citation letters",
    slug: "citation-letters",
    archivedAt: null,
    versions: [
      {
        id: randomUUID(),
        datasetId: "",
        version: 1,
        revision: 2,
        frozenAt: "2026-09-20T00:00:00.000Z",
        contentDigest: digest,
      },
    ],
  };
  const version = dataset.versions[0]!;
  version.datasetId = dataset.id;
  const source = {
    id: randomUUID(),
    name: options.sourceName ?? "Informe de ausentismo.pdf",
    type: "application/pdf",
    bytes: Buffer.from("%PDF-1.4 informe de ausentismo"),
  };
  const answerKey = {
    id: randomUUID(),
    name: "answer-key.json",
    type: "application/json",
    bytes: Buffer.from('{"expected":"evaluator-only answer"}'),
  };
  const artifacts = new Map<string, Stored>();
  for (const input of [source, answerKey])
    artifacts.set(input.id, {
      id: input.id,
      filename: input.name,
      contentType: input.type,
      byteSize: input.bytes.byteLength,
      sha256: sha256(input.bytes),
      state: "ready",
      bytes: input.bytes,
    });
  const entry = (input: typeof source, role: CaseFile["role"]): CaseFile => ({
    artifactId: input.id,
    role,
    filename: input.name,
    contentType: input.type,
    byteSize: input.bytes.byteLength,
    sha256: sha256(input.bytes),
  });
  const frozenCase: ExperimentCase = {
    id: randomUUID(),
    datasetVersionId: version.id,
    externalKey: "ausentismo-01",
    inputs: { task: "Draft the citation letter from the attached report" },
    hasExpected: false,
    metadata: { grading: "evaluator-private" },
    environmentVersionId,
    artifactManifestId: randomUUID(),
    inputFiles: [entry(source, "source"), entry(answerKey, "evaluator_reference")],
  };
  const worldOutcome = {
    id: randomUUID(),
    contentDigest: digest,
    definition: {
      kind: "world_outcome",
      entry: "hue.conversion_outcome.v1",
      metrics: [{ name: "letter_sent", type: "boolean" }],
    },
  } as unknown as ScorerVersion;
  const localVersion: ScorerVersion | undefined = options.scorer
    ? { id: randomUUID(), contentDigest: digest, definition: options.scorer.definition }
    : undefined;
  const versions = [worldOutcome, ...(localVersion ? [localVersion] : [])];
  const experiments = new Map<string, Experiment>();
  const executions = new Map<string, Execution & { experimentId: string }>();
  const worlds = new Map<string, { executionId: string; status: string }>();
  const subjects = new Map<string, Subject>();
  const runItems = new Map<
    string,
    { id: string; subjectId: string; hasOutput: boolean; traceSnapshotId: string | null }[]
  >();
  const results = new Map<string, StoredResult[]>();
  const reservations = new Map<string, string>();
  const queue: { runId: string; experimentId: string; state: string; workerId?: string }[] = [];
  let failArtifactCompletions = options.failArtifactCompletions ?? 0;
  /** Runs while the platform answers a case read, before it responds. */
  const hooks: { caseRead?: () => void } = {};
  const calls = {
    downloads: [] as string[],
    starts: 0,
    worldCreates: 0,
    finishes: [] as string[],
    completions: [] as Record<string, unknown>[],
    registrations: [] as Record<string, unknown>[],
    localRuns: [] as Record<string, unknown>[],
    submitted: [] as Record<string, unknown>[],
    uploads: 0,
  };
  function createExperiment(scorerVersionIds: string[], config: Experiment["config"] = {}) {
    const experiment: Experiment = {
      id: randomUUID(),
      name: "Citation letters",
      datasetVersionId: version.id,
      config,
      configDigest: digest,
      evaluation: {
        id: randomUUID(),
        name: "default",
        scorerVersions: versions.filter((item) => scorerVersionIds.includes(item.id)),
        itemCount: 1,
        scores: { scored: 0, error: 0, skipped: 0, pending: 1 },
      },
      caseCount: 1,
      finishedAt: null,
      execution: { unstarted: 1, started: 0, uncertain: 0, succeeded: 0, error: 0, cancelled: 0 },
    };
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
      if (url.pathname.startsWith("/blob/")) {
        // Storage never receives the project key.
        expect(request.headers.get("authorization")).toBeNull();
        const stored = artifacts.get(url.pathname.slice("/blob/".length))!;
        stored.bytes = new Uint8Array(await request.arrayBuffer());
        calls.uploads++;
        return Response.json({ ok: true });
      }
      if (request.headers.get("authorization") !== `Bearer ${key}`)
        return new Response(null, { status: 401 });
      const path = url.pathname.replace("/api/v1", "");
      if (path === "/projects/current")
        return Response.json({
          id: projectId,
          name: "Synthetic",
          slug: "synthetic",
          organizationId: randomUUID(),
        });
      if (path.startsWith("/otlp/")) {
        await request.arrayBuffer();
        return new Response(new Uint8Array(), {
          headers: { "Content-Type": "application/x-protobuf" },
        });
      }
      const download = /^\/artifacts\/([^/]+)\/download$/.exec(path);
      if (download) {
        const stored = artifacts.get(download[1]!);
        if (!stored?.bytes || stored.state !== "ready") return new Response(null, { status: 404 });
        calls.downloads.push(stored.id);
        const tampered = options.tamper === "answerKey" ? answerKey : source;
        const bytes =
          options.tamper && stored.id === tampered.id
            ? Buffer.from(stored.bytes).fill(0x41, 0, 8)
            : stored.bytes;
        return new Response(bytes as Uint8Array<ArrayBuffer>, {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      const body =
        request.method === "GET" ? {} : ((await request.json()) as Record<string, unknown>);
      if (path === `/datasets/${dataset.id}`) return Response.json(dataset);
      if (path === `/dataset-versions/${version.id}`) return Response.json(version);
      if (path === `/dataset-versions/${version.id}/cases`)
        return Response.json({ items: [frozenCase], nextCursor: null });
      if (path === "/local-agent-worker/register") {
        calls.registrations.push(body);
        return Response.json({
          id: agentId,
          ...body,
          enabled: true,
          lastSeenAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        });
      }
      if (path === "/local-agent-worker/claim") {
        // A claimed run goes back only to the worker that holds it, for checkpointed recovery.
        const queued = queue.find(
          (item) =>
            item.state === "queued" ||
            (item.state === "claimed" && item.workerId === body.workerId),
        );
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
      if (path === "/experiments" && request.method === "POST") {
        if (body.datasetVersionId !== version.id) return new Response(null, { status: 404 });
        const experiment = createExperiment(
          body.scorerVersionIds as string[],
          body.config as Experiment["config"],
        );
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
          calls.starts++;
          const execution = {
            id: randomUUID(),
            attempt: 1,
            state: "started" as const,
            traceExternalId: String(body.traceExternalId),
            experimentId: experiment.id,
          };
          executions.set(execution.id, execution);
          return Response.json(execution);
        }
        if (experimentMatch[2]) {
          if (experimentMatch[2] !== frozenCase.id) return new Response(null, { status: 404 });
          hooks.caseRead?.();
          return Response.json(frozenCase);
        }
        if (path.endsWith("/items"))
          return Response.json({
            items: [
              {
                id: frozenCase.id,
                externalKey: frozenCase.externalKey,
                hasExpected: false,
                execution:
                  [...executions.values()].find((item) => item.experimentId === experiment.id) ??
                  null,
              },
            ],
            nextCursor: null,
          });
        return Response.json(experiment);
      }
      if (path === "/artifacts" && request.method === "POST") {
        const reservationKey = String(body.idempotencyKey);
        let id = reservations.get(reservationKey);
        if (!id) {
          id = randomUUID();
          reservations.set(reservationKey, id);
          artifacts.set(id, {
            id,
            filename: String(body.filename),
            contentType: String(body.contentType),
            byteSize: Number(body.byteSize),
            sha256: String(body.sha256),
            state: "reserved",
          });
        }
        const stored = artifacts.get(id)!;
        return Response.json(
          {
            id,
            filename: stored.filename,
            declaredContentType: stored.contentType,
            declaredBytes: stored.byteSize,
            declaredSha256: stored.sha256,
            state: stored.state,
            copyState: stored.state === "ready" ? "acknowledged" : "none",
            verifiedBytes: null,
            verifiedSha256: null,
            failureCode: null,
          },
          { status: 201 },
        );
      }
      const action = /^\/artifacts\/([^/]+)\/(upload|complete)$/.exec(path);
      if (action) {
        const stored = artifacts.get(action[1]!);
        if (!stored) return new Response(null, { status: 404 });
        if (action[2] === "upload")
          return Response.json({
            uploadUrl: `${url.origin}/blob/${stored.id}`,
            method: "PUT",
            headers: { "content-type": stored.contentType },
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        if (failArtifactCompletions > 0) {
          failArtifactCompletions--;
          return new Response(null, { status: 500 });
        }
        if (
          !stored.bytes ||
          stored.bytes.byteLength !== stored.byteSize ||
          sha256(stored.bytes) !== stored.sha256
        )
          return new Response(null, { status: 409 });
        stored.state = "ready";
        return Response.json({
          id: stored.id,
          filename: stored.filename,
          declaredContentType: stored.contentType,
          declaredBytes: stored.byteSize,
          declaredSha256: stored.sha256,
          state: "ready",
          copyState: "acknowledged",
          verifiedBytes: stored.byteSize,
          verifiedSha256: stored.sha256,
          failureCode: null,
        });
      }
      if (path === "/environment-runs") {
        calls.worldCreates++;
        const id = randomUUID();
        worlds.set(id, { executionId: String(body.executionId), status: "open" });
        const mirror = `${url.origin}/api/sim/gmailmcp.googleapis.com/mcp/v1`;
        return Response.json({
          id,
          environmentVersionId,
          clockNs: "0",
          stateDigest: digest,
          maxSteps: 50,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          actions: [],
          worldId: id,
          token: worldToken,
          lifecycle: "live",
          completingUntil: null,
          baggage: `hue-world=${id}`,
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
            HUE_WORLD_ID: id,
            HUE_WORLD_TOKEN: worldToken,
            BAGGAGE: `hue-world=${id}`,
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
        });
      }
      const worldMatch = /^\/environment-runs\/([^/]+)(\/finish)?$/.exec(path);
      if (worldMatch) {
        const world = worlds.get(worldMatch[1]!);
        if (!world) return new Response(null, { status: 404 });
        if (worldMatch[2]) {
          if (world.status !== "open") return new Response(null, { status: 409 });
          world.status = String(body.status);
          calls.finishes.push(world.status);
          return Response.json({
            id: worldMatch[1],
            status: world.status,
            stepCount: 0,
            stateDigest: digest,
            sealedAt: new Date().toISOString(),
          });
        }
        return Response.json({
          id: worldMatch[1],
          environmentVersionId,
          executionId: world.executionId,
          seed: "e".repeat(32),
          status: world.status,
          stepCount: 0,
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
      const evidence = /^\/experiment-executions\/([^/]+)\/environment(\/steps)?$/.exec(path);
      if (evidence) {
        const linked = [...worlds.entries()].find(([, world]) => world.executionId === evidence[1]);
        if (!linked) return new Response(null, { status: 404 });
        if (linked[1].status === "open") return new Response(null, { status: 409 });
        if (evidence[2]) return Response.json({ items: [], nextCursor: null });
        return Response.json({
          validity: "not_assessed",
          coverageGap: null,
          runId: linked[0],
          executionId: evidence[1],
          environmentVersionId,
          definitionDigest: digest,
          seed: "e".repeat(32),
          status: linked[1].status,
          stepCount: 0,
          stateDigest: digest,
          initialState: { collections: {} },
          finalState: { collections: {} },
        });
      }
      const executionMatch = /^\/experiment-executions\/([^/]+)(\/complete)?$/.exec(path);
      if (executionMatch) {
        const execution = executions.get(executionMatch[1]!);
        if (!execution) return new Response(null, { status: 404 });
        if (!executionMatch[2]) return Response.json(execution);
        // Completion refuses an open linked world and artifacts that are not verified.
        const world = [...worlds.values()].find((item) => item.executionId === execution.id);
        if (world?.status === "open") return new Response(null, { status: 409 });
        const ids = (body.artifactIds as string[] | undefined) ?? [];
        if (ids.some((id) => artifacts.get(id)?.state !== "ready"))
          return new Response(null, { status: 409 });
        const experiment = experiments.get(execution.experimentId)!;
        execution.state = body.state as Execution["state"];
        calls.completions.push(body);
        const subjectId = randomUUID();
        const evaluationItemId = randomUUID();
        const hasOutput = Object.hasOwn(body, "output");
        subjects.set(subjectId, {
          id: subjectId,
          executionId: execution.id,
          inputs: frozenCase.inputs,
          hasOutput,
          ...(hasOutput ? { output: body.output as Subject["output"] } : {}),
          hasExpected: false,
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
        // Hue grades the world outcome after the seal; the letter counts only when uploaded.
        if (experiment.evaluation.scorerVersions.some((item) => item.id === worldOutcome.id))
          results.get(experiment.evaluation.id)!.push({
            id: randomUUID(),
            runId: experiment.evaluation.id,
            itemId: evaluationItemId,
            scorerVersionId: worldOutcome.id,
            state: "scored",
            metrics: [{ name: "letter_sent", value: ids.length === 1 }],
            explanation: ids.length === 1 ? "The letter was uploaded." : "No letter.",
            evidence: null,
            error: null,
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
        if (request.method === "POST") {
          calls.submitted.push(body);
          return Response.json({ ids: [randomUUID()] });
        }
        return Response.json({
          items: (results.get(runMatch[1]!) ?? []).map(
            ({ id, itemId, scorerVersionId, state }) => ({ id, itemId, scorerVersionId, state }),
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
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    calls,
    hooks,
    artifacts,
    source,
    answerKey,
    frozenCase,
    version,
    worldOutcome,
    /** Queue a run launched from Hue on this case, pinned to the local scorer when there is one. */
    enqueue() {
      const experiment = createExperiment(localVersion ? [localVersion.id] : []);
      queue.push({ runId: randomUUID(), experimentId: experiment.id, state: "queued" });
      return experiment;
    },
    /** Queue a run pinned to the Hue-graded world outcome, as `hue eval --worker` receives. */
    enqueueGraded() {
      const experiment = createExperiment([worldOutcome.id]);
      queue.push({ runId: randomUUID(), experimentId: experiment.id, state: "queued" });
      return experiment;
    },
    stop: () => server.stop(true),
  };
}

/** Every file under `directory` with its UTF-8 contents. */
async function tree(directory: string): Promise<{ path: string; text: string }[]> {
  const found: { path: string; text: string }[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await tree(path)));
    else found.push({ path, text: await readFile(path, "utf8") });
  }
  return found;
}

const mode = async (path: string) => (await stat(path)).mode & 0o777;

function worker(
  f: ReturnType<typeof platform>,
  checkpointDirectory: string,
  overrides: Partial<RunLocalAgentOptions>,
) {
  const hue = createHue({
    apiKey: key,
    baseUrl: f.baseUrl,
    serviceName: "environment-files",
    captureContent: false,
  });
  return runLocalAgent({
    client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl }),
    environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: f.baseUrl }),
    hue,
    checkpointDirectory,
    agent: {
      key: "letter-agent",
      name: "Letter agent",
      revision: "1",
      capabilities: [localAgentCapabilities.environmentFiles, "input:pdf"],
    },
    maxRuns: 1,
    ...overrides,
  }).finally(() => hue.shutdownSafe({ timeoutMillis: 2000 }));
}

describe("environment target files (environment-files:v1)", () => {
  test("the agent receives only the verified agent-visible file with its world, and its letter is uploaded and linked", async () => {
    let scored: ScoreContext | undefined;
    const scorer = defineLocalScorer({
      source: "export default function letterGrader() {}",
      entrypoint: "letterGrader",
      metrics: [{ name: "has_letter", type: "boolean" }],
      score(context) {
        scored = structuredClone(context);
        return {
          state: "scored",
          metrics: [{ name: "has_letter", value: true }],
          explanation: "One letter.",
        };
      },
    });
    const f = platform({ scorer });
    const experiment = f.enqueue();
    const directory = await mkdtemp(join(tmpdir(), "hue-environment-files-"));
    let seen:
      | {
          context: LocalAgentTargetContext;
          bytes: Buffer;
          modes: { file: number; directory: number; output: number };
          siblings: string[];
          downloads: string[];
          caseFiles: { path: string; text: string }[];
        }
      | undefined;
    try {
      await worker(f, directory, {
        scorers: [scorer],
        async target(_inputs, _tools, context) {
          const file = context.files[0]!;
          const letter = join(context.outputDirectory, "Citacion.docx");
          await writeFile(letter, "carta de citación");
          seen = {
            context: structuredClone(context),
            bytes: await readFile(file.path),
            modes: {
              file: await mode(file.path),
              directory: await mode(dirname(file.path)),
              output: await mode(context.outputDirectory),
            },
            siblings: await readdir(dirname(file.path)),
            downloads: [...f.calls.downloads],
            // Everything on disk for this case while the agent runs: its inputs, the
            // evaluator's download and the agent's work.
            caseFiles: await tree(dirname(dirname(file.path))),
          };
          return withFiles({ summary: "letter drafted" }, [
            { path: letter, filename: "Citacion.docx", contentType: docx, primary: true },
          ]);
        },
      });
    } finally {
      f.stop();
    }
    const context = seen!.context;
    // Only the agent-visible file, byte for byte as pinned, owner-only.
    expect(context.files).toEqual([
      expect.objectContaining({
        artifactId: f.source.id,
        role: "source",
        filename: f.source.name,
        contentType: "application/pdf",
        byteSize: f.source.bytes.byteLength,
        sha256: sha256(f.source.bytes),
      }),
    ]);
    expect(seen!.bytes.equals(f.source.bytes)).toBe(true);
    expect(seen!.modes).toEqual({ file: 0o600, directory: 0o700, output: 0o700 });
    // The evaluator's file was checked before the execution started but is not on disk while the
    // agent runs: the local scorer's copy is saved after the target finished, apart from the agent's.
    expect(seen!.siblings).toEqual([basename(context.files[0]!.path)]);
    expect(seen!.downloads).toEqual([f.answerKey.id, f.source.id]);
    expect(seen!.caseFiles.some((file) => file.text === f.answerKey.bytes.toString())).toBe(false);
    expect(dirname(scored!.files![1]!.path)).not.toBe(dirname(context.files[0]!.path));
    expect(JSON.stringify(context)).not.toContain("evaluator-private");
    // The world token reaches the agent only through the handoff: no path, no file holds it.
    expect(context.world?.token).toBe(worldToken);
    for (const file of seen!.caseFiles) {
      expect(file.path).not.toContain(worldToken);
      expect(file.text).not.toContain(worldToken);
    }
    for (const file of await tree(directory)) expect(file.text).not.toContain(worldToken);
    // The registration declares the capability with the accepted input type.
    expect(f.calls.registrations[0]!.capabilities).toEqual([
      "environment-files:v1",
      "input:pdf",
      "environment:v1",
    ]);
    // The letter is uploaded, verified and linked on completion as the primary document.
    expect(f.calls.completions).toHaveLength(1);
    const completion = f.calls.completions[0]!;
    expect(completion).toMatchObject({ state: "succeeded", output: { summary: "letter drafted" } });
    const artifactIds = completion.artifactIds as string[];
    expect(artifactIds).toHaveLength(1);
    expect(completion.primaryArtifactId).toBe(artifactIds[0]);
    const letter = f.artifacts.get(artifactIds[0]!)!;
    expect(letter).toMatchObject({ filename: "Citacion.docx", contentType: docx, state: "ready" });
    expect(Buffer.from(letter.bytes!).toString()).toBe("carta de citación");
    expect(f.calls.finishes).toEqual(["completed"]);
    expect(f.calls.localRuns).toEqual([expect.objectContaining({ state: "completed" })]);
    // The local scorer grades the report, the evaluator's answer key and the uploaded letter.
    expect(scored!.files!.map((file) => [file.role, file.filename])).toEqual([
      ["source", f.source.name],
      ["evaluator_reference", "answer-key.json"],
      ["output", "Citacion.docx"],
    ]);
    expect(f.calls.submitted).toHaveLength(1);
    // After the case, its directory is gone: the agent's copies, its work, the evaluator's
    // download and the staged letter.
    const caseDirectory = join(
      directory,
      `experiment-${experiment.id}`,
      "files",
      `world-case-${f.frozenCase.id}`,
    );
    expect(dirname(dirname(context.files[0]!.path))).toBe(caseDirectory);
    expect(existsSync(caseDirectory)).toBe(false);
    expect(existsSync(context.outputDirectory)).toBe(false);
    for (const file of scored!.files!) expect(existsSync(file.path)).toBe(false);
  }, 30_000);

  test("a case that stops early keeps only the staged outputs its upload resumes from", async () => {
    const f = platform({ failArtifactCompletions: 1 });
    const experiment = f.enqueue();
    const directory = await mkdtemp(join(tmpdir(), "hue-environment-files-resume-"));
    const caseDirectory = join(
      directory,
      `experiment-${experiment.id}`,
      "files",
      `world-case-${f.frozenCase.id}`,
    );
    let targets = 0;
    const target: RunLocalAgentOptions["target"] = async (_inputs, _tools, context) => {
      targets++;
      const letter = join(context.outputDirectory, "Citacion.docx");
      await writeFile(letter, "carta de citación");
      return withFiles({ summary: "letter drafted" }, [
        { path: letter, filename: "Citacion.docx", contentType: docx, primary: true },
      ]);
    };
    try {
      await expect(worker(f, directory, { target })).rejects.toMatchObject({ status: 500 });
      // The agent's inputs and work are gone; the staged letter stays for the upload to resume.
      expect((await readdir(caseDirectory)).sort()).toEqual(["outputs"]);
      expect(await readdir(join(caseDirectory, "outputs"))).toEqual(["Citacion.docx"]);
      const staged = [...f.artifacts.values()].find((item) => item.filename === "Citacion.docx");
      expect(staged?.state).toBe("reserved");
      // The resume publishes the staged letter without invoking the agent again. The runner then
      // stops, as before, because the first attempt's trace export was never acknowledged; with
      // the upload settled, nothing of the case is kept.
      await expect(worker(f, directory, { target })).rejects.toThrow(
        /trace export acknowledgement is unavailable/,
      );
      expect(staged?.state).toBe("ready");
      expect(Buffer.from(staged!.bytes!).toString()).toBe("carta de citación");
    } finally {
      f.stop();
    }
    expect(targets).toBe(1);
    expect(existsSync(caseDirectory)).toBe(false);
  }, 30_000);

  test("a forced exit while a resume loads its case keeps the staged outputs it needs", async () => {
    const f = platform({ failArtifactCompletions: 1 });
    const experiment = f.enqueue();
    const directory = await mkdtemp(join(tmpdir(), "hue-environment-files-forced-resume-"));
    const outputs = join(
      directory,
      `experiment-${experiment.id}`,
      "files",
      `world-case-${f.frozenCase.id}`,
      "outputs",
    );
    const target: RunLocalAgentOptions["target"] = async (_inputs, _tools, context) => {
      const letter = join(context.outputDirectory, "Citacion.docx");
      await writeFile(letter, "carta de citación");
      return withFiles({ summary: "letter drafted" }, [
        { path: letter, filename: "Citacion.docx", contentType: docx, primary: true },
      ]);
    };
    let kept: string[] | undefined;
    try {
      await expect(worker(f, directory, { target })).rejects.toMatchObject({ status: 500 });
      // The resume reads its `uploading` checkpoint, then the case; a second Ctrl+C lands there.
      f.hooks.caseRead = () => {
        f.hooks.caseRead = undefined;
        runForcedExitCleanups();
        kept = existsSync(outputs) ? readdirSync(outputs) : [];
      };
      await worker(f, directory, { target }).catch(() => undefined);
    } finally {
      f.stop();
    }
    expect(kept).toEqual(["Citacion.docx"]);
  }, 30_000);

  test("a checkpoint that fails its integrity check keeps nothing of the case", async () => {
    const f = platform({ failArtifactCompletions: 1 });
    const experiment = f.enqueue();
    const directory = await mkdtemp(join(tmpdir(), "hue-environment-files-corrupt-"));
    const store = join(directory, `experiment-${experiment.id}`);
    const caseDirectory = join(store, "files", `world-case-${f.frozenCase.id}`);
    const target: RunLocalAgentOptions["target"] = async (_inputs, _tools, context) => {
      const letter = join(context.outputDirectory, "Citacion.docx");
      await writeFile(letter, "carta de citación");
      return withFiles({ summary: "letter drafted" }, [
        { path: letter, filename: "Citacion.docx", contentType: docx, primary: true },
      ]);
    };
    try {
      await expect(worker(f, directory, { target })).rejects.toMatchObject({ status: 500 });
      expect(await readdir(caseDirectory)).toEqual(["outputs"]);
      // The saved `uploading` checkpoint no longer matches its digest: it can never be resumed.
      const checkpoint = join(store, `case-${f.frozenCase.id}.json`);
      const saved = JSON.parse(await readFile(checkpoint, "utf8")) as {
        value: { hasOutput: boolean };
      };
      saved.value.hasOutput = !saved.value.hasOutput;
      await writeFile(checkpoint, JSON.stringify(saved));
      await expect(worker(f, directory, { target })).rejects.toThrow(
        "Checkpoint integrity check failed",
      );
    } finally {
      f.stop();
    }
    expect(existsSync(caseDirectory)).toBe(false);
  }, 30_000);

  test("a file whose bytes do not match the manifest fails the case before an execution or world exists", async () => {
    const f = platform({ tamper: "source" });
    const experiment = f.enqueue();
    const directory = await mkdtemp(join(tmpdir(), "hue-environment-files-mismatch-"));
    let targets = 0;
    try {
      const outcome = worker(f, directory, {
        target() {
          targets++;
          return "unexpected";
        },
      });
      await expect(outcome).rejects.toMatchObject({
        name: "CaseFileError",
        code: "case_file_mismatch",
        artifactId: f.source.id,
      });
      await expect(outcome).rejects.toThrow(/does not match its pinned size and SHA-256/);
    } finally {
      f.stop();
    }
    expect(f.calls.downloads).toEqual([f.source.id]);
    expect(targets).toBe(0);
    expect(f.calls.starts).toBe(0);
    expect(f.calls.worldCreates).toBe(0);
    expect(f.calls.completions).toEqual([]);
    // Nothing unverified is left behind for the agent.
    expect(
      existsSync(
        join(directory, `experiment-${experiment.id}`, "files", `world-case-${f.frozenCase.id}`),
      ),
    ).toBe(false);
  }, 30_000);

  test("an evaluator-only file that does not match the manifest is refused before the execution too", async () => {
    const scorer = defineLocalScorer({
      source: "export default function unused() {}",
      entrypoint: "unused",
      metrics: [{ name: "unused", type: "boolean" }],
      score: () => ({ state: "scored", metrics: [{ name: "unused", value: true }] }),
    });
    const f = platform({ scorer, tamper: "answerKey" });
    f.enqueue();
    const directory = await mkdtemp(join(tmpdir(), "hue-environment-files-evaluator-"));
    let targets = 0;
    try {
      await expect(
        worker(f, directory, {
          scorers: [scorer],
          target() {
            targets++;
            return "unexpected";
          },
        }),
      ).rejects.toMatchObject({
        name: "CaseFileError",
        code: "case_file_mismatch",
        artifactId: f.answerKey.id,
      });
    } finally {
      f.stop();
    }
    expect(targets).toBe(0);
    expect(f.calls.starts).toBe(0);
    expect(f.calls.worldCreates).toBe(0);
    expect(await tree(directory)).not.toContainEqual(
      expect.objectContaining({ text: f.answerKey.bytes.toString() }),
    );
  }, 30_000);

  test("a traversal-like file name is refused before any download", async () => {
    const f = platform({ sourceName: "../../escape.pdf" });
    const directory = await mkdtemp(join(tmpdir(), "hue-environment-files-name-"));
    f.enqueue();
    let targets = 0;
    try {
      await expect(
        worker(f, directory, {
          target() {
            targets++;
            return "unexpected";
          },
        }),
      ).rejects.toMatchObject({
        name: "CaseFileError",
        code: "case_file_name_refused",
        artifactId: f.source.id,
      });
    } finally {
      f.stop();
    }
    expect(f.calls.downloads).toEqual([]);
    expect(targets).toBe(0);
    expect(f.calls.starts).toBe(0);
    expect(f.calls.worldCreates).toBe(0);
    expect(existsSync(join(tmpdir(), "escape.pdf"))).toBe(false);
  }, 30_000);

  test("file names are single, portable names", () => {
    for (const name of [
      "Informe de ausentismo.pdf",
      "résumé v2.docx",
      "..notes.txt",
      "CONFIG.json",
      "console.pdf",
      `${"é".repeat(98)}.pdf`,
    ])
      expect([name, isSafeFileName(name)]).toEqual([name, true]);
    for (const name of [
      "",
      ".",
      "..",
      "../escape.pdf",
      "a/b.pdf",
      "/etc/passwd",
      "..\\escape.pdf",
      "C:\\Windows\\win.ini",
      "CON",
      "nul.txt",
      "Com1.docx",
      "lpt¹.pdf",
      "aux .pdf",
      "trailing.",
      "trailing ",
      "tab\there.pdf",
      "nul\u0000byte.pdf",
      "c1\u0085control.pdf",
      "Report: Q3.pdf",
      "a<b>.pdf",
      'quote".pdf',
      "pipe|.pdf",
      "what?.pdf",
      "star*.pdf",
      `${"a".repeat(197)}.pdf`,
      `${"é".repeat(99)}.pdf`,
    ])
      expect([name, isSafeFileName(name)]).toEqual([name, false]);
  });

  test("environment-files:v1 is declared only with an environment target", () => {
    expect(localAgentCapabilities.environmentFiles).toBe("environment-files:v1");
    const agent = { key: "letter-agent", name: "Letter agent", revision: "1" };
    expect(() =>
      registeredCapabilities({
        agent: { ...agent, capabilities: ["environment-files:v1"] },
        directTarget: () => undefined,
      }),
    ).toThrow("environment-files:v1 requires a target callback");
    expect(
      registeredCapabilities({
        agent: { ...agent, capabilities: ["environment-files:v1", "input:pdf"] },
        target: () => undefined,
      }),
    ).toEqual(["environment-files:v1", "input:pdf", "environment:v1"]);
    // An existing registration keeps its capabilities: the SDK never adds this one itself.
    expect(registeredCapabilities({ agent, target: () => undefined })).toEqual(["environment:v1"]);
  });
});

function hue(
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string>;
    /** Sends SIGINT this many times, 150 ms apart, once this file exists: Ctrl+C, repeated. */
    interruptAfter?: { file: string; times: number };
  },
) {
  const { HUE_API_KEY: _key, HUE_BASE_URL: _origin, ...inherited } = process.env;
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [cli, "eval", ...args], {
        cwd: options.cwd,
        env: { ...inherited, NO_COLOR: "1", HUE_API_KEY: key, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      if (options.interruptAfter) {
        const { file, times } = options.interruptAfter;
        const waiting = setInterval(() => {
          if (!existsSync(file)) return;
          clearInterval(waiting);
          for (let index = 0; index < times; index++)
            setTimeout(() => child.kill("SIGINT"), 200 + index * 150);
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
    },
  );
}

/** A command agent: reads the case directory, writes the letter to output/ and reports what it saw. */
const commandSource = `import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HUE_CASE_DIR;
const walk = (path) => statSync(path).isDirectory() ? readdirSync(path).flatMap((name) => walk(join(path, name))) : [path];
const token = process.env.HUE_WORLD_TOKEN;
const inputs = JSON.parse(readFileSync(process.env.HUE_CASE_INPUTS, "utf8"));
const files = walk(join(dir, "files")).map((path) => path.slice(dir.length + 1));
const holdsToken = walk(dir).some((path) => path.includes(token) || readFileSync(path, "utf8").includes(token));
writeFileSync(join(process.env.HUE_CASE_OUTPUT_DIR, "Citacion.docx"), "carta para " + process.env.HUE_CASE_KEY);
writeFileSync(join(process.env.HUE_CASE_OUTPUT_DIR, "summary.txt"), "drafted from " + files.join(","));
writeFileSync(process.env.REPORT_FILE, JSON.stringify({
  dir,
  files,
  holdsToken,
  hasToken: typeof token === "string" && token.length > 0,
  task: inputs.task,
  report: readFileSync(join(dir, files[0]), "utf8"),
  mode: statSync(join(dir, files[0])).mode & 0o777,
}));
`;

/** An adapter: reads context.files and returns the letter with withFiles. */
const adapterSource = `import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withFiles } from ${JSON.stringify(evalsModule)};
export default async function (_inputs, context) {
  const [file] = context.files;
  const letter = join(context.outputDirectory, "Citacion.docx");
  writeFileSync(letter, "carta basada en " + readFileSync(file.path, "utf8"));
  writeFileSync(process.env.REPORT_FILE, JSON.stringify({
    files: context.files.map(({ role, filename }) => ({ role, filename })),
    path: file.path,
    outputDirectory: context.outputDirectory,
  }));
  return withFiles({ drafted: true }, [{ path: letter, filename: "Citacion.docx", contentType: ${JSON.stringify(docx)} }]);
}
`;

/** Swaps its output directory for a symlink to a host directory, then answers normally. */
const linkingSource = `import { rmSync, symlinkSync } from "node:fs";
rmSync(process.env.HUE_CASE_OUTPUT_DIR, { recursive: true });
symlinkSync(process.env.HOST_DIR, process.env.HUE_CASE_OUTPUT_DIR);
process.stdout.write("done");
`;

/** Never answers and ignores SIGTERM; records where its world files live. */
const stubbornSource = `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(process.env.MARKER + ".tmp", JSON.stringify({
  mcpConfig: process.env.HUE_MCP_CONFIG,
  caseDirectory: process.env.HUE_CASE_DIR,
  pid: process.pid,
}));
(await import("node:fs")).renameSync(process.env.MARKER + ".tmp", process.env.MARKER);
setInterval(() => {}, 1000);
`;

/** Every directory named `.lock` under `root`. */
async function locks(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (entry.name === ".lock") found.push(path);
    else found.push(...(await locks(path)));
  }
  return found;
}

describe("hue eval with a world case that carries files", () => {
  test("an output directory swapped for a symlink to a host directory fails the case and uploads nothing", async () => {
    const f = platform();
    const cwd = await mkdtemp(join(tmpdir(), "hue-eval-environment-files-link-"));
    const hostDirectory = join(cwd, "host");
    await mkdir(hostDirectory);
    await writeFile(join(hostDirectory, "secret.txt"), "host secret: never uploaded");
    await writeFile(join(hostDirectory, "summary.txt"), "host secret: never uploaded");
    await writeFile(join(cwd, "agent.mjs"), linkingSource);
    try {
      const run = await hue(
        [
          "--dataset-version",
          f.version.id,
          "--scorer-version",
          f.worldOutcome.id,
          "--command",
          `${process.execPath} ${join(cwd, "agent.mjs")}`,
          "--content",
          "--json",
          "--wait",
          "20",
        ],
        { cwd, env: { HUE_BASE_URL: f.baseUrl, HOST_DIR: hostDirectory } },
      );
      expect(run.status).toBe(1);
      const completion = f.calls.completions[0]!;
      expect(completion).toMatchObject({
        state: "error",
        error: { type: "TargetError", message: expect.stringContaining("is not a directory") },
      });
      expect(completion.artifactIds).toBeUndefined();
      expect(JSON.stringify(completion)).not.toContain("host secret");
      for (const stored of f.artifacts.values())
        expect(Buffer.from(stored.bytes ?? []).toString()).not.toContain("host secret");
      // Removing the case directory removed the link, never what it pointed at.
      expect(await readdir(hostDirectory)).toEqual(["secret.txt", "summary.txt"]);
    } finally {
      f.stop();
    }
  }, 60_000);

  test("a forced exit removes the world case's files, its MCP configuration and the locks", async () => {
    const f = platform();
    const cwd = await mkdtemp(join(tmpdir(), "hue-eval-environment-files-exit-"));
    await writeFile(join(cwd, "agent.mjs"), stubbornSource);
    const marker = join(cwd, "started.json");
    try {
      const run = await hue(
        [
          "--dataset-version",
          f.version.id,
          "--scorer-version",
          f.worldOutcome.id,
          "--command",
          `${process.execPath} ${join(cwd, "agent.mjs")}`,
          "--wait",
          "5",
        ],
        {
          cwd,
          env: { HUE_BASE_URL: f.baseUrl, MARKER: marker },
          interruptAfter: { file: marker, times: 2 },
        },
      );
      expect(run.status).toBe(130);
      const seen = JSON.parse(await readFile(marker, "utf8")) as {
        mcpConfig: string;
        caseDirectory: string;
        pid: number;
      };
      expect(existsSync(seen.mcpConfig)).toBe(false);
      expect(existsSync(dirname(dirname(seen.mcpConfig)))).toBe(false);
      // <world case>/work/case: the whole world case directory is gone.
      expect(existsSync(dirname(dirname(seen.caseDirectory)))).toBe(false);
      expect(await locks(join(cwd, ".hue", "eval"))).toEqual([]);
    } finally {
      f.stop();
    }
  }, 60_000);

  test("--command gets the case directory beside the world, and its output/ is uploaded", async () => {
    const f = platform();
    const cwd = await mkdtemp(join(tmpdir(), "hue-eval-environment-files-"));
    await writeFile(join(cwd, "agent.mjs"), commandSource);
    const reportFile = join(cwd, "report.json");
    try {
      const run = await hue(
        [
          "--dataset-version",
          f.version.id,
          "--scorer-version",
          f.worldOutcome.id,
          "--command",
          `${process.execPath} ${join(cwd, "agent.mjs")}`,
          "--content",
          "--json",
          "--wait",
          "20",
        ],
        { cwd, env: { HUE_BASE_URL: f.baseUrl, REPORT_FILE: reportFile } },
      );
      expect(run.stderr).not.toContain("Error");
      expect(run.status).toBe(0);
      for (const text of [run.stdout, run.stderr]) {
        expect(text).not.toContain(worldToken);
        expect(text).not.toContain(key);
      }
      const report = JSON.parse(await readFile(reportFile, "utf8")) as Record<string, unknown>;
      expect(report).toMatchObject({
        files: [`files/source/${f.source.name}`],
        holdsToken: false,
        hasToken: true,
        task: "Draft the citation letter from the attached report",
        report: f.source.bytes.toString(),
        mode: 0o600,
      });
      const completion = f.calls.completions[0]!;
      expect(completion).toMatchObject({
        state: "succeeded",
        output: { summary: `drafted from files/source/${f.source.name}` },
      });
      const artifactIds = completion.artifactIds as string[];
      expect(artifactIds).toHaveLength(1);
      expect(completion.primaryArtifactId).toBe(artifactIds[0]);
      expect(Buffer.from(f.artifacts.get(artifactIds[0]!)!.bytes!).toString()).toBe(
        "carta para ausentismo-01",
      );
      // Only the agent-visible file was downloaded: Hue grades this run, not this machine.
      expect(f.calls.downloads).toEqual([f.source.id]);
      expect(existsSync(String(report.dir))).toBe(false);
    } finally {
      f.stop();
    }
  }, 60_000);

  test("--worker registers --capability values and an adapter returns files with withFiles", async () => {
    const f = platform();
    f.enqueueGraded();
    const cwd = await mkdtemp(join(tmpdir(), "hue-eval-environment-files-worker-"));
    await writeFile(join(cwd, "letter-agent.mjs"), adapterSource);
    const reportFile = join(cwd, "report.json");
    try {
      const refused = await hue(
        [
          "--dataset-version",
          f.version.id,
          "--scorer-version",
          f.worldOutcome.id,
          "./letter-agent.mjs",
          "--capability",
          "input:pdf",
        ],
        { cwd, env: { HUE_BASE_URL: f.baseUrl } },
      );
      expect(refused.status).toBe(2);
      expect(refused.stderr).toContain("--capability applies to --worker only");
      const run = await hue(
        [
          "--worker",
          "./letter-agent.mjs",
          "--capability",
          "environment-files:v1",
          "--capability",
          "input:pdf",
          "--max-runs",
          "1",
          "--revision",
          "letters-1",
          "--wait",
          "20",
        ],
        { cwd, env: { HUE_BASE_URL: f.baseUrl, REPORT_FILE: reportFile } },
      );
      expect(run.stderr).not.toContain("Error");
      expect(run.status).toBe(0);
      expect(f.calls.registrations[0]!.capabilities).toEqual([
        "environment:v1",
        "environment-files:v1",
        "input:pdf",
      ]);
      const report = JSON.parse(await readFile(reportFile, "utf8")) as {
        files: unknown;
        path: string;
        outputDirectory: string;
      };
      expect(report.files).toEqual([{ role: "source", filename: f.source.name }]);
      const artifactIds = f.calls.completions[0]!.artifactIds as string[];
      expect(artifactIds).toHaveLength(1);
      expect(Buffer.from(f.artifacts.get(artifactIds[0]!)!.bytes!).toString()).toBe(
        `carta basada en ${f.source.bytes.toString()}`,
      );
      expect(existsSync(dirname(report.path))).toBe(false);
      expect(existsSync(report.outputDirectory)).toBe(false);
    } finally {
      f.stop();
    }
  }, 60_000);
});
