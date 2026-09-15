# Local evaluations

This provisional, private package executes targets and scorers on your machine. Hue stores pinned definitions, experiment progress and results. It does not execute uploaded source code. Install from the reviewed package tarball until a public release is explicitly approved.

```ts
import { randomUUID } from "node:crypto";
import { createHue } from "@hue/sdk";
import { builtins, createEvaluationClient, runExperiment, rescore } from "@hue/sdk/evals";

const connection = { apiKey: process.env.HUE_API_KEY! };
const client = createEvaluationClient(connection);
const hue = createHue({ ...connection, serviceName: "evaluation-demo", captureContent: false });

// Registry writes use optimistic revisions; they do not have automatic retries.
const dataset = await client.createDataset({ name: "Greetings", slug: "greetings" });
let draft = dataset.versions[0];
({ version: draft } = await client.addCase(draft.id, {
  expectedRevision: draft.revision,
  externalKey: "hello",
  inputs: { message: "hello" },
  expected: "Hello!",
}));
const frozen = await client.freezeDatasetVersion(draft.id, draft.revision);
const scorer = await client.createScorer({ name: "Exact", slug: "exact" });
const exact = await client.publishScorerVersion(scorer.id, builtins.exactMatch());

// Persist each creation key/returned ID in your application before retrying creation.
const experiment = await client.createExperiment({
  idempotencyKey: randomUUID(),
  name: "Greeting configuration A",
  datasetVersionId: frozen.id,
  scorerVersionIds: [exact.id],
  config: { greeting: "Hello!" },
});
try {
  const report = await runExperiment({
    client,
    hue,
    experimentId: experiment.id,
    checkpointDirectory: `.hue-checkpoints/${experiment.id}`,
    persistResultContent: true,
    traceEvidence: { mode: "required" },
    concurrency: 2,
    // Replace this deterministic example with your real agent invocation.
    target: async (_inputs, { config }) => (config as { greeting: string }).greeting,
  });
  const historical = await client.createEvaluationRun({
    idempotencyKey: randomUUID(),
    name: "Exact rescore",
    subjectIds: report.subjectIds,
    scorerVersionIds: [exact.id],
  });
  await rescore({
    client,
    runId: historical.id,
    checkpointDirectory: `.hue-checkpoints/${historical.id}`,
    persistResultContent: true,
  });
} finally {
  await hue.shutdown();
}
```

Create another experiment with the same frozen version and different `config` to compare configurations. The runner reads the exact experiment case/version and scorer definitions; it never resolves a mutable latest version. `rescore` accepts an existing evaluation-run ID and has no target callback. Subject IDs refer to immutable saved outputs and trace evidence.

## Content and result states

Both choices are required and independent:

- `captureContent` configures telemetry helpers and Vercel telemetry callbacks.
- `persistResultContent` configures completion output, target error messages, scorer evidence and arbitrary scorer explanations, including local checkpoint files. When false, the runner keeps these only in memory while computing scores and uploads generic explanations. Declared metric values are always uploaded, including custom text metrics; do not put sensitive output in a metric unless that is intended.

Frozen dataset inputs/references already exist on Hue. Their presence is independent of these switches. No output is inferred from telemetry. JavaScript `undefined` means unavailable output; JSON `null`, false, zero and empty string remain present values. Historical subjects with unavailable output produce skipped results without executing a scorer callback. A failed quality metric remains `state:"scored"` with `passed:false`. Target errors and scorer errors remain separate. Target error types are generalized to `TargetError`; when content is enabled, bounded messages may be stored. Never put credentials in error messages, output, custom metric values, names or metadata.

`traceEvidence:{mode:"required"}` waits for trace and log export acknowledgement after the root span ends. The explicit alternative `{mode:"omit",reason:"..."}` stores the omission reason and declared trace ID without a fake snapshot. It can complete despite an export failure; export diagnostics remain available on the Hue client. There is no automatic fallback to omission.

## Local scorers

Built-ins execute exact typed JSON equality, string inclusion (with pinned case sensitivity), and JSON Schema draft 2020-12 via pinned Ajv. Exact/includes skip absent references; includes skips non-string operands. Object key order does not affect exact match; array order and scalar types do.

JSON Schema compilation and validation run in an isolated worker with a default 2-second deadline (`schemaTimeoutMillis:100..60000`), terminated before returning a timeout error. No remote schema loading, custom formats, coercion or default insertion is enabled. Compilation errors are errors, not failed quality scores. Worker startup time counts toward the deadline. This is an execution bound, not a general security sandbox. Schema registration also enforces the server's supported schema subset. Ajv documents [draft 2020-12 support](https://ajv.js.org/json-schema.html) and [schema/regular-expression security considerations](https://ajv.js.org/security.html).

