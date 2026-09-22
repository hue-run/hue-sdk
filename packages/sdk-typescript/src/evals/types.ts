import type { JsonValue } from "../types.js";
import type { EnvironmentCoverage } from "../environment/types.js";

export type { JsonValue } from "../types.js";
/** One page of a paginated list. */
export interface Page<T> {
  /** Items on this page. */
  items: T[];
  /** Cursor for the next page, or `null` on the last page. */
  nextCursor: string | null;
}
/** Cursor pagination for list methods. */
export interface PageOptions {
  /** Cursor returned as `nextCursor` by the previous page. */
  after?: string;
  /** Page size, 1–100. */
  limit?: number;
}
/** Cursor pagination for registry methods that can include archived identities. */
export interface RegistryPageOptions extends PageOptions {
  /** Include archived identities so callers can diagnose slug conflicts explicitly. */
  includeArchived?: boolean;
}
/** Human-readable identity of a dataset or scorer. */
export interface Identity {
  /** Display name. */
  name: string;
  /** URL-safe slug, unique within the project. */
  slug: string;
  /** Optional description. */
  description?: string;
}
/** A dataset and its versions. */
export interface Dataset extends Identity {
  /** Dataset ID. */
  id: string;
  /** Archive timestamp on current servers; absent on older compatible responses. */
  archivedAt?: string | null;
  /** Versions of this dataset. */
  versions: DatasetVersion[];
}
/** One version of a dataset; frozen versions are immutable and can back experiments. */
export interface DatasetVersion {
  /** Version ID. */
  id: string;
  /** Owning dataset ID. */
  datasetId: string;
  /** Sequential version number within the dataset. */
  version: number;
  /** Optimistic-concurrency revision; pass it as `expectedRevision` when writing. */
  revision: number;
  /** When the version was frozen, or `null` while it is still a draft. */
  frozenAt: string | null;
  /** Digest of the frozen content, or `null` for a draft. */
  contentDigest: string | null;
}
/** A stored case: inputs, an optional reference output and metadata. */
export interface DatasetCase {
  /** Case ID. */
  id: string;
  /** Caller-chosen key, unique within the version. */
  externalKey: string;
  /** Inputs handed to the target. */
  inputs: JsonValue;
  /** Reference output for scorers, when known. */
  expected?: JsonValue;
  /** Caller-owned metadata. */
  metadata: Record<string, JsonValue>;
  /** Dataset version the case belongs to. */
  datasetVersionId: string;
  /** Exact immutable simulated world selected for this case, when present. */
  environmentVersionId?: string | null;
  /** Immutable trace provenance retained when the case was promoted from a trace. */
  sourceTraceId?: string | null;
  /** Immutable source trace revision paired with `sourceTraceId`. */
  sourceTraceRevision?: number | null;
  /** Immutable input-file manifest identity, when files are attached. */
  artifactManifestId?: string | null;
}
/** One pinned input file of a case or subject, as recorded in Hue's immutable manifest. */
export interface CaseFile {
  /** Hue artifact identity of the pinned bytes. */
  artifactId: string;
  /** How the file relates to the case; `org_template` is evaluator-only. */
  role: "source" | "attached_template" | "attached_reference" | "original" | "org_template";
  /** Declared file name. */
  filename: string;
  /** Declared content type. */
  contentType: string;
  /** Verified size in bytes. */
  byteSize: number;
  /** Verified SHA-256, hex encoded. */
  sha256: string;
}
/** A frozen manifest entry of a subject: the case inputs plus the outputs the target produced. */
export type SubjectFile = Omit<CaseFile, "role"> & {
  /** Input role, or `output` for a file the target generated. */
  role: CaseFile["role"] | "output";
};
/** A frozen case as an experiment sees it. */
export interface ExperimentCase extends DatasetCase {
  /** Whether a reference output is stored; JSON `null` counts as present. */
  hasExpected: boolean;
  /** Pinned input files, present on current servers when the case has a manifest. */
  inputFiles?: CaseFile[];
}
/** Input for {@link EvaluationClient.addCase}. */
export interface CaseWrite {
  /** Current `revision` of the draft version; the write fails when it has moved. */
  expectedRevision: number;
  /** Caller-chosen key, unique within the version. */
  externalKey: string;
  /** Inputs handed to the target. */
  inputs: JsonValue;
  /** Reference output for scorers. */
  expected?: JsonValue;
  /** Caller-owned metadata. */
  metadata?: Record<string, JsonValue>;
  /** Immutable simulated-world version selected for this case. */
  environmentVersionId?: string | null;
}
/** A typed metric a scorer declares and must report exactly once per scored result. */
export type MetricDefinition =
  | {
      /** Metric name. */
      name: string;
      /** Boolean or free-text metric. */
      type: "boolean" | "text";
    }
  | {
      /** Metric name. */
      name: string;
      /** Numeric metric. */
      type: "number";
      /** Inclusive lower bound. */
      min?: number;
      /** Inclusive upper bound. */
      max?: number;
    }
  | {
      /** Metric name. */
      name: string;
      /** Categorical metric. */
      type: "category";
      /** Allowed values. */
      categories: string[];
    };
