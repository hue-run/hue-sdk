import type { EvaluationClient } from "./client.js";
import { uuid } from "./json.js";
import type { ExperimentItem, Metric, Subject, TypedError } from "./types.js";

/** Subset of {@link EvaluationClient} used to wait for results. */
export type VerdictClient = Pick<
  EvaluationClient,
  "listEvaluationItems" | "listResults" | "getResult"
>;

/** Options for {@link waitForResults}. */
export interface WaitForResultsOptions {
  /** Evaluation run to read, for example `report.runId` or `experiment.evaluation.id`. */
  runId: string;
  /** Scorer versions every item must have a terminal result for. */
  scorerVersionIds: string[];
  /** Restrict the wait to these subjects, for example `report.subjectIds`; defaults to every item. */
  subjectIds?: string[];
  /** Overall budget in milliseconds; `0` reads once. Default 300000. */
  timeoutMillis?: number;
  /** Delay between reads in milliseconds, 250–60000. Default 2000. */
  pollIntervalMillis?: number;
  /** Stops waiting early; the partial state is returned with `complete: false`. */
  signal?: AbortSignal;
}

/** One stored result joined to its evaluation item. */
export interface VerdictResult {
  /** Result ID. */
  id: string;
  /** Evaluation item the result scores. */
  itemId: string;
  /** Immutable subject behind the item. */
  subjectId: string;
  /** Scorer version that produced it. */
  scorerVersionId: string;
  /** Terminal outcome state. */
  state: "scored" | "error" | "skipped";
  /** Reported metrics; empty unless scored. */
  metrics: Metric[];
  /** Scorer explanation, or `null` when absent or not persisted. */
  explanation: string | null;
  /** Scorer failure for `state: "error"`, otherwise `null`. */
  error: TypedError | null;
  /** Whether Hue recorded that the evaluator does not apply to the case; such a result counts as
   * neither a pass nor a failure. Absent means false. */
  notApplicable?: boolean;
  /** What a not-applicable evaluator needs that the case lacks, such as `outcome_criteria`. */
  requires?: string;
}

/** Outcome of {@link waitForResults}. */
export interface VerdictResults {
  /** Whether every item has a terminal result for every pinned scorer version. */
  complete: boolean;
  /** Evaluation items that were waited for. */
  items: {
    /** Evaluation item ID. */
    id: string;
    /** Immutable subject behind the item. */
    subjectId: string;
  }[];
  /** Terminal results read so far, one per item and scorer version. */
  results: VerdictResult[];
}

const TERMINAL = new Set(["scored", "error", "skipped"]);

