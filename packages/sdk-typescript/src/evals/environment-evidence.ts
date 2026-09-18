import type { EvaluationClient } from "./client.js";
import { json, uuid } from "./json.js";
import {
  environmentJson,
  validateEvidenceArguments,
  validateEvidenceWorld,
} from "./environment-json.js";
import type { EnvironmentEvidence } from "./types.js";

const maxBytes = 8 * 1024 * 1024;
const hexDigest = /^[a-f0-9]{64}$/;

export function validateEnvironmentEvidence(evidence: EnvironmentEvidence): void {
  uuid(evidence.runId);
  uuid(evidence.executionId);
  uuid(evidence.environmentVersionId);
  if (
    !hexDigest.test(evidence.definitionDigest) ||
    !hexDigest.test(evidence.stateDigest) ||
    !/^[a-f0-9]{32}$/.test(evidence.seed) ||
    !["completed", "abandoned", "expired"].includes(evidence.status) ||
    !Number.isInteger(evidence.stepCount) ||
    evidence.stepCount < 0 ||
    evidence.stepCount > 500 ||
    !Array.isArray(evidence.steps) ||
    evidence.steps.length !== evidence.stepCount
  )
    throw new TypeError("Invalid sealed environment evidence");
  validateEvidenceWorld(evidence.initialState);
  validateEvidenceWorld(evidence.finalState);
  for (const [ordinal, step] of evidence.steps.entries()) {
    const { args, observation, effects, ...header } = step;
    json(header);
    validateEvidenceArguments(args);
    environmentJson(observation, 256 * 1024, 35, 256 * 1024);
    environmentJson(effects, 256 * 1024, 35, 256 * 1024);
    if (step.ordinal !== ordinal || !hexDigest.test(step.stateDigest))
      throw new TypeError("Environment history is incomplete or unordered");
  }
  if (evidence.steps.length && evidence.steps.at(-1)!.stateDigest !== evidence.stateDigest)
    throw new TypeError("Environment history does not end at the sealed state");
  if (Buffer.byteLength(JSON.stringify(evidence)) > maxBytes)
    throw new RangeError("Environment evidence exceeds 8 MiB; no history was truncated");
}

export async function loadEnvironmentEvidence(
  client: EvaluationClient,
  executionId: string,
): Promise<EnvironmentEvidence> {
  const snapshot = await client.getEnvironmentEvidence(executionId);
  if (snapshot.executionId !== executionId) throw new TypeError("Environment execution differs");
  if (!Number.isInteger(snapshot.stepCount) || snapshot.stepCount < 0 || snapshot.stepCount > 500)
    throw new TypeError("Invalid environment step count");
  const evidence: EnvironmentEvidence = { ...snapshot, steps: [] };
  let size = Buffer.byteLength(JSON.stringify(evidence));
  let after: number | undefined;
  for (;;) {
    const page = await client.getEnvironmentSteps(executionId, { after, limit: 5 });
    if (!Array.isArray(page.items)) throw new TypeError("Invalid environment history page");
    for (const step of page.items) {
      if (step.ordinal !== evidence.steps.length || evidence.steps.length >= snapshot.stepCount)
        throw new TypeError("Environment history is incomplete or unordered");
      size += Buffer.byteLength(JSON.stringify(step));
      if (size > maxBytes) throw new RangeError("Environment evidence exceeds 8 MiB");
      evidence.steps.push(step);
    }
    if (page.nextCursor === null) break;
    if (!page.items.length || page.nextCursor !== evidence.steps.length - 1)
      throw new TypeError("Environment history repeated or skipped a cursor");
    after = page.nextCursor;
  }
  validateEnvironmentEvidence(evidence);
  return evidence;
}
