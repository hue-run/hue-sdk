# OTLP test decoder provenance

`otlp-schema.json` is the complete protobufjs descriptor generated from the official
[OpenTelemetry protobuf v1.11.0](https://github.com/open-telemetry/opentelemetry-proto/tree/v1.11.0)
common, resource, trace, logs and collector trace/log service definitions. It is the
same descriptor used by Hue's telemetry protocol compatibility suite. It is test
material, excluded from the published package's `files` list. The Apache-2.0 license
is included alongside it. This fixture decodes actual HTTP requests from official
OpenTelemetry exporters; it does not fabricate the exported bytes.

## Capture upload TLS fixture

`capture-localhost-cert.pem` and `capture-localhost-key.pem` are synthetic test-only material
for an HTTPS receiver bound to `127.0.0.1`. They are not production credentials and grant no
access to any Hue service. The installed-package verifier trusts this certificate only in its
isolated capture-acceptance subprocess through `NODE_EXTRA_CA_CERTS`; TLS verification remains
enabled. The files are excluded from published package contents.
