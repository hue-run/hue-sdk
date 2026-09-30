import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHue } from "../src/index.js";
import { createEnvironmentClient } from "../src/environment.js";
import {
  actualAgentManifestV2,
  agentManifestDigestV2,
  attemptBaselineV2,
  attemptConnectionBundleV2,
  createEvaluationClient,
  defineLocalScorer,
  dependencyManifestV2,
  dependencyProviderV2,
  executionManifestDigestV2,
  runLocalAgent,
  TargetOutcomeUncertainError,
  UncertainExecutionError,
  type AttemptConnectionBundleV2,
  type Completion,
  type EnvironmentEvidence,
  type Execution,
  type Experiment,
  type ExperimentCase,
  type LocalAgentTargetContext,
  type LocalRunFailure,
  type LocalScorer,
  type RunLocalAgentOptions,
  type ScorerVersion,
} from "../src/evals.js";

const key = "synthetic-local-worker-key";
const digest = "d".repeat(64);
const componentKeys = ["agent", "prompt", "model", "tools", "approvals", "orchestration"] as const;

function canonicalDigest(value: unknown): string {
  function canonical(input: unknown): string {
    if (input === null || typeof input === "string" || typeof input === "boolean")
      return JSON.stringify(input);
    if (typeof input === "number" && Number.isSafeInteger(input)) return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
    if (typeof input === "object" && input !== null)
      return `{${Object.keys(input)
        .sort()
        .map(
          (key) => `${JSON.stringify(key)}:${canonical((input as Record<string, unknown>)[key])}`,
        )
        .join(",")}}`;
    throw new TypeError("Fixture digest input must be JSON");
  }
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function providerContract() {
  const fixtureDigest = (label: string) => canonicalDigest({ fixture: label });
  const catalogDigest = fixtureDigest("gmail-catalog");
  const actualManifest = actualAgentManifestV2.parse({
    schemaVersion: 2,
    components: Object.fromEntries(
      componentKeys.map((key) => [key, { digest: fixtureDigest(key), evidence: "observed" }]),
    ),
    catalogs: [
      {
        providerInstanceKey: "gmail-primary",
        surfaceKey: "google.gmail/mcp",
        digest: catalogDigest,
        evidence: "observed",
      },
    ],
    helperConfigurations: [],
  });
  const expectedAgentManifest = {
    schemaVersion: 2 as const,
    components: Object.fromEntries(
      componentKeys.map((key) => [
        key,
        { digest: actualManifest.components[key].digest!, minimumEvidence: "observed" as const },
      ]),
    ) as Record<(typeof componentKeys)[number], { digest: string; minimumEvidence: "observed" }>,
    catalogs: actualManifest.catalogs.map(({ evidence: _evidence, ...item }) => ({
      ...item,
      digest: item.digest!,
      minimumEvidence: "observed" as const,
    })),
    helperConfigurations: [],
  };
  const provider = dependencyProviderV2.parse({
    providerInstanceKey: "gmail-primary",
    providerId: "google.gmail",
    syntheticPrincipalId: randomUUID(),
    scopes: ["mail.read"],
    profile: {
      profileId: "test.gmail.v2",
      profileDigest: fixtureDigest("profile"),
      buildDigest: fixtureDigest("build"),
      coverageDigest: fixtureDigest("coverage"),
      contractDigests: [
        { surfaceKey: "google.gmail/mcp", contractDigest: fixtureDigest("mcp-contract") },
      ],
    },
    workflowDigest: fixtureDigest("workflow"),
    surfaces: [
      {
        surfaceRegistrationId: "test.gmail.mcp.v2",
        surfaceKey: "google.gmail/mcp",
        protocolVersion: "2025-06-18",
        contractDigest: fixtureDigest("mcp-contract"),
        catalogDigest,
        helperConfigurationDigest: null,
        runtimeRegistrationDigest: fixtureDigest("mcp-registration"),
      },
    ],
  });
  const dependencyManifest = dependencyManifestV2.parse({
    schemaVersion: 2,
    providers: [provider],
  });
  const baseline = attemptBaselineV2.parse({
    schemaVersion: 2,
    expectedAgentManifestId: randomUUID(),
    expectedAgentManifestDigest: agentManifestDigestV2(expectedAgentManifest),
    expectedAgentManifest,
    dependencyManifest,
  });
  return { actualManifest, baseline, dependencyManifest, provider };
}

async function checkpointContents(directory: string): Promise<string> {
  const values: string[] = [];
  async function visit(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else values.push(await readFile(child, "utf8"));
    }
  }
  await visit(directory);
  return values.join("\n");
}

type ProviderOutcome = "ready" | "environment_incomplete" | "lost_ack";

