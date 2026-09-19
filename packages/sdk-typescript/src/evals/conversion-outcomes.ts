import { conversionOutcomeMetrics, scoreConversionOutcome } from "./conversion-outcome-core.mjs";
import type { LocalScorer } from "./types.js";

export { conversionOutcomeMetrics, scoreConversionOutcome };

/** The canonical module is copied unchanged into SDK releases. Registration and
 * workers pin actual executable bytes, independent of TypeScript transpilation. */
export const conversionOutcomeScorerDefinition: LocalScorer["definition"] = {
  kind: "local_code",
  language: "typescript",
  // Verified against the canonical executable module by the SDK build and tests.
  sourceDigest: "524d5cc24aee0c4ede4b6d81fa64a9f7a2cc4c8c1f53020da00519b7a3c4507c",
  entrypoint: "scoreConversionOutcome",
  metrics: conversionOutcomeMetrics,
};

/** Bind the portable sealed-outcome scorer to its exact executable source digest. */
export function createConversionOutcomeScorer(): LocalScorer {
  return {
    definition: structuredClone(conversionOutcomeScorerDefinition),
    score: scoreConversionOutcome,
  };
}
