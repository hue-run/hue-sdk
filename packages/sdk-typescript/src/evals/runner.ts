import { randomUUID } from "node:crypto";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import type { HueClient } from "../client.js";
import { HueExportError } from "../transport.js";
import type { HueSpan } from "../types.js";
import { EvaluationClient } from "./client.js";
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

export class UncertainExecutionError extends Error {
  constructor(
    readonly caseId: string,
    readonly executionId?: string,
  ) {
    super(
      "Execution has no saved outcome. The target will not run again. Inspect it and explicitly authorize a new attempt through startExecution if required.",
    );
    this.name = "UncertainExecutionError";
  }
}
export class OutcomeSerializationError extends Error {
  constructor(readonly executionId: string) {
    super(
      "Target completed, but its output could not be serialized. Resolve completion explicitly; the runner will not invoke the target again.",
    );
    this.name = "OutcomeSerializationError";
  }
}
interface RunnerOptions {
  client: EvaluationClient;
  checkpointDirectory: string;
  persistResultContent: boolean;
  scorers?: LocalScorer[];
  concurrency?: number;
  schemaTimeoutMillis?: number;
}
export interface RunExperimentOptions extends RunnerOptions {
  hue: HueClient;
  experimentId: string;
  traceEvidence: { mode: "required" } | { mode: "omit"; reason: string };
  target(
    inputs: JsonValue,
    context: { config: JsonValue; item: ExperimentCase; span: HueSpan },
  ): JsonValue | undefined | Promise<JsonValue | undefined>;
}
export interface RescoreOptions extends RunnerOptions {
  runId: string;
}
export interface RunnerReport {
  runId: string;
  subjectIds: string[];
  resultIds: string[];
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
): Promise<SavedResult[]> {
  const scores: SavedResult[] = [];
  for (const version of versions) {
    // Hosted/manual pins remain pending for their authorized executor.
    if (version.definition.kind === "llm_judge" || version.definition.kind === "manual") continue;
    const score = persistedScore(
      await scoreLocally(version, context, options),
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
              output = await options.target(json(frozenCase.inputs), {
                config: json(experiment.config),
                item: structuredClone(frozenCase),
                span,
              });
            } catch (error) {
              state = "error";
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
