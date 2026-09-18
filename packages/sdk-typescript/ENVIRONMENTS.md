# Simulated environments

Install the optional evaluation runtime-contract peer with the SDK:

```bash
npm install @hue-run/sdk zod
```

Your agent runs in your process while a disposable simulated world runs in Hue. The world is
authoritative and records an ordered journal; Hue does not execute your agent code or provider
credentials.

## Run a scenario like a test

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
    checkpointDirectory: ".hue-checkpoints/refund-scenario",
    scenario: { kind: "experiment", experimentId: process.env.HUE_EXPERIMENT_ID! },
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

This is currently a control-plane contract. Hue can issue provider endpoints under
`/api/v1/provider-facades/{bindingId}/{grantId}`, but a provider data-plane facade call has not
yet been proven by the released integration. The existing generic Hue MCP capability remains the
runnable hosted-tool path; do not interpret preparation or local-tool tests as evidence of a
hosted Gmail or Slack MCP call.

## Repository-authored scenarios

Repository scenarios publish through the same validated environment, dataset, scorer and
experiment APIs as Hue-authored scenarios. Stable slugs reuse matching immutable content
digests; changed definitions, tasks or scorers publish new versions. Hue does not synchronize
files back from its UI, and the helper refuses an unrelated mutable dataset draft instead of
overwriting it.

Repository publication supports the public `ScorerDefinition` union: exact match, includes,
JSON Schema, local code, manual and model-judge definitions. `runSimulation` applies the same
identity-affecting defaults as Hue before resolving versions and rejects unknown or server-only
kinds. In particular, `document_verifier` is not part of this SDK contract and is rejected rather
than published with a guessed digest.

```ts
const scenario = {
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
  checkpointDirectory: ".hue-checkpoints/refund-scenario",
  scenario,
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

An observation with `status: "error"` is a recorded world answer, not a transport exception.
Run mutations retry with stable invocation/idempotency identities. Registry writes do not retry
automatically because identity creation and publication have no request key.

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
