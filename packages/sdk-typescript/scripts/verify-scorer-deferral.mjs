import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [consumer] = process.argv.slice(2);
if (!consumer) throw new Error("Provide the installed consumer path");
const require = createRequire(join(consumer, "package.json"));
const {
  builtins,
  createEvaluationClient,
  defineLocalScorer,
  rescore,
  scoreLocally,
} = require("@hue-run/sdk/evals");
const directory = await mkdtemp(join(tmpdir(), "hue-deferred-installed-"));
const version = (definition) => ({ id: randomUUID(), contentDigest: "d".repeat(64), definition });
const metric = { name: "quality", type: "boolean" };
const worldMetrics = [
  "completed_run",
  "saved_draft",
  "correct_destination",
  "content",
  "unrelated_preserved",
  "process_constraints",
  "task_success",
].map((name) => ({ name, type: "boolean" }));
const conversionV2Metrics = [
  "completed_run",
  "saved_draft",
  "correct_destination",
  "recipient",
  "thread",
  "subject",
  "content",
  "unrelated_preserved",
  "process_constraints",
  "task_success",
].map((name) => ({ name, type: "boolean" }));
const assertionV3Metrics = [
  { name: "task_success", type: "boolean" },
  ...[
    "assertions_passed",
    "assertions_failed",
    "advisory_failed",
    "agent_mistakes",
    "judges_passed",
    "judges_failed",
    "judges_advisory",
  ].map((name) => ({ name, type: "number", min: 0 })),
];
const judge = {
  model: "anthropic/claude-fable-5.1",
  provider: "anthropic",
  template: "a".repeat(64),
  samples: 3,
  temperature: 0,
  maxOutputTokens: 1024,
  timeoutMs: 60_000,
};
const deferred = [
  version({ kind: "manual", metrics: [metric] }),
  version({ kind: "llm_judge", config: {}, metrics: [metric] }),
  version({ kind: "world_outcome", entry: "hue.conversion_outcome.v1", metrics: worldMetrics }),
  // The newer Hue-executed entries are deferred the same way.
  version({
    kind: "world_outcome",
    entry: "hue.conversion_outcome.v2",
    metrics: conversionV2Metrics,
  }),
  version({
    kind: "world_outcome",
    entry: "hue.outcome_assertions.v3",
    metrics: assertionV3Metrics,
    config: { judge },
  }),
  // A newer server's kind must not fall through to the familiar includes entry.
  version({
    kind: "future_hosted_kind",
    entry: "hue.includes.v1",
    config: { caseSensitive: false },
    metrics: [metric],
  }),
  version({ kind: "builtin", entry: "hue.future.v1", config: {} }),
];
let localCalls = 0;
const local = defineLocalScorer({
  source: "synthetic local callback",
  entrypoint: "score",
  metrics: [metric],
  score: () => {
    localCalls++;
    return {
      state: "scored",
      metrics: [{ name: "quality", value: true }],
      explanation: "Synthetic local callback executed",
    };
  },
});
const locals = [version(builtins.includes(false)), version(local.definition)];
const runId = randomUUID();
const subjectId = randomUUID();
const itemId = randomUUID();
const projectId = randomUUID();
const scorerId = randomUUID();
const evidence = {
  inputs: null,
  hasOutput: true,
  output: "Answer",
  hasExpected: true,
  expected: "answer",
  metadata: {},
  executionState: "succeeded",
};
const uploads = [];
const publications = [];
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, "Bearer synthetic-deferral-key");
    response.setHeader("content-type", "application/json");
    const path = new URL(request.url, "http://localhost").pathname;
    const send = (value) => response.end(JSON.stringify(value));
    if (path === "/api/v1/projects/current")
      return send({ id: projectId, name: "Synthetic", organizationId: randomUUID(), slug: "test" });
    if (path === `/api/v1/evaluation-runs/${runId}`)
      return send({
        id: runId,
        name: "Deferred",
        itemCount: 1,
        scorerVersions: [...locals, ...deferred],
      });
    if (path === `/api/v1/evaluation-runs/${runId}/items`)
      return send({ items: [{ id: itemId, subjectId, hasOutput: true }], nextCursor: null });
    if (path === `/api/v1/evaluation-subjects/${subjectId}`)
      return send({ id: subjectId, executionId: randomUUID(), ...evidence });
    // rescore lists the run's recorded results before scoring so terminal scores are preserved;
    // this synthetic run has none, so resume still relies on the checkpoint.
    if (request.method === "GET" && path === `/api/v1/evaluation-runs/${runId}/results`)
      return send({ items: [], nextCursor: null });
    assert.equal(request.method, "POST");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (path === `/api/v1/scorers/${scorerId}/versions`) {
      publications.push(body.definition);
      return send(version(body.definition));
    }
    assert.equal(path, `/api/v1/evaluation-runs/${runId}/results`);
    assert.ok(
      body.results.every((result) => locals.some((pin) => pin.id === result.scorerVersionId)),
    );
    uploads.push(...body.results);
    return send({ ids: body.results.map(() => randomUUID()) });
  } catch {
    response.statusCode = 500;
    response.end(JSON.stringify({ error: "Synthetic deferral contract failed" }));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  for (const pin of deferred) {
    await assert.rejects(scoreLocally(pin, evidence), TypeError);
    await assert.rejects(
      scoreLocally(pin, { ...evidence, hasOutput: false, output: undefined }),
      TypeError,
    );
  }
  const options = {
    client: createEvaluationClient({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKey: "synthetic-deferral-key",
    }),
    runId,
    checkpointDirectory: directory,
    persistResultContent: false,
    scorers: [local],
  };
  const world = {
    kind: "world_outcome",
    entry: "hue.conversion_outcome.v1",
    metrics: worldMetrics,
  };
  const published = await options.client.publishScorerVersion(scorerId, world);
  assert.deepEqual(published.definition, world);
  assert.equal(publications.length, 1);
  const report = await rescore(options);
  assert.deepEqual(
    report.deferredScorerVersionIds,
    deferred.map((pin) => pin.id),
  );
  assert.equal(report.resultIds.length, 2);
  assert.equal(uploads.length, 2);
  assert.ok(uploads.every((result) => result.state === "scored"));
  assert.equal(uploads[1].sourceDigest, local.definition.sourceDigest);
  assert.equal(localCalls, 1);
  const resumed = await rescore(options);
  assert.deepEqual(resumed, report);
  assert.equal(localCalls, 1);
  assert.equal(uploads.length, 2);
  console.log("Installed scorer deferral, local bindings and checkpoint resume passed");
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
