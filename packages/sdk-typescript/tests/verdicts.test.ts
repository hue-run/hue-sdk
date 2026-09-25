import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  collectExperimentVerdicts,
  compareVerdicts,
  HueApiError,
  metricPassed,
  summarizeVerdicts,
  waitForResults,
  type EvaluationClient,
  type ExperimentItem,
  type StoredResult,
  type VerdictResults,
  type VerdictSummary,
} from "../src/evals.js";

/** In-memory evaluation run whose results become visible after a number of reads. */
function run(options: { resultsAfterPolls?: number; itemCount?: number; pins?: number } = {}) {
  const runId = randomUUID();
  const pins = Array.from({ length: options.pins ?? 1 }, () => randomUUID());
  const items = Array.from({ length: options.itemCount ?? 2 }, () => ({
    id: randomUUID(),
    subjectId: randomUUID(),
    hasOutput: true,
    traceSnapshotId: null,
  }));
  const stored = new Map<string, StoredResult>();
  const calls = { items: 0, results: 0, reads: 0 };
  function record(itemId: string, scorerVersionId: string, value: Partial<StoredResult>) {
    const result: StoredResult = {
      id: randomUUID(),
      runId,
      itemId,
      scorerVersionId,
      state: "scored",
      metrics: [{ name: "resolved", value: true, passed: true }],
      explanation: "The refund was recorded.",
      evidence: null,
      error: null,
      sourceDigest: null,
      ...value,
    };
    stored.set(result.id, result);
    return result;
  }
  const client = {
    listEvaluationItems: async () => {
      calls.items++;
      return { items, nextCursor: null };
    },
    listResults: async () => {
      calls.results++;
      if (calls.results <= (options.resultsAfterPolls ?? 0)) return { items: [], nextCursor: null };
      return {
        items: [...stored.values()].map(({ id, itemId, scorerVersionId, state }) => ({
          id,
          itemId,
          scorerVersionId,
          state,
        })),
        nextCursor: null,
      };
    },
    getResult: async (id: string) => {
      calls.reads++;
      const found = stored.get(id);
      if (!found) throw new HueApiError(404);
      return found;
    },
  } as unknown as EvaluationClient;
  return { runId, pins, items, client, calls, record };
}

