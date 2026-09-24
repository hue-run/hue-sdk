import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import type { HueClient } from "../client.js";
import { HueExportError } from "../transport.js";
import type { HueSpan } from "../types.js";
import { EvaluationClient, HueApiError } from "./client.js";
import { loadEnvironmentEvidence } from "./environment-evidence.js";
import { CheckpointStore } from "./checkpoint.js";
import {
  downloadCaseFiles,
  localOutputFiles,
  OutputFileError,
  stageOutputFiles,
  targetFileRoles,
  uploadOutputFiles,
  type StagedOutputFile,
} from "./files.js";
import { json, uuid } from "./json.js";
import { executableHere, persistedScore, scoreLocally, validateScorerBindings } from "./scorers.js";
import {
  TargetResult,
  type CaseFile,
  type CompleteExecution,
  type Completion,
  type ExperimentCase,
  type JsonValue,
  type LocalFile,
  type LocalScorer,
  type Result,
  type ScoreContext,
  type ScorerVersion,
  type TerminalState,
  type TypedError,
} from "./types.js";

/**
 * Thrown when a case has a started attempt without a saved outcome. The runner never reruns the
 * target; inspect the execution and authorize a new attempt explicitly through `startExecution`.
 */
export class UncertainExecutionError extends Error {
  constructor(
    /** The affected case (experiment item) ID. */
    readonly caseId: string,
    /** The execution without a saved outcome, when known. */
    readonly executionId?: string,
  ) {
    super(
      "Execution has no saved outcome. The target will not run again. Inspect it and explicitly authorize a new attempt through startExecution if required.",
    );
    this.name = "UncertainExecutionError";
  }
}
/** Thrown when a completed target's output is not serializable JSON; the target is not invoked again. */
export class OutcomeSerializationError extends Error {
  constructor(
    /** The execution whose output could not be serialized. */
    readonly executionId: string,
  ) {
    super(
      "Target completed, but its output could not be serialized. Resolve completion explicitly; the runner will not invoke the target again.",
    );
    this.name = "OutcomeSerializationError";
  }
}
/** Thrown when cooperative caller cancellation stops target execution. */
export class TargetCancelledError extends Error {
  constructor() {
    super("Target execution was cancelled");
    this.name = "TargetCancelledError";
  }
}
/** Thrown when the target or world may have committed but acknowledgement is unavailable. */
export class TargetOutcomeUncertainError extends Error {
  constructor(
    /** Execution whose target outcome must never be replayed automatically. */
    readonly executionId: string,
    options?: ErrorOptions,
  ) {
    super(
      `Target outcome or environment finalization is uncertain for execution ${executionId}; resume will not invoke the target again`,
      options,
    );
    this.name = "TargetOutcomeUncertainError";
  }
}
interface RunnerOptions {
  /** Evaluation API client for the same project and origin as `hue`. */
  client: EvaluationClient;
  /** Dedicated directory (mode 0700) for resumable checkpoints; one per experiment or rescore run. */
  checkpointDirectory: string;
  /** Whether outputs, error messages, evidence and explanations are stored in Hue and in checkpoints. Required. */
  persistResultContent: boolean;
  /** Local callbacks bound to `local_code` scorer pins by digest. */
  scorers?: LocalScorer[];
  /** Leave pinned `local_code` versions this process has no binding for to another executor
   * (for example a Hue-operated grading worker that owns the evaluator source) instead of
   * refusing the run. Their IDs are reported in `deferredScorerVersionIds`. */
  deferUnboundLocalScorers?: boolean;
  /** Cases in flight at once, 1–64. Default 1. */
  concurrency?: number;
  /** Deadline for JSON Schema scoring in its worker, 100–60000 ms. Default 2000. */
  schemaTimeoutMillis?: number;
  /** Resolve sealed evidence by execution identity. when_pinned skips known direct cases. */
  environmentEvidence?: "required" | "when_pinned";
  /** Verified input copies and generated files live here; defaults to `<checkpointDirectory>/files`.
   * Generated files are always saved and uploaded: they are the execution's evidence. */
  filesDirectory?: string;
}
/** What {@link RunExperimentOptions.target} receives for one frozen case. */
/**
 * Pinned inputs this process must download. The target receives the agent-visible roles;
 * scorer-only roles (organization templates, evaluator references such as a legal corpus) are
 * fetched only when a bound code evaluator will grade here. A customer running `hue eval` with
 * grading deferred to Hue never receives them.
 */
