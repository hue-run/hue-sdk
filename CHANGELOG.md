# Changelog

Both packages follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the pre-1.0 rules in
[VERSIONING.md](./VERSIONING.md): a `0.MINOR` release may contain **Breaking** entries with migration
notes; a patch release adds or fixes without changing capture semantics, default budgets or the wire
format. Entries marked **Wire** change emitted attributes, events or endpoints. The release workflow
refuses to publish a version without a matching entry below.

## @hue-run/sdk (TypeScript)

### Unreleased

#### Added

- `hue.model()` creates a GenAI client span for a direct provider call, and `HueSpan.setUsage()` records validated token counts, matching the Python helpers.
- `hue.inject()` / `hue.extract()` carry W3C trace context between processes without baggage or credentials.
- `hueExperimentalTelemetry(hue)` from the core entry point for AI SDK 6 `experimental_telemetry`; `hueTelemetry` remains AI SDK 7 only.
- `contentPrefixes` exports the attribute keys removed in metadata-only mode.

#### Changed

- Export requests use explicit configuration only: `OTEL_EXPORTER_OTLP_*` environment variables no longer reach Hue's endpoint, and requests carry a `hue-sdk-typescript/<version>` User-Agent. **Wire**
- The instrumentation scope version is read from `package.json` instead of a hand-maintained literal.
- `ajv` is an optional peer dependency used only by `builtins.jsonSchema`; without it that scorer reports `SchemaValidatorUnavailable`. The tracing core now depends only on `@opentelemetry/*` packages.
- npm releases carry provenance attestations now that the source repository is public.

- `./package.json` export, `sideEffects` metadata, `bugs` and `keywords` in the package manifest.

#### Fixed

- The managed-target README snippet passes `tracer: hue.tracer`; without it every invocation returned `uncertain`.

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

#### Changed

- `capture_content=False` now strips recognized GenAI, OpenInference, OpenLLMetry and Vercel AI SDK content attributes, legacy `gen_ai.*` message events, log bodies and status descriptions from every exported record, including spans from third-party instrumentors on the same provider, matching the TypeScript export path. **Wire**
- `jsonschema` and `referencing` move to the optional `hue-run[evals]` extra used only by `builtins.json_schema`; without it that helper raises `ImportError` and stored schema scorers report `SchemaValidatorUnavailable`. The tracing core now depends only on OpenTelemetry packages and `requests`.

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

- 0.1.9 (unreleased): AI SDK 6 per-call telemetry, TypeScript `model()` helper and export-time content stripping in both SDKs.
- 0.1.8 (unreleased): fixed Next.js streaming anchor, troubleshooting table and handoff templates.
- 0.1.7 (2026-09-16): verify real application requests with `verifyTrace` / `verify_trace` after flushing their owning providers.

## Pre-publication pilot builds

Before registry publication, pilot builds were attached to the GitHub pre-releases [TypeScript 0.1.1](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.1.1) and [Python 0.1.0.dev0](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.1.0.dev0). They used the provisional package names `@hue/sdk` and `hue-sdk`, carried `UNLICENSED` metadata, and were never published to npm or PyPI. Use the registry packages above instead.
