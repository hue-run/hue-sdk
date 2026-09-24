# Simulated environments

The provider-aware environment APIs shipped in TypeScript `0.3.0` and are publicly available:

```bash
npm install @hue-run/sdk zod
```

Your agent runs in your process while a disposable simulated world runs in Hue. The world is
authoritative and records an ordered journal; Hue does not execute your agent code or provider
credentials.

## Run a definition like a test

`runSimulation` is the one-shot developer path. It calls your existing callback directly, so
IDE breakpoints and cooperative cancellation work. It does not register a worker, poll for jobs,
host your laptop or require an inbound tunnel.

```ts
import { createHue } from "@hue-run/sdk";
import { createEnvironmentClient } from "@hue-run/sdk/environment";
import { createEvaluationClient, runSimulation } from "@hue-run/sdk/evals";

const connection = { apiKey: process.env.HUE_API_KEY! };
const hue = createHue({ ...connection, serviceName: "agent-test", captureContent: true });

try {
  const report = await runSimulation({
    client: createEvaluationClient(connection),
    environmentClient: createEnvironmentClient(connection),
    hue,
    checkpointDirectory: ".hue-checkpoints/refund-definition",
    definition: { kind: "experiment", experimentId: process.env.HUE_EXPERIMENT_ID! },
    persistResultContent: true,
    traceEvidence: { mode: "required" },
    target: (inputs, { tools, mcp, config, signal }) =>
      runMyExistingAgent({ inputs, config, tools, mcp, signal }),
    onProgress(event) {
      if (event.type === "run_created") console.log(`Inspect this run: ${event.runUrl}`);
    },
  });
  console.log(report.runUrl);
} finally {
  await hue.shutdownSafe();
}
```

The referenced app-authored experiment is a template. Each completed invocation clones its
exact frozen dataset, configuration and scorer-version pins into a fresh experiment and creates
one isolated world per case. An interrupted invocation resumes through the private checkpoint
directory. If the agent may have run without a saved outcome, resume fails explicitly and never
calls it again. If Hue cannot confirm whether the world sealed, the execution likewise stays
uncertain and a resume refuses to re-invoke the agent.

`tools` contains framework-neutral local callables. `mcp` is a short-lived bearer for the same
run's closed catalog when a model provider executes MCP remotely. It is scoped to one execution
and world and is not the Hue project key. Configuration alone does not redirect real provider
calls; give one of these connections to the agent's actual tool boundary. `environmentRunId`
identifies the same world for adapter control operations such as
`environmentClient.recordCoverageGap`; it is not a credential. The MCP token is delivered only
to the callback and is never written to checkpoints.

### Published pins and verdicts

`scenario: { kind: "pins", datasetVersionId, scorerVersionIds, config?, name? }` runs already
published immutable pins, such as a Scenario's frozen case and Hue-owned outcome checks or a saved
eval set with explicitly chosen scorer versions. `resolveScenarioPins(client, selector)` reads
those pins from a Scenario ID, its Hue URL or its name (`listScenarios` and `getScenario` expose
the underlying reads; a Read and write key is required), and `resolveEvalSetPins`
resolves an eval set to its latest saved version. `runSimulation` creates the experiment directly
(`name` defaults to the dataset name, `config` to `{}`) and binds the pins and configuration into
the checkpoint identity, so resuming with different pins is refused like the other kinds.
Hue-executed pins such as `world_outcome` need no local callback; pass `localScorers` only for
bound `local_code` pins.

