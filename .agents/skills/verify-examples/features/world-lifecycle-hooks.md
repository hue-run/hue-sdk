# World login and cleanup hooks

`examples/world-lifecycle-hooks` is a standalone Node 24 helper. It polls Hue MCP
for one fixed World, accepts typed login test outcomes on loopback HTTP, and
delivers queued events to a trusted application command. It is distributed as
source rather than through an SDK package, so no SDK archive or OTLP stub is
needed for this feature.

## Run from a standalone copy

Use Node 24 and Bun 1.4.2 on a POSIX host. Copy only the example's tracked files
to an isolated directory, with no repository dependencies or real credentials:

```sh
cd examples/world-lifecycle-hooks
bun install --frozen-lockfile
bun run typecheck
bun run test
```

The ten tests start real HTTP, MCP, helper and adapter processes with synthetic
credentials and temporary SQLite databases. They prove authenticated typed
outcomes, fixed project and World scope, idempotent retries and conflicts,
private state, environment isolation, terminal cleanup, interrupted delivery,
late callback refusal, concurrent claims, MCP session recovery, and a detached
descendant that retains stdout. The expected result is ten passing tests with
no failures or skipped tests. Keep the command output and source-file hashes.

These tests do not contact Hue or any customer application. A separate live
integration must verify the configured Read key, actual World metadata and
sealing, and the application's adapter effects. A synthetic receiver does not
prove a customer's login or cleanup implementation. A `202` acknowledges durable
queueing; only a matching adapter acknowledgement completes delivery.

The tests stop owned processes and remove their temporary files. Do not remove
a real helper's state directory until cleanup is acknowledged and its evidence
has been retained.
