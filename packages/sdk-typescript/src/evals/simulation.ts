import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { HueClient } from "../client.js";
import { HueEnvironmentError, type EnvironmentClient } from "../environment/client.js";
import { bindEnvironmentTools, type EnvironmentTool } from "../environment/tools.js";
import type { EnvironmentDefinition, EnvironmentIdentity } from "../environment/types.js";
import { HueApiError, type EvaluationClient } from "./client.js";
import { CheckpointStore } from "./checkpoint.js";
import { MAX_ENVIRONMENT_STEPS } from "./environment-evidence.js";
import { aggregateBounds, digest, json } from "./json.js";
import { normalizeScorerDefinitionForPublication } from "./scorer-publication.js";
import {
  actualAgentManifestV2,
  attemptBaselineV2,
  projectMcpConnectionV2,
  requestedAttemptProvidersV2,
  validateAttemptConnectionBundleV2,
  type ActualAgentManifestInputV2,
  type AttemptBaselineV2,
  type AttemptConnectionBundleV2,
  type RequestedAttemptProviderV2,
} from "./attempt.js";
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
/** Immutable app-authored experiment reference or repository-authored scenario definition. */
export type SimulationScenario =
  | {
      /** Select an existing app-authored immutable experiment template. */
      kind: "experiment";
      /** Experiment to clone into a fresh attempt. */
      experimentId: string;
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
        definition: EnvironmentDefinition;
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

type ActualAgentManifestResolverV2 =
  | ActualAgentManifestInputV2
  | ((context: {
      config: JsonValue;
      item: ExperimentCase;
      signal?: AbortSignal;
    }) => ActualAgentManifestInputV2 | Promise<ActualAgentManifestInputV2>);

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

type AttemptPreparationV2 = {
  actualAgentManifest: ActualAgentManifestResolverV2;
  requestedProviders: RequestedAttemptProviderV2[];
  mcpSurface: NonNullable<RunSimulationOptions["mcpSurface"]>;
};

function requestedAttempt(options: RunSimulationOptions): AttemptPreparationV2 | undefined {
  const requested = options.requestedProviders !== undefined;
  const selected = options.mcpSurface !== undefined;
  if (!requested && !selected) {
    if (options.actualAgentManifest !== undefined)
      throw new TypeError("actualAgentManifest requires requestedProviders and mcpSurface");
    return undefined;
  }
  if (!requested || !selected)
    throw new TypeError("requestedProviders and mcpSurface must be supplied together");
  const requestedProviders = requestedAttemptProvidersV2.parse(options.requestedProviders);
  const mcpSurface = options.mcpSurface!;
  const provider = requestedProviders.find(
    (candidate) => candidate.providerInstanceKey === mcpSurface.providerInstanceKey,
  );
  if (!provider?.surfaceKeys.includes(mcpSurface.surfaceKey))
    throw new TypeError("mcpSurface must identify an exactly requested MCP surface");
  const actualAgentManifest =
    typeof options.actualAgentManifest === "function"
      ? options.actualAgentManifest
      : actualAgentManifestV2.parse(options.actualAgentManifest);
  return {
    actualAgentManifest,
    requestedProviders,
    mcpSurface: { ...mcpSurface },
  };
}

function expectedManifestDigest(
  config: JsonValue,
): AttemptBaselineV2["expectedAgentManifestDigest"] {
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new TypeError("Provider-profile simulations require an immutable V2 attempt baseline");
  const source = config as Record<string, JsonValue>;
  const baseline = attemptBaselineV2.safeParse(source.attemptBaselineV2);
  if (!baseline.success) {
    if (source.attemptBaselineV2 === undefined && source.attemptBaselineV1 !== undefined)
      throw new TypeError("Legacy V1 attempts require a fresh experiment with a V2 baseline");
    if (source.attemptBaselineV2 !== undefined)
      throw new TypeError("The immutable V2 attempt baseline is invalid");
    throw new TypeError("Provider-profile simulations require an immutable V2 attempt baseline");
  }
  return baseline.data.expectedAgentManifestDigest;
}

function normalizedEnvironmentDefinition(definition: EnvironmentDefinition): JsonValue {
  return json(
    {
      ...definition,
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

/** Run an existing agent callback against one fresh hosted world per case. The helper
 * owns immutable resolution, execution linkage, finalization, scoring and resumable uploads.
 */
export async function runSimulation(options: RunSimulationOptions): Promise<SimulationReport> {
  const requestedConfiguration = requestedAttempt(options);
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
      ? {
          ...requestedConfiguration,
          expectedAgentManifestDigest: expectedManifestDigest(
            (await options.client.getExperiment(experimentId)).config,
          ),
        }
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
        const progress = (type: "world_created" | "target_started" | "world_sealed") =>
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
          let connectionBundle: AttemptConnectionBundleV2 | undefined;
          let mcp: SimulationMcpCapability;
          if (requested) {
            const actualManifest = actualAgentManifestV2.parse(
              typeof requested.actualAgentManifest === "function"
                ? await requested.actualAgentManifest({
                    config: context.config,
                    item: structuredClone(context.item),
                    signal: options.signal,
                  })
                : requested.actualAgentManifest,
            );
            let prepared;
            try {
              prepared = await options.client.prepareAttempt({
                schemaVersion: 2,
                idempotencyKey: randomUUID(),
                executionId: context.executionId,
                environmentRunId: run.id,
                expectedAgentManifestDigest: requested.expectedAgentManifestDigest,
                actualManifest,
                requestedProviders: requested.requestedProviders,
              });
            } catch (error) {
              // A transport failure or malformed credential-bearing response may
              // follow a committed decision. Preserve the running checkpoint and
              // never reacquire credentials or replay the target on resume.
              throw new TargetOutcomeUncertainError(context.executionId, { cause: error });
            }
            await options.onProgress?.({
              type: "attempt_prepared",
              experimentId,
              executionId: context.executionId,
              caseId: context.item.id,
              environmentRunId: run.id,
              bindingId:
                prepared.status === "ready" ? prepared.bundle.bindingId : prepared.bindingId,
              status: prepared.status,
              findingCodes: prepared.preflightReport.findings.map((finding) => finding.code),
              ...(prepared.status === "ready"
                ? {
                    executionManifestDigest: prepared.bundle.parity.executionManifestDigest,
                  }
                : {}),
            });
            if (prepared.status === "environment_incomplete") {
              try {
                await seal(options.environmentClient, run.id, context.executionId, "completed");
              } catch (error) {
                throw new TargetOutcomeUncertainError(context.executionId, { cause: error });
              }
              finalized = true;
              await Promise.resolve(progress("world_sealed")).catch(() => undefined);
              return undefined;
            }
            connectionBundle = validateAttemptConnectionBundleV2(prepared.bundle, {
              requireFresh: true,
            });
            const projected = projectMcpConnectionV2(
              connectionBundle,
              requested.mcpSurface.providerInstanceKey,
            );
            if (!projected) throw new TypeError("The prepared attempt has no selected MCP surface");
            mcp = projected;
          } else {
            mcp = await options.client.createSimulationMcpCapability({
              runId: run.id,
              executionId: context.executionId,
            });
          }
          if (options.signal?.aborted) throw new TargetCancelledError();
          await progress("target_started");
          const output = await options.target(structuredClone(inputs), {
            config: structuredClone(context.config),
            item: { id: context.item.id, externalKey: context.item.externalKey },
            executionId: context.executionId,
            environmentRunId: run.id,
            tools,
            mcp: { url: mcp.url, token: mcp.token, expiresAt: mcp.expiresAt },
            ...(connectionBundle ? { connectionBundle } : {}),
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
          let environmentIncomplete: boolean;
          try {
            environmentIncomplete =
              (await options.environmentClient.getRun(run.id)).validity ===
              "environment_incomplete";
          } catch (inspectionError) {
            // A target error can be the adapter surfacing a coverage gap. If the
            // authoritative run cannot be read, do not guess that it was an agent
            // failure or replay the target on resume.
            throw new TargetOutcomeUncertainError(context.executionId, {
              cause: new AggregateError([error, inspectionError]),
            });
          }
          // A durable coverage gap invalidates parity independently of caller timing;
          // do not let a racing local abort hide it as an ordinary cancellation.
          if (environmentIncomplete) {
            try {
              await seal(options.environmentClient, run.id, context.executionId, "completed");
            } catch (finalizationError) {
              throw new TargetOutcomeUncertainError(context.executionId, {
                cause: new AggregateError([error, finalizationError]),
              });
            }
            finalized = true;
            await Promise.resolve(progress("world_sealed")).catch(() => undefined);
            return undefined;
          }
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