function neededInputFiles(
  files: CaseFile[] | undefined,
  versions: ScorerVersion[],
  options: RunnerOptions,
): CaseFile[] {
  if (!files?.length) return [];
  const codeEvaluatorRunsHere = versions.some(
    (version) =>
      version.definition.kind === "local_code" && executableHere(version.definition, options),
  );
  return codeEvaluatorRunsHere
    ? files
    : files.filter((file) => (targetFileRoles as readonly string[]).includes(file.role));
}

/** Immutable case context passed to a direct experiment target. */
export interface RunExperimentTargetContext {
  /** Frozen experiment configuration, validated as JSON. */
  config: JsonValue;
  /** The frozen case, cloned before invocation. */
  item: ExperimentCase;
  /** The `hue.experiment.case` span this attempt runs inside. */
  span: HueSpan;
  /** `executionId` identifies this attempt. Deriving an environment run's idempotency
   * key from it keeps a resumed upload bound to the same world. */
  executionId: string;
  /** Verified copies of the case's pinned input files meant for the agent. Evaluator-only
   * organization templates are withheld, as in the managed protocol. */
  files: LocalFile[];
  /** A private scratch directory for this case; return generated files with `withFiles`. */
  outputDirectory: string;
}
/** Options for {@link runExperiment}. */
export interface RunExperimentOptions extends RunnerOptions {
  /** Hue tracing client; each case runs inside a `hue.experiment.case` span. */
  hue: HueClient;
  /** Experiment to run; its dataset version must be frozen. */
  experimentId: string;
  /** Whether each case waits for acknowledged trace export or explicitly omits evidence. Required. */
  traceEvidence:
    | {
        /** Wait for trace and log acknowledgement after the case span ends. */
        mode: "required";
      }
    | {
        /** Store the declared trace ID without evidence. */
        mode: "omit";
        /** Why evidence is omitted, up to 4000 characters. */
        reason: string;
      };
  /**
   * What a case does when evidence is required and its trace or logs are not fully accepted.
   * `"stop"` (the default) keeps the saved outcome, leaves the execution started for recovery and
   * rejects. `"fail_case"` completes the execution as failed instead, with the evidence omitted
   * under the reason `telemetry_not_accepted`, reports it in
   * {@link RunnerReport.telemetryNotAccepted} and goes on with the other cases.
   */
  traceNotAccepted?: "stop" | "fail_case";
  /** Runs the application for one frozen case; return the output, `withFiles(output, files)`
   * when it generated files, or `undefined` when unavailable. */
  target(
    inputs: JsonValue,
    context: RunExperimentTargetContext,
  ): JsonValue | TargetResult | undefined | Promise<JsonValue | TargetResult | undefined>;
}
/** Options for {@link rescore}. */
export interface RescoreOptions extends RunnerOptions {
  /** Evaluation run created with `createEvaluationRun` over existing subjects. */
  runId: string;
}
/** Outcome of a runner call. */
export interface RunnerReport {
  /** Evaluation run the results belong to. */
  runId: string;
  /** Subjects created or scored, in completion order. */
  subjectIds: string[];
  /** Result IDs uploaded by this call. */
  resultIds: string[];
  /** Pins without a local implementation, left pending for their authorized executor. */
  deferredScorerVersionIds: string[];
  /** Cases completed as failed because their telemetry was not accepted, under
   * `traceNotAccepted: "fail_case"`; absent when there were none. */
  telemetryNotAccepted?: TelemetryNotAccepted[];
}

/** Export issue counts, never content: which signal, what happened, the HTTP status when Hue
 * answered, and how many records. */
export interface TelemetryIssueCount {
  /** Signal the records belong to. */
  signal: "traces" | "logs";
  /** `rejected` by Hue, `failed` to deliver, `dropped` from the queue, or an `invalid` record. */
  kind: "rejected" | "failed" | "dropped" | "invalid";
  /** HTTP status when the issue came from Hue's answer. */
  status?: number;
  /** Records affected. */
  count: number;
}

/** A case whose trace or logs were not fully accepted, completed as failed. */
export interface TelemetryNotAccepted {
  /** Experiment case (item) ID. */
  caseId: string;
  /** The case's caller-chosen key. */
  caseKey: string;
  /** Execution completed as failed. */
  executionId: string;
  /** Sanitized issues the transport reported while the case's telemetry was exported. */
  issues: TelemetryIssueCount[];
}