/** Synthetic control plane for one launched simulation: the queue, one pinned case, one world. */
function fixture(options: {
  capabilityStatus: number;
  loseSealAcknowledgement?: boolean;
  expireOnFinish?: boolean;
  failWorldRead?: boolean;
  failCompletionOnce?: boolean;
  caseCount?: number;
  completionFailures?: number;
  providerOutcome?: ProviderOutcome;
  scorer?: LocalScorer;
  /** Statuses the claim route answers before it claims: a queue's transient refusals. */
  claimStatuses?: number[];
  /** The lifetime of each world the fixture creates; ten minutes by default. */
  worldTtlMs?: number;
  /** Statuses the connection check answers before it answers the project. */
  connectionStatuses?: number[];
  /** The status the queue answers an attention completion with; 200 records it. */
  attentionStatus?: number;
  /** The status every execution completion answers; 200 completes it. */
  completionStatus?: number;
}) {
  const provider = options.providerOutcome ? providerContract() : undefined;
  const projectId = randomUUID();
  const datasetVersionId = randomUUID();
  const environmentVersionId = randomUUID();
  const agentId = randomUUID();
  const localRunId = randomUUID();
  const item: ExperimentCase = {
    id: randomUUID(),
    datasetVersionId,
    externalKey: "pinned",
    inputs: { task: "reply" },
    hasExpected: true,
    expected: { answer: "evaluator-private" },
    metadata: { provenance: "evaluator-private" },
    environmentVersionId,
  };
  const items = Array.from({ length: options.caseCount ?? 1 }, (_, index) =>
    index === 0
      ? item
      : { ...structuredClone(item), id: randomUUID(), externalKey: `pinned-${index}` },
  );
  const experiment: Experiment = {
    id: randomUUID(),
    name: "simulation",
    datasetVersionId,
    config: provider
      ? { settings: { temperature: 0 }, attemptBaselineV2: provider.baseline }
      : { settings: { temperature: 0 } },
    configDigest: digest,
    evaluation: {
      id: randomUUID(),
      name: "default",
      scorerVersions: options.scorer
        ? [{ id: randomUUID(), contentDigest: digest, definition: options.scorer.definition }]
        : [],
      itemCount: items.length,
      scores: {
        scored: 0,
        error: 0,
        skipped: 0,
        pending: options.scorer ? items.length : 0,
      },
    },
    caseCount: items.length,
    finishedAt: null,
    execution: {
      unstarted: items.length,
      started: 0,
      uncertain: 0,
      succeeded: 0,
      error: 0,
      cancelled: 0,
    },
  };
  const executions = new Map<string, Execution>();
  const worlds = new Map<
    string,
    {
      executionId: string;
      status: "open" | "completed" | "abandoned" | "expired";
      validity: "not_assessed" | "environment_incomplete";
      coverageGap: Record<string, unknown> | null;
    }
  >();
  const bearer = `hue_sim_${"s".repeat(40)}`;
  const expiresAt = new Date(Date.now() + 300_000).toISOString();
  const bindingId = randomUUID();
  const calls = {
    capability: 0,
    prepare: 0,
    bindingReads: 0,
    worldReads: 0,
    finishes: [] as { runId: string; idempotencyKey: string; status: string }[],
    completions: [] as { executionId: string; state: string; errorType?: string }[],
    localRun: [] as { state: string; failureType?: string }[],
    experimentFinished: 0,
    results: [] as Array<Record<string, unknown>>,
  };
  let queueState: "queued" | "claimed" | "completed" | "attention" = "queued";
  let claimedWorkerId: string | undefined;
  const claimStatuses = [...(options.claimStatuses ?? [])];
  const connectionStatuses = [...(options.connectionStatuses ?? [])];
  const worldTtlMs = options.worldTtlMs ?? 600_000;
  let claims = 0;
  let completionFailures = options.completionFailures ?? (options.failCompletionOnce ? 1 : 0);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
      const url = new URL(request.url);
      const path = url.pathname.replace("/api/v1", "");
      if (path === "/projects/current") {
        const refusal = connectionStatuses.shift();
        if (refusal !== undefined) return new Response(null, { status: refusal });
      }
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
      const body =
        request.method === "GET" ? {} : ((await request.json()) as Record<string, unknown>);
      if (path === "/local-agent-worker/register")
        return Response.json({
          id: agentId,
          ...body,
          enabled: true,
          lastSeenAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        });
      if (path === "/local-agent-worker/claim") {
        claims++;
        const refusal = claimStatuses.shift();
        if (refusal !== undefined) return new Response(null, { status: refusal });
        if (
          queueState === "completed" ||
          queueState === "attention" ||
          (queueState === "claimed" && claimedWorkerId !== body.workerId)
        )
          return Response.json(null);
        queueState = "claimed";
        claimedWorkerId = String(body.workerId);
        return Response.json({ runId: localRunId, experimentId: experiment.id });
      }
      if (path === "/local-agent-worker/runs/heartbeat")
        return Response.json({ runId: localRunId, active: true });
      if (path === "/local-agent-worker/runs/complete") {
        calls.localRun.push({
          state: String(body.state),
          ...(body.failureType ? { failureType: String(body.failureType) } : {}),
        });
        if (options.providerOutcome === "lost_ack" && body.state === "attention")
          return new Response(null, { status: 503 });
        if (body.state === "attention" && options.attentionStatus !== undefined)
          return new Response(null, { status: options.attentionStatus });
        queueState = body.state as "completed" | "attention";
        return Response.json({ runId: localRunId, state: body.state });
      }
      if (path === "/local-agent-worker/mcp-capability") {
        calls.capability++;
        if (options.capabilityStatus !== 200)
          return new Response(null, { status: options.capabilityStatus });
        return Response.json({
          url: `${url.origin}/api/v1/simulation-mcp/${String(body.runId)}`,
          token: "hue_sim_synthetic",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      if (path === `/dataset-versions/${datasetVersionId}`)
        return Response.json({
          id: datasetVersionId,
          datasetId: randomUUID(),
          version: 1,
          revision: 1,
          frozenAt: new Date().toISOString(),
          contentDigest: digest,
        });
      if (path === `/experiments/${experiment.id}`) return Response.json(experiment);
      if (path === `/experiments/${experiment.id}/items`)
        return Response.json({
          items: items.map((item) => ({
            id: item.id,
            externalKey: item.externalKey,
            hasExpected: item.hasExpected,
            execution: null,
          })),
          nextCursor: null,
        });
      const frozenCase = items.find(
        (item) => path === `/experiments/${experiment.id}/items/${item.id}`,
      );
      if (frozenCase) return Response.json(frozenCase);
      if (items.some((item) => path === `/experiments/${experiment.id}/items/${item.id}/start`)) {
        const execution: Execution = {
          id: randomUUID(),
          state: "started",
          attempt: 1,
          traceExternalId: String(body.traceExternalId),
        };
        executions.set(execution.id, execution);
        return Response.json(execution);
      }
      if (path === `/experiments/${experiment.id}/finish`) {
        calls.experimentFinished++;
        return Response.json({ id: experiment.id, finishedAt: new Date().toISOString() });
      }
      if (path === "/environment-runs") {
        const id = randomUUID();
        worlds.set(id, {
          executionId: String(body.executionId),
          status: "open",
          validity: "not_assessed",
          coverageGap: null,
        });
        return Response.json({
          id,
          environmentVersionId,
          clockNs: "0",
          stateDigest: digest,
          maxSteps: 50,
          expiresAt: new Date(Date.now() + worldTtlMs).toISOString(),
          actions: [],
        });
      }
      const prepareMatch = /^\/experiment-executions\/([^/]+)\/prepare-attempt$/.exec(path);
      if (prepareMatch) {
        calls.prepare++;
        if (!provider || !options.providerOutcome)
          return Response.json({ error: "No provider fixture" }, { status: 409 });
        if (options.providerOutcome === "lost_ack") return new Response(null, { status: 503 });
        const environmentRunId = String(body.environmentRunId);
        const world = worlds.get(environmentRunId);
        if (!world || world.executionId !== prepareMatch[1])
          return new Response(null, { status: 409 });
        if (options.providerOutcome === "environment_incomplete") {
          const gap = {
            provider: "hue.attempt",
            operation: "prepare_attempt",
            code: "attempt_preflight_incomplete",
            args: { findingCodes: ["evidence_missing"] },
            description: "Attempt preflight could not establish the required simulation parity.",
            reportedAt: new Date().toISOString(),
            reportedBy: { kind: "project_key", id: randomUUID() },
          };
          world.validity = "environment_incomplete";
          world.coverageGap = gap;
          return Response.json({
            status: "environment_incomplete",
            bindingId,
            preflightReport: {
              schemaVersion: 2,
              status: "environment_incomplete",
              evidenceSource: "caller_supplied",
              findings: [
                {
                  code: "evidence_missing",
                  component: "agent",
                  providerInstanceKey: null,
                  surfaceKey: null,
                  message: "Required parity evidence is missing.",
                },
              ],
            },
            gap,
          });
        }
        const actualManifest = actualAgentManifestV2.parse(body.actualManifest);
        const bundle: AttemptConnectionBundleV2 = attemptConnectionBundleV2.parse({
          schemaVersion: 2,
          bindingId,
          executionId: prepareMatch[1],
          environmentRunId,
          expiresAt,
          credentialGeneration: 0,
          providers: [
            {
              ...provider.provider,
              surfaces: provider.provider.surfaces.map((surface) => ({
                ...surface,
                endpoint: "https://simulation.invalid/gmail-mcp",
                bearer,
              })),
            },
          ],
          parity: {
            expectedAgentManifestId: provider.baseline.expectedAgentManifestId,
            expectedAgentManifestDigest: provider.baseline.expectedAgentManifestDigest,
            actualAgentManifestDigest: agentManifestDigestV2(actualManifest),
            actualManifest,
            dependencyManifestDigest: canonicalDigest(provider.dependencyManifest),
            executionManifestDigest: executionManifestDigestV2(
              actualManifest,
              provider.dependencyManifest,
              { bindingId, executionId: prepareMatch[1], environmentRunId },
            ),
            evidenceSource: "caller_supplied",
          },
        });
        return Response.json({
          status: "ready",
          preflightReport: {
            schemaVersion: 2,
            status: "ready",
            evidenceSource: "caller_supplied",
            findings: [],
          },
          bundle,
        });
      }
      if (path.startsWith("/attempt-bindings/")) {
        calls.bindingReads++;
        return new Response(null, { status: 500 });
      }
      const finishMatch = /^\/environment-runs\/([^/]+)\/finish$/.exec(path);
      if (finishMatch) {
        const world = worlds.get(finishMatch[1]!);
        if (!world) return new Response(null, { status: 404 });
        if (world.status !== "open") return new Response(null, { status: 409 });
        world.status = body.status as "completed" | "abandoned";
        calls.finishes.push({
          runId: finishMatch[1]!,
          idempotencyKey: String(body.idempotencyKey),
          status: world.status,
        });
        // An elapsed lease seals the world but conflicts with the requested finish.
        if (options.expireOnFinish) {
          world.status = "expired";
          return new Response(null, { status: 409 });
        }
        // Model an upstream/gateway response failure after the seal was committed.
        if (options.loseSealAcknowledgement) return new Response(null, { status: 503 });
        return Response.json({
          id: finishMatch[1],
          status: world.status,
          stepCount: 0,
          stateDigest: digest,
          sealedAt: new Date().toISOString(),
        });
      }
      const worldMatch = /^\/environment-runs\/([^/]+)$/.exec(path);
      if (worldMatch && request.method === "GET") {
        calls.worldReads++;
        if (options.failWorldRead) return new Response(null, { status: 503 });
        const world = worlds.get(worldMatch[1]!);
        if (!world) return new Response(null, { status: 404 });
        return Response.json({
          id: worldMatch[1],
          environmentVersionId,
          executionId: world.executionId,
          seed: "e".repeat(32),
          status: world.status,
          stepCount: 0,
          maxSteps: 50,
          clockNs: "0",
          expiresAt: new Date(Date.now() + worldTtlMs).toISOString(),
          createdAt: new Date().toISOString(),
          sealedAt: world.status === "open" ? null : new Date().toISOString(),
          stateDigest: digest,
          finalState: { collections: {} },
          validity: world.validity,
          coverageGap: world.coverageGap,
        });
      }
      const evidenceMatch = /^\/experiment-executions\/([^/]+)\/environment(\/steps)?$/.exec(path);
      if (evidenceMatch) {
        const linked = [...worlds.entries()].find(
          ([, world]) => world.executionId === evidenceMatch[1],
        );
        if (!linked) return new Response(null, { status: 404 });
        // The server refuses to disclose an open world; only sealed evidence is readable.
        if (linked[1].status === "open") return new Response(null, { status: 409 });
        if (evidenceMatch[2]) return Response.json({ items: [], nextCursor: null });
        const snapshot: Omit<EnvironmentEvidence, "steps"> = {
          validity: linked[1].validity,
          coverageGap: linked[1].coverageGap as EnvironmentEvidence["coverageGap"],
          runId: linked[0],
          executionId: evidenceMatch[1]!,
          environmentVersionId,
          definitionDigest: digest,
          seed: "e".repeat(32),
          status: linked[1].status,
          stepCount: 0,
          stateDigest: digest,
          initialState: { collections: {} },
          finalState: { collections: {} },
        };
        return Response.json(snapshot);
      }
      const executionMatch = /^\/experiment-executions\/([^/]+)(\/complete)?$/.exec(path);
      if (executionMatch) {
        const execution = executions.get(executionMatch[1]!);
        if (!execution) return new Response(null, { status: 404 });
        if (!executionMatch[2]) return Response.json(execution);
        if (completionFailures > 0) {
          completionFailures--;
          return new Response(null, { status: 503 });
        }
        if (options.completionStatus !== undefined)
          return new Response(null, { status: options.completionStatus });
        // Mirrors the server guard: completion refuses an open linked world.
        const linked = [...worlds.values()].find((world) => world.executionId === execution.id);
        if (linked?.status === "open") return new Response(null, { status: 409 });
        execution.state = body.state as Execution["state"];
        const error = body.error as { type?: string } | undefined;
        calls.completions.push({
          executionId: execution.id,
          state: execution.state,
          ...(error?.type ? { errorType: error.type } : {}),
        });
        return Response.json({
          executionId: execution.id,
          subjectId: randomUUID(),
          evaluationItemId: randomUUID(),
          traceSnapshotId: randomUUID(),
        } satisfies Completion);
      }
      if (path === `/evaluation-runs/${experiment.evaluation.id}/results`) {
        calls.results.push(body);
        return Response.json({ ids: [randomUUID()] });
      }
      throw new Error(`Unexpected request ${request.method} ${path}`);
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return {
    server,
    baseUrl,
    calls,
    worlds,
    experiment,
    item,
    provider,
    bearer,
    expiresAt,
    reclaim: () => {
      queueState = "queued";
    },
    queueState: () => queueState,
    claims: () => claims,
    items,
  };
}

describe("local agent worker", () => {
  test("rejects malformed claimed experiment ids before creating a run checkpoint", async () => {
    for (const id of ["", ".", "..", "../escape", null, 42]) {
      const f = fixture({ capabilityStatus: 500 });
      const directory = await mkdtemp(join(tmpdir(), "hue-worker-invalid-id-"));
      const hue = createHue({
        apiKey: key,
        baseUrl: f.baseUrl,
        serviceName: "invalid-claim",
        captureContent: false,
      });
      const client = createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl });
      const claim = client.claimLocalAgentRun.bind(client);
      client.claimLocalAgentRun = async (input) => ({
        ...(await claim(input))!,
        experimentId: id as string,
      });
      let targetCalls = 0;
      try {
        await expect(
          runLocalAgent({
            client,
            environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: f.baseUrl }),
            hue,
            checkpointDirectory: directory,
            agent: { key: "invalid-claim", name: "Invalid claim", revision: "v1" },
            maxRuns: 1,
            target() {
              targetCalls++;
              return {};
            },
          }),
        ).rejects.toThrow(/Refusing to use experiment id/);
        expect(targetCalls).toBe(0);
        expect((await readdir(directory)).sort()).toEqual(["manifest.json", "worker-id.json"]);
      } finally {
        await hue.shutdown();
        f.server.stop(true);
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  for (const providerOutcome of ["ready", "environment_incomplete"] as const) {
    test(`generic worker defers nonlocal scorer pins for ${providerOutcome} V2 work`, async () => {
      const f = fixture({ capabilityStatus: 500, providerOutcome });
      const pins = ["world_outcome", "future_hosted_kind"].map((kind) => ({
        id: randomUUID(),
        contentDigest: digest,
        definition: { kind, entry: "hue.conversion_outcome.v1", metrics: [] },
      })) as ScorerVersion[];
      f.experiment.evaluation.scorerVersions = pins;
      const directory = await mkdtemp(join(tmpdir(), "hue-generic-provider-"));
      const hue = createHue({
        apiKey: key,
        baseUrl: f.baseUrl,
        serviceName: "generic",
        captureContent: false,
      });
      let targetCalls = 0;
      let completed = false;
      try {
        await runLocalAgent({
          client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl }),
          environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: f.baseUrl }),
          hue,
          checkpointDirectory: directory,
          agent: { key: "generic", name: "Generic", revision: "v2" },
          scorers: [],
          actualAgentManifest: () => f.provider!.actualManifest,
          requestedProviders: [
            { providerInstanceKey: "gmail-primary", surfaceKeys: ["google.gmail/mcp"] },
          ],
          mcpSurface: { providerInstanceKey: "gmail-primary", surfaceKey: "google.gmail/mcp" },
          maxRuns: 1,
          target() {
            targetCalls++;
            return { drafted: true };
          },
          onCompleted(report) {
            completed = true;
            expect(report.deferredScorerVersionIds).toEqual(pins.map((pin) => pin.id));
            expect(report.resultIds).toEqual([]);
          },
        });
        expect(completed).toBe(true);
        expect(targetCalls).toBe(providerOutcome === "ready" ? 1 : 0);
        expect(f.calls.prepare).toBe(1);
        expect(f.calls.results).toEqual([]);
        expect([...f.worlds.values()].map((world) => world.status)).toEqual(["completed"]);
        expect(f.queueState()).toBe("completed");
        expect(await checkpointContents(directory)).not.toContain(f.bearer);
      } finally {
        await hue.shutdown();
        f.server.stop(true);
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  test("a failed MCP capability request still seals the world so the execution can complete", async () => {
    const f = fixture({ capabilityStatus: 503 });
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "local-worker-test",
      captureContent: false,
    });
    let targets = 0;
    try {
      await runLocalAgent({
        client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl, maxAttempts: 1 }),
        environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: f.baseUrl }),
        hue,
        checkpointDirectory: await mkdtemp(join(tmpdir(), "hue-local-worker-")),
        agent: { key: "reference", name: "Reference", revision: "1" },
        maxRuns: 1,
        target() {
          targets++;
          return undefined;
        },
      });
    } finally {
      await hue.shutdown();
      f.server.stop(true);
    }
    // The target never ran, the world was sealed as abandoned, and the linked execution
    // completed as an error instead of being refused forever with an open world.
    expect(targets).toBe(0);
    expect(f.calls.capability).toBe(1);
    expect([...f.worlds.values()].map((world) => world.status)).toEqual(["abandoned"]);
    expect(f.calls.finishes.map((finish) => finish.status)).toEqual(["abandoned"]);
    expect(f.calls.finishes[0]!.idempotencyKey).toMatch(/^execution:[0-9a-f-]{36}:abandoned$/);
    expect(f.calls.completions).toHaveLength(1);
    expect(f.calls.completions[0]).toMatchObject({ state: "error", errorType: "TargetError" });
    expect(f.calls.experimentFinished).toBe(1);
    expect(f.calls.localRun).toEqual([{ state: "completed" }]);
  });

  test("provider-ready work prepares once, skips the legacy grant and keeps credentials memory-only", async () => {
    let scorerCalls = 0;
    const scorer = defineLocalScorer({
      source: "export default function providerReady() {}",
      entrypoint: "providerReady",
      metrics: [{ name: "ready", type: "boolean" }],
      score() {
        scorerCalls++;
        return {
          state: "scored",
          metrics: [{ name: "ready", value: true, passed: true }],
          explanation: "The provider-backed target completed.",
        };
      },
    });
    const f = fixture({ capabilityStatus: 500, providerOutcome: "ready", scorer });
    if (!f.provider) throw new Error("Expected provider fixture");
    const directory = await mkdtemp(join(tmpdir(), "hue-local-provider-ready-"));
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "local-provider-ready-test",
      captureContent: false,
    });
    let targetCalls = 0;
    let manifestCalls = 0;
    let received: LocalAgentTargetContext | undefined;
    const priorMcpUrl = process.env.HUE_MCP_URL;
    try {
      await runLocalAgent({
        client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl }),
        environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: f.baseUrl }),
        hue,
        checkpointDirectory: directory,
        agent: { key: "provider-ready", name: "Provider ready", revision: "v2" },
        scorers: [scorer],
        actualAgentManifest(context) {
          manifestCalls++;
          expect(context.item).toEqual(f.item);
          expect(context.item.environmentVersionId).toBe(f.item.environmentVersionId);
          (context.item.metadata as { provenance: string }).provenance = "changed";
          const settings = (context.config as { settings: { temperature: number } }).settings;
          expect(settings.temperature).toBe(0);
          settings.temperature = 1;
          return f.provider!.actualManifest;
        },
        requestedProviders: [
          { providerInstanceKey: "gmail-primary", surfaceKeys: ["google.gmail/mcp"] },
        ],
        mcpSurface: { providerInstanceKey: "gmail-primary", surfaceKey: "google.gmail/mcp" },
        maxRuns: 1,
        target(_inputs, tools, context) {
          targetCalls++;
          expect(tools).toEqual({});
          expect(
            (context.config as { settings: { temperature: number } }).settings.temperature,
          ).toBe(0);
          received = context;
          return { drafted: true };
        },
      });
      expect(targetCalls).toBe(1);
      expect(manifestCalls).toBe(1);
      expect(scorerCalls).toBe(1);
      expect(f.calls.prepare).toBe(1);
      expect(f.calls.capability).toBe(0);
      expect(f.calls.bindingReads).toBe(0);
      expect(f.calls.results).toHaveLength(1);
      expect(f.calls.results[0]).toMatchObject({ results: [{ state: "scored" }] });
      expect([...f.worlds.values()].map((world) => world.status)).toEqual(["completed"]);
      expect(received?.item).toEqual({ id: f.item.id, externalKey: f.item.externalKey });
      expect(f.item.metadata).toEqual({ provenance: "evaluator-private" });
      expect(received?.environmentRunId).toBe(received?.connectionBundle?.environmentRunId);
      expect(received?.mcp).toEqual({
        url: "https://simulation.invalid/gmail-mcp",
        token: f.bearer,
        expiresAt: f.expiresAt,
      });
      expect(received?.connectionBundle?.parity.actualManifest).toEqual(f.provider.actualManifest);
      expect(process.env.HUE_MCP_URL).toBe(priorMcpUrl);
      const saved = await checkpointContents(directory);
      for (const secret of [
        f.bearer,
        "https://simulation.invalid/gmail-mcp",
        f.expiresAt,
        '"connectionBundle"',
        '"bearer"',
      ])
        expect(saved).not.toContain(secret);
    } finally {
      await hue.shutdown();
      f.server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("provider-incomplete work seals completed without invoking the target or local scorer", async () => {
    let scorerCalls = 0;
    const scorer = defineLocalScorer({
      source: "export default function mustNotRun() {}",
      entrypoint: "mustNotRun",
      metrics: [{ name: "unexpected", type: "boolean" }],
      score() {
        scorerCalls++;
        return { state: "scored", metrics: [{ name: "unexpected", value: true }] };
      },
    });
    const f = fixture({
      capabilityStatus: 500,
      providerOutcome: "environment_incomplete",
      scorer,
    });
    if (!f.provider) throw new Error("Expected provider fixture");
    const directory = await mkdtemp(join(tmpdir(), "hue-local-provider-incomplete-"));
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "local-provider-incomplete-test",
      captureContent: false,
    });
    let targetCalls = 0;
    try {
      await runLocalAgent({
        client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl }),
        environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: f.baseUrl }),
        hue,
        checkpointDirectory: directory,
        agent: { key: "provider-incomplete", name: "Provider incomplete", revision: "v2" },
        scorers: [scorer],
        actualAgentManifest: f.provider.actualManifest,
        requestedProviders: [
          { providerInstanceKey: "gmail-primary", surfaceKeys: ["google.gmail/mcp"] },
        ],
        mcpSurface: { providerInstanceKey: "gmail-primary", surfaceKey: "google.gmail/mcp" },
        maxRuns: 1,
        target() {
          targetCalls++;
          return { shouldNotExist: true };
        },
      });
      expect(targetCalls).toBe(0);
      expect(scorerCalls).toBe(0);
      expect(f.calls.prepare).toBe(1);
      expect(f.calls.capability).toBe(0);
      expect(f.calls.bindingReads).toBe(0);
      expect([...f.worlds.values()]).toEqual([
        expect.objectContaining({ status: "completed", validity: "environment_incomplete" }),
      ]);
      expect(f.calls.results).toHaveLength(1);
      expect(f.calls.results[0]).toMatchObject({
        results: [
          {
            state: "skipped",
            explanation: "Environment incomplete: provider behavior is not implemented.",
          },
        ],
      });
      expect(f.calls.localRun).toEqual([{ state: "completed" }]);
    } finally {
      await hue.shutdown();
      f.server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a lost prepare acknowledgement stays uncertain and never reacquires or replays", async () => {
    let scorerCalls = 0;
    const scorer = defineLocalScorer({
      source: "export default function uncertain() {}",
      entrypoint: "uncertain",
      metrics: [{ name: "unexpected", type: "boolean" }],
      score() {
        scorerCalls++;
        return { state: "scored", metrics: [{ name: "unexpected", value: true }] };
      },
    });
    const f = fixture({ capabilityStatus: 500, providerOutcome: "lost_ack", scorer });
    if (!f.provider) throw new Error("Expected provider fixture");
    const directory = await mkdtemp(join(tmpdir(), "hue-local-provider-uncertain-"));
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "local-provider-uncertain-test",
      captureContent: false,
    });
    let targetCalls = 0;
    const options: RunLocalAgentOptions = {
      // Single-attempt everywhere: the queue refuses to record attention for good here, and the
      // worker must stop with the uncertain error once it cannot record it, not loop.
      client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl, maxAttempts: 1 }),
      maxRunAttempts: 1,
      pollIntervalMillis: 250,
      environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: f.baseUrl }),
      hue,
      checkpointDirectory: directory,
      agent: { key: "provider-uncertain", name: "Provider uncertain", revision: "v2" },
      scorers: [scorer],
      actualAgentManifest: f.provider.actualManifest,
      requestedProviders: [
        { providerInstanceKey: "gmail-primary", surfaceKeys: ["google.gmail/mcp"] },
      ],
      mcpSurface: { providerInstanceKey: "gmail-primary", surfaceKey: "google.gmail/mcp" },
      maxRuns: 1,
      target() {
        targetCalls++;
        return { shouldNotExist: true };
      },
    };
    try {
      await expect(runLocalAgent(options)).rejects.toBeInstanceOf(TargetOutcomeUncertainError);
      await expect(runLocalAgent(options)).rejects.toBeInstanceOf(UncertainExecutionError);
      expect(targetCalls).toBe(0);
      expect(scorerCalls).toBe(0);
      expect(f.calls.prepare).toBe(1);
      expect(f.calls.capability).toBe(0);
      expect(f.calls.bindingReads).toBe(0);
      expect(f.calls.results).toHaveLength(0);
      expect([...f.worlds.values()].map((world) => world.status)).toEqual(["open"]);
      expect(f.calls.localRun).toEqual([
        { state: "attention", failureType: "TargetOutcomeUncertainError" },
        { state: "attention", failureType: "UncertainExecutionError" },
      ]);
      const saved = await checkpointContents(directory);
      expect(saved).not.toContain(f.bearer);
      expect(saved).not.toContain('"connectionBundle"');
    } finally {
      await hue.shutdown();
      f.server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("local candidates receive only cloned inputs, configuration, identities and scoped capability", async () => {
  const f = fixture({ capabilityStatus: 200 });
  const hue = createHue({
    apiKey: key,
    baseUrl: f.baseUrl,
    serviceName: "candidate-boundary",
    captureContent: false,
  });
  let targets = 0;
  try {
    await runLocalAgent({
      client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl }),
      environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: f.baseUrl }),
      hue,
      checkpointDirectory: await mkdtemp(join(tmpdir(), "hue-local-candidate-")),
      agent: { key: "reference", name: "Reference", revision: "1" },
      maxRuns: 1,
      target(inputs, tools, context) {
        targets++;
        expect(Object.keys(context).sort()).toEqual([
          "config",
          "environmentRunId",
          "executionId",
          "files",
          "item",
          "mcp",
          "outputDirectory",
          "signal",
          "trace",
        ]);
        expect(context.signal).toBeInstanceOf(AbortSignal);
        expect(context.files).toEqual([]);
        expect(context.item).toEqual({ id: f.item.id, externalKey: "pinned" });
        expect(Object.keys(context.mcp!).sort()).toEqual(["expiresAt", "token", "url"]);
        expect(Object.keys(context.trace).sort()).toEqual(["spanId", "traceId"]);
        expect(JSON.stringify(context)).not.toContain("evaluator-private");
        expect(tools).toEqual({});
        (inputs as { task: string }).task = "changed";
        (context.config as { settings: { temperature: number } }).settings.temperature = 1;
        return "reply saved";
      },
    });
    expect(targets).toBe(1);
    expect(f.item.inputs).toEqual({ task: "reply" });
    expect(f.experiment.config).toEqual({ settings: { temperature: 0 } });
    expect(f.calls.finishes.map((finish) => finish.status)).toEqual(["completed"]);
    expect(f.calls.localRun).toEqual([{ state: "completed" }]);
  } finally {
    await hue.shutdown();
    f.server.stop(true);
  }
});

