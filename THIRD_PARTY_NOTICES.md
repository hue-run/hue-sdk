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

## Optional dependencies for JSON Schema scoring

| Package | License | Used by |
| --- | --- | --- |
| `ajv` (with `fast-uri` under BSD-3-Clause, `fast-deep-equal`, `json-schema-traverse`, `require-from-string`) | MIT | `@hue-run/sdk/evals`, optional peer dependency |
| `jsonschema`, `referencing`, `jsonschema-specifications`, `rpds-py`, `attrs` | MIT | `hue-run[evals]` |

## Test material

`packages/sdk-typescript/tests/fixtures/otlp-schema.json` is generated from the
[OpenTelemetry protobuf definitions](https://github.com/open-telemetry/opentelemetry-proto) (Apache-2.0).
The license is included next to it and the fixture is excluded from published packages.
