import { z } from "zod/v4";

const id = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const metric = z.object({
  name: z.string(),
  value: z.union([z.boolean(), z.number(), z.string()]),
  passed: z.boolean().optional(),
});
export const evalPolicy = z.strictObject({
  thresholds: z
    .array(
      z.strictObject({
        evaluatorVersionId: id,
        metric: z.string().min(1),
        operator: z.enum(["gte", "lte"]),
        value: z.number(),
      }),
    )
    .default([]),
});
export const evalCiContext = z.strictObject({
  provider: z.enum(["github", "local"]),
  repository: z.string().optional(),
  commitSha: z.string().optional(),
  baseSha: z.string().optional(),
  pullRequestHeadSha: z.string().optional(),
  pullRequestNumber: z.number().int().positive().optional(),
  workflowRunId: z.string().optional(),
  workflowRunAttempt: z.number().int().positive().optional(),
  eventName: z.string().optional(),
});
export const createEvalInvocationInput = z
  .strictObject({
    idempotencyKey: z.string().min(1).max(128),
    name: z.string().min(1).max(100).optional(),
    evalSetId: id.optional(),
    evalSetVersionId: id.optional(),
    evaluatorIds: z.array(id).optional(),
    evaluatorVersionIds: z.array(id).optional(),
    config: z.json().optional(),
    policy: evalPolicy.optional(),
    ci: evalCiContext.optional(),
    deadlineAt: timestamp,
    baselineRunId: id.optional(),
  })
  .refine(
    (value) => Number(!!value.evalSetId) + Number(!!value.evalSetVersionId) === 1,
    "Choose exactly one eval set selector",
  );
export const evalGateReceipt = z.object({
  id,
  manifestDigest: z.string(),
  runId: id,
  scoringRunId: id,
  verdict: z.enum(["pass", "fail", "incomplete", "error", "cancelled"]),
  finalizedAt: timestamp,
  executionIds: z.array(id),
  results: z.array(
    z.object({
      caseId: id,
      executionId: id,
      evaluatorVersionId: id,
      resultId: id,
      state: z.string(),
      metrics: z.array(metric),
    }),
  ),
  reasons: z.array(z.string()),
});
export const evalInvocationEnvelope = z.object({
  invocation: z.object({
    id,
    runId: id,
    runUrl: z.url(),
    deadlineAt: timestamp,
    state: z.enum(["active", "finalized", "cancelled", "expired"]),
    manifest: z.object({
      version: z.literal(1),
      digest: z.string(),
      evalSetId: id,
      evalSetVersionId: id,
      scoringRunId: id,
      config: z.json(),
      policy: evalPolicy,
      cases: z.array(
        z.object({
          caseId: id,
          contentDigest: z.string(),
          evaluatorVersionIds: z.array(id),
          world: z.json(),
        }),
      ),
      evaluators: z.array(
        z.object({
          id,
          evaluatorId: id,
          version: z.number().int().positive(),
          kind: z.string(),
          contentDigest: z.string(),
        }),
      ),
      baselineRunId: id.nullable(),
    }),
    receipt: evalGateReceipt.nullable(),
  }),
});
export const finalizeEvalInvocationInput = z.strictObject({
  idempotencyKey: z.string().min(1).max(128),
  executionIds: z.array(id).optional(),
});
export const cancelEvalInvocationInput = z.strictObject({
  idempotencyKey: z.string().min(1).max(128),
  reason: z.enum(["interrupted", "deadline", "runner_error"]),
});
export type CreateEvalInvocationInput = z.input<typeof createEvalInvocationInput>;
export type EvalInvocation = z.infer<typeof evalInvocationEnvelope>["invocation"];
export type EvalGateReceipt = z.infer<typeof evalGateReceipt>;
export type EvalCiContext = z.infer<typeof evalCiContext>;
export type FinalizeEvalInvocationInput = z.infer<typeof finalizeEvalInvocationInput>;
export type CancelEvalInvocationInput = z.infer<typeof cancelEvalInvocationInput>;
