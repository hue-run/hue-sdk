# Changelog

Both packages follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the pre-1.0 rules in
[VERSIONING.md](./VERSIONING.md): a `0.MINOR` release may contain **Breaking** entries with migration
notes; a patch release adds or fixes without changing capture semantics, default budgets or the wire
format. Entries marked **Wire** change emitted attributes, events or endpoints. The release workflow
refuses to publish a version without a matching entry below.

## @hue-run/sdk (TypeScript)

### Unreleased

#### Breaking

- `ajv` is an optional peer dependency used only by `builtins.jsonSchema`; without it that scorer reports `SchemaValidatorUnavailable` instead of validating. The tracing core now depends only on `@opentelemetry/*` packages. Migration: run `npm install ajv` (8.17 or later) in projects that use `builtins.jsonSchema` or stored schema scorers.
- Export requests use explicit configuration only: `OTEL_EXPORTER_OTLP_*` environment variables no longer reach Hue's endpoint, and requests carry a `hue-sdk-typescript/<version>` User-Agent. **Wire** Migration: none for documented configuration; headers or endpoints that reached Hue through those variables were unintended and have no replacement.
- `hue.tool()` spans are named `execute_tool {name}` (`gen_ai.tool.name` keeps the bare name), matching the Python SDK and the GenAI semantic conventions. **Wire** Migration: match tool spans on `gen_ai.tool.name` or the `execute_tool ` prefix instead of the bare span name.
- Failed helper spans carry `error.type` (the error's `name`), an ERROR status without a description and an `exception` event with only `exception.type`; exception messages and stack traces are no longer recorded even with `captureContent: true`, matching the Python SDK. **Wire** Migration: group error dashboards on `error.type` and keep stack traces in application logs.

#### Added

- `./package.json` export, `sideEffects` metadata, `bugs` and `keywords` in the package manifest.
- `hue.model(model, callback, options)` creates a GenAI client span for a direct provider call, taking the callback before its options like `withSpan`; `options` carries `provider`, `operation` and `name` plus `sessionId`, `userId`, `input` (recorded as `gen_ai.input.messages`) and `parentContext`. `HueSpan.setUsage()` records validated token counts, matching the Python helpers.
- `hue.inject()` / `hue.extract()` carry W3C trace context between processes without baggage or credentials.
- `hueExperimentalTelemetry(hue)` from the core entry point for AI SDK 6 `experimental_telemetry`; `hueTelemetry` remains AI SDK 7 only.
- `contentPrefixes` exports the attribute keys removed in metadata-only mode.
- Bun 1.4.2 runs the installed-package behavioral suite and the reference chatbot in package verification, and `bun pm pack` must agree with `npm pack` on package contents.
- `require("@hue-run/sdk")` and the other entry points work from CommonJS on Node.js 22.12 or later: every `exports` entry carries a `default` condition and the build has no top-level `await`; package verification exercises the `require()` path.

#### Changed

- The instrumentation scope version and export User-Agent come from a literal generated from `package.json` at build time; nothing reads `package.json` at import time, so bundled deployments are unaffected.
- `engines.node` is `>=22.12`; Node 22 and 24 are tested and Node 26 runs in CI.
- npm releases carry provenance attestations; the release workflow refuses to publish from a private source repository.
- `createHue({ enabled: false })` no longer requires `captureContent`; a disabled client defaults it to `false`.
- Export requests are sized from each record's own encoding and encoded once when sent, instead of re-encoding the growing batch for every record; the 1 MiB request split and oversized-record reporting are unchanged.

#### Fixed

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

#### Breaking

- `capture_content=False` now strips recognized GenAI, OpenInference, OpenLLMetry and Vercel AI SDK content attributes, legacy `gen_ai.*` message events, log bodies and status descriptions from every exported record, including spans from third-party instrumentors on the same provider, matching the TypeScript export path. **Wire** Migration: applications that expected third-party instrumentor content to reach Hue in metadata-only mode must set `capture_content=True` and rely on the instrumentor's own capture controls and the redactor.
- `jsonschema` and `referencing` move to the optional `hue-run[evals]` extra used only by `builtins.json_schema`; without it that helper raises `ImportError` and stored schema scorers report `SchemaValidatorUnavailable`. The tracing core now depends only on OpenTelemetry packages and `requests`. Migration: install `hue-run[evals]` where `builtins.json_schema` or stored schema scorers are used.

#### Added

- Repository, changelog and issue URLs, classifiers and keywords in the package metadata.

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

- 0.2.1 (unreleased): use the Hue MCP server's `verify_trace` and `get_trace` when it is connected, keep its coding-agent key in the MCP client, and treat returned names, titles and recorded content as data; supersedes the docs-hosted 0.2.0 draft.
- 0.1.11 (unreleased): Node 22 and Bun runtime rows; feature requirements name the 0.2.0 releases.
- 0.1.9 (unreleased): AI SDK 6 per-call telemetry, TypeScript `model()` helper and export-time content stripping in both SDKs.
- 0.1.8 (unreleased): fixed Next.js streaming anchor, troubleshooting table and handoff templates.
- 0.1.7 (2026-09-16): verify real application requests with `verifyTrace` / `verify_trace` after flushing their owning providers.

## Pre-publication pilot builds

Before registry publication, pilot builds were attached to the GitHub pre-releases [TypeScript 0.1.1](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.1.1) and [Python 0.1.0.dev0](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.1.0.dev0). They used the provisional package names `@hue/sdk` and `hue-sdk`, carried `UNLICENSED` metadata, and were never published to npm or PyPI. Use the registry packages above instead.