test.each([false, true])(
  "a committed seal with a lost acknowledgement preserves the candidate outcome (target error: %s)",
  async (targetError) => {
    const f = fixture({ capabilityStatus: 200, loseSealAcknowledgement: true });
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "seal-recovery",
      captureContent: false,
    });
    const checkpointDirectory = await mkdtemp(join(tmpdir(), "hue-seal-recovery-"));
    let targets = 0;
    const options = {
      client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl }),
      environmentClient: createEnvironmentClient({
        apiKey: key,
        baseUrl: f.baseUrl,
        maxAttempts: 1,
      }),
      hue,
      checkpointDirectory,
      agent: { key: "reference", name: "Reference", revision: "1" },
      maxRuns: 1,
      target() {
        targets++;
        if (targetError) throw new Error("Synthetic candidate failure");
        return "reply saved";
      },
    };
    try {
      await runLocalAgent(options);
      expect(targets).toBe(1);
      expect(f.calls.worldReads).toBe(targetError ? 2 : 1);
      expect(f.calls.finishes.map((finish) => finish.status)).toEqual([
        targetError ? "abandoned" : "completed",
      ]);
      expect(f.calls.completions).toHaveLength(1);
      expect(f.calls.completions[0]).toMatchObject({ state: targetError ? "error" : "succeeded" });
      expect(f.calls.localRun).toEqual([{ state: "completed" }]);
      // Re-presenting the claimed run recovers its saved outcome without another callback or seal.
      f.reclaim();
      await runLocalAgent(options);
      expect(targets).toBe(1);
      expect(f.calls.finishes).toHaveLength(1);
      expect(f.calls.completions).toHaveLength(1);
    } finally {
      await hue.shutdown();
      f.server.stop(true);
      await rm(checkpointDirectory, { recursive: true, force: true });
    }
  },
);

