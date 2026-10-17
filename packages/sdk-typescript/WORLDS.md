# Simulated worlds

The World client names in this checkout are unreleased. They require a Hue deployment that
serves the canonical World and instance routes. Existing published packages use the
[compatible environment client](ENVIRONMENTS.md).

Your agent runs locally against an isolated hosted instance of a simulated world:

```bash
npm install @hue-run/sdk zod
```

Your agent runs in your process while a disposable simulated world runs in Hue. The world is
authoritative and records an ordered journal; Hue does not execute your agent code or provider
credentials.

A World is a reconstructed starting state. An instance is an isolated running copy of that
state. Starting another instance does not share the first instance's changes. The handoff's
legacy `worldId` field identifies the runtime instance, not a durable World model.

## Reconstruct a user's World

The World model client is unreleased and requires the corresponding service routes. An entity's
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

`listModels` and `listAccounts` accept `after` and `limit` for pagination. Use each account's
`providerInstanceKey` to distinguish connections, including several accounts for one app.

## Publish an authored World

`createWorldClient` also publishes authored definitions and starts instances from their
immutable versions. Use `WorldDefinitionV2` and `WorldProviderInstance` for arbitrary registered
apps and multiple accounts of the same app. The deployment validates each app's JSON
configuration and supported dialects.

The [compatible client guide](ENVIRONMENTS.md) covers authored definitions, action catalogs,
instance journals and simulation runners. Its examples use the retained environment client;
the canonical client uses the same request bodies through World and instance routes.