/** A pinned scorer definition executed locally, by a person, or by Hue. */
export type ScorerDefinition =
  | {
      /** Hue built-in scorer. */
      kind: "builtin";
      /** Exact typed JSON equality with the reference output. */
      entry: "hue.exact_match.v1";
      /** No configuration. */
      config: Record<string, never>;
    }
  | {
      /** Hue built-in scorer. */
      kind: "builtin";
      /** String inclusion of the reference output in the output. */
      entry: "hue.includes.v1";
      /** Pinned comparison options. */
      config: {
        /** Compare case-sensitively. */
        caseSensitive: boolean;
      };
    }
  | {
      /** Hue built-in scorer. */
      kind: "builtin";
      /** JSON Schema draft 2020-12 validation of the output. */
      entry: "hue.json_schema.v1";
      /** Pinned schema. */
      config: {
        /** JSON Schema the output must satisfy. */
        schema: JsonValue;
      };
    }
  | {
      /** Trusted local callback bound by digest; Hue never downloads or runs the source. */
      kind: "local_code";
      /** Implementation language. */
      language: "typescript" | "python";
      /** Exported function name in the source. */
      entrypoint: string;
      /** SHA-256 of the declared source. */
      sourceDigest: string;
      /** Metrics the callback reports. */
      metrics: MetricDefinition[];
    }
  | {
      /** Scored inside Hue using immutable world evidence; the local runner defers it. */
      kind: "world_outcome";
      /** Pinned Hue-executed outcome evaluator. */
      entry: "hue.conversion_outcome.v1";
      /** The seven fixed boolean metrics defined by the entry. */
      metrics: MetricDefinition[];
    }
  | {
      /** Scored by a person in Hue; the local runner defers it. */
      kind: "manual";
      /** Metrics the reviewer records. */
      metrics: MetricDefinition[];
    }
  | {
      /** Hosted model judge dispatched through `createJudgeJobs`; the local runner defers it. */
      kind: "llm_judge";
      /** Judge model and rubric. */
      config: JudgeConfig;
      /** Metrics the judge reports. */
      metrics: MetricDefinition[];
    };