test.each([false, true])(
  "an expired world completes local recovery without a completed-run verdict (target error: %s)",
  async (targetError) => {
    const scorer = defineLocalScorer({
      source: "synthetic-sealed-world-status-check",
      entrypoint: "score",
      metrics: [{ name: "completed_run", type: "boolean" }],
      score({ environment }) {
        expect(environment?.status).toBe("expired");
        return {
          state: "scored",
          metrics: [{ name: "completed_run", value: environment?.status === "completed" }],
          explanation: "Synthetic check of the authoritative sealed status.",
        };
      },
    });
    const f = fixture({ capabilityStatus: 200, expireOnFinish: true, scorer });
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "expired-world-recovery",
      captureContent: false,
    });
    const checkpointDirectory = await mkdtemp(join(tmpdir(), "hue-expired-world-recovery-"));
    let targets = 0;
    const options = {
      client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl }),
      environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: f.baseUrl }),
      hue,
      checkpointDirectory,
      agent: { key: "reference", name: "Reference", revision: "1" },
      scorers: [scorer],
      maxRuns: 1,
      target() {
        targets++;
        if (targetError) throw new Error("Synthetic candidate failure");
        return "reply saved";
      },
    };
    try {
      await runLocalAgent(options);
      expect(targets).toBe(1);
      expect([...f.worlds.values()].map((world) => world.status)).toEqual(["expired"]);
      expect(f.calls.finishes.map((finish) => finish.status)).toEqual([
        targetError ? "abandoned" : "completed",
      ]);
      expect(f.calls.completions).toEqual([
        expect.objectContaining(
          targetError ? { state: "error", errorType: "TargetError" } : { state: "succeeded" },
        ),
      ]);
      expect(f.calls.results).toEqual([
        expect.objectContaining({
          results: [
            expect.objectContaining({
              state: "scored",
              metrics: [{ name: "completed_run", value: false }],
            }),
          ],
        }),
      ]);
      expect(f.calls.experimentFinished).toBe(1);
      expect(f.calls.localRun).toEqual([{ state: "completed" }]);
      f.reclaim();
      await runLocalAgent(options);
      expect(targets).toBe(1);
      expect(f.calls.finishes).toHaveLength(1);
      expect(f.calls.completions).toHaveLength(1);
      expect(f.calls.results).toHaveLength(1);
    } finally {
      await hue.shutdown();
      f.server.stop(true);
      await rm(checkpointDirectory, { recursive: true, force: true });
    }
  },
);