async function allPages<T>(
  page: (after?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const items: T[] = [];
  const cursors = new Set<string>();
  let after: string | undefined;
  do {
    const response = await page(after);
    items.push(...response.items);
    if (items.length > 5000) throw new RangeError("Runs of more than 5000 items are unsupported");
    if (response.nextCursor === null) break;
    after = uuid(response.nextCursor);
    if (cursors.has(after)) throw new Error("API pagination repeated a cursor");
    cursors.add(after);
  } while (after !== undefined);
  return items;
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Polls an evaluation run until every item has a terminal (`scored`, `error` or `skipped`)
 * result for every pinned scorer version, or the budget elapses. Hue-executed pins such as
 * `world_outcome` are graded after the world seals, so a caller that wants verdicts waits here
 * after the runner returns. A timeout or abort returns the partial state with `complete: false`.
 */
export async function waitForResults(
  client: VerdictClient,
  options: WaitForResultsOptions,
): Promise<VerdictResults> {
  const timeout = options.timeoutMillis ?? 300_000;
  const interval = options.pollIntervalMillis ?? 2_000;
  if (!Number.isInteger(timeout) || timeout < 0) throw new RangeError("timeoutMillis must be ≥ 0");
  if (!Number.isInteger(interval) || interval < 250 || interval > 60_000)
    throw new RangeError("pollIntervalMillis must be 250–60000");
  const wanted = options.subjectIds ? new Set(options.subjectIds) : undefined;
  const pins = [...new Set(options.scorerVersionIds)];
  const deadline = Date.now() + timeout;
  for (;;) {
    const listed = await allPages((after) => client.listEvaluationItems(options.runId, { after }));
    const items = listed
      .filter((item) => !wanted || wanted.has(item.subjectId))
      .map((item) => ({ id: item.id, subjectId: item.subjectId }));
    const summaries = await allPages((after) => client.listResults(options.runId, { after }));
    const found = new Map<string, string>();
    for (const summary of summaries)
      if (TERMINAL.has(summary.state))
        found.set(`${summary.itemId}:${summary.scorerVersionId}`, summary.id);
    const missing = items.flatMap((item) =>
      pins.filter((pin) => !found.has(`${item.id}:${pin}`)).map((pin) => `${item.id}:${pin}`),
    );
    const complete = missing.length === 0 && (wanted === undefined || items.length === wanted.size);
    if (complete || Date.now() >= deadline || options.signal?.aborted) {
      const subjects = new Map(items.map((item) => [item.id, item.subjectId]));
      const results: VerdictResult[] = [];
      for (const item of items)
        for (const pin of pins) {
          const id = found.get(`${item.id}:${pin}`);
          if (!id) continue;
          const stored = await client.getResult(id);
          // Only Hue's own flag marks a result not applicable; its evidence alone never does.
          const notApplicable = stored.notApplicable === true;
          const evidence = stored.evidence as { requires?: unknown } | null;
          results.push({
            id: stored.id,
            itemId: stored.itemId,
            subjectId: subjects.get(stored.itemId) ?? item.subjectId,
            scorerVersionId: stored.scorerVersionId,
            state: stored.state,
            metrics: stored.state === "scored" ? stored.metrics : [],
            explanation: stored.explanation ?? null,
            error: stored.error ?? null,
            notApplicable,
            ...(notApplicable && typeof evidence?.requires === "string"
              ? { requires: evidence.requires }
              : {}),
          });
        }
      return { complete, items, results };
    }
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())), options.signal);
  }
}

/** Per-case verdict derived from every pinned scorer's result. */
export interface CaseVerdict {
  /** Frozen experiment-case identity. */
  caseId: string;
  /** Caller-chosen case key. */
  externalKey: string;
  /** Subject scored for the case, or `null` before completion. */
  subjectId: string | null;
  /** `passed` and `failed` are scored verdicts; `error`, `skipped` and `pending` carry no verdict.
   * Only the evaluators that apply to the case decide it; one where none applies is an error. */
  state: "passed" | "failed" | "error" | "skipped" | "pending";
  /** True only for `state: "passed"`: every scored metric of an applicable pin passed and no
   * applicable pin errored or is missing. */
  passed: boolean;
  /** Pinned scorer versions Hue recorded as not applicable to the case; always set by
   * {@link summarizeVerdicts}. */
  notApplicable?: string[];
  /** Reported metrics across pinned scorers, in result order. */
  metrics: (Metric & {
    /** Scorer version that reported the metric. */
    scorerVersionId: string;
  })[];
  /** Explanations of results that did not pass, when persisted. */
  explanations: string[];
  /** Error types of errored results. */
  errors: string[];
}

/** Per-case rows and totals for one evaluation run. */
export interface VerdictSummary {
  /** One row per experiment case, in experiment order. */
  cases: CaseVerdict[];
  /** Case counts by verdict state. */
  totals: {
    /** All cases. */
    cases: number;
    /** Cases whose every metric passed. */
    passed: number;
    /** Cases with a failing metric. */
    failed: number;
    /** Cases with a scorer error. */
    error: number;
    /** Cases whose pins were all skipped. */
    skipped: number;
    /** Cases still missing a result. */
    pending: number;
    /** Results of evaluators that do not apply to their case, a case can have several; always
     * set by {@link summarizeVerdicts}. */
    notApplicable?: number;
  };
}

