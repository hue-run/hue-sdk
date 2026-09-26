# Hue setup CLI

The local setup-session CLI core shipped in TypeScript `0.3.1`. TypeScript `0.4.0` is an unreleased,
activation-gated candidate for the real one-command flow:

```sh
npx --yes @hue-run/sdk@latest setup --agent
# Default Terminal mode, when a person is present:
npx @hue-run/sdk@latest setup
```

These public commands are not working onboarding promises until candidate publication, Fern
activation, production acceptance and `latest` promotion all pass. The automatic matrix is limited
to Express with npm, Express with Bun, and Flask with uv in a single application package with one recognizable
entrypoint, a literal existing GET route and `PORT` supplied by the environment. The command uses the
detected manager to install an exact runtime, inserts two owned middleware marker blocks without
rewriting business logic, starts that exact entrypoint without a shell, authenticates its loopback
socket before sending HTTP, makes one request on that same socket, flushes, and verifies its exact trace/span receipt.
A delayed listener, failing handler, missing telemetry or receipt failure never authorizes replay of
business work. A setup probe is separate transport evidence and cannot establish application
instrumentation.

Workspace roots, mixed languages/managers, custom Hue versions, edited marker blocks, unfamiliar
entrypoints and ambiguous routes stop with `action.required`. Follow its specific local action and
rerun the same installation; select the intended application package with `--project` when needed.
Setup does not choose a monorepo package or silently broaden its supported shapes. Preserve the
application's business logic when completing an integration manually.

The bounded fixture contract is ESM JavaScript/TypeScript Express with `const app = express();`,
one literal `app.get(...)`, an environment-selected listen port, and a start script containing only
`node path/to/server.mjs` (or `.js`, `.ts`, `.mts`) or `bun path/to/server.mjs`. A Bun start script
requires the Bun manager. Plain JavaScript does not need a TypeScript dependency. Flask uses root
`app.py`, `app = Flask(__name__)`, one literal `@app.get(...)` and a port read from
`os.environ["PORT"]`. Routes cannot contain network-path prefixes, escapes or dynamic segments.
JavaScript/TypeScript shebang/BOM entrypoints require manual integration. Python UTF-8/ASCII
shebang, encoding, comments, module docstring (including parenthesized forms) and future imports
are preserved using an isolated stdlib Python 3 syntax parser. Other encodings and ambiguous
statement layouts are refused. Package roots nested in an npm/Bun workspace or beneath any Python
project manifest are refused because managers can update ancestor locks; Python build-system/custom-source projects are also outside this matrix.
`uv` uses binary-only dependency installation and starts with no implicit sync/build.

The generated `hue.setup.mjs` or `hue_setup.py` always selects `captureContent: false` /
`capture_content=False`. For a supported application, setup installs the dependency and adds the
managed import and middleware registration to the existing entrypoint; an unreferenced helper is
not a completed integration. TypeScript uses `@hue-run/sdk@0.10.0`, `@opentelemetry/api@1.9.1` and
`@opentelemetry/context-async-hooks@2.11.0`; Python setup uses its separately tested package pin.
Content capture requires an ordinary account-managed key and a later explicit application decision.

The generated bootstrap supplies standard active SERVER-span context across asynchronous/streaming
handlers; the core SDK's global-provider/context ownership is unchanged. It preserves a working
caller context manager and disposes only its own instance. Unknown local imports, custom/late manager
bootstraps, runtime preloads and conflicting OTel dependencies require manual review before any
mutation or provisioning. Automatic Express entrypoints import only Express, the standard OTel API,
or the supported `node:fs`, `node:fs/promises`, `node:timers/promises` and `node:stream` modules.
Syntax parsing, not matches inside comments/strings/templates/regular expressions, establishes the
constructor and literal route. Custom middleware, alternate route methods, app aliases/escapes and
extra Flask handler decorators are outside the automatic matrix. The one selected request must finish with a 2xx response; a 404 or
telemetry failure never authorizes a business retry.

Bun runtime checks and application launch use an explicit empty config and disable dotenv loading.
Local runtime/preload settings, dotenv files and a global `.bunfig.toml` require manual review before
any Bun invocation. The only supported local `bunfig.toml` is an `[install]` section with one
credential-free registry origin for package installation; this does not become runtime config.

Automatic Express listeners must be the single top-level
`app.listen(Number(process.env.PORT), "127.0.0.1")` (the direct `process.env.PORT` argument
is also recognized). Flask permits only `app.run(port=int(os.environ["PORT"]))`, optionally
with `host="127.0.0.1"`, at module level or under the usual main guard. Custom callbacks,
server handles, socket metadata access, reloaders, workers and listener options require manual
integration. Flask dotenv/runtime bootstrap configuration also requires review.
Before dependency or credential changes, an isolated compile-only check validates the selected
Node/Bun entrypoint without executing it; Node-unsupported TypeScript syntax is refused.

During this setup-owned invocation only, a bounded server-first proof authenticates the retained
loopback connection. HTTP uses that exact socket once, with no redirect, redial or retry. Express
uses a private inner listener and a one-connection forwarding listener; Flask uses its standard
request-handler seam. The per-attempt secret stays in memory/private child transport, never in
events, checkpoints or receipts. Ordinary app starts have no handshake and retain their original
listener behavior. This prevents accidental requests to an unrelated listener, not access by
malicious code running as the same local user.

Setup creates no simulation, Hue Run, evaluation, source capture, worker or remote execution. Package
manager lifecycle scripts are disabled. The supported existing application entrypoint is executed
directly with fixed argv solely for its bounded local HTTP verification; no shell command is accepted.

