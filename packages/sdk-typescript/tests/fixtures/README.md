# OTLP test decoder provenance

`otlp-schema.json` is the complete protobufjs descriptor generated from the official
[OpenTelemetry protobuf v1.11.0](https://github.com/open-telemetry/opentelemetry-proto/tree/v1.11.0)
common, resource, trace, logs and collector trace/log service definitions. It is the
same descriptor used by Hue's telemetry protocol compatibility suite. It is test
material, excluded from the published package's `files` list. The Apache-2.0 license
is included alongside it. This fixture decodes actual HTTP requests from official
OpenTelemetry exporters; it does not fabricate the exported bytes.

`capture-localhost-cert.pem` and `capture-localhost-key.pem` are public, synthetic localhost-only
TLS test material. They carry no account access. Isolated installed-package checks trust this
certificate explicitly; production TLS verification remains enabled. Capture and Scenario JSON
fixtures contain invented inboxes, identities and source text only.