/** Whether one reported metric counts as passing: an explicit `passed`, else a true boolean. */
export function metricPassed(metric: Metric): boolean {
  if (metric.passed !== undefined) return metric.passed;
  return typeof metric.value === "boolean" ? metric.value : true;
}

/**
 * Groups results by experiment case. Cases link to results through their execution's subject;
 * pass `subjects` when the items do not carry `execution.subjectId`. A case passes when every
 * pinned scorer scored it without a failing metric.
 */
export function summarizeVerdicts(
  results: VerdictResults,
  options: {
    /** Experiment items, in the order rows should appear. */
    experimentItems: Pick<ExperimentItem, "id" | "externalKey" | "execution">[];
    /** Scorer versions every case needs a result for; defaults to the versions seen in `results`. */
    scorerVersionIds?: string[];
    /** Subject to case links for servers that omit `execution.subjectId`. */
    subjects?: Pick<Subject, "id" | "caseId">[];
  },
): VerdictSummary {
  const pins = new Set(
    options.scorerVersionIds ?? results.results.map((result) => result.scorerVersionId),
  );
  const subjectByCase = new Map<string, string>();
  for (const subject of options.subjects ?? []) subjectByCase.set(subject.caseId, subject.id);
  for (const item of options.experimentItems)
    if (item.execution?.subjectId) subjectByCase.set(item.id, item.execution.subjectId);
  const cases: CaseVerdict[] = options.experimentItems.map((item) => {
    const subjectId = subjectByCase.get(item.id) ?? null;
    const own = subjectId ? results.results.filter((result) => result.subjectId === subjectId) : [];
    const metrics = own.flatMap((result) =>
      result.metrics.map((metric) => ({ ...metric, scorerVersionId: result.scorerVersionId })),
    );
    // An evaluator that does not apply to the case neither passes nor fails it.
    const inapplicable = own.filter((result) => result.notApplicable);
    const applicable = own.filter((result) => !result.notApplicable);
    const errors = applicable.filter((result) => result.state === "error");
    const scored = applicable.filter((result) => result.state === "scored");
    const failing = scored.filter((result) => !result.metrics.every(metricPassed));
    const missing = [...pins].some((pin) => !own.some((result) => result.scorerVersionId === pin));
    const noneApplies = !missing && own.length > 0 && !applicable.length;
    const state: CaseVerdict["state"] =
      errors.length || noneApplies
        ? "error"
        : failing.length
          ? "failed"
          : missing || !own.length
            ? "pending"
            : scored.length
              ? "passed"
              : "skipped";
    const requires = [
      ...new Set(inapplicable.flatMap((result) => (result.requires ? [result.requires] : []))),
    ];
    return {
      caseId: item.id,
      externalKey: item.externalKey,
      subjectId,
      state,
      passed: state === "passed",
      notApplicable: inapplicable.map((result) => result.scorerVersionId),
      metrics,
      explanations: [
        ...(noneApplies
          ? [
              `No pinned evaluator applies to this case${requires.length ? ` (they need ${requires.join(" or ")})` : ""}; pin one that grades it`,
            ]
          : []),
        ...applicable
          .filter((result) => result.state !== "scored" || failing.includes(result))
          .map((result) => result.explanation)
          .filter((explanation): explanation is string => !!explanation),
      ],
      errors: errors.map((result) => result.error?.type ?? "ScorerError"),
    };
  });
  const totals = {
    cases: cases.length,
    passed: 0,
    failed: 0,
    error: 0,
    skipped: 0,
    pending: 0,
    notApplicable: 0,
  };
  for (const item of cases) {
    totals[item.state]++;
    totals.notApplicable += item.notApplicable?.length ?? 0;
  }
  return { cases, totals };
}

