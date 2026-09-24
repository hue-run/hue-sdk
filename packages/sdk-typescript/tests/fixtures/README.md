# OTLP test decoder provenance

`otlp-schema.json` is the complete protobufjs descriptor generated from the official
[OpenTelemetry protobuf v1.11.0](https://github.com/open-telemetry/opentelemetry-proto/tree/v1.11.0)
common, resource, trace, logs and collector trace/log service definitions. It is the
same descriptor used by Hue's telemetry protocol compatibility suite. It is test
material, excluded from the published package's `files` list. The Apache-2.0 license
is included alongside it. This fixture decodes actual HTTP requests from official
OpenTelemetry exporters; it does not fabricate the exported bytes.

# Hosted tool call fixture

`hosted-tool-calls.json` is synthetic: an OpenAI Responses request/response pair with a hosted MCP
server (`mcp_list_tools`, a successful and a failed `mcp_call`), built-in tool calls and an
approval request, and an Anthropic Messages pair with `server_tool_use` and `mcp_tool_use` blocks
and their results, including an error. Credentials are placeholders. The Python suite records this
fixture through its hosted-call recorder; the TypeScript suite keeps it as shared fixture material
while exercising its parser limits directly.

# Tool-definition digest fixture

`tool-definitions.json` is synthetic: a hosted MCP provider tool with placeholder credentials,
function tools in the AI SDK and Chat Completions shapes, and an unnamed built-in tool. Its
numbers, strings and keys exercise RFC 8785 canonicalization (floats, a large integer, negative
zero, U+2028/U+2029 and non-ASCII keys). `names` and `sha256` are the `hue.tool.names` and `hue.tool.definitions.sha256`
both SDKs must derive from `definitions`; the Python suite reads the same file.
# Tool-definition digest fixture

`tool-definitions.json` is synthetic: a hosted MCP provider tool with placeholder credentials,
function tools in the AI SDK and Chat Completions shapes, and an unnamed built-in tool. Its
numbers, strings and keys exercise RFC 8785 canonicalization (floats, a large integer, negative
zero, U+2028/U+2029 and non-ASCII keys). `names` and `sha256` are the `hue.tool.names` and `hue.tool.definitions.sha256`
both SDKs must derive from `definitions`; the Python suite reads the same file.
