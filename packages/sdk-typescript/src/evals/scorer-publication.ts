import { z } from "zod";
import { json, digest } from "./json.js";
import type { JsonValue, ScorerDefinition } from "./types.js";

const metricName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/);
const metric = z.discriminatedUnion("type", [
  z.strictObject({ name: metricName, type: z.literal("boolean") }),
  z.strictObject({ name: metricName, type: z.literal("text") }),
  z.strictObject({
    name: metricName,
    type: z.literal("number"),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  }),
  z.strictObject({
    name: metricName,
    type: z.literal("category"),
    categories: z.array(z.string()).min(1),
  }),
]);
const metrics = z.array(metric).min(1);
const worldOutcomeMetrics = [
  "completed_run",
  "saved_draft",
  "correct_destination",
  "content",
  "unrelated_preserved",
  "process_constraints",
  "task_success",
].map((name) => ({ name, type: "boolean" as const }));
/** `hue.conversion_outcome.v2`: v1's rubric with the destination reported as `recipient`,
 * `thread` and `subject`. */
const conversionOutcomeV2Metrics = [
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
].map((name) => ({ name, type: "boolean" as const }));
/** `hue.outcome_assertions.v2`'s counts; `.v3` adds the judge counts. */
const outcomeAssertionMetrics = [
  { name: "task_success", type: "boolean" as const },
  ...["assertions_passed", "assertions_failed", "advisory_failed", "agent_mistakes"].map(
    (name) => ({ name, type: "number" as const, min: 0 }),
  ),
];
const outcomeAssertionV3Metrics = [
  ...outcomeAssertionMetrics,
  ...["judges_passed", "judges_failed", "judges_advisory"].map((name) => ({
    name,
    type: "number" as const,
    min: 0,
  })),
];
/** The judge pin a `hue.outcome_assertions.v3` version carries; every field is required. */
const outcomeJudgeConfig = z.strictObject({
  model: z.string().min(1).max(200),
  provider: z.string().min(1).max(64),
  template: z.string().regex(/^[a-f0-9]{64}$/),
  samples: z.number().int().min(1).max(9),
  temperature: z.number().min(0).max(2),
  maxOutputTokens: z.number().int().min(1).max(32_000),
  timeoutMs: z.number().int().min(1_000).max(300_000),
});
/** A Hue-executed entry whose metrics are fixed by the entry itself. */
const fixedMetrics = (fixed: z.infer<typeof metrics>) =>
  metrics
    .default(fixed)
    .refine(
      (value) => digest(value) === digest(fixed),
      "World outcome metrics are fixed by the pinned entry",
    );
const jsonValue = z.custom<JsonValue>((value) => {
  try {
    json(value);
    return true;
  } catch {
    return false;
  }
});
const judgeConfig = z.strictObject({
  model: z.string(),
  provider: z.string(),
  rubric: z.string().trim(),
  bindings: z.array(
    z.strictObject({
      name: z.string(),
      path: z.string(),
      required: z.boolean().default(true),
    }),
  ),
  maxOutputTokens: z.number().default(1024),
  timeoutMs: z.number().default(60_000),
  temperature: z.number().optional(),
});

/** Closed client-side publication contract. The server remains authoritative for
 * full validation; this parser only applies defaults that affect immutable content
 * identity and rejects server-only scorer kinds before any write. A differential
 * test against the server schema guards this deliberately duplicated boundary.
 */
const sdkScorerPublication = z.union([
  z.strictObject({
    kind: z.literal("builtin"),
    entry: z.literal("hue.exact_match.v1"),
    config: z.strictObject({}).default({}),
  }),
  z.strictObject({
    kind: z.literal("builtin"),
    entry: z.literal("hue.includes.v1"),
    config: z
      .strictObject({ caseSensitive: z.boolean().default(true) })
      .default({ caseSensitive: true }),
  }),
  z.strictObject({
    kind: z.literal("builtin"),
    entry: z.literal("hue.json_schema.v1"),
    config: z.strictObject({ schema: jsonValue }),
  }),
  z.strictObject({
    kind: z.literal("local_code"),
    language: z.enum(["typescript", "python"]),
    entrypoint: z.string(),
    sourceDigest: z.string(),
    metrics,
  }),
  z.strictObject({
    kind: z.literal("world_outcome"),
    entry: z.literal("hue.conversion_outcome.v1"),
    metrics: fixedMetrics(worldOutcomeMetrics),
  }),
  z.strictObject({
    kind: z.literal("world_outcome"),
    entry: z.literal("hue.conversion_outcome.v2"),
    metrics: fixedMetrics(conversionOutcomeV2Metrics),
  }),
  z.strictObject({
    kind: z.literal("world_outcome"),
    entry: z.literal("hue.outcome_assertions.v2"),
    metrics: fixedMetrics(outcomeAssertionMetrics),
  }),
  z.strictObject({
    kind: z.literal("world_outcome"),
    entry: z.literal("hue.outcome_assertions.v3"),
    metrics: fixedMetrics(outcomeAssertionV3Metrics),
    config: z.strictObject({ judge: outcomeJudgeConfig }),
  }),
  z.strictObject({ kind: z.literal("manual"), metrics }),
  z.strictObject({ kind: z.literal("llm_judge"), config: judgeConfig, metrics }),
]);

export function normalizeScorerDefinitionForPublication(definition: unknown): ScorerDefinition {
  const normalized = sdkScorerPublication.safeParse(definition);
  if (!normalized.success) throw new TypeError("Unsupported or invalid SDK scorer definition");
  return json(normalized.data) as ScorerDefinition;
}
