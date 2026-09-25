import { describe, expect, test } from "bun:test";
import { normalizeScorerDefinitionForPublication } from "../src/evals/scorer-publication.js";
import type { ScorerDefinition } from "../src/evals.js";

const metric = { name: "quality", type: "boolean" } as const;
const worldOutcome = {
  kind: "world_outcome",
  entry: "hue.conversion_outcome.v1",
  metrics: [
    "completed_run",
    "saved_draft",
    "correct_destination",
    "content",
    "unrelated_preserved",
    "process_constraints",
    "task_success",
  ].map((name) => ({ name, type: "boolean" as const })),
} satisfies ScorerDefinition;

const conversionOutcomeV2 = {
  kind: "world_outcome",
  entry: "hue.conversion_outcome.v2",
  metrics: [
    "completed_run",
    "saved_draft",
    "correct_destination",
    "recipient",
    "thread",
    "subject",
    "content",
    "unrelated_preserved",
    "process_constraints",
    "task_success",
  ].map((name) => ({ name, type: "boolean" as const })),
} satisfies ScorerDefinition;
const assertionMetrics = [
  { name: "task_success", type: "boolean" as const },
  ...["assertions_passed", "assertions_failed", "advisory_failed", "agent_mistakes"].map(
    (name) => ({ name, type: "number" as const, min: 0 }),
  ),
];
const judgeMetrics = ["judges_passed", "judges_failed", "judges_advisory"].map((name) => ({
  name,
  type: "number" as const,
  min: 0,
}));
const judge = {
  model: "anthropic/claude-fable-5.1",
  provider: "anthropic",
  template: "a".repeat(64),
  samples: 3,
  temperature: 0,
  maxOutputTokens: 1024,
  timeoutMs: 60_000,
};
const outcomeAssertionsV3 = {
  kind: "world_outcome",
  entry: "hue.outcome_assertions.v3",
  metrics: [...assertionMetrics, ...judgeMetrics],
  config: { judge },
} satisfies ScorerDefinition;

describe("scorer publication normalization", () => {
  test.each([
    [
      "conversion outcome v2 metrics",
      { kind: "world_outcome", entry: "hue.conversion_outcome.v2" },
      conversionOutcomeV2,
    ],
    [
      "outcome assertions v2 metrics",
      { kind: "world_outcome", entry: "hue.outcome_assertions.v2" },
      { kind: "world_outcome", entry: "hue.outcome_assertions.v2", metrics: assertionMetrics },
    ],
    [
      "outcome assertions v3 metrics beside its judge pin",
      { kind: "world_outcome", entry: "hue.outcome_assertions.v3", config: { judge } },
      outcomeAssertionsV3,
    ],
    [
      "world outcome metrics",
      { kind: "world_outcome", entry: "hue.conversion_outcome.v1" },
      worldOutcome,
    ],
    [
      "exact-match config",
      { kind: "builtin", entry: "hue.exact_match.v1" },
      { kind: "builtin", entry: "hue.exact_match.v1", config: {} },
    ],
    [
      "includes config",
      { kind: "builtin", entry: "hue.includes.v1" },
      { kind: "builtin", entry: "hue.includes.v1", config: { caseSensitive: true } },
    ],
    [
      "includes case sensitivity",
      { kind: "builtin", entry: "hue.includes.v1", config: {} },
      { kind: "builtin", entry: "hue.includes.v1", config: { caseSensitive: true } },
    ],
    [
      "judge defaults",
      {
        kind: "llm_judge",
        config: {
          model: "openai/gpt-5",
          provider: "openai",
          rubric: "  Assess quality  ",
          bindings: [{ name: "output", path: "/output" }],
        },
        metrics: [metric],
      },
      {
        kind: "llm_judge",
        config: {
          model: "openai/gpt-5",
          provider: "openai",
          rubric: "Assess quality",
          bindings: [{ name: "output", path: "/output", required: true }],
          maxOutputTokens: 1024,
          timeoutMs: 60_000,
        },
        metrics: [metric],
      },
    ],
  ])("applies the server's %s", (_name, input, expected) => {
    expect(normalizeScorerDefinitionForPublication(input) as unknown).toEqual(expected);
  });

  test("world outcome publication requires the pinned entry and exact ordered boolean metrics", () => {
    expect(normalizeScorerDefinitionForPublication(worldOutcome)).toEqual(worldOutcome);
    for (const invalid of [
      { ...worldOutcome, metrics: [] },
      { ...worldOutcome, metrics: worldOutcome.metrics.slice(1) },
      { ...worldOutcome, metrics: [...worldOutcome.metrics].reverse() },
      {
        ...worldOutcome,
        metrics: worldOutcome.metrics.map((metric) => ({ ...metric, type: "text" })),
      },
      { ...worldOutcome, entry: "hue.future.v1" },
      { ...worldOutcome, sourceDigest: "a".repeat(64) },
    ])
      expect(() => normalizeScorerDefinitionForPublication(invalid)).toThrow(TypeError);
  });

  test("newer outcome entries require their own metrics and the v3 judge pin", () => {
    expect(normalizeScorerDefinitionForPublication(conversionOutcomeV2)).toEqual(
      conversionOutcomeV2,
    );
    expect(normalizeScorerDefinitionForPublication(outcomeAssertionsV3)).toEqual(
      outcomeAssertionsV3,
    );
    for (const invalid of [
      // v1's seven metrics are not v2's ten.
      { ...conversionOutcomeV2, metrics: worldOutcome.metrics },
      { ...outcomeAssertionsV3, metrics: assertionMetrics },
      { kind: "world_outcome", entry: "hue.outcome_assertions.v3" },
      { ...outcomeAssertionsV3, config: {} },
      { ...outcomeAssertionsV3, config: { judge: { ...judge, template: "not-a-digest" } } },
      { ...outcomeAssertionsV3, config: { judge: { ...judge, samples: 10 } } },
      { ...outcomeAssertionsV3, config: { judge: { ...judge, temperature: 3 } } },
      { ...outcomeAssertionsV3, config: { judge: { ...judge, rubric: "extra" } } },
      { ...conversionOutcomeV2, config: { judge } },
      { kind: "world_outcome", entry: "hue.outcome_assertions.v2", config: { judge } },
    ])
      expect(() => normalizeScorerDefinitionForPublication(invalid)).toThrow(TypeError);
  });

  test("rejects server-only scorer kinds instead of guessing their contract", () => {
    expect(() =>
      normalizeScorerDefinitionForPublication({
        kind: "document_verifier",
        config: {
          sourceDigest: "a".repeat(64),
          imageDigest: `sha256:${"b".repeat(64)}`,
          render: "required",
        },
      }),
    ).toThrow("Unsupported or invalid SDK scorer definition");
  });
});
