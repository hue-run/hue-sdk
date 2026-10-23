import { describe, expect, test } from "bun:test";

import { runKindOf } from "../src/cli/eval.js";

// The run kind follows the one published fact about each case: whether it pins a world.
describe("hue eval run kind", () => {
  test("left open, the cases' pins decide: no world runs direct, a world runs a simulation, both run mixed", () => {
    expect(runKindOf({ mode: "auto", cases: 1, worldCases: 0 })).toEqual({ kind: "direct" });
    expect(runKindOf({ mode: "auto", cases: 1, worldCases: 1 })).toEqual({ kind: "simulation" });
    expect(runKindOf({ mode: "auto", cases: 3, worldCases: 1 })).toEqual({ kind: "mixed" });
    expect(runKindOf({ mode: "auto", cases: 0, worldCases: 0 })).toEqual({ kind: "direct" });
  });

  test("a forced mode a case cannot run is refused with the count of cases that cannot", () => {
    const simulation = runKindOf({ mode: "simulation", cases: 3, worldCases: 1 });
    expect(simulation.kind).toBe("simulation");
    expect(simulation.refusal).toContain("2 of the 3 cases pin no world");
    expect(simulation.refusal).toContain("Drop --mode simulation");
    const direct = runKindOf({ mode: "direct", cases: 1, worldCases: 1 });
    expect(direct.kind).toBe("direct");
    expect(direct.refusal).toContain("1 of the 1 case pins a world");
    expect(direct.refusal).toContain("Drop --mode direct");
  });

  test("a forced mode every case can run is kept without a refusal", () => {
    expect(runKindOf({ mode: "direct", cases: 2, worldCases: 0 })).toEqual({ kind: "direct" });
    expect(runKindOf({ mode: "simulation", cases: 2, worldCases: 2 })).toEqual({
      kind: "simulation",
    });
  });
});
