import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { HueClient } from "../client.js";
import { HueEnvironmentError, type EnvironmentClient } from "../environment/client.js";
import type { EnvironmentTool } from "../environment/tools.js";
import type {
  EnvironmentIdentity,
  PublishableEnvironmentDefinition,
} from "../environment/types.js";
import { HueApiError, type EvaluationClient } from "./client.js";
import { CheckpointStore } from "./checkpoint.js";
import { MAX_ENVIRONMENT_STEPS } from "./environment-evidence.js";
import { aggregateBounds, digest, json } from "./json.js";
import { normalizeScorerDefinitionForPublication } from "./scorer-publication.js";
import type {
  ActualAgentManifestInputV2,
  AttemptConnectionBundleV2,
  RequestedAttemptProviderV2,
} from "./attempt.js";
import {
  pinRequestedAttemptV2,
  requestedAttemptV2,
  runEnvironmentTarget,
} from "./environment-target.js";
import { runExperiment, type RunnerReport } from "./runner.js";
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

/** Repository-authored scorer identity and its public definition or local binding. */
export interface RepositorySimulationScorer extends Identity {
  /** Scorer definition to publish, or a local callback bound to its source digest. */
  scorer: ScorerDefinition | LocalScorer;
}
/** One repository-authored scenario case. */
export interface RepositorySimulationCase {
  /** Stable key unique within this scenario dataset. */
  externalKey: string;
  /** JSON inputs passed to the local target callback. */
  inputs: JsonValue;
  /** Optional reference output for scorers. */
  expected?: JsonValue;
  /** Optional caller-owned case metadata. */
  metadata?: Record<string, JsonValue>;
}
/** Immutable app-authored experiment reference, published pins or repository-authored scenario definition. */
export type SimulationScenario =
  | {
      /** Select an existing app-authored immutable experiment template. */
      kind: "experiment";
      /** Experiment to clone into a fresh attempt. */
      experimentId: string;
    }
  | {
      /** Run already published immutable pins, such as a Scenario's frozen case and outcome checks. */
      kind: "pins";
      /** Frozen dataset version whose cases pin their simulated-world versions. */
      datasetVersionId: string;
      /** Immutable scorer versions to pin; Hue-executed pins need no local callback. */
      scorerVersionIds: string[];
      /** JSON configuration passed to every target callback; defaults to `{}`. */
      config?: JsonValue;
      /** Experiment display name; defaults to the dataset name, then `Simulation`. */
      name?: string;
    }
  | {
      /** Publish and resolve the repository-authored definition. */
      kind: "repository";
      /** Experiment display name. */
      name: string;
      /** Stable dataset slug used for immutable version resolution. */
      slug: string;
      /** Optional experiment/dataset description. */
      description?: string;
      /** Environment identity and authored world definition. */
      environment: EnvironmentIdentity & {
        /** Definition normalized and published as an immutable version. */
        definition: PublishableEnvironmentDefinition;
      };
      /** Cases published into one frozen dataset version. */
      cases: RepositorySimulationCase[];
      /** Scorers published and pinned by immutable version. */
      scorers: RepositorySimulationScorer[];
      /** JSON configuration passed to every target callback. */
      config?: JsonValue;
    };

/** Progress emitted without target output, credentials or other sensitive content. */
export type SimulationProgress =
  | {
      /** Emitted as soon as the inspectable experiment exists. */
      type: "run_created";
      /** Fresh experiment identity. */
      experimentId: string;
      /** Browser URL for inspecting progress and evidence. */
      runUrl: string;
    }
  | {
      /** World/target lifecycle event. */
      type: "world_created" | "target_started" | "world_sealed";
      /** Fresh experiment identity. */
      experimentId: string;
      /** Target execution identity. */
      executionId: string;
      /** Frozen experiment-case identity. */
      caseId: string;
      /** Isolated simulated-world identity. */
      environmentRunId: string;
    }
  | {
      /** Strict provider-profile preflight decision. */
      type: "attempt_prepared";
      /** Fresh experiment identity. */
      experimentId: string;
      /** Target execution identity. */
      executionId: string;
      /** Frozen experiment-case identity. */
      caseId: string;
      /** Isolated simulated-world identity. */
      environmentRunId: string;
      /** Stable attempt binding identity. */
      bindingId: string;
      /** Whether strict parity was established. */
      status: "ready" | "environment_incomplete";
      /** Stable nonsecret finding codes. */
      findingCodes: string[];
      /** Credential-free execution manifest digest for ready attempts. */
      executionManifestDigest?: AttemptConnectionBundleV2["parity"]["executionManifestDigest"];
    };

