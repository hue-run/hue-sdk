import { randomUUID } from "node:crypto";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import type { HueClient } from "../client.js";
import { HueExportError } from "../transport.js";
import type { HueSpan } from "../types.js";
import { EvaluationClient } from "./client.js";
import { loadEnvironmentEvidence } from "./environment-evidence.js";
import { CheckpointStore } from "./checkpoint.js";
import { json, uuid } from "./json.js";
import { persistedScore, scoreLocally, validateScorerBindings } from "./scorers.js";
import type {
  CompleteExecution,
  Completion,
  ExperimentCase,
  JsonValue,
  LocalScorer,
  Result,
  ScoreContext,
  ScorerVersion,
  TerminalState,
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
export class TargetCancelledError extends Error {
  constructor() {
    super("Target execution was cancelled");
    this.name = "TargetCancelledError";
  }
}
export class TargetOutcomeUncertainError extends Error {
  constructor(
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
  /** Cases in flight at once, 1–16. Default 1. */
  concurrency?: number;
  /** Deadline for JSON Schema scoring in its worker, 100–60000 ms. Default 2000. */
  schemaTimeoutMillis?: number;
  environmentEvidence?: "required";
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
  /** Runs the application for one frozen case; return the output, or `undefined` when unavailable. */
  target(
    inputs: JsonValue,
    context: { config: JsonValue; item: ExperimentCase; span: HueSpan; executionId: string },
  ): JsonValue | undefined | Promise<JsonValue | undefined>;
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
  /** `llm_judge` and `manual` pins left pending for hosted or human scoring. */
  deferredScorerVersionIds: string[];
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
  exportState: "pending" | "accepted";
}
type CaseCheckpoint =
  | Prepared
  | { stage: "starting"; startKey: string; traceExternalId: string }
  | { stage: "running" | "serialization_failed"; executionId: string };

function settings(options: RunnerOptions): number {
  if (options.environmentEvidence !== undefined && options.environmentEvidence !== "required")
    throw new TypeError("environmentEvidence must be required when supplied");
  if (typeof options.persistResultContent !== "boolean")
    throw new TypeError("Choose persistResultContent explicitly: true or false");
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new RangeError("concurrency must be 1–16");
  const timeout = options.schemaTimeoutMillis ?? 2000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60_000)
    throw new RangeError("schemaTimeoutMillis must be 100–60000");
  return concurrency;
}
async function allPages<T>(
  page: (after?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const items: T[] = [];
  const cursors = new Set<string>();
  let after: string | undefined;
  do {
    const response = await page(after);
    items.push(...response.items);
    if (items.length > 5000) throw new RangeError("Runner supports at most 5000 items");
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
): Promise<SavedResult[]> {
  const scores: SavedResult[] = [];
  let environmentUnavailable = false;
  if (options.environmentEvidence === "required") {
    try {
      context = {
        ...context,
        environment: await loadEnvironmentEvidence(options.client, executionId),
      };
    } catch {
      environmentUnavailable = true;
    }
  }
  for (const version of versions) {
    // Hosted/manual pins remain pending for their authorized executor.
    if (version.definition.kind === "llm_judge" || version.definition.kind === "manual") continue;
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
): Promise<void> {
  for (const score of scores) {
    if (score.receipt) continue;
    if (!score.payload.evaluationItemId)
      throw new Error("Scoring requires the acknowledged evaluation item identity");
    const result = await options.client.submitResults(runId, {
      idempotencyKey: score.key,
      results: [score.payload as Result],
    });
    score.receipt = result.ids;
    await save();
  }
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
  validateScorerBindings(versions, options.scorers);
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
      .filter((version) => ["llm_judge", "manual"].includes(version.definition.kind))
      .map((version) => version.id),
  };
  try {
    await pool(items, concurrency, async (item) => {
      const file = `case-${uuid(item.id)}`;
      let checkpoint = await store.read<CaseCheckpoint>(file);
      if (checkpoint && checkpoint.stage !== "prepared") {
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
      if (!checkpoint) {
        if (item.execution) throw new UncertainExecutionError(item.id, item.execution.id);
        const frozenCase = await options.client.getExperimentCase(experiment.id, item.id);
        if (frozenCase.datasetVersionId !== version.id)
          throw new Error("Case is not from the pinned dataset version");
        const targetInputs = json(frozenCase.inputs);
        const targetConfig = json(experiment.config);
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
            let targetError: unknown;
            try {
              output = await options.target(targetInputs, {
                config: targetConfig,
                item: structuredClone(frozenCase),
                span,
                executionId: execution.id,
              });
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
            const scores = await scoresFor(
              versions,
              {
                inputs: frozenCase.inputs,
                hasExpected: frozenCase.hasExpected,
                ...(frozenCase.hasExpected ? { expected: frozenCase.expected! } : {}),
                metadata: frozenCase.metadata,
                hasOutput: output !== undefined,
                ...(output !== undefined ? { output } : {}),
                executionState: state,
              },
              options,
              execution.id,
            );
            const complete: CompleteExecution = {
              idempotencyKey: randomUUID(),
              state,
              ...(options.persistResultContent && output !== undefined ? { output } : {}),
              ...(state === "error"
                ? {
                    error: {
                      type: "TargetError",
                      ...(options.persistResultContent && targetError instanceof Error
                        ? {
                            message: targetError.message
                              .slice(0, 4000)
                              .toWellFormed()
                              .replaceAll("\u0000", ""),
                          }
                        : {}),
                    },
                  }
                : {}),
              traceEvidence: options.traceEvidence.mode,
              ...(options.traceEvidence.mode === "omit"
                ? { omissionReason: options.traceEvidence.reason }
                : {}),
            };
            const prepared: Prepared = {
              stage: "prepared",
              executionId: execution.id,
              complete,
              scores,
              exportState: "pending",
            };
            await store.write(file, prepared);
            return prepared;
          },
          {
            parentContext: ROOT_CONTEXT,
            input: frozenCase.inputs,
            attributes: { "hue.experiment.id": experiment.id, "hue.dataset.case.id": item.id },
          },
        );
        // End root before waiting for both OTLP signals. Export failure leaves the prepared checkpoint intact.
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
          checkpoint.exportState = "accepted";
          await store.write(file, checkpoint);
        } catch (error) {
          // The explicitly chosen omission policy can complete without acknowledged telemetry.
          if (options.traceEvidence.mode !== "omit") throw error;
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
      await uploadScores(options, experiment.evaluation.id, prepared.scores, save);
      report.subjectIds.push(prepared.completion.subjectId);
      report.resultIds.push(...prepared.scores.flatMap((score) => score.receipt ?? []));
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
      .filter((version) => ["llm_judge", "manual"].includes(version.definition.kind))
      .map((version) => version.id),
  };
  try {
    await pool(items, concurrency, async (item) => {
      const file = `item-${uuid(item.id)}`;
      let saved = await store.read<{ scores: SavedResult[] }>(file);
      if (!saved) {
        const subject = await options.client.getSubject(item.subjectId);
        const scores = await scoresFor(
          run.scorerVersions,
          {
            inputs: subject.inputs,
            hasOutput: subject.hasOutput,
            hasExpected: subject.hasExpected,
            ...(subject.hasOutput ? { output: subject.output! } : {}),
            ...(subject.hasExpected ? { expected: subject.expected! } : {}),
            metadata: subject.metadata,
            executionState: subject.executionState,
          },
          options,
          subject.executionId,
        );
        for (const score of scores) score.payload.evaluationItemId = item.id;
        saved = { scores };
        await store.write(file, saved);
      }
      const current = saved;
      await uploadScores(options, run.id, current.scores, () => store.write(file, current));
      report.subjectIds.push(item.subjectId);
      report.resultIds.push(...current.scores.flatMap((score) => score.receipt ?? []));
    });
    return report;
  } finally {
    await store.release();
  }
}
