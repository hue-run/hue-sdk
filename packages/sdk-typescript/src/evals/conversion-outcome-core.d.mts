import type { MetricDefinition, Score, ScoreContext } from "./types.js";
/** Boolean metrics for sealed draft completion, destination, content and preservation. */
export const conversionOutcomeMetrics: MetricDefinition[];
/** Grade sealed environment evidence against a reviewed conversion_outcome_v1 rubric. */
export function scoreConversionOutcome(context: ScoreContext): Score;