/** Configuration of a hosted judge scorer. */
export interface JudgeConfig {
  /** Judge model identifier. */
  model: string;
  /** Judge model provider. */
  provider: string;
  /** Rubric prompt the judge follows. */
  rubric: string;
  /** Subject fields bound into the rubric. */
  bindings: {
    /** Placeholder name in the rubric. */
    name: string;
    /** JSON path into the subject. */
    path: string;
    /** Whether the bound value must be present. */
    required: boolean;
  }[];
  /** Output token cap for the judge call. */
  maxOutputTokens: number;
  /** Judge call timeout in milliseconds. */
  timeoutMs: number;
  /** Sampling temperature, when set. */
  temperature?: number;
}
/** A result as listed by {@link EvaluationClient.listResults}. */
export interface ResultSummary {
  /** Result ID. */
  id: string;
  /** Evaluation item the result scores. */
  itemId: string;
  /** Scorer version that produced it. */
  scorerVersionId: string;
  /** Outcome state. */
  state: "scored" | "error" | "skipped";
}
/** A full stored result from {@link EvaluationClient.getResult}. */
export interface StoredResult extends ResultSummary {
  /** Evaluation run the result belongs to. */
  runId: string;
  /** Reported metric values. */
  metrics: Metric[];
  /** Scorer explanation, or `null` when absent or not persisted. */
  explanation: string | null;
  /** Scorer evidence. */
  evidence: JsonValue;
  /** Failure for `state: "error"`, otherwise `null`. */
  error: TypedError | null;
  /** Source digest of the local scorer that produced it, when applicable. */
  sourceDigest: string | null;
}
/** A hosted judge job and its charge accounting. */
export interface JudgeJob {
  /** Job ID. */
  id: string;
  /** Evaluation run. */
  runId: string;
  /** Evaluation item being judged. */
  itemId: string;
  /** Judge scorer version. */
  scorerVersionId: string;
  /** Execution state. */
  state: "queued" | "running" | "completed" | "cancelled" | "uncertain";
  /** Charge state after any separately verified reconciliation. */
  chargeState: "unreserved" | "reserved" | "settled" | "uncertain";
  /** Preserved charge state before any separately verified reconciliation. */
  originalChargeState: JudgeJob["chargeState"];
  /** Budget reserved for the job, in micro-USD. */
  reservationMicroUsd: number;
  /** Verified actual charge in micro-USD, or `null` until settled. */
  actualMicroUsd: number | null;
  /** Separately verified settlement, or `null` when there is none. */
  reconciliation: {
    /** Reconciled job ID. */
    jobId: string;
    /** Verified charge in micro-USD. */
    actualMicroUsd: number;
    /** Reference to the settlement evidence. */
    evidenceReference: string;
    /** Why the charge was reconciled. */
    reason: string;
    /** When the reconciliation was recorded. */
    createdAt: string;
  } | null;
  /** Provider price quote behind the reservation. */
  priceQuote: JsonValue;
  /** Original provider receipt. */
  receipt: JsonValue;
  /** Platform workflow ID once dispatched, otherwise `null`. */
  workflowId: string | null;
  /** When cancellation was requested, or `null`. */
  cancelRequestedAt: string | null;
  /** Caller-supplied cancellation reason, or `null`. */
  cancellationReason: string | null;
  /** Creation time. */
  createdAt: string;
  /** Start time, or `null` while queued. */
  startedAt: string | null;
  /** Finish time, or `null` until the job is terminal. */
  finishedAt: string | null;
}
/** The project's hosted judge budget and admission controls. */
export interface JudgeBudget {
  /** Project ID. */
  projectId: string;
  /** A judge provider credential is configured. */
  configured: boolean;
  /** Credential resolution does not establish provider acceptance or available funds. */
  authentication?: {
    /** Whether a credential resolved. */
    status: "available" | "unavailable";
    /** How the credential resolved, or `null`. */
    method: "api-key" | "oidc" | null;
    /** What was verified: credential resolution only. */
    verification: "credential_resolution";
  };
  /** Hosted judging is enabled for the project. */
  enabled: boolean;
  /** Total allowance in micro-USD. */
  allowanceMicroUsd: number;
  /** Currently reserved micro-USD. */
  reservedMicroUsd: number;
  /** Settled spend in micro-USD. */
  spentMicroUsd: number;
  /** Maximum concurrently running jobs. */
  maxInFlight: number;
  /** Dispatch is currently blocked. */
  blocked: boolean;
}
/** A scorer and its published versions. */
export interface Scorer extends Identity {
  /** Scorer ID. */
  id: string;
  /** Archive timestamp on current servers; absent on older compatible responses. */
  archivedAt?: string | null;
  /** Published versions, when included in the response. */
  versions?: ScorerVersion[];
}
/** An immutable published scorer definition. */
export interface ScorerVersion {
  /** Version ID; pin it in experiments and runs. */
  id: string;
  /** Digest of the definition. */
  contentDigest: string;
  /** The pinned definition. */
  definition: ScorerDefinition;
}
/** Final state of a target execution. */
export type TerminalState = "succeeded" | "error" | "cancelled";
/** One attempt to run the target for a case. */
export interface Execution {
  /** Execution ID. */
  id: string;
  /** Attempt number for the case, starting at 1. */
  attempt: number;
  /** Current state; `uncertain` means no outcome was saved. */
  state: TerminalState | "started" | "uncertain";
  /** OpenTelemetry trace ID declared for the attempt, or `null`. */
  traceExternalId: string | null;
  /** Subject created on completion, when known. */
  subjectId?: string | null;
}
/** A case within an experiment and its latest execution. */
export interface ExperimentItem {
  /** Item ID, used with the experiment to address the case. */
  id: string;
  /** The case's caller-chosen key. */
  externalKey: string;
  /** Whether a reference output is stored. */
  hasExpected: boolean;
  /** Latest execution, or `null` before the first start. */
  execution: Execution | null;
}
/** Scoring progress for an experiment or a historical rescore. */
export interface EvaluationRun {
  /** Run ID. */
  id: string;
  /** Display name. */
  name: string;
  /** Scorer versions pinned to the run. */
  scorerVersions: ScorerVersion[];
  /** Subjects in the run. */
  itemCount: number;
  /** Result counts by state. */
  scores: {
    /** Results with metrics. */
    scored: number;
    /** Scorer errors. */
    error: number;
    /** Skipped results. */
    skipped: number;
    /** Results not yet recorded. */
    pending: number;
  };
}
/** An experiment: a frozen dataset version, a configuration and pinned scorers. */
export interface Experiment {
  /** Experiment ID. */
  id: string;
  /** Display name. */
  name: string;
  /** Frozen dataset version under test. */
  datasetVersionId: string;
  /** Configuration handed to the target. */
  config: JsonValue;
  /** Digest of `config`. */
  configDigest: string;
  /** The experiment's evaluation run. */
  evaluation: EvaluationRun;
  /** Cases in the frozen version. */
  caseCount: number;
  /** When the experiment was finished, or `null`. */
  finishedAt: string | null;
  /** Case counts by execution state. */
  execution: {
    /** Cases never started. */
    unstarted: number;
    /** Cases with a started attempt. */
    started: number;
    /** Cases whose attempt has no saved outcome. */
    uncertain: number;
    /** Cases that succeeded. */
    succeeded: number;
    /** Cases that failed. */
    error: number;
    /** Cases that were cancelled. */
    cancelled: number;
  };
}
/** A sanitized error type with an optional bounded message. */
export interface TypedError {
  /** Stable error type. */
  type: string;
  /** Optional message; stored only when result content is persisted. */
  message?: string;
}
/** Input for {@link EvaluationClient.startExecution}. */
export interface StartExecution {
  /** Stable key; replaying it returns the same execution. */
  idempotencyKey: string;
  /** OpenTelemetry trace ID the attempt will emit under. */
  traceExternalId?: string;
  /** Execution being replaced; required for a new attempt. */
  previousExecutionId?: string;
  /** Explicitly allow replacing a still-started (uncertain) attempt. */
  allowUncertainRetry?: boolean;
}
/** Input for {@link EvaluationClient.completeExecution}. */
export interface CompleteExecution {
  /** Stable key; replaying it returns the same completion. */
  idempotencyKey: string;
  /** Final state of the attempt. */
  state: TerminalState;
  /** Target output; omit when unavailable. */
  output?: JsonValue;
  /** Verified artifacts the target generated; the manifest freezes them with the case inputs. */
  artifactIds?: string[];
  /** The declared primary generated artifact, one of `artifactIds`. */
  primaryArtifactId?: string;
  /** Sanitized failure for `state: "error"`. */
  error?: TypedError;
  /** Trace revision the stored snapshot must have reached. */
  expectedTraceRevision?: number;
  /** Whether stored trace evidence is required or explicitly omitted. */
  traceEvidence?: "required" | "omit";
  /** Why trace evidence was omitted. */
  omissionReason?: string;
}
/** Result of {@link EvaluationClient.completeExecution}. */
export interface Completion {
  /** Completed execution ID. */
  executionId: string;
  /** Immutable subject created from the outcome. */
  subjectId: string;
  /** Stored trace snapshot, or `null` when omitted. */
  traceSnapshotId: string | null;
  /** Evaluation item to score. */
  evaluationItemId: string;
}
/** A subject within an evaluation run. */
export interface EvaluationItem {
  /** Item ID. */
  id: string;
  /** Subject being scored. */
  subjectId: string;
  /** Whether the subject has an output. */
  hasOutput: boolean;
  /** Stored trace snapshot, or `null`. */
  traceSnapshotId: string | null;
}
/** An immutable saved outcome: inputs, output, reference and evidence for one case attempt. */
export interface Subject {
  /** Subject ID. */
  id: string;
  /** Execution that produced this subject. */
  executionId: string;
  /** Case inputs. */
  inputs: JsonValue;
  /** Whether an output is stored; JSON `null` counts as present. */
  hasOutput: boolean;
  /** Target output, when available. */
  output?: JsonValue;
  /** Whether a reference output is stored. */
  hasExpected: boolean;
  /** Reference output, when stored. */
  expected?: JsonValue;
  /** Case metadata. */
  metadata: Record<string, JsonValue>;
  /** Digest of the subject content. */
  contentDigest: string;
  /** Whether output evidence can be read. */
  outputEvidence: "available" | "unavailable";
  /** Final state of the execution. */
  executionState: TerminalState;
  /** Stored trace snapshot, or `null`. */
  traceSnapshotId: string | null;
  /** Source case ID. */
  caseId: string;
  /** Source dataset version ID. */
  datasetVersionId: string;
  /** Source case key. */
  caseExternalKey: string;
  /** Source experiment ID. */
  experimentId: string;
  /** Attempt number of the execution. */
  attempt: number;
  /** Whether trace evidence was captured, omitted with a reason or not requested. */
  traceEvidence: "captured" | "omitted" | "not_requested";
  /** Declared OpenTelemetry trace ID, or `null`. */
  traceExternalId: string | null;
  /** Reason trace evidence was omitted, or `null`. */
  omissionReason: string | null;
  /** Present on current servers: the case's pinned world, or null for an ordinary case. */
  environmentVersionId?: string | null;
  /** Present on current servers: the frozen input and output files of this subject. */
  files?: SubjectFile[];
  /** The target's declared primary generated artifact, or `null`. */
  primaryArtifactId?: string | null;
}
/** A reported metric value. */
export interface Metric {
  /** Declared metric name. */
  name: string;
  /** Value matching the declared type. */
  value: boolean | number | string;
  /** Quality verdict; a failed metric stays `state: "scored"`. */
  passed?: boolean;
}
/** Outcome of one scorer for one subject. */
export type Score =
  | {
      /** Metrics were produced. */
      state: "scored";
      /** Every declared metric exactly once. */
      metrics: Metric[];
      /** Human-readable reasoning; required unless `evidence` is given. */
      explanation?: string;
      /** Supporting data; required unless `explanation` is given. */
      evidence?: JsonValue;
    }
  | {
      /** The scorer failed. */
      state: "error";
      /** Sanitized failure. */
      error: TypedError;
    }
  | {
      /** The scorer did not apply. */
      state: "skipped";
      /** Why it was skipped. */
      explanation: string;
    };
