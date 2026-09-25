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

# Provider error text fixture

`provider-error-text.json` is synthetic: error messages a hosted MCP call can report, each with
the text both SDKs export as the failed span's status description under content capture once
credentials are scrubbed (URL userinfo, query values and fragments, quoted query values included;
a URL with another scheme than `http(s)`, `ws(s)` or `ftp` replaced whole when it has an `@`, `?`
or `#`; tokens with a known credential prefix; authorization-scheme credentials and an
`Authorization` header's whole value; credential-named `key=value` and `key: value` pairs, quoted,
backslash-escaped or bare, and a pair inside another pair's value) and the text bounded, and
texts that must stay as they are. Credentials are placeholders. The Python suite reads the same
file.

# Provider tool listing digest fixture

`provider-tool-listing.json` is synthetic: an OpenAI `mcp_list_tools` item whose tools have null
fields, with the `hue.tool.names` and `hue.tool.definitions.sha256` both SDKs must derive from the
definitions they record for it. The Python suite reads the same file.

# Tool-definition digest fixture

`tool-definitions.json` is synthetic: a hosted MCP provider tool with placeholder credentials,
function tools in the AI SDK and Chat Completions shapes, and an unnamed built-in tool. Its
numbers, strings and keys exercise RFC 8785 canonicalization (floats, a large integer, negative
zero, U+2028/U+2029 and non-ASCII keys). `names` and `sha256` are the `hue.tool.names` and `hue.tool.definitions.sha256`
both SDKs must derive from `definitions`; the Python suite reads the same file.

`tool-definition-urls.json` holds URLs a hosted tool definition can carry, each with the text
the TypeScript SDK exports once userinfo, query values and the fragment are removed: WHATWG `URL`
serialization of IDN hosts, percent-encoding, dot segments, default ports, trailing dots, IPv4
and IPv6 forms, and URLs it refuses. `sha256` is the catalog digest of one `mcp` definition per
URL; `bigInteger` is a definition whose integer is longer than CPython's `int()` digit limit.
Both suites check the file. It was generated from the TypeScript SDK under Bun, and Node gives
the same text for every URL in it.

# Inline file digest fixture

`inline-file-digests.json` is synthetic: large `blob` and AI SDK 6 `file` parts whose content
is a unit repeated `times` between a prefix and a suffix. `expected` is the `sha256` and `size`
both SDKs must export in place of the content, computed from the bytes each case was built from
rather than by decoding it, or `null` where the file's bytes fit in 64 KiB and the part stays
inline. It covers base64 content under text, JSON, image and absent media types, `data:` URLs
with `;base64` before or after another parameter, a percent-escaped `data:` URL, a text file's
own text, base64 characters before a final newline, `data:` URLs whose data does not decode,
which are hashed as their text, a `data:` URL with millions of parameters, and text and a
percent-escaped `data:` URL with a lone surrogate, which both SDKs write as U+FFFD. Both suites
check the file.