describe("waitForResults", () => {
  test("waits until deferred results appear for every item and pin", async () => {
    const fixture = run({ resultsAfterPolls: 2 });
    for (const item of fixture.items) fixture.record(item.id, fixture.pins[0]!, {});
    const results = await waitForResults(fixture.client, {
      runId: fixture.runId,
      scorerVersionIds: fixture.pins,
      timeoutMillis: 10_000,
      pollIntervalMillis: 250,
    });
    expect(results.complete).toBe(true);
    expect(fixture.calls.results).toBe(3);
    expect(results.items).toEqual(fixture.items.map(({ id, subjectId }) => ({ id, subjectId })));
    expect(results.results).toHaveLength(2);
    expect(results.results[0]).toMatchObject({
      itemId: fixture.items[0]!.id,
      subjectId: fixture.items[0]!.subjectId,
      scorerVersionId: fixture.pins[0],
      state: "scored",
      metrics: [{ name: "resolved", value: true, passed: true }],
      explanation: "The refund was recorded.",
      error: null,
    });
  });

  test("returns the partial state when the budget elapses or the caller aborts", async () => {
    const fixture = run({ resultsAfterPolls: 1000, pins: 2 });
    const started = Date.now();
    const timedOut = await waitForResults(fixture.client, {
      runId: fixture.runId,
      scorerVersionIds: fixture.pins,
      timeoutMillis: 600,
      pollIntervalMillis: 250,
    });
    expect(timedOut.complete).toBe(false);
    expect(timedOut.results).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(fixture.calls.results).toBeGreaterThanOrEqual(2);

    const once = await waitForResults(fixture.client, {
      runId: fixture.runId,
      scorerVersionIds: fixture.pins,
      timeoutMillis: 0,
    });
    expect(once.complete).toBe(false);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const aborted = await waitForResults(fixture.client, {
      runId: fixture.runId,
      scorerVersionIds: fixture.pins,
      timeoutMillis: 60_000,
      pollIntervalMillis: 5_000,
      signal: controller.signal,
    });
    expect(aborted.complete).toBe(false);
  });

  test("restricts the wait to the requested subjects and needs every pin per item", async () => {
    const fixture = run({ pins: 2 });
    const [first, second] = fixture.items;
    fixture.record(first!.id, fixture.pins[0]!, {});
    let results = await waitForResults(fixture.client, {
      runId: fixture.runId,
      scorerVersionIds: fixture.pins,
      subjectIds: [first!.subjectId],
      timeoutMillis: 0,
    });
    expect(results.complete).toBe(false);
    expect(results.items).toHaveLength(1);
    fixture.record(first!.id, fixture.pins[1]!, { state: "skipped", explanation: "n/a" });
    results = await waitForResults(fixture.client, {
      runId: fixture.runId,
      scorerVersionIds: fixture.pins,
      subjectIds: [first!.subjectId],
      timeoutMillis: 0,
    });
    expect(results.complete).toBe(true);
    expect(results.results.map((result) => result.state)).toEqual(["scored", "skipped"]);
    expect(results.results[1]!.metrics).toEqual([]);
    results = await waitForResults(fixture.client, {
      runId: fixture.runId,
      scorerVersionIds: fixture.pins,
      subjectIds: [first!.subjectId, second!.subjectId],
      timeoutMillis: 0,
    });
    expect(results.complete).toBe(false);
    expect(results.results).toHaveLength(2);
  });

  test("rejects invalid budgets before reading", async () => {
    const fixture = run();
    await expect(
      waitForResults(fixture.client, {
        runId: fixture.runId,
        scorerVersionIds: fixture.pins,
        pollIntervalMillis: 10,
      }),
    ).rejects.toThrow("pollIntervalMillis must be 250–60000");
    await expect(
      waitForResults(fixture.client, {
        runId: fixture.runId,
        scorerVersionIds: fixture.pins,
        timeoutMillis: -1,
      }),
    ).rejects.toThrow("timeoutMillis must be ≥ 0");
    expect(fixture.calls.items).toBe(0);
  });
});

function item(externalKey: string, subjectId: string | null): ExperimentItem {
  return {
    id: randomUUID(),
    externalKey,
    hasExpected: true,
    execution: subjectId
      ? { id: randomUUID(), attempt: 1, state: "succeeded", traceExternalId: null, subjectId }
      : null,
  };
}