/** A score addressed to an evaluation item, as uploaded by {@link EvaluationClient.submitResults}. */
export type Result = Score & {
  /** Evaluation item the score belongs to. */
  evaluationItemId: string;
  /** Scorer version that produced the score. */
  scorerVersionId: string;
  /** Source digest of the local scorer, for `local_code` pins. */
  sourceDigest?: string;
};
/** What a local scorer callback receives. */
export interface ScoreContext {
  /** Case inputs. */
  inputs: JsonValue;
  /** Target output; `undefined` means unavailable. */
  output?: JsonValue;
  /** Reference output, when stored. */
  expected?: JsonValue;
  /** Whether `output` is present; JSON `null` counts. */
  hasOutput: boolean;
  /** Whether `expected` is present. */
  hasExpected: boolean;
  /** Case metadata. */
  metadata: Record<string, JsonValue>;
  /** Final state of the target execution. */
  executionState: TerminalState;
  /** Authoritative sealed world and complete journal, when required by the runner. */
  environment?: EnvironmentEvidence;
  /** Pinned input files and the target's generated files, verified and saved on this machine.
   * Present only when the runner handled files for this execution. */
  files?: LocalFile[];
}
/** A verified copy of a case input or generated output on the runner's disk. */
export interface LocalFile {
  /** Hue artifact identity; generated files receive theirs after upload. */
  artifactId: string;
  /** Input role, or `output` for a file the target generated. */
  role: CaseFile["role"] | "output";
  /** File name. */
  filename: string;
  /** Content type. */
  contentType: string;
  /** Verified size in bytes. */
  byteSize: number;
  /** Verified SHA-256, hex encoded. */
  sha256: string;
  /** Absolute path of the verified bytes on this machine. */
  path: string;
  /** Whether this is the execution's primary generated document. */
  primary?: boolean;
}
/** A file the target generated for one case. Bytes are read from `path` or taken from `bytes`. */
export type OutputFile = {
  /** File name Hue stores; sanitized to one path segment. */
  filename: string;
  /** One of the accepted generated content types. */
  contentType: string;
  /** The declared primary document; at most one per execution. */
  primary?: boolean;
} & (
  | {
      /** Path of the generated file on this machine. */
      path: string;
      /** Not used when `path` is given. */
      bytes?: undefined;
    }
  | {
      /** Generated bytes held in memory. */
      bytes: Uint8Array;
      /** Not used when `bytes` is given. */
      path?: undefined;
    }
);
/** A target's saved outcome when it produced files. Create it with `withFiles`. */
export class TargetResult {
  constructor(
    /** JSON output of the target, or `undefined` when it produced only files. */
    readonly output: JsonValue | undefined,
    /** Generated files to save with the execution. */
    readonly files: OutputFile[],
  ) {}
}
/** Return this from a target to save generated files with the execution. */
export function withFiles(output: JsonValue | undefined, files: OutputFile[]): TargetResult {
  return new TargetResult(output, files);
}
/** Sealed environment evidence resolved through one target execution. */
export interface EnvironmentEvidenceSnapshot extends EnvironmentCoverage {
  /** Environment-run identity. */
  runId: string;
  /** Linked target execution identity. */
  executionId: string;
  /** Immutable environment version used by the world. */
  environmentVersionId: string;
  /** Digest of the stored environment definition. */
  definitionDigest: string;
  /** Deterministic world seed. */
  seed: string;
  /** Terminal world status. */
  status: "completed" | "abandoned" | "expired";
  /** Number of recorded journal steps. */
  stepCount: number;
  /** Digest of final state. */
  stateDigest: string;
  /** State before the first action. */
  initialState: JsonValue;
  /** State at sealing. */
  finalState: JsonValue;
}
/** Sealed environment evidence with its full ordered journal. */
export interface EnvironmentEvidence extends EnvironmentEvidenceSnapshot {
  /** Complete steps ordered by ordinal. */
  steps: import("../environment/types.js").Step[];
}
/** A local scorer: its pinned definition and the callback bound to it. */
export interface LocalScorer {
  /** Definition to publish and pin; the runner matches it by digest. */
  definition: Extract<ScorerDefinition, { kind: "local_code" }>;
  /** Trusted local code. There is no callback timeout or side-effect cancellation. */
  score(context: ScoreContext): Score | Promise<Score>;
}