Hue grades `world_outcome` pins after the world seals, so the runner's report precedes the
verdicts. `waitForResults(client, { runId, scorerVersionIds, subjectIds, timeoutMillis })` polls
until every item has a terminal result for every pin or the budget elapses (`complete: false`);
`summarizeVerdicts` turns results into per-case rows with `passed` and totals; `compareVerdicts`
diffs two summaries by case key; and `collectExperimentVerdicts` combines those reads for one
experiment. The `hue eval` command uses the same path; see
[Evaluate an agent against a case](CLI.md#evaluate-an-agent-against-a-case).

### Pinned provider-profile preflight

An experiment with an immutable `attemptBaselineV2` can require the local process to describe
the agent configuration it is actually about to run. Supply `actualAgentManifest`, the exact
ordered `requestedProviders`, and an `mcpSurface` selected from that request. Hue compares the
agent, prompt, model, tools, approvals, orchestration, MCP catalogs and native-helper
configuration before the callback or model runs. Missing evidence stays explicitly `missing`; it
is never treated as a match.

On a ready decision, `context.connectionBundle` contains the selected V2 provider surfaces and
`context.mcp` remains the backwards-compatible projection of the selected MCP surface. Endpoints,
bearers, expiry and credential generation stay in callback memory: the runner does not write
them to checkpoints or progress events, and it never mutates global `process.env`. A durable
`environment_incomplete` decision skips both the callback and scoring. If a ready response or
world seal cannot be confirmed, the checkpoint remains uncertain and resume neither reacquires
credentials nor invokes the callback again.

The SDK consumes the versioned connection contract but does not itself establish provider
fidelity. Public package acceptance exercises local control-plane responses and connection-bundle
handling; it does not call the issued facade endpoint. Exact installed-registry-package to hosted-
facade acceptance remains a post-publication Fern integration gate. No public SDK test calls the
official Gmail service, and passing these tests is not evidence of universal Gmail or Slack
parity. A matching Hue deployment and verified provider profile remain required.

## Repository-authored definitions

Repository definitions publish through the same validated environment, dataset, scorer and
experiment APIs as definitions authored in Hue. Stable slugs reuse matching immutable content
digests; changed definitions, tasks or scorers publish new versions. Hue does not synchronize
files back from its UI, and the helper refuses an unrelated mutable dataset draft instead of
overwriting it.

Repository publication supports the public `ScorerDefinition` union: exact match, includes,
JSON Schema, local code, manual and model-judge definitions. `runSimulation` applies the same
identity-affecting defaults as Hue before resolving versions and rejects unknown or server-only
kinds. In particular, `document_verifier` is not part of this SDK contract and is rejected rather
than published with a guessed digest.

The extendable `EnvironmentDefinition` name remains the V1 contract and is also exported as
`EnvironmentDefinitionV1`. Use `EnvironmentDefinitionV2` to add immutable Gmail
`providerInstances`; `PublishableEnvironmentDefinition` is the publication/repository union.
Hue canonicalizes valid synthetic-principal UUIDs to lowercase, and repository resolution does
the same before comparing immutable digests, so casing-only UUID changes reuse the stored
version without dropping provider bindings.

```ts
const definition = {
  kind: "repository" as const,
  name: "Refund an eligible charge",
  slug: "refund-eligible-charge",
  environment: {
    name: "Refund fixture",
    slug: "refund-fixture",
    definition: refundWorld,
  },
  cases: [
    {
      externalKey: "eligible-charge",
      inputs: { request: "Refund charge ch_2" },
      metadata: { suite: "billing" },
    },
  ],
  scorers: [{ name: "Refund saved", slug: "refund-saved", scorer: refundScorer }],
  config: { agentMode: "support" },
};

await runSimulation({
  client,
  environmentClient,
  hue,
  checkpointDirectory: ".hue-checkpoints/refund-definition",
  definition,
  persistResultContent: false,
  traceEvidence: { mode: "required" },
  target: (inputs, context) => runMyExistingAgent({ inputs, ...context }),
});
```

Repeat the command after an edit for a fresh attempt and world. The run URL joins task, trace,
world effects, final state, target outcome and scorer results. Target failures and cancellations
seal the world as `abandoned`; scorer errors remain separate. Cancellation is cooperative, so
pass `context.signal` into the provider or agent call.

## Direct environment tools

For lower-level use, create a run and bind its generated catalog:

```ts
import { randomUUID } from "node:crypto";
import { bindEnvironmentTools, createEnvironmentClient } from "@hue-run/sdk/environment";

const client = createEnvironmentClient(connection);
const run = await client.createRun({
  idempotencyKey: randomUUID(),
  environmentVersionId,
});
const tools = bindEnvironmentTools({ hue, client, run });
await tools.refund_charge!.execute({ charge_id: "ch_2" });
await client.finishRun(run.id, { idempotencyKey: randomUUID(), status: "completed" });
```

Each bound call is an ordinary `hue.tool` span. When the catalog names an MCP server, the span
also carries `mcp.server.name`, plus `hue.mcp.provider` and `hue.mcp.surface` when the catalog
entry includes them. Wrap any MCP client the same way, using `serverInfo` from
`initialize` — this is not specific to Hue-hosted Gmail or Slack:

```ts
await hue.tool(name, args, () => client.callTool({ name, arguments: args }), {
  mcp: client.getServerVersion(),
});
```

An observation with `status: "error"` is a recorded world answer, not a transport exception.
Run mutations retry with stable invocation/idempotency identities. Registry writes do not retry
automatically because identity creation and publication have no request key.

## Worlds served by the simulation gateway

Where a Hue deployment has the simulation gateway on, `createRun` returns the World API handoff
beside the run: `token` (a `hue_world_…` credential that lives exactly as long as the world),
`surfaces[]` (one mirror URL per pinned provider surface, such as the Gmail MCP and REST mirrors),
`env` (`HUE_WORLD_ID`, `HUE_WORLD_TOKEN`, `BAGGAGE`, `TRACEPARENT` and one
`HUE_SIM_<SURFACE ID>_URL` per surface) and `mcpConfig` (the common `mcpServers` shape with the
token in the `Authorization` header). The agent is pointed at the mirrors by configuration only:
its own Gmail MCP or REST client, the mirror URL, the world token where the Google credential went.

```ts
import {
  agentEnvironment,
  createEnvironmentClient,
  worldHandoff,
  writeMcpConfig,
} from "@hue-run/sdk/environment";

const run = await environmentClient.createRun({
  idempotencyKey: `execution:${executionId}`,
  environmentVersionId,
  executionId,
  ttlSeconds: 600,
  traceparent: `00-${span.traceId}-${span.spanId}-01`, // parents the world span on the case span
  agentRevision: "my-agent@1.4.2", // joins the world's fingerprint
});
const world = worldHandoff(run); // null for a world created while the gateway is off
const child = agentEnvironment(world!, { parent: process.env }); // no HUE_API_KEY in the agent
const config = await writeMcpConfig(world!); // owner-only mcp.json; dispose after the run
try {
  await spawnAgent({ env: child, mcpConfigPath: config.path });
} finally {
  await config.dispose();
  await environmentClient.finishRun(run.id, {
    idempotencyKey: `execution:${executionId}:completed`,
    status: "completed",
  });
}
```

`runSimulation`, `runLocalAgent` and `hue eval` do this for you: they create the world with the
execution, the stable key, the case span's context and the agent revision, pass the handoff as
`context.world`, and finish before returning so telemetry is flushed and the execution completed
afterwards. For one compatibility release `context.mcp` is the world's first MCP mirror with the
world token, so an adapter that read `HUE_MCP_URL` and `HUE_MCP_TOKEN` keeps working;
`agentEnvironment` sets those names too unless `legacyMcpVariables: false`. A gateway world binds
no Hue-native `tools` (Hue refuses them); a world created while the gateway is off keeps its tools
and the `hue_sim_` capability and emits a one-time `DeprecationWarning`.

`agentEnvironment` removes Hue control-plane credentials from the child by default: `HUE_API_KEY`,
`HUE_MCP_KEY` and any variable whose value is a `hue_sk_`, `hue_mcp_` or `hue_attempt_`
credential. Pass `includeHueCredentials: true` only for an agent that must call Hue's own API.
Nothing in these helpers logs the token; keep it out of your own logs and checkpoints.

Finish answers `lifecycle: "completing"` with `sealedAt: null` for a gateway world: the seal
follows a 5 s grace so in-flight writes land, and a late finish answers 409, which the helpers
treat as the seal they can no longer change. `getEvidence(runId, { section, bodies })` reads the
sealed world's evaluator-only evidence (start and end state, the diff, the call ledger, coverage,
fingerprint) with the project key; a world token can never read it. The client honors Hue's
`Retry-After` on 429 and 503.

