import { isDeepStrictEqual } from "node:util";

// This file is shipped verbatim so server registration and packed SDK workers
// hash identical executable source bytes. No downloaded or generated code runs.
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value, max = 200) =>
  typeof value === "string" && value.length > 0 && value.length <= max;
function parseWorld(value) {
  return object(value) &&
    object(value.collections) &&
    Object.values(value.collections).every(
      (collection) => object(collection) && Object.values(collection).every(object),
    )
    ? { success: true, data: value }
    : { success: false };
}
function parseRubric(value) {
  if (
    !object(value) ||
    value.kind !== "conversion_outcome_v1" ||
    !["gmail", "slack"].includes(value.service) ||
    !object(value.goal)
  )
    return { success: false };
  const goal = value.goal,
    content = goal.content;
  if (
    !object(content) ||
    !["equals", "contains"].includes(content.mode) ||
    !nonempty(content.text, 20000) ||
    (content.forbidden !== undefined &&
      (!Array.isArray(content.forbidden) ||
        content.forbidden.length > 32 ||
        !content.forbidden.every((term) => nonempty(term, 1000))))
  )
    return { success: false };
  if (value.service === "gmail") {
    if (
      ![goal.parentMessageId, goal.threadId].every((id) => nonempty(id)) ||
      !nonempty(goal.subject, 998) ||
      !Array.isArray(goal.to) ||
      goal.to.length < 1 ||
      goal.to.length > 50 ||
      !goal.to.every(
        (address) => nonempty(address, 254) && /^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(address),
      )
    )
      return { success: false };
  } else if (![goal.channelId, goal.threadTs, goal.actorId].every((id) => nonempty(id)))
    return { success: false };
  if (value.preserveUnrelated !== undefined && typeof value.preserveUnrelated !== "boolean")
    return { success: false };
  if (
    value.processConstraints !== undefined &&
    (!Array.isArray(value.processConstraints) ||
      value.processConstraints.length > 32 ||
      !value.processConstraints.every(
        (item) => object(item) && nonempty(item.action) && object(item.args),
      ))
  )
    return { success: false };
  return {
    success: true,
    data: {
      ...value,
      preserveUnrelated: value.preserveUnrelated ?? true,
      processConstraints: value.processConstraints ?? [],
      goal: { ...goal, content: { ...content, forbidden: content.forbidden ?? [] } },
    },
  };
}

const names = [
  "completed_run",
  "saved_draft",
  "correct_destination",
  "content",
  "unrelated_preserved",
  "process_constraints",
  "task_success",
];
export const conversionOutcomeMetrics = names.map((name) => ({ name, type: "boolean" }));

const text = (value) => (typeof value === "string" ? value : "");
const subject = (value) =>
  text(value)
    .replace(/^(?:re:\s*)+/i, "")
    .trim()
    .toLowerCase();
const recipients = (value) =>
  Array.isArray(value) ? value.map((item) => text(item).toLowerCase()).sort() : [];
const coverageErrors = new Set([
  "unsupported_action",
  "unsupported_query",
  "unsupported_content_types",
  "result_limit_exceeded",
  "environment_coverage_missing",
]);

// Keep this gate inside the pinned executable. Importing another SDK validator
// would let its later changes alter grading without changing this source digest.
function boundedGapJson(value, maxBytes, maxDepth = 32) {
  const ancestors = new Set();
  let nodes = 0;
  const validText = (item) => item.isWellFormed() && !item.includes("\u0000");
  const visit = (item, depth) => {
    if (++nodes > 20000 || depth > maxDepth) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "string") return validText(item);
    if (!object(item) && !Array.isArray(item)) return false;
    if (ancestors.has(item) || Object.getOwnPropertySymbols(item).length) return false;
    const keys = Object.keys(item);
    if (Array.isArray(item)) {
      if (keys.length !== item.length) return false;
    } else if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) return false;
    ancestors.add(item);
    const valid = keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      return validText(key) && "value" in descriptor && visit(descriptor.value, depth + 1);
    });
    ancestors.delete(item);
    return valid;
  };
  return visit(value, 0) && Buffer.byteLength(JSON.stringify(value)) <= maxBytes;
}

