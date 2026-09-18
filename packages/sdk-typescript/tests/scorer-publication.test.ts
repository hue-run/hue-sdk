import { describe, expect, test } from "bun:test";
import { normalizeScorerDefinitionForPublication } from "../src/evals/scorer-publication.js";

const metric = { name: "quality", type: "boolean" } as const;

describe("scorer publication normalization", () => {
  test.each([
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