describe("summarizeVerdicts", () => {
  test("derives passed, failed, error, skipped and pending rows with totals", () => {
    const pin = randomUUID();
    const passed = item("passed", randomUUID());
    const failed = item("failed", randomUUID());
    const errored = item("errored", randomUUID());
    const skipped = item("skipped", randomUUID());
    const pending = item("pending", randomUUID());
    const unstarted = item("unstarted", null);
    const subject = (value: ExperimentItem) => value.execution!.subjectId!;
    const results: VerdictResults = {
      complete: false,
      items: [],
      results: [
        {
          id: randomUUID(),
          itemId: randomUUID(),
          subjectId: subject(passed),
          scorerVersionId: pin,
          state: "scored",
          metrics: [
            { name: "resolved", value: true },
            { name: "steps", value: 3 },
            { name: "tone", value: "polite" },
          ],
          explanation: "Done.",
          error: null,
        },
        {
          id: randomUUID(),
          itemId: randomUUID(),
          subjectId: subject(failed),
          scorerVersionId: pin,
          state: "scored",
          metrics: [{ name: "resolved", value: false }],
          explanation: "No refund was recorded.",
          error: null,
        },
        {
          id: randomUUID(),
          itemId: randomUUID(),
          subjectId: subject(errored),
          scorerVersionId: pin,
          state: "error",
          metrics: [],
          explanation: null,
          error: { type: "JudgeUnavailable" },
        },
        {
          id: randomUUID(),
          itemId: randomUUID(),
          subjectId: subject(skipped),
          scorerVersionId: pin,
          state: "skipped",
          metrics: [],
          explanation: "Environment incomplete.",
          error: null,
        },
      ],
    };
    const summary = summarizeVerdicts(results, {
      experimentItems: [passed, failed, errored, skipped, pending, unstarted],
      scorerVersionIds: [pin],
    });
    expect(summary.cases.map((row) => [row.externalKey, row.state, row.passed])).toEqual([
      ["passed", "passed", true],
      ["failed", "failed", false],
      ["errored", "error", false],
      ["skipped", "skipped", false],
      ["pending", "pending", false],
      ["unstarted", "pending", false],
    ]);
    expect(summary.cases[0]!.metrics).toEqual([
      { name: "resolved", value: true, scorerVersionId: pin },
      { name: "steps", value: 3, scorerVersionId: pin },
      { name: "tone", value: "polite", scorerVersionId: pin },
    ]);
    expect(summary.cases[0]!.explanations).toEqual([]);
    expect(summary.cases[1]!.explanations).toEqual(["No refund was recorded."]);
    expect(summary.cases[2]!.errors).toEqual(["JudgeUnavailable"]);
    expect(summary.cases[3]!.explanations).toEqual(["Environment incomplete."]);
    expect(summary.cases[5]!.subjectId).toBeNull();
    expect(summary.totals).toEqual({
      cases: 6,
      passed: 1,
      failed: 1,
      error: 1,
      skipped: 1,
      pending: 2,
      notApplicable: 0,
    });
  });

  test("a missing pin keeps a case pending and explicit passed flags win", () => {
    const [first, second] = [randomUUID(), randomUUID()];
    const scored = item("scored", randomUUID());
    const results: VerdictResults = {
      complete: false,
      items: [],
      results: [
        {
          id: randomUUID(),
          itemId: randomUUID(),
          subjectId: scored.execution!.subjectId!,
          scorerVersionId: first,
          state: "scored",
          metrics: [{ name: "score", value: 0.4, passed: true }],
          explanation: null,
          error: null,
        },
      ],
    };
    expect(
      summarizeVerdicts(results, { experimentItems: [scored], scorerVersionIds: [first, second] })
        .cases[0]!.state,
    ).toBe("pending");
    expect(
      summarizeVerdicts(results, { experimentItems: [scored], scorerVersionIds: [first] }).cases[0]!
        .state,
    ).toBe("passed");
    expect(metricPassed({ name: "x", value: true, passed: false })).toBe(false);
    expect(metricPassed({ name: "x", value: false })).toBe(false);
    expect(metricPassed({ name: "x", value: 0 })).toBe(true);
    expect(metricPassed({ name: "x", value: "any" })).toBe(true);
  });

  test("links cases through supplied subjects when items omit the subject", () => {
    const pin = randomUUID();
    const unlinked = item("unlinked", null);
    const subjectId = randomUUID();
    const results: VerdictResults = {
      complete: true,
      items: [{ id: randomUUID(), subjectId }],
      results: [
        {
          id: randomUUID(),
          itemId: randomUUID(),
          subjectId,
          scorerVersionId: pin,
          state: "scored",
          metrics: [{ name: "resolved", value: true }],
          explanation: null,
          error: null,
        },
      ],
    };
    expect(summarizeVerdicts(results, { experimentItems: [unlinked] }).cases[0]!.state).toBe(
      "pending",
    );
    expect(
      summarizeVerdicts(results, {
        experimentItems: [unlinked],
        subjects: [{ id: subjectId, caseId: unlinked.id }],
      }).cases[0],
    ).toMatchObject({ state: "passed", subjectId });
  });
});

