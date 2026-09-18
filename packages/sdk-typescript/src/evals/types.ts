import type { JsonValue } from "../types.js";

export type { JsonValue } from "../types.js";
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface PageOptions {
  after?: string;
  limit?: number;
}
export interface Identity {
  name: string;
  slug: string;
  description?: string;
}
export interface Dataset extends Identity {
  id: string;
  versions: DatasetVersion[];
}
export interface DatasetVersion {
  id: string;
  datasetId: string;
  version: number;
  revision: number;
  frozenAt: string | null;
  contentDigest: string | null;
}
export interface DatasetCase {
  id: string;
  externalKey: string;
  inputs: JsonValue;
  expected?: JsonValue;
  metadata: Record<string, JsonValue>;
  datasetVersionId: string;
  environmentVersionId?: string | null;
}
export interface ExperimentCase extends DatasetCase {
  hasExpected: boolean;
}
export interface CaseWrite {
  expectedRevision: number;
  externalKey: string;
  inputs: JsonValue;
  expected?: JsonValue;
  metadata?: Record<string, JsonValue>;
  environmentVersionId?: string | null;
}
export type MetricDefinition =
  | { name: string; type: "boolean" | "text" }
  | { name: string; type: "number"; min?: number; max?: number }
  | { name: string; type: "category"; categories: string[] };
export type ScorerDefinition =
  | { kind: "builtin"; entry: "hue.exact_match.v1"; config: Record<string, never> }
  | { kind: "builtin"; entry: "hue.includes.v1"; config: { caseSensitive: boolean } }
  | { kind: "builtin"; entry: "hue.json_schema.v1"; config: { schema: JsonValue } }
  | {
      kind: "local_code";
      language: "typescript" | "python";
      entrypoint: string;
      sourceDigest: string;
      metrics: MetricDefinition[];
    }
  | { kind: "manual"; metrics: MetricDefinition[] }
  | { kind: "llm_judge"; config: JudgeConfig; metrics: MetricDefinition[] };
