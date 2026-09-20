import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createConversionOutcomeScorer,
  conversionOutcomeScorerDefinition,
  scoreConversionOutcome,
  scoreLocally,
  sourceDigest,
  type ScoreContext,
} from "../src/evals.js";
import { sealedEvidence } from "./fixtures/environment-evidence.js";

test("the public scorer registration pins the exact portable executable source", async () => {
  const source = await readFile(
    new URL("../src/evals/conversion-outcome-core.mjs", import.meta.url),
  );
  const scorer = createConversionOutcomeScorer();
  expect(scorer.definition.sourceDigest).toBe(sourceDigest(source));
  expect(scorer.definition).toEqual(conversionOutcomeScorerDefinition);
  expect(
    scorer.score({
      inputs: {},
      hasOutput: false,
      hasExpected: false,
      metadata: {},
      executionState: "succeeded",
    }),
  ).toEqual({ state: "error", error: { type: "ConversionEnvironmentEvidenceRequired" } });
});

test("mutable caller scorer definitions cannot alter future registrations", () => {
  const first = createConversionOutcomeScorer();
  first.definition.metrics[0]!.name = "changed";
  expect(createConversionOutcomeScorer().definition.metrics[0]!.name).toBe("completed_run");
  const saved = structuredClone(conversionOutcomeScorerDefinition);
  try {
    conversionOutcomeScorerDefinition.sourceDigest = "changed";
    conversionOutcomeScorerDefinition.metrics[0]!.name = "changed";
    expect(createConversionOutcomeScorer().definition).toEqual(saved);
  } finally {
    Object.assign(conversionOutcomeScorerDefinition, saved);
  }
});

test("the standalone provider rubric matches its exact published evaluator", async () => {
  const context = JSON.parse(
    await readFile(new URL("./fixtures/scenario-outcome.json", import.meta.url), "utf8"),
  ) as ScoreContext;
  const scorer = createConversionOutcomeScorer();
  expect(scorer.definition.sourceDigest).toBe(
    "27d096eedc80fbfb747b849c891762f76165ef76429727b0a93ec7dbebaf7b05",
  );
  const result = scoreConversionOutcome(context);
  expect(result.state).toBe("scored");
  if (result.state !== "scored") throw new Error("Expected quality metrics");
  expect(result.metrics.every((metric) => metric.passed)).toBe(true);
  expect(
    await scoreLocally(
      { id: randomUUID(), contentDigest: "a".repeat(64), definition: scorer.definition },
      context,
      { scorers: [scorer] },
    ),
  ).toEqual(result);
});

function incompleteContext(): ScoreContext {
  return {
    inputs: {},
    hasOutput: false,
    hasExpected: false,
    metadata: {},
    executionState: "succeeded",
    environment: {
      ...sealedEvidence(),
      validity: "environment_incomplete",
      coverageGap: {
        provider: "gmail",
        operation: "create_draft",
        code: "standalone_draft_unsupported",
        args: {},
        description: "Standalone draft behavior is not implemented.",
        reportedAt: "2026-09-18T08:00:00.000Z",
        reportedBy: { kind: "project_key", id: randomUUID() },
      },
    },
  };
}

test.each(["succeeded", "error"] as const)(
  "direct and registered conversion scoring skip authoritative gaps before grading: %s",
  async (executionState) => {
    const context = { ...incompleteContext(), executionState };
    const scorer = createConversionOutcomeScorer();
    const expected = {
      state: "skipped" as const,
      explanation: "Environment incomplete: provider behavior is not implemented.",
    };
    expect(scoreConversionOutcome(context)).toEqual(expected);
    expect(scorer.score(context)).toEqual(expected);
    expect(
      await scoreLocally(
        { id: randomUUID(), contentDigest: "a".repeat(64), definition: scorer.definition },
        context,
        { scorers: [scorer] },
      ),
    ).toEqual(expected);
  },
);

test.each([
  "missing_gap",
  "unassessed_gap",
  "invalid_reporter",
  "extra_field",
  "invalid_date",
  "invalid_unicode",
  "oversized_args",
  "deep_args",
  "incomplete_journal",
  "open_world",
])("direct conversion scoring rejects malformed coverage evidence: %s", async (fault) => {
  const context = incompleteContext();
  const environment = context.environment!;
  if (fault === "missing_gap") environment.coverageGap = null;
  if (fault === "unassessed_gap") environment.validity = "not_assessed";
  if (fault === "invalid_reporter") environment.coverageGap!.reportedBy.id = "invalid";
  if (fault === "extra_field") Object.assign(environment.coverageGap!, { approved: true });
  if (fault === "invalid_date") environment.coverageGap!.reportedAt = "yesterday";
  if (fault === "invalid_unicode") environment.coverageGap!.description = "invalid\u0000text";
  if (fault === "oversized_args") environment.coverageGap!.args = { body: "x".repeat(16000) };
  if (fault === "deep_args")
    for (let depth = 0; depth < 34; depth++)
      environment.coverageGap!.args = { nested: environment.coverageGap!.args };
  if (fault === "incomplete_journal") environment.stepCount++;
  if (fault === "open_world") Object.assign(environment, { status: "open" });
  expect(scoreConversionOutcome(context)).toEqual({
    state: "error",
    error: { type: "ConversionOutcomeEvidenceInvalid" },
  });
  const scorer = createConversionOutcomeScorer();
  expect(
    (
      await scoreLocally(
        { id: randomUUID(), contentDigest: "a".repeat(64), definition: scorer.definition },
        context,
        { scorers: [scorer] },
      )
    ).state,
  ).toBe("error");
});

