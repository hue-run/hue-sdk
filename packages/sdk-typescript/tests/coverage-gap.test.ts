import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createEnvironmentClient,
  type CoverageGap,
  type CoverageGapInput,
} from "../src/environment.js";
import {
  builtins,
  createEvaluationClient,
  defineLocalScorer,
  scoreLocally,
  type EnvironmentEvidence,
  type ScorerVersion,
} from "../src/evals.js";

const reason = "Environment incomplete: provider behavior is not implemented.";
function sealedEvidence(executionId: string = randomUUID(), count = 7): EnvironmentEvidence {
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
function gap(): CoverageGap {
  return {
    provider: "google.gmail.mcp",
    operation: "create_draft",
    code: "html_body_unimplemented",
    args: { htmlBody: "<p>synthetic fixture</p>", attachments: [{ mimeType: "text/plain" }] },
    description: "HTML draft content is not implemented.",
    reportedAt: "2026-09-18T05:49:02.000Z",
    reportedBy: { kind: "project_key", id: randomUUID() },
  };
}

test("coverage reporting retries the same durable request after a lost acknowledgement", async () => {
  const runId = randomUUID();
  const { reportedAt, reportedBy, ...input } = gap();
  const body: CoverageGapInput = { idempotencyKey: randomUUID(), ...input };
  const requests: string[] = [];
  const saved = {
    runId,
    validity: "environment_incomplete" as const,
    coverageGap: { ...input, reportedAt, reportedBy },
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe(`/api/v1/environment-runs/${runId}/coverage-gap`);
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-key");
      requests.push(await request.text());
      return requests.length === 1 ? new Response(null, { status: 503 }) : Response.json(saved);
    },
  });
  try {
    const client = createEnvironmentClient({ apiKey: "synthetic-key", baseUrl: server.url.origin });
    expect(await client.recordCoverageGap(runId, body)).toEqual(saved);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
    expect(JSON.parse(requests[0]!)).toEqual(body);
    expect(() => client.recordCoverageGap(runId, { ...body, idempotencyKey: "invalid" })).toThrow();
    expect(() =>
      client.recordCoverageGap(runId, { ...body, args: { body: "x".repeat(16_000) } }),
    ).toThrow("byte limit");
    expect(requests).toHaveLength(2);
  } finally {
    server.stop(true);
  }
});

test.each([false, true])(
  "incomplete evidence skips builtins and callbacks with output=%s",
  async (hasOutput) => {
    const environment = {
      ...sealedEvidence(),
      validity: "environment_incomplete" as const,
      coverageGap: gap(),
    };
    let calls = 0;
    const local = defineLocalScorer({
      source: "fail if invoked",
      entrypoint: "score",
      metrics: [{ name: "quality", type: "boolean" }],
      score() {
        calls++;
        throw new Error("must not run");
      },
    });
    const context = {
      inputs: {},
      hasOutput,
      ...(hasOutput ? { output: "wrong" } : {}),
      hasExpected: true,
      expected: "right",
      metadata: {},
      executionState: "error" as const,
      environment,
    };
    for (const definition of [local.definition, builtins.exactMatch()]) {
      const version: ScorerVersion = {
        id: randomUUID(),
        contentDigest: "a".repeat(64),
        definition,
      };
      const result = await scoreLocally(version, context, { scorers: [local] });
      expect(result).toEqual({ state: "skipped", explanation: reason });
    }
    expect(calls).toBe(0);
  },
);

test.each([
  "missing_gap",
  "unassessed_gap",
  "invalid_provider",
  "args_array",
  "invalid_actor",
  "invalid_date",
  "oversized_args",
])("rejects malformed coverage evidence: %s", async (fault) => {
  const evidence = {
    ...sealedEvidence(),
    validity: "environment_incomplete" as const,
    coverageGap: gap(),
  };
  const malformed = JSON.parse(JSON.stringify(evidence));
  const record = malformed.coverageGap as Record<string, unknown>;
  if (fault === "missing_gap") malformed.coverageGap = null;
  if (fault === "unassessed_gap") malformed.validity = "not_assessed";
  if (fault === "invalid_provider") record.provider = "x".repeat(129);
  if (fault === "args_array") record.args = [];
  if (fault === "invalid_actor") record.reportedBy = { kind: "project_key", id: "wrong" };
  if (fault === "invalid_date") record.reportedAt = "yesterday";
  if (fault === "oversized_args") record.args = { body: "x".repeat(16_000) };
  const version: ScorerVersion = {
    id: randomUUID(),
    contentDigest: "a".repeat(64),
    definition: builtins.exactMatch(),
  };
  expect(
    await scoreLocally(version, {
      inputs: {},
      output: "wrong",
      expected: "right",
      hasOutput: true,
      hasExpected: true,
      metadata: {},
      executionState: "succeeded",
      environment: malformed,
    }),
  ).toEqual({ state: "error", error: { type: "LocalScorerError" } });
});
