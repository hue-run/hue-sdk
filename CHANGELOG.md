# Changelog

## TypeScript 0.1.5 / Python 0.1.3 — unreleased

- Isolate helper capture, redaction and provider failures from application results/errors; never rerun business callbacks.
- Add disabled clients, safe initialization and nonthrowing lifecycle calls with a default one-second caller deadline, retaining strict diagnostic APIs.
- Bound pending telemetry by bytes and records, including in-flight exports, and report omissions/drops through cumulative health counters.
- Bound transport work and acknowledgements; isolate rejected TypeScript diagnostics, handle Python 429/Retry-After, and make inherited Python clients safe after fork.
- Allow TypeScript core installation alongside AI SDK 6 while retaining the AI SDK 7 adapter requirement.
- Add installed-package regressions for outages, oversized data, redactor failures, queue saturation, cancellation, stuck providers and trickling responses.

## TypeScript 0.1.4 / Python 0.1.2 — 2026-09-16

- Add TypeScript and Python managed-target adapters with scoped execution claims, verified file bytes, existing-provider trace context, idempotent outcomes and telemetry acknowledgements.
- Preserve saved outcomes when flush callbacks report failure or pending records, and reject expired callback budgets and malformed trace/file identities before starting agent work.

## TypeScript 0.1.3 / Python 0.1.1 — 2026-09-16

- Verify persisted application traces by OpenTelemetry trace ID, expected span IDs, and required field presence using bounded, authenticated receipt requests.
- Keep export acknowledgement, stored evidence, and content inspection distinct; report incomplete receipts and safe authentication/transport failures.
- Update the maintained coding-agent skill to verify real application requests after flushing their owning providers.

## Python 0.1.0 — 2026-09-15

- Publish `hue-run` to PyPI under MIT, with verified release artifacts and unchanged `hue_sdk` imports.
- Default Python clients to Hue Cloud while preserving explicit origins and existing positional calls.
- Use package-page-safe links and consistent Python installation examples.

## TypeScript 0.1.2 — 2026-09-15

- Publish `@hue-run/sdk` to npm under MIT, including the core, AI SDK, and evaluation entry points.
- Expose hosted-judge authentication and charge-reconciliation metadata in TypeScript declarations.
- Document the tested runtime and integration matrix, including dependency-resolution and cross-language content/delivery boundaries.
- Verify release archives and registry bytes, and document npm/PyPI publication and installation checks.

## Private pilot releases

The available archives are [TypeScript 0.1.1](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.1.1) and [Python 0.1.0.dev0](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.1.0.dev0). They provide OpenTelemetry tracing and local evaluations with frozen datasets, resumable uploads and historical rescoring. Access requires repository permission; these are not npm or PyPI releases.