/** Context supplied to the existing local agent callback for one case attempt. */
export interface SimulationTargetContext {
  /** Frozen experiment configuration. */
  config: JsonValue;
  /** Candidate-visible identity. References, metadata and source pins stay with grading. */
  item: Pick<ExperimentCase, "id" | "externalKey">;
  /** Target execution identity. */
  executionId: string;
  /** Stable world identity for adapter control operations such as coverage reporting. */
  environmentRunId: string;
  /** Framework-neutral local callables backed by this attempt's isolated world. */
  tools: Record<string, EnvironmentTool>;
  /** Short-lived capability for providers that execute MCP remotely. */
  mcp: SimulationMcpCapability;
  /** Credential-bearing provider connections for this callback only. Hue never
   * checkpoints, logs or adds this response to parity digests. */
  connectionBundle?: AttemptConnectionBundleV2;
  /** Cancellation is cooperative: pass this signal into the real agent/provider call. */
  signal?: AbortSignal;
}

/** Options for {@link runSimulation}. */
export interface RunSimulationOptions {
  /** Evaluation client for the target Hue project. */
  client: EvaluationClient;
  /** Environment client for the same Hue origin and project. */
  environmentClient: EnvironmentClient;
  /** Hue telemetry client used for target and tool spans. */
  hue: HueClient;
  /** Dedicated private directory for resumable checkpoints. */
  checkpointDirectory: string;
  /** App-authored reference or repository-authored scenario. */
  scenario: SimulationScenario;
  /** Required privacy decision for saved target/scorer content. */
  persistResultContent: boolean;
  /** Required trace receipt policy for every target attempt. */
  traceEvidence:
    | {
        /** Wait for acknowledged trace/log export. */
        mode: "required";
      }
    | {
        /** Explicitly omit stored trace evidence. */
        mode: "omit";
        /** Bounded explanation for the omission. */
        reason: string;
      };
  /** Local scorer callbacks bound by their declared source digests. */
  localScorers?: LocalScorer[];
  /** Cases in flight, 1–16; defaults to 1. */
  concurrency?: number;
  /** JSON Schema worker deadline in milliseconds. */
  schemaTimeoutMillis?: number;
  /** Per-world action ceiling, 1–500. */
  maxSteps?: number;
  /** Per-world lease in seconds, 1–86400. */
  ttlSeconds?: number;
  /** Cooperative caller cancellation signal. */
  signal?: AbortSignal;
  /** Optional display name for the fresh experiment. */
  runName?: string;
  /** Opt into immutable provider-profile preflight. Provider selection and the MCP
   * projection are required together. Omitted actual evidence normalizes to explicit
   * V2 missing evidence; it is never assumed equal to the baseline. */
  actualAgentManifest?:
    | ActualAgentManifestInputV2
    | ((context: {
        /** Frozen experiment configuration. */
        config: JsonValue;
        /** Frozen case selected for this attempt. */
        item: ExperimentCase;
        /** Cooperative caller cancellation signal. */
        signal?: AbortSignal;
      }) => ActualAgentManifestInputV2 | Promise<ActualAgentManifestInputV2>);
  /** Exact provider instances and ordered surfaces asserted for strict preflight. */
  requestedProviders?: RequestedAttemptProviderV2[];
  /** Requested MCP surface projected to the backwards-compatible `context.mcp`. */
  mcpSurface?: {
    /** Provider instance selected from `requestedProviders`. */
    providerInstanceKey: string;
    /** Selected MCP surface. */
    surfaceKey: "google.gmail/mcp" | "slack/mcp";
  };
  /** Invokes the existing local agent exactly once for this attempt. */
  target(
    inputs: JsonValue,
    context: SimulationTargetContext,
  ): JsonValue | undefined | Promise<JsonValue | undefined>;
  /** Receives bounded nonsecret lifecycle progress. */
  onProgress?(event: SimulationProgress): void | Promise<void>;
}