function validCoverage(e) {
  const validity = e.validity === undefined ? "not_assessed" : e.validity;
  const gap = e.coverageGap ?? null;
  if (validity === "not_assessed" && gap === null) return true;
  if (validity !== "environment_incomplete" || !object(gap)) return false;
  if (!boundedGapJson(gap, 216000, 33)) return false;
  const { args, ...metadata } = gap;
  if (!boundedGapJson(metadata, 200000)) return false;
  const uuid = (value) =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  return (
    Object.keys(gap).sort().join(",") ===
      "args,code,description,operation,provider,reportedAt,reportedBy" &&
    object(args) &&
    boundedGapJson(args, 16000) &&
    nonempty(gap.provider, 128) &&
    nonempty(gap.operation, 256) &&
    nonempty(gap.code, 128) &&
    nonempty(gap.description, 2000) &&
    typeof gap.reportedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(gap.reportedAt) &&
    Number.isFinite(Date.parse(gap.reportedAt)) &&
    object(gap.reportedBy) &&
    Object.keys(gap.reportedBy).sort().join(",") === "id,kind" &&
    ["project_key", "user"].includes(gap.reportedBy.kind) &&
    uuid(gap.reportedBy.id) &&
    [e.runId, e.executionId, e.environmentVersionId].every(uuid) &&
    digest(e.definitionDigest) &&
    digest(e.stateDigest) &&
    typeof e.seed === "string" &&
    /^[a-f0-9]{32}$/.test(e.seed) &&
    ["completed", "abandoned", "expired"].includes(e.status) &&
    Number.isInteger(e.stepCount) &&
    e.stepCount >= 0 &&
    e.stepCount <= 500 &&
    e.steps.every((step) => digest(step.stateDigest)) &&
    (!e.steps.length || e.steps.at(-1).stateDigest === e.stateDigest)
  );
}

/** Grades authoritative sealed outcomes. Read order and repair writes are irrelevant
 * unless the reviewer added an explicit process constraint. Historical rescoring
 * uses the same immutable evidence and never executes a candidate. */
