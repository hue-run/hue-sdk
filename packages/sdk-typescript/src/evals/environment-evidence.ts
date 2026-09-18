import { setTimeout as wait } from "node:timers/promises";
import { HueApiError } from "./client.js";
import type { EvaluationClient } from "./client.js";
import { json, uuid, valueBounds } from "./json.js";
import {
  environmentJson,
  validateEvidenceArguments,
  validateEvidenceWorld,
} from "./environment-json.js";
import type { EnvironmentEvidence } from "./types.js";

const maxBytes = 8 * 1024 * 1024;
const hexDigest = /^[a-f0-9]{64}$/;
export const MAX_ENVIRONMENT_STEPS = 500;

async function readEvidence<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const retryable =
        error instanceof HueApiError &&
        (error.status === undefined ||
          error.status === 408 ||
          error.status === 429 ||
          error.status >= 500);
      if (!retryable || attempt >= 4) throw error;
      await wait(25 * 2 ** (attempt - 1));
    }
  }
}

export const environmentIncompleteReason =
  "Environment incomplete: provider behavior is not implemented.";

function validateCoverage(evidence: EnvironmentEvidence): void {
  const validity = evidence.validity === undefined ? "not_assessed" : evidence.validity;
  const gap = evidence.coverageGap ?? null;
  if (validity === "not_assessed" && gap === null) return;
  if (validity !== "environment_incomplete" || !gap || typeof gap !== "object")
    throw new TypeError("Invalid environment coverage evidence");
  const { args, ...metadata } = gap;
  json(metadata);
  json(args, { ...valueBounds, bytes: 16_000 });
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    Object.keys(gap).sort().join(",") !==
      "args,code,description,operation,provider,reportedAt,reportedBy" ||
    [
      [gap.provider, 128],
      [gap.operation, 256],
      [gap.code, 128],
      [gap.description, 2000],
    ].some(
      ([value, maximum]) =>
        typeof value !== "string" || !value.length || value.length > Number(maximum),
    ) ||
    typeof gap.reportedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(gap.reportedAt) ||
    !Number.isFinite(Date.parse(gap.reportedAt)) ||
    !gap.reportedBy ||
    !["project_key", "user"].includes(gap.reportedBy.kind) ||
    Object.keys(gap.reportedBy).sort().join(",") !== "id,kind"
  )
    throw new TypeError("Invalid environment coverage gap");
  uuid(gap.reportedBy.id);
}

export function validateEnvironmentEvidence(evidence: EnvironmentEvidence): void {
  validateCoverage(evidence);
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
    evidence.stepCount > MAX_ENVIRONMENT_STEPS ||
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
  const snapshot = await readEvidence(() => client.getEnvironmentEvidence(executionId));
  if (snapshot.executionId !== executionId) throw new TypeError("Environment execution differs");
  if (
    !Number.isInteger(snapshot.stepCount) ||
    snapshot.stepCount < 0 ||
    snapshot.stepCount > MAX_ENVIRONMENT_STEPS
  )
    throw new TypeError("Invalid environment step count");
  const evidence: EnvironmentEvidence = {
    validity: "not_assessed",
    coverageGap: null,
    ...snapshot,
    steps: [],
  };
  let size = Buffer.byteLength(JSON.stringify(evidence));
  let after: number | undefined;
  for (;;) {
    const page = await readEvidence(() =>
      client.getEnvironmentSteps(executionId, { after, limit: 5 }),
    );
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
