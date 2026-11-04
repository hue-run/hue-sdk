import { z } from "zod/v4";

const id = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const metric = z.object({
  /** Metric name. */
  name: z.string(),
  /** Recorded metric value. */
  value: z.union([z.boolean(), z.number(), z.string()]),
  /** Whether this metric passed. */
  passed: z.boolean().optional(),
});
const baselineComparison = z.strictObject({
  /** Pinned evaluator version ID. */
  evaluatorVersionId: id,
  /** Metric name to compare. */
  metric: z.string().min(1),
  /** Minimum or maximum comparison. */
  operator: z.enum(["gte", "lte"]),
  /** Allowed regression from the base mean. Must be finite and nonnegative. */
  tolerance: z.number().nonnegative(),
});
export const evalPolicy = z.strictObject({
  /** Absolute checks applied to each required applicable result. */
  thresholds: z
    .array(
      z.strictObject({
        /** Pinned evaluator version ID. */
        evaluatorVersionId: id,
        /** Metric name to compare. */
        metric: z.string().min(1),
        /** Minimum or maximum comparison. */
        operator: z.enum(["gte", "lte"]),
        /** Required minimum or maximum numeric value. */
        value: z.number(),
      }),
    )
    .default([]),
  /** Relative checks over paired applicable case means. */
  baselineComparisons: z.array(baselineComparison).optional(),
});
export const evalCiContext = z.strictObject({
  /** CI provider, or local for an invocation outside CI. */
  provider: z.enum(["github", "local"]),
  /** Repository owner and name. */
  repository: z.string().optional(),
  /** Commit checked out for execution. */
  commitSha: z.string().optional(),
  /** Base commit used for comparison. */
  baseSha: z.string().optional(),
  /** Pull request head commit, which may differ from the checked-out merge commit. */
  pullRequestHeadSha: z.string().optional(),
  /** Pull request number. */
  pullRequestNumber: z.number().int().positive().optional(),
  /** CI workflow run ID. */
  workflowRunId: z.string().optional(),
  /** CI workflow run attempt. */
  workflowRunAttempt: z.number().int().positive().optional(),
  /** CI event name. */
  eventName: z.string().optional(),
});
export const createEvalInvocationInput = z
  .strictObject({
    /** Stable request key used to recover the original invocation on retry. */
    idempotencyKey: z.string().min(1).max(128),
    /** Display name for this invocation. */
    name: z.string().min(1).max(100).optional(),
    /** Eval set ID. Choose this or evalSetVersionId. */
    evalSetId: id.optional(),
    /** Frozen eval set version ID. */
    evalSetVersionId: id.optional(),
    /** Evaluator IDs to resolve and freeze. */
    evaluatorIds: z.array(id).optional(),
    /** Pinned evaluator version IDs. */
    evaluatorVersionIds: z.array(id).optional(),
    /** JSON configuration frozen for this invocation. */
    config: z.json().optional(),
    /** Server gate policy frozen for this invocation. */
    policy: evalPolicy.optional(),
    /** CI identity for this execution. */
    ci: evalCiContext.optional(),
    /** Absolute deadline in ISO 8601 format. */
    deadlineAt: timestamp,
    /** Compatible completed base run, when one was selected. */
    baselineRunId: id.optional(),
  })
  .refine(
    (value) => Number(!!value.evalSetId) + Number(!!value.evalSetVersionId) === 1,
    "Choose exactly one eval set selector",
  );
