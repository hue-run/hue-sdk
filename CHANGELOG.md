# Changelog

Both packages follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the pre-1.0 rules in
[VERSIONING.md](./VERSIONING.md): a `0.MINOR` release may contain **Breaking** entries with migration
notes; a patch release adds or fixes without changing capture semantics, default budgets or the wire
format. Entries marked **Wire** change emitted attributes, events or endpoints. The release workflow
refuses to publish a version without a matching entry below.

## @hue-run/sdk (TypeScript)

### Unreleased

### [0.4.1] - 2026-09-21

#### Added

- `hue.tool(..., { mcp })` records the MCP `initialize` `serverInfo` as `mcp.server.name` and
  `mcp.server.version`, so a generic tool name can be attributed to the server that handled it.
  Pass `client.getServerVersion()` after connect; any MCP server works. Environment catalog
  entries may include the same `mcp` object, and `bindEnvironmentTools` stamps it automatically.
  **Wire**

No registry release is claimed until publication and registry acceptance complete.

### [0.4.0] - 2026-09-20

#### Breaking

- The unreleased setup-session placeholder is replaced by Setup HTTP protocol v1. The exported
  `SetupBackendAdapter` is now a concrete installation/status/credential/OTLP-receipt adapter rather
  than the historical `createTrial`/`verifyReceipt`/`getClaim` stub boundary. Migration: construct it
  with `{ projectRoot, origin? }` and pass it to `runSetup`, or use the `hue` executable. Existing
  `createHue`, exporter, evaluation and environment APIs are unchanged.
- Setup JSONL events now carry `contractVersion: 2` and schema identity
  `https://hue.run/schemas/setup-events-v2.json`. Version 1 shipped in `0.3.1` and `0.3.2` with a public
  claim URL and different step/action fields. Migration: consume the bundled v2 schema, handle the
  non-secret local-handoff actions and `privacy.notice`, use `verify-application-receipt`, and require
  `receipt.verified.source: "repository-http-boundary"`. Claim events no longer include a URL.
  Setup HTTP `protocolVersion: 1` is independent and remains an unreleased protocol candidate.

#### Added

- The `hue` executable implements the unreleased Setup HTTP protocol v1 candidate: per-project/per-origin
  installation proof is persisted before network writes, provisioning and credential recovery are
  idempotent, and account claim reconciles generation 1 while checking generation 0 revocation.
- The automatic matrix is Express with npm, Express with Bun, and Flask with uv in one package
  with an unambiguous existing entrypoint, literal GET route and environment-selected port. Setup
  installs exact runtime versions through that manager, adds bounded owned middleware blocks without
  rewriting business logic, makes one request to the existing route and verifies its exact trace/span
  receipt. That original evidence is preserved through account claim without replaying business work.
  Monorepos, mixed managers, custom runtime versions and unfamiliar shapes require an explicit action.
- Technical preflight reports availability and presents the published privacy and security notice
  before telemetry. The anonymous ingestion window is 24 hours with limits of 100 traces, 1,000 spans
  and 2 MiB; unclaimed data is purged seven days after expiry.
- Both credential generations use the isolated setup token namespace and sole
  `setup_telemetry_write` capability. Exact receipts use the dedicated setup route. Normal and unknown
  token substitutions are refused; content capture requires a separate account-managed key.
- Managed credentials stay in ignored atomic `0600` files; custom conflicts, symlinks, unsafe paths,
  insecure hosted origins, redirects and unexpected edits fail closed. Setup creates no Scenario,
  Hue Run, evaluation, source capture, worker or remote execution.
- Human terminal and noninteractive version-2 JSONL agent modes support interruption/resume, private
  one-time browser handoff, post-claim status reconciliation and bounded retries. Handoffs last at
  most ten minutes, browser sessions at most thirty minutes, and each installation permits at most
  32 handoff IDs. Only an explicit human restart replaces a handoff; public output contains no claim
  capability. Installed-tarball checks cover both modes and both project languages against a loopback
  protocol service; a separate
  staging/live runner records only secret-free evidence.
- The unpublished `hue-run` npm alias tracks `0.4.0`, pins `@hue-run/sdk@0.4.0`, mirrors setup exports
  and includes its own `hue` executable wrapper. Alias publication remains a separate release gate.