## Coverage gaps

A provider adapter can record a known valid provider request that the environment cannot
implement with `client.recordCoverageGap(run.id, { idempotencyKey, provider, operation, code,
args, description })`. Use a durable UUID idempotency key and repeat the identical request to
recover a lost acknowledgement. This is a runner/adapter control operation, not an agent tool.
Arguments must be a JSON object of at most 16,000 encoded bytes.

Hue preserves the first report, marks `validity: "environment_incomplete"`, and refuses new
actions while still replaying already-recorded invocation receipts. `coverageGap` retains the
request and reporting provenance. An absent gap means `not_assessed`; it does not establish
provider parity.

Local scoring and historical rescoring skip incomplete evidence before calling a scorer, even
when the target returned no output or failed. Unsupported caller syntax and real provider errors
are not automatically coverage gaps; the adapter must identify a known missing provider
behavior. `runSimulation` checks the authoritative world when its callback throws: a durably
recorded gap finishes as environment-incomplete rather than `TargetError`, while a gap or seal
that cannot be confirmed stays uncertain and never causes the agent to be replayed.

The hosted MCP connection exposes Hue's bounded native actions; it is not general Gmail or
Slack HTTP parity and does not proxy arbitrary provider traffic. Forking, in-place reset and
arbitrary-step diffs are outside this interface.

## Candidate context migration

This candidate-context restriction shipped in `@hue-run/sdk@0.3.0`.

`runSimulation` now supplies `context.item` as `{ id, externalKey }`. Read candidate inputs
from the callback's first argument. Expected outcomes, case metadata and environment-version
pins are available to evaluation and scoring code, and are omitted from the candidate callback.
Inputs and configuration are cloned before invocation so candidate mutations cannot change
pinned grading data. The generic `runExperiment` evaluator interface is unchanged.