export const evalGateReceipt = z.object({
  /** Saved resource ID. */
  id,
  /** Digest of the frozen manifest used for this decision. */
  manifestDigest: z.string(),
  /** Run ID for agent execution. */
  runId: id,
  /** Original scoring pass ID used by the gate. */
  scoringRunId: id,
  /** Authoritative server decision. */
  verdict: z.enum(["pass", "fail", "incomplete", "error", "cancelled"]),
  /** Time the server froze this receipt. */
  finalizedAt: timestamp,
  /** Executions considered by the gate. */
  executionIds: z.array(id),
  /** Result evidence used for the decision. */
  results: z.array(
    z.object({
      /** Frozen case ID. */
      caseId: id,
      /** Execution that produced this result. */
      executionId: id,
      /** Pinned evaluator version ID. */
      evaluatorVersionId: id,
      /** Saved result ID. */
      resultId: id,
      /** Saved state. */
      state: z.string(),
      /** Metrics recorded by the evaluator. */
      metrics: z.array(metric),
    }),
  ),
  /** Server reasons for the decision. */
  reasons: z.array(z.string()),
  /** Compatible completed base run, when one was selected. */
  baselineRunId: id.optional(),
  /** Immutable receipt for the selected base run. */
  baselineReceiptId: id.optional(),
  /** Server evidence for the relative checks. */
  comparisons: z
    .array(
      baselineComparison.extend({
        /** Mean candidate value over the paired cases. */
        candidateMean: z.number(),
        /** Mean base value over the paired cases. */
        baselineMean: z.number(),
        /** Whether this metric passed. */
        passed: z.boolean(),
        /** Cases paired for this comparison. */
        caseIds: z.array(id),
      }),
    )
    .optional(),
});
export const evalInvocationEnvelope = z
  .object({
    /** Saved invocation and its frozen inputs. */
    invocation: z.object({
      /** Saved resource ID. */
      id,
      /** Run ID for agent execution. */
      runId: id,
      /** Hue run URL. */
      runUrl: z.url(),
      /** Absolute deadline in ISO 8601 format. */
      deadlineAt: timestamp,
      /** Saved state. */
      state: z.enum(["active", "finalized", "cancelled", "expired"]),
      /** Immutable case, evaluator, configuration and policy snapshot. */
      manifest: z.object({
        /** Manifest format version. */
        version: z.literal(1),
        /** Digest of this manifest. */
        digest: z.string(),
        /** Eval set ID. Choose this or evalSetVersionId. */
        evalSetId: id,
        /** Frozen eval set version ID. */
        evalSetVersionId: id,
        /** Original scoring pass ID used by the gate. */
        scoringRunId: id,
        /** JSON configuration frozen for this invocation. */
        config: z.json(),
        /** Server gate policy frozen for this invocation. */
        policy: evalPolicy,
        /** Frozen cases selected for this invocation. */
        cases: z.array(
          z.object({
            /** Frozen case ID. */
            caseId: id,
            /** Digest of the frozen published content. */
            contentDigest: z.string(),
            /** Frozen input and variable identity, when present. */
            inputIdentity: z.string().optional(),
            /** Frozen ownership for each judge evaluator version. */
            judgePinning: z.record(id, z.enum(["this_case", "other_cases", "no_case"])).optional(),
            /** Pinned evaluator version IDs. */
            evaluatorVersionIds: z.array(id),
            /** Frozen world inputs and pins. */
            world: z.json(),
          }),
        ),
        /** Frozen evaluator versions selected for this invocation. */
        evaluators: z.array(
          z.object({
            /** Saved resource ID. */
            id,
            /** Logical evaluator ID. */
            evaluatorId: id,
            /** Published evaluator version number. */
            version: z.number().int().positive(),
            /** Evaluator kind. */
            kind: z.string(),
            /** Digest of the frozen published content. */
            contentDigest: z.string(),
          }),
        ),
        /** Compatible completed base run, when one was selected. */
        baselineRunId: id.nullable(),
      }),
      /** Immutable server receipt, or null while no receipt exists. */
      receipt: evalGateReceipt.nullable(),
    }),
  })
  .refine(
    ({ invocation }) =>
      !invocation.receipt ||
      (invocation.receipt.runId === invocation.runId &&
        invocation.receipt.scoringRunId === invocation.manifest.scoringRunId &&
        invocation.receipt.manifestDigest === invocation.manifest.digest),
    "Gate receipt does not belong to this invocation manifest",
  );
export const finalizeEvalInvocationInput = z.strictObject({
  /** Stable request key used to recover the original invocation on retry. */
  idempotencyKey: z.string().min(1).max(128),
  /** Executions considered by the gate. */
  executionIds: z.array(id).optional(),
});
export const cancelEvalInvocationInput = z.strictObject({
  /** Stable request key used to recover the original invocation on retry. */
  idempotencyKey: z.string().min(1).max(128),
  /** Reason for closing the invocation. */
  reason: z.enum(["interrupted", "deadline", "runner_error"]),
});
export const createEvalBaselineInput = z.strictObject({
  /** Stable request key used to recover the original invocation on retry. */
  idempotencyKey: z.string().min(1).max(128),
  /** CI identity for this execution. */
  ci: evalCiContext.refine((ci) => !!ci.commitSha, "Baseline CI context requires commitSha"),
});
/**
 * Request to freeze inputs and create a CI eval invocation.
 * @interface
 */
export type CreateEvalInvocationInput = z.input<typeof createEvalInvocationInput>;
/**
 * Saved CI eval invocation with a frozen manifest and optional server receipt.
 * @interface
 */