/** An artifact reservation as Hue reports it through the reserve, upload and complete steps. */
export interface ArtifactReservation {
  /** Artifact ID. */
  id: string;
  /** Declared file name. */
  filename: string;
  /** Declared content type. */
  declaredContentType: string;
  /** Declared size in bytes. */
  declaredBytes: number;
  /** Declared SHA-256, hex encoded. */
  declaredSha256: string;
  /** Lifecycle state; only `ready` artifacts are verified and downloadable. */
  state: "reserved" | "verifying" | "ready" | "rejected" | "cancelled" | "abandoned";
  /** Progress of the byte copy into Hue storage. */
  copyState: "none" | "started" | "acknowledged";
  /** Verified size once ready, otherwise `null`. */
  verifiedBytes: number | null;
  /** Verified SHA-256 once ready, otherwise `null`. */
  verifiedSha256: string | null;
  /** Why verification failed, or `null`. */
  failureCode: string | null;
}
/** A short-lived storage capability for staging one artifact's bytes. */
export interface ArtifactUpload {
  /** Storage URL that accepts the bytes; the Hue key is never sent there. */
  uploadUrl: string;
  /** HTTP method the capability accepts. */
  method: "PUT";
  /** Headers to send with the bytes; omitted or null means the file content-type only. */
  headers?: Record<string, string> | null;
  /** Capability expiry as an ISO timestamp. */
  expiresAt: string;
}
/** Short-lived execution-scoped MCP connection for one simulated world. */
export interface SimulationMcpCapability {
  /** HTTPS MCP endpoint. */
  url: string;
  /** Attempt-scoped bearer; never persist or expose it. */
  token: string;
  /** Credential expiry timestamp. */
  expiresAt: string;
}

