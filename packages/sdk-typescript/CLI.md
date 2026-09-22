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
not a completed integration. TypeScript uses `@hue-run/sdk@0.4.2`, `@opentelemetry/api@1.9.1` and
`@opentelemetry/context-async-hooks@2.11.0`; Python uses published `hue-run==0.2.2`.
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
generic project, receipt, evaluation, log or browsing APIs. Published Python `0.2.2` can export with the setup
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
  --archive .artifacts/typescript/hue-run-sdk-0.4.2.tgz \
  --origin https://STAGING_ORIGIN \
  --project "$project" --command setup \
  --evidence .context/setup-staging-before-claim.json
```

After the approved backend is available, run `hue claim` from an interactive owner terminal to open
the private local handoff and finish the real browser claim, then reconcile the same project:

```sh
node packages/sdk-typescript/scripts/verify-setup-live.mjs \
  --archive .artifacts/typescript/hue-run-sdk-0.4.2.tgz \
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
