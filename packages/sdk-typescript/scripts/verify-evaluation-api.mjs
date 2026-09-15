import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

// Opt-in: creates only synthetic evaluation artifacts in the supplied development project.
if (!process.env.HUE_API_KEY || !process.env.HUE_BASE_URL || !process.argv[2])
  throw new Error("Supply HUE_API_KEY/HUE_BASE_URL and an external tarball consumer directory");
const loader = join(resolve(process.argv[2]), "evaluation-imports.mjs");
await writeFile(
  loader,
  'export * as telemetry from "@hue-run/sdk"; export * as evaluation from "@hue-run/sdk/evals";',
);
const { telemetry, evaluation } = await import(pathToFileURL(loader));
const { createHue } = telemetry;
const {
  builtins,
  createEvaluationClient,
  defineLocalScorer,
  runExperiment,
  rescore,
  scoreLocally,
} = evaluation;
const connection = { apiKey: process.env.HUE_API_KEY, baseUrl: process.env.HUE_BASE_URL };
const client = createEvaluationClient(connection);
const suffix = randomUUID().slice(0, 8);
const artifact = await mkdtemp(join(tmpdir(), "hue-real-evaluation-"));
const dataset = await client.createDataset({
  name: `SDK acceptance ${suffix}`,
  slug: `sdk-acceptance-${suffix}`,
});
let draft = dataset.versions[0];
for (const item of [
  { externalKey: "greeting", inputs: { prompt: "Return the greeting" }, expected: "Hello!" },
  { externalKey: "null", inputs: null, expected: null },
  { externalKey: "failure", inputs: "controlled-error" },
]) {
  ({ version: draft } = await client.addCase(draft.id, {
    expectedRevision: draft.revision,
    ...item,
  }));
}
const frozen = await client.freezeDatasetVersion(draft.id, draft.revision);
assert.ok(frozen.contentDigest);
const local = defineLocalScorer({
  source: "acceptance-local-length-v1",
  entrypoint: "length",
  metrics: [{ name: "length", type: "number", min: 0 }],
  score: ({ output }) => ({
    state: "scored",
    metrics: [{ name: "length", value: typeof output === "string" ? output.length : 0 }],
    explanation: "Counted synthetic output length locally",
  }),
});
const definitions = [
  builtins.exactMatch(),
  builtins.includes(false),
  builtins.jsonSchema({ anyOf: [{ type: "string" }, { type: "null" }] }),
  local.definition,
];
const versions = [];
for (const [index, definition] of definitions.entries()) {
  const scorer = await client.createScorer({
    name: `SDK scorer ${index} ${suffix}`,
    slug: `sdk-scorer-${index}-${suffix}`,
  });
  versions.push(await client.publishScorerVersion(scorer.id, definition));
}
// This is the actual Node runtime, including the built worker file installed from the package.
const timed = await scoreLocally(
  {
    id: randomUUID(),
    contentDigest: "a".repeat(64),
    definition: builtins.jsonSchema({ type: "string", pattern: "^(a+)+$" }),
  },
  {
    inputs: null,
    metadata: {},
    hasOutput: true,
    output: `${"a".repeat(10000)}!`,
    hasExpected: false,
    executionState: "succeeded",
  },
  { schemaTimeoutMillis: 500 },
);
assert.equal(timed.state, "error");
assert.equal(timed.error.type, "SchemaTimeout");
const experiments = [];
let invocations = 0;
for (const [label, greeting, persistResultContent] of [
  ["A", "Hello!", true],
  ["B", "Hello there!", true],
  ["metadata", "private-synthetic-output", false],
]) {
  const hue = createHue({
    ...connection,
    serviceName: `sdk-evaluation-${suffix}`,
    captureContent: persistResultContent,
  });
  const experiment = await client.createExperiment({
    idempotencyKey: randomUUID(),
    name: `SDK ${label} ${suffix}`,
    datasetVersionId: frozen.id,
    scorerVersionIds: versions.map((version) => version.id),
    config: { greeting },
  });
  const options = {
    client,
    hue,
    experimentId: experiment.id,
    checkpointDirectory: join(artifact, experiment.id),
    persistResultContent,
    traceEvidence: { mode: "required" },
    scorers: [local],
    concurrency: 3,
    target: async (input, { config }) => {
      invocations++;
      if (input === "controlled-error") throw new Error("Intentional synthetic target failure");
      return input === null ? null : config.greeting;
    },
  };
  try {
    const report = await runExperiment(options);
    const beforeResume = invocations;
    const resumed = await runExperiment(options);
    assert.equal(invocations, beforeResume);
    assert.equal(resumed.resultIds.length, report.resultIds.length);
    assert.equal(report.subjectIds.length, 3);
    assert.equal(report.resultIds.length, 12);
    const recorded = await client.getResult(report.resultIds[0]);
    assert.ok(["scored", "skipped", "error"].includes(recorded.state));
    const subjects = await Promise.all(report.subjectIds.map((id) => client.getSubject(id)));
    assert.ok(
      subjects.every((subject) => subject.traceEvidence === "captured" && subject.traceSnapshotId),
    );
    if (persistResultContent)
      assert.ok(subjects.some((subject) => subject.hasOutput && subject.output === null));
    else assert.ok(subjects.every((subject) => !subject.hasOutput && !("output" in subject)));
    const historical = await client.createEvaluationRun({
      idempotencyKey: randomUUID(),
      name: `SDK rescore ${label} ${suffix}`,
      subjectIds: report.subjectIds,
      scorerVersionIds: [versions[0].id, versions[3].id],
    });
    const scored = await rescore({
      client,
      runId: historical.id,
      checkpointDirectory: join(artifact, historical.id),
      persistResultContent,
      scorers: [local],
    });
    assert.equal(invocations, beforeResume);
    assert.equal(scored.resultIds.length, 6);
    const run = await client.getEvaluationRun(historical.id);
    if (!persistResultContent) assert.equal(run.scores.skipped, 6);
    experiments.push({
      label,
      experimentId: experiment.id,
      runId: report.runId,
      historicalRunId: historical.id,
      subjectIds: report.subjectIds,
      resultIds: report.resultIds,
      historicalScores: run.scores,
    });
  } finally {
    await hue.shutdown();
  }
}
assert.equal(invocations, 9);
const report = {
  datasetId: dataset.id,
  datasetVersionId: frozen.id,
  scorerVersionIds: versions.map((version) => version.id),
  invocations,
  experiments,
};
await writeFile(join(artifact, "acceptance.json"), JSON.stringify(report, null, 2), {
  mode: 0o600,
});
console.log(JSON.stringify({ artifact, ...report }, null, 2));
