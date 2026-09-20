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
| `zod` | MIT | `@hue-run/sdk/evals`; optional peer dependency from 0.2.0 |
| `ajv` (with `fast-uri` under BSD-3-Clause, `fast-deep-equal`, `json-schema-traverse`, `require-from-string`) | MIT | `@hue-run/sdk/evals`; regular dependency in 0.1.x, optional peer dependency from 0.2.0 |
| `jsonschema`, `referencing`, `jsonschema-specifications`, `rpds-py`, `attrs` | MIT | `hue-run[evals]` |

## Test material

`packages/sdk-typescript/tests/fixtures/otlp-schema.json` is generated from the
[OpenTelemetry protobuf definitions](https://github.com/open-telemetry/opentelemetry-proto) (Apache-2.0).
The license is included next to it and the fixture is excluded from published packages.