/** Stable reason, and first word of the omission reason, of a case failed for its telemetry. */
export const TELEMETRY_NOT_ACCEPTED = "telemetry_not_accepted";

/** The issues of a failed export, summed by signal, kind and status. */
export function telemetryIssueCounts(error: unknown): TelemetryIssueCount[] {
  if (!(error instanceof HueExportError)) return [];
  const counts = new Map<string, TelemetryIssueCount>();
  for (const issue of error.issues) {
    if (issue.kind === "warning") continue;
    const key = `${issue.signal}:${issue.kind}:${issue.status ?? ""}`;
    const entry = counts.get(key) ?? {
      signal: issue.signal,
      kind: issue.kind,
      ...(issue.status === undefined ? {} : { status: issue.status }),
      count: 0,
    };
    entry.count += issue.count;
    counts.set(key, entry);
  }
  // A zero-count entry, such as the processor's own flush failure, only repeats a signal that
  // already has counted records.
  const counted = new Set([...counts.values()].filter((entry) => entry.count).map((e) => e.signal));
  return [...counts.values()].filter((entry) => entry.count || !counted.has(entry.signal));
}

/** `telemetry_not_accepted`, then the issue counts, for example `traces failed 1 (HTTP 400)`. */
export function describeTelemetryIssues(issues: TelemetryIssueCount[]): string {
  const parts = issues.map(
    (issue) =>
      `${issue.signal} ${issue.kind} ${issue.count}${issue.status === undefined ? "" : ` (HTTP ${issue.status})`}`,
  );
  return parts.length ? `${TELEMETRY_NOT_ACCEPTED}: ${parts.join(", ")}` : TELEMETRY_NOT_ACCEPTED;
}
type SavedResult = {
  payload: Omit<Result, "evaluationItemId"> & { evaluationItemId?: string };
  key: string;
  receipt?: string[];
};
interface Prepared {
  stage: "prepared";
  executionId: string;
  complete: CompleteExecution;
  completion?: Completion;
  scores: SavedResult[];
  /** `not_accepted`: the case is completed as failed with its evidence omitted. */
  exportState: "pending" | "accepted" | "not_accepted";
  /** The issues behind a `not_accepted` export. */
  telemetryIssues?: TelemetryIssueCount[];
}
/** The target finished and its generated files are staged; publication and scoring can resume. */
interface Uploading {
  stage: "uploading";
  executionId: string;
  state: TerminalState;
  hasOutput: boolean;
  output?: JsonValue;
  error?: TypedError;
  files: StagedOutputFile[];
}
type CaseCheckpoint =
  | Prepared
  | Uploading
  | { stage: "starting"; startKey: string; traceExternalId: string }
  | { stage: "running" | "serialization_failed"; executionId: string };

