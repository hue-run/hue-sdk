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

describe("scorer publication normalization", () => {
  test.each([
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
