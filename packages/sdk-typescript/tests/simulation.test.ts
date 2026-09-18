import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import type { HueClient } from "../src/client.js";
import type { EnvironmentClient } from "../src/environment.js";
import {
  builtins,
  defineLocalScorer,
  HueApiError,
  runSimulation,
  TargetOutcomeUncertainError,
  UncertainExecutionError,
  type EvaluationClient,
  type JsonValue,
  type SimulationProgress,
} from "../src/evals.js";

const project = {
  id: randomUUID(),
  organizationId: randomUUID(),
  name: "Synthetic",
  slug: "synthetic",
};
const baseUrl = "https://app.hue.test";
const checksum = "a".repeat(64);
const scenario = {
  kind: "repository" as const,
  name: "Repository scenario",
  slug: "repository-scenario",
  environment: {
    name: "Repository world",
    slug: "repository-world",
    definition: {
      schemaVersion: 1 as const,
      state: { collections: { records: {} } },
      actions: [
        {
          name: "save",
          semantics: {
            entry: "hue.collection.create@1" as const,
            config: { collection: "records", set: { value: true } },
          },
        },
      ],
    },
  },
  cases: [{ externalKey: "one", inputs: { task: "save" }, expected: "saved" }],
  scorers: [{ name: "Exact", slug: "exact", scorer: builtins.exactMatch() }],
};