function settings(options: RunnerOptions): number {
  if (
    options.environmentEvidence !== undefined &&
    options.environmentEvidence !== "required" &&
    options.environmentEvidence !== "when_pinned"
  )
    throw new TypeError("environmentEvidence must be required or when_pinned when supplied");
  if (typeof options.persistResultContent !== "boolean")
    throw new TypeError("Choose persistResultContent explicitly: true or false");
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64)
    throw new RangeError("concurrency must be 1–64");
  const timeout = options.schemaTimeoutMillis ?? 2000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60_000)
    throw new RangeError("schemaTimeoutMillis must be 100–60000");
  return concurrency;
}
async function allPages<T>(
  page: (after?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
  maximum = 5000,
): Promise<T[]> {
  const items: T[] = [];
  const cursors = new Set<string>();
  let after: string | undefined;
  do {
    const response = await page(after);
    items.push(...response.items);
    if (items.length > maximum) throw new RangeError(`Runner supports at most ${maximum} items`);
    if (response.nextCursor === null) break;
    after = uuid(response.nextCursor);
    if (cursors.has(after)) throw new Error("API pagination repeated a cursor");
    cursors.add(after);
  } while (after !== undefined);
  return items;
}
async function pool<T>(
  items: T[],
  concurrency: number,
  execute: (item: T) => Promise<void>,
): Promise<void> {
  let position = 0;
  const failures: unknown[] = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (position < items.length && !failures.length) {
        const item = items[position++];
        try {
          await execute(item);
        } catch (error) {
          failures.push(error);
        }
      }
    }),
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(
      failures,
      "Multiple case operations failed; resume uses saved outcomes",
    );
}
async function scoresFor(
  versions: ScorerVersion[],
  context: ScoreContext,
  options: RunnerOptions,
  executionId: string,
  hasEnvironment = true,
): Promise<SavedResult[]> {
  const scores: SavedResult[] = [];
  let environmentUnavailable = false;
  if (
    (options.environmentEvidence === "required" ||
      (options.environmentEvidence === "when_pinned" && hasEnvironment)) &&
    versions.some((version) => executableHere(version.definition, options))
  ) {
    try {
      context = {
        ...context,
        environment: await loadEnvironmentEvidence(options.client, executionId),
      };
    } catch (error) {
      // Generic targets may attach a world independently of the case pin. Preserve
      // required evidence lookups, including the optional 404 for an unpinned case.
      if (!(error instanceof HueApiError && error.status === 404 && !hasEnvironment))
        environmentUnavailable = true;
    }
  }
  for (const version of versions) {
    // Every pin without a local implementation belongs to another executor.
    if (!executableHere(version.definition, options)) continue;
    const score = persistedScore(
      environmentUnavailable && version.definition.kind === "local_code"
        ? { state: "error", error: { type: "EnvironmentEvidenceUnavailable" } }
        : await scoreLocally(version, context, options),
      options.persistResultContent,
    );
    scores.push({
      key: randomUUID(),
      payload: {
        ...score,
        scorerVersionId: version.id,
        ...(version.definition.kind === "local_code"
          ? { sourceDigest: version.definition.sourceDigest }
          : {}),
      },
    });
  }
  return scores;
}
async function uploadScores(
  options: RunnerOptions,
  runId: string,
  scores: SavedResult[],
  save: () => Promise<void>,
  versions: ScorerVersion[],
  resolveConflict?: (score: SavedResult) => Promise<string[] | undefined>,
): Promise<string[]> {
  // A previous SDK may have checkpointed a placeholder for an unknown kind.
  // Keep its evidence intact, but never upload or report it as a local result.
  const local = scores.filter((score) => {
    const pin = versions.find((version) => version.id === score.payload.scorerVersionId);
    if (!pin) throw new Error("Saved result references an unpinned scorer version");
    return executableHere(pin.definition, options);
  });
  for (const score of local) {
    if (score.receipt) continue;
    if (!score.payload.evaluationItemId)
      throw new Error("Scoring requires the acknowledged evaluation item identity");
    try {
      const result = await options.client.submitResults(runId, {
        idempotencyKey: score.key,
        results: [score.payload as Result],
      });
      score.receipt = result.ids;
    } catch (error) {
      const receipt =
        error instanceof HueApiError && error.status === 409
          ? await resolveConflict?.(score)
          : undefined;
      if (!receipt) throw error;
      score.receipt = receipt;
    }
    await save();
  }
  return local.flatMap((score) => score.receipt ?? []);
}

/**
 * Runs every case of a frozen experiment through `target` on this machine, completes each
 * execution, scores it with local scorers and uploads the results, checkpointing so an interrupted
 * run resumes without invoking the target twice.
 *
 * @throws UncertainExecutionError when a case has a started attempt without a saved outcome.
 * @throws OutcomeSerializationError when a completed target's output is not serializable.
 * @throws HueApiError for evaluation API failures; the checkpoint keeps prepared payloads for a retry.
 */