/** Completed simulation report with its inspectable experiment identity. */
export interface SimulationReport extends RunnerReport {
  /** Fresh experiment created for this invocation. */
  experimentId: string;
  /** Browser URL joining task, trace, world evidence and scoring. */
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

function normalizedEnvironmentDefinition(definition: PublishableEnvironmentDefinition): JsonValue {
  return json(
    {
      ...definition,
      ...(definition.schemaVersion === 2
        ? {
            providerInstances: definition.providerInstances.map((instance) => ({
              ...instance,
              syntheticPrincipalId: instance.syntheticPrincipalId.toLowerCase(),
            })),
          }
        : {}),
      determinism: {
        clock: {
          startNs: definition.determinism?.clock?.startNs ?? "0",
          stepAdvanceNs: definition.determinism?.clock?.stepAdvanceNs ?? "1000000",
        },
      },
      actions: definition.actions.map((action) => ({
        ...action,
        params: (action.params ?? []).map((parameter) => ({
          ...parameter,
          required: parameter.required ?? true,
        })),
        semantics: {
          ...action.semantics,
          config: {
            ...action.semantics.config,
            guards: action.semantics.config.guards ?? [],
            notFoundError: action.semantics.config.notFoundError ?? "not_found",
          },
        },
        observation: action.observation ?? { projection: "identity" },
      })),
      provenance: definition.provenance ?? { kind: "handwritten" },
      metadata: definition.metadata ?? {},
    },
    aggregateBounds(240_000),
  );
}

function scenarioIdentity(scenario: SimulationScenario): JsonValue {
  if (scenario.kind === "experiment") return scenario;
  // The display name is cosmetic; the pins and configuration are the scenario.
  if (scenario.kind === "pins")
    return json({
      kind: scenario.kind,
      datasetVersionId: scenario.datasetVersionId,
      scorerVersionIds: [...scenario.scorerVersionIds].sort(),
      config: scenario.config ?? {},
    });
  return json(
    {
      kind: scenario.kind,
      name: scenario.name,
      slug: scenario.slug,
      description: scenario.description ?? "",
      environment: {
        ...scenario.environment,
        definition: normalizedEnvironmentDefinition(scenario.environment.definition),
      },
      cases: scenario.cases,
      scorers: scenario.scorers.map(({ scorer, ...identity }) => ({
        ...identity,
        definition: normalizeScorerDefinitionForPublication(
          "definition" in scorer ? scorer.definition : scorer,
        ),
      })),
      config: scenario.config ?? {},
    },
    aggregateBounds(8 * 1024 * 1024),
  );
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

type HueWriteError = HueApiError | HueEnvironmentError;

function canReconcileWrite(error: unknown): error is HueWriteError {
  if (!(error instanceof HueApiError || error instanceof HueEnvironmentError)) return false;
  return error.status === undefined || error.status === 409 || error.status >= 500;
}

/** Re-read only writes whose acknowledgement can be ambiguous or whose 409 can be a
 * concurrent matching publication. Local encoding and deterministic 4xx failures are
 * caller errors and retain their original type/status.
 */
async function reconcileWrite<T>(
  error: unknown,
  read: () => Promise<T | undefined>,
  unavailableMessage: string,
): Promise<T> {
  if (!canReconcileWrite(error)) throw error;
  let recovered: T | undefined;
  try {
    recovered = await read();
  } catch (readError) {
    throw new Error(unavailableMessage, {
      cause: new AggregateError([error, readError], "Write and reconciliation both failed"),
    });
  }
  if (recovered !== undefined) return recovered;
  // A received conflict is deterministic when no matching concurrent write exists.
  if (error.status === 409) throw error;
  throw new Error(unavailableMessage, { cause: error });
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
    } catch (error) {
      identity = await reconcileWrite(
        error,
        () => findBySlug((after) => client.listEnvironments({ after, limit: 100 }), source.slug),
        "Environment creation acknowledgement is unavailable",
      );
    }
  }
  if (identity.archivedAt) throw new Error("Repository scenario environment is archived");
  const definitionDigest = digest(normalizedEnvironmentDefinition(source.definition));
  const current = await client.getEnvironment(identity.id);
  const existing = current.versions.find((version) => version.contentDigest === definitionDigest);
  if (existing) return existing.id;
  try {
    return (await client.publishVersion(identity.id, source.definition)).id;
  } catch (error) {
    return (
      await reconcileWrite(
        error,
        async () =>
          (await client.getEnvironment(identity.id)).versions.find(
            (version) => version.contentDigest === definitionDigest,
          ),
        "Environment publication acknowledgement is unavailable",
      )
    ).id;
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
    const supplied = scorerDefinition(source);
    const definition = normalizeScorerDefinitionForPublication(supplied);
    let identity = await findBySlug(
      (after) => client.listScorers({ after, limit: 100, includeArchived: true }),
      source.slug,
    );
    if (!identity) {
      try {
        identity = await client.createScorer({
          name: source.name,
          slug: source.slug,
          ...(source.description === undefined ? {} : { description: source.description }),
        });
      } catch (error) {
        identity = await reconcileWrite(
          error,
          () =>
            findBySlug(
              (after) => client.listScorers({ after, limit: 100, includeArchived: true }),
              source.slug,
            ),
          "Scorer creation acknowledgement is unavailable",
        );
      }
    }
    if (identity.archivedAt) throw new Error("Repository scenario scorer is archived");
    const full = await client.getScorer(identity.id);
    const definitionDigest = digest(definition);
    let version = full.versions?.find((item) => item.contentDigest === definitionDigest);
    if (!version) {
      try {
        version = await client.publishScorerVersion(identity.id, definition);
      } catch (error) {
        version = await reconcileWrite(
          error,
          async () =>
            (await client.getScorer(identity.id)).versions?.find(
              (item) => item.contentDigest === definitionDigest,
            ),
          "Scorer publication acknowledgement is unavailable",
        );
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

type CaseDigestInput = Omit<CaseWrite, "expectedRevision"> &
  Partial<Pick<DatasetCase, "sourceTraceId" | "sourceTraceRevision" | "artifactManifestId">>;

const caseDigestValue = (value: CaseDigestInput) => ({
  externalKey: value.externalKey,
  inputs: value.inputs,
  expected: Object.hasOwn(value, "expected") ? value.expected! : null,
  hasExpected: Object.hasOwn(value, "expected"),
  metadata: value.metadata ?? {},
  sourceTraceId: value.sourceTraceId ?? null,
  sourceTraceRevision: value.sourceTraceRevision ?? null,
  ...(value.artifactManifestId ? { artifactManifestId: value.artifactManifestId } : {}),
  ...(value.environmentVersionId ? { environmentVersionId: value.environmentVersionId } : {}),
});

async function resolveDataset(
  client: EvaluationClient,
  scenario: Extract<SimulationScenario, { kind: "repository" }>,
  environmentVersionId: string,
): Promise<string> {
  if (!scenario.cases.length) throw new TypeError("Repository scenarios require at least one case");
  const cases = scenario.cases.map((item) => normalizedCase(item, environmentVersionId));
  const keys = new Set(cases.map((item) => item.externalKey));
  if (keys.size !== cases.length)
    throw new TypeError("Repository scenario case keys must be unique");
  const ordered = [...cases].sort((a, b) =>
    Buffer.compare(Buffer.from(a.externalKey), Buffer.from(b.externalKey)),
  );
  const wantedDigest = digest(ordered.map(caseDigestValue));
  let identity = await findBySlug(
    (after) => client.listDatasets({ after, limit: 100, includeArchived: true }),
    scenario.slug,
  );
  if (!identity) {
    try {
      identity = await client.createDataset({
        name: scenario.name,
        slug: scenario.slug,
        ...(scenario.description === undefined ? {} : { description: scenario.description }),
      });
    } catch (error) {
      identity = await reconcileWrite(
        error,
        () =>
          findBySlug(
            (after) => client.listDatasets({ after, limit: 100, includeArchived: true }),
            scenario.slug,
          ),
        "Dataset creation acknowledgement is unavailable",
      );
    }
  }
  if (identity.archivedAt) throw new Error("Repository scenario dataset is archived");
  let dataset = await client.getDataset(identity.id);
  const frozen = dataset.versions.find((version) => version.contentDigest === wantedDigest);
  if (frozen) return frozen.id;
  let draft = dataset.versions.find((version) => !version.frozenAt);
  if (!draft) {
    try {
      draft = await client.createDatasetVersion(identity.id);
    } catch (error) {
      draft = await reconcileWrite(
        error,
        async () => {
          dataset = await client.getDataset(identity.id);
          return dataset.versions.find((version) => !version.frozenAt);
        },
        "Dataset draft creation acknowledgement is unavailable",
      );
    }
  }
  const current = await allCases(client, draft.id);
  const desired = new Map(cases.map((item) => [item.externalKey, item]));
  for (const item of current) {
    const expected = desired.get(item.externalKey);
    if (!expected || digest(caseDigestValue(item)) !== digest(caseDigestValue(expected)))
      throw new Error("Repository scenario conflicts with an existing mutable dataset draft");
    desired.delete(item.externalKey);
  }
  for (const item of cases) {
    if (!desired.has(item.externalKey)) continue;
    const draftId = draft.id;
    const expectedRevision = draft.revision;
    try {
      const added = await client.addCase(draftId, {
        ...item,
        expectedRevision,
      });
      draft = added.version;
    } catch (error) {
      await reconcileWrite(
        error,
        async () => {
          const recovered = (await allCases(client, draftId)).find(
            (value) => value.externalKey === item.externalKey,
          );
          return recovered && digest(caseDigestValue(recovered)) === digest(caseDigestValue(item))
            ? recovered
            : undefined;
        },
        "Dataset case write acknowledgement is unavailable",
      );
      draft = await client.getDatasetVersion(draftId);
    }
  }
  try {
    return (await client.freezeDatasetVersion(draft.id, draft.revision)).id;
  } catch (error) {
    return (
      await reconcileWrite(
        error,
        async () => {
          const recovered = await client.getDatasetVersion(draft.id);
          return recovered.contentDigest === wantedDigest ? recovered : undefined;
        },
        "Dataset freeze acknowledgement is unavailable",
      )
    ).id;
  }
}

/** Display name of the dataset owning a version, or undefined when it cannot be read. */
async function datasetName(client: EvaluationClient, versionId: string) {
  try {
    const version = await client.getDatasetVersion(versionId);
    return (await client.getDataset(version.datasetId)).name;
  } catch {
    return undefined;
  }
}

async function allCases(client: EvaluationClient, versionId: string) {
  const items = [];
  let after: string | undefined;
  for (;;) {
    const page = await client.listCases(versionId, { after, limit: 100 });
    items.push(...page.items);
    if (!page.nextCursor) return items;
    after = page.nextCursor;
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
  if (options.scenario.kind === "pins") {
    const { datasetVersionId, scorerVersionIds } = options.scenario;
    if (!scorerVersionIds.length) throw new TypeError("Pinned scenarios require a scorer version");
    const created = await options.client.createExperiment({
      idempotencyKey,
      name:
        options.runName ??
        options.scenario.name ??
        (await datasetName(options.client, datasetVersionId)) ??
        "Simulation",
      datasetVersionId,
      scorerVersionIds: [...scorerVersionIds],
      config: options.scenario.config ?? {},
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

/** Run an existing agent callback against one fresh hosted world per case. The helper
 * owns immutable resolution, execution linkage, finalization, scoring and resumable uploads.
 */
export async function runSimulation(options: RunSimulationOptions): Promise<SimulationReport> {
  const requestedConfiguration = requestedAttemptV2(options);
  if (
    options.maxSteps !== undefined &&
    (!Number.isInteger(options.maxSteps) ||
      options.maxSteps < 1 ||
      options.maxSteps > MAX_ENVIRONMENT_STEPS)
  )
    throw new RangeError(`maxSteps must be 1–${MAX_ENVIRONMENT_STEPS}`);
  if (
    options.ttlSeconds !== undefined &&
    (!Number.isInteger(options.ttlSeconds) || options.ttlSeconds < 1 || options.ttlSeconds > 86_400)
  )
    throw new RangeError("ttlSeconds must be 1–86400");
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
      attempt = {
        scenarioDigest,
        idempotencyKey: randomUUID(),
        stage: "preparing",
      };
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
    const requested = requestedConfiguration
      ? pinRequestedAttemptV2(
          requestedConfiguration,
          (await options.client.getExperiment(experimentId)).config,
        )
      : undefined;
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
      target: (inputs, context) =>
        runEnvironmentTarget({
          client: options.client,
          environmentClient: options.environmentClient,
          hue: options.hue,
          inputs,
          context,
          requested,
          maxSteps: options.maxSteps,
          ttlSeconds: options.ttlSeconds,
          signal: options.signal,
          onProgress: (event) =>
            options.onProgress?.({
              ...event,
              experimentId,
              executionId: context.executionId,
              caseId: context.item.id,
            }),
          target: (targetInputs, targetContext) =>
            options.target(structuredClone(targetInputs), {
              config: structuredClone(targetContext.config),
              item: {
                id: targetContext.item.id,
                externalKey: targetContext.item.externalKey,
              },
              executionId: targetContext.executionId,
              environmentRunId: targetContext.environmentRunId,
              tools: targetContext.tools,
              mcp: {
                url: targetContext.mcp.url,
                token: targetContext.mcp.token,
                expiresAt: targetContext.mcp.expiresAt,
              },
              ...(targetContext.connectionBundle
                ? { connectionBundle: structuredClone(targetContext.connectionBundle) }
                : {}),
              signal: targetContext.signal,
            }),
        }),
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
