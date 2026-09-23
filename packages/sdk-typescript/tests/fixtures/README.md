# OTLP test decoder provenance

`otlp-schema.json` is the complete protobufjs descriptor generated from the official
[OpenTelemetry protobuf v1.11.0](https://github.com/open-telemetry/opentelemetry-proto/tree/v1.11.0)
common, resource, trace, logs and collector trace/log service definitions. It is the
same descriptor used by Hue's telemetry protocol compatibility suite. It is test
material, excluded from the published package's `files` list. The Apache-2.0 license
is included alongside it. This fixture decodes actual HTTP requests from official
OpenTelemetry exporters; it does not fabricate the exported bytes.

# Tool-definition digest fixture

`tool-definitions.json` is synthetic: a hosted MCP provider tool with placeholder credentials,
function tools in the AI SDK and Chat Completions shapes, and an unnamed built-in tool. Its
numbers and keys exercise RFC 8785 canonicalization (floats, a large integer, negative zero and
non-ASCII keys). `names` and `sha256` are the `hue.tool.names` and `hue.tool.definitions.sha256`
both SDKs must derive from `definitions`; the Python suite reads the same file.