function harness(
  options: {
    uncertainSeal?: boolean;
    evidenceFailures?: number;
    runInspectionFailures?: number;
    loseCompletionAcknowledgement?: boolean;
    loseSealAcknowledgement?: boolean;
  } = {},
) {
  const datasets = new Map<string, any>();
  const scorers = new Map<string, any>();
  const environments = new Map<string, any>();
  const experiments = new Map<string, any>();
  const executions = new Map<string, any>();
  const worlds = new Map<string, any>();
  const completions = new Map<string, any>();
  const results: any[] = [];
  let targetCalls = 0;
  let loseCompletion = options.loseCompletionAcknowledgement ?? true;
  let loseSealAcknowledgement = options.loseSealAcknowledgement ?? true;
  let evidenceFailures = options.evidenceFailures ?? 1;
  let runInspectionFailures = options.runInspectionFailures ?? 0;
  const client = {
    baseUrl,
    checkConnection: async () => project,
    listDatasets: async () => ({ items: [], nextCursor: null }),
    createDataset: async (identity: any) => {
      const id = randomUUID();
      const draft = {
        id: randomUUID(),
        datasetId: id,
        version: 1,
        revision: 1,
        frozenAt: null,
        contentDigest: null,
      };
      const value = { id, ...identity, versions: [draft], cases: [] };
      datasets.set(id, value);
      return value;
    },
    getDataset: async (id: string) => datasets.get(id),
    createDatasetVersion: async (id: string) => {
      const dataset = datasets.get(id);
      const draft = {
        id: randomUUID(),
        datasetId: id,
        version: dataset.versions.length + 1,
        revision: 1,
        frozenAt: null,
        contentDigest: null,
      };
      dataset.versions.unshift(draft);
      dataset.cases = [];
      return draft;
    },
    listCases: async (id: string) => ({
      items: [...datasets.values()].find((value) => value.versions.some((v: any) => v.id === id))
        ?.cases,
      nextCursor: null,
    }),
    addCase: async (id: string, input: any) => {
      const dataset = [...datasets.values()].find((value) =>
        value.versions.some((v: any) => v.id === id),
      );
      const draft = dataset.versions.find((value: any) => value.id === id);
      const item = { id: randomUUID(), datasetVersionId: id, ...input };
      delete item.expectedRevision;
      dataset.cases.push(item);
      draft.revision++;
      return { item, version: draft };
    },
    getDatasetVersion: async (id: string) =>
      [...datasets.values()].flatMap((value) => value.versions).find((value) => value.id === id),
    freezeDatasetVersion: async (id: string) => {
      const version = await client.getDatasetVersion(id);
      version.frozenAt = new Date().toISOString();
      version.contentDigest = checksum;
      return version;
    },
    listScorers: async () => ({ items: [], nextCursor: null }),
    createScorer: async (identity: any) => {
      const value = { id: randomUUID(), ...identity, versions: [] };
      scorers.set(value.id, value);
      return value;
    },
    getScorer: async (id: string) => scorers.get(id),
    publishScorerVersion: async (id: string, definition: any) => {
      const version = { id: randomUUID(), contentDigest: checksum, definition };
      scorers.get(id).versions.push(version);
      return version;
    },
    createExperiment: async (input: any) => {
      const dataset = [...datasets.values()].find((value) =>
        value.versions.some((version: any) => version.id === input.datasetVersionId),
      );
      const scorerVersions = [...scorers.values()]
        .flatMap((value) => value.versions)
        .filter((value) => input.scorerVersionIds.includes(value.id));
      const id = randomUUID();
      const value = {
        id,
        name: input.name,
        datasetVersionId: input.datasetVersionId,
        config: input.config,
        configDigest: checksum,
        evaluation: {
          id: randomUUID(),
          name: "default",
          scorerVersions,
          itemCount: dataset.cases.length,
          scores: { scored: 0, error: 0, skipped: 0, pending: dataset.cases.length },
        },
        caseCount: dataset.cases.length,
        finishedAt: null,
        execution: {
          unstarted: dataset.cases.length,
          started: 0,
          uncertain: 0,
          succeeded: 0,
          error: 0,
          cancelled: 0,
        },
        cases: dataset.cases,
      };
      experiments.set(id, value);
      return { id, evaluationRunId: value.evaluation.id };
    },
    getExperiment: async (id: string) => experiments.get(id),
    listExperimentItems: async (id: string) => ({
      items: experiments.get(id).cases.map((item: any) => ({
        id: item.id,
        externalKey: item.externalKey,
        hasExpected: Object.hasOwn(item, "expected"),
        execution:
          [...executions.values()].find(
            (execution) => execution.experimentId === id && execution.caseId === item.id,
          ) ?? null,
      })),
      nextCursor: null,
    }),
    getExperimentCase: async (id: string, caseId: string) => {
      const item = experiments.get(id).cases.find((value: any) => value.id === caseId);
      return { ...item, hasExpected: Object.hasOwn(item, "expected") };
    },
    startExecution: async (experimentId: string, caseId: string, input: any) => {
      const execution = {
        id: randomUUID(),
        attempt: 1,
        state: "started",
        traceExternalId: input.traceExternalId,
        experimentId,
        caseId,
      };
      executions.set(execution.id, execution);
      return execution;
    },
    getExecution: async (id: string) => executions.get(id),
    getEnvironmentEvidence: async (executionId: string) => {
      if (evidenceFailures-- > 0) throw new HueApiError(503);
      const world = [...worlds.values()].find((value) => value.executionId === executionId);
      return {
        runId: world.id,
        executionId,
        environmentVersionId: world.environmentVersionId,
        definitionDigest: checksum,
        seed: "b".repeat(32),
        status: world.status,
        validity: world.validity,
        coverageGap: world.coverageGap,
        stepCount: world.steps.length,
        stateDigest: checksum,
        initialState: { collections: { records: {} } },
        finalState: { collections: { records: { saved: { value: true } } } },
      };
    },
    getEnvironmentSteps: async (executionId: string) => ({
      items: [...worlds.values()].find((value) => value.executionId === executionId).steps,
      nextCursor: null,
    }),
    completeExecution: async (id: string, input: any) => {
      const prior = completions.get(input.idempotencyKey);
      if (prior) return prior;
      const execution = executions.get(id);
      execution.state = input.state;
      const result = {
        executionId: id,
        subjectId: randomUUID(),
        traceSnapshotId: randomUUID(),
        evaluationItemId: randomUUID(),
      };
      completions.set(input.idempotencyKey, result);
      if (loseCompletion) {
        loseCompletion = false;
        throw new Error("lost completion acknowledgement");
      }
      return result;
    },
    submitResults: async (_runId: string, input: { results: any[] }) => {
      results.push(...input.results);
      return { ids: input.results.map(() => randomUUID()) };
    },
    finishExperiment: async (id: string) => {
      experiments.get(id).finishedAt = new Date().toISOString();
      return { id, finishedAt: experiments.get(id).finishedAt };
    },
    createSimulationMcpCapability: async (input: { runId: string }) => ({
      url: `${baseUrl}/api/v1/simulation-mcp/${input.runId}`,
      token: "attempt-scoped-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  } as unknown as EvaluationClient;
  const environmentClient = {
    baseUrl,
    listEnvironments: async () => ({ items: [], nextCursor: null }),
    createEnvironment: async (identity: any) => {
      const value = {
        id: randomUUID(),
        ...identity,
        description: identity.description ?? "",
        archivedAt: null,
        versions: [],
      };
      environments.set(value.id, value);
      return value;
    },
    getEnvironment: async (id: string) => environments.get(id),
    publishVersion: async (id: string) => {
      const version = {
        id: randomUUID(),
        version: 1,
        contentDigest: checksum,
        createdAt: new Date().toISOString(),
      };
      environments.get(id).versions.push(version);
      return version;
    },
    createRun: async (input: any) => {
      const world = {
        id: randomUUID(),
        environmentVersionId: input.environmentVersionId,
        executionId: input.executionId,
        status: "open",
        validity: "not_assessed",
        coverageGap: null,
        steps: [],
        actions: [
          {
            name: "save",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
              additionalProperties: false,
            },
          },
        ],
      };
      worlds.set(world.id, world);
      return {
        ...world,
        clockNs: "0",
        stateDigest: checksum,
        maxSteps: 500,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    act: async (runId: string, input: any) => {
      const world = worlds.get(runId);
      const step = {
        id: randomUUID(),
        ordinal: world.steps.length,
        invocationId: input.invocationId,
        action: input.action,
        args: input.args,
        observation: { status: "ok" },
        effects: [{ kind: "created", collection: "records", entityId: "saved", fields: ["value"] }],
        mutated: true,
        clockNs: "1",
        stateDigest: checksum,
      };
      world.steps.push(step);
      return {
        runId,
        stepOrdinal: step.ordinal,
        observation: step.observation,
        effects: step.effects,
        stateDigest: checksum,
        clockNs: "1",
        replayed: false,
        stepsRemaining: 499,
      };
    },
    recordCoverageGap: async (runId: string, input: any) => {
      const world = worlds.get(runId);
      const { idempotencyKey: _idempotencyKey, ...details } = input;
      world.validity = "environment_incomplete";
      world.coverageGap = {
        ...details,
        reportedAt: "2026-09-18T05:49:02.000Z",
        reportedBy: { kind: "project_key", id: randomUUID() },
      };
      return { runId, validity: world.validity, coverageGap: world.coverageGap };
    },
    finishRun: async (runId: string, input: any) => {
      if (options.uncertainSeal) throw new Error("world finalization unavailable");
      worlds.get(runId).status = input.status;
      const sealed = {
        id: runId,
        status: input.status,
        stepCount: worlds.get(runId).steps.length,
        stateDigest: checksum,
        sealedAt: new Date().toISOString(),
      };
      if (loseSealAcknowledgement) {
        loseSealAcknowledgement = false;
        throw new Error("lost seal acknowledgement");
      }
      return sealed;
    },
    getRun: async (runId: string) => {
      if (runInspectionFailures-- > 0) throw new Error("world inspection unavailable");
      return worlds.get(runId);
    },
  } as unknown as EnvironmentClient;
  const hue = {
    captureContent: false,
    transport: {
      options: { baseUrl },
      getFailureSequence: () => 0,
      getIssues: () => [],
      getReport: () => ({}),
    },
    checkConnection: async () => project,
    withSpan: async (_name: string, callback: any) =>
      callback({
        traceId: "1".repeat(32),
        spanId: "2".repeat(16),
        span: {},
        context: ROOT_CONTEXT,
        setOutput() {},
      }),
    recordError() {},
    flush: async () => ({}),
    tool: async (_name: string, _input: JsonValue, execute: () => unknown) => execute(),
  } as unknown as HueClient;
  return {
    client,
    environmentClient,
    hue,
    worlds,
    experiments,
    results,
    targetCalls: () => targetCalls,
    target: async (_inputs: JsonValue, context: any) => {
      targetCalls++;
      expect(context.mcp.token).toBe("attempt-scoped-token");
      await context.tools.save.execute({});
      return "saved";
    },
  };
}

describe("one-shot simulation workflow", () => {
  test("resolves a repository world larger than the default JSON value cap", async () => {
    const fixture = harness({
      evidenceFailures: 0,
      loseCompletionAcknowledgement: false,
      loseSealAcknowledgement: false,
    });
    const directory = await mkdtemp(join(tmpdir(), "hue-simulation-large-world-"));
    try {
      const report = await runSimulation({
        ...fixture,
        checkpointDirectory: directory,
        scenario: {
          ...scenario,
          environment: {
            ...scenario.environment,
            definition: {
              ...scenario.environment.definition,
              state: {
                collections: { records: { seed: { blob: "x".repeat(210_000) } } },
              },
            },
          },
        },
        persistResultContent: false,
        traceEvidence: { mode: "required" },
      });
      expect(report.experimentId).toBeTruthy();
      expect(fixture.worlds.size).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects invalid world limits before consuming a scenario case", async () => {
    const fixture = harness();
    const options = {
      ...fixture,
      checkpointDirectory: join(tmpdir(), "unused-hue-simulation-checkpoint"),
      scenario,
      persistResultContent: false,
      traceEvidence: { mode: "required" as const },
    };

    await expect(runSimulation({ ...options, maxSteps: 501 })).rejects.toThrow(
      "maxSteps must be 1–500",
    );
    await expect(runSimulation({ ...options, ttlSeconds: 86_401 })).rejects.toThrow(
      "ttlSeconds must be 1–86400",
    );
    expect(fixture.targetCalls()).toBe(0);
    expect(fixture.worlds.size).toBe(0);
    expect(fixture.experiments.size).toBe(0);
  });

  test("recovers an upload without rerunning the target and reruns in a fresh world", async () => {
    const fixture = harness();
    const directory = await mkdtemp(join(tmpdir(), "hue-simulation-"));
    const options = {
      ...fixture,
      checkpointDirectory: directory,
      scenario,
      persistResultContent: false,
      traceEvidence: { mode: "required" as const },
    };
    try {
      let firstError: unknown;
      try {
        await runSimulation(options);
      } catch (error) {
        firstError = error;
      }
      expect((firstError as Error).message).toContain("lost completion acknowledgement");
      const recovered = await runSimulation(options);
      expect(fixture.targetCalls()).toBe(1);
      expect(recovered.runUrl).toBe(`${baseUrl}/experiments/${recovered.experimentId}`);
      const repeated = await runSimulation(options);
      expect(fixture.targetCalls()).toBe(2);
      expect(repeated.experimentId).not.toBe(recovered.experimentId);
      const appAuthored = await runSimulation({
        ...options,
        checkpointDirectory: join(directory, "app-authored"),
        scenario: { kind: "experiment", experimentId: recovered.experimentId },
      });
      expect(fixture.targetCalls()).toBe(3);
      expect(appAuthored.experimentId).not.toBe(recovered.experimentId);
      expect(new Set([...fixture.worlds.values()].map((world) => world.id)).size).toBe(3);
      expect([...fixture.experiments.values()].every((item) => item.finishedAt)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("an unconfirmed world seal stays uncertain and never reruns the target", async () => {
    const fixture = harness({ uncertainSeal: true });
    const directory = await mkdtemp(join(tmpdir(), "hue-simulation-uncertain-"));
    const options = {
      ...fixture,
      checkpointDirectory: directory,
      scenario,
      persistResultContent: false,
      traceEvidence: { mode: "required" as const },
    };
    try {
      await expect(runSimulation(options)).rejects.toBeInstanceOf(TargetOutcomeUncertainError);
      expect(fixture.targetCalls()).toBe(1);
      await expect(runSimulation(options)).rejects.toBeInstanceOf(UncertainExecutionError);
      expect(fixture.targetCalls()).toBe(1);
      expect([...fixture.worlds.values()][0]?.status).toBe("open");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("publishes the run URL before target work and cancels without invoking the callback", async () => {
    const fixture = harness({
      evidenceFailures: 0,
      loseCompletionAcknowledgement: false,
      loseSealAcknowledgement: false,
    });
    const directory = await mkdtemp(join(tmpdir(), "hue-simulation-cancelled-"));
    const controller = new AbortController();
    const progress: SimulationProgress[] = [];
    controller.abort(new Error("stop requested"));
    try {
      const report = await runSimulation({
        ...fixture,
        checkpointDirectory: directory,
        scenario,
        persistResultContent: false,
        traceEvidence: { mode: "required" },
        signal: controller.signal,
        onProgress(event) {
          progress.push(event);
        },
      });
      expect(fixture.targetCalls()).toBe(0);
      expect(progress.map((event) => event.type)).toEqual([
        "run_created",
        "world_created",
        "world_sealed",
      ]);
      expect(progress[0]).toEqual({
        type: "run_created",
        experimentId: report.experimentId,
        runUrl: report.runUrl,
      });
      expect([...fixture.worlds.values()][0]?.status).toBe("abandoned");
      const [item] = (await fixture.client.listExperimentItems(report.experimentId)).items;
      expect(item?.execution?.state).toBe("cancelled");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a durably reported provider gap is inconclusive, not a target or scorer verdict", async () => {
    let scorerCalls = 0;
    let callbackCalls = 0;
    const scorer = defineLocalScorer({
      source: "must-not-score-an-incomplete-world",
      entrypoint: "score",
      metrics: [{ name: "quality", type: "boolean" }],
      score() {
        scorerCalls++;
        throw new Error("must not run");
      },
    });
    const fixture = harness({
      evidenceFailures: 0,
      loseCompletionAcknowledgement: false,
      loseSealAcknowledgement: false,
    });
    const directory = await mkdtemp(join(tmpdir(), "hue-simulation-incomplete-"));
    try {
      const report = await runSimulation({
        ...fixture,
        checkpointDirectory: directory,
        scenario: {
          ...scenario,
          scorers: [{ name: "Quality", slug: "quality", scorer }],
        },
        persistResultContent: false,
        traceEvidence: { mode: "required" },
        target: async (_inputs, context) => {
          callbackCalls++;
          await fixture.environmentClient.recordCoverageGap(context.environmentRunId, {
            idempotencyKey: randomUUID(),
            provider: "google.gmail.mcp",
            operation: "create_draft",
            code: "standalone_draft_unsupported",
            args: { to: ["synthetic-recipient@example.test"] },
            description: "Standalone new-message drafts are not implemented.",
          });
          const error = new Error("The simulated provider does not support this operation");
          error.name = "EnvironmentIncompleteError";
          throw error;
        },
      });
      expect(callbackCalls).toBe(1);
      expect(scorerCalls).toBe(0);
      expect(fixture.results).toEqual([
        expect.objectContaining({
          state: "skipped",
          metrics: [],
          explanation: "Environment incomplete: provider behavior is not implemented.",
        }),
      ]);
      const [item] = (await fixture.client.listExperimentItems(report.experimentId)).items;
      expect(item?.execution?.state).toBe("succeeded");
      expect([...fixture.worlds.values()][0]).toMatchObject({
        status: "completed",
        validity: "environment_incomplete",
        coverageGap: {
          provider: "google.gmail.mcp",
          operation: "create_draft",
          code: "standalone_draft_unsupported",
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("an unconfirmed provider gap stays uncertain and never replays the callback", async () => {
    const fixture = harness({
      evidenceFailures: 0,
      runInspectionFailures: 1,
      loseCompletionAcknowledgement: false,
      loseSealAcknowledgement: false,
    });
    const directory = await mkdtemp(join(tmpdir(), "hue-simulation-gap-uncertain-"));
    let callbackCalls = 0;
    const options = {
      ...fixture,
      checkpointDirectory: directory,
      scenario,
      persistResultContent: false,
      traceEvidence: { mode: "required" as const },
      target: async (_inputs: JsonValue, context: any) => {
        callbackCalls++;
        await fixture.environmentClient.recordCoverageGap(context.environmentRunId, {
          idempotencyKey: randomUUID(),
          provider: "google.gmail.mcp",
          operation: "create_draft",
          code: "standalone_draft_unsupported",
          args: {},
          description: "Standalone new-message drafts are not implemented.",
        });
        throw new Error("Environment incomplete");
      },
    };
    try {
      await expect(runSimulation(options)).rejects.toBeInstanceOf(TargetOutcomeUncertainError);
      expect(callbackCalls).toBe(1);
      await expect(runSimulation(options)).rejects.toBeInstanceOf(UncertainExecutionError);
      expect(callbackCalls).toBe(1);
      expect([...fixture.worlds.values()][0]?.status).toBe("open");
      expect(fixture.results).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
