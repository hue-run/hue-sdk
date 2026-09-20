import { conversionOutcomeMetrics, scoreConversionOutcome } from "./conversion-outcome-core.mjs";
import type { LocalScorer } from "./types.js";

export { conversionOutcomeMetrics, scoreConversionOutcome };

/** The canonical module is copied unchanged into SDK releases. Registration and
 * workers pin actual executable bytes, independent of TypeScript transpilation. */
const canonicalDefinition: LocalScorer["definition"] = {
  kind: "local_code",
  language: "typescript",
  // Verified against the canonical executable module by the SDK build and tests.
  sourceDigest: "27d096eedc80fbfb747b849c891762f76165ef76429727b0a93ec7dbebaf7b05",
  entrypoint: "scoreConversionOutcome",
  metrics: structuredClone(conversionOutcomeMetrics),
};

/** Registration metadata for the canonical executable; callers may clone it for publication. */
export const conversionOutcomeScorerDefinition = structuredClone(canonicalDefinition);

/** Bind the portable sealed-outcome scorer to its exact executable source digest. */
export function createConversionOutcomeScorer(): LocalScorer {
  return {
    definition: structuredClone(canonicalDefinition),
    score: scoreConversionOutcome,
  };
}
