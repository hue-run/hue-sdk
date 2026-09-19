import { randomUUID } from "node:crypto";
import type { EnvironmentEvidence } from "../../src/evals.js";

export function sealedEvidence(executionId: string = randomUUID(), count = 7): EnvironmentEvidence {
  return {
    runId: randomUUID(),
    executionId,
    environmentVersionId: randomUUID(),
    definitionDigest: "a".repeat(64),
    seed: "b".repeat(32),
    status: "completed",
    validity: "not_assessed",
    coverageGap: null,
    stepCount: count,
    stateDigest: "c".repeat(64),
    initialState: { collections: { messages: {} } },
    finalState: { collections: { messages: { draft: { body: "private mailbox body" } } } },
    steps: Array.from({ length: count }, (_, ordinal) => ({
      id: randomUUID(),
      ordinal,
      invocationId: randomUUID(),
      action: "read_mail",
      args: {},
      observation: { status: "ok", entity: { subject: "mail" } },
      effects: [],
      mutated: false,
      clockNs: String(ordinal),
      stateDigest: "c".repeat(64),
    })),
  };
}