/** Identity and capabilities of one fixed local agent entry point. */
export interface LocalAgentRegistration {
  /** Stable application-selected agent key. */
  key: string;
  /** Display name. */
  name: string;
  /** Application-selected revision of the agent configuration. */
  revision: string;
  /** Supported execution contracts; defaults to environment:v1 in the worker. */
  capabilities?: string[];
  /** Local scorer source digests available in this process. */
  scorerDigests?: string[];
}
/** Server registration and heartbeat timestamps for a local agent. */
export interface RegisteredLocalAgent extends Required<LocalAgentRegistration> {
  /** Registered agent identity. */
  id: string;
  /** Whether Hue permits this registration to receive runs. */
  enabled: boolean;
  /** Latest registration heartbeat, as an ISO timestamp. */
  lastSeenAt: string;
  /** Registration creation timestamp. */
  createdAt: string;
}
/** Queue claim connecting a local run to a pinned experiment. */
export interface LocalAgentClaim {
  /** Claimed queue-run identity. */
  runId: string;
  /** Pinned experiment to execute. */
  experimentId: string;
}
/** A Scenario as listed by {@link EvaluationClient.listCaseConversions}. Extra server fields are ignored. */
export interface CaseConversionSummary {
  /** Scenario ID. */
  id: string;
  /** Scenario domain label. */
  domain: string;
  /** Whether the Scenario has immutable published pins. */
  status: "draft" | "published";
  /** Optimistic-concurrency revision of the Scenario. */
  revision: number;
  /** Creation timestamp. */
  createdAt: string;
  /** Source trace the Scenario was converted from. */
  traceId: string;
}
/** Immutable pins created when a Scenario is published. */
export interface CaseConversionPublication {
  /** Published dataset case. */
  caseId: string;
  /** Dataset holding the published case. */
  datasetId: string;
  /** Frozen dataset version holding the published case. */
  datasetVersionId: string;
  /** Environment identity of the simulated world. */
  environmentId: string;
  /** Immutable environment version the case pins. */
  environmentVersionId: string;
  /** Scorer identity of the published outcome checks. */
  scorerId: string;
  /** Immutable scorer version pinned by the Scenario. */
  scorerVersionId: string;
}
/** A Scenario read by {@link EvaluationClient.getCaseConversion}. Extra server fields are ignored. */
export interface CaseConversion extends Partial<Omit<CaseConversionSummary, "id" | "status">> {
  /** Scenario ID. */
  id: string;
  /** Whether the Scenario has immutable published pins. */
  status: "draft" | "published";
  /** Published pins, or `null` while the Scenario is a draft. */
  publication: CaseConversionPublication | null;
}