No registry release is claimed until publication and registry acceptance complete.

### [0.3.2] - 2026-09-20

#### Fixed

- `runSimulation()` and `runLocalAgent()` accept an authoritative `expired` world after a failed
  finish request, allowing execution and experiment finalization while preserving the target
  outcome and expired evidence. Unconfirmed seals still remain uncertain without replaying the agent.
- Availability documentation records TypeScript `0.3.1` as published, including scorer deferral
  and the local setup CLI core.

The [release artifacts](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.3.2) are published and passed registry acceptance.

### [0.3.1] - 2026-09-20

#### Added

- The `ScorerDefinition` union and publication validator accept Hue-executed `world_outcome`
  pins with their fixed entry and metrics. They require no local scorer registration.
- A dependency-free `hue` setup-session CLI and `@hue-run/sdk/setup` installer contract provide
  deterministic local project detection, private resumable checkpoints, append-only human/plain
  renderers and versioned JSONL agent events. This first slice does not change project files, contact
  the Hue backend, or create a Scenario, evaluation, worker or Hue Run.
- The unpublished npm alias tracks the new package exports and version. Public installation still
  uses `@hue-run/sdk`; alias publication remains separate.

#### Fixed

- Local evaluation runners execute only known `builtin` entries and bound `local_code` scorers. Other kinds
  remain pending and appear in `deferredScorerVersionIds`, including kinds introduced by a newer
  server. Unknown built-in entries are deferred too. The SDK does not upload placeholder results
  for deferred scorers, including placeholders saved by an older SDK before an interrupted upload.
- Availability documentation now records the already-published worker correctly. The setup CLI core
  was merged after publication and first belongs to this new release, not the existing 0.3.0 archive.

The existing `runLocalAgent` API, V2 connection bundle, provider transport, environment lifecycle,
checkpoint formats, telemetry ownership and capture defaults are unchanged. Python remains at 0.2.2.
No registry release is claimed until publication and registry acceptance complete.

### [0.3.0](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.3.0) - 2026-09-19

#### Breaking

- `runSimulation()` now gives candidate callbacks only case identity and cloned task inputs, excluding expected criteria, case metadata and environment pins. Migration: move candidate-visible metadata into task inputs or candidate configuration. Scorers retain their evaluation context; generic `runExperiment()` callbacks are unchanged.
- `EnvironmentVersion.definition`, `EnvironmentClient.publishVersion()` and repository-authored simulation definitions now use `PublishableEnvironmentDefinition`, whose discriminator is `schemaVersion: 1 | 2`, rather than assuming V1. Migration: consumers that access V1-only definition fields must first narrow `definition.schemaVersion === 1`, or annotate known V1 values as `EnvironmentDefinitionV1`; use `EnvironmentDefinitionV2` only when supplying `providerInstances`.

#### Added

- `runLocalAgent()` connects a fixed local TypeScript agent entry point to app-launched, versioned simulation jobs while preserving checkpoint recovery and the developer's existing process, debugger and provider orchestration.
- `runLocalAgent()` and `runSimulation()` share one provider-aware world lifecycle: V2 manifest preflight runs once before target code, ready bundles remain memory-only, incomplete environments skip targets and scorers, and uncertain preparation is never reacquired or replayed.
- Environment publication supports explicit V1 and V2 definitions, including immutable Gmail provider-instance bindings and canonical synthetic-principal UUID comparison.

### [0.2.2](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.2.2) - 2026-09-18

#### Fixed

- Export-time byte accounting walks arrays by element, matching admission, so array-heavy records such as embeddings that fit `maxQueueBytes` are exported instead of failed as `invalid`.

### [0.2.1](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.2.1) - 2026-09-18

#### Changed

- The package description no longer ends with `(hue.run, not Philips Hue)`.

### [0.2.0](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.2.0) - 2026-09-18

#### Breaking