export function scoreConversionOutcome(context) {
  const e = context.environment;
  if (!e) return { state: "error", error: { type: "ConversionEnvironmentEvidenceRequired" } };
  const initial = parseWorld(e.initialState),
    final = parseWorld(e.finalState);
  if (
    !initial.success ||
    !final.success ||
    !Array.isArray(e.steps) ||
    e.stepCount !== e.steps.length ||
    e.steps.some((step, ordinal) => !object(step) || step.ordinal !== ordinal)
  )
    return { state: "error", error: { type: "ConversionOutcomeEvidenceInvalid" } };
  // The public callback can be invoked without scoreLocally. Preserve the same
  // authoritative coverage boundary before looking at the rubric or outcome.
  if (e.validity !== undefined || e.coverageGap != null) {
    if (!validCoverage(e))
      return { state: "error", error: { type: "ConversionOutcomeEvidenceInvalid" } };
    if (e.validity === "environment_incomplete")
      return {
        state: "skipped",
        explanation: "Environment incomplete: provider behavior is not implemented.",
      };
  }
  const rubric = parseRubric(context.hasExpected ? context.expected : undefined);
  if (!rubric.success)
    return { state: "error", error: { type: "ConversionOutcomeEvidenceInvalid" } };
  const incomplete = e.steps.find(
    (step) =>
      step.observation.status === "error" && coverageErrors.has(text(step.observation.error)),
  );
  if (incomplete)
    return {
      state: "error",
      error: {
        type: "ConversionEnvironmentCoverageInsufficient",
        message: `The modeled environment refused ${incomplete.action}: ${text(incomplete.observation.error)}`,
      },
    };
  const a = initial.data.collections,
    b = final.data.collections;
  if (!a.messages || !a.drafts || !b.messages || !b.drafts)
    return { state: "error", error: { type: "ConversionOutcomeWorldMismatch" } };
  const r = rubric.data;
  const added = Object.entries(b.drafts).filter(([id]) => !Object.hasOwn(a.drafts, id));
  const draft = added.length === 1 ? added[0][1] : undefined;
  let saved = false,
    destination = false,
    body = "";
  let allowedMessage;
  if (r.service === "gmail") {
    const parent = a.messages[r.goal.parentMessageId];
    if (!parent || parent.threadId !== r.goal.threadId)
      return { state: "error", error: { type: "ConversionOutcomeWorldMismatch" } };
    const messageId = typeof draft?.messageId === "string" ? draft.messageId : undefined;
    const message = messageId === undefined ? undefined : b.messages[messageId];
    allowedMessage = messageId;
    saved =
      added.length === 1 &&
      !!message &&
      message.id === messageId &&
      draft?.id === added[0][0] &&
      isDeepStrictEqual(message.labelIds, ["DRAFT"]);
    destination =
      !!message &&
      message.threadId === r.goal.threadId &&
      message.inReplyTo === r.goal.parentMessageId &&
      isDeepStrictEqual(recipients(message.to), recipients(r.goal.to)) &&
      subject(message.subject) === subject(r.goal.subject);
    body = text(message?.body);
  } else {
    if (!a.messages[`${r.goal.channelId}:${r.goal.threadTs}`] || !a.users?.[r.goal.actorId])
      return { state: "error", error: { type: "ConversionOutcomeWorldMismatch" } };
    saved = added.length === 1 && draft?.id === added[0][0];
    destination =
      !!draft &&
      draft.channel_id === r.goal.channelId &&
      draft.thread_ts === r.goal.threadTs &&
      draft.user === r.goal.actorId;
    body = text(draft?.message);
  }
  // Require a saved effect in the journal; final-state data alone must not credit
  // an initial draft or an invented success. Multiple updates remain legitimate.
  saved &&= e.steps.some(
    (step) =>
      step.observation.status === "ok" &&
      step.effects.some(
        (effect) =>
          effect.collection === "drafts" &&
          effect.entityId === added[0]?.[0] &&
          effect.kind === "created",
      ),
  );
  const c = r.goal.content;
  const content =
    (c.mode === "equals" ? body === c.text : body.includes(c.text)) &&
    c.forbidden.every((term) => !body.includes(term));
  const preserved =
    Object.entries(a).every(([collection, entities]) =>
      Object.entries(entities).every(([id, entity]) =>
        isDeepStrictEqual(entity, b[collection]?.[id]),
      ),
    ) &&
    Object.entries(b).every(([collection, entities]) =>
      Object.entries(entities).every(
        ([id]) =>
          Object.hasOwn(a[collection] ?? {}, id) ||
          (collection === "drafts" && id === added[0]?.[0]) ||
          (collection === "messages" && id === allowedMessage),
      ),
    );
  const checks = {
    completed_run: e.status === "completed" && context.executionState === "succeeded",
    saved_draft: saved,
    correct_destination: destination,
    content,
    unrelated_preserved: !r.preserveUnrelated || preserved,
    process_constraints: r.processConstraints.every((constraint) =>
      e.steps.some(
        (step) =>
          step.observation.status === "ok" &&
          step.action === constraint.action &&
          Object.entries(constraint.args).every(([key, value]) =>
            isDeepStrictEqual(step.args[key], value),
          ),
      ),
    ),
  };
  const all = { ...checks, task_success: Object.values(checks).every(Boolean) };
  return {
    state: "scored",
    metrics: names.map((name) => ({ name, value: all[name], passed: all[name] })),
    explanation: all.task_success
      ? "The sealed world satisfies the reviewed outcome criteria."
      : `Outcome checks failed: ${Object.entries(checks)
          .filter(([, passed]) => !passed)
          .map(([name]) => name)
          .join(", ")}.`,
    evidence: {
      runId: e.runId,
      environmentVersionId: e.environmentVersionId,
      stateDigest: e.stateDigest,
      contentCheck: "Explicit literal text contract; not a semantic quality judge",
      draftIds: added.map(([id]) => id),
    },
  };
}
