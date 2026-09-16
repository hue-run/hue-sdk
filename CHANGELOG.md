# Changelog

## TypeScript 0.1.4 / Python 0.1.2 — unreleased

- Add TypeScript and Python managed-target adapters with scoped execution claims, verified file bytes, existing-provider trace context, idempotent outcomes and telemetry acknowledgements.

## TypeScript 0.1.3 / Python 0.1.1 — unreleased

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
