import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { HueClient } from "../client.js";
import type { EnvironmentClient } from "../environment/client.js";
import { bindEnvironmentTools, type EnvironmentTool } from "../environment/tools.js";
import type { EnvironmentDefinition, EnvironmentIdentity } from "../environment/types.js";
import type { EvaluationClient } from "./client.js";
import { CheckpointStore } from "./checkpoint.js";
import { digest, json } from "./json.js";
import {
  runExperiment,
  TargetCancelledError,
  TargetOutcomeUncertainError,
  type RunnerReport,
} from "./runner.js";
import type {
  CaseWrite,
  DatasetCase,
  ExperimentCase,
  Identity,
  JsonValue,
  LocalScorer,
  ScorerDefinition,
  SimulationMcpCapability,
} from "./types.js";

export interface RepositorySimulationScorer extends Identity {
  scorer: ScorerDefinition | LocalScorer;
}
export interface RepositorySimulationCase {
  externalKey: string;
  inputs: JsonValue;
  expected?: JsonValue;
  metadata?: Record<string, JsonValue>;
}
export type SimulationScenario =
  | { kind: "experiment"; experimentId: string }
  | {
      kind: "repository";
      name: string;
      slug: string;
      description?: string;
      environment: EnvironmentIdentity & { definition: EnvironmentDefinition };
      cases: RepositorySimulationCase[];
      scorers: RepositorySimulationScorer[];
      config?: JsonValue;
    };
export type SimulationProgress =
  | { type: "run_created"; experimentId: string; runUrl: string }
  | {
      type: "world_created" | "target_started" | "world_sealed";
      experimentId: string;
      executionId: string;
      caseId: string;
      environmentRunId: string;
    };
export interface SimulationTargetContext {
  config: JsonValue;
  item: ExperimentCase;
  executionId: string;
  tools: Record<string, EnvironmentTool>;
  mcp: SimulationMcpCapability;
  signal?: AbortSignal;
}
export interface RunSimulationOptions {
  client: EvaluationClient;
  environmentClient: EnvironmentClient;
  hue: HueClient;
  checkpointDirectory: string;
  scenario: SimulationScenario;
  persistResultContent: boolean;
  traceEvidence: { mode: "required" } | { mode: "omit"; reason: string };
  localScorers?: LocalScorer[];
  concurrency?: number;
  schemaTimeoutMillis?: number;
  maxSteps?: number;
  ttlSeconds?: number;
  signal?: AbortSignal;
  runName?: string;
  target(
    inputs: JsonValue,
    context: SimulationTargetContext,
  ): JsonValue | undefined | Promise<JsonValue | undefined>;
  onProgress?(event: SimulationProgress): void | Promise<void>;
}
export interface SimulationReport extends RunnerReport {
  experimentId: string;
  runUrl: string;
}
type Attempt = {
  scenarioDigest: string;
  idempotencyKey: string;
  stage: "preparing" | "running" | "completed";
  experimentId?: string;
  report?: SimulationReport;
};

const scorerDefinition = (entry: RepositorySimulationScorer) =>
  "definition" in entry.scorer ? entry.scorer.definition : entry.scorer;