test.each([false, true])(
  "an unresolved seal stays uncertain and resume never reinvokes the candidate (target error: %s)",
  async (targetError) => {
    const f = fixture({
      capabilityStatus: 200,
      loseSealAcknowledgement: true,
      failWorldRead: true,
    });
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "seal-uncertain",
      captureContent: false,
    });
    const checkpointDirectory = await mkdtemp(join(tmpdir(), "hue-seal-uncertain-"));
    let targets = 0;
    const failures: LocalRunFailure[] = [];
    const options = {
      client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl }),
      environmentClient: createEnvironmentClient({
        apiKey: key,
        baseUrl: f.baseUrl,
        maxAttempts: 1,
      }),
      hue,
      checkpointDirectory,
      agent: { key: "reference", name: "Reference", revision: "1" },
      maxRuns: 1,
      onRunFailed: (failure: LocalRunFailure) => {
        failures.push(failure);
      },
      target() {
        targets++;
        if (targetError) throw new Error("Synthetic candidate failure");
        return "reply saved";
      },
    };
    try {
      // The worker gives the uncertain outcome up as attention and keeps polling; it does not
      // die with the run.
      await runLocalAgent(options);
      expect(failures).toHaveLength(1);
      expect(failures[0]!.outcome).toBe("attention");
      expect(failures[0]!.error).toBeInstanceOf(TargetOutcomeUncertainError);
      expect(targets).toBe(1);
      expect(f.calls.worldReads).toBe(1);
      expect(f.calls.finishes.map((finish) => finish.status)).toEqual(
        targetError ? [] : ["completed"],
      );
      expect(f.calls.completions).toEqual([]);
      expect(f.calls.experimentFinished).toBe(0);
      expect(f.calls.localRun).toEqual([
        { state: "attention", failureType: "TargetOutcomeUncertainError" },
      ]);
      f.reclaim();
      await runLocalAgent(options);
      expect(failures).toHaveLength(2);
      expect(failures[1]!.error).toBeInstanceOf(UncertainExecutionError);
      expect(targets).toBe(1);
      expect(f.calls.finishes).toHaveLength(targetError ? 0 : 1);
      expect(f.calls.completions).toEqual([]);
      expect(f.calls.localRun[1]).toEqual({
        state: "attention",
        failureType: "UncertainExecutionError",
      });
    } finally {
      await hue.shutdown();
      f.server.stop(true);
      await rm(checkpointDirectory, { recursive: true, force: true });
    }
  },
);

