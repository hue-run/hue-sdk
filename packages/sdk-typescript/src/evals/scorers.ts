import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { aggregateBounds, digest, json, sourceDigest } from "./json.js";
import {
  environmentIncompleteReason,
  validateEnvironmentEvidence,
} from "./environment-evidence.js";
import type {
  JsonValue,
  LocalScorer,
  MetricDefinition,
  Score,
  ScoreContext,
  ScorerDefinition,
  ScorerVersion,
} from "./types.js";

/** Definitions for Hue's built-in scorers, ready to publish with `publishScorerVersion`. */
export const builtins = {
  /** Exact typed JSON equality with the reference output; key order is ignored. */
  exactMatch: (): ScorerDefinition => ({
    kind: "builtin",
    entry: "hue.exact_match.v1",
    config: {},
  }),
  /** The string reference output is contained in the string output. */
  includes: (caseSensitive = true): ScorerDefinition => ({
    kind: "builtin",
    entry: "hue.includes.v1",
    config: { caseSensitive },
  }),
  /** The output satisfies a JSON Schema (draft 2020-12), validated with the optional `ajv` peer in a worker. */
  jsonSchema: (schema: JsonValue): ScorerDefinition => ({
    kind: "builtin",
    entry: "hue.json_schema.v1",
    config: { schema: json(schema) },
  }),
};
/** The source hash is a caller declaration; closures and installed dependencies are not attested. */
export function defineLocalScorer(options: {
  source: string | Uint8Array;
  entrypoint: string;
  metrics: MetricDefinition[];
  score: LocalScorer["score"];
}): LocalScorer {
  return {
    definition: {
      kind: "local_code",
      language: "typescript",
      entrypoint: options.entrypoint,
      sourceDigest: sourceDigest(options.source),
      metrics: options.metrics,
    },
    score: options.score,
  };
}

/** ajv is an optional peer dependency: only JSON Schema scoring loads it, inside a worker. */
function schemaValidatorAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve("ajv/dist/2020.js");
    return true;
  } catch {
    return false;
  }
}

