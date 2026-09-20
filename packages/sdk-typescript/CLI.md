# Hue setup CLI

The local setup-session CLI core shipped in TypeScript `0.3.1`. TypeScript `0.4.0` prepares the
real one-command setup flow:

```sh
npx --yes @hue-run/sdk@0.4.0 setup
# The npm alias exposes the same executable once that separately gated alias is published:
npx --yes hue-run@0.4.0 setup
```

Run it from a clean TypeScript or Python project. The command detects manifests without importing
or executing project code, provisions a metadata-only installation, writes a secret-free integration
module, exports and flushes one real OpenTelemetry probe, and verifies that probe's exact trace and
span IDs through Hue's receipt endpoint. A verified probe proves only that the setup probe was
stored. It does not prove the application's own instrumentation ran.

The generated `hue.setup.mjs` or `hue_setup.py` always selects `captureContent: false` /
`capture_content=False`. Import it from the application's server-side instrumentation entry point
after adding the matching SDK as an application dependency. Content capture is never enabled by
setup; it requires an ordinary account-managed key and a later explicit application decision.

Setup creates no Scenario, Hue Run, evaluation, source capture, worker or remote execution. It does
not run a package manager, application command, lifecycle script or provider request.

## Commands and modes

```sh
hue setup                 # provision/configure/verify, then show the private claim link
hue resume                # continue the same project/origin installation
hue status                # read status; after claim, reconcile generation 1 if necessary
hue claim                 # show the link, or reconcile after the browser completes claim
hue setup --agent         # noninteractive version-1 JSONL events
hue setup --format human  # explicit append-only terminal rendering
hue setup --origin http://127.0.0.1:PORT # isolated loopback tests only
```

Hosted setup accepts HTTPS origins only. HTTP is accepted solely for `localhost`, `127.0.0.1` and
`[::1]` test origins. Origins with credentials, paths, queries or fragments are refused, and
redirects are never followed.

`--agent` never reads stdin or opens a browser. It emits exactly one terminal `run.completed` or
`run.failed` event. Human mode prints the claim link intentionally; the complete URL is a private
bearer capability because its fragment contains the claim secret. Do not put it in screenshots,
logs, issue reports or analytics. The browser owns the claim cookie; the CLI never reads it. After
claim completes, rerun `hue claim` or `hue status` to fetch credential generation 1, atomically
replace the locally managed key, verify a new metadata probe, and—when generation 0 is still in
memory—confirm the old key receives `401`.

## Local state and conflicts

Before its first network write, setup creates a lowercase UUIDv4 and a 32-byte random installation
secret. They live with the current telemetry credential in `.hue/installation-<origin-hash>.json`.
The file is added to `.gitignore`, written atomically with mode `0600`, and scoped to this exact
project and Hue origin. `.hue` uses mode `0700`. Setup rejects symlinks, unsafe paths, oversized or
invalid state, custom files at its managed config paths, and unexpected edits to files it previously
managed. It preserves unrelated `.gitignore`, manifests, lockfiles and project files.

Secret-free checkpoints remain in the operating system's per-user state directory and support
interruption/resume. Claim URLs are never checkpointed. Credential retries are idempotent; a lost
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

Build and retain the exact tested tarball, then use an empty temporary project outside the repository:

```sh
node packages/sdk-typescript/scripts/verify-package.mjs --artifacts-dir .artifacts/typescript
project="$(mktemp -d)"
node packages/sdk-typescript/scripts/verify-setup-live.mjs \
  --archive .artifacts/typescript/hue-run-sdk-0.4.0.tgz \
  --origin https://STAGING_ORIGIN \
  --project "$project" --language typescript --command setup \
  --evidence .context/setup-staging-before-claim.json
```

Open the private link printed only to the terminal, finish the real browser claim, then reconcile the
same project:

```sh
node packages/sdk-typescript/scripts/verify-setup-live.mjs \
  --archive .artifacts/typescript/hue-run-sdk-0.4.0.tgz \
  --origin https://STAGING_ORIGIN \
  --project "$project" --command claim \
  --evidence .context/setup-staging-after-claim.json
```

Repeat from another empty directory with `--language python`. Evidence files contain the archive
hash, event names and terminal outcome only—never the claim link, installation proof, telemetry key,
project path or trace/span IDs. Do not redirect the terminal line containing the private claim link
into an artifact. The runner installs and executes the exact tarball; it does not establish registry
publication or authorize production activation.