test("a completion Hue refuses transiently is resumed by the same worker process without rerunning the candidate", async () => {
  // Single-attempt client: the 503 reaches the worker, whose claim is kept and whose next claim
  // resumes the saved outcome in the same process; the default client would absorb it.
  const f = fixture({ capabilityStatus: 200, failCompletionOnce: true });
  const hue = createHue({
    apiKey: key,
    baseUrl: f.baseUrl,
    serviceName: "upload-recovery",
    captureContent: false,
  });
  const checkpointDirectory = await mkdtemp(join(tmpdir(), "hue-worker-upload-"));
  let targets = 0;
  const failures: LocalRunFailure[] = [];
  const options = {
    client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl, maxAttempts: 1 }),
    environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: f.baseUrl }),
    hue,
    checkpointDirectory,
    agent: { key: "reference", name: "Reference", revision: "1" },
    maxRuns: 1,
    pollIntervalMillis: 250,
    onRunFailed: (failure: LocalRunFailure) => {
      failures.push(failure);
    },
    target() {
      targets++;
      return "reply saved";
    },
  };
  try {
    await runLocalAgent(options);
    expect(targets).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ outcome: "retry", attempt: 1, waitMillis: 500 });
    expect((failures[0]!.error as { status?: number }).status).toBe(503);
    expect(f.calls.finishes.map((finish) => finish.status)).toEqual(["completed"]);
    expect(f.calls.completions).toHaveLength(1);
    expect(f.calls.completions[0]).toMatchObject({ state: "succeeded" });
    expect(f.calls.localRun).toEqual([{ state: "completed" }]);
    expect(f.queueState()).toBe("completed");
  } finally {
    await hue.shutdown();
    f.server.stop(true);
    await rm(checkpointDirectory, { recursive: true, force: true });
  }
});

