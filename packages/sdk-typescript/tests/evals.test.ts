import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs/light.js";
import schema from "./fixtures/otlp-schema.json" with { type: "json" };
import { createHue, HueExportError } from "../src/index.js";
import { CheckpointStore } from "../src/evals/checkpoint.js";
import {
  builtins,
  createEvaluationClient,
  defineLocalScorer,
  HueApiError,
  OutcomeSerializationError,
  rescore,
  runExperiment,
  scoreLocally,
  sourceDigest,
  UncertainExecutionError,
  type Completion,
  type EvaluationRun,
  type Execution,
  type Experiment,
  type ExperimentCase,
  type JsonValue,
  type Result,
  type ScorerVersion,
  type Subject,
} from "../src/evals.js";

const key = "synthetic-evaluation-key";
const digest = "b".repeat(64);
const otlp = protobuf.Root.fromJSON(schema);
const version = (definition: ScorerVersion["definition"]): ScorerVersion => ({
  id: randomUUID(),
  contentDigest: digest,
  definition,
});
const context = (output: unknown, expected?: unknown) => ({
  inputs: {},
  metadata: {},
  hasOutput: output !== undefined,
  ...(output !== undefined ? { output: output as null } : {}),
  hasExpected: expected !== undefined,
  ...(expected !== undefined ? { expected: expected as null } : {}),
  executionState: "succeeded" as const,
});
const directory = () => mkdtemp(join(tmpdir(), "hue-eval-checkpoint-"));

