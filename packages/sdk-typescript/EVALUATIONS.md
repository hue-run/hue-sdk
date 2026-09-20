# Local evaluations

Install the optional runtime-contract peer with the SDK before importing
`@hue-run/sdk/evals`:

```bash
npm install @hue-run/sdk zod
```

The SDK executes targets and scorers on your machine. Hue stores pinned definitions, experiment progress and results. It does not execute uploaded source code. Follow the [installation guide](https://docs.hue.run/installation) to add `@hue-run/sdk` to your application.

Create a **Tracing and evaluations** project service key under **Settings → Integrations & API keys** and expose it to this server-side process as `HUE_API_KEY`. A **Tracing only** key cannot author datasets or evaluation runs.

```ts
import { randomUUID } from "node:crypto";
import { createHue } from "@hue-run/sdk";
import { builtins, createEvaluationClient, runExperiment, rescore } from "@hue-run/sdk/evals";

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

For the shorter agent-against-a-hosted-world workflow, use `runSimulation`. It owns immutable
resolution, a fresh linked world per case, local and hosted MCP tools, finalization, sealed
evidence and scoring while retaining this runner's checkpoint guarantees. See
[Simulated environments](ENVIRONMENTS.md#run-a-scenario-like-a-test).

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
import { defineLocalScorer } from "@hue-run/sdk/evals";
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

In TypeScript `0.3.1` (unreleased), the local runner executes only the three known built-in entries and bound `local_code` scorers. It leaves every other pin pending and reports its ID in `deferredScorerVersionIds`, including kinds and built-in entries introduced by a newer server. It never uploads a placeholder result that would occupy the immutable result slot, including placeholders already saved in an older SDK's checkpoint. Direct `scoreLocally()` calls reject pins that require another executor.

`world_outcome` pins run inside Hue and need no local callback or executable source digest. A supporting server owns their execution from saved world evidence. Legacy `local_code` pins still require the exact registered callback; changing the worker cannot convert those immutable pins into hosted ones.

Manual results require a human session. Hosted model-judge dispatch is an explicit separate API operation: inspect `getJudgeBudget()`, then call `createJudgeJobs(runId,{idempotencyKey,jobs:[{evaluationItemId,scorerVersionId}]})`. `listJudgeJobs`, `getJudgeJob` and `cancelJudgeJob` expose job progress and cancellation requests. These methods never claim that local execution has hosted provenance. Hosted job endpoints are covered by HTTP contract tests here; live hosted model execution is a separate platform acceptance phase. `listResults` and `getResult` read recorded local or hosted results.

When present, the budget's `authentication` reports credential resolution only. An
`available` status or `configured: true` does not prove that a provider accepted the
credential, has funds, or permits the selected model. The project's `enabled`,
allocation and `blocked` fields are separate admission controls. Treat absent
authentication details as unknown.

Job reads preserve `originalChargeState` and the original provider `receipt`.
`chargeState` and `actualMicroUsd` reflect a separately verified reconciliation
when one exists; `reconciliation` is otherwise `null`. Its evidence reference,
reason and timestamp explain that settlement. A settled charge does not change
an interrupted job's execution state or rerun the model.

## Checkpoints and failures

Use one dedicated mode-0700 directory per experiment/rescore run. Files are mode 0600, written through fsync and atomic rename, and protected against accidental corruption by a digest. This is local storage, not encryption. Do not check it into Git. The manifest binds project, origin, frozen versions/configuration, scorer pins and content choices. Keep the directory until you no longer need upload recovery.

An exclusive `.lock` prevents two processes from invoking targets through the same checkpoint. A process crash can leave the lock behind. Confirm the recorded process has stopped before explicitly removing that lock; the SDK never guesses ownership from elapsed time. Removing a lock does not authorize another target call.

The runner saves a starting marker before `start`, and a running marker before invoking a target. If an outcome is not durably saved, resume throws `UncertainExecutionError` and never reruns the target. Replaying an original start key only recovers its execution ID. The low-level `startExecution` API requires an explicit `previousExecutionId`; replacing a still-started attempt additionally requires `allowUncertainRetry:true`. The convenience runner does not automatically adopt externally created attempts. Create a fresh experiment for a fresh target run after investigating side effects.

After a target completes and local scoring finishes, the runner saves the allowed completion/result payloads before uploading. Network/API errors leave those payloads and stable keys available for another call to `runExperiment` with the same directory. Saved receipt IDs prevent duplicate result writes. Serialization failure raises `OutcomeSerializationError` with the execution ID; it does not relabel the target as failed or invoke it again. Scoring/upload failures never change target state.

A crash between target completion and saving its permitted result still leaves an uncertain outcome; metadata-only mode intentionally cannot reconstruct discarded output. Export acknowledgement is saved separately. If required telemetry export was not acknowledged, a fresh empty exporter is not evidence of prior receipt: automatic completion is refused. Inspect/export the original trace or use the low-level completion API with an explicit omission policy; do not rerun a known completed target to manufacture telemetry. API completion/results retain their own idempotency guarantees for explicit recovery.

Concurrent flush calls each perform a fresh serialized drain. Because OTLP partial responses do not identify rejected records, any export failure during a case prevents the runner from acknowledging that case's required evidence, including a failure already surfaced by another concurrent flush. This deliberately favors explicit recovery over accepting possibly incomplete evidence.

The runner stops scheduling more cases after an operational failure and waits for already active cases before releasing the lock. It does not undo target side effects. A historical rescore can repeat local scoring after a crash before its checkpoint was saved; its result uploads use saved immutable payloads and stable keys once prepared.

## Verification boundaries

`scripts/verify-package.mjs` installs a real packed tarball outside the monorepo and runs HTTP contract tests against a synthetic service plus actual OpenTelemetry exporters. It checks two configurations, rescoring without target invocation, absent/null output, upload resume, uncertain execution, exclusive checkpoints, source/metric contracts, content policy and terminating schema workers. It also exercises the local worker's ready, incomplete and uncertain provider-attempt control-plane paths, but does not call an issued provider facade. `scripts/verify-evaluation-api.mjs` is a separate opt-in acceptance against a real Hue receiver/API; it creates synthetic datasets/scorers/experiments in the project associated with the supplied development key.

## Outbound local agent worker

`runLocalAgent` shipped in `@hue-run/sdk@0.3.0` and is publicly available. Install
`npm install @hue-run/sdk zod`. Queue registration, claims, scoped MCP capabilities and sealed
evidence require a supporting Hue server and project access; the package version alone does not
establish hosted provider availability.

`runLocalAgent` registers one fixed application callback and polls for queued runs. Hue selects
the registered key/revision; it does not send executable code or shell commands. Keep the
checkpoint directory private and durable. The worker persists result content and requires
acknowledged trace and sealed environment evidence.

```ts
import { createHue } from "@hue-run/sdk";
import { createEnvironmentClient } from "@hue-run/sdk/environment";
import { createEvaluationClient, runLocalAgent } from "@hue-run/sdk/evals";
import { runMyAgent } from "./agent.js"; // Your existing application entry point.

const connection = { apiKey: process.env.HUE_API_KEY! };
const hue = createHue({ ...connection, serviceName: "local-worker", captureContent: false });
try {
  await runLocalAgent({
    client: createEvaluationClient(connection),
    environmentClient: createEnvironmentClient(connection),
    hue,
    agent: { key: "support-agent", name: "Support agent", revision: "1" },
    checkpointDirectory: ".hue-checkpoints/support-agent",
    scorers: [], // Hue-executed scorers require no local callback registration.
    target: (inputs, tools, context) => runMyAgent({ inputs, tools, config: context.config }),
  });
} finally {
  await hue.shutdownSafe();
}
```

The callback receives cloned inputs, local tools, and an allowlisted context containing
`config`, `item: {id, externalKey}`, `executionId`, `environmentRunId`,
`trace: {traceId,spanId}` and a short-lived `mcp` capability. Expected outcomes, case metadata
and original source pins remain private to grading. Pass the tools or scoped MCP capability into
the agent's actual tool boundary; their presence does not redirect provider calls. Capabilities
are not written to checkpoints. `maxRuns` limits completed runs for one-shot workers, while
`signal` stops polling. A stop signal does not forcibly cancel an already executing callback.

For an experiment with an immutable V2 attempt baseline, also supply `actualAgentManifest`, the
exact ordered `requestedProviders`, and an `mcpSurface` selected from that request. The worker
creates the world and prepares once before target code. A ready response exposes the memory-only
`connectionBundle` and keeps `context.mcp` as its selected MCP projection; it never mints the
legacy generic capability for that attempt. An incomplete response seals the world as completed
without invoking the target or scorers. A lost preparation acknowledgement remains uncertain
and is never recovered through binding reads, credential refresh or target replay. Synthetic
acceptance does not contact official Gmail or claim universal provider parity.

Completion or result-upload failures keep the run claimed by the durable worker identity.
Restart with the same checkpoint directory to resume saved uploads without invoking the
candidate again. A lost world-seal acknowledgement is recovered by reading authoritative world
state. If the seal or candidate outcome cannot be confirmed, or an outcome cannot be serialized,
the worker reports `attention` and stops; operator investigation is required. Such runs are not
automatically reclaimed, and presenting the same uncertain checkpoint again cannot replay the
candidate. Public package acceptance proves this lifecycle against local fixtures; exact
installed-registry-package to hosted-facade acceptance remains a post-publication Fern gate.