test.each(["uncertain", "operational"] as const)(
  "concurrent %s failures preserve the correct queue recovery state",
  async (failure) => {
    const f = fixture({
      capabilityStatus: 200,
      caseCount: 2,
      loseSealAcknowledgement: failure === "uncertain",
      failWorldRead: failure === "uncertain",
      completionFailures: failure === "operational" ? 2 : 0,
    });
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "concurrent-recovery",
      captureContent: false,
    });
    const checkpointDirectory = await mkdtemp(join(tmpdir(), "hue-concurrent-recovery-"));
    let targets = 0;
    const failures: LocalRunFailure[] = [];
    const options = {
      client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl, maxAttempts: 1 }),
      environmentClient: createEnvironmentClient({
        apiKey: key,
        baseUrl: f.baseUrl,
        maxAttempts: 1,
      }),
      hue,
      checkpointDirectory,
      agent: { key: "reference", name: "Reference", revision: "1" },
      concurrency: 2,
      maxRuns: 1,
      pollIntervalMillis: 250,
      onRunFailed: (entry: LocalRunFailure) => {
        failures.push(entry);
      },
      target() {
        targets++;
        return "reply saved";
      },
    };
    try {
      await runLocalAgent(options);
      expect(targets).toBe(2);
      if (failure === "uncertain") {
        // Both concurrent attempts are uncertain: the run is given up as attention at once, the
        // worker goes on, and a requeue finds the running checkpoints refusing to replay.
        expect(failures).toHaveLength(1);
        expect(failures[0]!.outcome).toBe("attention");
        expect(failures[0]!.error).toBeInstanceOf(AggregateError);
        expect(
          (failures[0]!.error as AggregateError).errors.every(
            (error: unknown) => error instanceof TargetOutcomeUncertainError,
          ),
        ).toBe(true);
        expect(f.calls.completions).toEqual([]);
        expect(f.queueState()).toBe("attention");
        expect(f.calls.localRun).toEqual([{ state: "attention", failureType: "AggregateError" }]);
        f.reclaim();
        await runLocalAgent(options);
        expect(failures).toHaveLength(2);
        expect(failures[1]!.outcome).toBe("attention");
        expect(f.queueState()).toBe("attention");
        expect(f.calls.completions).toEqual([]);
      } else {
        // Both completions failed operationally once: the claim was kept and the same process
        // resumed the saved outcomes without invoking the candidates again.
        expect(failures.map((entry) => entry.outcome)).toEqual(["retry"]);
        expect(f.queueState()).toBe("completed");
        expect(f.calls.completions).toHaveLength(2);
        expect(f.calls.completions.every((completion) => completion.state === "succeeded")).toBe(
          true,
        );
        expect(f.calls.localRun).toEqual([{ state: "completed" }]);
      }
      expect(targets).toBe(2);
      expect(f.calls.finishes).toHaveLength(2);
    } finally {
      await hue.shutdown();
      f.server.stop(true);
      await rm(checkpointDirectory, { recursive: true, force: true });
    }
  },
);

test("nested aggregate failures retain an unsafe-to-resume queue decision", async () => {
  const f = fixture({ capabilityStatus: 200 });
  const hue = createHue({
    apiKey: key,
    baseUrl: f.baseUrl,
    serviceName: "nested-recovery",
    captureContent: false,
  });
  const checkpointDirectory = await mkdtemp(join(tmpdir(), "hue-nested-recovery-"));
  const client = createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl });
  // A composed client can propagate an already aggregated failure into the runner.
  client.completeExecution = async (executionId) => {
    throw new AggregateError([new AggregateError([new TargetOutcomeUncertainError(executionId)])]);
  };
  let targets = 0;
  const failures: LocalRunFailure[] = [];
  try {
    await runLocalAgent({
      client,
      environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: f.baseUrl }),
      hue,
      checkpointDirectory,
      agent: { key: "reference", name: "Reference", revision: "1" },
      maxRuns: 1,
      onRunFailed: (failure) => {
        failures.push(failure);
      },
      target() {
        targets++;
        return "reply saved";
      },
    });
    expect(targets).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.outcome).toBe("attention");
    expect(failures[0]!.error).toBeInstanceOf(AggregateError);
    expect(f.queueState()).toBe("attention");
    expect(f.calls.localRun).toEqual([{ state: "attention", failureType: "AggregateError" }]);
  } finally {
    await hue.shutdown();
    f.server.stop(true);
    await rm(checkpointDirectory, { recursive: true, force: true });
  }
});

test("a transient claim refusal is absorbed by the client, and one past its attempts keeps the worker polling", async () => {
  const absorbed = fixture({ capabilityStatus: 200, claimStatuses: [502] });
  const hue = createHue({
    apiKey: key,
    baseUrl: absorbed.baseUrl,
    serviceName: "claim-retry",
    captureContent: false,
  });
  const pollErrors: unknown[] = [];
  try {
    await runLocalAgent({
      client: createEvaluationClient({ apiKey: key, baseUrl: absorbed.baseUrl }),
      environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: absorbed.baseUrl }),
      hue,
      checkpointDirectory: await mkdtemp(join(tmpdir(), "hue-claim-retry-")),
      agent: { key: "reference", name: "Reference", revision: "1" },
      maxRuns: 1,
      pollIntervalMillis: 250,
      onPollError: (error) => {
        pollErrors.push(error);
      },
      target: () => "reply",
    });
    expect(absorbed.claims()).toBe(2);
    expect(pollErrors).toEqual([]);
    expect(absorbed.queueState()).toBe("completed");
  } finally {
    await hue.shutdown();
    absorbed.server.stop(true);
  }
  // With a single-attempt client the refusal reaches the poll loop, which reports it, waits and
  // polls again instead of exiting the worker.
  const surfaced = fixture({ capabilityStatus: 200, claimStatuses: [502, 503] });
  const hue2 = createHue({
    apiKey: key,
    baseUrl: surfaced.baseUrl,
    serviceName: "claim-poll",
    captureContent: false,
  });
  try {
    await runLocalAgent({
      client: createEvaluationClient({ apiKey: key, baseUrl: surfaced.baseUrl, maxAttempts: 1 }),
      environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: surfaced.baseUrl }),
      hue: hue2,
      checkpointDirectory: await mkdtemp(join(tmpdir(), "hue-claim-poll-")),
      agent: { key: "reference", name: "Reference", revision: "1" },
      maxRuns: 1,
      pollIntervalMillis: 250,
      onPollError: (error) => {
        pollErrors.push(error);
      },
      target: () => "reply",
    });
    expect(surfaced.claims()).toBe(3);
    expect(pollErrors.map((error) => (error as { status?: number }).status)).toEqual([502, 503]);
    expect(surfaced.queueState()).toBe("completed");
  } finally {
    await hue2.shutdown();
    surfaced.server.stop(true);
  }
});

