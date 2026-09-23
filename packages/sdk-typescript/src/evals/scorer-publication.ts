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
    executor: z.literal("worker").optional(),
    metrics,
  }),
  z.strictObject({
    kind: z.literal("world_outcome"),
    entry: z.literal("hue.conversion_outcome.v1"),
    metrics: metrics
      .default(worldOutcomeMetrics)
      .refine(
        (value) => digest(value) === digest(worldOutcomeMetrics),
        "World outcome metrics are fixed by the pinned entry",
      ),
  }),
  z.strictObject({ kind: z.literal("manual"), metrics }),
  z.strictObject({ kind: z.literal("llm_judge"), config: judgeConfig, metrics }),
]);

export function normalizeScorerDefinitionForPublication(definition: unknown): ScorerDefinition {
  const normalized = sdkScorerPublication.safeParse(definition);
  if (!normalized.success) throw new TypeError("Unsupported or invalid SDK scorer definition");
  return json(normalized.data) as ScorerDefinition;
}
