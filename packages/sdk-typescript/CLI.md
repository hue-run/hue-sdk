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
to a single-package npm/Bun Express server or uv Flask server with one statically recognizable
entrypoint, a literal existing GET route and `PORT` supplied by the environment. The command uses the
detected manager to install an exact runtime, inserts two owned middleware marker blocks without
rewriting business logic, starts that exact entrypoint without a shell, requests the existing route,
flushes, and verifies its exact trace/span receipt. It never treats a generated probe as application
evidence.

Workspace roots, mixed languages/managers, custom Hue versions, edited marker blocks, unfamiliar
entrypoints and ambiguous routes stop with `action.required`. Select a package with `--project`, or
integrate Hue into an existing request path and rerun. Setup does not choose a monorepo package.

The generated `hue.setup.mjs` or `hue_setup.py` always selects `captureContent: false` /
`capture_content=False`. Import it from the application's server-side instrumentation entry point
after adding the matching SDK as an application dependency. Content capture is never enabled by
setup; it requires an ordinary account-managed key and a later explicit application decision.

Setup creates no Scenario, Hue Run, evaluation, source capture, worker or remote execution. Package
manager lifecycle scripts are disabled. The supported existing application entrypoint is executed
directly with fixed argv solely for its bounded local HTTP verification; no shell command is accepted.

## Legal approval gate

The enforced order is read-only project detection/conflict planning, active legal-notice preflight,
explicit human acceptance of that exact Terms/Privacy version, runtime installation and wiring,
provisioning, then application exercise. Agent mode cannot accept for its user. Missing, stale,
disabled or unavailable notice metadata emits a bounded `approve-legal-notice` action before package
manager, project, `.hue`, credential or setup-network writes. A secret-free checkpoint may already
exist in the operating system's user state directory so the same invocation can resume.

No authoritative combined Terms/Privacy bundle or approved version is configured yet. The real
adapter therefore fails closed at this step; the privacy page's date is not treated as a version and
the SDK contains no substitute legal text. Synthetic notice fixtures are isolated-test inputs only.

## Commands and modes

```sh
hue setup                 # provision/configure/verify, then prepare a private owner handoff
hue resume                # continue the same project/origin installation
hue status                # read status; after claim, reconcile generation 1 if necessary
hue claim                 # open the owner-only handoff, or reconcile after browser claim
hue setup --agent         # noninteractive version-1 JSONL events
hue setup --format human  # explicit append-only terminal rendering
hue setup --origin http://127.0.0.1:PORT # isolated loopback tests only
```

Hosted setup accepts HTTPS origins only. HTTP is accepted solely for `localhost`, `127.0.0.1` and
`[::1]` test origins. Origins with credentials, paths, queries or fragments are refused, and
redirects are never followed.

`--agent` never accepts legal terms, reads stdin or opens a browser. It emits exactly one terminal `run.completed` or
`run.failed` event and only a generic owner action. No setup mode prints a bearer claim URL or token.
The CLI saves the capability in an ignored owner-only local handoff and human Terminal mode opens
only that local file; the browser consumes the short-lived one-time capability. A repository-reading
agent can read local project files, so this boundary prevents durable transcript/log disclosure, not
a malicious local process. The browser owns the claim cookie; the CLI never reads it. After claim
completes, rerun `hue claim` or `hue status` to fetch credential generation 1, atomically replace the
locally managed key, verify again, and—when generation 0 is still in memory—confirm the old key
receives `401`.

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

Each command uses bounded timeouts and retries. Provisioning records at most five attempts per local
installation in an hour and makes at most two attempts in one invocation; the live service's stricter
per-network admission remains authoritative. Receipt polling honors the SDK's bounded deadline and
`Retry-After`. A missing or late receipt is reported as resumable and unverified, never as success.

The TypeScript event union is exported from `@hue-run/sdk/setup`; its JSON Schema is exported as
`@hue-run/sdk/setup-events.schema.json`. Event `run.*` names describe only CLI invocations, not Hue
Runs.

## Staging/live acceptance runner

Fern owns hosted acceptance and its private browser/inbox orchestration. SDK verification builds and
retains the exact tarball; it does not spend a live admission or claim hosted success. The Fern job
first accepts the reviewed PR archive, then after merge downloads the exact `publish=false` Release
SDK archive without repacking and repeats acceptance. It uses two persistent installations and at
most four provisioning admissions; a legal pause spends zero admissions.

The SDK's local/manual runner remains useful only after Fern supplies the frozen legal and private
handoff contracts. It must not be represented as hosted acceptance:

```sh
node packages/sdk-typescript/scripts/verify-package.mjs --artifacts-dir .artifacts/typescript
project="$(mktemp -d)"
node packages/sdk-typescript/scripts/verify-setup-live.mjs \
  --archive .artifacts/typescript/hue-run-sdk-0.4.0.tgz \
  --origin https://STAGING_ORIGIN \
  --project "$project" --language typescript --command setup \
  --evidence .context/setup-staging-before-claim.json
```

Run `hue claim` from an interactive owner terminal to open the private local handoff, finish the real
browser claim, then reconcile the same project only after the refrozen contract is implemented:

```sh
node packages/sdk-typescript/scripts/verify-setup-live.mjs \
  --archive .artifacts/typescript/hue-run-sdk-0.4.0.tgz \
  --origin https://STAGING_ORIGIN \
  --project "$project" --command claim \
  --evidence .context/setup-staging-after-claim.json
```

Repeat from another supported fixture with `--language python`. Evidence files contain the archive
hash, bounded event names and terminal outcome only—never the claim capability, installation proof,
telemetry key, cookie, verification URL, project path or trace/span IDs. The runner installs and
executes the exact tarball; it does not establish hosted acceptance, registry publication or
production activation.