function scenarioIdentity(scenario: SimulationScenario): JsonValue {
  if (scenario.kind === "experiment") return scenario;
  return json({
    kind: scenario.kind,
    name: scenario.name,
    slug: scenario.slug,
    description: scenario.description ?? "",
    environment: scenario.environment,
    cases: scenario.cases,
    scorers: scenario.scorers.map(({ scorer, ...identity }) => ({
      ...identity,
      definition: "definition" in scorer ? scorer.definition : scorer,
    })),
    config: scenario.config ?? {},
  });
}
async function findBySlug<T extends { id: string; slug: string }>(
  page: (after?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
  slug: string,
): Promise<T | undefined> {
  let after: string | undefined;
  for (;;) {
    const result = await page(after);
    const found = result.items.find((item) => item.slug === slug);
    if (found) return found;
    if (!result.nextCursor) return undefined;
    after = result.nextCursor;
  }
}
async function resolveEnvironment(
  client: EnvironmentClient,
  source: Extract<SimulationScenario, { kind: "repository" }>["environment"],
): Promise<string> {
  let identity = await findBySlug(
    (after) => client.listEnvironments({ after, limit: 100 }),
    source.slug,
  );
  if (!identity) {
    try {
      identity = await client.createEnvironment({
        name: source.name,
        slug: source.slug,
        ...(source.description === undefined ? {} : { description: source.description }),
      });
    } catch {
      identity = await findBySlug(
        (after) => client.listEnvironments({ after, limit: 100 }),
        source.slug,
      );
      if (!identity) throw new Error("Environment creation outcome is unavailable");
    }
  }
  if (identity.archivedAt) throw new Error("Repository scenario environment is archived");
  const definitionDigest = digest(source.definition);
  const existing = (await client.getEnvironment(identity.id)).versions.find(
    (version) => version.contentDigest === definitionDigest,
  );
  if (existing) return existing.id;
  try {
    return (await client.publishVersion(identity.id, source.definition)).id;
  } catch {
    const recovered = (await client.getEnvironment(identity.id)).versions.find(
      (version) => version.contentDigest === definitionDigest,
    );
    if (!recovered) throw new Error("Environment publication outcome is unavailable");
    return recovered.id;
  }
}
async function resolveScorers(
  client: EvaluationClient,
  sources: RepositorySimulationScorer[],
): Promise<{ versionIds: string[]; bindings: LocalScorer[] }> {
  if (!sources.length) throw new TypeError("Repository scenarios require at least one scorer");
  const versionIds: string[] = [];
  const bindings: LocalScorer[] = [];
  for (const source of sources) {
    const definition = scorerDefinition(source);
    let identity = await findBySlug(
      (after) => client.listScorers({ after, limit: 100 }),
      source.slug,
    );
    if (!identity) {
      try {
        identity = await client.createScorer({
          name: source.name,
          slug: source.slug,
          ...(source.description === undefined ? {} : { description: source.description }),
        });
      } catch {
        identity = await findBySlug(
          (after) => client.listScorers({ after, limit: 100 }),
          source.slug,
        );
        if (!identity) throw new Error("Scorer creation outcome is unavailable");
      }
    }
    const definitionDigest = digest(definition);
    let version = (await client.getScorer(identity.id)).versions?.find(
      (item) => item.contentDigest === definitionDigest,
    );
    if (!version) {
      try {
        version = await client.publishScorerVersion(identity.id, definition);
      } catch {
        version = (await client.getScorer(identity.id)).versions?.find(
          (item) => item.contentDigest === definitionDigest,
        );
        if (!version) throw new Error("Scorer publication outcome is unavailable");
      }
    }
    versionIds.push(version.id);
    if ("definition" in source.scorer) bindings.push(source.scorer);
  }
  return { versionIds, bindings };
}
const normalizedCase = (
  value: RepositorySimulationCase,
  environmentVersionId: string,
): Omit<CaseWrite, "expectedRevision"> => ({
  externalKey: value.externalKey,
  inputs: json(value.inputs),
  ...(Object.hasOwn(value, "expected") ? { expected: json(value.expected) } : {}),
  metadata: json(value.metadata ?? {}) as Record<string, JsonValue>,
  environmentVersionId,
});
const caseDigestValue = (value: Omit<CaseWrite, "expectedRevision"> | DatasetCase) => ({
  externalKey: value.externalKey,
  inputs: value.inputs,
  expected: Object.hasOwn(value, "expected") ? value.expected! : null,
  hasExpected: Object.hasOwn(value, "expected"),
  metadata: value.metadata ?? {},
  sourceTraceId: null,
  sourceTraceRevision: null,
  ...(value.environmentVersionId ? { environmentVersionId: value.environmentVersionId } : {}),
});
async function allCases(client: EvaluationClient, versionId: string): Promise<DatasetCase[]> {
  const items: DatasetCase[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await client.listCases(versionId, { after, limit: 100 });
    items.push(...page.items);
    if (!page.nextCursor) return items;
    after = page.nextCursor;
  }
}
async function resolveDataset(
  client: EvaluationClient,
  scenario: Extract<SimulationScenario, { kind: "repository" }>,
  environmentVersionId: string,
): Promise<string> {
  if (!scenario.cases.length) throw new TypeError("Repository scenarios require at least one case");
  const cases = scenario.cases.map((item) => normalizedCase(item, environmentVersionId));
  if (new Set(cases.map((item) => item.externalKey)).size !== cases.length)
    throw new TypeError("Repository scenario case keys must be unique");
  const ordered = [...cases].sort((a, b) =>
    Buffer.compare(Buffer.from(a.externalKey), Buffer.from(b.externalKey)),
  );
  const wantedDigest = digest(ordered.map(caseDigestValue));
  let identity = await findBySlug(
    (after) => client.listDatasets({ after, limit: 100 }),
    scenario.slug,
  );
  if (!identity) {
    try {
      identity = await client.createDataset({
        name: scenario.name,
        slug: scenario.slug,
        ...(scenario.description === undefined ? {} : { description: scenario.description }),
      });
    } catch {
      identity = await findBySlug(
        (after) => client.listDatasets({ after, limit: 100 }),
        scenario.slug,
      );
      if (!identity) throw new Error("Dataset creation outcome is unavailable");
    }
  }
  let dataset = await client.getDataset(identity.id);
  const frozen = dataset.versions.find((version) => version.contentDigest === wantedDigest);
  if (frozen) return frozen.id;
  let draft = dataset.versions.find((version) => !version.frozenAt);
  if (!draft) {
    try {
      draft = await client.createDatasetVersion(identity.id);
    } catch {
      dataset = await client.getDataset(identity.id);
      draft = dataset.versions.find((version) => !version.frozenAt);
      if (!draft) throw new Error("Dataset draft creation outcome is unavailable");
    }
  }
  const desired = new Map(cases.map((item) => [item.externalKey, item]));
  for (const item of await allCases(client, draft.id)) {
    const expected = desired.get(item.externalKey);
    if (!expected || digest(caseDigestValue(item)) !== digest(caseDigestValue(expected)))
      throw new Error("Repository scenario conflicts with an existing mutable dataset draft");
    desired.delete(item.externalKey);
  }
  for (const item of cases) {
    if (!desired.has(item.externalKey)) continue;
    try {
      ({ version: draft } = await client.addCase(draft.id, {
        ...item,
        expectedRevision: draft.revision,
      }));
    } catch {
      const recovered = (await allCases(client, draft.id)).find(
        (value) => value.externalKey === item.externalKey,
      );
      if (!recovered || digest(caseDigestValue(recovered)) !== digest(caseDigestValue(item)))
        throw new Error("Dataset case write outcome is unavailable");
      draft = await client.getDatasetVersion(draft.id);
    }
  }
  try {
    return (await client.freezeDatasetVersion(draft.id, draft.revision)).id;
  } catch {
    const recovered = await client.getDatasetVersion(draft.id);
    if (recovered.contentDigest !== wantedDigest)
      throw new Error("Dataset freeze outcome is unavailable");
    return recovered.id;
  }
}
async function resolveExperiment(
  options: RunSimulationOptions,
  idempotencyKey: string,
): Promise<{ experimentId: string; bindings: LocalScorer[] }> {
  if (options.scenario.kind === "experiment") {
    const source = await options.client.getExperiment(options.scenario.experimentId);
    const created = await options.client.createExperiment({
      idempotencyKey,
      name: options.runName ?? source.name,
      datasetVersionId: source.datasetVersionId,
      scorerVersionIds: source.evaluation.scorerVersions.map((item) => item.id),
      config: source.config,
    });
    return { experimentId: created.id, bindings: options.localScorers ?? [] };
  }
  const environmentVersionId = await resolveEnvironment(
    options.environmentClient,
    options.scenario.environment,
  );
  const datasetVersionId = await resolveDataset(
    options.client,
    options.scenario,
    environmentVersionId,
  );
  const scorers = await resolveScorers(options.client, options.scenario.scorers);
  const created = await options.client.createExperiment({
    idempotencyKey,
    name: options.runName ?? options.scenario.name,
    datasetVersionId,
    scorerVersionIds: scorers.versionIds,
    config: options.scenario.config ?? {},
  });
  return {
    experimentId: created.id,
    bindings: [...scorers.bindings, ...(options.localScorers ?? [])],
  };
}
async function seal(
  client: EnvironmentClient,
  runId: string,
  executionId: string,
  status: "completed" | "abandoned",
) {
  try {
    await client.finishRun(runId, {
      idempotencyKey: `execution:${executionId}:${status}`,
      status,
    });
  } catch (error) {
    const recovered = await client.getRun(runId).catch(() => undefined);
    if (recovered?.status !== status) throw error;
  }
}

export async function runSimulation(options: RunSimulationOptions): Promise<SimulationReport> {
  if (options.environmentClient.baseUrl !== options.client.baseUrl)
    throw new Error("Environments and evaluations must use the same Hue origin");
  const project = await options.client.checkConnection();
  const store = await CheckpointStore.acquire(options.checkpointDirectory, {
    kind: "simulation",
    projectId: project.id,
    baseUrl: options.client.baseUrl,
  });
  try {
    const scenarioDigest = digest(scenarioIdentity(options.scenario));
    let attempt = await store.read<Attempt>("active-attempt");
    if (attempt && attempt.stage !== "completed" && attempt.scenarioDigest !== scenarioDigest)
      throw new Error("Recover the unfinished simulation before running a changed scenario");
    if (!attempt || attempt.stage === "completed") {
      attempt = { scenarioDigest, idempotencyKey: randomUUID(), stage: "preparing" };
      await store.write("active-attempt", attempt);
    }
    let bindings = options.localScorers ?? [];
    if (!attempt.experimentId) {
      const resolved = await resolveExperiment(options, attempt.idempotencyKey);
      attempt.experimentId = resolved.experimentId;
      bindings = resolved.bindings;
      attempt.stage = "running";
      await store.write("active-attempt", attempt);
    } else if (options.scenario.kind === "repository") {
      bindings = [
        ...options.scenario.scorers
          .filter((item) => "definition" in item.scorer)
          .map((item) => item.scorer as LocalScorer),
        ...(options.localScorers ?? []),
      ];
    }
    const experimentId = attempt.experimentId;
    const runUrl = new URL(`/experiments/${experimentId}`, options.client.baseUrl).toString();
    await options.onProgress?.({ type: "run_created", experimentId, runUrl });
    const report = await runExperiment({
      client: options.client,
      hue: options.hue,
      experimentId,
      checkpointDirectory: join(store.directory, `experiment-${experimentId}`),
      persistResultContent: options.persistResultContent,
      traceEvidence: options.traceEvidence,
      environmentEvidence: "required",
      scorers: bindings,
      concurrency: options.concurrency,
      schemaTimeoutMillis: options.schemaTimeoutMillis,
      target: async (inputs, context) => {
        const environmentVersionId = context.item.environmentVersionId;
        if (!environmentVersionId)
          throw new Error("The simulation case has no pinned environment version");
        const run = await options.environmentClient.createRun({
          idempotencyKey: `execution:${context.executionId}`,
          environmentVersionId,
          executionId: context.executionId,
          maxSteps: options.maxSteps,
          ttlSeconds: options.ttlSeconds,
        });
        const progress = (type: Exclude<SimulationProgress["type"], "run_created">) =>
          options.onProgress?.({
            type,
            experimentId,
            executionId: context.executionId,
            caseId: context.item.id,
            environmentRunId: run.id,
          });
        let finalized = false;
        try {
          await progress("world_created");
          if (options.signal?.aborted) throw new TargetCancelledError();
          const tools = bindEnvironmentTools({
            hue: options.hue,
            client: options.environmentClient,
            run,
            parentContext: context.span.context,
          });
          const mcp = await options.client.createSimulationMcpCapability({
            runId: run.id,
            executionId: context.executionId,
          });
          await progress("target_started");
          const output = await options.target(inputs, {
            config: context.config,
            item: context.item,
            executionId: context.executionId,
            tools,
            mcp,
            signal: options.signal,
          });
          try {
            await seal(options.environmentClient, run.id, context.executionId, "completed");
          } catch (error) {
            throw new TargetOutcomeUncertainError(context.executionId, { cause: error });
          }
          finalized = true;
          await Promise.resolve(progress("world_sealed")).catch(() => undefined);
          return output;
        } catch (error) {
          if (error instanceof TargetOutcomeUncertainError || finalized) throw error;
          try {
            await seal(options.environmentClient, run.id, context.executionId, "abandoned");
          } catch (finalizationError) {
            throw new TargetOutcomeUncertainError(context.executionId, {
              cause: new AggregateError([error, finalizationError]),
            });
          }
          await Promise.resolve(progress("world_sealed")).catch(() => undefined);
          if (options.signal?.aborted && !(error instanceof TargetCancelledError))
            throw new TargetCancelledError();
          throw error;
        }
      },
    });
    const complete: SimulationReport = { ...report, experimentId, runUrl };
    attempt.stage = "completed";
    attempt.report = complete;
    await store.write("active-attempt", attempt);
    return complete;
  } finally {
    await store.release();
  }
}