- `zod` is an optional peer required when importing `@hue-run/sdk/evals`; `ajv` remains a separate optional peer used only by `builtins.jsonSchema`, which reports `SchemaValidatorUnavailable` when it is absent. The tracing core now depends only on `@opentelemetry/*` packages. Migration: run `npm install zod` (4.6.5 or later) for evaluations or simulations, and add `ajv` (8.17 or later) when using JSON Schema scorers.
- Export requests use explicit configuration only: `OTEL_EXPORTER_OTLP_*` environment variables no longer reach Hue's endpoint, and requests carry a `hue-sdk-typescript/<version>` User-Agent. **Wire** Migration: none for documented configuration; headers or endpoints that reached Hue through those variables were unintended and have no replacement.
- `hue.tool()` spans are named `execute_tool {name}` (`gen_ai.tool.name` keeps the bare name), matching the Python SDK and the GenAI semantic conventions. **Wire** Migration: match tool spans on `gen_ai.tool.name` or the `execute_tool ` prefix instead of the bare span name.
- Failed helper spans carry `error.type` (the error's `name`), an ERROR status without a description and an `exception` event with only `exception.type`; exception messages and stack traces are no longer recorded even with `captureContent: true`, matching the Python SDK. **Wire** Migration: group error dashboards on `error.type` and keep stack traces in application logs.
- Metadata-only mode also strips OpenInference retrieval documents, embeddings, reranker query and documents, prompt-template text and variables, `llm.tools`, `llm.function_call`, `llm.choices`, input/output images, and AI SDK `ai.response.reasoning` and `ai.response.files`; `contentPrefixes` lists the full set. **Wire** Migration: applications that relied on those fields reaching Hue with `captureContent: false` must set `captureContent: true`.
- `HueTransport`'s exporter plumbing (`finish`, `acceptedRecords`, `issue`, `instrumentationFailure`) is `@internal` and no longer appears in the published declarations. Migration: none for documented usage; read `getReport()`, `getIssues()` and `getFailureSequence()` instead of calling these members.

#### Added

- TypeScript environment APIs and bounded local tools through the new `@hue-run/sdk/environment` export, plus evaluation-client support for execution-scoped hosted MCP capabilities.
- TypeScript `runSimulation()` for repository-authored or app-authored scenarios, with immutable definition pins, fresh isolated worlds, resumable uploads, evidence-aware scoring, and early run URLs.
- V2 attempt-profile preflight for `runSimulation()`, including explicit actual-manifest evidence, typed provider connection bundles, secret-free V1/V2 binding reads, stable refresh/revocation checks, and the backwards-compatible `context.mcp` projection.
- `./package.json` export, `sideEffects` metadata, `bugs` and `keywords` in the package manifest.
- `hue.model(model, callback, options)` creates a GenAI client span for a direct provider call, taking the callback before its options like `withSpan`; `options` carries `provider`, `operation` and `name` plus `sessionId`, `userId`, `input` (recorded as `gen_ai.input.messages`) and `parentContext`. `HueSpan.setUsage()` records validated token counts, matching the Python helpers.
- `hue.inject()` / `hue.extract()` carry W3C trace context between processes without baggage or credentials.
- `hueExperimentalTelemetry(hue)` from the core entry point for AI SDK 6 `experimental_telemetry`; `hueTelemetry` remains AI SDK 7 only.
- `contentPrefixes` exports the attribute keys removed in metadata-only mode.
- Bun 1.4.2 runs the installed-package behavioral suite and the reference chatbot in package verification, and `bun pm pack` must agree with `npm pack` on package contents.
- `require("@hue-run/sdk")` and the other entry points work from CommonJS on Node.js 22.12 or later: every `exports` entry carries a `default` condition and the build has no top-level `await`; package verification exercises the `require()` path.
- `resourceAttributes` on owned-client options adds resource attributes such as `deployment.environment.name` to the owned resource, with `serviceName` and `serviceVersion` taking precedence over same-named keys; attach mode ignores it with a warning issue.
- `allowInsecureHttp: true` permits `http://` to hosts other than loopback, such as a docker-compose or in-cluster collector, and records a one-time warning issue.
- `HueConnectionError.cause` carries the underlying network, timeout or parsing error from `checkConnection()`.
- `recordMessages` accepts `operation`, `provider` and `model` for the request attributes of the details record.
- `hue.tool(name, input, execute, { callId })` records `gen_ai.tool.call.id` on the tool span, matching the Python `call_id=` keyword; a blank id is omitted with an instrumentation failure.

#### Changed

- The instrumentation scope version and export User-Agent come from a literal generated from `package.json` at build time; nothing reads `package.json` at import time, so bundled deployments are unaffected.
- `engines.node` is `>=22.12`; Node 22 and 24 are tested and Node 26 runs in CI.
- npm releases carry provenance attestations; the release workflow refuses to publish from a private source repository.
- `createHue({ enabled: false })` no longer requires `captureContent`; a disabled client defaults it to `false`.
- Export requests are sized from each record's own encoding and encoded once when sent, instead of re-encoding the growing batch for every record; the 1 MiB request split and oversized-record reporting are unchanged.
- `hue.tool`, `setInput`, `setOutput`, `recordMessages` and `SpanOptions.input` accept `unknown`, so interface-typed values compile without casts; `JsonValue` remains the documented wire shape and values that are not JSON are still omitted at runtime with an instrumentation failure.
- `recordMessages` sets `gen_ai.operation.name`, `gen_ai.provider.name` and `gen_ai.request.model` (from the enclosing `model()` span or the caller) and `gen_ai.conversation.id` (from the active session) as attributes on the `gen_ai.client.inference.operation.details` log record, alongside the existing body. **Wire** The Python `log_inference` record does not carry these attributes yet (tracked in #37).
- `hueTelemetry` reads the installed `ai` major version once per process and rejects only versions below 7; the peer range enforces the `7.0.99` floor.
- Every exported type, option and member of the four entry points carries API documentation, and the TypeScript reference build fails on undocumented public API.
- The package description ends with `(hue.run, not Philips Hue)` so registry listings are not mistaken for smart-lighting libraries.

#### Fixed

- Repository simulations normalize every public scorer definition default before immutable digest lookup and reject unsupported server-only scorer kinds instead of publishing an incompatible identity.
- The managed-target README snippet passes `tracer: hue.tracer`; without it every invocation returned `uncertain`.
- `withSpan`, `tool`, `model` and `hue.tracer.startActiveSpan` make their span the active OpenTelemetry span while the callback runs, so spans from instrumentations that use the global API parent under Hue spans when the application has registered a context manager; Hue still registers none. A disabled client leaves the application's active span visible through `getContext()`, `HueSpan.context` and `inject()`.
- Owned providers export the OpenTelemetry default resource (`telemetry.sdk.language`, `telemetry.sdk.name`, `telemetry.sdk.version`) beside `service.name` and `service.version`. **Wire**
- `createHueSafe` keeps the caller's `onExportIssue` on the disabled fallback client and records the configuration error's message as the reported issue.
- `hue.inject()` propagates W3C trace context when the client is disabled or closed, matching the Python SDK.

### [0.1.5](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.1.5) - 2026-09-17

#### Changed

- Pending telemetry is bounded by bytes as well as records, including in-flight exports; the default `maxQueueBytes` is 8 MiB across traces and logs. Omissions and drops are reported through cumulative health counters.
- The `ai` peer range accepts AI SDK 6 for core installation; `hueTelemetry` still requires AI SDK 7.

#### Added

- `createHueSafe`, `enabled: false`, `flushSafe` and `shutdownSafe` with a default one-second caller deadline. Strict diagnostic APIs remain.
- Installed-package regressions for outages, oversized data, redactor failures, queue saturation, cancellation, stuck providers and trickling responses.

#### Fixed

- Helper capture, redaction and provider failures are isolated from application results and errors; business callbacks never rerun.
- Transport work and acknowledgements are bounded, and rejected diagnostics are isolated from the application.

### [0.1.4](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.1.4) - 2026-09-16

#### Added

- `@hue-run/sdk/managed`: managed-target adapters with scoped execution claims, verified file bytes, existing-provider trace context, idempotent outcomes and telemetry acknowledgements.

#### Fixed

- Saved outcomes are preserved when flush callbacks report failure or pending records; expired callback budgets and malformed trace or file identities are rejected before agent work starts.

### [0.1.3](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.1.3) - 2026-09-16

#### Added

- `hue.verifyTrace()` verifies persisted application traces by OpenTelemetry trace ID, expected span IDs and required field presence using bounded, authenticated receipt requests. Export acknowledgement, stored evidence and content inspection stay distinct; incomplete receipts and safe authentication or transport failures are reported.

### [0.1.2](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.1.2) - 2026-09-15

#### Added

- First public npm release under MIT with the core, AI SDK and evaluation entry points.
- Hosted-judge authentication and charge-reconciliation metadata in the TypeScript declarations.
- Documented runtime and integration matrix, including dependency-resolution and cross-language content and delivery boundaries; verified release archives and registry bytes.

## hue-run (Python)

### Unreleased

### [0.2.2](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.2.2) - 2026-09-18

#### Changed

- `log_inference` emits the `gen_ai.client.inference.operation.details` record with a structured body instead of JSON-string fields (an explicit `None` field keeps its key with an empty value, as in TypeScript), sets `gen_ai.operation.name`, `gen_ai.provider.name` and `gen_ai.request.model` as record attributes from the enclosing `model()` block or the new `operation=`, `provider=` and `model=` keywords, and `gen_ai.conversation.id` from the enclosing `context()`, matching TypeScript `recordMessages` (#37). With `capture_content=False` no record is emitted, and the Python-only `hue.capture_content` record attribute is gone. **Wire**

### [0.2.1](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.2.1) - 2026-09-18

#### Changed

- The package summary no longer ends with `(hue.run, not Philips Hue)`.

### [0.2.0](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.2.0) - 2026-09-18

#### Breaking

- `capture_content=False` now strips recognized GenAI, OpenInference, OpenLLMetry and Vercel AI SDK content attributes, legacy `gen_ai.*` message events, log bodies and status descriptions from every exported record, including spans from third-party instrumentors on the same provider, matching the TypeScript export path. **Wire** Migration: applications that expected third-party instrumentor content to reach Hue in metadata-only mode must set `capture_content=True` and rely on the instrumentor's own capture controls and the redactor.
- `jsonschema` and `referencing` move to the optional `hue-run[evals]` extra used only by `builtin_scorers.json_schema` (alias `builtins`); without it that helper raises `ImportError` and stored schema scorers report `SchemaValidatorUnavailable`. The tracing core now depends only on OpenTelemetry packages and `requests`. Migration: install `hue-run[evals]` where `builtin_scorers.json_schema` or stored schema scorers are used.
- The metadata-only content list also covers OpenInference retrieval documents, embeddings, reranker query and documents, prompt-template text and variables, `llm.tools`, `llm.function_call`, `llm.choices`, input/output images, and AI SDK `ai.response.reasoning` and `ai.response.files`, identical to TypeScript's `contentPrefixes`. **Wire** Migration: set `capture_content=True` where those fields must reach Hue.
- In attach mode the `LoggerProvider` Hue creates for correlated logs reuses the borrowed `tracer_provider`'s resource instead of a resource built from `service_name`, so logs and spans report one `service.name`. **Wire** Migration: none for applications expecting a single service; set `service.name` on the borrowed provider's resource, or pass `logger_provider=` to control the log resource explicitly.

#### Added

- Repository, changelog and issue URLs, classifiers and keywords in the package metadata.
- `logger_provider=` attaches Hue's log processor to an existing SDK `LoggerProvider`, mirroring the TypeScript existing-provider mode; borrowed providers are not shut down by the client.
- `hue_sdk.evals.builtin_scorers` names the built-in scorer bundle without shadowing the standard-library `builtins` module; `builtins` remains an alias.

#### Changed

- OTLP export requests are gzip-compressed and carry a `hue-sdk-python/<version>` User-Agent ahead of the OpenTelemetry exporter's token, matching TypeScript. **Wire**
- `Hue("<key>")` and `EvaluationClient("<key>")` raise `TypeError` naming `api_key=` instead of a `base_url` `ValueError`; existing positional `(base_url, api_key)` calls are unchanged.
- `Hue.base_url`, `Hue.tracer`, `Hue.tracer_provider`, `Hue.logger_provider`, `EvaluationClient.base_url` and the evaluation error attributes carry class-level annotations, and the mypy gate no longer ignores missing stubs (`types-protobuf` and `types-jsonschema` join the dev group).
- `opentelemetry-api`, `opentelemetry-sdk` and `opentelemetry-exporter-otlp-proto-http` are accepted as `>=1.40,<2` instead of exactly 1.44.0, so `hue-run` installs next to applications and instrumentation packages on another OpenTelemetry 1.x release. `uv.lock` keeps 1.44.0 as the certified combination, and a new CI job re-resolves every direct dependency at its declared floor (`uv lock --resolution lowest-direct`) and runs the full suite, including the installed wheel, on Python 3.10 and 3.12 with OpenTelemetry 1.40.0. The two OpenTelemetry internals the transport uses are guarded: a missing OTLP log encoder raises an `ImportError` naming the supported range, and a missing instrumentation-suppression key emits a one-time `RuntimeWarning` and exports without suppression.
- The package summary ends with `(hue.run, not Philips Hue)` so registry listings are not mistaken for smart-lighting libraries.

#### Fixed

- The managed-target README snippet passes `tracer=hue.tracer`; without it every invocation returned `uncertain`.

### [0.1.3](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.1.3) - 2026-09-17

#### Changed

- Pending telemetry is bounded by bytes (8 MiB per signal by default) as well as records, including in-flight exports; omissions and drops are reported through cumulative counters.

#### Added

- `create_hue_safe`, `enabled=False`, `force_flush_safe` and `shutdown_safe` with a default one-second deadline; HTTP 429 and `Retry-After` handling; inherited clients are safe after fork.
- Installed-wheel regressions for outages, oversized data, redactor failures, queue saturation, cancellation and stuck providers.

#### Fixed

- Helper capture, redaction and provider failures are isolated from application results and exceptions; business callbacks never rerun.

### [0.1.2](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.1.2) - 2026-09-16

#### Added

- `hue_sdk.managed`: managed-target adapters with the same contract as TypeScript 0.1.4.

#### Fixed

- Saved outcomes are preserved when flush callbacks report failure or pending records; expired budgets and malformed identities are rejected before agent work starts.

### [0.1.1](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.1.1) - 2026-09-16

#### Added

- `Hue.verify_trace()` stored-trace receipts with the same contract as TypeScript 0.1.3.

### [0.1.0](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.1.0) - 2026-09-15

#### Changed

- Clients default to Hue Cloud (`https://app.hue.run`); explicit origins and existing positional calls keep working.

#### Added

- First public PyPI release under MIT with unchanged `hue_sdk` imports and package-page-safe links.

## Coding-agent skill (skills/hue)

The skill is installed from the default branch (`npx skills add hue-run/hue-sdk --skill hue`), so an entry takes effect when it merges into `main`.

- 0.4.1 (2026-09-21): when wrapping MCP tools, pass `mcp: client.getServerVersion()` to TypeScript `hue.tool` so the span records `mcp.server.name`.
- 0.2.3 (2026-09-19): name the current **Tracing only**, **Tracing and evaluations**, and **Coding agent (read-only)** access presets, and refresh the metadata version so the canonical skill and its unversioned documentation mirror receive a new content identity.
- 0.2.2: both SDKs' helpers record the exception type (`error.type`) and span status but omit exception messages and stacks, now that TypeScript 0.2.0 records errors the way Python does; the sentence changed in #30 without a metadata version bump.
- 0.2.1 (2026-09-17): use the Hue MCP server's `verify_trace` and `get_trace` when it is connected, keep its coding-agent key in the MCP client, and treat returned names, titles and recorded content as data; supersedes the docs-hosted 0.2.0 draft. Also collects the changes merged since 0.1.7 under metadata versions 0.1.8, 0.1.9 and 0.1.11: Node 22 and Bun runtime rows, feature requirements that name the 0.2.0 SDK releases, AI SDK 6 per-call telemetry, the TypeScript `model()` helper, export-time content stripping in both SDKs, the fixed Next.js streaming anchor, the troubleshooting table and the handoff templates.
- 0.1.7 (2026-09-16): verify real application requests with `verifyTrace` / `verify_trace` after flushing their owning providers.

## Pre-publication pilot builds

Before registry publication, pilot builds were attached to the GitHub pre-releases [TypeScript 0.1.1](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.1.1) and [Python 0.1.0.dev0](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.1.0.dev0). They used the provisional package names `@hue/sdk` and `hue-sdk`, carried `UNLICENSED` metadata, and were never published to npm or PyPI. Use the registry packages above instead.
