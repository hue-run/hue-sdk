# Third-party notices

The Hue SDKs are MIT-licensed (see [LICENSE](LICENSE)). They depend on the following third-party
software, which keeps its own license. Transitive dependencies are recorded in
`packages/sdk-typescript/bun.lock` and `packages/sdk-python/uv.lock`.

## Runtime dependencies of the tracing core

| Package | License | Used by |
| --- | --- | --- |
| `@opentelemetry/*` (API, core, resources, SDK trace, SDK logs, OTLP exporter base, OTLP transformer, API logs) | Apache-2.0 | `@hue-run/sdk` |
| `opentelemetry-api`, `opentelemetry-sdk`, `opentelemetry-exporter-otlp-proto-http` and their transitives | Apache-2.0 | `hue-run` |
| `requests` (with `certifi` under MPL-2.0, `urllib3`, `charset-normalizer`, `idna`) | Apache-2.0 / MPL-2.0 / MIT / BSD-3-Clause | `hue-run` |

## Setup integration

The setup CLI additionally uses `@babel/parser` (MIT) for static JavaScript/TypeScript
syntax inspection. Generated Express bootstrap integrations explicitly install
`@opentelemetry/api` and `@opentelemetry/context-async-hooks` (Apache-2.0); the tracing
core does not register a global context manager.

## Optional dependencies for evaluations

| Package | License | Used by |
| --- | --- | --- |
| `zod` | MIT | `@hue-run/sdk/evals` and `hue eval`; optional peer dependency from 0.2.0, regular dependency from 0.16.0 |
| `ajv` (with `fast-uri` under BSD-3-Clause, `fast-deep-equal`, `json-schema-traverse`, `require-from-string`) | MIT | `@hue-run/sdk/evals`; regular dependency in 0.1.x, optional peer dependency from 0.2.0 |
| `jsonschema`, `referencing`, `jsonschema-specifications`, `rpds-py`, `attrs` | MIT | `hue-run[evals]` |

## Test material

`packages/sdk-typescript/tests/fixtures/otlp-schema.json` is generated from the
[OpenTelemetry protobuf definitions](https://github.com/open-telemetry/opentelemetry-proto) (Apache-2.0).
The license is included next to it and the fixture is excluded from published packages.

## Coding-agent tooling

These files guide coding agents working in this repository. They are not part of the published packages.

| Path | Source | License |
| --- | --- | --- |
| `.agents/skills/{create-verification-skill,maintain-verification-skill,principle-prove-it-works,technical-writing,unslop}/` | [pstack](https://github.com/cursor/plugins/tree/d73344bee8cf22e53b9d5f4cf5749d38ba38c174/pstack) at `d73344b`, unmodified | MIT (Lauren Tan), `LICENSE` in each directory |
| `.cursor/rules/ponytail.mdc`; `ponytail@ponytail` plugin enabled in `.claude/settings.json` | [ponytail](https://github.com/DietrichGebert/ponytail) `v5.1.0` (`9cc65d0`), rule unmodified | MIT (DietrichGebert), `.cursor/rules/ponytail.LICENSE` |
