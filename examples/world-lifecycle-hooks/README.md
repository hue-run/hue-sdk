# World login and cleanup hooks

This reference helper connects application test hooks to an existing Hue World instance. It accepts explicit login outcomes and calls your local adapter after the World is sealed. It uses the existing Hue MCP read tools, a private SQLite queue, and a local child process. It adds no hosted Hue endpoint or database schema.

This is an application test integration. It is not an OAuth server, an SSO provider, or an MFA browser simulation. Supply your application adapter and connection ownership rules before testing your application.

## Get the helper

Clone this public repository and use the example directory:

```sh
git clone https://github.com/hue-run/hue-sdk.git
cd hue-sdk/examples/world-lifecycle-hooks
bun install --frozen-lockfile
```

The helper runs separately from your agent. It works with a TypeScript, Python,
or other application through the same JSON adapter contract; it does not require
tracing, SDK imports, or changes to every agent. The npm and PyPI SDK packages do
not install this helper. Use Node 24 on a POSIX host and keep the helper running
under your process supervisor with its state directory on persistent storage.

## Run the isolated proof

From the helper directory, use Node 24 and Bun 1.4.2 on a POSIX host:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
```

Use `bun run test` to invoke the package's Node test command. The tests start a synthetic MCP server and real helper and adapter processes. They exercise HTTP authentication, all four login outcomes, process death after a receiver commit, retry, acknowledgement, credential isolation, and connection deletion scoped to one project and World. They do not contact Hue or another live service. Temporary databases and processes are removed after each test.

## Configure an application adapter

Create a JSON configuration file with these fields. Use the absolute executable and adapter paths from your machine:

```json
{
  "origin": "https://app.hue.run",
  "projectId": "00000000-0000-4000-8000-000000000001",
  "worldId": "00000000-0000-4000-8000-000000000002",
  "connectionId": "your-test-connection-id",
  "command": ["/absolute/path/to/node", "/absolute/path/to/application-adapter.mjs"],
  "envNames": ["APP_TEST_TOKEN"],
  "port": 8788
}
```

The origin selects production or staging. Explicit loopback HTTP origins are also supported for local verification. The helper maps production to `https://mcp.hue.run/mcp` and staging to `https://mcp.staging.hue.run/mcp`. It pins the project and requests read-only tools. It verifies that `list_projects` reports exactly that project, then polls `get_instance` every five seconds. It waits for an actual sealed status. Inactivity, a local deadline, an unavailable server, or a revoked credential cannot count as cleanup success.

This read tool does not force an overdue World to seal. Expiry cleanup waits for Hue's existing lifecycle sweep or another supported seal path, then the next helper poll. The scheduled sweep runs every ten minutes plus jitter, so TTL-based cleanup is not an immediate expiry callback.

Provide two supervisor credentials through your existing secret workflow:

- `HUE_HOOK_STATUS_KEY`: a project **Read** service key. It remains usable for metadata reads after a World token is revoked. A World token is not accepted. The REST instance route requires broader permissions and is not used here.
- `HUE_HOOK_CONTROL_TOKEN`: a separate random secret of at least 32 characters for the local control endpoint.

Provide the adapter's test credential separately, such as `APP_TEST_TOKEN`. Only explicitly listed `envNames`, `PATH`, and `LANG` reach the adapter. Hue variables and process-injection variables are refused in `envNames`. The adapter receives no configuration file or Hue credential in its arguments or input. The state database stores identifiers, outcome values and delivery status, not these secrets.

Start the helper with a new private state directory:

```sh
node src/main.ts --config /absolute/path/to/hooks.json --state-dir /absolute/path/to/private-hook-state
```

The ready line reports its loopback URL. Reuse the same configuration and state directory after a restart. Changing the project, World, connection, adapter command, or environment-name list refuses the old state. Keep the directory on persistent local storage owned by the helper user, with mode `0700`. Each World has its own directory. The helper must keep running under your normal supervisor; it does not install a background service. If it stops, queued work resumes when it restarts. It continues retrying failed cleanup until acknowledged; monitor `/status` for pending work and `hooks.retry_pending` for unavailable World metadata.

Once the helper has persisted a terminal World receipt, cleanup retries use that receipt even if MCP later becomes unavailable or the Read key is revoked. Restart also accepts that saved terminal receipt. New login outcomes remain refused. Before a terminal receipt is saved, unavailable or refused metadata prevents any cleanup claim.

Failed metadata reads discard the cached MCP connection. The next poll initializes a new session and checks the project pin again, including after server-side session expiry.

If another process holds the database lock during startup, the helper waits up to five seconds to enable SQLite's write-ahead log. Persistent contention stops startup before the ready message. The retry runs no application action. Other database errors are not retried.

The local adapter is trusted application code. Environment filtering is not an operating-system sandbox: a process running under the same account can read files or inspect other processes permitted to that account. Use a dedicated account or container when you need that isolation. Do not give the adapter production banking credentials.