export type EvalInvocation = z.infer<typeof evalInvocationEnvelope>["invocation"];
/**
 * Immutable server decision and the evidence used by the gate.
 * @interface
 */
export type EvalGateReceipt = z.infer<typeof evalGateReceipt>;
/**
 * CI metadata used to identify and recover an invocation.
 * @interface
 */
export type EvalCiContext = z.infer<typeof evalCiContext>;
/**
 * Request to finalize an invocation from its saved execution and scoring evidence.
 * @interface
 */
export type FinalizeEvalInvocationInput = z.infer<typeof finalizeEvalInvocationInput>;
/**
 * Request to close an invocation and its owned execution resources.
 * @interface
 */
export type CancelEvalInvocationInput = z.infer<typeof cancelEvalInvocationInput>;
/**
 * Request to copy candidate inputs into an owned base run for the base commit.
 * @interface
 */
export type CreateEvalBaselineInput = z.infer<typeof createEvalBaselineInput>;

const evidenceField = z.enum([
  "manifest.cases",
  "receipt.results",
  "receipt.reasons",
  "receipt.comparisons",
]);
const evidenceDescriptors = z.object({
  pages: z
    .array(z.object({ field: evidenceField, total: z.number().int().positive().max(5_000_000) }))
    .default([]),
});
const evidencePage = z.object({
  id: z.uuid(),
  manifestDigest: z.string(),
  receiptId: z.uuid().nullable(),
  field: evidenceField,
  offset: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  items: z.array(z.unknown()).min(1).max(100),
  nextOffset: z.number().int().positive().nullable(),
});

/** Reassemble immutable evidence pages without changing the server's receipt. */
export async function readEvalInvocation(
  value: unknown,
  load: (path: string) => Promise<unknown>,
): Promise<EvalInvocation> {
  const invocation = evalInvocationEnvelope.parse(value).invocation;
  const pages = evidenceDescriptors.parse(value).pages;
  const encoder = new TextEncoder();
  let bytes = encoder.encode(JSON.stringify(value)).byteLength;
  if (new Set(pages.map((p) => p.field)).size !== pages.length)
    throw new Error("Duplicate evidence field");
  for (const descriptor of pages) {
    const existing =
      descriptor.field === "manifest.cases"
        ? invocation.manifest.cases
        : invocation.receipt?.[
            descriptor.field === "receipt.results"
              ? "results"
              : descriptor.field === "receipt.reasons"
                ? "reasons"
                : "comparisons"
          ];
    if (!existing || existing.length) throw new Error("Invalid evidence placeholder");
    const items: unknown[] = [];
    while (items.length < descriptor.total) {
      const query = new URLSearchParams({
        field: descriptor.field,
        offset: String(items.length),
        manifestDigest: invocation.manifest.digest,
      });
      if (invocation.receipt) query.set("receiptId", invocation.receipt.id);
      const page = evidencePage.parse(await load(`/eval-invocations/${invocation.id}?${query}`));
      const end = items.length + page.items.length;
      if (
        page.id !== invocation.id ||
        page.manifestDigest !== invocation.manifest.digest ||
        (descriptor.field !== "manifest.cases" && page.receiptId !== invocation.receipt?.id) ||
        page.field !== descriptor.field ||
        page.offset !== items.length ||
        page.total !== descriptor.total ||
        end > descriptor.total ||
        page.nextOffset !== (end === descriptor.total ? null : end)
      )
        throw new Error("Evidence page does not belong to this invocation");
      bytes += encoder.encode(JSON.stringify(page.items)).byteLength;
      if (bytes > 256 * 1024 * 1024) throw new Error("Invocation evidence exceeds 256 MiB");
      items.push(...page.items);
    }
    switch (descriptor.field) {
      case "manifest.cases":
        invocation.manifest.cases =
          evalInvocationEnvelope.shape.invocation.shape.manifest.shape.cases.parse(items);
        break;
      case "receipt.results":
        if (invocation.receipt)
          invocation.receipt.results = evalGateReceipt.shape.results.parse(items);
        break;
      case "receipt.reasons":
        if (invocation.receipt)
          invocation.receipt.reasons = evalGateReceipt.shape.reasons.parse(items);
        break;
      case "receipt.comparisons":
        if (invocation.receipt)
          invocation.receipt.comparisons = evalGateReceipt.shape.comparisons.parse(items);
        break;
    }
  }
  return invocation;
}