## Technical preflight and privacy disclosure

Read-only project detection and conflict checks precede project mutation. Public
`GET /api/v1/setup/preflight` reports `available` or `inactive`, `metadata-only-v1`, trial limits and
lifetime, and the published privacy and security information. An inactive deployment remains
unverified. An available deployment proceeds through runtime installation, private installation and
credential provisioning, managed application wiring, one application request and exact receipt
verification.

Before telemetry, `privacy.notice` presents `https://hue.run/privacy`, effective date `2026-08-24`,
and `https://trust.hue.run/`. This is a non-blocking disclosure. Setup has no acceptance step or
acceptance fields and does not infer a person's acknowledgement. It does not invent notice content.

The anonymous ingestion window is 24 hours with lifetime limits of 100 traces, 1,000 spans and 2 MiB
of sanitized stored data. Unclaimed data is purged seven days after expiry. Claim preserves the
project and its data; the setup-issued replacement key remains metadata-only.

## Commands and modes

```sh
hue setup                 # provision/configure/verify, then prepare a private owner handoff
hue resume                # continue the same project/origin installation
hue status                # read status; after claim, reconcile generation 1 if necessary
hue claim                 # open the owner-only handoff, or reconcile after browser claim
hue claim --restart       # explicit owner recovery; requires an interactive local terminal
hue setup --agent         # noninteractive version-2 JSONL events
hue setup --format human  # explicit append-only terminal rendering
hue setup --origin http://127.0.0.1:PORT # isolated loopback tests only
hue login                 # validate keys created in Hue and store them in ./.env.hue
hue mcp install --client claude-code # write the Hue MCP configuration for a coding agent
hue listen --subscription <id> --forward-to http://localhost:3000/slack/events # deliver events to a local bot
```

Hosted setup accepts HTTPS origins only. HTTP is accepted solely for `localhost`, `127.0.0.1` and
`[::1]` test origins. Origins with credentials, paths, queries or fragments are refused, and
redirects are never followed.

`--agent` never reads stdin or opens a browser. It emits exactly one terminal `run.completed` or
`run.failed` event and only a generic owner action. No setup mode prints a bearer claim URL or token.
The CLI saves the capability in an ignored owner-only local handoff and human Terminal mode opens
only that local file; the browser consumes the short-lived one-time capability. A repository-reading
agent can read local project files, so this boundary prevents durable transcript/log disclosure, not
a malicious local process. The browser owns the claim cookie; the CLI never reads it. After claim
completes, rerun `hue claim` or `hue status` to fetch credential generation 1, atomically replace the
locally managed key, verify the preserved original receipt and confirm the old key receives `401`.
The superseded key is retained only in private managed state until that check succeeds, so an
interruption does not lose the revocation check. Reconciliation does not replay the application
request or require a second one.

A pending handoff expires after at most ten minutes and is exchanged once for a distinct browser
session lasting at most thirty minutes; both deadlines are bounded by trial expiry. Status polling
never creates or rotates a handoff. Retrying or reopening a pending handoff keeps its original ID
and expiry; a consumed handoff with an active browser session remains intact. Only the owner can
explicitly replace an expired or lost handoff with `hue claim --restart`; this persists a new ID and
uses the observed predecessor for compare-and-swap. A conflict refreshes status once and stops.
At most 32 distinct handoff IDs exist per installation; `SETUP_HANDOFF_LIMIT` is terminal. Replacing a
handoff does not create a trial, reset quota or rerun business work.

## Sign in and store keys

`hue login` stores keys that a person creates in Hue; it never mints one, because setup
credentials are deliberately isolated from ordinary project keys. It prints the key settings page
(`<origin>/settings/integrations`, opened in a browser only when a terminal is attached and
`--no-browser` is absent), then reads one **Read and write** key from stdin without echo. By
default that single key serves both uses: it is checked with `GET /api/v1/projects/current` and
`GET /api/v1/datasets` (a **Read** or **Tracing only** key is refused because it cannot use
evaluations) and with an MCP `tools/list` request, then stored as `HUE_API_KEY` with
`HUE_BASE_URL` and `HUE_MCP_KEY` with `HUE_MCP_URL` in one write. A rejected key (`401` or `403`)
exits `1` and stores nothing. `--keys evaluations` stores only `HUE_API_KEY`; `--keys coding-agent`
stores only `HUE_MCP_KEY` and also accepts a **Read** key, for an agent that should only inspect the
project. Run them separately with different keys if you want to revoke either use alone.

```sh
hue login                                  # one key for both uses into ./.env.hue
hue login --keys coding-agent --gitignore  # only HUE_MCP_KEY; add .env.hue to .gitignore
hue login --origin https://staging.hue.run --env-path .env.staging
```

`--env-path <path>` writes another env file, creating it when missing. `--env-file <path>` is
accepted too, but Node 22 and 24 read that flag from the whole command line and exit with
`node: <path>: not found` before `hue` runs when the file does not exist yet.

The env file is written with mode `0600` through a temporary file and an atomic rename. Other
lines are preserved; a symlink or a non-regular file is refused; an existing different value is
replaced only with `--force`. Empty values, whitespace and URLs are refused before any request.
The MCP endpoint is `https://mcp.hue.run/mcp` for `https://app.hue.run`,
`https://mcp.staging.hue.run/mcp` for `https://staging.hue.run` and `<origin>/api/mcp` otherwise;
plain HTTP origins are accepted for loopback test servers only. Output names variables and lengths
(`Stored the key (NN chars) as HUE_API_KEY and HUE_MCP_KEY`), never values. When git does not ignore the env file, the command
warns; `--gitignore` appends the file name to the `.gitignore` next to it. Exit codes: `0` stored,
`1` failed, `2` usage error, `130` interrupted.