## Submit a login outcome

POST JSON to the helper's loopback `/auth/outcomes` endpoint with `Authorization: Bearer <HUE_HOOK_CONTROL_TOKEN>`:

```json
{
  "requestId": "login-attempt-17",
  "subjectId": "test-user-3",
  "stage": "oauth",
  "outcome": "rejected"
}
```

`stage` is `oauth`, `sso`, or `mfa`. `outcome` is `succeeded`, `rejected`, `timed_out`, or `failed`. These values describe a test outcome supplied by the operator; the helper does not perform or attest a real login. The subject must be an application test identity. Never submit access tokens, passwords, authorization codes, or MFA codes.

The project, World and connection come only from the fixed configuration. Repeating a request ID and stage with the same body returns the same idempotency key. Changing that outcome or subject returns `409`. Use a new request ID for a new attempt. A `202` means the outcome is durably queued, not that the application handled it. Authenticated `GET /status` reports `pending`, `done`, or `cancelled` for each event. New login outcomes require a live World. When the World seals, queued login outcomes that have not been delivered are cancelled before cleanup.

If World metadata cannot be read, the helper returns `503 world_status_unavailable` with `Retry-After: 5` and does not queue the outcome. Retry the same request after metadata access recovers. Once any helper process saves a terminal receipt, the database refuses new login rows and claims even if another request has an older live response. Identical recorded outcomes can still return their existing receipt; an adapter already claimed before terminal observation still needs the application fencing described below.

Login delivery also requires the server's activity to be `active`. An expired or issuer-inactive World can still have an unsealed `live` lifecycle; the helper pauses login effects in that state and waits for the actual seal before cleanup.

An outcome does not change Hue's own login or the agent's credentials. Your adapter maps it to your application's test callback and observes the resulting behavior, such as the agent's Slack reply. That mapping requires the application's actual callback contract; this helper does not invent one.

## Handle deliveries and cleanup

The adapter command receives one JSON event on standard input:

```json
{
  "version": 1,
  "type": "world.ended",
  "idempotencyKey": "stable-sha256-key",
  "scope": {
    "projectId": "00000000-0000-4000-8000-000000000001",
    "worldId": "00000000-0000-4000-8000-000000000002",
    "connectionId": "your-test-connection-id"
  },
  "status": "completed",
  "sealedAt": "2026-11-04T12:00:00.000Z"
}
```

An `auth.outcome` event has the same version, key, and scope, plus `login` containing the submitted typed outcome instead of `status` and `sealedAt`. `world.ended` covers `completed`, `abandoned`, and `expired` instances.

The adapter must validate that the external connection belongs to the supplied test project and World. Delete only that connection, not every connection for the user or business. It must atomically record the event's idempotency key with its effects, or use a downstream API that provides the same guarantee. On a retry, confirm the earlier result without repeating its effects.

Cleanup must also write a permanent terminal marker for that project, World and connection in the same transaction as deletion. Every login callback must check that marker in the transaction that applies its effects and ignore callbacks after teardown. This prevents an old login subprocess from recreating a connection after cleanup. An external API must provide equivalent fencing if its effects cannot share that transaction. The included synthetic receiver demonstrates this terminal marker, deduplication receipt and exact connection deletion. Neither a stable event key nor a helper lease supplies this receiver guarantee by itself.

After successful handling, exit with code zero and write only this JSON to standard output:

```json
{ "acknowledged": "the-exact-idempotencyKey-from-the-event" }
```

A nonzero exit, timeout, malformed acknowledgement, or acknowledgement for another key leaves the event pending. The adapter has ten seconds and a 4 KiB acknowledgement limit. Its stderr is discarded, so log application diagnostics through your own secure logging system. The helper retries after five seconds. A killed helper's claim can be recovered after thirty seconds. Only one adapter delivery holds a claim in a state database at a time.

On timeout or excess output, the helper kills the adapter's original process group, closes its local pipe handles and records failure without waiting for descendant processes to exit. A detached descendant can escape that process group; it cannot keep the delivery promise or helper shutdown waiting by retaining a pipe. Process-group cleanup is not an operating-system sandbox.

Delivery is **at least once**. The helper can die after an external effect but before saving its acknowledgement. Stable keys make receiver deduplication possible; the helper alone cannot guarantee exactly-once external effects. A detached adapter can survive a killed helper, including its ten-second timer, and finish after cleanup. The receiver's terminal marker must prevent that late callback from restoring a deleted connection. Revoking the Hue World token does not cancel external processes. The interruption test deliberately leaves such an adapter alive and verifies that its late effect is ignored.

The queue permits 999 login outcomes and reserves one terminal cleanup event per World. Keep the database until cleanup is acknowledged and the evidence is retained. This example does not rotate state files, move leases between hosts, schedule itself, or remove application connections without an application adapter.
