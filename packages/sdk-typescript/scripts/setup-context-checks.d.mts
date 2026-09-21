/** Test-only scenarios shared by source and installed-archive checks. */
export const setupContextScenarios: string[];
/** Construct one bounded subprocess program without executing it. */
export function setupContextCheckSource(scenario: string): string;