/** Synthetic API contract service. Actual receiver/database acceptance is a separate integration check. */
function fixture() {
  const projectId = randomUUID();
  const datasetId = randomUUID();
  const datasetVersionId = randomUUID();
  const cases: ExperimentCase[] = [
    {
      id: randomUUID(),
      datasetVersionId,
      externalKey: "text",
      inputs: "secret-input",
      expected: "answer",
      hasExpected: true,
      metadata: {},
    },
    {
      id: randomUUID(),
      datasetVersionId,
      externalKey: "null",
      inputs: null,
      expected: null,
      hasExpected: true,
      metadata: {},
    },
  ];
  const versions = [version(builtins.exactMatch()), version(builtins.includes(false))];
  const experiments = new Map<string, Experiment>();
  const executions = new Map<string, Execution & { caseId: string; experimentId: string }>();
  const subjects = new Map<string, Subject>();
  const runs = new Map<string, EvaluationRun>();
  const runItems = new Map<
    string,
    { id: string; subjectId: string; hasOutput: boolean; traceSnapshotId: string | null }[]
  >();
  const results: Result[] = [];
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const receipts = new Map<string, { body: string; response: unknown }>();
  const traceIds = new Set<string>();
  const wire: string[] = [];
  let completeFailures = 0;
  let telemetryFailures = 0;
  let resultFailures = 0;
  let startFailures = 0;
  let truncatedItemPages = 0;
  const create = (config: unknown = { suffix: "" }) => {
    const id = randomUUID();
    const runId = randomUUID();
    const run: EvaluationRun = {
      id: runId,
      name: "default",
      scorerVersions: versions,
      itemCount: cases.length,
      scores: { scored: 0, error: 0, skipped: 0, pending: cases.length * versions.length },
    };
    const experiment: Experiment = {
      id,
      name: "contract",
      datasetVersionId,
      config: config as null,
      configDigest: digest,
      evaluation: run,
      caseCount: cases.length,
      finishedAt: null,
      execution: {
        unstarted: cases.length,
        started: 0,
        uncertain: 0,
        succeeded: 0,
        error: 0,
        cancelled: 0,
      },
    };
    experiments.set(id, experiment);
    runs.set(runId, run);
    runItems.set(runId, []);
    return experiment;
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
      const url = new URL(request.url);
      const path = url.pathname.replace("/api/v1", "");
      if (path === "/projects/current")
        return Response.json({
          id: projectId,
          name: "Synthetic",
          slug: "synthetic",
          organizationId: randomUUID(),
        });
      if (path.startsWith("/otlp/")) {
        if (telemetryFailures-- > 0) {
          await request.arrayBuffer();
          return new Response(null, { status: 401 });
        }
        let bytes = Buffer.from(await request.arrayBuffer());
        if (request.headers.get("content-encoding") === "gzip") bytes = gunzipSync(bytes);
        const isTrace = path.endsWith("traces");
        const type = otlp.lookupType(
          `opentelemetry.proto.collector.${isTrace ? "trace" : "logs"}.v1.Export${isTrace ? "Trace" : "Logs"}ServiceRequest`,
        );
        const value = type.toObject(type.decode(bytes), { bytes: String, longs: String });
        wire.push(JSON.stringify(value));
        if (isTrace)
          for (const resource of value.resourceSpans)
            for (const scope of resource.scopeSpans)
              for (const span of scope.spans)
                traceIds.add(Buffer.from(span.traceId, "base64").toString("hex"));
        return new Response(new Uint8Array(), {
          headers: { "Content-Type": "application/x-protobuf" },
        });
      }
      const body =
        request.method === "GET" ? {} : ((await request.json()) as Record<string, unknown>);
      requests.push({ path, body });
      const receiptKey =
        typeof body.idempotencyKey === "string" ? `${path}:${body.idempotencyKey}` : undefined;
      const prior = receiptKey ? receipts.get(receiptKey) : undefined;
      if (prior)
        return JSON.stringify(body) === prior.body
          ? Response.json(prior.response)
          : new Response(null, { status: 409 });
      const send = (response: unknown) => {
        if (receiptKey) receipts.set(receiptKey, { body: JSON.stringify(body), response });
        return Response.json(response);
      };
      if (path === "/datasets" && request.method === "POST")
        return send({ id: datasetId, ...body, versions: [{ id: datasetVersionId, revision: 1 }] });
      if (path === "/scorers" && request.method === "POST")
        return send({ id: randomUUID(), ...body });
      if (/^\/scorers\/[^/]+\/versions$/.test(path))
        return send(version(body.definition as ScorerVersion["definition"]));
      if (path === `/dataset-versions/${datasetVersionId}`)
        return send({
          id: datasetVersionId,
          datasetId,
          version: 1,
          revision: 3,
          frozenAt: new Date().toISOString(),
          contentDigest: digest,
        });
      if (path === `/dataset-versions/${datasetVersionId}/cases`)
        return send({
          item: { id: randomUUID(), ...body },
          version: { id: datasetVersionId, revision: Number(body.expectedRevision) + 1 },
        });
      if (path === `/dataset-versions/${datasetVersionId}/freeze`)
        return send({
          id: datasetVersionId,
          revision: body.expectedRevision,
          frozenAt: new Date().toISOString(),
          contentDigest: digest,
        });
      if (path === "/experiments") {
        const exp = create(body.config);
        return send({ id: exp.id, evaluationRunId: exp.evaluation.id });
      }
      const experimentMatch =
        /^\/experiments\/([^/]+)(?:\/items(?:\/([^/]+)(?:\/(start))?)?|\/(finish))?$/.exec(path);
      if (experimentMatch) {
        const exp = experiments.get(experimentMatch[1])!;
        if (!exp) return new Response(null, { status: 404 });
        if (experimentMatch[4]) return send({ id: exp.id, finishedAt: new Date().toISOString() });
        if (experimentMatch[3]) {
          if (startFailures-- > 0) return new Response(null, { status: 503 });
          const execution = {
            id: randomUUID(),
            state: "started" as const,
            attempt: 1,
            traceExternalId: String(body.traceExternalId),
            caseId: experimentMatch[2],
            experimentId: exp.id,
          };
          executions.set(execution.id, execution);
          return send(execution);
        }
        if (experimentMatch[2]) return send(cases.find((item) => item.id === experimentMatch[2]));
        if (path.endsWith("/items")) {
          const index = url.searchParams.has("after")
            ? cases.findIndex((item) => item.id === url.searchParams.get("after")) + 1
            : 0;
          const item = cases[index];
          return send({
            items: item
              ? [
                  {
                    id: item.id,
                    externalKey: item.externalKey,
                    hasExpected: item.hasExpected,
                    execution:
                      [...executions.values()].find(
                        (execution) =>
                          execution.experimentId === exp.id && execution.caseId === item.id,
                      ) ?? null,
                  },
                ]
              : [],
            nextCursor: index < cases.length - 1 ? item.id : null,
          });
        }
        return send(exp);
      }
      const executionMatch = /^\/experiment-executions\/([^/]+)(\/complete)?$/.exec(path);
      if (executionMatch) {
        const execution = executions.get(executionMatch[1])!;
        if (!executionMatch[2]) return send(execution);
        if (completeFailures-- > 0) return new Response(null, { status: 503 });
        if (body.traceEvidence !== "omit" && !traceIds.has(execution.traceExternalId!))
          return new Response(null, { status: 409 });
        const item = cases.find((item) => item.id === execution.caseId)!;
        const subjectId = randomUUID();
        const evaluationItemId = randomUUID();
        const exp = experiments.get(execution.experimentId)!;
        const hasOutput = Object.hasOwn(body, "output");
        const snapshot = body.traceEvidence === "omit" ? null : randomUUID();
        const subject = {
          ...item,
          id: subjectId,
          executionId: execution.id,
          caseId: item.id,
          caseExternalKey: item.externalKey,
          hasOutput,
          ...(hasOutput ? { output: body.output } : {}),
          outputEvidence: hasOutput ? "available" : "unavailable",
          executionState: body.state,
          contentDigest: digest,
          traceSnapshotId: snapshot,
          experimentId: exp.id,
          attempt: 1,
          traceEvidence: snapshot ? "captured" : "omitted",
          traceExternalId: execution.traceExternalId,
          omissionReason: body.omissionReason ?? null,
        } as Subject;
        subjects.set(subjectId, subject);
        execution.state = body.state as Execution["state"];
        execution.subjectId = subjectId;
        runItems
          .get(exp.evaluation.id)!
          .push({ id: evaluationItemId, subjectId, hasOutput, traceSnapshotId: snapshot });
        return send({
          executionId: execution.id,
          subjectId,
          evaluationItemId,
          traceSnapshotId: snapshot,
        } satisfies Completion);
      }
      if (path === "/evaluation-runs") {
        const id = randomUUID();
        const run: EvaluationRun = {
          id,
          name: String(body.name),
          scorerVersions: versions.filter((version) =>
            (body.scorerVersionIds as string[]).includes(version.id),
          ),
          itemCount: (body.subjectIds as string[]).length,
          scores: { scored: 0, skipped: 0, error: 0, pending: 0 },
        };
        runs.set(id, run);
        runItems.set(
          id,
          (body.subjectIds as string[]).map((subjectId) => ({
            id: randomUUID(),
            subjectId,
            hasOutput: subjects.get(subjectId)!.hasOutput,
            traceSnapshotId: subjects.get(subjectId)!.traceSnapshotId,
          })),
        );
        return send({ id });
      }
      const runMatch = /^\/evaluation-runs\/([^/]+)(?:\/(items|results))?$/.exec(path);
      if (runMatch) {
        if (!runMatch[2]) return send(runs.get(runMatch[1]));
        if (runMatch[2] === "items") {
          const items = runItems.get(runMatch[1])!;
          return send({
            items: truncatedItemPages-- > 0 ? items.slice(0, 1) : items,
            nextCursor: null,
          });
        }
        if (request.method === "GET") return send({ items: [], nextCursor: null });
        if (resultFailures-- > 0) return new Response(null, { status: 503 });
        const submitted = body.results as Result[];
        results.push(...submitted);
        return send({ ids: submitted.map(() => randomUUID()) });
      }
      if (path.startsWith("/evaluation-subjects/")) return send(subjects.get(path.split("/")[2]));
      return new Response(null, { status: 404 });
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const client = createEvaluationClient({ apiKey: key, baseUrl });
  return {
    server,
    client,
    baseUrl,
    create,
    cases,
    versions,
    subjects,
    results,
    requests,
    wire,
    executions,
    failComplete: () => (completeFailures = 1),
    failTelemetry: () => (telemetryFailures = 1),
    failResult: () => (resultFailures = 1),
    failStart: () => (startFailures = 1),
    truncateItemPage: () => (truncatedItemPages = 1),
  };
}

describe("local evaluation scorers", () => {
  test("typed JSON exact match, missing versus null, includes and schema 2020-12", async () => {
    const exact = version(builtins.exactMatch());
    expect(
      await scoreLocally(exact, context({ a: 1, b: [false] }, { b: [false], a: 1 })),
    ).toMatchObject({ state: "scored", metrics: [{ value: true }] });
    expect(await scoreLocally(exact, context(false, 0))).toMatchObject({
      state: "scored",
      metrics: [{ value: false, passed: false }],
    });
    expect(await scoreLocally(exact, context(null, null))).toMatchObject({
      state: "scored",
      metrics: [{ value: true }],
    });
    expect(await scoreLocally(exact, context(undefined, null))).toMatchObject({
      state: "skipped",
      explanation: "Output evidence is unavailable",
    });
    expect(await scoreLocally(exact, context("answer"))).toMatchObject({
      state: "skipped",
      explanation: "Reference evidence is unavailable",
    });
    expect(
      await scoreLocally(version(builtins.includes(false)), context("HELLO WORLD", "world")),
    ).toMatchObject({ state: "scored", metrics: [{ value: true }] });
    const schema = version(
      builtins.jsonSchema({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "array",
        prefixItems: [{ type: "string" }],
        items: false,
        minItems: 1,
        maxItems: 1,
      }),
    );
    expect(await scoreLocally(schema, context(["ok"]))).toMatchObject({
      state: "scored",
      metrics: [{ value: true }],
    });
    expect(await scoreLocally(schema, context([1]))).toMatchObject({
      state: "scored",
      metrics: [{ value: false }],
    });
    expect(
      await scoreLocally(
        version(builtins.jsonSchema({ minimum: 0, customAnnotation: "valid annotation" })),
        context(1),
      ),
    ).toMatchObject({ state: "scored", metrics: [{ value: true }] });
    expect(
      await scoreLocally(
        version(builtins.jsonSchema({ $ref: "https://example.invalid/schema" })),
        context(null),
      ),
    ).toMatchObject({ state: "error" });
  });
  test("schema worker is actually terminated for catastrophic regex", async () => {
    const started = Date.now();
    const result = await scoreLocally(
      version(builtins.jsonSchema({ type: "string", pattern: "^(a+)+$" })),
      context(`${"a".repeat(10000)}!`),
      { schemaTimeoutMillis: 200 },
    );
    expect(result).toEqual({ state: "error", error: { type: "SchemaTimeout" } });
    expect(Date.now() - started).toBeLessThan(3000);
  });
  test("local source-bound metrics reject invalid values and preserve quality failure", async () => {
    const scorer = defineLocalScorer({
      source: "score-v1",
      entrypoint: "score",
      metrics: [{ name: "quality", type: "number", min: 0, max: 1 }],
      score: () => ({
        state: "scored",
        metrics: [{ name: "quality", value: 0.2, passed: false }],
        explanation: "Measured quality",
      }),
    });
    expect(scorer.definition.sourceDigest).toBe(sourceDigest("score-v1"));
    expect(
      await scoreLocally(version(scorer.definition), context("output"), { scorers: [scorer] }),
    ).toMatchObject({ state: "scored", metrics: [{ value: 0.2, passed: false }] });
    expect(
      await scoreLocally(version(scorer.definition), context("output"), {
        scorers: [
          {
            ...scorer,
            score: () => ({
              state: "scored",
              metrics: [{ name: "quality", value: 4 }],
              explanation: "invalid",
            }),
          },
        ],
      }),
    ).toEqual({ state: "error", error: { type: "LocalScorerError" } });
  });
});

describe("installed evaluation API and runner contract", () => {
  test("runs up to 64 cases at once and refuses more", async () => {
    const options = (concurrency: number) =>
      ({ persistResultContent: false, concurrency }) as never;
    for (const concurrency of [0, 65, 1.5])
      await expect(runExperiment(options(concurrency))).rejects.toThrow("concurrency must be 1–64");
    // 64 clears the bound and stops at the next required option.
    await expect(runExperiment(options(64))).rejects.toThrow(
      "Choose a trace evidence policy explicitly",
    );
  });

  test("a failure consumed by another flush cannot acknowledge incomplete case evidence", async () => {
    const f = fixture();
    const exp = f.create();
    let calls = 0;
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "failed-evidence",
      captureContent: false,
    });
    const options = {
      client: f.client,
      hue,
      experimentId: exp.id,
      checkpointDirectory: await directory(),
      persistResultContent: true,
      traceEvidence: { mode: "required" as const },
      target: async () => {
        calls++;
        await hue.withSpan("lost-child", () => {});
        f.failTelemetry();
        await expect(hue.flush()).rejects.toBeInstanceOf(HueExportError);
        return "known completed output";
      },
    };
    try {
      await expect(runExperiment(options)).rejects.toBeInstanceOf(HueExportError);
      expect(f.requests.filter((request) => request.path.endsWith("/complete"))).toEqual([]);
      await expect(runExperiment(options)).rejects.toThrow(
        "trace export acknowledgement is unavailable",
      );
      expect(calls).toBe(1);
    } finally {
      await hue.shutdown();
      f.server.stop(true);
    }
  });
  test("every non-local and unknown scorer pin is deferred without uploading placeholders", async () => {
    const f = fixture();
    const hosted = version({
      kind: "llm_judge",
      config: {
        model: "openai/gpt-5",
        provider: "openai",
        rubric: "Assess quality",
        bindings: [{ name: "output", path: "/output", required: true }],
        maxOutputTokens: 1024,
        timeoutMs: 60000,
      },
      metrics: [{ name: "quality", type: "boolean" }],
    });
    const manual = version({ kind: "manual", metrics: [{ name: "quality", type: "boolean" }] });
    const world = version({
      kind: "world_outcome",
      entry: "hue.conversion_outcome.v1",
      metrics: [],
    });
    const unknown = version(JSON.parse('{"kind":"future_kind"}'));
    const unknownBuiltin = version(
      JSON.parse('{"kind":"builtin","entry":"hue.future.v1","config":{}}'),
    );
    const deferred = [hosted, manual, world, unknown, unknownBuiltin];
    const deferredIds = deferred.map((pin) => pin.id);
    f.versions.push(...deferred);
    const exp = f.create();
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "deferred",
      captureContent: false,
    });
    try {
      const report = await runExperiment({
        client: f.client,
        hue,
        experimentId: exp.id,
        checkpointDirectory: await directory(),
        persistResultContent: false,
        traceEvidence: { mode: "required" },
        target: () => "answer",
      });
      expect(report.deferredScorerVersionIds).toEqual(deferredIds);
      expect(f.results).toHaveLength(4);
      expect(f.results.every((result) => !deferredIds.includes(result.scorerVersionId))).toBe(true);
      const run = await f.client.createEvaluationRun({
        idempotencyKey: randomUUID(),
        name: "Deferred",
        subjectIds: report.subjectIds,
        scorerVersionIds: deferredIds,
      });
      const rescored = await rescore({
        client: f.client,
        runId: run.id,
        checkpointDirectory: await directory(),
        persistResultContent: false,
      });
      expect(rescored.resultIds).toEqual([]);
      expect(rescored.deferredScorerVersionIds).toEqual(deferredIds);
      for (const pin of deferred) {
        await expect(scoreLocally(pin, context("answer"))).rejects.toThrow("deferred");
        await expect(scoreLocally(pin, { ...context("answer"), hasOutput: false })).rejects.toThrow(
          "deferred",
        );
      }
    } finally {
      await hue.shutdown();
      f.server.stop(true);
    }
  });
  test("hosted job controls use the public HTTP contract without claiming local provenance", async () => {
    const requests: { path: string; body?: unknown }[] = [];
    const runId = randomUUID();
    const jobId = randomUUID();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
        const path = new URL(request.url).pathname;
        const body = request.method === "POST" ? await request.json() : undefined;
        requests.push({ path, body });
        if (path.endsWith("/judge-budget")) return Response.json({ enabled: false });
        if (path.endsWith("/cancel")) return Response.json({ id: jobId, state: "cancelled" });
        if (path.endsWith("/judge-jobs"))
          return Response.json(
            request.method === "POST"
              ? { ids: [jobId] }
              : { items: [{ id: jobId }], nextCursor: null },
          );
        return Response.json({ id: jobId, state: "queued" });
      },
    });
    const client = createEvaluationClient({
      apiKey: key,
      baseUrl: `http://127.0.0.1:${server.port}`,
    });
    try {
      const body = {
        idempotencyKey: randomUUID(),
        jobs: [{ evaluationItemId: randomUUID(), scorerVersionId: randomUUID() }],
      };
      expect(await client.createJudgeJobs(runId, body)).toEqual({ ids: [jobId] });
      expect((await client.listJudgeJobs(runId)).items.map((item) => item.id)).toEqual([jobId]);
      expect((await client.getJudgeJob(jobId)).state).toBe("queued");
      expect((await client.cancelJudgeJob(jobId, "Operator cancellation")).state).toBe("cancelled");
      expect((await client.getJudgeBudget()).enabled).toBe(false);
      expect(requests[0]).toEqual({ path: `/api/v1/evaluation-runs/${runId}/judge-jobs`, body });
      expect(requests[3].body).toEqual({ reason: "Operator cancellation" });
    } finally {
      server.stop(true);
    }
  });
  test("hosted reads distinguish resolved credentials and reconciled charges from execution success", async () => {
    const jobId = randomUUID();
    const runId = randomUUID();
    let settled = false;
    let exposeAuthentication = true;
    const job = () => ({
      id: jobId,
      state: "uncertain",
      chargeState: settled ? "settled" : "uncertain",
      originalChargeState: "uncertain",
      actualMicroUsd: settled ? 2500 : null,
      receipt: { actualMicroUsd: null },
      reconciliation: settled
        ? {
            jobId,
            actualMicroUsd: 2500,
            evidenceReference: "synthetic-provider-statement-42",
            reason: "Verified final charge after interrupted execution",
            createdAt: "2026-09-15T10:00:00.000Z",
          }
        : null,
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
        expect(request.method).toBe("GET");
        const path = new URL(request.url).pathname;
        if (path.endsWith("/judge-budget"))
          return Response.json({
            configured: true,
            enabled: false,
            ...(exposeAuthentication
              ? {
                  authentication: {
                    status: "available",
                    method: "oidc",
                    verification: "credential_resolution",
                  },
                }
              : {}),
          });
        if (path === `/api/v1/evaluation-runs/${runId}/judge-jobs`)
          return Response.json({ items: [job()], nextCursor: null });
        if (path === `/api/v1/judge-jobs/${jobId}`) return Response.json(job());
        return new Response(null, { status: 404 });
      },
    });
    const client = createEvaluationClient({ apiKey: key, baseUrl: server.url.origin });
    try {
      const budget = await client.getJudgeBudget();
      expect(budget.authentication?.status).toBe("available");
      expect(budget.authentication?.method).toBe("oidc");
      expect(budget.authentication?.verification).toBe("credential_resolution");
      expect(budget.enabled).toBe(false);
      const original = await client.getJudgeJob(jobId);
      expect(original.reconciliation).toBeNull();
      expect(original.actualMicroUsd).toBeNull();

      settled = true;
      const updated = (await client.listJudgeJobs(runId)).items[0];
      expect(updated.chargeState).toBe("settled");
      expect(updated.originalChargeState).toBe(original.chargeState);
      expect(updated.state).toBe(original.state);
      expect(updated.receipt).toEqual(original.receipt);
      if (!updated.reconciliation) throw new Error("Settled fixture is missing its reconciliation");
      expect(updated.actualMicroUsd).toBe(updated.reconciliation.actualMicroUsd);
      expect(updated.reconciliation.evidenceReference).toBe("synthetic-provider-statement-42");
      expect(updated.reconciliation.reason).toBe(
        "Verified final charge after interrupted execution",
      );
      expect(updated.reconciliation.createdAt).toBe("2026-09-15T10:00:00.000Z");
      expect(updated.reconciliation.jobId).toBe(jobId);

      exposeAuthentication = false;
      expect((await client.getJudgeBudget()).authentication).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });
  test("evaluation requests refuse credential-bearing redirects and sanitize failures", async () => {
    let redirectedHits = 0;
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        redirectedHits++;
        return Response.json({});
      },
    });
    const redirect = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(key, {
          status: 307,
          headers: { Location: `http://127.0.0.1:${target.port}` },
        });
      },
    });
    const client = createEvaluationClient({
      apiKey: key,
      baseUrl: `http://127.0.0.1:${redirect.port}`,
    });
    try {
      await expect(client.checkConnection()).rejects.toThrow(
        "Hue API connection or response failed",
      );
      expect(redirectedHits).toBe(0);
    } finally {
      redirect.stop(true);
      target.stop(true);
    }
  });
  test("public dataset/scorer registry methods preserve null and revision", async () => {
    const f = fixture();
    try {
      const dataset = await f.client.createDataset({ name: "test", slug: "test" });
      const added = await f.client.addCase(dataset.versions[0].id, {
        expectedRevision: 1,
        externalKey: "null",
        inputs: null,
        expected: null,
      });
      expect(added.version.revision).toBe(2);
      expect(f.requests.at(-1)!.body).toHaveProperty("expected", null);
      expect(
        (await f.client.freezeDatasetVersion(dataset.versions[0].id, 2)).frozenAt,
      ).toBeTruthy();
      const scorer = await f.client.createScorer({ name: "Exact", slug: "exact" });
      expect(
        (await f.client.publishScorerVersion(scorer.id, builtins.exactMatch())).definition,
      ).toEqual(builtins.exactMatch());
      // An older compatible v1 response does not promise its owning evaluator ID.
      expect(
        (await f.client.publishEvaluatorVersion(scorer.id, builtins.exactMatch())).evaluatorId,
      ).toBeUndefined();
      expect(() => f.client.getExperiment("../../secret")).toThrow("UUID");
      await expect(
        f.client.addCase(dataset.versions[0].id, {
          expectedRevision: 1,
          externalKey: "nan",
          inputs: NaN,
        }),
      ).rejects.toThrow("JSON");
      let expanded: JsonValue = { value: true };
      for (let depth = 0; depth < 15; depth++) expanded = [expanded, expanded];
      const requestCount = f.requests.length;
      await expect(
        f.client.addCase(dataset.versions[0].id, {
          expectedRevision: 1,
          externalKey: "expanded-shared-graph",
          inputs: expanded,
        }),
      ).rejects.toThrow("depth/node limits");
      expect(f.requests).toHaveLength(requestCount);
    } finally {
      f.server.stop(true);
    }
  });
  test("product registry methods keep v1 paths and leave customer fields untouched", async () => {
    const setId = randomUUID();
    const setVersionId = randomUUID();
    const caseId = randomUUID();
    const evaluatorId = randomUUID();
    const evaluatorVersionId = randomUUID();
    const paths: string[] = [];
    const setVersion = {
      id: setVersionId,
      datasetId: setId,
      version: 1,
      revision: 1,
      frozenAt: null,
      contentDigest: null,
    };
    const set = { id: setId, name: "Set", slug: "set", versions: [setVersion] };
    const evalCase = {
      id: caseId,
      datasetVersionId: setVersionId,
      externalKey: "one",
      inputs: { datasetId: "customer-input" },
      metadata: { scorerId: "customer-metadata" },
    };
    const evaluatorVersion = {
      id: evaluatorVersionId,
      scorerId: evaluatorId,
      contentDigest: digest,
      definition: { ...builtins.exactMatch(), scorerId: "customer-definition" },
    };
    const evaluator = {
      id: evaluatorId,
      name: "Exact",
      slug: "exact",
      versions: [evaluatorVersion],
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
        const path = new URL(request.url).pathname.replace("/api/v1", "");
        paths.push(`${request.method} ${path}`);
        if (path === "/datasets")
          return Response.json(request.method === "GET" ? { items: [set], nextCursor: null } : set);
        if (path === `/datasets/${setId}`) return Response.json(set);
        if (path === `/datasets/${setId}/versions`) return Response.json(setVersion);
        if (path === `/dataset-versions/${setVersionId}`) return Response.json(setVersion);
        if (path === `/dataset-versions/${setVersionId}/cases`)
          return Response.json(
            request.method === "GET"
              ? { items: [evalCase], nextCursor: null }
              : { item: evalCase, version: setVersion },
          );
        if (path === `/dataset-versions/${setVersionId}/freeze`)
          return Response.json({ ...setVersion, frozenAt: new Date().toISOString() });
        if (path === "/scorers")
          return Response.json(
            request.method === "GET" ? { items: [evaluator], nextCursor: null } : evaluator,
          );
        if (path === `/scorers/${evaluatorId}`) return Response.json(evaluator);
        if (path === `/scorers/${evaluatorId}/versions`) return Response.json(evaluatorVersion);
        if (path === `/scorer-versions/${evaluatorVersionId}`)
          return Response.json(evaluatorVersion);
        return new Response(null, { status: 404 });
      },
    });
    const client = createEvaluationClient({
      apiKey: key,
      baseUrl: `http://127.0.0.1:${server.port}`,
    });
    try {
      expect((await client.createEvalSet({ name: "Set", slug: "set" })).versions[0].evalSetId).toBe(
        setId,
      );
      expect((await client.getEvalSet(setId)).versions[0].evalSetId).toBe(setId);
      expect((await client.listEvalSets()).items[0].id).toBe(setId);
      expect((await client.createEvalSetVersion(setId)).evalSetId).toBe(setId);
      expect((await client.getEvalSetVersion(setVersionId)).evalSetId).toBe(setId);
      const listedCase = (await client.listEvalSetCases(setVersionId)).items[0];
      expect(listedCase.evalSetVersionId).toBe(setVersionId);
      expect(listedCase.inputs).toEqual({ datasetId: "customer-input" });
      const added = await client.addEvalSetCase(setVersionId, {
        expectedRevision: 1,
        externalKey: "one",
        inputs: { datasetId: "customer-input" },
      });
      expect(added.item.evalSetVersionId).toBe(setVersionId);
      expect(added.version.evalSetId).toBe(setId);
      expect((await client.freezeEvalSetVersion(setVersionId, 1)).frozenAt).toBeTruthy();
      expect((await client.createEvaluator({ name: "Exact", slug: "exact" })).id).toBe(evaluatorId);
      expect((await client.getEvaluator(evaluatorId)).versions?.[0].evaluatorId).toBe(evaluatorId);
      expect((await client.listEvaluators()).items[0].id).toBe(evaluatorId);
      const published = await client.publishEvaluatorVersion(evaluatorId, builtins.exactMatch());
      expect(published.evaluatorId).toBe(evaluatorId);
      expect(published.definition).toHaveProperty("scorerId", "customer-definition");
      expect((await client.getEvaluatorVersion(evaluatorVersionId)).evaluatorId).toBe(evaluatorId);
      expect(
        paths.every((path) => !path.includes("eval-sets") && !path.includes("evaluators")),
      ).toBe(true);
    } finally {
      server.stop(true);
    }
  });
  test("product run and scoring methods keep v1 paths and distinct IDs", async () => {
    const runId = randomUUID();
    const scoringId = randomUUID();
    const evalSetVersionId = randomUUID();
    const evaluatorId = randomUUID();
    const evaluatorVersionId = randomUUID();
    const caseId = randomUUID();
    const itemId = randomUUID();
    const subjectId = randomUUID();
    const resultId = randomUUID();
    const executionId = randomUUID();
    const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
    const scoring = {
      id: scoringId,
      name: "Scoring",
      scorerVersions: [
        {
          id: evaluatorVersionId,
          scorerId: evaluatorId,
          contentDigest: digest,
          definition: { scorerId: "customer-definition" },
        },
      ],
      itemCount: 1,
      scores: { scored: 0, error: 0, skipped: 0, pending: 1 },
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
        const path = new URL(request.url).pathname.replace("/api/v1", "");
        const body =
          request.method === "GET" ? {} : ((await request.json()) as Record<string, unknown>);
        calls.push({ method: request.method, path, body });
        if (path === "/experiments")
          return Response.json({ id: runId, evaluationRunId: scoringId });
        if (path === `/experiments/${runId}`)
          return Response.json({
            id: runId,
            name: "Run",
            datasetVersionId: evalSetVersionId,
            config: { experimentId: "customer-config" },
            evaluation: scoring,
          });
        if (path === `/experiments/${runId}/items`)
          return Response.json({
            items: [{ id: itemId, externalKey: "one", execution: null }],
            nextCursor: null,
          });
        if (path === `/experiments/${runId}/items/${caseId}`)
          return Response.json({
            id: caseId,
            datasetVersionId: evalSetVersionId,
            inputs: { datasetVersionId: "customer-input" },
            metadata: {},
          });
        if (
          path === `/experiments/${runId}/items/${caseId}/start` ||
          path === `/experiment-executions/${executionId}`
        )
          return Response.json({
            id: executionId,
            state: "started",
            attempt: 1,
            traceExternalId: null,
          });
        if (path === `/experiment-executions/${executionId}/complete`)
          return Response.json({
            executionId,
            subjectId,
            traceSnapshotId: null,
            evaluationItemId: itemId,
          });
        if (path === `/experiments/${runId}/finish`)
          return Response.json({ id: runId, finishedAt: new Date().toISOString() });
        if (path === "/evaluation-runs")
          return Response.json(
            request.method === "GET"
              ? {
                  items: [{ id: scoringId, experimentId: runId, name: "Scoring" }],
                  nextCursor: null,
                }
              : { id: scoringId },
          );
        if (path === `/evaluation-runs/${scoringId}`) return Response.json(scoring);
        if (path === `/evaluation-runs/${scoringId}/items`)
          return Response.json({ items: [{ id: itemId, subjectId }], nextCursor: null });
        if (path === `/evaluation-runs/${scoringId}/results`)
          return Response.json(
            request.method === "GET"
              ? {
                  items: [{ id: resultId, itemId, scorerVersionId: evaluatorVersionId }],
                  nextCursor: null,
                }
              : { ids: [resultId] },
          );
        if (path === `/evaluation-results/${resultId}`)
          return Response.json({
            id: resultId,
            itemId,
            runId: scoringId,
            scorerVersionId: evaluatorVersionId,
            state: "scored",
            metrics: [],
            explanation: null,
            evidence: { runId: "customer-evidence" },
            error: null,
            sourceDigest: null,
          });
        if (path === `/evaluation-subjects/${subjectId}`)
          return Response.json({
            id: subjectId,
            experimentId: runId,
            datasetVersionId: evalSetVersionId,
            inputs: { experimentId: "customer-subject" },
          });
        return new Response(null, { status: 404 });
      },
    });
    const client = createEvaluationClient({
      apiKey: key,
      baseUrl: `http://127.0.0.1:${server.port}`,
    });
    try {
      expect(
        (
          await client.createRun({
            idempotencyKey: randomUUID(),
            name: "Run",
            evalSetVersionId,
            evaluatorVersionIds: [evaluatorVersionId],
            config: { experimentId: "customer-config" },
          })
        ).scoringId,
      ).toBe(scoringId);
      expect(calls.at(-1)?.body).toMatchObject({
        evalSetVersionId,
        evaluatorVersionIds: [evaluatorVersionId],
        config: { experimentId: "customer-config" },
      });
      const run = await client.getRun(runId);
      expect(run.evalSetVersionId).toBe(evalSetVersionId);
      expect(run.scoring.evaluatorVersions[0].evaluatorId).toBe(evaluatorId);
      expect(run.config).toEqual({ experimentId: "customer-config" });
      expect((await client.listRunItems(runId)).items[0].id).toBe(itemId);
      expect((await client.getRunCase(runId, caseId)).inputs).toEqual({
        datasetVersionId: "customer-input",
      });
      expect(
        (await client.startRunExecution(runId, caseId, { idempotencyKey: randomUUID() })).id,
      ).toBe(executionId);
      expect((await client.getRunExecution(executionId)).id).toBe(executionId);
      expect(
        (
          await client.completeRunExecution(executionId, {
            idempotencyKey: randomUUID(),
            state: "succeeded",
          })
        ).subjectId,
      ).toBe(subjectId);
      expect((await client.finishRun(runId, randomUUID())).id).toBe(runId);
      expect(
        (
          await client.createScoring({
            idempotencyKey: randomUUID(),
            name: "Scoring",
            subjectIds: [subjectId],
            evaluatorVersionIds: [evaluatorVersionId],
          })
        ).id,
      ).toBe(scoringId);
      expect(calls.at(-1)?.body).toHaveProperty("evaluatorVersionIds", [evaluatorVersionId]);
      expect((await client.getScoring(scoringId)).evaluatorVersions[0].evaluatorId).toBe(
        evaluatorId,
      );
      expect((await client.listScorings()).items[0].runId).toBe(runId);
      expect((await client.listScoringItems(scoringId)).items[0].subjectId).toBe(subjectId);
      expect((await client.getScoringSubject(subjectId)).runId).toBe(runId);
      expect(
        (
          await client.submitScoringResults(scoringId, {
            idempotencyKey: randomUUID(),
            results: [
              {
                evaluationItemId: itemId,
                evaluatorVersionId,
                state: "scored",
                metrics: [],
                evidence: { scorerVersionId: "customer-evidence" },
              },
            ],
          })
        ).ids,
      ).toEqual([resultId]);
      expect(calls.at(-1)?.body).toHaveProperty("results.0.evaluatorVersionId", evaluatorVersionId);
      expect((await client.listScoringResults(scoringId)).items[0].evaluatorVersionId).toBe(
        evaluatorVersionId,
      );
      const stored = await client.getScoringResult(resultId);
      expect(stored.scoringId).toBe(scoringId);
      expect(stored.evidence).toEqual({ runId: "customer-evidence" });
      expect(
        calls.every(({ path }) => !path.includes("/runs") && !path.includes("/scorings")),
      ).toBe(true);
    } finally {
      server.stop(true);
    }
  });
  test("two configurations complete and rescore frozen subjects without invoking targets", async () => {
    const f = fixture();
    let calls = 0;
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "eval-test",
      captureContent: true,
    });
    try {
      const reports = [];
      for (const suffix of ["", "!"]) {
        const exp = f.create({ suffix });
        reports.push(
          await runExperiment({
            client: f.client,
            hue,
            experimentId: exp.id,
            checkpointDirectory: await directory(),
            persistResultContent: true,
            traceEvidence: { mode: "required" },
            concurrency: 2,
            target: (input, { config }) => {
              calls++;
              return input === null ? null : `answer${(config as { suffix: string }).suffix}`;
            },
          }),
        );
      }
      expect(calls).toBe(4);
      expect(f.results.length).toBe(8);
      expect(
        f.results.some((result) => result.state === "scored" && result.metrics[0].passed === false),
      ).toBe(true);
      const run = await f.client.createEvaluationRun({
        idempotencyKey: randomUUID(),
        name: "Rescore",
        subjectIds: reports[0].subjectIds,
        scorerVersionIds: [f.versions[0].id],
      });
      await rescore({
        client: f.client,
        runId: run.id,
        checkpointDirectory: await directory(),
        persistResultContent: true,
      });
      expect(calls).toBe(4);
      expect(f.results.length).toBe(10);
      expect(
        [...f.subjects.values()].filter((subject) => subject.output === null && subject.hasOutput),
      ).toHaveLength(2);
    } finally {
      await hue.shutdown();
      f.server.stop(true);
    }
  });
  test("resume defers old checkpoint placeholders for both experiments and rescores without rerunning targets", async () => {
    const f = fixture();
    const deferred = version({
      kind: "world_outcome",
      entry: "hue.conversion_outcome.v1",
      metrics: [],
    });
    f.versions.push(deferred);
    const exp = f.create();
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "upgrade-resume",
      captureContent: false,
    });
    let calls = 0;
    const options = {
      client: f.client,
      hue,
      experimentId: exp.id,
      checkpointDirectory: await directory(),
      persistResultContent: true,
      traceEvidence: { mode: "required" as const },
      target: () => {
        calls++;
        return "answer";
      },
    };
    async function seedOldPlaceholder(dir: string, prefix: string) {
      const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
      const store = await CheckpointStore.acquire(dir, manifest.value.identity);
      try {
        const name = (await readdir(dir))
          .find((name) => name.startsWith(prefix) && name.endsWith(".json"))!
          .slice(0, -5);
        const saved = (await store.read<{
          scores: {
            key: string;
            payload: {
              scorerVersionId: string;
              evaluationItemId?: string;
              state: string;
              explanation: string;
            };
          }[];
        }>(name))!;
        saved.scores.push({
          key: randomUUID(),
          payload: {
            scorerVersionId: deferred.id,
            evaluationItemId: saved.scores[0]!.payload.evaluationItemId,
            state: "skipped",
            explanation: "Old SDK placeholder",
          },
        });
        await store.write(name, saved);
      } finally {
        await store.release();
      }
    }
    try {
      f.failResult();
      await expect(runExperiment(options)).rejects.toBeInstanceOf(HueApiError);
      expect(calls).toBe(1);
      await seedOldPlaceholder(options.checkpointDirectory, "case-");
      const report = await runExperiment(options);
      expect(calls).toBe(2);
      expect(report.deferredScorerVersionIds).toEqual([deferred.id]);
      expect(report.resultIds).toHaveLength(4);
      await runExperiment(options);
      expect(calls).toBe(2);
      const run = await f.client.createEvaluationRun({
        idempotencyKey: randomUUID(),
        name: "Resume",
        subjectIds: report.subjectIds,
        scorerVersionIds: f.versions.map((pin) => pin.id),
      });
      const rescoring = {
        client: f.client,
        runId: run.id,
        checkpointDirectory: await directory(),
        persistResultContent: true,
      };
      f.failResult();
      await expect(rescore(rescoring)).rejects.toBeInstanceOf(HueApiError);
      await seedOldPlaceholder(rescoring.checkpointDirectory, "item-");
      const rescored = await rescore(rescoring);
      expect(rescored.deferredScorerVersionIds).toEqual([deferred.id]);
      expect(rescored.resultIds).toHaveLength(4);
      expect(calls).toBe(2);
      const uploaded = f.requests
        .filter((request) => request.path.endsWith("/results") && request.body.results)
        .flatMap((request) => (request.body as { results: Result[] }).results);
      expect(uploaded.every((score) => score.scorerVersionId !== deferred.id)).toBe(true);
    } finally {
      await hue.shutdown();
      f.server.stop(true);
    }
  });
  test("completion and score upload retries reuse saved outcomes, receipts and keys", async () => {
    const f = fixture();
    const exp = f.create();
    let calls = 0;
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "resume",
      captureContent: false,
    });
    const options = {
      client: f.client,
      hue,
      experimentId: exp.id,
      checkpointDirectory: await directory(),
      persistResultContent: true,
      traceEvidence: { mode: "required" as const },
      target: () => {
        calls++;
        return "answer";
      },
    };
    try {
      f.failComplete();
      await expect(runExperiment(options)).rejects.toBeInstanceOf(HueApiError);
      expect(calls).toBe(1);
      f.failResult();
      await expect(runExperiment(options)).rejects.toBeInstanceOf(HueApiError);
      expect(calls).toBe(1);
      const report = await runExperiment(options);
      expect(calls).toBe(2);
      expect(report.resultIds).toHaveLength(4);
      await runExperiment(options);
      expect(calls).toBe(2);
      expect(f.results).toHaveLength(4);
      const completions = f.requests.filter((request) => request.path.endsWith("/complete"));
      expect(completions[0].body).toEqual(completions[1].body);
    } finally {
      await hue.shutdown();
      f.server.stop(true);
    }
  });
  test("shared object graphs survive completion retries without replaying targets", async () => {
    const f = fixture();
    const shared = { values: [1, null, false] };
    const output = { first: shared, second: [shared, shared.values] };
    for (const item of f.cases) item.expected = output;
    const exp = f.create();
    let calls = 0;
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "shared-output",
      captureContent: false,
    });
    const options = {
      client: f.client,
      hue,
      experimentId: exp.id,
      checkpointDirectory: await directory(),
      persistResultContent: true,
      traceEvidence: { mode: "required" as const },
      target: () => {
        calls++;
        return output;
      },
    };
    try {
      f.failComplete();
      await expect(runExperiment(options)).rejects.toBeInstanceOf(HueApiError);
      expect(calls).toBe(1);
      const report = await runExperiment(options);
      expect(report.subjectIds).toHaveLength(2);
      expect(calls).toBe(2);
      for (const subject of f.subjects.values()) expect(subject.output).toEqual(output);
      expect(f.results.filter((result) => result.scorerVersionId === f.versions[0].id)).toEqual([
        expect.objectContaining({
          state: "scored",
          metrics: [{ name: "match", value: true, passed: true }],
        }),
        expect.objectContaining({
          state: "scored",
          metrics: [{ name: "match", value: true, passed: true }],
        }),
      ]);
      await runExperiment(options);
      expect(calls).toBe(2);
      expect(f.results).toHaveLength(4);
    } finally {
      await hue.shutdown();
      f.server.stop(true);
    }
  });
  test("rescore rejects truncated frozen items before scoring or uploads and can retry", async () => {
    const f = fixture();
    let scorerCalls = 0;
    const custom = defineLocalScorer({
      source: "count-rescore-invocations",
      entrypoint: "score",
      metrics: [{ name: "ok", type: "boolean" }],
      score: () => {
        scorerCalls++;
        return { state: "scored", metrics: [{ name: "ok", value: true }] };
      },
    });
    const local = version(custom.definition);
    f.versions.push(local);
    const exp = f.create();
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "rescore-items",
      captureContent: false,
    });
    try {
      const report = await runExperiment({
        client: f.client,
        hue,
        experimentId: exp.id,
        checkpointDirectory: await directory(),
        persistResultContent: true,
        traceEvidence: { mode: "required" },
        scorers: [custom],
        target: () => "answer",
      });
      const run = await f.client.createEvaluationRun({
        idempotencyKey: randomUUID(),
        name: "Truncated items",
        subjectIds: report.subjectIds,
        scorerVersionIds: [local.id],
      });
      const dir = await directory();
      const options = {
        client: f.client,
        runId: run.id,
        checkpointDirectory: dir,
        persistResultContent: true,
        scorers: [custom],
      };
      scorerCalls = 0;
      const priorResults = f.results.length;
      f.truncateItemPage();
      await expect(rescore(options)).rejects.toThrow("Frozen evaluation run item count differs");
      expect(scorerCalls).toBe(0);
      expect(f.results).toHaveLength(priorResults);
      expect(await readdir(dir)).toEqual([]);
      const rescored = await rescore(options);
      expect(rescored.subjectIds).toHaveLength(2);
      expect(rescored.resultIds).toHaveLength(2);
      expect(scorerCalls).toBe(2);
      await rescore(options);
      expect(scorerCalls).toBe(2);
      expect(f.results).toHaveLength(priorResults + 2);
    } finally {
      await hue.shutdown();
      f.server.stop(true);
    }
  });
  test("metadata-only policy omits output on disk/API and skips historical unavailable evidence", async () => {
    const f = fixture();
    const exp = f.create();
    const dir = await directory();
    const custom = defineLocalScorer({
      source: "privacy-scorer",
      entrypoint: "score",
      metrics: [{ name: "ok", type: "boolean" }],
      score: () => ({
        state: "scored",
        metrics: [{ name: "ok", value: true }],
        explanation: "secret-output",
        evidence: "secret-output",
      }),
    });
    f.versions.push(version(custom.definition));
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "private",
      captureContent: false,
    });
    try {
      const report = await runExperiment({
        client: f.client,
        hue,
        experimentId: exp.id,
        checkpointDirectory: dir,
        persistResultContent: false,
        traceEvidence: { mode: "required" },
        scorers: [custom],
        target: () => "secret-output",
      });
      expect(
        [...f.subjects.values()].every((subject) => !subject.hasOutput && !("output" in subject)),
      ).toBe(true);
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        expect((await stat(join(dir, entry.name))).mode & 0o077).toBe(0);
        if (entry.isFile())
          expect(await readFile(join(dir, entry.name), "utf8")).not.toContain("secret-output");
      }
      expect(f.wire.join()).not.toContain("secret-input");
      expect(f.wire.join()).not.toContain("secret-output");
      expect(
        JSON.stringify(
          f.requests.filter(
            (request) => request.path.endsWith("/complete") || request.path.endsWith("/results"),
          ),
        ),
      ).not.toContain("secret-output");
      const run = await f.client.createEvaluationRun({
        idempotencyKey: randomUUID(),
        name: "Unavailable",
        subjectIds: report.subjectIds,
        scorerVersionIds: [f.versions[0].id],
      });
      await rescore({
        client: f.client,
        runId: run.id,
        checkpointDirectory: await directory(),
        persistResultContent: false,
      });
      expect(
        f.results
          .slice(-2)
          .every((score) => score.state === "skipped" && score.explanation.includes("unavailable")),
      ).toBe(true);
    } finally {
      await hue.shutdown();
      f.server.stop(true);
    }
  });
  test("uncertain starts and serialization failures never invoke a target on resume", async () => {
    const f = fixture();
    const exp = f.create();
    let calls = 0;
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "uncertain",
      captureContent: false,
    });
    const options = {
      client: f.client,
      hue,
      experimentId: exp.id,
      checkpointDirectory: await directory(),
      persistResultContent: true,
      traceEvidence: { mode: "required" as const },
      target: () => {
        calls++;
        return NaN;
      },
    };
    try {
      await expect(runExperiment(options)).rejects.toBeInstanceOf(OutcomeSerializationError);
      await expect(runExperiment(options)).rejects.toBeInstanceOf(OutcomeSerializationError);
      expect(calls).toBe(1);
      const cyclic: Record<string, JsonValue> = {};
      cyclic.self = cyclic;
      const cycleOptions = {
        ...options,
        experimentId: f.create().id,
        checkpointDirectory: await directory(),
        target: () => {
          calls++;
          return cyclic;
        },
      };
      await expect(runExperiment(cycleOptions)).rejects.toBeInstanceOf(OutcomeSerializationError);
      await expect(runExperiment(cycleOptions)).rejects.toBeInstanceOf(OutcomeSerializationError);
      expect(calls).toBe(2);
      const other = {
        ...options,
        experimentId: f.create().id,
        checkpointDirectory: await directory(),
      };
      f.failStart();
      await expect(runExperiment(other)).rejects.toBeInstanceOf(HueApiError);
      await expect(runExperiment(other)).rejects.toBeInstanceOf(UncertainExecutionError);
      expect(calls).toBe(2);
    } finally {
      await hue.shutdown();
      f.server.stop(true);
    }
  });
  test("exclusive checkpoint ownership prevents concurrent duplicate target execution", async () => {
    const f = fixture();
    const exp = f.create();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hue = createHue({
      apiKey: key,
      baseUrl: f.baseUrl,
      serviceName: "lock",
      captureContent: false,
    });
    const options = {
      client: f.client,
      hue,
      experimentId: exp.id,
      checkpointDirectory: await directory(),
      persistResultContent: false,
      traceEvidence: {
        mode: "omit" as const,
        reason: "Explicit synthetic metadata-only acceptance",
      },
      target: async () => {
        entered();
        await hold;
        return null;
      },
    };
    const first = runExperiment(options);
    try {
      await ready;
      await expect(runExperiment(options)).rejects.toThrow("locked");
    } finally {
      release();
      await first;
      await hue.shutdown();
      f.server.stop(true);
    }
    expect(
      [...f.subjects.values()].every(
        (subject) => subject.traceEvidence === "omitted" && subject.traceSnapshotId === null,
      ),
    ).toBe(true);
  });
});