test("the direct coverage gate accepts the SDK's full argument byte boundary", async () => {
  const context = incompleteContext();
  context.environment!.coverageGap!.args = { body: "x".repeat(15989) };
  expect(Buffer.byteLength(JSON.stringify(context.environment!.coverageGap!.args))).toBe(16000);
  const scorer = createConversionOutcomeScorer();
  expect(scoreConversionOutcome(context)).toEqual(
    await scoreLocally(
      { id: randomUUID(), contentDigest: "a".repeat(64), definition: scorer.definition },
      context,
      { scorers: [scorer] },
    ),
  );
  expect(scoreConversionOutcome(context).state).toBe("skipped");
});

function successfulContext(service: "gmail" | "slack"): ScoreContext {
  const environment = sealedEvidence(randomUUID(), 2);
  const initial = {
    messages: {
      parent: { id: "parent", threadId: "thread" },
      "channel:1": { text: "Question" },
    },
    drafts: {},
    users: { actor: { name: "Author" } },
  };
  environment.initialState = { collections: initial };
  environment.finalState = {
    collections: {
      ...initial,
      messages: {
        ...initial.messages,
        ...(service === "gmail"
          ? {
              reply: {
                id: "reply",
                threadId: "thread",
                inReplyTo: "parent",
                to: ["recipient@example.test"],
                subject: "Re: Question",
                labelIds: ["DRAFT"],
                body: "Approved reply",
              },
            }
          : {}),
      },
      drafts: {
        draft:
          service === "gmail"
            ? { id: "draft", messageId: "reply" }
            : {
                id: "draft",
                channel_id: "channel",
                thread_ts: "1",
                user: "actor",
                message: "Approved reply",
              },
      },
    },
  };
  environment.steps[0]!.action = "read_context";
  environment.steps[1]!.action = "save_reply";
  environment.steps[1]!.mutated = true;
  environment.steps[1]!.effects = [
    { kind: "created", collection: "drafts", entityId: "draft", fields: ["id"] },
  ];
  return {
    inputs: { task: "Save a reply" },
    hasOutput: true,
    output: "Done",
    hasExpected: true,
    expected: {
      kind: "conversion_outcome_v1",
      service,
      goal: {
        ...(service === "gmail"
          ? {
              parentMessageId: "parent",
              threadId: "thread",
              to: ["recipient@example.test"],
              subject: "Question",
            }
          : { channelId: "channel", threadTs: "1", actorId: "actor" }),
        content: { mode: "equals", text: "Approved reply" },
      },
    },
    metadata: {},
    executionState: "succeeded",
    environment,
  };
}

test.each(["gmail", "slack"] as const)(
  "sealed %s outcome succeeds through both direct and registered callbacks",
  async (service) => {
    const context = successfulContext(service);
    const direct = scoreConversionOutcome(context);
    expect(direct.state).toBe("scored");
    if (direct.state !== "scored") throw new Error("Expected a scored outcome");
    expect(direct.metrics).toHaveLength(7);
    expect(direct.metrics.every((metric) => metric.passed === true)).toBe(true);
    const scorer = createConversionOutcomeScorer();
    expect(
      await scoreLocally(
        { id: randomUUID(), contentDigest: "a".repeat(64), definition: scorer.definition },
        context,
        { scorers: [scorer] },
      ),
    ).toEqual(direct);
    // Reordered reads and repair updates do not replace the reviewed outcome contract.
    const modified = structuredClone(context);
    const steps = modified.environment!.steps;
    steps.reverse();
    steps.push({
      ...structuredClone(steps[0]!),
      id: randomUUID(),
      invocationId: randomUUID(),
      action: "repair_draft",
      effects: [{ kind: "updated", collection: "drafts", entityId: "draft", fields: ["body"] }],
    });
    steps.forEach((step, ordinal) => {
      step.ordinal = ordinal;
    });
    modified.environment!.stepCount = steps.length;
    expect(scoreConversionOutcome(modified)).toEqual(direct);
  },
);

test("a claimed success without a journaled save or with unrelated changes fails quality", () => {
  const context = successfulContext("gmail");
  context.environment!.steps[1]!.effects = [];
  const score = scoreConversionOutcome(context);
  expect(score.state).toBe("scored");
  if (score.state !== "scored") throw new Error("Expected quality metrics");
  expect(score.metrics.find((metric) => metric.name === "saved_draft")?.passed).toBe(false);
  expect(score.metrics.find((metric) => metric.name === "task_success")?.passed).toBe(false);
  const unrelated = successfulContext("gmail");
  const world = unrelated.environment!.finalState as {
    collections: { users: Record<string, unknown> };
  };
  world.collections.users = {};
  const changed = scoreConversionOutcome(unrelated);
  if (changed.state !== "scored") throw new Error("Expected quality metrics");
  expect(changed.metrics.find((metric) => metric.name === "unrelated_preserved")?.passed).toBe(
    false,
  );
});