function schemaScore(schema: JsonValue, output: JsonValue, timeoutMillis: number): Promise<Score> {
  if (!schemaValidatorAvailable())
    return Promise.resolve({
      state: "error",
      error: {
        type: "SchemaValidatorUnavailable",
        message: "JSON Schema scoring requires the optional ajv peer dependency: npm install ajv",
      },
    });
  return new Promise((resolve) => {
    const compiled = new URL("./schema-worker.js", import.meta.url);
    const file = existsSync(compiled) ? compiled : new URL("./schema-worker.ts", import.meta.url);
    const worker = new Worker(file, {
      workerData: { schema, output },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    let settled = false;
    const finish = async (result: Score) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(
      () => void finish({ state: "error", error: { type: "SchemaTimeout" } }),
      timeoutMillis,
    );
    worker.once("message", (value: { match?: boolean; error?: boolean }) => {
      void finish(
        typeof value.match === "boolean"
          ? match(value.match, "JSON Schema conformance evaluated locally")
          : { state: "error", error: { type: "InvalidSchema" } },
      );
    });
    worker.once(
      "error",
      () => void finish({ state: "error", error: { type: "SchemaWorkerError" } }),
    );
    worker.once("exit", () => {
      if (!settled) void finish({ state: "error", error: { type: "SchemaWorkerExit" } });
    });
  });
}
function match(value: boolean, explanation: string): Score {
  return { state: "scored", metrics: [{ name: "match", value, passed: value }], explanation };
}
function skip(explanation: string): Score {
  return { state: "skipped", explanation };
}

/** Check local callbacks before target invocation; never execute downloaded source code. */
export function isBoundLocally(definition: ScorerDefinition, scorers: LocalScorer[] = []): boolean {
  return scorers.some((local) => digest(local.definition) === digest(definition));
}
export function validateScorerBindings(
  versions: ScorerVersion[],
  scorers: LocalScorer[] = [],
): void {
  for (const { definition } of versions) {
    if (definition.kind === "local_code" && !isBoundLocally(definition, scorers))
      throw new Error(
        "A pinned local scorer has no matching language/source/entrypoint/metric binding",
      );
  }
}
/**
 * Whether this process produces the result for a pinned version. Built-ins always run here; a
 * `local_code` pin runs here when bound, and with `deferUnboundLocalScorers` an unbound pin is
 * left to the executor that owns its source (for example Hue's grading worker) instead of
 * failing the run.
 */
export function executableHere(
  definition: ScorerDefinition,
  options: { scorers?: LocalScorer[]; deferUnboundLocalScorers?: boolean },
): definition is Extract<ScorerDefinition, { kind: "builtin" | "local_code" }> {
  if (!isLocallyExecutable(definition)) return false;
  if (definition.kind === "local_code" && options.deferUnboundLocalScorers)
    return isBoundLocally(definition, options.scorers);
  return true;
}
/** Only implementations this SDK owns may produce local results. Unknown pins are deferred. */
export function isLocallyExecutable(definition: {
  kind: string;
  entry?: string;
}): definition is Extract<ScorerDefinition, { kind: "builtin" | "local_code" }> {
  return (
    definition.kind === "local_code" ||
    (definition.kind === "builtin" &&
      ["hue.exact_match.v1", "hue.includes.v1", "hue.json_schema.v1"].includes(
        definition.entry ?? "",
      ))
  );
}

/**
 * Scores one subject locally using a known built-in or a bound `local_code` callback.
 * Scorer failures are returned as sanitized error scores.
 *
 * @throws TypeError for pins without a local implementation; their authorized executor owns scoring.
 */
export async function scoreLocally(
  version: ScorerVersion,
  context: ScoreContext,
  options: { scorers?: LocalScorer[]; schemaTimeoutMillis?: number } = {},
): Promise<Score> {
  const definition = version.definition;
  if (!isLocallyExecutable(definition))
    throw new TypeError(
      "This scorer must be deferred to its authorized executor; do not submit a local result",
    );
  const timeout = options.schemaTimeoutMillis ?? 2000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60_000)
    throw new RangeError("schemaTimeoutMillis must be 100–60000");
  if (context.environment?.validity === "environment_incomplete") {
    try {
      validateEnvironmentEvidence(context.environment);
      return skip(environmentIncompleteReason);
    } catch {
      return { state: "error", error: { type: "LocalScorerError" } };
    }
  }
  // A code evaluator can grade a sealed world or generated files without a JSON output.
  const generatedFiles = context.files?.some((file) => file.role === "output") ?? false;
  if (
    !context.hasOutput &&
    !(definition.kind === "local_code" && (context.environment || generatedFiles))
  )
    return skip("Output evidence is unavailable");
  if (context.hasOutput && context.output === undefined)
    throw new TypeError("hasOutput requires a present JSON output");
  try {
    // Clone and validate inputs so a scorer cannot mutate another scorer's evidence.
    const { environment, ...ordinaryEvidence } = context;
    json(ordinaryEvidence, aggregateBounds(1024 * 1024));
    if (environment !== undefined) validateEnvironmentEvidence(environment);
    const owned = structuredClone(context);
    if (definition.kind === "local_code") {
      const binding = options.scorers?.find(
        (local) => digest(local.definition) === digest(definition),
      );
      if (!binding) return { state: "error", error: { type: "ScorerBindingUnavailable" } };
      return validateScore(await binding.score(owned), definition);
    }
    if (definition.entry === "hue.json_schema.v1")
      return await schemaScore(definition.config.schema, owned.output!, timeout);
    if (!owned.hasExpected) return skip("Reference evidence is unavailable");
    if (definition.entry === "hue.exact_match.v1")
      return match(
        digest(owned.output) === digest(owned.expected),
        "JSON exact match evaluated locally",
      );
    if (typeof owned.output !== "string" || typeof owned.expected !== "string")
      return skip("Includes requires string output and reference");
    const normalize = (value: string) =>
      definition.config.caseSensitive ? value : value.toLowerCase();
    return match(
      normalize(owned.output).includes(normalize(owned.expected)),
      "String inclusion evaluated locally",
    );
  } catch {
    // Arbitrary thrown messages can include secrets/output. Keep scorer failures typed and sanitized.
    return { state: "error", error: { type: "LocalScorerError" } };
  }
}
export function validateScore(value: Score, definition: ScorerDefinition): Score {
  json(value);
  const score = structuredClone(value);
  const keys = (object: object, allowed: string[]) => {
    if (Object.keys(object).some((key) => !allowed.includes(key)))
      throw new TypeError("Unexpected scorer result field");
  };
  if (score.state === "error") {
    keys(score, ["state", "error"]);
    if (
      !score.error ||
      typeof score.error.type !== "string" ||
      !score.error.type ||
      score.error.type.length > 200
    )
      throw new TypeError("Scorer error requires a bounded type");
    keys(score.error, ["type", "message"]);
    if (
      score.error.message !== undefined &&
      (typeof score.error.message !== "string" || score.error.message.length > 4000)
    )
      throw new TypeError("Invalid scorer error message");
    return score;
  }
  if (score.state === "skipped") {
    keys(score, ["state", "explanation"]);
    if (
      typeof score.explanation !== "string" ||
      !score.explanation.trim() ||
      score.explanation.length > 4000
    )
      throw new TypeError("Skipped score requires a bounded reason");
    return score;
  }
  if (score.state !== "scored" || !Array.isArray(score.metrics))
    throw new TypeError("Invalid scorer result");
  keys(score, ["state", "metrics", "explanation", "evidence"]);
  const metrics: MetricDefinition[] =
    definition.kind === "builtin" ? [{ name: "match", type: "boolean" }] : definition.metrics;
  if (
    score.metrics.length !== metrics.length ||
    new Set(score.metrics.map((m) => m.name)).size !== metrics.length
  )
    throw new TypeError("Scorer result must contain every declared metric once");
  for (const expected of metrics) {
    const actual = score.metrics.find((item) => item.name === expected.name);
    if (!actual || (actual.passed !== undefined && typeof actual.passed !== "boolean"))
      throw new TypeError("Invalid metric");
    keys(actual, ["name", "value", "passed"]);
    const value = actual.value;
    if (expected.type === "number") {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (expected.min !== undefined && value < expected.min) ||
        (expected.max !== undefined && value > expected.max)
      )
        throw new TypeError("Invalid numeric metric");
    } else if (expected.type === "category") {
      if (typeof value !== "string" || !expected.categories.includes(value))
        throw new TypeError("Invalid category metric");
    } else if (typeof value !== (expected.type === "text" ? "string" : "boolean"))
      throw new TypeError("Invalid metric type");
    if (typeof value === "string" && value.length > 4000)
      throw new TypeError("Metric text is too long");
  }
  if (
    score.explanation !== undefined &&
    (typeof score.explanation !== "string" ||
      !score.explanation.trim() ||
      score.explanation.length > 4000)
  )
    throw new TypeError("Invalid explanation");
  const evidence = score.evidence;
  const hasEvidence =
    evidence !== undefined &&
    evidence !== null &&
    (typeof evidence !== "string" || evidence.trim().length > 0) &&
    (typeof evidence !== "object" || Object.keys(evidence).length > 0);
  if (!score.explanation && !hasEvidence)
    throw new TypeError("Scored results require an explanation or evidence");
  return score;
}
export function persistedScore(score: Score, persistResultContent: boolean): Score {
  if (persistResultContent) return score;
  if (score.state === "scored")
    return {
      state: "scored",
      metrics: score.metrics,
      explanation: "Local scoring completed; result content storage disabled",
    };
  if (score.state === "error")
    return {
      state: "error",
      error: {
        type:
          score.error.type === "EnvironmentEvidenceUnavailable"
            ? "EnvironmentEvidenceUnavailable"
            : "LocalScorerError",
      },
    };
  // Preserve fixed unavailable reasons, never arbitrary caller explanations.
  const safeReasons = [
    environmentIncompleteReason,
    "Output evidence is unavailable",
    "Reference evidence is unavailable",
    "Includes requires string output and reference",
    "Manual scoring requires a human session",
  ];
  return {
    state: "skipped",
    explanation: safeReasons.includes(score.explanation)
      ? score.explanation
      : "Local scoring skipped; result content storage disabled",
  };
}