/** Per-case change between a baseline and the current run, keyed by case key. */
export interface VerdictComparison {
  /** Cases that pass now but did not in the baseline. */
  improvements: number;
  /** Cases that passed in the baseline but do not now. */
  regressions: number;
  /** Cases with the same verdict, including cases present in only one run. */
  unchanged: number;
  /** Every case key seen in either run. */
  cases: {
    /** Caller-chosen case key. */
    externalKey: string;
    /** Baseline state, or `missing`. */
    before: CaseVerdict["state"] | "missing";
    /** Current state, or `missing`. */
    after: CaseVerdict["state"] | "missing";
    /** Direction of the change. */
    change: "improved" | "regressed" | "unchanged";
  }[];
}

/** Diffs the current summary against a baseline by case key. */
export function compareVerdicts(
  current: VerdictSummary,
  baseline: VerdictSummary,
): VerdictComparison {
  const before = new Map(baseline.cases.map((item) => [item.externalKey, item.state]));
  const after = new Map(current.cases.map((item) => [item.externalKey, item.state]));
  const keys = [...new Set([...after.keys(), ...before.keys()])];
  const comparison: VerdictComparison = {
    improvements: 0,
    regressions: 0,
    unchanged: 0,
    cases: [],
  };
  for (const externalKey of keys) {
    const previous = before.get(externalKey) ?? "missing";
    const next = after.get(externalKey) ?? "missing";
    const change =
      previous !== "missing" && next !== "missing" && previous !== "passed" && next === "passed"
        ? "improved"
        : previous === "passed" && next !== "passed" && next !== "missing"
          ? "regressed"
          : "unchanged";
    comparison[
      change === "improved" ? "improvements" : change === "regressed" ? "regressions" : "unchanged"
    ]++;
    comparison.cases.push({ externalKey, before: previous, after: next, change });
  }
  return comparison;
}

/** Options for {@link collectExperimentVerdicts}. */
export interface CollectExperimentVerdictsOptions
  extends Omit<WaitForResultsOptions, "runId" | "scorerVersionIds"> {
  /** Experiment whose evaluation run is read. */
  experimentId: string;
}

/** Verdicts of one experiment: its run identity, the raw results and the per-case summary. */
export interface ExperimentVerdicts {
  /** Experiment ID. */
  experimentId: string;
  /** The experiment's evaluation run. */
  runId: string;
  /** Scorer versions pinned by the experiment. */
  scorerVersionIds: string[];
  /** Raw results and completeness. */
  results: VerdictResults;
  /** Per-case rows and totals. */
  summary: VerdictSummary;
}

/**
 * Reads an experiment's pinned scorer versions, waits for its results and summarizes them per
 * case. Subject links fall back to reading each subject when the items omit them.
 */
export async function collectExperimentVerdicts(
  client: VerdictClient &
    Pick<EvaluationClient, "getExperiment" | "listExperimentItems" | "getSubject">,
  options: CollectExperimentVerdictsOptions,
): Promise<ExperimentVerdicts> {
  const experiment = await client.getExperiment(options.experimentId);
  const scorerVersionIds = experiment.evaluation.scorerVersions.map((version) => version.id);
  const { experimentId: _experimentId, ...wait } = options;
  const results = await waitForResults(client, {
    ...wait,
    runId: experiment.evaluation.id,
    scorerVersionIds,
  });
  const experimentItems = await allPages((after) =>
    client.listExperimentItems(experiment.id, { after }),
  );
  const linked = new Set(
    experimentItems.map((item) => item.execution?.subjectId).filter((id): id is string => !!id),
  );
  const subjects: Pick<Subject, "id" | "caseId">[] = [];
  for (const item of results.items)
    if (!linked.has(item.subjectId)) {
      const subject = await client.getSubject(item.subjectId);
      subjects.push({ id: subject.id, caseId: subject.caseId });
    }
  return {
    experimentId: experiment.id,
    runId: experiment.evaluation.id,
    scorerVersionIds,
    results,
    summary: summarizeVerdicts(results, { experimentItems, scorerVersionIds, subjects }),
  };
}