## Install the MCP for your coding agent

`hue mcp install --client <name>` writes, runs or prints the configuration for Hue's MCP server,
in the shapes of the [connection guide](https://docs.hue.run/agents/mcp-server): server name
`hue` and the endpoint (default `https://mcp.hue.run/mcp`; `--url https://mcp.staging.hue.run/mcp`
for staging). Hue's Settings page does not show these snippets; this command keeps its own copy.

`--auth` chooses how the client authenticates:

- `key` (the default, except for `conductor`) references the `HUE_MCP_KEY` environment variable,
  which `hue login` stores in `.env.hue`. A key value is never written.
- `oauth` configures the URL only. The client opens Hue in a browser, where you sign in, select one
  project and approve **Read** or **Read and write**; no key or header is involved. It is available
  for `claude-code`, `codex` and `conductor`. Hue does not yet accept Cursor's sign-in callback, so
  `cursor` and the other clients use a key.

`--read-only` adds `?read_only=true` to a key configuration's URL, so Hue hides and rejects write
tools whatever the key allows. With `--auth oauth` it is refused: choose **Read** when you approve
the connection instead.

| Client | Key (`--auth key`) | Sign-in (`--auth oauth`) |
| --- | --- | --- |
| `claude-code` | Merges `mcpServers.hue` into `./.mcp.json`. `--scope user` runs `claude mcp add --transport http --scope user hue URL --header 'Authorization: Bearer ${HUE_MCP_KEY}'` when `claude` is on `PATH`, otherwise prints it. | Merges `mcpServers.hue` with only `type` and `url` into `./.mcp.json`; `--scope user` runs `claude mcp add --transport http --scope user hue URL`. Then run `/mcp` in Claude Code, select `hue` and choose **Authenticate**. |
| `codex` | Runs `codex mcp add hue --url URL --bearer-token-env-var HUE_MCP_KEY`, or prints the `[mcp_servers.hue]` TOML block for `~/.codex/config.toml`. | Runs `codex mcp add hue --url URL`, which can start sign-in right away; `codex mcp login hue` starts or repeats it. |
| `conductor` | Runs the Claude Code user-scope and Codex key commands above. | The default: runs `claude mcp add --transport http --scope user hue URL` and `codex mcp add hue --url URL`. Then use `hue`'s authentication action in Conductor's MCP status (the plug icon or `/mcp-status`). |
| `cursor` | Merges `mcpServers.hue` into `./.cursor/mcp.json` with `${env:HUE_MCP_KEY}`. | Refused. |
| `vscode` | Merges `servers.hue` and the `hue-mcp-key` password input into `./.vscode/mcp.json`. | Refused. |
| `windsurf` | Prints the `serverUrl` snippet for `~/.codeium/windsurf/mcp_config.json`; nothing is written to the home directory. | Refused. |
| `gemini` | Runs `gemini mcp add --scope user --transport http hue URL --header 'Authorization: Bearer ${HUE_MCP_KEY}'`, or prints it. | Refused. |

Conductor has no MCP configuration of its own: its Claude Code and Codex agents read their user
configuration in every workspace, so `conductor` registers the server at user scope with each CLI
on `PATH` and prints the command for a CLI that is missing. A failing CLI does not stop the other;
the command then exits `1`.

JSON files are parsed and merged: other servers, inputs and top-level fields are kept, only the
`hue` entry is replaced, and invalid JSON (including comments) is refused together with the snippet
to add by hand. Files are written with mode `0644` through a temporary file and an atomic rename;
symlinks are refused. `--dry-run` prints the resulting file content or commands without writing or
running; `--print` prints only the snippet. Client CLIs run without a shell, so the
`${HUE_MCP_KEY}` reference reaches them literally; the printed commands use single quotes for the
same reason, and quote a URL with a query such as `?read_only=true`, whose `?` is a zsh glob.

After a key installation the command reminds you to export `HUE_MCP_KEY` in the shell that starts
the client (VS Code prompts for the key instead). A desktop app started from the Dock or a launcher
does not see that shell's variables, and Conductor's agents read the login-shell environment that
Conductor captures, so sign-in is the simpler choice there. After a sign-in installation it names
the client's authentication action. Both end with the prompt that verifies the connection:
`Use the Hue MCP: call get_project_context, then show the traces from the last 24 hours that need
attention or have errors, with links. If there are none, show my 5 most recent traces.` Exit codes:
`0` done or printed, `1` failed, `2` usage error.

## Deliver simulated events to a local bot

`hue listen` delivers a simulated world's events to a receiver on your machine, so an
event-driven agent such as a Slack bot can be tested without a public URL, the way
`stripe listen --forward-to` delivers webhooks. Hue signs each request as the provider does (Slack
Events API requests today); the command pulls them, forwards each one unchanged to
`--forward-to` and reports the bot's answer to Hue, which settles or retries the event on the
provider's schedule. It needs a **listen** event subscription on the world or on a connection key;
the subscription's id and signing secret are shown once when it is created. Configure the bot with
that signing secret where `SLACK_SIGNING_SECRET` went, then start the command: Hue offers the URL
verification first, and events follow once the bot has answered it.

```sh
hue listen --subscription <id> --forward-to http://localhost:3000/slack/events --env-path .env.world
```

The credential is the subscription's own, read from the environment (or `--env-path`, loaded
first; a variable already set keeps its value): `HUE_WORLD_TOKEN` for a world's subscription or
`HUE_CONNECTION_KEY` for a connection key's, chosen with `--credential world-token|connection-key`
when both are set. It is never taken from the command line, where other local processes and shell
history can read it. A project key is refused: a value equal to `HUE_API_KEY` or `HUE_MCP_KEY`
exits 2 before any request, and Hue answers any credential that is not the subscription's with
`401`. `--origin` (default `HUE_BASE_URL`, then `https://app.hue.run`) must be HTTPS, or plain HTTP
on a loopback test server.