export interface JudgeConfig {
  model: string;
  provider: string;
  rubric: string;
  bindings: { name: string; path: string; required: boolean }[];
  maxOutputTokens: number;
  timeoutMs: number;
  temperature?: number;
}
export interface ResultSummary {
  id: string;
  itemId: string;
  scorerVersionId: string;
  state: "scored" | "error" | "skipped";
}
export interface StoredResult extends ResultSummary {
  runId: string;
  metrics: Metric[];
  explanation: string | null;
  evidence: JsonValue;
  error: TypedError | null;
  sourceDigest: string | null;
}
export interface JudgeJob {
  id: string;
  runId: string;
  itemId: string;
  scorerVersionId: string;
  state: "queued" | "running" | "completed" | "cancelled" | "uncertain";
  chargeState: "unreserved" | "reserved" | "settled" | "uncertain";
  /** Preserved charge state before any separately verified reconciliation. */
  originalChargeState: JudgeJob["chargeState"];
  reservationMicroUsd: number;
  actualMicroUsd: number | null;
  reconciliation: {
    jobId: string;
    actualMicroUsd: number;
    evidenceReference: string;
    reason: string;
    createdAt: string;
  } | null;
  priceQuote: JsonValue;
  receipt: JsonValue;
  workflowId: string | null;
  cancelRequestedAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface JudgeBudget {
  projectId: string;
  configured: boolean;
  /** Credential resolution does not establish provider acceptance or available funds. */
  authentication?: {
    status: "available" | "unavailable";
    method: "api-key" | "oidc" | null;
    verification: "credential_resolution";
  };
  enabled: boolean;
  allowanceMicroUsd: number;
  reservedMicroUsd: number;
  spentMicroUsd: number;
  maxInFlight: number;
  blocked: boolean;
}
export interface Scorer extends Identity {
  id: string;
  versions?: ScorerVersion[];
}
export interface ScorerVersion {
  id: string;
  contentDigest: string;
  definition: ScorerDefinition;
}
export type TerminalState = "succeeded" | "error" | "cancelled";
export interface Execution {
  id: string;
  attempt: number;
  state: TerminalState | "started" | "uncertain";
  traceExternalId: string | null;
  subjectId?: string | null;
}
export interface ExperimentItem {
  id: string;
  externalKey: string;
  hasExpected: boolean;
  execution: Execution | null;
}
export interface EvaluationRun {
  id: string;
  name: string;
  scorerVersions: ScorerVersion[];
  itemCount: number;
  scores: { scored: number; error: number; skipped: number; pending: number };
}
export interface Experiment {
  id: string;
  name: string;
  datasetVersionId: string;
  config: JsonValue;
  configDigest: string;
  evaluation: EvaluationRun;
  caseCount: number;
  finishedAt: string | null;
  execution: {
    unstarted: number;
    started: number;
    uncertain: number;
    succeeded: number;
    error: number;
    cancelled: number;
  };
}
export interface TypedError {
  type: string;
  message?: string;
}
export interface StartExecution {
  idempotencyKey: string;
  traceExternalId?: string;
  previousExecutionId?: string;
  allowUncertainRetry?: boolean;
}
export interface CompleteExecution {
  idempotencyKey: string;
  state: TerminalState;
  output?: JsonValue;
  error?: TypedError;
  expectedTraceRevision?: number;
  traceEvidence?: "required" | "omit";
  omissionReason?: string;
}
export interface Completion {
  executionId: string;
  subjectId: string;
  traceSnapshotId: string | null;
  evaluationItemId: string;
}
export interface EvaluationItem {
  id: string;
  subjectId: string;
  hasOutput: boolean;
  traceSnapshotId: string | null;
}
export interface Subject {
  id: string;
  executionId: string;
  inputs: JsonValue;
  hasOutput: boolean;
  output?: JsonValue;
  hasExpected: boolean;
  expected?: JsonValue;
  metadata: Record<string, JsonValue>;
  contentDigest: string;
  outputEvidence: "available" | "unavailable";
  executionState: TerminalState;
  traceSnapshotId: string | null;
  caseId: string;
  datasetVersionId: string;
  caseExternalKey: string;
  experimentId: string;
  attempt: number;
  traceEvidence: "captured" | "omitted" | "not_requested";
  traceExternalId: string | null;
  omissionReason: string | null;
}
export interface Metric {
  name: string;
  value: boolean | number | string;
  passed?: boolean;
}
export type Score =
  | { state: "scored"; metrics: Metric[]; explanation?: string; evidence?: JsonValue }
  | { state: "error"; error: TypedError }
  | { state: "skipped"; explanation: string };
export type Result = Score & {
  evaluationItemId: string;
  scorerVersionId: string;
  sourceDigest?: string;
};
export interface ScoreContext {
  inputs: JsonValue;
  output?: JsonValue;
  expected?: JsonValue;
  hasOutput: boolean;
  hasExpected: boolean;
  metadata: Record<string, JsonValue>;
  executionState: TerminalState;
  environment?: EnvironmentEvidence;
}
export interface EnvironmentEvidenceSnapshot {
  runId: string;
  executionId: string;
  environmentVersionId: string;
  definitionDigest: string;
  seed: string;
  status: "completed" | "abandoned" | "expired";
  stepCount: number;
  stateDigest: string;
  initialState: JsonValue;
  finalState: JsonValue;
}
export interface EnvironmentEvidence extends EnvironmentEvidenceSnapshot {
  steps: import("../environment/types.js").Step[];
}
export interface LocalScorer {
  definition: Extract<ScorerDefinition, { kind: "local_code" }>;
  /** Trusted local code. There is no callback timeout or side-effect cancellation. */
  score(context: ScoreContext): Score | Promise<Score>;
}
export interface SimulationMcpCapability {
  url: string;
  token: string;
  expiresAt: string;
}