```ts
import { readFile } from "node:fs/promises";
import { defineLocalScorer } from "@hue/sdk/evals";
import { score } from "./my-scorer.js";

const local = defineLocalScorer({
  source: await readFile(new URL("./my-scorer.js", import.meta.url)),
  entrypoint: "score",
  metrics: [{ name: "quality", type: "number", min: 0, max: 1 }],
  score,
});
const identity = await client.createScorer({ name: "Quality", slug: "quality" });
const published = await client.publishScorerVersion(identity.id, local.definition);
// Pin published.id in the experiment and pass scorers:[local] to the runner.
```

A callback receives `{inputs,hasOutput,output?,hasExpected,expected?,metadata,executionState}` and returns one of:

- `{state:"scored",metrics:[{name,value,passed?}],explanation?,evidence?}` (explanation or evidence required).
- `{state:"error",error:{type,message?}}`.
- `{state:"skipped",explanation:"reason"}`.

All declared metrics must appear exactly once and satisfy pinned types, bounds and categories. The binding must match language, entrypoint, SHA-256 source digest and metric definitions. The digest is an authenticated caller declaration; it does not attest closures, dependency versions or actual execution. Callback source is never downloaded or evaluated. Callbacks are trusted local code; they have **no execution timeout or side-effect cancellation**. Concurrency limits active cases to 1–16 (default 1), with scorers evaluated sequentially within each case.

### Hosted and manual scorer pins

The local runner leaves `llm_judge` and `manual` pins pending and reports their IDs in `deferredScorerVersionIds`. It does not upload a synthetic skipped result that would occupy their immutable result slot. Manual results require a human session. Hosted dispatch is an explicit separate API operation: inspect `getJudgeBudget()`, then call `createJudgeJobs(runId,{idempotencyKey,jobs:[{evaluationItemId,scorerVersionId}]})`. `listJudgeJobs`, `getJudgeJob` and `cancelJudgeJob` expose job progress and cancellation requests. These methods never claim that local execution has hosted provenance. Hosted job endpoints are covered by HTTP contract tests here; live hosted model execution is a separate platform acceptance phase. `listResults` and `getResult` read recorded local or hosted results.

## Checkpoints and failures

Use one dedicated mode-0700 directory per experiment/rescore run. Files are mode 0600, written through fsync and atomic rename, and protected against accidental corruption by a digest. This is local storage, not encryption. Do not check it into Git. The manifest binds project, origin, frozen versions/configuration, scorer pins and content choices. Keep the directory until you no longer need upload recovery.

An exclusive `.lock` prevents two processes from invoking targets through the same checkpoint. A process crash can leave the lock behind. Confirm the recorded process has stopped before explicitly removing that lock; the SDK never guesses ownership from elapsed time. Removing a lock does not authorize another target call.

The runner saves a starting marker before `start`, and a running marker before invoking a target. If an outcome is not durably saved, resume throws `UncertainExecutionError` and never reruns the target. Replaying an original start key only recovers its execution ID. The low-level `startExecution` API requires an explicit `previousExecutionId`; replacing a still-started attempt additionally requires `allowUncertainRetry:true`. The convenience runner does not automatically adopt externally created attempts. Create a fresh experiment for a fresh target run after investigating side effects.

After a target completes and local scoring finishes, the runner saves the allowed completion/result payloads before uploading. Network/API errors leave those payloads and stable keys available for another call to `runExperiment` with the same directory. Saved receipt IDs prevent duplicate result writes. Serialization failure raises `OutcomeSerializationError` with the execution ID; it does not relabel the target as failed or invoke it again. Scoring/upload failures never change target state.

A crash between target completion and saving its permitted result still leaves an uncertain outcome; metadata-only mode intentionally cannot reconstruct discarded output. Export acknowledgement is saved separately. If required telemetry export was not acknowledged, a fresh empty exporter is not evidence of prior receipt: automatic completion is refused. Inspect/export the original trace or use the low-level completion API with an explicit omission policy; do not rerun a known completed target to manufacture telemetry. API completion/results retain their own idempotency guarantees for explicit recovery.

Concurrent flush calls each perform a fresh serialized drain. Because OTLP partial responses do not identify rejected records, any export failure during a case prevents the runner from acknowledging that case's required evidence, including a failure already surfaced by another concurrent flush. This deliberately favors explicit recovery over accepting possibly incomplete evidence.

The runner stops scheduling more cases after an operational failure and waits for already active cases before releasing the lock. It does not undo target side effects. A historical rescore can repeat local scoring after a crash before its checkpoint was saved; its result uploads use saved immutable payloads and stable keys once prepared.

## Verification boundaries

`scripts/verify-package.mjs` installs a real packed tarball outside the monorepo and runs HTTP contract tests against a synthetic service plus actual OpenTelemetry exporters. It checks two configurations, rescoring without target invocation, absent/null output, upload resume, uncertain execution, exclusive checkpoints, source/metric contracts, content policy and terminating schema workers. `scripts/verify-evaluation-api.mjs` is a separate opt-in acceptance against a real Hue receiver/API; it creates synthetic datasets/scorers/experiments in the project associated with the supplied development key.
