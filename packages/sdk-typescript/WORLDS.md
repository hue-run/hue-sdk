# Simulated worlds

The World clients require a Hue deployment that serves the canonical World and instance routes.
The [compatible environment client](ENVIRONMENTS.md) remains supported.

Your agent runs locally against an isolated hosted instance of a simulated world:

```bash
npm install @hue-run/sdk zod
```

Your agent runs in your process while a disposable simulated world runs in Hue. The world is
authoritative and records an ordered journal; Hue does not execute your agent code or provider
credentials.

A World model is retained entity history. A World is a reconstructed starting state. A World
instance is an isolated running copy of that state. Starting another World instance does not
share the first World instance's changes. The handoff's
legacy `worldId` field identifies the runtime instance, not a durable World model.

## Reconstruct a user's World

The World model client requires the corresponding service routes. An entity's
namespace and full ID bind its history to the project identified by the service key.

```ts
import { WorldModelClient } from "@hue-run/sdk/world";

const models = new WorldModelClient({ apiKey: process.env.HUE_API_KEY! });
const { worldModel } = await models.createModel({
  entity: { namespace: "user", id: "user-123" },
});
const { world, instance } = await models.startInstance(worldModel.id, {
  idempotencyKey: "review-user-123-at-t2",
  at: "2026-10-17T12:00:00Z",
  ttlSeconds: 600,
});
```

`world.at` is the represented time. `world.evidenceCutoff` names the committed evidence used to
reconstruct it, including qualifying evidence from traces recorded later. A subsequent start
with a new idempotency key uses the latest completed reconstruction. Retrying the same key
replays the original start. `instance.id` identifies the isolated running copy.

`materialize(modelId, { at })` reconstructs without starting an instance.
`reproduceInstance(instance.id, { idempotencyKey })` starts a fresh isolated instance from the
original starting World. It does not copy the earlier instance's mutations or reuse its token.
Erased or unavailable starting data fails explicitly. `eraseModel(modelId)` revokes the model
and prevents its starting Worlds from being reproduced.

Materialization, instance creation and reproduction wait up to two minutes when Hue explicitly
reports that the World is preparing. Retries preserve the same request bytes and identity.
Other failures keep the client's `maxAttempts` limit. Pass `{ signal }` as the last options
argument to cancel a preparation wait or an active request.

When the service reports preparation progress, `worldModel.processing` distinguishes retained
evidence from indexed evidence. A start's `preparation` also includes the selected evidence
cutoff. `HueWorldError.preparation` exposes the same bounded progress on a preparation refusal.
Insufficient evidence and processing limits stop identical retries. Useful later evidence or an
interpreter update can prepare the same unfinished request automatically. Retrying its original
idempotency key starts the first usable World selected for that request. Preparation requires no
review or publish action.

`listModels` and `listAccounts` accept `after` and `limit` for pagination. Use each account's
`providerInstanceKey` to distinguish connections, including several accounts for one app.

## Capture user and account identity

Automatic World capture requires a compatible service.
Your existing tracing remains valid without these attributes; unresolved identity does not become
World state.

Record the complete user ID on the request's root span with `userId`. For another entity kind,
set both `hue.world.entity.namespace` and `hue.world.entity.id` on that root. Tool observations
need an explicit connection binding on the actual tool span:

| Attribute | Value |
| --- | --- |
| `hue.connection.provider_id` | Registered app ID, such as `google.gmail`. |
| `hue.connection.account_id` | Your stable account or connection ID, scoped to this user and project. |
| `hue.connection.generation` | Positive integer identifying that connection generation. Increment when the connection is replaced. |
| `hue.connection.scope` | Optional app partition, such as a workspace. Keep it stable. |
| `hue.connection.principal` | The app's acting identity when its simulation requires one. |

For example, attach the binding inside an existing tool callback. `searchThreads` below is your
application's tool implementation:

```ts
import { trace } from "@opentelemetry/api";
import { createHue } from "@hue-run/sdk";

const hue = createHue({
  serviceName: "assistant",
  apiKey: process.env.HUE_API_KEY!,
  resourceAttributes: { "deployment.environment.name": "production" },
});

await hue.withSpan("assistant request", () =>
  hue.tool("search_threads", { query: "project update" }, async () => {
    trace.getSpan(hue.getContext())?.setAttributes({
      "hue.connection.provider_id": "google.gmail",
      "hue.connection.account_id": "connection-work",
      "hue.connection.generation": 1,
      "hue.connection.principal": "owner@example.test",
    });
    return searchThreads({ query: "project update" });
  }, { mcp: { name: "gmail", provider: "google.gmail", surface: "mcp" } }),
  { userId: "user-123" },
);
await hue.shutdownSafe();
```

An attached client uses your application's existing OpenTelemetry resource; declare its environment
there. Missing or empty environment declarations and the exact value `production` can contribute
to a user's World. Any explicit nonproduction declaration prevents capture, even if another
declaration says `production`. Eval, simulation and excluded traffic cannot populate a live user's
World. Historical records sent over OTLP follow the same environment rule. The
[verified import route](https://docs.hue.run/guides/import-traces) retains the recorded origin and
follows the same environment rule. Verification does not override an explicit nonproduction declaration.

Use the same fields with your framework's tool-span hook. A parent-only account label cannot
resolve several accounts used by different tool calls. Account IDs and resource IDs stay separate;
a tool argument or matching email address alone does not establish a binding. Do not record
OAuth tokens or provider credentials in these fields.

## Publish an authored World

`createWorldClient` uses `createWorld`, `listWorlds` and `getWorld` for World identities.
The compatibility names `createEnvironment`, `listEnvironments` and `getEnvironment` remain
available. The client also publishes authored definitions and starts World instances from their
immutable versions. Use `WorldDefinitionV2` and `WorldProviderInstance` for arbitrary registered
apps and multiple accounts of the same app. The deployment validates each app's JSON
configuration and supported dialects.

The [compatible client guide](ENVIRONMENTS.md) covers authored definitions, action catalogs,
instance journals and simulation runners. Its examples use the retained environment client;
the canonical client uses the same request bodies through World and instance routes.