test("a case whose outcome cannot be saved does not block the case beside it, and the run is given up as attention", async () => {
  // Case one's output is unserializable, its own failure and unsafe to resume; case two beside
  // it still runs and completes, and the run is given up at once with the failure's name.
  const f = fixture({ capabilityStatus: 200, caseCount: 2 });
  const hue = createHue({
    apiKey: key,
    baseUrl: f.baseUrl,
    serviceName: "case-isolation",
    captureContent: false,
  });
  const failures: LocalRunFailure[] = [];
  const targets: string[] = [];
  try {
    await runLocalAgent({
      client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl }),
      environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: f.baseUrl }),
      hue,
      checkpointDirectory: await mkdtemp(join(tmpdir(), "hue-case-isolation-")),
      agent: { key: "reference", name: "Reference", revision: "1" },
      maxRuns: 1,
      pollIntervalMillis: 250,
      onRunFailed: (failure) => {
        failures.push(failure);
      },
      target(_inputs, _tools, context) {
        targets.push(context.item.externalKey);
        return context.item.externalKey === "pinned" ? NaN : "reply";
      },
    });
    expect(targets.sort()).toEqual([...f.items.map((entry) => entry.externalKey)].sort());
    expect(f.calls.completions).toEqual([expect.objectContaining({ state: "succeeded" })]);
    expect(failures.map((failure) => failure.outcome)).toEqual(["attention"]);
    expect(f.calls.localRun).toEqual([
      { state: "attention", failureType: "OutcomeSerializationError" },
    ]);
    expect(f.calls.experimentFinished).toBe(0);
  } finally {
    await hue.shutdown();
    f.server.stop(true);
  }
});

test("a target that hangs is stopped at its world's deadline, its case ends as a timeout and the world is sealed abandoned", async () => {
  const f = fixture({ capabilityStatus: 200, worldTtlMs: -4_000 });
  const hue = createHue({
    apiKey: key,
    baseUrl: f.baseUrl,
    serviceName: "world-deadline",
    captureContent: false,
  });
  const startedAt = performance.now();
  try {
    await runLocalAgent({
      client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl }),
      environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: f.baseUrl }),
      hue,
      checkpointDirectory: await mkdtemp(join(tmpdir(), "hue-world-deadline-")),
      agent: { key: "reference", name: "Reference", revision: "1" },
      maxRuns: 1,
      worldTtlSeconds: 1,
      target: (_inputs, _tools, context) =>
        new Promise((_, reject) => {
          // A candidate that listens stops; one that does not is left behind either way.
          context.signal?.addEventListener("abort", () =>
            reject(
              context.signal!.reason instanceof Error
                ? context.signal!.reason
                : new Error(String(context.signal!.reason)),
            ),
          );
        }),
    });
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(f.calls.completions).toEqual([
      expect.objectContaining({ state: "error", errorType: "TargetTimeout" }),
    ]);
    expect([...f.worlds.values()].map((world) => world.status)).toEqual(["abandoned"]);
    expect(f.calls.localRun).toEqual([{ state: "completed" }]);
    expect(f.calls.experimentFinished).toBe(1);
  } finally {
    await hue.shutdown();
    f.server.stop(true);
  }
});

test("a completion callback's own failure is thrown as itself, and a refusal to record attention Hue decided on is thrown rather than retried", async () => {
  // onCompleted throws after the queue completed the run: the error is the caller's, not a
  // retry the worker could make, and reaches it unchanged.
  const completed = fixture({ capabilityStatus: 200 });
  const hue = createHue({
    apiKey: key,
    baseUrl: completed.baseUrl,
    serviceName: "callback-failure",
    captureContent: false,
  });
  const failures: LocalRunFailure[] = [];
  try {
    await expect(
      runLocalAgent({
        client: createEvaluationClient({ apiKey: key, baseUrl: completed.baseUrl }),
        environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: completed.baseUrl }),
        hue,
        checkpointDirectory: await mkdtemp(join(tmpdir(), "hue-callback-failure-")),
        agent: { key: "reference", name: "Reference", revision: "1" },
        maxRuns: 1,
        onRunFailed: (failure) => {
          failures.push(failure);
        },
        onCompleted() {
          throw new Error("Synthetic reporting failure");
        },
        target: () => "reply",
      }),
    ).rejects.toThrow("Synthetic reporting failure");
    expect(failures).toEqual([]);
    expect(completed.queueState()).toBe("completed");
  } finally {
    await hue.shutdown();
    completed.server.stop(true);
  }
  // The queue refuses to record attention with a 403 (a revoked key): that refusal is what
  // needs fixing, so it is thrown as itself instead of the run being retried.
  const revoked = fixture({ capabilityStatus: 200, attentionStatus: 403 });
  const hue2 = createHue({
    apiKey: key,
    baseUrl: revoked.baseUrl,
    serviceName: "revoked-attention",
    captureContent: false,
  });
  try {
    await expect(
      runLocalAgent({
        client: createEvaluationClient({ apiKey: key, baseUrl: revoked.baseUrl }),
        environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: revoked.baseUrl }),
        hue: hue2,
        checkpointDirectory: await mkdtemp(join(tmpdir(), "hue-revoked-attention-")),
        agent: { key: "reference", name: "Reference", revision: "1" },
        maxRuns: 1,
        pollIntervalMillis: 250,
        target: () => NaN,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(revoked.calls.localRun).toEqual([
      { state: "attention", failureType: "OutcomeSerializationError" },
    ]);
  } finally {
    await hue2.shutdown();
    revoked.server.stop(true);
  }
});

test("a transient failure of the startup connection check is reported and polled through", async () => {
  const f = fixture({ capabilityStatus: 200, connectionStatuses: [502] });
  const hue = createHue({
    apiKey: key,
    baseUrl: f.baseUrl,
    serviceName: "startup-retry",
    captureContent: false,
  });
  const pollErrors: unknown[] = [];
  try {
    await runLocalAgent({
      client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl, maxAttempts: 1 }),
      environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: f.baseUrl }),
      hue,
      checkpointDirectory: await mkdtemp(join(tmpdir(), "hue-startup-retry-")),
      agent: { key: "reference", name: "Reference", revision: "1" },
      maxRuns: 1,
      pollIntervalMillis: 250,
      onPollError: (error) => {
        pollErrors.push(error);
      },
      target: () => "reply",
    });
    expect(pollErrors.map((error) => (error as { status?: number }).status)).toEqual([502]);
    expect(f.calls.localRun).toEqual([{ state: "completed" }]);
  } finally {
    await hue.shutdown();
    f.server.stop(true);
  }
});

test("a refusal that would recur is given up as attention at once instead of being retried", async () => {
  // Hue refuses the completion for good (409): no resume changes that, so the run is given up
  // on the first attempt with the refusal's name, and the worker goes on.
  const f = fixture({ capabilityStatus: 200, completionStatus: 409 });
  const hue = createHue({
    apiKey: key,
    baseUrl: f.baseUrl,
    serviceName: "recurring-refusal",
    captureContent: false,
  });
  const failures: LocalRunFailure[] = [];
  try {
    await runLocalAgent({
      client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl }),
      environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: f.baseUrl }),
      hue,
      checkpointDirectory: await mkdtemp(join(tmpdir(), "hue-recurring-refusal-")),
      agent: { key: "reference", name: "Reference", revision: "1" },
      maxRuns: 1,
      pollIntervalMillis: 250,
      onRunFailed: (failure) => {
        failures.push(failure);
      },
      target: () => "reply",
    });
    expect(failures.map((failure) => failure.outcome)).toEqual(["attention"]);
    expect((failures[0]!.error as { status?: number }).status).toBe(409);
    expect(f.calls.localRun).toEqual([{ state: "attention", failureType: "HueApiError" }]);
  } finally {
    await hue.shutdown();
    f.server.stop(true);
  }
});