describe("evaluators that do not apply", () => {
  const notApplicable = {
    state: "skipped" as const,
    metrics: [],
    explanation: "Not applicable: the case has no outcome criteria",
    evidence: {
      state: "not_applicable",
      entry: "hue.outcome_assertions.v3",
      requires: "outcome_criteria",
    },
  };

  test("only Hue's notApplicable flag marks a result not applicable", async () => {
    const { runId, pins, items, client, record } = run({ itemCount: 2 });
    record(items[0]!.id, pins[0]!, { ...notApplicable, notApplicable: true });
    // The same skipped result and evidence without the flag, as a submitted result would read.
    record(items[1]!.id, pins[0]!, notApplicable);
    const results = await waitForResults(client, { runId, scorerVersionIds: pins });
    const byItem = new Map(results.results.map((result) => [result.itemId, result]));
    expect(byItem.get(items[0]!.id)).toMatchObject({
      notApplicable: true,
      requires: "outcome_criteria",
    });
    expect(byItem.get(items[1]!.id)!.notApplicable).toBe(false);
    expect(byItem.get(items[1]!.id)).not.toHaveProperty("requires");
  });

  test("the flag never turns an errored or failing result into a pass", async () => {
    const { runId, pins, items, client, record } = run({ itemCount: 2, pins: 2 });
    const flagged = { notApplicable: true, evidence: notApplicable.evidence };
    for (const value of items) record(value.id, pins[0]!, {});
    record(items[0]!.id, pins[1]!, {
      ...flagged,
      state: "error",
      metrics: [],
      error: { type: "ScorerError" },
    });
    record(items[1]!.id, pins[1]!, {
      ...flagged,
      metrics: [{ name: "resolved", value: false, passed: false }],
    });
    const results = await waitForResults(client, { runId, scorerVersionIds: pins });
    expect(results.results.filter((result) => result.notApplicable)).toEqual([]);
    expect(results.results.some((result) => "requires" in result)).toBe(false);
    const cases = [item("errored", items[0]!.subjectId), item("failing", items[1]!.subjectId)];
    const summary = summarizeVerdicts(results, { experimentItems: cases, scorerVersionIds: pins });
    expect(summary.cases.map((row) => [row.state, row.notApplicable])).toEqual([
      ["error", []],
      ["failed", []],
    ]);
    // A hand-built result gets the same treatment from summarizeVerdicts itself.
    const forged = summarizeVerdicts(
      {
        ...results,
        results: results.results.map((result) => ({ ...result, notApplicable: true })),
      },
      { experimentItems: cases, scorerVersionIds: pins },
    );
    expect(forged.cases.map((row) => row.state)).toEqual(["error", "failed"]);
    expect(forged.totals.notApplicable).toBe(0);
  });

  test("a mixed set passes each case on its own evaluator; none applying is an error", () => {
    const [outcome, rubric] = [randomUUID(), randomUUID()];
    const traced = item("trace-built", randomUUID());
    const authored = item("hand-authored", randomUUID());
    const neither = item("neither", randomUUID());
    const incomplete = item("incomplete-world", randomUUID());
    const subject = (value: ExperimentItem) => value.execution!.subjectId!;
    const scored = (value: ExperimentItem, pin: string) => ({
      id: randomUUID(),
      itemId: randomUUID(),
      subjectId: subject(value),
      scorerVersionId: pin,
      state: "scored" as const,
      metrics: [{ name: pin === outcome ? "outcome" : "rubric", value: true }],
      explanation: null,
      error: null,
    });
    const skipped = (value: ExperimentItem, pin: string, flagged: boolean) => ({
      id: randomUUID(),
      itemId: randomUUID(),
      subjectId: subject(value),
      scorerVersionId: pin,
      state: "skipped" as const,
      metrics: [],
      explanation: flagged ? "Not applicable" : "Environment incomplete.",
      error: null,
      notApplicable: flagged,
      ...(flagged ? { requires: pin === outcome ? "outcome_criteria" : "conversion_rubric" } : {}),
    });
    const summary = summarizeVerdicts(
      {
        complete: true,
        items: [],
        results: [
          scored(traced, outcome),
          skipped(traced, rubric, true),
          skipped(authored, outcome, true),
          scored(authored, rubric),
          skipped(neither, outcome, true),
          skipped(neither, rubric, true),
          // A genuine skip for an incomplete environment is still a skip, not n/a.
          skipped(incomplete, outcome, false),
          skipped(incomplete, rubric, false),
        ],
      },
      {
        experimentItems: [traced, authored, neither, incomplete],
        scorerVersionIds: [outcome, rubric],
      },
    );
    expect(summary.cases.map((row) => [row.externalKey, row.state, row.notApplicable])).toEqual([
      ["trace-built", "passed", [rubric]],
      ["hand-authored", "passed", [outcome]],
      ["neither", "error", [outcome, rubric]],
      ["incomplete-world", "skipped", []],
    ]);
    expect(summary.cases[2]!.explanations).toEqual([
      "No pinned evaluator applies to this case (they need outcome_criteria or conversion_rubric); pin one that grades it",
    ]);
    expect(summary.cases[2]!.errors).toEqual([]);
    expect(summary.cases[3]!.explanations).toEqual([
      "Environment incomplete.",
      "Environment incomplete.",
    ]);
    expect(summary.totals).toEqual({
      cases: 4,
      passed: 2,
      failed: 0,
      error: 1,
      skipped: 1,
      pending: 0,
      notApplicable: 4,
    });
  });
});

