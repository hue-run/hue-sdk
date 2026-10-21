<p align="center">
  <img alt="Hue" src="https://raw.githubusercontent.com/hue-run/hue-sdk/df0443f98c6096ff331fd0400715e4f3a1936607/.github/assets/hue-ascii-neutral.png" width="720">
</p>

# Hue TypeScript SDK

[![npm](https://img.shields.io/npm/v/%40hue-run%2Fsdk?label=%40hue-run%2Fsdk)](https://www.npmjs.com/package/@hue-run/sdk) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

A client for Hue's standard OTLP HTTP endpoints on Node.js 22 or 24 and Bun 1.4.2. It uses the
OpenTelemetry JavaScript SDK and official OTLP protobuf exporter components for
traces and correlated logs. The package is named `@hue-run/sdk`.

[Documentation](https://docs.hue.run) · [Sign in](https://app.hue.run)

## Install

```bash
npm install @hue-run/sdk
```

Or with Bun:

```bash
bun add @hue-run/sdk
```

Run the command in your application's server package. The package is ESM; CommonJS applications on
Node.js 22.12 or later load it with `require("@hue-run/sdk")`. See the [compatibility guide](https://docs.hue.run/sdks/compatibility) before adding Hue to an application with existing OpenTelemetry or AI SDK dependencies.

## Start

```ts
import { createHue, HueExportError } from "@hue-run/sdk";

const hue = createHue({
  apiKey: process.env.HUE_API_KEY!, // a project service key, on the server only
  serviceName: "my-agent",
  captureContent: true, // Also works with older releases; false sends metadata only
  onExportIssue: (issue) => console.error(issue), // sanitized counts, never server bodies
});

await hue.checkConnection(); // GET /api/v1/projects/current
await hue.withSpan(
  "chat",
  async (span) => {
    const output = await hue.tool("uppercase", "hello", () => "hello".toUpperCase());
    span.setOutput(output);
  },
  { sessionId: "session-123", userId: "user-123", input: "hello" },
);

try {
  await hue.flush(); // await both traces and logs; don't discard this promise
} catch (error) {
  if (error instanceof HueExportError) console.error(error.issues, error.report);
}
await hue.shutdown(); // flushes and releases providers owned by this client
```

Starting with TypeScript 0.14.0, `captureContent` defaults to `true`. Earlier releases require an explicit choice. The example sets `true`: trace inspection,
evaluations and judges read the prompts, responses and tool inputs/outputs it records. Choose
`false` for metadata only when a policy forbids sending that content; see
[Privacy and content](#privacy-and-content).

The default destination is `https://app.hue.run`. Data goes to
`/api/v1/otlp/v1/traces` and `/api/v1/otlp/v1/logs` with a Bearer project key.
Set `baseUrl` only for another Hue deployment. It must be an origin without an API path; a trailing slash is accepted.
HTTPS is required except for loopback HTTP or the explicit
[`allowInsecureHttp`](#local-development-without-a-hue-account) opt-in. Redirects are refused for both
project checks and exports.

The setup CLI shipped in TypeScript `0.4.0` also prepares the `hue` executable. The unreleased
`npx --yes @hue-run/sdk@latest setup --agent` path supports Express with npm, Express with Bun, and
Flask with uv in one application package with an unambiguous entrypoint and existing GET route. It
installs the runtime, wires the application, makes one request and verifies that request's exact
trace/span receipt. Unsupported or ambiguous repositories receive a structured action. Technical
preflight checks availability and presents the published [privacy notice](https://hue.run/privacy)
and [security information](https://trust.hue.run/) before telemetry. Anonymous trials last 24 hours
and are limited to 100 traces, 1,000 spans and 2 MiB. A private owner-only browser handoff supports
account linkage; the original request evidence is retained and business work is never replayed on
claim. Setup never enables content capture or creates a simulation, Hue Run, evaluation, source capture
or remote execution. See the [setup CLI contract](./CLI.md) for the supported shapes and release gates.

For an existing account, `hue mcp install --client claude-code` (or `codex`, `conductor`,
`cursor`, `vscode`, `windsurf`, `gemini`) writes the Hue MCP configuration. For Claude Code, Codex,
Conductor and Cursor it holds only the URL, and you sign in with Hue in the client; for the other
clients, `--read-only` and `--auth key` it references `HUE_MCP_KEY` (VS Code prompts for the key).
`hue login` validates keys created in Hue Settings and stores them in `.env.hue` without printing
them. See [Store project keys](./CLI.md#store-project-keys) and
[Install the MCP for your coding agent](./CLI.md#install-the-mcp-for-your-coding-agent).

`checkConnection()` rejects with `HueConnectionError`: its fixed message is safe to log, `status`
carries the HTTP status when Hue answered, and `cause` carries the underlying network, timeout or
parsing error. `serviceVersion` and `resourceAttributes` (for example
`{ "deployment.environment.name": "production", "service.namespace": "agents" }`) describe the
deployment; a client that owns its providers merges them into its resource, with `serviceName`
and `serviceVersion` taking precedence over same-named keys.

## Model spans without a framework adapter

When you call a provider SDK directly, `hue.model()` creates the GenAI client span for the call.
Inside it, `setInput` and `setOutput` record `gen_ai.input.messages` / `gen_ai.output.messages`
when `captureContent` is true. Those attributes carry the OpenTelemetry GenAI message shape
(`{ role, parts: [{ type: "text", content }] }`, with `finish_reason` on output messages) defined
by the semantic conventions'
[input messages](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/gen-ai-input-messages.json)
and
[output messages](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/gen-ai-output-messages.json)
JSON schemas. GenAI conventions are in Development; Hue supports the fields described here
and accepts caller-supplied JSON without validating the full draft. Convert provider-native
messages before recording them:

```ts
await hue.model(
  "gpt-5-mini",
  async (span) => {
    span.setInput(
      messages.map((message) => ({
        role: message.role,
        parts: [{ type: "text", content: message.content }],
      })),
    );
    const response = await openai.chat.completions.create({ model: "gpt-5-mini", messages });
    span.setOutput(
      response.choices.map((choice) => ({
        role: choice.message.role,
        parts: [{ type: "text", content: choice.message.content ?? "" }],
        finish_reason: choice.finish_reason,
      })),
    );
    span.setUsage({
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
    });
    return response;
  },
  { provider: "openai" },
);
```

Tools the provider runs itself, such as OpenAI hosted MCP, web search, file search and code
interpreter, or Anthropic's MCP connector and server tools, never pass through `hue.tool()`. Inside
the same `hue.model()` callback, hand the response to `hue.recordProviderToolCalls`:

```ts
await hue.model(
  "gpt-5-mini",
  async (span) => {
    const response = await openai.responses.create(request);
    span.setOutput(response.output_text);
    hue.recordProviderToolCalls(response, { request });
    return response;
  },
  { provider: "openai" },
);
```

Each OpenAI Responses `mcp_call`, `web_search_call`, `file_search_call` or `code_interpreter_call`
item, and each Anthropic `mcp_tool_use` or `server_tool_use` block with its result, becomes an
`execute_tool {name}` child span with `gen_ai.tool.type` `extension`, `gen_ai.tool.call.id`,
`hue.tool.call.position` (the 0-based position of its item in the response: the OpenAI `output`
index or the Anthropic `content` block index, in both capture modes) and, for MCP calls,
`mcp.server.name` (the provider's label). Arguments and results follow `captureContent`; a failed
call carries `error.type` (`mcp_error`, the provider's status or error code) and ERROR status. With
`captureContent: true`, a failed OpenAI MCP call's status description is the provider's error
text, credentials scrubbed (URL userinfo, query values and fragments, or the whole URL for a scheme
other than `http(s)`, `ws(s)` and `ftp`; tokens with a known credential prefix such as `hue_sk_`,
`sk-` or `xoxb-`; authorization-scheme credentials and an `Authorization` header's whole value;
the value of a credential-named `key=value`, `key: value` or `key => value` pair, quoted, bare or
a whole `[…]` or `{…}` (to the end of the text when it does not close), a quote that does not close
on its line running to its end; a JSON or `%` escape such as `\n` or `%20` ends a word) and cut to
1,024 characters and a `…`. An `mcp_list_tools`
item becomes a `tools/list` child span with that server's `gen_ai.tool.definitions`; with
`captureContent: false` it carries only `hue.tool.names` and `hue.tool.definitions.sha256`, the
summary described below. Pass the request so each server's host is recorded as `server.address`
(only server URLs are read, never credentials; a host name keeps its underscores, as WHATWG URL
parsing does), and `servers` to record a
server's real `name`, `version`, Hue `provider` and `surface` under its label. `provider` defaults
to the enclosing `model()` call's provider (`openai` or `anthropic`). The spans have no duration of
their own: the provider ran the tools inside the model request.

The span is named `{operation} {model}` (`operation` defaults to `chat`) with
`gen_ai.operation.name`, `gen_ai.request.model` and `gen_ai.provider.name`. Like `withSpan`, the
options come after the callback and also accept `name`, `sessionId`, `userId`, `workspaceId`, `input` (recorded as
`gen_ai.input.messages`) and `parentContext`. When you send system instructions or tools separately
from the messages, pass `systemInstructions` (for example `[{ type: "text", content: instructions }]`)
and `tools` (for example `[{ type: "function", name, description, parameters }]`); they are recorded
as `gen_ai.system_instructions` and `gen_ai.tool.definitions` under the same `captureContent` rule
as the messages. `recordMessages` also accepts `systemInstructions` for its log record. `setUsage` records
nonnegative integer `gen_ai.usage.input_tokens` / `output_tokens`; other values are omitted and
counted as instrumentation failures. Unknown usage stays absent. `hue.tool(name, input, execute)`
creates an `execute_tool {name}` span with `gen_ai.tool.name`, arguments and result; an optional
fourth argument `{ callId }` records the provider's tool call id as `gen_ai.tool.call.id`. When the
tool came from an MCP server, pass `{ mcp: client.getServerVersion() }` (the MCP `initialize`
`serverInfo`) to record `mcp.server.name` and `mcp.server.version` so a generic verb such as
`get_thread` is attributed to that server. When the server is a Hue surface, `mcp.provider` and
`mcp.surface` (for example `google.gmail` and `google.gmail/mcp`) record `hue.mcp.provider` and
`hue.mcp.surface`. A blank, over-256-character or otherwise invalid label is omitted and counted as
an instrumentation failure; the tool still runs. Content
helpers (`setInput`, `setOutput`, `tool` arguments and results, `recordMessages`,
`SpanOptions.input`) accept any value and encode plain JSON data (`JsonValue`) at runtime; a value
that is not JSON, such as a `Date` or a class instance, is omitted with an instrumentation failure
while the callback result is returned unchanged.

### Tool endpoint evidence

Since TypeScript `0.21.0`, `ToolOptions` accepts an optional `endpoint`: `{ url, source, method?, captureQueryParameters? }`.
Use the actual HTTP(S) request URL, client config URL or receipt URL; set `source` to `request`,
`client_config` or `receipt`. Supply `method` only when known. With content capture enabled,
Hue records `url.full`, `hue.tool.endpoint.source` and optional `http.request.method` through the
existing redactor (`attributes.url.full` for the URL). URL userinfo and fragments are removed;
query values are omitted unless their names appear in `captureQueryParameters`. Credential names
are rejected even if allowlisted. Duplicate and empty allowed query values remain intact.

Metadata-only mode omits endpoint evidence. Invalid evidence is omitted and counted without
changing the tool's result or exception. This helper does not observe HTTP automatically or infer
account identifiers. Do not supply secret-bearing URL paths, and preserve existing masking of
account identifiers. See the [setup skill](../../skills/hue/SKILL.md#http-tool-endpoint-evidence)
for dispatcher integration and source checkout requirements.

## Images, documents and audio

Hue stores the bytes of images, documents and audio apart from the spans and log records that
mention them, under the record's trace and named by SHA-256. The record keeps the file's digest in
its place and lists the upload in its `hue.blobs` attribute. Files reach Hue in four ways:

| You have | Use | The record carries | `hue.blobs` key |
| --- | --- | --- | --- |
| Files inline in the messages and values your code or framework already records | Nothing: [automatic capture](#automatically-captured-media) | The part, in digest form | `<attribute>#<JSON pointer>` |
| A file to place at a position in a value you record | [`Attachment`](#attach-a-file-anywhere) | A GenAI `blob` part, in digest form | `<attribute>#<JSON pointer>`, or `body#<JSON pointer>` in a `recordMessages()` log record |
| A file the work read, received or produced, outside any recorded value | [`hue.recordFile`](#record-a-file) | A `hue.file` event | `event:hue.file:<sha256>` |
| Files a case's agent and scorers receive in an evaluation | [`CaseWrite.files`](#files-in-evaluation-cases) | An input file pinned on the case | None: case files are artifacts |

[`client.media`](#read-recorded-media-back) reads a recorded file back. Every upload needs
`captureContent: true` and a project key (never a setup credential, `hue_setup_…`) and follows
`redact`: nothing the redactor removes is uploaded, a value it rewrites uploads as rewritten, and an
attachment part it rewrites uploads nothing. Uploads run after the record is exported, within the
128 MiB held for values awaiting upload, and never hold up or fail the export; a file used more than
once in a trace is stored once. See [Values over the inline limit](#values-over-the-inline-limit)
for the upload protocol, budgets and fallbacks.

### Automatically captured media

With `captureContent: true` and a project key, the SDK finds the files inline in the attributes Hue
reads files from, uploads each file's bytes under the record's trace and leaves the file's digest in
its place. On a span's own attributes:

- Messages and values: `gen_ai.input.messages`, `gen_ai.output.messages`, `ai.prompt.messages`,
  the AI SDK's `ai.prompt`, `input.value` and `output.value` (what `withSpan` and OpenInference
  record), `traceloop.entity.input` and `traceloop.entity.output`, and Langfuse's
  `langfuse.observation.input`, `langfuse.observation.output`, `langfuse.trace.input` and
  `langfuse.trace.output`.
- Tool arguments and results: `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`,
  `ai.toolCall.args`, `ai.toolCall.result`, `tool.parameters`, `tool_arguments` and
  `tool_response`.
- Metadata: `metadata`, `langfuse.observation.metadata` and `langfuse.trace.metadata` (whole, or
  one `.<key>` per attribute) and `ai.telemetry.metadata.<key>`. A metadata value is read as JSON
  when it is an object or array; otherwise it is a file only when the whole value is a `data:` URL.
- Indexed messages: OpenLLMetry's `gen_ai.prompt.<n>.content` and `gen_ai.completion.<n>.content`
  when the value is the JSON of a parts list (any other content stays text), and OpenInference's
  flattened `llm.input_messages.<n>.message.contents.<m>.message_content.image.image.url` (and
  `llm.output_messages.…`), whose value is the image's URL.

Inside those values a file is found by its shape: GenAI `blob`, AI SDK `file` and `image`, OpenAI
Chat image, file and audio parts and an assistant message's `audio`, Responses `input_image`,
`input_file` and `computer_screenshot`, Anthropic base64 sources, Gemini `inlineData` and
`inline_data`, Vertex `media`, Bedrock image and document sources, and any whole string that is a
`data:` URL declaring a media type. A tool call's `arguments` and a tool result (a `tool` message's
`content`, `tool_result`, `function_call_output`, `tool_call_response`) are JSON in a string by
convention, so the files inside them are uploaded too; a message's own text is never parsed as JSON.
Hue's reader looks for files no deeper than ten levels below a value's root (an encoded string's
JSON counting as a level), and the SDK inspects no deeper. Hue keeps attribute JSON nested past 32
levels, or holding an integer past 2^53, as text, and an OpenInference `input.value` or
`output.value` whose record declares `input.mime_type` or `output.mime_type` as `text/plain` is
literal text: the SDK leaves such values as recorded. Remote URLs, provider file IDs, S3 references
and Langfuse media tokens stay unchanged, and Hue never fetches them.

Each uploaded file is listed in the record's `hue.blobs`, keyed `<attribute>#<JSON pointer>`:

- A provider part loses its byte field and carries `sha256` and `size`; the key names the part,
  for example `gen_ai.input.messages#/0/parts/1`.
- An OpenAI assistant message's `audio` loses `audio.data` and the message carries `sha256` and
  `size` (`gen_ai.output.messages#/0`). Its media type comes from `audio.format`, else from the
  bytes' WAV, MP3, AAC, FLAC or Ogg signature, else `application/octet-stream`.
- Raw 16-bit PCM keeps the format its type declares: `audio/pcm`, `audio/x-pcm` or `audio/L16`
  with a `rate` from 8000 to 192000 and 1 or 2 `channels` is listed as
  `audio/pcm;rate=24000;channels=1` (`audio/L16;…` for big-endian samples), and OpenAI `pcm16`
  audio as `audio/pcm;rate=24000;channels=1`, so Hue plays the stored file. Other types are listed
  without their parameters.
- A whole `data:` URL string becomes a GenAI `blob` part,
  `{"type":"blob","mime_type":"image/png","modality":"image","sha256":"…","size":68}`, keyed at
  the string (`input.value#/image`). A value that is entirely one, such as a metadata attribute
  or the string input or output a Langfuse SDK records as it is, becomes that part's JSON text,
  keyed `<attribute>#`: an attribute read as JSON whose text is not JSON is read as that text, as
  Hue reads it.
- A file inside a JSON-encoded tool string takes the digest form inside the string. Its key goes on
  through the string, which no JSON pointer can address, so Hue matches it by its digest.
- Text media over 64 KiB of decoded bytes in a provider part keeps a UTF-8-safe 16 KiB prefix in
  its content field instead, and its key names that field
  (`gen_ai.input.messages#/0/parts/1/content`). Smaller text and empty fields stay inline. A text
  file a GenAI `blob`, Vertex `media` or AI SDK part holds as bare base64 takes the digest form.

Only the file's own value, or the members of the part that held it, change: every other byte of the
recorded text, its key order, number spellings, escapes and spacing included, is kept, in an encoded
string as in the attribute itself, so both SDKs write the same bytes. A record has 64 `hue.blobs`
places: the media inline in its values take them first, in reading order, then its attachments and
the files recorded with `upload`.

Entries use the recorded media type and, when valid, the filename, name or title. A valid name
is nonblank after trimming, at most 256 UTF-16 code units and well-formed Unicode, with no C0
characters (U+0000–U+001F) or DEL (U+007F). Invalid names are omitted from the entry without
rewriting the original field. Data URLs and fields explicitly encoded as base64 by the provider
contract are decoded before hashing. Other content is read as Hue's reader reads it, whatever its
media type: content that reads as base64 (a length divisible by four, base64 characters only, as
the GenAI conventions and `client.media.resolve` write a `blob` or `media` part's content) is the
file's base64 and is decoded, so `YWJj` hashes as `abc`; anything else is the file's own UTF-8
text. The digest matches `hue.recordFile`'s digest for the same bytes.

A file refused when its record is exported (the receiver is known to have no upload route, uploads
were ended by shutdown, or a budget ran out) keeps its digest without an entry in the recorded
messages (`gen_ai.input.messages`, `gen_ai.output.messages`, `ai.prompt.messages`); in every other
attribute it keeps its bytes inline under the ordinary value limit. A file whose upload fails after
its record was exported keeps its digest form and its entry, which Hue reads as missing.

Log records upload their media the same way when they are correlated with a span:
`recordMessages`'s `gen_ai.client.inference.operation.details` record and any `gen_ai.*` event
with a structured body. The bytes upload under the log record's own trace and the log record lists
them in its own `hue.blobs`, keyed `body#<JSON pointer>` into the body
(`body#/gen_ai.input.messages/0/parts/1`, or `body#/content/1` for a deprecated
`gen_ai.user.message` event) or `<attribute>#<JSON pointer>` for the attributes above. One step
places a log record's files, the attachments in its body included. A body recorded as JSON text
stays as it is, and no log value is uploaded whole. A log file refused when its record is exported
is placed as log records were before they uploaded: a file over 64 KiB in a recorded message
attribute becomes its digest and any other file keeps its bytes; text still over the value limit is
cut inline and listed under `hue.truncated`. One whose upload fails afterwards keeps its digest and
its entry, as on a span. While uploads are available, `recordMessages` records a body over
the value limit when it fits the limit with its files as their digest.

Inspection is bounded to 8 Mi UTF-16 code units of text per attribute and 16 Mi per record, a log
body's file contents included. Within those bounds, inspection parses the value and decodes each
file while the record is queued and again when it is exported. A span's own attribute past either
bound that is held whole for upload (it is over the value limit) has its media read in place when
it is exported, as a voice agent's audio usually needs: each string in it longer than 16 Ki code
units and written without escapes as strict base64 or a base64 `data:` URL is decoded, hashed and
uploaded a 1 MiB window at a time from the recorded text, never parsed or copied out of it, and a
file may be up to Hue's 1 GB upload limit. The scan that finds those strings also reads the value
a window at a time, between turns of the event loop, so no step of it stalls the application for
long; a percent-escaped `data:` URL is parsed with the JSON around it. The value is placed exactly as one within the bounds: the same
digest form, entries and fallbacks. The JSON around those strings, a file written with escapes or
inside a JSON-encoded string included, is parsed within the 8 Mi bound; a value past it uses the
ordinary value limit (it uploads whole). Each such value is read within that bound on its own, apart
from the record's 16 Mi allowance, while it stays held within the 128 MiB for values awaiting
upload. Log records keep the bounds. Resources, links and span
events never upload inline media: in their recorded messages, media up to 64 KiB stays verbatim
and larger media is replaced by its digest, as in 0.16, and log records that cannot upload (not
correlated with a span, or while uploads are unavailable) keep the same rule. With
`captureContent: false`, nothing is inspected or uploaded.

### Attach a file anywhere

Wrap a file in an `Attachment` and put it anywhere in a value Hue records: a `withSpan()` input or
output, `model()` messages, a tool's arguments or result, `recordMessages()` messages or a span
attribute passed to `withSpan()`.

```ts
import { readFile } from "node:fs/promises";
import { Attachment } from "@hue-run/sdk";

const png = await readFile("scan.png");
await hue.withSpan(
  "review contract",
  (span) => {
    span.setInput({
      question: "Which clauses changed?",
      contract: new Attachment({ path: "contract.pdf", contentType: "application/pdf" }),
    });
  },
  { attributes: { metadata: { scan: new Attachment({ data: png, contentType: "image/png" }) } } },
);
```

Give exactly one of `data` (a `Buffer`, typed array, `ArrayBuffer`, or a base64 string or `data:`
URL) and `path` (a file on the file system), a `contentType` and optionally a `name`. `data` is
read and hashed when the attachment is created and is limited to 25 MiB, the `recordFile` limit:
it is held in memory from then until it is uploaded, within the 128 MiB budget for values awaiting
upload. A `path` names a regular file: anything else, such as a named pipe, is
refused without waiting on it. A `path` up to 25 MiB is read the same way. A larger regular file, up to
Hue's 1 GB upload limit, is not held: it is hashed a 1 MiB slice at a time when the attachment is
created and read again from disk when it is uploaded, each slice hashed as it is sent and the last
sent only once the file ended at the size and SHA-256 it was recorded with. Keep such a file in
place and unchanged until the client flushes: one that changed, is gone or is no longer a regular
file is not uploaded (the
request ends before its body is complete, and Hue's upload URL signs the size and SHA-256, so the
store refuses other bytes), and it counts in `report.uploadFallbacks`, its part keeping the digest
it was recorded with.

At its position the attachment is recorded as a GenAI `blob` part that names the file by digest,
`{"type":"blob","mime_type":"application/pdf","modality":"document","sha256":"<64 hex>","size":48213,"name":"contract.pdf"}`,
with `modality` read from the content type (`image`, `audio`, `video`, `document` or `file`).
Export lists the bytes under the record's `hue.blobs` and uploads them once the record is sent, keyed
`<attribute>#<JSON pointer to the part>`: `input.value#/contract` above, `metadata#/scan` for the
attribute, and `body#/gen_ai.input.messages/0/parts/1` for a part in a `recordMessages()` log
record, which uploads with the other media in the body. An attribute value that is an attachment,
a JSON object or an array OpenTelemetry cannot hold (not of one primitive type), with or without
attachments, is recorded as JSON text; put files under `metadata` for Hue to list them as the
span's metadata files.

With `captureContent: false` or a setup credential no bytes leave the process: a metadata
attribute still records the part, without its name, and content values are not recorded at all. A
part the redactor removes or rewrites is not uploaded. A part refused when its record is exported
keeps its digest without an entry, and one whose upload fails afterwards keeps its digest and its
entry; either is counted in `report.uploadFallbacks`, as is one nested more than 10 levels deep in
its value, where Hue does not read parts, or one in a value cut to the value limit. An attachment in a
value that is still over the value limit with its files as digest parts is uploaded and listed as
usual, and `client.media.fetch({ traceId, sha256 })` and Hue's span read reach it by digest; the
value itself uploads whole and keeps only its first 16 KiB inline, so readers do not place the file
at its position in the value. Creating an
attachment never throws: one without exactly one of `data` and `path`, with unreadable or larger
data or an invalid content type is recorded as `null` and counted as an instrumentation failure;
an invalid name alone is omitted and counted.

### Record a file

Record a file the work read, received or produced with `hue.recordFile`. It adds a `hue.file`
event to the active span, or to the span of an explicit context passed second. The event identifies
the file by SHA-256. Pass `upload: true` to store its bytes in Hue as well:

```ts
import { readFile } from "node:fs/promises";

await hue.withSpan("review contract", async () => {
  const pdf = await readFile("contract.pdf");
  hue.recordFile({
    role: "input", mediaType: "application/pdf", data: pdf, name: "contract.pdf", upload: true,
  });
});
```

`upload` defaults to `false`, which hashes and measures `data` locally without exporting bytes.
`data` is limited to 25 MiB, as it is held in memory until it is uploaded. Larger data is omitted
and counted as an instrumentation failure; pass `sha256` and `byteSize` when you already have them.
Give `path` instead of `data` for a file on disk: up to 25 MiB it is read as `data` is, and a larger
regular file, up to Hue's 1 GB upload limit, is hashed a slice at a time now and, with `upload`,
read again from disk when it is uploaded, as an [`Attachment`](#attach-a-file-anywhere) given by
path is: it uploads only if it still has the size and SHA-256 it was recorded with. A file over
1 GB, a path that is no regular file, or `data` and `path` together, is omitted and counted. Upload requires supplied bytes or a
path, content capture and an ordinary project key. An upload that cannot be held when the file is
recorded (a span's 65th, a receiver known to lack the upload route, or a full
[held-value budget](#values-over-the-inline-limit), which uploads not yet settled share) keeps the
event without its bytes and is counted as an upload fallback, with a warning, and as an
instrumentation failure. Export adds a `hue.blobs` entry to the same span,
keyed `event:hue.file:<sha256>`, while preserving the event, once it has fitted the span's events
and entries; the upload runs after the span is sent, four at a time with the export's other
uploads. A file whose event was redacted or shed is not uploaded.

The event carries `hue.file.sha256`, `hue.file.role` (`input`, `attachment` or `output`),
`hue.file.media_type` and `hue.file.size` in both capture modes. `hue.file.name` requires
`captureContent: true`. Names must be nonblank after trimming, contain at most 256 UTF-16 code
units, be well-formed Unicode and contain no C0 characters (U+0000–U+001F) or DEL (U+007F).
Tabs, newlines, DEL and lone surrogates make a name invalid. An invalid name is omitted and
counted as an instrumentation failure; the otherwise valid event remains. Invalid records and
records without an active span count as instrumentation failures.

### Read recorded media back

The evaluation client's `media` reads a recorded file back by its digest, with a key that may read
recorded content (**Read** or **Read and write**; a trace snapshot's copy needs **Read and write**):

```ts
import { createEvaluationClient } from "@hue-run/sdk/evals";

const client = createEvaluationClient({ apiKey: process.env.HUE_API_KEY! });

// One file by digest; pass the span that recorded it when you know it.
const file = await client.media.fetch({ traceId, spanId, sha256 });
console.log(file.contentType, file.fileName, file.size, file.bytes);

// Every digest part of a recorded value, written back in its own field.
const recorded = JSON.parse(attributes["gen_ai.input.messages"]);
const { value: messages, failures } = await client.media.resolve(recorded, { traceId, spanId });
```

`fetch` asks Hue for a five-minute download link (`GET /api/v1/traces/{traceId}/blobs/{sha256}`),
downloads it without the project key and refuses bytes whose SHA-256 is not the digest. It throws
`MediaFetchError`, whose `reason` is `not_found` (Hue holds no such file for the trace),
`missing` (the trace lists it, but it was never uploaded or has been erased), `unavailable` (still
unavailable after one retry that waits out a `Retry-After` of up to 10 seconds), `forbidden` (the
key cannot read recorded content, or reads a snapshot without **Read and write**), `too_large`
(over `maxBytes`, 64 MiB by default, checked before downloading), `digest_mismatch` or `failed` (a
connection failure, a timeout, a redirect or another unexpected answer). Hue is asked for the link
once more after a connection failure or a timeout, never after an unexpected answer; a download
ends once no byte has arrived for the client's timeout, at least two minutes, and is not retried.
`{ snapshotId, sha256 }` reads a trace snapshot's pinned copy instead
(`GET /api/v1/trace-snapshots/{snapshotId}/blobs/{sha256}`), which carries no media type or name.

`resolve` downloads each distinct digest once, four at a time (`concurrency`, up to 16), and returns
a new value; the input is not changed. With `as: "dataUrl"` (the default) each part receives a
`data:` URL where its field takes one (OpenAI `image_url` and `file_data`, Responses `input_image`,
`input_file` and `computer_screenshot`, AI SDK `image` and `file`) and bare base64 where its
convention requires it (GenAI `blob`, OpenAI `input_audio` and assistant `audio`, Anthropic
`source.data`, Gemini `inlineData`, Vertex `media`, Bedrock `source.bytes`), so the messages can be
sent to the provider again. A GenAI `blob` or Vertex `media` part receives base64 whatever its media
type, as the GenAI conventions define its content and as Hue reads content that reads as base64;
`as: "bytes"` writes a `Uint8Array`. A resolved part no longer carries `sha256` and `size`. A part
whose file cannot be read stays as it is and is listed in `failures` with its JSON pointer and
reason. Parts inside JSON-encoded strings, such as tool-call arguments, and Langfuse media tokens,
which name files Langfuse holds, are left as they are; `fetch` reads the former by the digest the
part carries.

A snapshot's copies carry no media type, so a part that declares none would get a `data:` URL of
`application/octet-stream`. Pass the record's `hue.blobs` entries in any form Hue reads (the JSON
strings the attribute holds, objects, or one string holding the JSON array), and such a part takes
the type of the entry with its SHA-256. Text over 64 KiB that a record keeps as its first 16 KiB
is never written back: a part whose content field an entry names, holding only that prefix, stays
as it is and is listed in `failures` as `prefix_only` with the entry's SHA-256, and
`fetch({ traceId, sha256 })` returns the whole file. An entry names a pointer, not a value, so the
entries of another attribute with a file at the same pointer are listed too; pass only the entries
of the value's own attribute to list its own file.

```ts
const { value } = await client.media.resolve(recorded, {
  snapshotId,
  blobs: attributes["hue.blobs"],
});
```

### Files in evaluation cases

`addCase` and `addEvalSetCase` pin up to 32 input files on a case with `files`: artifacts the
project already holds, or bytes and paths the client checks and uploads first. A case's target
receives its agent-visible files as `context.files`, and `rehydrateMedia(inputs, files)` writes
them back into the digest parts of recorded messages copied into the case, so the target can send
the recorded model call again with the real image, document or audio. See
[Case files](EVALUATIONS.md#case-files).

### Coming from Langfuse or Braintrust

| Langfuse | Braintrust | Hue |
| --- | --- | --- |
| Base64 data URIs in an observation's input, output or metadata | | [Automatic capture](#automatically-captured-media), for the attributes and shapes listed there |
| `LangfuseMedia` | `Attachment` | [`Attachment`](#attach-a-file-anywhere), at the same position |
| `LangfuseMedia` and data URIs, keeping Langfuse's SDK | | Unchanged: with Hue's processor [beside Langfuse's](#existing-opentelemetry-providers), each file uploads to Hue in the background |
| `resolveMediaReferences({ obj, resolveWith: "base64DataUri" })` | | `client.media.resolve(obj, { traceId })` |
| `GET /api/public/media/{mediaId}` | `ReadonlyAttachment.data()` | `client.media.fetch({ traceId, sha256 })` |
| Media tokens (`@@@langfuseMedia:…@@@`) | `ExternalAttachment` | Left as recorded: Hue never fetches a remote URL or a file another service holds. [`hue import langfuse --media`](#import-from-langfuse) copies Langfuse's files with your keys |

## Import from Langfuse

`hue import langfuse` copies a Langfuse project's history into Hue. It runs on your machine with
the Langfuse project's own keys (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and
`LANGFUSE_BASE_URL` or `LANGFUSE_HOST`), which go only to Langfuse, and sends the spans with your
`HUE_API_KEY`:

```sh
npx -y @hue-run/sdk@0.22.0 import langfuse --env-path .env.langfuse --from 2026-01-01 --dry-run
npx -y @hue-run/sdk@0.22.0 import langfuse --env-path .env.langfuse --from 2026-01-01 --media
```

- It reads Langfuse Cloud and self-hosted v4 through the Observations API v2, and self-hosted v3
  through the v1 traces and observations API, newest first; `--from`, `--to`, `--limit` and
  `--trace-id` select traces, and `--dry-run` counts them without sending anything.
- Each observation becomes the span a Langfuse OpenTelemetry SDK records, with the
  `langfuse.observation.*` and `langfuse.trace.*` attributes Hue reads, the user, session, release
  and environment, and the model and token counts as GenAI attributes. Hex ids are kept and other
  ids derived from them, so running the same command again resumes an import without duplicates.
- Langfuse's environment is also sent, as recorded, as `hue.import.source_environment`.
  Ended traces with a resolved user can contribute to that user's World with any environment
  value or without an environment declaration. Traces linked to Hue runs, World instances, or
  run executions never contribute. Hue's evaluation and simulation evidence and deliberately
  excluded traces also stay excluded.
- Spans are exported by the SDK's transport with its content-capture default; `--no-content`
  sends metadata only.
- With `--media`, files that Langfuse media references point to are downloaded and uploaded under
  the trace in the [digest form](#automatically-captured-media) the SDK writes, listed in
  `hue.blobs`; a reference Langfuse holds no bytes for stays as recorded.
- Langfuse's rate limits are waited out for as long as `Retry-After` asks.

The command has no Python counterpart; it runs with `npx` for an application in any language. See
[Import traces from Langfuse](CLI.md#import-traces-from-langfuse) for every option, the attribute
mapping, media handling, limits and exit codes.

## Import a bundle of existing traces

`hue traces import` brings exports you already hold into Hue in two steps, with no project key.
`prepare` converts the bundle on your machine and sends nothing; a Hue MCP connection authorizes
the delivery with `prepare_trace_import`; `upload` delivers it with that authorization:

```sh
npx -y @hue-run/sdk@latest traces import prepare ./exports --out ./exports.hue-import --json
# Call prepare_trace_import with the report's manifest_digest, totals and source, and save its
# answer (or the authorization alone) in a private file.
npx -y @hue-run/sdk@latest traces import upload ./exports.hue-import --authorization-file ./authorization.json --json
```

- Sources are files, directories or ZIP archives, gzip or zstd compressed or not, holding JSON
  documents, arrays, JSON Lines or binary OTLP. Each file is recognized by its content, never its
  name, in these formats: OTLP/JSON, OTLP protobuf and OpenTelemetry Collector file exports,
  Jaeger, Zipkin v2, Langfuse (API answers, UI downloads and blob-storage files), Braintrust span
  rows, LangSmith runs, Arize Phoenix spans, MLflow traces, Opik exports, W&B Weave calls, Datadog
  LLM Observability spans, OpenAI Agents SDK traces, Raindrop events and span rows, Helicone
  requests, ATIF v1.7 and v1.8, and OpenAI chat, OpenAI Responses and Anthropic Messages
  transcripts. One `prepare` reads up to 256 MiB decompressed; prepare a larger export in parts.
- `prepare` writes each trace as gzip OTLP/JSON batches beside a manifest. Spans of OTLP exports
  (Jaeger API v3 answers included) are kept as recorded, and Jaeger, Zipkin and Phoenix spans
  become the OTLP spans they were. Every other record becomes the GenAI spans Hue reads, with its
  model and tool calls, token usage and errors, and keeps its whole source record. Each trace's end
  user and conversation are read where the source names them, never from a tool's arguments or
  result, and a converted record carries them as `user.id` and `gen_ai.conversation.id` on the
  trace's root. `--user-key` and `--session-key` name them for an export that records them under
  keys of its own.
- The report gives the manifest's digest and totals, the traces per format, the files it could not
  read, each line or record of a file it could not read (the rest of the file is read), what it
  read with a repair (a compressed file read up to a break, `NaN` read as null) or read once though
  the input held it twice, the traces refused (a malformed record refuses only its trace), the instants filled in by a fixed rule,
  invalid vendor ids mapped to OpenTelemetry ids, and the traces without a declared history owner,
  read from the spans as Hue reads them. Nothing about a file's name or place reaches a span.
- `upload` registers the manifest, sends each trace's large values and batches in order, two
  requests at a time, checks every span's receipt, reconciles and completes the import. Interrupted,
  run it again: it resumes from `progress.json` in the bundle. An expired authorization is renewed
  by calling `prepare_trace_import` again with the same digest and totals.
- The authorization (`hue_it_…`) is read only from the file and never printed.

See [Import a bundle of existing traces](CLI.md#import-a-bundle-of-existing-traces) for how each
format is recognized and where its user and conversation come from, the report, what Hue refuses
and the exit codes.

## Sub-agents

Run a sub-agent with `hue.subagent(name, callback, options)`, inside the tool call that starts it:

```ts
const findings = await hue.tool("research", { topic }, () =>
  hue.subagent(
    "researcher",
    async () => {
      const notes = await hue.model("gpt-5-mini", () => callModel(topic), { provider: "openai" });
      return hue.tool("summarize", notes, () => summarize(notes));
    },
    { input: topic },
  ),
);
```

The sub-agent runs inside one `invoke_agent researcher` span with `gen_ai.operation.name`
`invoke_agent`, `gen_ai.agent.name` `researcher` and `hue.agent.role` `subagent`. That span is a
child of the active span, here the `execute_tool research` span, and the sub-agent's own model and
tool spans are its children, so Hue scopes them to the sub-agent. Sub-agents nest: a sub-agent's
tool can start another. The span is `INTERNAL` unless `options.kind` says otherwise; session, user
and workspace identifiers are inherited unless `options` sets them. `options.input` and the
callback's defined result are recorded as `input.value` and `output.value` when `captureContent`
is true (a callback that calls `setOutput` keeps its own output), and errors are recorded and
rethrown as in `withSpan`.

The calling agent's role is not set for you: Hue reads roles only from the spans that state them,
and the span a sub-agent starts under is usually a tool call, not the agent. To label the calling
agent, give its own span the role:

```ts
await hue.withSpan("invoke_agent planner", () => runPlanner(), {
  attributes: {
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": "planner",
    "hue.agent.role": "orchestrator",
  },
});
```

When the sub-agent runs in another process, send the caller's trace context with the request and
start the sub-agent under it:

```ts
// The calling process, inside the tool call that hands the task over.
await hue.tool("research", { topic }, async () => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  hue.inject(headers); // adds `traceparent` only
  const response = await fetch(researcherUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ topic, sessionId }),
  });
  return response.json();
});

// The sub-agent's process, for example an Express handler.
const { topic, sessionId } = req.body;
const findings = await hue.subagent("researcher", () => research(topic), {
  parentContext: hue.extract(req.headers),
  sessionId,
});
```

The `invoke_agent researcher` span then belongs to the caller's trace, with the caller's
`execute_tool research` span as its parent. `hue.extract()` reads a plain header object such as
Node's `req.headers`; pass `Object.fromEntries(request.headers)` for a Fetch `Request`. Only
`traceparent` crosses the boundary, never the API key, baggage or the session, so pass the
session identifier yourself as above. Accept `traceparent` only from your own services: whoever
sets it chooses the trace the sub-agent's spans join. On an endpoint that also serves other
callers, extract it only from authenticated internal requests and start a new trace otherwise.

## Vercel AI SDK 6

AI SDK 6 accepts a per-call tracer through `experimental_telemetry`. Pass
`hueExperimentalTelemetry(hue)` from the core entry point; the generated spans parent under
`withSpan`, inherit session/user identifiers, and record prompts and responses only when
`captureContent` is true:

```ts
import { hueExperimentalTelemetry } from "@hue-run/sdk";

const result = await generateText({
  model,
  prompt,
  experimental_telemetry: hueExperimentalTelemetry(hue),
});
```

This requires no `@ai-sdk/otel` peer. `hueTelemetry` remains AI SDK 7 only: it reads the
installed `ai` major version once per process and throws a `TypeError` below 7.

## Vercel AI SDK 7

Compatible optional peers are `ai@^7.0.0` and `@ai-sdk/otel@^1.0.0` (install `@ai-sdk/otel` with
the matching patch number, for example `ai@7.0.99` with `@ai-sdk/otel@1.0.99`; each `@ai-sdk/otel`
release depends on exactly that `ai` release), alongside
`@opentelemetry/api@1.9.1`. For an app without global AI SDK telemetry integrations,
configure telemetry on each agent or generation call:

```ts
import { ToolLoopAgent } from "ai";
import { hueTelemetry } from "@hue-run/sdk/ai-sdk";

const agent = new ToolLoopAgent({
  model: process.env.AI_MODEL!, // actual configured AI Gateway provider/model
  telemetry: hueTelemetry(hue),
});
await hue.withSpan(
  "chat",
  async (span) => {
    const result = await agent.stream({ prompt: "Hello" });
    // Consume the stream inside the span's callback so completion/error timing is correct.
    for await (const text of result.textStream) process.stdout.write(text);
    span.setOutput(await result.text);
  },
  { sessionId: "session-123" },
);
await hue.flush();
```

`hueTelemetry(hue)` supplies per-call integrations, which AI SDK 7 uses **instead of
globally registered integrations for that call**. Global registration remains intact,
but those integrations do not receive that call's events. To keep an existing
OpenTelemetry exporter, attach Hue's transport to the same provider using the
[existing-provider recipe](#existing-opentelemetry-providers).

The end user and conversation can also come from AI SDK 7's runtime context. `hueTelemetry(hue)`
records the call's `runtimeContext.userId` as `user.id`, and `runtimeContext.sessionId` (else
`threadId`) as `gen_ai.conversation.id`, on every span of the call; a value that is neither a
non-empty string nor a finite number is ignored. The returned options name those keys in `includeRuntimeContext`,
because AI SDK withholds runtime context from telemetry unless a key is named there; no other
runtime-context value is recorded. An enclosing `withSpan`'s `userId` or `sessionId` takes
precedence:

```ts
const result = await generateText({
  model,
  prompt,
  runtimeContext: { userId: user.id, sessionId: chat.id },
  telemetry: hueTelemetry(hue),
});
```

For other keys, pass `hueTelemetry(hue, { userKey: "accountId", sessionKey: ["chatId"] })`;
`false` records none from runtime context. An application that sets its own
`includeRuntimeContext` keeps these keys by spreading the returned one into it.

Reuse the client across server requests. Await stream completion before flushing;
returning a streaming `Response` does not mean its stream has finished. The
[Next.js streaming recipe](https://docs.hue.run/integrations/opentelemetry#flush-streamed-responses-in-next-js)
shows how to keep completion and flushing within the request's background lifetime.
For a standalone script, put the operation in `try` and call `await hue.shutdownSafe()`
in `finally`. Shut down a shared server client only when the application stops.

The integration creates real Vercel provider, streaming and tool spans and passes
`recordInputs` and `recordOutputs` explicitly. The installed-package verification
tests the matching 7.0.99/1.0.99, 7.0.100/1.0.100, 7.0.137/1.0.137,
7.0.138/1.0.138 and 7.0.139/1.0.139 pairs. Compatible-major ranges do not mean every later release
has been verified. Other OTel
instrumentations can use `hue.tracer` directly or explicitly attach the processors
below. Instrumentations that only use a global provider need your application's
normal OTel setup; Hue does not silently replace it.

Provider-executed tools, such as OpenAI hosted MCP (`openai.tools.mcp`), appear as
`execute_tool mcp.<name>` spans with `gen_ai.tool.type` `extension`. The server is named only
by `serverLabel` inside the recorded result, so before export the TypeScript SDK copies it to
`mcp.server.name`, and a result with an MCP `error` sets ERROR status and `error.type`
`mcp_error`. Metadata-only export keeps these two attributes while stripping arguments and
results. The label can only be read when AI SDK recorded the result: `hueTelemetry(hue)` with
`captureContent: false` records none, whereas an application whose AI SDK integration records
outputs and exports through Hue's attached processors keeps the label.

## Privacy and content

Set `captureContent: true` for full traces: prompts and messages, responses and tool inputs/outputs,
alongside model, usage, timing and errors. Trace inspection, evaluations and judges read that
content. Choose `false`, metadata-only mode, when your users decline or an application or data
policy forbids sending that content to another service. `redact` and the credential filtering
described below apply in both modes.

`captureContent: false` disables manual input/output/messages/tool content and
removes recognized GenAI, Vercel, OpenInference, OpenLLMetry and Langfuse content attributes,
legacy GenAI content events, log bodies, status messages and exception text before
export. The exported `contentPrefixes` array lists the attribute keys (and their dotted
children) that are removed. Model/provider/token metadata remains available. Generic custom attribute
names cannot be classified automatically; use them deliberately.

`captureContent: true` captures supplied content. Accepted content is stored by Hue;
there is no SDK retention timer or automatic content expiry. To redact strings
before export, supply `redact(value, path)`; it applies to supported strings in
attributes, resources, event/link attributes and log bodies. Return a string.
Invalid helper content is omitted with an instrumentation failure; the span can still be delivered.
A content value over Hue's 1 MiB value cap (or the value limit Hue's receiver advertises) is not
omitted. A span's own string attribute over the cap is uploaded to Hue whole and replaced by its
first 16 KiB (see [Values over the inline limit](#values-over-the-inline-limit)); `redact` sees
the whole value first, and its answer is what is uploaded. Any other value over the cap, and one
that could not be uploaded, is cut: text to a UTF-8 prefix, and
bytes or a structured log body are replaced by the receiver's own marker
(`{ "hue.truncated": true, "hue.truncated_bytes": <size> }`), and the value's key is listed in
the record's `hue.truncated` attribute, where Hue's receiver lists the values it cuts itself,
so the span still carries the call, the recorded part of its value and the rest of its evidence.
`redact` sees text past the cap, so it can recognize a secret that crosses it. A string longer
than the cap and 64 Ki code units that is not held whole for upload is cut to that length when
its record is queued, so a value of millions of characters cannot drop its record for the queue
budget; for such a text the last 64 Ki code units of the redactor's answer are never exported,
and tool definitions and recorded requests have their credentials removed from the whole value
before that cut.
Export-time redactor failures reject the affected record and are reported by flush. Shared resources are redacted once per
export batch. Do not put user content or secrets in span names or scope names.

Hosted tools carry credentials in their definitions, such as the `authorization` and `headers` of
an OpenAI hosted MCP tool. Before export, and before `redact`, Hue replaces the values of
credential-like fields including `authorization`, `authorization_token`, `headers`, `api_key`,
`access_token`, `x-api-key`, and keys ending in `token`, `secret`, `password`, `apikey` or
`credential` (case-insensitively, ignoring `-` and `_`) with `"[redacted]"` in recorded tool definitions
(`gen_ai.tool.definitions`, `ai.prompt.tools`, `llm.tools.*.tool.json_schema`) and in the
top-level `tools` and `mcp_servers` entries of any JSON object recorded as `input.value`,
`output.value` or `llm.invocation_parameters`, whether or not it is a provider request; nothing
else in that object changes. Parameters named in a JSON Schema `properties`
object keep their schemas, so a tool that takes a `headers` argument is still described. A
definition nested more than 256 levels deep rejects its record. Sensitive `default`, `const`,
`examples` and `enum` values under credential-named schema parameters are redacted too. A `url`
or `server_url` field (named like the credential fields, so `serverUrl` too) that has userinfo, a
query or a fragment loses its userinfo and fragment, and each query value becomes `[redacted]`
under its original name; the result is serialized as WHATWG `URL` does (lowercase scheme and
host, IDN hosts in Punycode, default ports dropped, dot segments resolved). A URL with none of
them is exported as recorded, and a value `URL` cannot parse becomes `"[redacted]"`.

With `captureContent: false`, export removes tool definitions but keeps a summary of them on the
same record: `hue.tool.names` lists each definition's `name` (Chat Completions `function.name`,
or the `type` of an unnamed built-in tool such as `mcp`) in order, and
`hue.tool.definitions.sha256` is the lowercase hex SHA-256 of the
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical JSON of the credential-scrubbed
definition list. The digest is the same in both SDKs and does not change when a credential
rotates. Only definitions another integration recorded can be summarized: `hueTelemetry(hue)` with
`captureContent: false` records none, whereas an application whose AI SDK integration records
inputs and exports through Hue's attached processors gets the summary.
Recorded content can carry images, documents and audio: see
[Images, documents and audio](#images-documents-and-audio) for what the SDK uploads and how.

Manual helpers encode JSON values without converting null into absence. Unknown
outputs and usage remain absent. This SDK does not estimate tokens or cost. A thrown
application error marks the span with `error.type` (the error's `name`), an ERROR status and an
`exception` event carrying only the type; exception messages and stack traces are never recorded by
the helpers, whatever `captureContent` is, and the error is rethrown unchanged. `withSpan` ends its
span in `finally`.

`recordMessages` emits the `gen_ai.client.inference.operation.details` log record correlated with
the active span, with the messages in its body. The record also carries `gen_ai.operation.name`,
`gen_ai.provider.name` and `gen_ai.request.model` as attributes, copied from the enclosing
`hue.model()` span or passed as `operation`, `provider` and `model`, and `gen_ai.conversation.id`
from the active session, when those values are known. Use `recordMessages` inside `hue.model()` or
supply `operation` and `provider` explicitly to include the required inference context.

## Existing OpenTelemetry providers

Attach processors while constructing your providers. Hue uses local async context
for its own helpers and never registers/replaces the global tracer, logger, or
context manager. When your application has registered a context manager, Hue helpers also make
their span the active OpenTelemetry span for the duration of the callback, so spans from other
instrumentations (HTTP clients, provider SDKs) that use the global API parent under it.

```ts
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import { createHue, createHueTransport } from "@hue-run/sdk";

const transport = createHueTransport({
  apiKey: process.env.HUE_API_KEY!,
  serviceName: "existing-app",
  captureContent: true, // false sends metadata only
});
const tracerProvider = new TracerProvider({ spanProcessors: [transport.spanProcessor] });
const loggerProvider = new LoggerProvider({ processors: [transport.logRecordProcessor] });
const hue = createHue({ transport, tracerProvider, loggerProvider });
// Your application owns and configures these providers and their resources.
await hue.shutdown(); // flushes; does not shut down these externally owned providers
// During application shutdown, shut down your providers, then await transport.shutdown().
```

The application's providers own the resource in this mode, so `resourceAttributes` on the
transport options is ignored and reported as a `warning` issue; set `deployment.environment.name`
and similar attributes on your own providers.

For external parent context pass `parentContext` to `withSpan`. Across processes, use
`hue.inject(carrier)` inside the producing span and `hue.extract(carrier)` in the worker; both
speak W3C `traceparent` only and never include the API key or baggage. Extract it only from
trusted internal callers, as described under [Sub-agents](#sub-agents). Hue registers no global
propagator, so `propagation.inject()` from `@opentelemetry/api` is a no-op unless your
application configured one. `getContext()` exposes the helper's current context for APIs taking
an explicit context. Session, user and workspace identifiers (`sessionId` as
`gen_ai.conversation.id`, `userId` as `user.id`, and `workspaceId` as `hue.workspace.id` for the
application workspace or tenant) are inherited within a client callback and are
stamped only on spans created through Hue's tracer (helpers and the AI SDK adapters); spans from
other instrumentations on a shared provider carry them only if that instrumentation sets them.
Separate requests require separate callbacks.

In attach mode Hue's span processor exports every span that ends on that provider, the same
default as other OpenTelemetry exporters. To send only part of a provider's spans, wrap the
processor:

```ts
const aiSpansOnly = {
  onStart: () => {},
  onEnd: (span) => {
    if ("gen_ai.operation.name" in span.attributes || span.name.startsWith("ai."))
      transport.spanProcessor.onEnd(span);
  },
  forceFlush: () => transport.spanProcessor.forceFlush(),
  shutdown: () => transport.spanProcessor.shutdown(),
};
```

## Local development without a Hue account

Hue speaks standard OTLP, so any local collector works. Point `baseUrl` at a loopback receiver
that accepts `/api/v1/otlp/v1/traces` and `/api/v1/otlp/v1/logs` (for example an OpenTelemetry
Collector `otlp` receiver with `http.traces_url_path` and `logs_url_path` set to those paths,
forwarding to Jaeger or the debug exporter) and pass any placeholder `apiKey`; HTTP is allowed
for loopback origins. `checkConnection()` and `verifyTrace()` are Hue-only diagnostics and are
not available against a generic collector. Set `liveSpans: false` so Hue-specific placeholders
do not reach the collector's other destinations. A collector has no upload route: the records
exported before it answers an upload carry their large values and media as 16 KiB prefixes or
digests with `hue.blobs` entries that never resolve, and for 10 minutes after each answer values are
cut inline, as described in [Values over the inline limit](#values-over-the-inline-limit).

A collector on a private network is not loopback: a docker-compose sibling such as
`http://otel-collector:4318` or an in-cluster service requires the explicit opt-in
`allowInsecureHttp: true`. The client then records a one-time `warning` issue because the key and
telemetry travel unencrypted. Use a placeholder key with such a collector, and never enable the
option for a real project key on a network you do not control.

```ts
const hue = createHue({
  apiKey: "local-placeholder",
  serviceName: "my-agent",
  captureContent: true,
  baseUrl: "http://otel-collector:4318",
  liveSpans: false,
  allowInsecureHttp: true,
});
```

## Delivery behavior

Exports retry temporary HTTP/network failures (429, 500, 502, 503, 504 and connection errors,
honoring `Retry-After`) within the export timeout. A
429 whose `Retry-After` outlasts the export timeout keeps its records queued, within the queue's
bounds, and sends them again once the wait has passed; an export holds its records this way for at
most 60 seconds in all, and a longer wait loses them, reported as a `failed` issue with status 429.
`flush()` and `shutdown()` wait for a held export, and a held export keeps the process running
until it is sent. When `shutdownSafe()`'s budget runs out first, a client that owns its providers
ends the hold: its records are reported lost to the rate limit and the process can exit. In attach
mode the application's providers drain with their own timeout (OpenTelemetry's default is 30
seconds), so a flush during a longer hold can report a provider flush failure while the held
export continues. Uploads of values over the inline limit never hold an export or draw on its
hold: they run after their records are sent. `flush()` waits for them once the providers have
drained; an application's own provider `forceFlush()` in attach mode waits for them within its
provider timeout, which can then report a provider flush failure while uploads continue.

Requests are measured as Hue's receiver measures them: after gzip against its request limit and
after decompression against its decoded limit. Until a response advertises its own limits
(`Hue-Max-Request-Bytes`, `Hue-Max-Decoded-Bytes` and `Hue-Max-Value-Bytes`, on every
acknowledgement and refusal) these are 1 MiB on the wire, 4 MiB decoded and 1 MiB per value;
advertised limits are adopted, clamped to 1–64 MiB, 1–64 MiB and 256 KiB–16 MiB, and never
exceeded: a request that limits lowered while it was retried or held no longer fit is split and
shed again before it is sent. Batches are packed to 4 MiB before gzip (or the decoded limit, when lower) and split at
record boundaries; a batch that compresses worse than the limit allows is sent in halves. A record
over a limit on its own sheds its content values,
largest first, each replaced by the receiver's marker and listed under `hue.truncated`, until it
fits; only a record too large without any content value is lost, reported as an `invalid` issue,
and counted on its trace's root span as `hue.sdk.dropped_records` when the root is exported, so
Hue reads the trace as incomplete by that many records; so are records lost to a rate limit
longer than the hold. Each signal queues at most 2,048 records, including
exports in flight; overflow is reported through the callback, counters and next
flush. This is an in-memory queue, not durable storage. A client's own providers keep 2,000
attributes, events and links per span and 2,000 attributes per log record (OpenTelemetry's default
is 128); providers an application attaches Hue to keep their own limits. A span whose events or
links do not all fit the queue's byte budget keeps its newest ones and counts the rest in its
dropped event and link counts, rather than being dropped whole.

### Values over the inline limit

Hue keeps a value inline up to its value limit (1 MiB unless the receiver advertises another in
`Hue-Max-Value-Bytes`). A span's own string attribute larger than that (helper content such as
`input.value`, `output.value` and tool results, or another instrumentation's attribute), and the
files described in [Images, documents and audio](#images-documents-and-audio), are uploaded to Hue
apart from their record, up to Hue's upload limit of 1,000,000,000 bytes. As with Langfuse media,
the record is sent first and its bytes follow:

1. Export computes the SHA-256 of the value's bytes (a string as UTF-8, a file as its own bytes)
   and places the value: whole string values and large text media keep a UTF-8-safe 16 KiB prefix,
   and binary media keeps its digest on the part. The record lists each value in `hue.blobs`, at
   most 64 compact JSON strings with fields ordered `key`, `sha256`, `size`, `content_type` (the
   type this reference declared) and optional `name`:
   `{"key":"output.value","sha256":"<64 hex>","size":5242880,"content_type":"application/json"}`.
   A whole value is listed under `hue.truncated` as well, since its inline text is a prefix. The
   record is then sent.
2. In the background, the upload reserves the value with `POST /api/v1/otlp/blobs`, authenticated
   with the project key. Hue answers that it already stores the value under the trace, and nothing
   is uploaded, or with a presigned URL.
3. The bytes go straight to the project's evidence store in one `PUT` to that URL, with exactly the
   headers Hue signed and never the project key (over HTTPS, or plain HTTP to a loopback store or
   with `allowInsecureHttp`), and
   the upload is confirmed with `POST /api/v1/otlp/blobs/complete`. A PUT the store answers with
   412 (the same value uploaded at the same time by another span) counts as stored.

Hue stores the value under the trace, so the trace's retention, deletion and erasure cover it, and
reads an entry's bytes whenever they arrive: until then Hue reports the value as missing. Uploads
never run on the application's thread and never delay, hold or drop a record: hashing has its own
four places, at most four uploads run at once, and none draws on an export's 60-second hold.

| Request | Tried | Waits before trying again | Not tried again |
| --- | --- | --- | --- |
| Reservation | 3 times: no answer, 408, 429 or a 5xx other than 501 | Its `Retry-After` up to 60 s, or 1 s then 2 s with jitter | Other refusals |
| `PUT` | 3 times: no answer, 408, 429 or a 5xx | 1 s then 2 s with jitter | Other refusals; an expired URL is reserved again once |
| Completion | Once | None | Its outcome is not read: Hue completes the value on its next reservation |

Each request gives up after `timeoutMillis` without progress, and each upload ends within six
export timeouts and a minute of being queued (two minutes at the default
`timeoutMillis` of 10000), so a 1 GB file needs about 8.5 MB/s at the defaults; raise
`timeoutMillis` (up to 60000) for slower links. `flush()`, `shutdown()` and the span and log
processors' `forceFlush()` and `shutdown()` (attach mode included) wait for the uploads queued
before them, after their records are sent; call one of them, or a `Safe` variant with a budget
that covers your uploads, before the process exits. A `shutdownSafe()` whose budget runs out ends
queued and in-flight uploads.

A value refused when its record is exported (the receiver is known to have no upload route,
uploads were ended by shutdown, the value is over 1 GB, or a budget is full) is exported as before
uploads existed: whole attributes keep a prefix up to the limit and are listed under
`hue.truncated`; media parts keep their digest without a blob entry; opt-in `recordFile` uploads
keep the file event. A value whose upload fails after its record was exported (Hue or the store
refused it or failed, the network or a deadline did) keeps the form it was exported with and its
`hue.blobs` entry, which Hue reads as missing until a later reference to the same bytes in the
trace uploads them. Bytes given in memory to `recordFile` or an `Attachment` are limited to 25
MiB; a file given by path, a file read in place from a value and a whole attribute to 1 GB. An
export reports such values in a `warning` issue per cause, whose `count` is the values and
`traceIds` their traces (those refused when it runs, then those that failed once its uploads
settle), and counts them in `report.uploadFallbacks`; completed uploads are counted in
`report.uploadedValues`. Both counters include whole attributes, eligible media, attachments and
opt-in `recordFile` uploads. A warning never makes `flush()` throw. A receiver without the upload
route (a 404 that is not Hue's, a 405 or 501, or a 200 that is no reservation) is not asked again
for 10 minutes: records exported before it answers list entries it never stores, and values
exported in those 10 minutes fall back as above.

To upload a value whole, the queue holds it until export apart from `maxQueueBytes`, within a
128 MiB budget shared by held values (a string charged two bytes a code unit) and the bytes of
uploads not yet settled, and at most 4,096 uploads wait at once; a recorded message holding
eligible media is held the same way. `maxQueueBytes` is still charged what the value would cost
cut (a message, its copy with the files as their digest). A value the budget cannot hold, or one
queued while the receiver is known to lack the upload route, is cut (its files digested) when it
is queued, as before, and reported as not uploaded, once per file; a single value larger than the
whole budget is held while nothing else is. While values can be uploaded, helpers encode content whole, up to the
upload limit and 1,048,576 values, rather than cutting it to the value limit as they record it.

Nothing is uploaded with `captureContent: false` or a setup credential (`hue_setup_…`), nor from
links, resources, log records not correlated with a span or in-progress placeholders; a log record
uploads only its files and the attachments in its body (see
[Automatically captured media](#automatically-captured-media)). Span events upload only through explicit `recordFile({ upload: true, ... })`;
other event values are cut as before. `redact` and the credential scrub of
tool definitions and recorded requests run on the whole value before it is hashed, so a value they
rewrite is uploaded as rewritten.

`flush()` waits for the current trace and log export work. A partial rejection,
invalid acknowledgement, queue drop or failure throws `HueExportError`; its
`report` contains cumulative accepted/rejected/failed counts and current pending gauges. Accepted
means the collector acknowledged receipt, not that a complete trace has arrived.
A malformed response reports uncertain acceptance as failure. Partial successes
are not retried. Warning-only acknowledgements with zero rejected records remain
successful; the callback and issue history expose a sanitized warning. The next
non-overlapping flush reports new failures; overlapping callers also observe failures
from their shared in-flight work. Counters remain cumulative and `transport.getIssues()`
keeps the latest 128 sanitized issues. Each concurrent caller receives a fresh drain, including
records emitted before its call; drains send their records one after another, and each then waits
for the uploads queued so far on its own, so a later drain's records never wait for an earlier
drain's uploads. `flushSafe()` joins a drain still sending its records and otherwise starts its
own. Stop request production
before shutdown so late spans cannot race it. A client does not own instrumented
operations still running in the application.

## Live spans

OpenTelemetry exports a span only when it ends, so a long streamed turn would otherwise stay
invisible until it finishes. When a Hue or AI span is still open at the transport's next 500 ms
tick, the transport queues a placeholder: an ordinary OTLP span whose parent is the running span,
with its name, kind, start time and current attributes, an end time of 0,
`hue.span_type = "pending_span"` and `hue.pending_parent_id` (the running span's own parent,
omitted for a root). Hue shows the span as running and replaces the placeholder when the real span
arrives.

The placeholder then waits for the next batch export like any queued span: up to 500 ms until the
next tick, then the 1 s batch delay when nothing else is queued, so it usually reaches Hue within
about 1.5 s of its span starting. It goes out sooner when a batch is already scheduled, for example
because another span has just ended, and at once for a full batch or `flush()`. It goes out later
while an earlier export is still in flight, because the next batch is scheduled only after that
export finishes. A placeholder whose span has ended by the time it is exported is not sent, so a
short span may send none and appear in Hue only when it finishes.

- Only spans from the client's tracer (`withSpan`, `tool`, `model`, `hue.tracer` and the AI SDK
  adapters) and spans with a `gen_ai.`, `ai.`, `llm.` or `traceloop.` attribute at start, or a
  name starting with `ai.`, are announced. HTTP, database and other framework spans are not.
- Placeholder attributes follow `captureContent` and `redact` like the real span. Tool
  definitions, system instructions and any value over 64 KiB are left out.
- The transport builds each placeholder from the running span itself, so code in a wrapping
  processor's `onEnd` never runs on it. If a wrapper forwards `onStart` to Hue but scrubs
  attributes, renames the span or drops it in `onEnd`, a placeholder exported while the span is
  still open is sent anyway: it has the span's original name, and its attributes as set on the span
  with `captureContent` and `redact` applied. Scrub with `redact`, which applies to placeholders
  too, or before the value is set on the span; do not forward `onStart` for spans you rename or
  drop; or turn live spans off with `liveSpans: false`.
- Placeholders are advisory. They are queued only while the queue is under a quarter of its
  record and byte budgets, and skipped silently otherwise. While queued they count in
  `pendingSpans` and `pendingBytes`, but never as accepted, rejected, failed or dropped records.
  Losing only placeholders records a warning and does not make `flush()` throw.
- Placeholders travel in their own requests, after an export's completed spans, so a rejection
  count is always one kind of record's: a completed span's rejection is never credited to a
  placeholder, and a rejected request of placeholders is a warning. A Hue server that accepts
  placeholders sends `Hue-Pending-Spans: 1` on every trace acknowledgement. The first trace
  acknowledgement without it, whatever its request carried, shows the receiver predates them: the
  transport records one warning (counting the placeholders the receiver rejected in that request, if any) and stops
  sending placeholders for that client, so a receiver that acknowledged completed spans first
  never receives one.
- Opt out with `liveSpans: false`. Setup credentials never send placeholders.
- With an existing provider, announcements start in `spanProcessor.onStart`. A wrapping processor
  that forwards `onStart` should forward `onEnd` for the same spans: a span that ends without
  reaching Hue is forgotten at the next tick, but a placeholder already sent keeps it showing as
  running until Hue marks the trace stalled. The filtering wrapper above forwards no starts, so it
  sends no placeholders.

## Verify a stored application trace

After exercising a real application request and finishing its stream, flush the
providers that own its spans, then verify their OpenTelemetry IDs:

```ts
// traceId and requestSpanId come from the application request you just exercised.
await hue.flush(); // borrowed providers must also finish their own work
const result = await hue.verifyTrace(traceId, {
  expectedSpanIds: [requestSpanId], // include known model/tool span IDs when available
  requiredFields: ["input", "output", "model"], // choose fields this request should emit
});
if (!result.verified) throw new Error("Trace verification timed out; inspect missing spans and fields.");
console.log(result.receipt?.traceUrl);
```

Available in TypeScript `0.1.3`. `verifyTrace` makes a read-only, project-key-authenticated
receipt request. It does not flush, run your application, create a test span, or
read captured values. `fields` reports the presence of stored normalized input,
output, model, usage, and session data across the trace; it does not establish
content correctness or that every possible span has arrived. Leave unknown usage
and intentionally disabled content out of `requiredFields`. When Hue reports the trace
missing, `project` names the project the key searched: a trace absent there was sent with a
different key (for example one still exported in the shell) or is not stored yet.

The default budget is 10 seconds; set `timeoutMillis` up to 60,000. Only a recognized
missing trace, HTTP 429, or HTTP 503 is retried, respecting `Retry-After` and the
overall deadline. Incomplete evidence is also checked again within that deadline.
A timeout returns `{ verified: false, receipt }`, retaining the latest observed
receipt or `null`. Authentication, unsupported endpoint, transport, and invalid
response failures throw `HueTraceVerificationError` with a safe `code` and optional
HTTP `status`. Missing expected spans and required fields remain explicit; a 200
response alone is not success. A successful result verifies those requested
conditions only. Use Hue's UI to inspect captured values and redaction.

## Dependencies

The tracing core depends only on official `@opentelemetry/*` packages and `zod`, which the
`@hue-run/sdk/evals` entry point and `hue eval` use for their bounded runtime contracts and which
installs with the SDK. JSON Schema scoring also uses `ajv`, an optional peer loaded inside a worker only when `builtins.jsonSchema` scores a case; without it that scorer
reports `SchemaValidatorUnavailable`. Install it when you use that scorer:

```bash
npm install ajv
```

See [THIRD_PARTY_NOTICES.md](https://github.com/hue-run/hue-sdk/blob/main/THIRD_PARTY_NOTICES.md) for licenses.

## Package verification

From the repository root with Node 24 and Bun 1.4.2 on PATH:

```sh
node packages/sdk-typescript/scripts/verify-package.mjs
```

This copies the SDK to a temporary directory, performs a frozen installation,
builds and packs it, installs the tarball into a separate consumer, runs the real
HTTP exporter suite against that installed package, and installs/builds the
standalone reference chatbot. It prints the artifact paths. No package is
published. The chatbot README describes running that external installation.

## Local evaluation workflows

The optional `@hue-run/sdk/evals` entry point supports dataset/scorer registration, frozen-version experiments, local built-in/custom scoring, upload resume, and historical rescoring. See the [evaluation guide](https://docs.hue.run/evaluations/first-evaluation) for the complete journey, content policy and checkpoint recovery contract.

### App-launched local workers

`runLocalAgent()` shipped in TypeScript `0.3.0` and is available from npm. It connects a fixed local
callback to app-launched simulation work while keeping the agent and provider orchestration in
the developer's process. It shares
`runSimulation()`'s provider-aware world lifecycle, keeps scoped credentials in callback memory,
skips target/scorer execution for incomplete environments, and never reacquires or replays after
an uncertain preparation. See the
[outbound worker contract](EVALUATIONS.md#outbound-local-agent-worker) and
[simulated environment guide](ENVIRONMENTS.md). Tests exercise local control-plane fixtures, not
an issued facade endpoint or the official Gmail service, and do not claim universal provider
parity.

The `directTarget` callback, shipped in TypeScript `0.5.0`, extends the same worker to cases
without a world: the runner verifies the case's pinned input files, hands them to the agent, and
uploads the documents it returns as verified Hue artifacts for scoring. See
[direct cases and files](EVALUATIONS.md#direct-cases-and-files).

Scorer deferral shipped in TypeScript `0.3.1`. Only built-ins
and bound `local_code` callbacks run here; other pins remain pending for their authorized executor.
See [scorer execution](EVALUATIONS.md#hosted-and-manual-scorer-pins).

The published [setup CLI](CLI.md) is a resumable local inspection core; the unreleased `0.4.0`
candidate adds the bounded application onboarding flow described above. Existing customers connect
their agents with `runLocalAgent()`; setup does not register workers or launch simulations.

### Command-line evaluation

The `hue eval` command, shipped in TypeScript `0.5.0` (`--case` since `0.6.0`, `--scenario`
before), wraps `runSimulation()` and `runLocalAgent()` for an adapter file or a shell command:
`hue eval --case "<name>" ./hue-agent.ts --content` creates a fresh run from a published case's
immutable pins, runs the agent with an isolated world when the case pins one, waits
for Hue's outcome checks and prints the run URL and per-case PASS/FAIL verdicts with an exit code;
`--worker` registers the same adapter for runs launched from Hue. Since TypeScript 0.13.2, a
command worker handles both world and answer-only cases; adapter workers opt into direct cases
with `--capability direct:v1`. Upgrade an existing command registration under a new `--revision`.
It needs a Read and write key in `HUE_API_KEY` (never printed). Content capture defaults on; `--no-content` opts out. The example passes `--content` explicitly
for compatibility with older releases. Case outputs, error messages and
explanations are stored in Hue either way (`--no-output` keeps them out of a one-shot run's
results); a command's stdout is its stored answer, with the credentials `hue eval` handed the case
replaced by `[redacted]`.
Instrument the agent itself for its model and tool spans. See
[Evaluate an agent against a case](CLI.md#evaluate-an-agent-against-a-case).
Eval sets whose cases pin files instead of a world run as direct cases through `runExperiment()`:
`hue eval --set <slug> --scorer <slug> --command "…" --content` hands the agent each case's
pinned files in a private directory, uploads the documents it writes and waits for Hue's grading
executor to score them. See [Evaluate a document eval set](CLI.md#evaluate-a-document-eval-set).

## Managed targets

Start a frozen dataset run in Hue while your agent stays in your application. Expose a
protected POST route around your existing function:

```ts
import { createManagedTargetHandler } from "@hue-run/sdk/managed";

export const POST = createManagedTargetHandler({
  machineCredential: process.env.HUE_MANAGED_TARGET_SECRET!,
  // Application-owned functions: keep your current provider, tools and tracing.
  target: async ({ input, config, inputFiles, signal }) =>
    runAgentForEvaluation({ input, config, inputFiles, signal }),
  tracer: hue.tracer, // Required with a Hue-owned client: Hue never registers a global tracer.
  flushTelemetry: () => hue.flush(), // Existing Hue client; flush traces and logs.
});
```

Without `tracer`, the handler falls back to the global OpenTelemetry tracer, its span is not
recorded, and every invocation returns `uncertain`. An application that only uses `createHue()`
also needs an OpenTelemetry context manager installed for the handler's span to propagate; see
the [managed-run guide](https://docs.hue.run/evaluations/managed-runs).

`runAgentForEvaluation` adapts your application result to `{ output, files? }`.
Files contain `filename`, `contentType`, actual `Uint8Array` data and an optional
`primary` flag. Generated files accept the same 22 content types as Python managed outputs:
PDF, DOCX, PPTX, XLSX, `application/json`, `text/plain`, `text/csv`, `image/png`, `image/jpeg`,
`image/webp`, `image/gif`, `image/avif`, `audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/webm`,
`audio/mp4`, `audio/flac`, `audio/opus`, `audio/aac`, `video/mp4` and `video/webm`.
Declare `audio/mp4` or `video/mp4` for `.mp4` files, and `audio/webm` or `video/webm` for
`.webm` files; the extension alone does not distinguish audio from video.
The helper verifies input bytes, claims the invocation, saves the
outcome and correlates its span with Hue. It never retries the agent automatically.
Use a 120-second host request limit for the default 90-second execution and
30-second finalization budget; your target must honor `signal`.

See the [managed-run guide](https://docs.hue.run/evaluations/managed-runs) and the
[full adapter contract](https://github.com/hue-run/hue-sdk/blob/main/packages/sdk-typescript/MANAGED_TARGETS.md) for registration, file handling,
existing-provider flush callbacks and recovery. Local/CI runners remain available.

## Serving safely

Use `createHueSafe(options)` for best-effort startup. Invalid initialization returns a disabled client that keeps your `onExportIssue` hook and records the reason as an instrumentation failure. Pass `enabled: false` to disable Hue without a key or a `captureContent` choice; disabled helpers still execute the application callback, and `inject()` keeps propagating the application's own trace context. `flushSafe({ timeoutMillis: 1000 })` and `shutdownSafe({ timeoutMillis: 1000 })` return `{ ok, timedOut, report }` without rejecting. Strict initialization, connection checks and `flush()` remain available for diagnostics; do not gate application readiness or responses on them.

Capture/serialization/redaction/provider failures omit unsafe telemetry, record failures, and preserve the original business result/error. Async diagnostic rejections are contained; diagnostics are rate-limited. The default `maxQueueBytes` is 8 MiB across traces/logs including in-flight work, alongside the existing record cap. `pendingBytes` is a current queue gauge; `droppedSpans`, `droppedLogs` and `instrumentationFailures` are cumulative failure counters; `uploadedValues` and `uploadFallbacks` count completed uploads and upload fallbacks for whole attributes, eligible binary or large text media, and opt-in `recordFile` uploads. Whole-attribute fallbacks refused at export keep a prefix; media fallbacks keep a digest; helper upload fallbacks keep the file event; a value whose upload failed after export keeps its entry as well. This is a telemetry budget, not a total process memory ceiling. A timeout bounds the caller and does not cancel a borrowed provider. Never retry the business operation to recover telemetry. See [production setup](https://docs.hue.run/sdks/typescript#production-setup).

Queued records snapshot supported telemetry values when a span ends or a log is emitted; later caller mutations cannot change queued data. Resource attributes still awaiting detection are omitted with a sanitized warning. Later records include them after detection finishes; await resource detection before instrumentation when those attributes are required.