Each request reaches the bot with its body bytes and headers unchanged, so the provider's
signature verifies as it would in production; only `Host`, `Content-Length` and connection
headers are the local request's own, and Hue's credential is never forwarded. No redirect is
followed: a `3xx` is reported as the answer. An answer counts only within three seconds, Slack's
acknowledgement window; a later one is a timeout. A failing answer with `x-slack-no-retry: 1` is
reported so Hue stops retrying it. Only the URL verification's answer body (at most 4 KiB, for its
challenge) is sent to Hue; an event's answer body stays on this machine. Each pull waits for at
most 20 seconds, leases up to `--max` deliveries (1 to 10, default 10) and forwards them
concurrently; the next pull starts once they are acknowledged. A provider retry of an event is a
new delivery and is forwarded again with its `X-Slack-Retry-Num` and `X-Slack-Retry-Reason`, so the
bot deduplicates by `event_id` as it does with Slack. A delivery Hue hands out a second time is
not sent again; its recorded answer is repeated. An acknowledgement Hue did not answer is repeated
until the delivery's 30-second lease ends.

`--forward-to` must name this machine: `localhost`, a `.localhost` name or a loopback address, and
a name must resolve to loopback addresses only. `--allow-remote-forward` permits another host.
Credentials and fragments in the URL are refused. Output is one line per delivery (time, event id,
retry number, the bot's status and duration, and the state Hue recorded), never a body, a
signature or a credential; credentials in error messages are replaced with `[redacted]`.

Ctrl+C or `SIGTERM` stops pulling (a waiting pull is cancelled), finishes the deliveries in flight
and acknowledges them, then exits `0`; a second Ctrl+C abandons unfinished acknowledgements and
exits `130`. Nothing is acknowledged before the bot answered or its window closed, and a lease
left unacknowledged lapses into a timeout that Hue retries on the provider's schedule, so no event
is lost and none is marked delivered unanswered. Network errors, `429`, `5xx` and another open pull
for the same subscription (a second `hue listen`) are retried with backoff up to 30 seconds. Exit
codes: `0` stopped, `1` Hue refused the credential or the subscription (unknown, revoked, or one
that delivers to a request URL), `2` usage error, `130` interrupted twice.

## Local state and conflicts

Before its first network write, setup creates a lowercase UUIDv4 and a 32-byte random installation
secret. They live with the current telemetry credential in `.hue/installation-<origin-hash>.json`.
The file is added to `.gitignore`, written atomically with mode `0600`, and scoped to this exact
project and Hue origin. A pending browser capability is stored only in
`.hue/claim-handoff-<origin-hash>.html`, also ignored and mode `0600`; `.hue` uses mode `0700`.
Setup rejects symlinks, unsafe paths, oversized or invalid state, custom files at its managed config
paths, and unexpected edits to files it previously managed. It preserves unrelated `.gitignore`,
manifests, lockfiles and project files.

Secret-free checkpoints remain in the operating system's per-user state directory and support
interruption/resume. Claim capabilities never enter checkpoints or public events. Credential retries are idempotent; a lost
credential response is recovered by asking for the same generation. `SETUP_CHANGED` triggers one
status refresh. `SETUP_REVOKED`, expired/purged installations, custom credential conflicts and
exhausted lifetime quota fail closed instead of silently replacing an installation or key.

Commands serialize all origins for one canonical project and reload current state under that lock.
Every invocation re-detects current manifests, managers and managed blocks before mutation. Normal
interruptions release the lock; after a forcible process kill, the owner must inspect the stale
non-secret lock under canonical `/tmp` on Linux/macOS
(`hue-setup-locks-<uid>/<sha256(canonical-project-root)>`) and remove only that lock after confirming
no setup command remains active. Its location does not depend on `TMPDIR`, `HOME` or state-directory
overrides; project aliases and different Hue origins share ownership. Other operating systems fail
closed for automatic setup. Setup never breaks an unexplained lock automatically or retries
business work.

Both setup credential generations use exactly
`^hue_setup_(live|test)_setup-([a-f0-9]{24})_([A-Za-z0-9_-]{43})$`, with `keyId` equal to
`setup-` plus the token's 24-character identifier, fixed kind `anonymous_trial`, and the sole
capability `setup_telemetry_write`.
Normal project credentials and unknown token shapes are refused in setup responses and private
managed state. These credentials authorize metadata-only OTLP at `/api/v1/otlp/v1/traces` and exact
content-free receipt verification at `/api/v1/setup/traces/{traceId}/receipt`. They do not authorize
generic project, receipt, evaluation, log or browsing APIs. The Python package version
pinned by setup can export with the setup
credential; the CLI verifies the dedicated setup receipt instead of Python's generic receipt helper.

Each command uses bounded timeouts and retries. Provisioning records at most five attempts per local
installation in an hour and makes at most two attempts in one invocation; the live service's stricter
per-network admission remains authoritative. Receipt polling honors the SDK's bounded deadline and
`Retry-After`. A missing or late receipt is reported as resumable and unverified, never as success.

The TypeScript event union is exported from `@hue-run/sdk/setup`; its JSON Schema is exported as
`@hue-run/sdk/setup-events.schema.json`. Event `run.*` names describe only CLI invocations, not Hue
Runs.

## Public machine events and actions

Events carry `contractVersion: 2`, a non-secret invocation ID, sequence and timestamp. The closed
event set is `run.started`, `project.detected`, `plan.ready`, `step.started`, `step.completed`,
`file.changed`, `diagnostic`, `privacy.notice`, `action.required`, `trial.created`,
`receipt.verified`, `claim.required`, `claim.completed`, `run.completed` and `run.failed`.

Event version 1 shipped in TypeScript `0.3.1` and `0.3.2`; its public claim URL, action set and receipt
step are incompatible with this flow. The v2 schema shipped in TypeScript `0.4.0` with identity
`https://hue.run/schemas/setup-events-v2.json`. Event version 2 is independent of Setup HTTP
`protocolVersion: 1` and the checkpoint format.

`privacy.notice` has only `privacyUrl`, `effectiveDate` and `securityUrl` beyond the event envelope,
with the literal values above. `receipt.verified` carries non-secret `receiptId`, `traceId` and
`source: "repository-http-boundary"`. It confirms the exercised application boundary and every
expected span, positive stored span count, empty missing IDs and absent input/output content.
It does not establish instrumentation of unexercised application paths. `claim.required` and
`claim.completed` carry only the non-secret `claimId`; neither contains a URL or capability.

The closed `action.required.action` set is:

| Action | Caller response |
| --- | --- |
| `claim-project` | Defer account linkage to the project owner. |
| `configure` | Resolve the reported availability or managed-configuration issue. |
| `select-project` | Select one supported application package explicitly with `--project`. |
| `integrate-application` | Resolve the reported unsupported or ambiguous integration safely. |
| `run-instrumented-request` | Inspect the prior attempt and missing evidence; do not automatically replay business work. |
| `open-claim-handoff` | Ask the owner to run `hue claim` in an interactive local terminal. |
| `restart-claim-handoff` | Ask the owner to explicitly run `hue claim --restart` if recovery is needed. |

A coding agent follows the non-secret message and optional command, reports unverified steps, and
leaves browser account linkage for the human. It must not read or copy the private handoff into a
transcript. `run.completed` with `action_required` is a successful pause, not proof that all setup
steps completed. `claim.completed` requires reconciliation and the retained evidence checks.

## Staging/live acceptance runner

Fern owns hosted acceptance and its private browser/inbox orchestration. SDK verification builds and
retains the exact tarball; it does not spend a live admission or claim hosted success. The Fern job
first accepts the reviewed PR archive, then after merge downloads the exact `publish=false` Release
SDK archive without repacking and repeats acceptance. It uses two persistent installations and at
most four provisioning admissions. Local compatibility fixtures do not spend hosted admissions.

The local/manual diagnostic runner accepts an already prepared supported application fixture. Its `--language`
scaffolding does not create such an application, and its human-output option does not allocate a PTY.
It records CLI outcomes, not independent original-handler span binding or server evidence. It always
exits nonzero: exit `2` means the diagnostic finished but acceptance remains unverified; malformed
events, private output and child failures also fail closed. Even a valid version-2 application receipt
event followed by `ready` cannot make this runner an acceptance gate. Do not use it to authorize a
release, count it as hosted acceptance, or suppress its exit code in a release gate:

```sh
node packages/sdk-typescript/scripts/verify-package.mjs --artifacts-dir .artifacts/typescript
# Set project to an existing supported fixture; use the same directory on resume.
project=/absolute/path/to/supported-fixture
node packages/sdk-typescript/scripts/verify-setup-live.mjs \
  --archive .artifacts/typescript/hue-run-sdk-0.10.0.tgz \
  --origin https://STAGING_ORIGIN \
  --project "$project" --command setup \
  --evidence .context/setup-staging-before-claim.json
```

After the approved backend is available, run `hue claim` from an interactive owner terminal to open
the private local handoff and finish the real browser claim, then reconcile the same project:

```sh
node packages/sdk-typescript/scripts/verify-setup-live.mjs \
  --archive .artifacts/typescript/hue-run-sdk-0.10.0.tgz \
  --origin https://STAGING_ORIGIN \
  --project "$project" --command claim \
  --evidence .context/setup-staging-after-claim.json
```

Repeat from an existing supported Flask/uv fixture when that diagnostic pass is budgeted. Evidence files explicitly
record `purpose: "diagnostic-only"`, `independentlyVerifiedApplication: false` and `accepted: false`,
with the archive hash, bounded event names and terminal outcome—never the claim capability, installation proof,
telemetry key, cookie, verification URL, project path or trace/span IDs. The runner installs and
executes the exact tarball; it does not establish hosted acceptance, registry publication or
production activation.

Hosted acceptance separately executes installed Express/npm, Express/Bun and Flask/uv fixture
coverage, with Agent JSONL and a real default-mode PTY. It independently verifies exact stored IDs,
the privacy disclosure, one handler invocation, verified-account adoption and owner transfer,
preserved project/data, replacement receipt access and old-key `401`. Browser orchestration opens
only the private local file and produces no secret-bearing screenshots, traces, logs or artifacts.
Publication under a candidate dist-tag, registry acceptance, production activation, promotion of
the same version to `latest`, and clean-project literal `@latest` smoke remain separate gates; see
[RELEASING.md](../../RELEASING.md).

## Evaluate an agent against a case

`hue eval` runs a developer's local agent against a published Hue case or a saved eval set
and prints Hue's verdicts. It is the command-line form of `runSimulation()` (one-shot) and
`runLocalAgent()` (worker): the agent, its prompts and its provider credentials stay in the local
process, Hue creates one isolated simulated world per case, and Hue-owned outcome checks grade
the sealed world. Hue never executes the agent. `HUE_API_KEY` must be a **Read and
write** project key (a **Read** or **Tracing only** key cannot read cases or create runs);
the CLI never prints it. The optional `zod` peer of `@hue-run/sdk/evals` must be installed.

Write an adapter module that hands the case inputs and the world's tools or MCP connection to
the real agent. The module exports `default` or `runMyAgent`; `context` is the SDK's
`SimulationTargetContext` (`world`, `mcp`, `tools`, `config`, `item`, `executionId`,
`environmentRunId`, `files`, `outputDirectory`, `signal`; `world` carries the provider mirror URLs,
the world token, `env` and `mcpConfig` where Hue's simulation gateway serves the world). When the
case also pins input files, `files` holds verified copies of its agent-visible ones (see
[Evaluate a document eval set](#evaluate-a-document-eval-set)); return
`withFiles(output, files)` from `@hue-run/sdk/evals` to upload documents the agent produced:

```ts
// hue-agent.ts: erasable TypeScript only; Node.js 24 and Bun strip the types natively.
import type { JsonValue, SimulationTargetContext } from "@hue-run/sdk/evals";
import { runAgent } from "./src/agent.js"; // The application's existing entry point.

export default function runMyAgent(inputs: JsonValue, context: SimulationTargetContext) {
  // Hand context.tools or context.mcp to the agent's real tool boundary; configuration alone
  // does not redirect provider calls. Pass context.signal for cooperative cancellation.
  const { config, tools, mcp, signal } = context;
  return runAgent({ inputs, config, tools, mcp, signal });
}
```

```sh
hue eval --case "Refund an eligible charge" ./hue-agent.ts --content --env-file .env.hue
hue eval --case https://app.hue.run/projects/demo/scenarios/<id> ./hue-agent.ts --content --baseline <run id>
hue eval --set "Billing regressions" --scorer-version <id> ./hue-agent.ts --content --save-version
hue eval --case "Refund an eligible charge" --command "python agent.py" --timeout 120 --content
hue eval --worker ./hue-agent.ts --agent-key support-agent --content --env-file .env.hue
```

`--scenario` remains an alias for `--case` for existing scripts. Pass one selection flag.

The one-shot mode resolves the selection (`--case` by name, or by the ID or URL of the published
case or of the case conversion that published it, among the project's first 1,000 Scenarios;
`--set` by name, ID or URL with explicit `--scorer-version` pins; or `--dataset-version` with `--scorer-version`),
creates a fresh run from those immutable pins named `<agent key> @ <revision>` (a commit hash is
shortened to 7 characters)
(`--name` overrides), prints `Run: <url>` and `Experiment: <id>` as soon as the experiment exists,
one line per case event (world created, agent started, world sealed), then
`Waiting for Hue checks...` and a table with one row per case: boolean metrics as `PASS`/`FAIL`,
numbers as values, text and category metrics as-is, an overall result per case and a pass count.
Failing cases print the scorer explanation. An evaluator Hue records as not applicable to a case
(its outcome scoring has no outcome criteria or conversion rubric to grade there) shows `n/a` in
that case's columns and neither passes nor fails it, so in a mixed eval set a case is decided by
the evaluators that apply to it; the pass line counts the not-applicable results. A case that no
pinned evaluator applies to is an error that names what they need. A result of a pinned Hue judge
(an evaluator of kind `world_judge`) that Hue marks advisory, as it does every judge's today, is
shown in its column, marked `(advisory)`, but never decides a case or the exit code; the pass line
counts advisory failures as not counted, and a case only advisory results ran for is an error. Any
other evaluator's result, an error, or a metric that carries `passed` is never advisory, whatever
its evidence says. A metric name that
several evaluators report, such as two judges' `verdict`, gets a column per evaluator, labelled
with the version's first eight characters. `--baseline <experiment id|url>` adds improvement,
regression and unchanged counts with per-case deltas. `--json` prints one JSON document
(`experimentId`, `runId`, `runUrl`, `complete`, `cases`, `totals`, optional `baseline`) on stdout
and sends progress to stderr; each case lists its not-applicable evaluator versions in
`notApplicable` and its advisory ones in `advisory`, and `totals.notApplicable` counts the
former; a case failed for its telemetry has `state: "error"`,
`passed: false` and
`telemetry: { code: "telemetry_not_accepted", issues: [{ signal, kind, status?, count }] }`. `--wait <seconds>` (default 300) bounds the verdict wait because
Hue-owned `world_outcome` checks are graded after the world seals. An experiment always covers
every case of the saved version; there is no case subset.

`--command "<shell command>"` spawns the command once per case with the world's environment
(`HUE_WORLD_ID`, `HUE_WORLD_TOKEN`, one `HUE_SIM_<SURFACE ID>_URL` per provider mirror,
`HUE_MCP_CONFIG` naming an owner-only `mcpServers` file that is removed after the case, and
`HUE_MCP_URL`, `HUE_MCP_TOKEN`, `HUE_MCP_EXPIRES_AT` for the first MCP mirror; these name the
world's simulated MCP server and replace a `HUE_MCP_URL` that `hue login` stored for Hue's project
MCP server), plus
`HUE_EXECUTION_ID`, `HUE_ENVIRONMENT_RUN_ID`, `HUE_CASE_ID` and `HUE_CASE_KEY`, and
`{"inputs": ..., "config": ...}` on stdin. The child does not receive `HUE_API_KEY`, `HUE_MCP_KEY`
or any other Hue control-plane credential unless `--allow-hue-credentials` is passed; the rest of
the parent environment (model keys, application settings) is inherited. `HUE_CASE_DIR`,
`HUE_CASE_INPUTS` and `HUE_CASE_OUTPUT_DIR` name a private case directory with the layout direct
cases use: the case inputs, verified copies of the case's agent-visible pinned files under
`files/<role>/`, and `output/`, whose files are uploaded after the world seals (the command still
starts in the current directory). The case directory never holds the world token and is removed
after the case. Its stdout is the answer
(JSON when it parses, otherwise trimmed text; empty means no output); a non-zero exit or the
per-case `--timeout` (default 600 seconds) is a target failure. A timed-out or interrupted command
is stopped as a whole process group on macOS and Linux: SIGTERM, then SIGKILL for anything still
running 5 seconds later, including an agent a compound command started after its shell exited;
the case settles only once nothing in the group is left. A command that exits normally but leaves
processes in its group has them stopped the same way before its answer and files are read. A
second Ctrl+C during that grace kills the group at once, removes the world case's files, the MCP
configuration file and the checkpoint locks, and exits with 130. The world token is never logged.
A world created while the deployment's simulation gateway is off gets the legacy `hue_sim_`
capability under the same `HUE_MCP_*` names. The agent key defaults to the slug of the command's
script name; `--revision` is sent to Hue as the agent revision of every world.

`--worker` registers the adapter through `runLocalAgent()` with key `--agent-key` (default: the
adapter filename slug), name `--agent-name` (default: the key), revision `--revision` (default:
`AGENT_REVISION`, then the Git `HEAD` short hash, then `dev`) and capability `environment:v1`
plus any repeated `--capability <value>`, prints the registration and each claimed run with its
URL, executes runs launched from Hue until Ctrl+C or `--max-runs <n>`, and prints the verdict table
after each run. Selection flags do not apply; Hue chooses the pinned experiment. The worker exits 0
when it stops normally. Hue offers a case whose world comes with agent-visible files only to a
registration that declares `environment-files:v1` and `input:<extension>` for each file type, for
example `--capability environment-files:v1 --capability input:pdf`; the adapter or command then
receives the files as described above. Hue keeps each registered revision's capabilities fixed,
so declare new ones under a new `--revision`. A world pinned to provider profiles, a Gmail world
for example, needs a reviewed `attemptBaselineV2` (see
[Pinned provider-profile preflight](ENVIRONMENTS.md#pinned-provider-profile-preflight)); `--worker`
registers none, so put `"attemptBaselineV2"` in the run's configuration JSON when you launch the
run from Hue.

A Scenario or eval set whose dataset version is not saved cannot back an experiment: the command
exits 1 and asks for **Save eval-set version** in Hue or `--save-version`, which freezes that
version at its current revision. Connection settings are `HUE_API_KEY` and `HUE_BASE_URL`
(default `https://app.hue.run`), loaded from `--env-file <path>` (or its alias `--env-path`) first when given; `--origin`
overrides the origin. Telemetry content capture stays off unless `--content` is passed; the
examples pass it so the run's case spans carry content. Model and tool spans inside the agent come
only from the agent's own instrumentation. Case outputs, error messages and explanations are
stored in Hue whether or not `--content` is passed, so a case's answer can be graded and read on
its run page. A `--command`'s stdout is its answer unless it writes a result file, and is stored,
so it must not print credentials or debug logs there; before storing, `hue eval` replaces the
credentials it handed the case (the world token and MCP headers, a legacy MCP token, attempt
bearers) and every Hue control-plane credential in its environment with `[redacted]`, in the
answer, an adapter's thrown message and name, generated file names and the local checkpoint.
`--no-output` keeps outputs, error messages and explanations out of a one-shot run's stored
results; with `--content` the case span still carries the output. `--worker` always stores them, because a run launched from Hue is read
on its run page (that is `runLocalAgent()`'s contract), and refuses `--no-output`. An interrupted
one-shot run keeps the choice it started with, so one run never mixes stored and unstored outputs:
rerunning it with other `--no-output` or `--content` flags is refused with the flags it started
with. Resume a run that an earlier SDK started without `--content` by passing `--no-output`.

Files the agent writes to `output/` are uploaded as generated documents with or without
`--no-output`, and they are not redacted the way the answer is: `hue eval` replaces the same
credentials only in the UTF-8 `.txt`, `.csv` and `.json` documents it collects, while PDF, Office
and image documents, and files an adapter returns by `path`, are uploaded as written. A direct
case also keeps the agent's raw `output/` files on disk under its checkpoint directory
(`.hue/eval/<agent-key>/<project>/direct/<experiment>/files/`). Never write credentials to
`output/`.

Trace evidence is required for every case: when Hue does not accept a case's traces or logs, the
case is completed as failed (error `TelemetryNotAccepted`, evidence omitted as
`telemetry_not_accepted`, no output or generated files attached) instead of being left started,
and the run goes on. Each export of the CLI's own telemetry may take 30 seconds, retries
included: a slow acknowledgement is waited for, and a 429, 502, 503, 504 or network error is
retried within that time, honouring `Retry-After`; any other response, or rejected records, fails
the case at once. Stderr names the case as it completes, with the export
issue counts, for example
`[refund] telemetry not accepted, case failed: telemetry_not_accepted: traces failed 1 (HTTP 400)`;
the case counts as an error in the table and JSON whatever its scores, and the command exits 1.
Counts carry signals, kinds, HTTP statuses and record numbers only, never content or credentials.
Resumable checkpoints live in `.hue/eval/<agent-key>/<project id>/` (a `.gitignore` is written
inside `.hue/eval/`); `--checkpoint-dir` overrides the root. Rerunning the same selection resumes
an interrupted run without invoking the agent again; a different selection is refused until the
unfinished one is resumed or its directory is removed.

Exit codes: `0` every case passed the evaluators that apply to it (advisory ones never count),
`1` a case failed, errored (including one no pinned evaluator applies to or decides), was skipped
or Hue's checks were
still pending at `--wait`, `2` usage or configuration error (including a missing key), `130`
interrupted. On Node.js 22, load TypeScript adapters with `NODE_OPTIONS=--experimental-strip-types`;
non-erasable syntax (enums, parameter properties, namespaces) needs a loader such as `--import tsx`
on any Node.js version.

## Evaluate a document eval set

Eval sets whose cases pin no simulated world — a task plus pinned input files, answered with
generated documents — run as **direct** cases through `runExperiment()`. `hue eval` detects this
from the saved version (`--mode direct|simulation` overrides the detection; `--case` is always
a simulation). `--set` accepts the eval set's slug, name, ID or URL; `--set-version <n>` pins a
saved version other than the latest; `--scorer <slug|name|id>` pins an evaluator at its newest
published version, beside or instead of explicit `--scorer-version` IDs.

```sh
hue eval --set gia-d1-citation --scorer gia-d1-citation \
  --command "pnpm --filter @august/frontend run hue:gia-agent" \
  --revision prompt-v10 --wait 1800 --content --json --env-file .env.hue
hue eval --set gia-d1-citation --set-version 1 --scorer gia-d1-citation ./hue-agent.ts --content --baseline <experiment id>
```

For each case the command is spawned once **inside a private case directory** with
`HUE_CASE_DIR`, `HUE_CASE_INPUTS`, `HUE_CASE_OUTPUT_DIR`, `HUE_CASE_ID`, `HUE_CASE_KEY` and
`HUE_EXECUTION_ID` in its environment (`{"inputs","config"}` is also written to stdin):

```text
<case dir>/inputs.json            the case inputs (for example {"query": "...", "tipo_diligencia": "Virtual"})
<case dir>/case.json              id, external key, execution id, run config, staged file list
<case dir>/files/<role>/<name>    verified copies of the agent-visible pinned files
<case dir>/output/                write the generated documents here
```

Hue verifies each generated document before the case completes. Once a document is reserved and
its bytes are uploaded, a verification that outlasts a request is waited out for up to three
minutes, so a completion that cannot reach Hue takes that long to fail; a reservation or upload
that cannot reach Hue still fails at once.

Every regular file the command leaves under `output/` is uploaded as a generated document
(accepted: `.pdf .docx .pptx .xlsx .json .txt .csv .png .jpg .jpeg .webp`; another extension or an
empty file is the case's error). Optional helpers: `manifest.json` (`{"primary": "<filename>",
"output": <json>}`) names the primary document and the JSON output; `result.json` is the JSON
output; `summary.txt` or `summary.md` is recorded as `{"summary": "..."}`. When none is written,
the command's stdout is the output (JSON when it parses). A single generated file is the primary
document by default. Model and provider credentials stay in the command's own environment; the
scoped case files are copies under `--checkpoint-dir` (default `.hue/eval/<agent-key>/<project>/direct/<experiment>`).

The same collection serves world cases, and it does not trust paths the agent controls. `output/`
must be a real directory, and a helper name, when present, a regular file; a symlink, FIFO or
directory in either place is the case's error. Symlinks and other special files among the
documents are skipped, as are hidden and lock entries. Every file is opened without following a
final symlink or blocking, must be the regular file the listing saw and within its limit (4 MiB
for a helper, 25 MiB for a document, checked before reading), and its upload is staged from the
bytes read. A file or directory that vanished or changed while it was collected, more than 32
documents or more than 1024 entries is the case's error too. A hard link is an ordinary file and
is collected like one: an agent running as your user could copy the file just as well, so run an
agent that must not reach your files under another account or in a sandbox.

An adapter file works too: it is called with `(inputs, context)` where `context.mode` is
`"direct"` and `context` carries `config`, `item`, `executionId`, `files` (agent-visible pinned
files on disk), `outputDirectory` and `signal`. Return a JSON value, or `withFiles(output, files)`
from `@hue-run/sdk/evals` to attach generated documents.

Code evaluators pinned to the run are **not** executed on your machine: the CLI leaves them
deferred (`deferUnboundLocalScorers`) and Hue's grading executor scores the uploaded documents;
evaluator-only pinned files such as a legal corpus are never downloaded. `Waiting for Hue
checks...` then covers that grading, so size `--wait` to the evaluator's runtime. The
`--json` document gains `"mode": "direct"` and `"deferredScorerVersionIds"`. Exit codes, `--baseline`,
`--content`, `--no-output` and checkpoints behave as for Scenarios; generated documents are
uploaded with or without them.