export async function runExperiment(options: RunExperimentOptions): Promise<RunnerReport> {
  const concurrency = settings(options);
  if (!options.traceEvidence || !["required", "omit"].includes(options.traceEvidence.mode))
    throw new TypeError("Choose a trace evidence policy explicitly");
  if (
    options.traceEvidence.mode === "omit" &&
    (!options.traceEvidence.reason?.trim() || options.traceEvidence.reason.length > 4000)
  )
    throw new TypeError("Omitting evidence requires a bounded reason");
  if (options.hue.transport.options.baseUrl !== options.client.baseUrl)
    throw new Error("Telemetry and evaluations must use the same Hue origin");
  const [project, telemetryProject, experiment] = await Promise.all([
    options.client.checkConnection(),
    options.hue.checkConnection(),
    options.client.getExperiment(options.experimentId),
  ]);
  if (project.id !== telemetryProject.id)
    throw new Error("Telemetry and evaluations must use the same Hue project");
  const version = await options.client.getDatasetVersion(experiment.datasetVersionId);
  if (!version.frozenAt || !version.contentDigest)
    throw new Error("Experiment dataset must be frozen");
  const versions = experiment.evaluation.scorerVersions;
  if (!options.deferUnboundLocalScorers) validateScorerBindings(versions, options.scorers);
  const items = await allPages((after) =>
    options.client.listExperimentItems(experiment.id, { after }),
  );
  if (items.length !== experiment.caseCount)
    throw new Error("Frozen experiment case count differs from API items");
  const store = await CheckpointStore.acquire(options.checkpointDirectory, {
    kind: "experiment",
    projectId: project.id,
    baseUrl: options.client.baseUrl,
    experimentId: experiment.id,
    datasetVersionId: version.id,
    datasetDigest: version.contentDigest,
    configDigest: experiment.configDigest,
    pins: versions
      .map(({ id, contentDigest }) => ({ id, contentDigest }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    persistResultContent: options.persistResultContent,
    captureContent: options.hue.captureContent,
    traceEvidence: options.traceEvidence,
    ...(options.environmentEvidence ? { environmentEvidence: options.environmentEvidence } : {}),
  });
  const report: RunnerReport = {
    runId: experiment.evaluation.id,
    subjectIds: [],
    resultIds: [],
    deferredScorerVersionIds: versions
      .filter((version) => !executableHere(version.definition, options))
      .map((version) => version.id),
  };
  try {
    const filesRoot = resolve(options.filesDirectory ?? join(options.checkpointDirectory, "files"));
    const sanitize = (message: string) =>
      message.slice(0, 4000).toWellFormed().replaceAll("\u0000", "");
    const errorPayload = (error: unknown): TypedError => ({
      type: "TargetError",
      ...(options.persistResultContent && error instanceof Error
        ? { message: sanitize(error.message) }
        : {}),
    });
    /** Publish staged files, score with every verified file on disk and save the completion. */
    async function prepare(
      file: string,
      saved: Uploading,
      frozenCase: ExperimentCase,
      caseDirectory: string,
      /** The target's output, in memory when result content is not persisted. */
      output: JsonValue | undefined,
    ): Promise<Prepared> {
      const needed = neededInputFiles(frozenCase.inputFiles, versions, options);
      const inputs = needed.length
        ? await downloadCaseFiles(options.client, needed, join(caseDirectory, "inputs"))
        : [];
      await uploadOutputFiles(options.client, saved.executionId, saved.files, () =>
        store.write(file, saved),
      );
      const outputs = localOutputFiles(saved.files);
      const primary = outputs.find((item) => item.primary);
      const scores = await scoresFor(
        versions,
        {
          inputs: frozenCase.inputs,
          hasExpected: frozenCase.hasExpected,
          ...(frozenCase.hasExpected ? { expected: frozenCase.expected! } : {}),
          metadata: frozenCase.metadata,
          hasOutput: saved.hasOutput,
          ...(saved.hasOutput ? { output: output! } : {}),
          executionState: saved.state,
          ...(inputs.length || outputs.length ? { files: [...inputs, ...outputs] } : {}),
        },
        options,
        saved.executionId,
        Boolean(frozenCase.environmentVersionId),
      );
      const complete: CompleteExecution = {
        idempotencyKey: randomUUID(),
        state: saved.state,
        ...(options.persistResultContent && saved.hasOutput ? { output: output! } : {}),
        ...(saved.error ? { error: saved.error } : {}),
        ...(outputs.length
          ? {
              artifactIds: outputs.map((item) => item.artifactId),
              ...(primary ? { primaryArtifactId: primary.artifactId } : {}),
            }
          : {}),
        traceEvidence: options.traceEvidence.mode,
        ...(options.traceEvidence.mode === "omit"
          ? { omissionReason: options.traceEvidence.reason }
          : {}),
      };
      const prepared: Prepared = {
        stage: "prepared",
        executionId: saved.executionId,
        complete,
        scores,
        exportState: "pending",
      };
      await store.write(file, prepared);
      return prepared;
    }
    await pool(items, concurrency, async (item) => {
      const file = `case-${uuid(item.id)}`;
      const caseDirectory = join(filesRoot, `case-${uuid(item.id)}`);
      let checkpoint = await store.read<CaseCheckpoint>(file);
      if (checkpoint && checkpoint.stage !== "prepared" && checkpoint.stage !== "uploading") {
        if (checkpoint.stage === "serialization_failed")
          throw new OutcomeSerializationError(checkpoint.executionId);
        const execution =
          checkpoint.stage === "starting"
            ? await options.client.startExecution(experiment.id, item.id, {
                idempotencyKey: checkpoint.startKey,
                traceExternalId: checkpoint.traceExternalId,
              })
            : await options.client.getExecution(checkpoint.executionId);
        throw new UncertainExecutionError(item.id, execution.id);
      }
      if (checkpoint?.stage === "uploading") {
        // The target finished and its files are staged: publish and score them without a
        // second invocation. Metadata-only mode discarded the output, so its outcome is lost.
        if (checkpoint.hasOutput && checkpoint.output === undefined)
          throw new UncertainExecutionError(item.id, checkpoint.executionId);
        const frozenCase = await options.client.getExperimentCase(experiment.id, item.id);
        checkpoint = await prepare(file, checkpoint, frozenCase, caseDirectory, checkpoint.output);
      }
      if (!checkpoint) {
        if (item.execution) throw new UncertainExecutionError(item.id, item.execution.id);
        const frozenCase = await options.client.getExperimentCase(experiment.id, item.id);
        if (frozenCase.datasetVersionId !== version.id)
          throw new Error("Case is not from the pinned dataset version");
        // Validate before creating a remote execution. SDK/input failures are not
        // target failures and cannot consume a case's execution slot.
        const targetInputs = json(frozenCase.inputs);
        const targetConfig = json(experiment.config);
        // Pinned input files are verified on disk before an execution exists for the same reason.
        const needed = neededInputFiles(frozenCase.inputFiles, versions, options);
        const inputFiles = needed.length
          ? await downloadCaseFiles(options.client, needed, join(caseDirectory, "inputs"))
          : [];
        const outputDirectory = join(caseDirectory, "work");
        await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
        const failureSequenceBefore = options.hue.transport.getFailureSequence();
        checkpoint = await options.hue.withSpan(
          "hue.experiment.case",
          async (span): Promise<Prepared> => {
            const start = {
              stage: "starting" as const,
              startKey: randomUUID(),
              traceExternalId: span.traceId,
            };
            await store.write(file, start);
            const execution = await options.client.startExecution(experiment.id, item.id, {
              idempotencyKey: start.startKey,
              traceExternalId: span.traceId,
            });
            await store.write(file, { stage: "running", executionId: execution.id });
            let state: TerminalState = "succeeded";
            let output: JsonValue | undefined;
            let generated: TargetResult["files"] | undefined;
            let targetError: unknown;
            try {
              const result = await options.target(targetInputs, {
                config: targetConfig,
                item: structuredClone(frozenCase),
                span,
                executionId: execution.id,
                files: structuredClone(
                  inputFiles.filter((entry) =>
                    (targetFileRoles as readonly string[]).includes(entry.role),
                  ),
                ),
                outputDirectory,
              });
              if (result instanceof TargetResult) {
                output = result.output;
                generated = result.files;
              } else output = result;
            } catch (error) {
              if (error instanceof TargetOutcomeUncertainError) throw error;
              state = error instanceof TargetCancelledError ? "cancelled" : "error";
              targetError = error;
              options.hue.recordError(span.span, error);
            }
            // Output validation is outside the target catch: a successful target never becomes an agent error because upload serialization failed.
            if (output !== undefined) {
              try {
                output = json(output);
              } catch {
                await store.write(file, {
                  stage: "serialization_failed",
                  executionId: execution.id,
                });
                throw new OutcomeSerializationError(execution.id);
              }
            }
            if (output !== undefined) span.setOutput(output);
            let staged: StagedOutputFile[] = [];
            // An empty declared list (a direct case answered only through stdout, or
            // `withFiles(output, [])`) means no generated files, not a missing-files error.
            if (generated !== undefined && generated.length > 0 && state === "succeeded") {
              try {
                staged = await stageOutputFiles(generated, join(caseDirectory, "outputs"));
              } catch (error) {
                // Files the target declared but did not deliver are its own failure; the
                // outcome is still saved instead of leaving the execution uncertain.
                if (!(error instanceof OutputFileError)) throw error;
                state = "error";
                targetError = error;
                options.hue.recordError(span.span, error);
              }
            }
            const uploading: Uploading = {
              stage: "uploading",
              executionId: execution.id,
              state,
              hasOutput: output !== undefined,
              ...(options.persistResultContent && output !== undefined ? { output } : {}),
              ...(state === "error" ? { error: errorPayload(targetError) } : {}),
              files: staged,
            };
            // Without persisted result content a restart cannot reconstruct the outcome; the
            // saved stage then reports the execution as uncertain instead of guessing.
            await store.write(file, uploading);
            return prepare(file, uploading, frozenCase, caseDirectory, output);
          },
          {
            parentContext: ROOT_CONTEXT,
            input: frozenCase.inputs,
            attributes: { "hue.experiment.id": experiment.id, "hue.dataset.case.id": item.id },
          },
        );
        // End root before waiting for both OTLP signals. Export failure leaves the prepared checkpoint intact.
        let exportError: Error | undefined;
        try {
          await options.hue.flush();
          // Another concurrent flush may already have surfaced this failure. OTLP
          // partial acknowledgements do not identify individual rejected records.
          if (options.hue.transport.getFailureSequence() !== failureSequenceBefore)
            throw new HueExportError(
              options.hue.transport
                .getIssues()
                .filter(
                  (issue) => issue.sequence > failureSequenceBefore && issue.kind !== "warning",
                ),
              options.hue.transport.getReport(),
            );
        } catch (error) {
          exportError = error as Error;
        }
        try {
          if (exportError === undefined) {
            checkpoint.exportState = "accepted";
            await store.write(file, checkpoint);
          }
        } catch (error) {
          // The explicitly chosen omission policy can complete without acknowledged telemetry.
          if (options.traceEvidence.mode !== "omit") throw error;
        }
        if (exportError !== undefined && options.traceEvidence.mode !== "omit") {
          if (options.traceNotAccepted !== "fail_case") throw exportError;
          // Required evidence that Hue did not accept fails the case rather than leaving its
          // execution started: the outcome is kept, the evidence is declared omitted. Only an
          // export failure takes this path; a checkpoint that cannot be saved is raised above.
          const failed = checkpoint as Prepared;
          const issues = telemetryIssueCounts(exportError);
          const { traceEvidence: _required, ...complete } = failed.complete;
          if (complete.state === "succeeded") {
            complete.state = "error";
            complete.error = {
              type: "TelemetryNotAccepted",
              ...(options.persistResultContent ? { message: describeTelemetryIssues(issues) } : {}),
            };
            // Local scores were taken of a succeeded outcome that is now a failure.
            failed.scores = [];
          }
          failed.complete = {
            ...complete,
            traceEvidence: "omit",
            omissionReason: describeTelemetryIssues(issues).slice(0, 4000),
          };
          failed.exportState = "not_accepted";
          failed.telemetryIssues = issues;
          await store.write(file, failed);
        }
      }
      const prepared = checkpoint as Prepared;
      await options.client.getExecution(prepared.executionId);
      if (prepared.exportState !== "accepted" && prepared.complete.traceEvidence !== "omit")
        throw new Error(
          "Target outcome is saved but trace export acknowledgement is unavailable. Restore/export the trace or explicitly complete with omitted evidence through the client; never rerun the target.",
        );
      const save = () => store.write(file, prepared);
      if (!prepared.completion) {
        prepared.completion = await options.client.completeExecution(
          prepared.executionId,
          prepared.complete,
        );
        for (const score of prepared.scores)
          score.payload.evaluationItemId = prepared.completion.evaluationItemId;
        await save();
      }
      const results = await uploadScores(
        options,
        experiment.evaluation.id,
        prepared.scores,
        save,
        versions,
      );
      report.subjectIds.push(prepared.completion.subjectId);
      report.resultIds.push(...results);
      if (prepared.exportState === "not_accepted")
        (report.telemetryNotAccepted ??= []).push({
          caseId: item.id,
          caseKey: item.externalKey,
          executionId: prepared.executionId,
          issues: prepared.telemetryIssues ?? [],
        });
    });
    let finish = await store.read<{ key: string }>("finish");
    if (!finish) {
      finish = { key: randomUUID() };
      await store.write("finish", finish);
    }
    await options.client.finishExperiment(experiment.id, finish.key);
    return report;
  } finally {
    await store.release();
  }
}

/** Scores existing immutable subjects; this API has no target callback. */
export async function rescore(options: RescoreOptions): Promise<RunnerReport> {
  const concurrency = settings(options);
  const [project, run] = await Promise.all([
    options.client.checkConnection(),
    options.client.getEvaluationRun(options.runId),
  ]);
  if (!options.deferUnboundLocalScorers)
    validateScorerBindings(run.scorerVersions, options.scorers);
  const items = await allPages((after) => options.client.listEvaluationItems(run.id, { after }));
  if (items.length !== run.itemCount)
    throw new Error("Frozen evaluation run item count differs from API items");
  const store = await CheckpointStore.acquire(options.checkpointDirectory, {
    kind: "rescore",
    projectId: project.id,
    baseUrl: options.client.baseUrl,
    runId: run.id,
    pins: run.scorerVersions
      .map(({ id, contentDigest }) => ({ id, contentDigest }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    persistResultContent: options.persistResultContent,
    ...(options.environmentEvidence ? { environmentEvidence: options.environmentEvidence } : {}),
  });
  const report: RunnerReport = {
    runId: run.id,
    subjectIds: [],
    resultIds: [],
    deferredScorerVersionIds: run.scorerVersions
      .filter((version) => !executableHere(version.definition, options))
      .map((version) => version.id),
  };
  const filesRoot = resolve(options.filesDirectory ?? join(options.checkpointDirectory, "files"));
  try {
    // Grade again can also schedule Hue's built-in checks. Terminal results are immutable:
    // preserve their receipts, including when another executor wins during local scoring.
    const resultKey = (itemId: string, scorerVersionId: string) => `${itemId}:${scorerVersionId}`;
    const receipts = new Map<string, string>();
    const refreshReceipts = async () => {
      const results = await allPages(
        (after) => options.client.listResults(run.id, { after }),
        5000 * 32,
      );
      for (const result of results)
        receipts.set(resultKey(result.itemId, result.scorerVersionId), result.id);
    };
    await refreshReceipts();
    await pool(items, concurrency, async (item) => {
      const file = `item-${uuid(item.id)}`;
      const pending = run.scorerVersions.filter(
        (version) => !receipts.has(resultKey(item.id, version.id)),
      );
      let saved = await store.read<{ scores: SavedResult[] }>(file);
      if (!saved && !pending.some((version) => executableHere(version.definition, options)))
        saved = { scores: [] };
      if (!saved) {
        const subject = await options.client.getSubject(item.subjectId);
        // The frozen manifest holds the case inputs and the target's documents; a code
        // evaluator grades the saved bytes, verified against their pinned identities.
        // Built-ins grade the JSON output alone, so no file — least of all a scorer-only
        // organization template or evaluator reference — is fetched onto this machine for them.
        const codeEvaluatorRunsHere = pending.some(
          (version) =>
            version.definition.kind === "local_code" && executableHere(version.definition, options),
        );
        const files =
          codeEvaluatorRunsHere && subject.files?.length
            ? await downloadCaseFiles(
                options.client,
                subject.files,
                join(filesRoot, `subject-${uuid(item.subjectId)}`),
                subject.primaryArtifactId,
              )
            : [];
        // Older servers omit the world pin; keep their previous behaviour.
        const hasEnvironment =
          subject.environmentVersionId === undefined ? true : subject.environmentVersionId !== null;
        const scores = await scoresFor(
          pending,
          {
            inputs: subject.inputs,
            hasOutput: subject.hasOutput,
            hasExpected: subject.hasExpected,
            ...(subject.hasOutput ? { output: subject.output! } : {}),
            ...(subject.hasExpected ? { expected: subject.expected! } : {}),
            metadata: subject.metadata,
            executionState: subject.executionState,
            ...(files.length ? { files } : {}),
          },
          options,
          subject.executionId,
          hasEnvironment,
        );
        for (const score of scores) score.payload.evaluationItemId = item.id;
        saved = { scores };
        await store.write(file, saved);
      }
      const current = saved;
      for (const score of current.scores) {
        const receipt = receipts.get(resultKey(item.id, score.payload.scorerVersionId));
        if (receipt) score.receipt = [receipt];
      }
      const results = await uploadScores(
        options,
        run.id,
        current.scores,
        () => store.write(file, current),
        run.scorerVersions,
        async (score) => {
          await refreshReceipts();
          const receipt = receipts.get(resultKey(item.id, score.payload.scorerVersionId));
          return receipt ? [receipt] : undefined;
        },
      );
      report.subjectIds.push(item.subjectId);
      report.resultIds.push(
        ...new Set([
          ...results,
          ...run.scorerVersions.flatMap((version) => {
            const receipt = receipts.get(resultKey(item.id, version.id));
            return receipt && executableHere(version.definition, options) ? [receipt] : [];
          }),
        ]),
      );
    });
    return report;
  } finally {
    await store.release();
  }
}