describe("compareVerdicts", () => {
  test("counts improvements, regressions and unchanged cases by key", () => {
    const summary = (states: Record<string, VerdictSummary["cases"][number]["state"]>) => ({
      cases: Object.entries(states).map(([externalKey, state]) => ({
        caseId: randomUUID(),
        externalKey,
        subjectId: null,
        state,
        passed: state === "passed",
        metrics: [],
        explanations: [],
        errors: [],
      })),
      totals: { cases: 0, passed: 0, failed: 0, error: 0, skipped: 0, pending: 0 },
    });
    const comparison = compareVerdicts(
      summary({ a: "passed", b: "failed", c: "passed", d: "error", added: "passed" }),
      summary({ a: "failed", b: "passed", c: "passed", d: "pending", removed: "passed" }),
    );
    expect(comparison).toMatchObject({ improvements: 1, regressions: 1, unchanged: 4 });
    expect(comparison.cases).toEqual([
      { externalKey: "a", before: "failed", after: "passed", change: "improved" },
      { externalKey: "b", before: "passed", after: "failed", change: "regressed" },
      { externalKey: "c", before: "passed", after: "passed", change: "unchanged" },
      { externalKey: "d", before: "pending", after: "error", change: "unchanged" },
      { externalKey: "added", before: "missing", after: "passed", change: "unchanged" },
      { externalKey: "removed", before: "passed", after: "missing", change: "unchanged" },
    ]);
  });
});

describe("collectExperimentVerdicts", () => {
  test("reads the pins, waits for results and links cases, falling back to subjects", async () => {
    const fixture = run({ itemCount: 2 });
    const experimentId = randomUUID();
    const [linked, unlinked] = fixture.items;
    const items = [item("linked", linked!.subjectId), item("unlinked", null)];
    fixture.record(linked!.id, fixture.pins[0]!, {});
    fixture.record(unlinked!.id, fixture.pins[0]!, {
      metrics: [{ name: "resolved", value: false }],
      explanation: "Missed.",
    });
    const subjectReads: string[] = [];
    const client = {
      ...fixture.client,
      getExperiment: async (id: string) => {
        expect(id).toBe(experimentId);
        return {
          id,
          evaluation: {
            id: fixture.runId,
            scorerVersions: fixture.pins.map((pin) => ({ id: pin })),
          },
        };
      },
      listExperimentItems: async () => ({ items, nextCursor: null }),
      getSubject: async (id: string) => {
        subjectReads.push(id);
        return { id, caseId: items[1]!.id };
      },
    } as unknown as EvaluationClient;
    const verdicts = await collectExperimentVerdicts(client, { experimentId, timeoutMillis: 0 });
    expect(verdicts).toMatchObject({
      experimentId,
      runId: fixture.runId,
      scorerVersionIds: fixture.pins,
      results: { complete: true },
    });
    expect(subjectReads).toEqual([unlinked!.subjectId]);
    expect(verdicts.summary.cases.map((row) => [row.externalKey, row.state])).toEqual([
      ["linked", "passed"],
      ["unlinked", "failed"],
    ]);
    expect(verdicts.summary.totals).toMatchObject({ cases: 2, passed: 1, failed: 1 });
  });
});
