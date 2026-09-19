import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHue } from "../src/index.js";
import { createEnvironmentClient } from "../src/environment.js";
import {
  createEvaluationClient,
  runLocalAgent,
  TargetOutcomeUncertainError,
  UncertainExecutionError,
  type Completion,
  type EnvironmentEvidence,
  type Execution,
  type Experiment,
  type ExperimentCase,
} from "../src/evals.js";

const key = "synthetic-local-worker-key";
const digest = "d".repeat(64);

/** Synthetic control plane for one launched simulation: the queue, one pinned case, one world. */
function fixture(options: {
  capabilityStatus: number;
  loseSealAcknowledgement?: boolean;
  failWorldRead?: boolean;
  failCompletionOnce?: boolean;
  caseCount?: number;
  completionFailures?: number;
}) {
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
    config: { settings: { temperature: 0 } },
    configDigest: digest,
    evaluation: {
      id: randomUUID(),
      name: "default",
      scorerVersions: [],
      itemCount: items.length,
      scores: { scored: 0, error: 0, skipped: 0, pending: 0 },
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
    { executionId: string; status: "open" | "completed" | "abandoned" }
  >();
  const calls = {
    capability: 0,
    worldReads: 0,
    finishes: [] as { runId: string; idempotencyKey: string; status: string }[],
    completions: [] as { executionId: string; state: string; errorType?: string }[],
    localRun: [] as { state: string; failureType?: string }[],
    experimentFinished: 0,
  };
  let queueState: "queued" | "claimed" | "completed" | "attention" = "queued";
  let claimedWorkerId: string | undefined;
  let completionFailures = options.completionFailures ?? (options.failCompletionOnce ? 1 : 0);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
      const url = new URL(request.url);
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
        queueState = body.state as "completed" | "attention";
        calls.localRun.push({
          state: String(body.state),
          ...(body.failureType ? { failureType: String(body.failureType) } : {}),
        });
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
        worlds.set(id, { executionId: String(body.executionId), status: "open" });
        return Response.json({
          id,
          environmentVersionId,
          clockNs: "0",
          stateDigest: digest,
          maxSteps: 50,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          actions: [],
        });
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
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          createdAt: new Date().toISOString(),
          sealedAt: world.status === "open" ? null : new Date().toISOString(),
          stateDigest: digest,
          finalState: { collections: {} },
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
    reclaim: () => {
      queueState = "queued";
    },
    queueState: () => queueState,
  };
}

describe("local agent worker", () => {
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
        client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl }),
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
    expect(f.calls.finishes[0]!.idempotencyKey).toMatch(/^execution:[0-9a-f-]{36}:abandon$/);
    expect(f.calls.completions).toHaveLength(1);
    expect(f.calls.completions[0]).toMatchObject({ state: "error", errorType: "TargetError" });
    expect(f.calls.experimentFinished).toBe(1);
    expect(f.calls.localRun).toEqual([{ state: "completed" }]);
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
          "executionId",
          "item",
          "mcp",
          "trace",
        ]);
        expect(context.item).toEqual({ id: f.item.id, externalKey: "pinned" });
        expect(Object.keys(context.mcp).sort()).toEqual(["expiresAt", "token", "url"]);
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
      expect(f.calls.worldReads).toBe(1);
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
      await expect(runLocalAgent(options)).rejects.toBeInstanceOf(TargetOutcomeUncertainError);
      expect(targets).toBe(1);
      expect(f.calls.worldReads).toBe(1);
      expect(f.calls.finishes.map((finish) => finish.status)).toEqual([
        targetError ? "abandoned" : "completed",
      ]);
      expect(f.calls.completions).toEqual([]);
      expect(f.calls.experimentFinished).toBe(0);
      expect(f.calls.localRun).toEqual([
        { state: "attention", failureType: "TargetOutcomeUncertainError" },
      ]);
      f.reclaim();
      await expect(runLocalAgent(options)).rejects.toBeInstanceOf(UncertainExecutionError);
      expect(targets).toBe(1);
      expect(f.calls.finishes).toHaveLength(1);
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

test("a failed completion upload retains the worker claim and resumes without rerunning the candidate", async () => {
  const f = fixture({ capabilityStatus: 200, failCompletionOnce: true });
  const hue = createHue({
    apiKey: key,
    baseUrl: f.baseUrl,
    serviceName: "upload-recovery",
    captureContent: false,
  });
  const checkpointDirectory = await mkdtemp(join(tmpdir(), "hue-worker-upload-"));
  let targets = 0;
  const options = {
    client: createEvaluationClient({ apiKey: key, baseUrl: f.baseUrl }),
    environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: f.baseUrl }),
    hue,
    checkpointDirectory,
    agent: { key: "reference", name: "Reference", revision: "1" },
    maxRuns: 1,
    target() {
      targets++;
      return "reply saved";
    },
  };
  try {
    await expect(runLocalAgent(options)).rejects.toMatchObject({ status: 503 });
    expect(targets).toBe(1);
    expect(f.calls.finishes.map((finish) => finish.status)).toEqual(["completed"]);
    expect(f.calls.completions).toEqual([]);
    expect(f.calls.localRun).toEqual([]);
    expect(f.queueState()).toBe("claimed");
    // The queue returns the same claim to the durable worker identity on process restart.
    // No operator reset or synthetic requeue is needed for a recoverable upload failure.
    await runLocalAgent(options);
    expect(targets).toBe(1);
    expect(f.calls.finishes).toHaveLength(1);
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
      concurrency: 2,
      maxRuns: 1,
      target() {
        targets++;
        return "reply saved";
      },
    };
    try {
      const failureResult = await runLocalAgent(options).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failureResult).toBeInstanceOf(AggregateError);
      expect((failureResult as AggregateError).errors).toHaveLength(2);
      expect(targets).toBe(2);
      expect(f.calls.completions).toEqual([]);
      if (failure === "uncertain") {
        expect(
          (failureResult as AggregateError).errors.every(
            (error: unknown) => error instanceof TargetOutcomeUncertainError,
          ),
        ).toBe(true);
        expect(f.queueState()).toBe("attention");
        expect(f.calls.localRun).toEqual([{ state: "attention", failureType: "AggregateError" }]);
        f.reclaim();
        await expect(runLocalAgent(options)).rejects.toBeInstanceOf(AggregateError);
        expect(f.queueState()).toBe("attention");
        expect(f.calls.completions).toEqual([]);
      } else {
        expect(f.queueState()).toBe("claimed");
        expect(f.calls.localRun).toEqual([]);
        await runLocalAgent(options);
        expect(f.queueState()).toBe("completed");
        expect(f.calls.completions).toHaveLength(2);
        expect(f.calls.completions.every((completion) => completion.state === "succeeded")).toBe(
          true,
        );
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
  try {
    await expect(
      runLocalAgent({
        client,
        environmentClient: createEnvironmentClient({ apiKey: key, baseUrl: f.baseUrl }),
        hue,
        checkpointDirectory,
        agent: { key: "reference", name: "Reference", revision: "1" },
        maxRuns: 1,
        target() {
          targets++;
          return "reply saved";
        },
      }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(targets).toBe(1);
    expect(f.queueState()).toBe("attention");
    expect(f.calls.localRun).toEqual([{ state: "attention", failureType: "AggregateError" }]);
  } finally {
    await hue.shutdown();
    f.server.stop(true);
    await rm(checkpointDirectory, { recursive: true, force: true });
  }
});
