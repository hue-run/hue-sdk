<p align="center">
  <img alt="Hue" src="https://raw.githubusercontent.com/hue-run/hue-sdk/df0443f98c6096ff331fd0400715e4f3a1936607/.github/assets/hue-ascii-neutral.png" width="720">
</p>

# Hue Python SDK

[![PyPI](https://img.shields.io/pypi/v/hue-run?label=hue-run)](https://pypi.org/project/hue-run/) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

For frozen datasets, local experiments, custom scorers, durable retries and historical rescoring, see [Local evaluations](https://docs.hue.run/evaluations/first-evaluation).

Python helpers around the official OpenTelemetry trace and log SDKs and OTLP HTTP/protobuf exporters. `opentelemetry-api`, `opentelemetry-sdk` and `opentelemetry-exporter-otlp-proto-http` are accepted as **`>=1.40,<2`**; **1.44.0** is the certified lockfile combination and **1.40.0** is tested as the floor in CI. Provider requests run in your application. This package does not proxy model calls or configure global OTel providers.

The distribution is named `hue-run` on PyPI (`import hue_sdk`); install `hue-run`, not `hue-sdk`, which is not published there. Python 3.10+ is supported by the package contract; recorded validation below identifies the tested runtime.

[Documentation](https://docs.hue.run) · [Sign in](https://app.hue.run)

## Install

```bash
pip install hue-run
# Or, in a uv project:
uv add hue-run
```

## Send a trace

In the consuming application, use only public imports:

```python
import os
from hue_sdk import Hue

with Hue(
    api_key=os.environ["HUE_API_KEY"],
    capture_content=True,  # Also works with older releases; False sends metadata only.
) as hue:
    project = hue.validate_project()
    with hue.context(session_id="conversation-42", user_id="observed-user-7"):
        with hue.span("agent.run") as run:
            run.set_input({"question": "What is 2 + 2?"})
            with hue.tool("add") as tool:
                tool.set_input({"a": 2, "b": 2})
                tool.set_output(4)
            run.set_output({"answer": 4})
    if not hue.force_flush():
        raise RuntimeError("Telemetry export failed; inspect Hue export_status.")
```

`capture_content=True`, as above, is the recommended choice: trace inspection, evaluations and judges read the inputs, outputs and tool arguments and results it records. Choose `False` for metadata only when a policy forbids sending that content; see [Content and semantic fields](#content-and-semantic-fields).

The SDK uses `https://app.hue.run` by default. Set `base_url` only for a different Hue deployment or a local receiver, using an origin without an API suffix. Existing `Hue(base_url, api_key, ...)` calls remain supported; a bare key passed as the first positional argument raises `TypeError` pointing at `api_key=`. The project service key determines the project. The SDK validates the project at `GET /api/v1/projects/current` when explicitly requested; construction itself does not perform a request. HTTP is permitted only for `localhost` and loopback IPs. Userinfo, query strings, fragments, paths and redirects are rejected. The key is sent only as `Authorization: Bearer …`; `repr(hue)`, SDK errors and status counters omit it.

## Content and semantic fields

Starting with Python 0.8.0, `capture_content` defaults to `True`. Earlier releases require an explicit choice. Set it to `True` for full traces: prompts and messages, responses and tool inputs/outputs, alongside model, usage, timing and errors. Trace inspection, evaluations and judges read that content, and your redactor and the credential filtering below apply to it. Choose `False`, metadata-only mode, when your users decline or an application or data policy forbids sending that content to another service.

`False` makes `set_input` and `set_output` omit content before it reaches an OTel queue and makes `log_inference` emit no record. Explicit JSON null, empty strings and absent content stay distinct when capture is enabled. Exception recording includes the exception type and ERROR status; exception messages and stacks are always excluded by these helpers.

When capture is disabled Hue also strips recognized GenAI, OpenInference, OpenLLMetry, Langfuse and Vercel AI SDK content attributes (including OpenInference retrieval documents, embeddings, reranker documents, prompt-template variables and images, and Langfuse observation and trace inputs, outputs, status messages and model parameters), legacy `gen_ai.*` message events, log bodies and status descriptions from every record it exports, including spans produced by third-party instrumentors on the same provider. [COMPATIBILITY.md](https://github.com/hue-run/hue-sdk/blob/main/COMPATIBILITY.md) lists the exact keys. This setting is still **not a blanket PII filter**: custom attribute names, span names, session/user identifiers and resource attributes cannot be classified automatically and remain under your control, and other exporters keep their own policy. The server stores received content; there is no automatic telemetry expiry. Delete scoped data explicitly when required by your retention policy.

Hosted tools carry credentials in their definitions, such as the `authorization` and `headers` of an OpenAI hosted MCP tool. When content is captured, Hue's export path replaces credential-like fields including `authorization`, `authorization_token`, `headers`, `api_key`, `access_token`, `x-api-key`, and keys ending in `token`, `secret`, `password`, `apikey` or `credential` (case-insensitively, ignoring `-` and `_`) with `"[redacted]"` in recorded tool definitions (`gen_ai.tool.definitions`, `ai.prompt.tools`, `llm.tools.*.tool.json_schema`) and in the top-level `tools` and `mcp_servers` entries of any JSON object recorded as `input.value`, `output.value` or `llm.invocation_parameters` (as OpenInference records a raw provider request), whether or not it is a provider request; nothing else in that object changes. Parameters named in a JSON Schema `properties` object keep their schemas, so a tool that takes a `headers` argument is still described. A definition nested more than 256 levels deep drops its record. Sensitive defaults, constants, examples and enum values under credential-named schema parameters are redacted too. A `url` or `server_url` field (named like the credential fields, so `serverUrl` too) that has userinfo, a query or a fragment loses its userinfo and fragment, and each query value becomes `[redacted]` under its original name; a URL with none of them is exported as recorded. A scrubbed `http`, `https`, `ws`, `wss` or `ftp` URL is serialized as WHATWG `URL` does (lowercase scheme and host, IDN hosts in Punycode, default ports dropped, dot segments resolved), so for ordinary hosts its text and the tool-catalog digest match the TypeScript SDK's. Internationalized hosts can still differ at the edges: Python refuses an IDN host longer than 1,024 characters and a zero-width joiner or non-joiner anywhere but after a virama, and checks right-to-left labels as the Node.js parser does, which accepts a few that Bun refuses. Other schemes, such as `mcp:` or `file:`, keep their earlier handling and can differ from the TypeScript SDK. A value that is not an absolute URL becomes `"[redacted]"`.

With `capture_content=False`, export removes tool definitions but keeps a summary of them on the same record: `hue.tool.names` lists each definition's `name` (Chat Completions `function.name`, or the `type` of an unnamed built-in tool such as `mcp`) in order, and `hue.tool.definitions.sha256` is the lowercase hex SHA-256 of the [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical JSON of the credential-scrubbed definition list, identical to the TypeScript SDK's and unchanged when a credential rotates. Only definitions an instrumentor recorded can be summarized, for example OpenInference without `hide_inputs`.
Recorded content can carry images, documents and audio: see [Images, documents and audio](#images-documents-and-audio) for what the SDK uploads and how.

Use `redactor=lambda field, value: ...` to transform content in supported helpers. It runs synchronously before serialization and export. Return a redacted JSON value; failures omit the field and increment `export_status.instrumentation_failures` without changing application behavior. It does not inspect arbitrary OTel attributes or logs:

```python
def redact(field, value):
    if isinstance(value, dict):
        return {key: "[redacted]" if key == "email" else item for key, item in value.items()}
    return value
```

The callback should cover your actual nested input format; this small example is only a top-level dictionary transformation.

Before redaction, helpers copy supported content into detached built-in containers; in-place changes by a redactor cannot change application inputs or results. The input and the redactor's returned value each have a **4 MiB conservative value budget**, **64 maximum nesting depth** and **65,536 visited values/keys**, so a redactor sees content past the value cap and can recognize a secret that crosses it. While values over the cap can be uploaded (see [values over the inline limit](#values-over-the-inline-limit)), a span attribute's content (`set_input`, `set_output`) has a **1 GB** budget and **1,048,576** values instead and is serialized whole: the redactor sees the whole value, and its answer is what is uploaded. Integers and integer keys are limited to **14,000 bits** before decimal conversion. Final serialized content has the **1 MiB** UTF-8 JSON value cap (or the value limit Hue's receiver advertises): a value over it is cut to a UTF-8 prefix of its JSON text, as Hue's receiver cuts a value over its own cap, and its key is listed in the span's `hue.truncated` attribute, so the span still carries the call and the recorded part of its value. Cyclic, nonfinite, unsupported or over-budget content is omitted and counted as an instrumentation failure. See [the Python safety boundary](https://github.com/hue-run/hue-sdk/blob/main/packages/sdk-python/SAFETY.md) for supported types and callback limits.

| Helper                                         | Attributes / behavior                                                                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `span(name)`                                   | Generic `input.value` / `output.value`, optional OTel attributes and kind                                                                      |
| `model(model, provider=..., system_instructions=..., tools=...)` | `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.provider.name`; message content in `gen_ai.input.messages` / `gen_ai.output.messages`; optional content `gen_ai.system_instructions` and `gen_ai.tool.definitions` |
| `tool(name, call_id=..., mcp=...)`             | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, call ID, optional MCP `initialize` `serverInfo` as `mcp.server.name` / `mcp.server.version` and Hue `provider` / `surface` as `hue.mcp.provider` / `hue.mcp.surface`, arguments and result |
| `context(session_id=..., user_id=...)`         | Task-local `gen_ai.conversation.id` / `user.id` on nested Hue helpers; observed users are not Hue account identities                           |
| `span.set_usage(...)`                          | Nonnegative reported `gen_ai.usage.input_tokens` / `output_tokens`; `None` leaves a field absent                                               |
| `span.record_provider_tool_calls(response, request=..., servers=...)` | On a `model()` span: one `execute_tool {name}` child span per tool the provider ran itself (OpenAI Responses `mcp_call`, `web_search_call`, `file_search_call`, `code_interpreter_call`; Anthropic `mcp_tool_use` / `server_tool_use` with their results) with `gen_ai.tool.type=extension`, `gen_ai.tool.call.id`, `hue.tool.call.position` (the 0-based position of its item in the response, in both capture modes), `mcp.server.name`, `server.address` from the request's server URL (a host name keeps its underscores, as in the TypeScript SDK), content-gated arguments and result, and `error.type` plus ERROR status on failure; with `capture_content=True` a failed OpenAI MCP call's status description is the provider's error text, credentials scrubbed and cut to 1,024 characters and a `…` as in the TypeScript SDK, then passed to your redactor as `status.message`; an `mcp_list_tools` item becomes a `tools/list` span carrying that server's `gen_ai.tool.definitions`, or only `hue.tool.names` and `hue.tool.definitions.sha256` with `capture_content=False` |
| `span.log_inference(input=..., output=..., system_instructions=...)` | Correlated `gen_ai.client.inference.operation.details` log linked to that span: structured body plus request metadata and session attributes |
| `span.record_file(role=..., media_type=..., data=... or sha256=..., name=..., upload=False)` | `hue.file` event keyed by `hue.file.sha256`, with role, media type and size in both capture modes. Up to 25 MiB of `data` is hashed locally. `upload=True` also stores supplied bytes during export and adds a same-span blob entry keyed `event:hue.file:<sha256>` when content capture and ordinary project credentials permit it. `hue.file.name` requires content capture |
| `span.record_error(error)`                     | Exception type event and ERROR status; context managers also record escaping errors/cancellation                                               |
| `Hue.inject(headers)` / `Hue.extract(headers)` | W3C trace context propagation; pass extracted context to `span(parent_context=...)`                                                            |

To store a file your work reads or produces, see [Record a file](#record-a-file).

Tool/model metadata accepts plain strings; invalid values use stable fallback labels and increment instrumentation failures without invoking custom conversion hooks. Disabled tracing skips metadata validation.

Hue helpers implement the model/tool metadata and inference-message subset of the Development GenAI conventions. They accept caller-supplied JSON without full schema validation. For model helpers, pass the message representation produced by your integration. When authoring your own messages, prefer the shape defined by the GenAI semantic conventions' [input messages](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/gen-ai-input-messages.json) and [output messages](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/gen-ai-output-messages.json) JSON schemas. Use either span content or correlated logs for a given input/output, avoiding duplicate copies. Call `log_inference` inside `model(..., provider=...)`, or pass `operation=` and `provider=` explicitly, to include the required inference metadata. `log_inference` sends a structured body (an explicit `None` field keeps its key with an empty value, distinct from an absent field) and copies `gen_ai.operation.name`, `gen_ai.provider.name` and `gen_ai.request.model` from the enclosing `model()` block, or from its `operation=`, `provider=` and `model=` keywords, plus `gen_ai.conversation.id` from `context()`, onto the record's attributes when known. A blank or over-long keyword is omitted and counted as an instrumentation failure.

## Images, documents and audio

Hue stores the bytes of images, documents and audio apart from the spans and log records that mention them, under the record's trace and named by SHA-256. The record keeps the file's digest in its place and lists the upload in its `hue.blobs` attribute. Files reach Hue in four ways:

| You have | Use | The record carries | `hue.blobs` key |
| --- | --- | --- | --- |
| Files inline in the messages and values your code or instrumentation already records | Nothing: [automatic capture](#automatically-captured-media) | The part, in digest form | `<attribute>#<JSON pointer>` |
| A file to place at a position in a value you record | [`Attachment`](#attach-a-file-anywhere) | A GenAI `blob` part, in digest form | `<attribute>#<JSON pointer>`, or `body#<JSON pointer>` in a `log_inference()` log record |
| A file the work read, received or produced, outside any recorded value | [`span.record_file`](#record-a-file) | A `hue.file` event | `event:hue.file:<sha256>` |
| Files a case's agent and scorers receive in an evaluation | [`add_case(files=...)`](#files-in-evaluation-cases) | An input file pinned on the case | None: case files are artifacts |

[`client.media`](#read-recorded-media-back) reads a recorded file back. Every upload needs `capture_content=True` and a project key (never a setup key, `hue_setup_…`) and follows the redactor: nothing it removes is uploaded, a value it rewrites uploads as rewritten, and an attachment part it rewrites uploads nothing. Uploads share the export's upload budget and the 128 MiB held for values awaiting upload, and fall back without failing the export; a file used more than once in a trace is stored once. See [Values over the inline limit](#values-over-the-inline-limit) for the upload protocol, budgets and fallbacks.

### Automatically captured media

With `capture_content=True` and a project key, the SDK finds the files inline in the attributes Hue reads files from, uploads each file's bytes under the record's trace and leaves the file's digest in its place. On a span's own attributes:

- Messages and values: `gen_ai.input.messages`, `gen_ai.output.messages`, `ai.prompt.messages`, the AI SDK's `ai.prompt`, `input.value` and `output.value` (what `span()` and OpenInference record), `traceloop.entity.input` and `traceloop.entity.output`, and Langfuse's `langfuse.observation.input`, `langfuse.observation.output`, `langfuse.trace.input` and `langfuse.trace.output`.
- Tool arguments and results: `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `ai.toolCall.args`, `ai.toolCall.result`, `tool.parameters`, `tool_arguments` and `tool_response`.
- Metadata: `metadata`, `langfuse.observation.metadata` and `langfuse.trace.metadata` (whole, or one `.<key>` per attribute) and `ai.telemetry.metadata.<key>`. A metadata value is read as JSON when it is an object or array; otherwise it is a file only when the whole value is a `data:` URL.
- Indexed messages: OpenLLMetry's `gen_ai.prompt.<n>.content` and `gen_ai.completion.<n>.content` when the value is the JSON of a parts list (any other content stays text), and OpenInference's flattened `llm.input_messages.<n>.message.contents.<m>.message_content.image.image.url` (and `llm.output_messages.…`), whose value is the image's URL.

Inside those values a file is found by its shape: GenAI `blob`, AI SDK `file` and `image`, OpenAI Chat image, file and audio parts and an assistant message's `audio`, Responses `input_image`, `input_file` and `computer_screenshot`, Anthropic base64 sources, Gemini `inlineData` and `inline_data`, Vertex `media`, Bedrock image and document sources, and any whole string that is a `data:` URL declaring a media type. A tool call's `arguments` and a tool result (a `tool` message's `content`, `tool_result`, `function_call_output`, `tool_call_response`) are JSON in a string by convention, so the files inside them are uploaded too and the string is encoded again, as JavaScript encodes it; a message's own text is never parsed as JSON. Remote URLs, provider file IDs, S3 references and Langfuse media tokens stay unchanged, and Hue never fetches them.

Each uploaded file is listed in the record's `hue.blobs`, keyed `<attribute>#<JSON pointer>`:

- A provider part loses its byte field and carries `sha256` and `size`; the key names the part, for example `gen_ai.input.messages#/0/parts/1`.
- An OpenAI assistant message's `audio` loses `audio.data` and the message carries `sha256` and `size` (`gen_ai.output.messages#/0`). Its media type comes from `audio.format`, else from the bytes' WAV, MP3, AAC, FLAC or Ogg signature, else `application/octet-stream`.
- A whole `data:` URL string becomes a GenAI `blob` part, `{"type":"blob","mime_type":"image/png","modality":"image","sha256":"…","size":68}`, keyed at the string (`input.value#/image`). A value that is entirely one, such as a metadata attribute, becomes that part's JSON text, keyed `<attribute>#`.
- A file inside a JSON-encoded tool string takes the digest form inside the string. Its key goes on through the string, which no JSON pointer can address, so Hue matches it by its digest.
- Text media over 64 KiB of decoded bytes in a provider part keeps a UTF-8-safe 16 KiB prefix in its content field instead, and its key names that field (`gen_ai.input.messages#/0/parts/1/content`). Smaller text and empty fields stay inline.

Entries use the recorded media type and, when valid, the filename, name or title. A valid name is nonblank after trimming, at most 256 UTF-16 code units and well-formed Unicode, with no C0 characters (U+0000–U+001F) or DEL (U+007F). Invalid names are omitted from the entry without rewriting the original field. Data URLs and fields explicitly encoded as base64 by the provider contract are decoded before hashing. Other non-data strings with a valid declared textual media type remain raw UTF-8: `YWJj` hashes as those four characters. The digest matches `span.record_file`'s digest for the same bytes.

A file that is not uploaded (the upload failed, the receiver has no upload route, or a budget ran out) keeps its digest without an entry in the recorded messages (`gen_ai.input.messages`, `gen_ai.output.messages`, `ai.prompt.messages`); in every other attribute it keeps its bytes inline under the ordinary value limit.

Log records upload their media the same way when they are correlated with a span: `log_inference`'s `gen_ai.client.inference.operation.details` record and any `gen_ai.*` event with a structured body. The bytes upload under the log record's own trace and the log record lists them in its own `hue.blobs`, keyed `body#<JSON pointer>` into the body (`body#/gen_ai.input.messages/0/parts/1`, or `body#/content/1` for a deprecated `gen_ai.user.message` event) or `<attribute>#<JSON pointer>` for the attributes above. One step places a log record's files, the attachments in its body included. A body recorded as JSON text stays as it is, and no log value is uploaded whole. A log file that is not uploaded is placed as log records were before they uploaded: a file over 64 KiB in a recorded message attribute becomes its digest and any other file keeps its bytes; text still over the value limit is cut inline and listed under `hue.truncated`. While uploads are available, `log_inference` records a field over the value limit when it fits the limit with its files as their digest.

Inspection is bounded to 8 Mi UTF-16 code units of text per attribute and 16 Mi per record, a log body's file contents included; a longer value uses the ordinary value limit. Inspection parses the value and decodes each file while the record is queued and again when it is exported, holding several copies of the value at once; larger files belong in an `Attachment` or in `span.record_file` with `upload` set, whose bytes are not parsed out of text. Resources, links and span events never upload inline media: in their recorded messages, media up to 64 KiB stays verbatim and larger media is replaced by its digest, as in 0.9, and log records that cannot upload (not correlated with a span, or while uploads are unavailable) keep the same rule. With `capture_content=False`, nothing is inspected or uploaded.

### Attach a file anywhere

Wrap a file in an `Attachment` and put it anywhere in a value Hue records: a `span()` input or output, `model()` messages, a tool's arguments or result, `log_inference()` messages, or a span attribute passed to `span(attributes=...)` or `set_attribute`.

```python
from pathlib import Path

from hue_sdk import Attachment

png = Path("scan.png").read_bytes()
with hue.span(
    "review contract",
    attributes={"metadata": {"scan": Attachment(png, content_type="image/png")}},
) as span:
    span.set_input(
        {
            "question": "Which clauses changed?",
            "contract": Attachment(path="contract.pdf", content_type="application/pdf"),
        }
    )
```

Give exactly one of `data` (bytes, or a base64 string or `data:` URL) and `path` (read when the attachment is created), a `content_type` and optionally a `name`. The bytes are read and hashed when the attachment is created and are limited to 25 MiB, the `record_file` limit: they are held in memory from then until export, within the 128 MiB budget that queued spans share for values awaiting upload.

At its position the attachment is recorded as a GenAI `blob` part that names the file by digest, `{"type":"blob","mime_type":"application/pdf","modality":"document","sha256":"<64 hex>","size":48213,"name":"contract.pdf"}`, with `modality` read from the content type (`image`, `audio`, `video`, `document` or `file`). Export uploads the bytes and lists them under the record's `hue.blobs`, keyed `<attribute>#<JSON pointer to the part>`: `input.value#/contract` above, `metadata#/scan` for the attribute, and `body#/gen_ai.input.messages/0/parts/1` for a part in a `log_inference()` log record, which uploads with the other media in the body. An attribute value that is an attachment, a dict or a list OpenTelemetry cannot hold (not of one primitive type), with or without attachments, is recorded as JSON text, as in the TypeScript SDK; put files under `metadata` for Hue to list them as the span's metadata files.

With `capture_content=False` or a setup key no bytes leave the process: a metadata attribute still records the part, without its name, and content values are not recorded at all. A part the redactor removes or rewrites is not uploaded. A part that cannot be uploaded keeps its digest and is counted in `export_status.upload_fallbacks`, as is one nested more than 10 levels deep in its value, where Hue does not read parts, or one in a value cut to the value limit. Creating an attachment never raises: one without exactly one of `data` and `path`, with unreadable or larger data or an invalid content type is recorded as `None` and counted as an instrumentation issue; an invalid name alone is omitted and counted.

### Record a file

Record a file your work read, received or produced with `span.record_file`. It adds a `hue.file` event keyed by `hue.file.sha256` to the span; pass `upload=True` to store its bytes in Hue as well:

```python
from pathlib import Path

with hue.span("review contract") as span:
    span.record_file(
        role="input", media_type="application/pdf", data=Path("contract.pdf").read_bytes(),
        name="contract.pdf", upload=True,
    )
```

`upload` defaults to `False`. Supplied `data` must be at most 25 MiB. Upload requires supplied bytes, content capture and an ordinary project key; it runs during export and adds a `hue.blobs` entry to the same span, keyed `event:hue.file:<sha256>`, while preserving the event. An export fits every span's events and entries before it uploads any of these files, then uploads the files of all its spans together, four at a time; a file whose event was redacted or shed is not uploaded. Names must be nonblank after trimming, contain at most 256 UTF-16 code units, be well-formed Unicode and contain no C0 characters (U+0000–U+001F) or DEL (U+007F). Tabs, newlines, DEL and lone surrogates make a name invalid. An invalid name is omitted and counted as an instrumentation failure; the otherwise valid event remains. Larger data and invalid records are omitted and counted as instrumentation failures. Pass `sha256` and `byte_size` when you already have the file's identity.

### Read recorded media back

`EvaluationClient.media` reads a recorded file back by its digest, with a key that may read recorded content (**Read** or **Read and write**):

```python
import json
import os
from hue_sdk.evals import EvaluationClient

client = EvaluationClient(api_key=os.environ["HUE_API_KEY"])

# One file by digest; pass the span that recorded it when you know it.
file = client.media.fetch(trace_id=trace_id, span_id=span_id, sha256=sha256)
print(file.content_type, file.file_name, file.size, len(file.data))

# Every digest part of a recorded value, written back in its own field.
recorded = json.loads(attributes["gen_ai.input.messages"])
resolved = client.media.resolve(recorded, trace_id=trace_id, span_id=span_id)
messages, failures = resolved.value, resolved.failures
```

`fetch` asks Hue for a five-minute download link (`GET /api/v1/traces/{traceId}/blobs/{sha256}`), downloads it without the project key and refuses bytes whose SHA-256 is not the digest. It raises `MediaFetchError`, whose `reason` is `not_found` (Hue holds no such file for the trace), `missing` (the trace lists it, but it was never uploaded or has been erased), `unavailable` (still unavailable after one retry that waits out a `Retry-After` of up to 10 seconds), `forbidden` (the key cannot read recorded content), `too_large` (over `max_bytes`, 64 MiB by default, checked before downloading), `digest_mismatch` or `failed` (a connection failure, a timeout or an unexpected answer, retried once). `snapshot_id=` instead of `trace_id=` reads a trace snapshot's pinned copy.

`resolve` downloads each distinct digest once, four at a time (`concurrency`, up to 16), and returns a `ResolvedMedia` with a new `value`; the input is not changed. With `as_="data_url"` (the default) each part receives a `data:` URL where its field takes one (OpenAI `image_url` and `file_data`, Responses `input_image`, `input_file` and `computer_screenshot`, AI SDK `image` and `file`) and bare base64 where its convention requires it (GenAI `blob`, OpenAI `input_audio` and assistant `audio`, Anthropic `source.data`, Gemini `inlineData`, Vertex `media`, Bedrock `source.bytes`), so the messages can be sent to the provider again. A GenAI `blob` or Vertex `media` part that declares a textual media type (`text/*`, JSON, XML, YAML and the like) receives the file's UTF-8 text, as Hue reads that field, or a typed `data:` URL when the bytes are no UTF-8, so recording the value again keeps the same bytes; `as_="bytes"` writes `bytes`. A resolved part no longer carries `sha256` and `size`. A part whose file cannot be read stays as it is and is listed in `failures` with its JSON pointer and reason. Parts inside JSON-encoded strings, such as tool-call arguments, and Langfuse media tokens, which name files Langfuse holds, are left as they are; `fetch` reads the former by the digest the part carries.

### Files in evaluation cases

`add_case` and `add_eval_set_case` pin up to 32 input files on a case with `files=`: artifacts the project already holds, or data and paths the client checks and uploads first. `run_experiment` downloads a case's pinned files before its execution starts and hands the agent-visible ones to the target as `context.files`, and `rehydrate_media(inputs, files)` writes them back into the digest parts of recorded messages copied into the case, so the target can send the recorded model call again with the real image, document or audio. See [Case files](EVALUATIONS.md#case-files).

### Coming from Langfuse or Braintrust

| Langfuse | Braintrust | Hue |
| --- | --- | --- |
| Base64 data URIs in an observation's input, output or metadata | | [Automatic capture](#automatically-captured-media), for the attributes and shapes listed there |
| `LangfuseMedia` | `Attachment` | [`Attachment`](#attach-a-file-anywhere), at the same position |
| `resolve_media_references(obj=..., resolve_with="base64_data_uri")` | | `client.media.resolve(obj, trace_id=...)` |
| `GET /api/public/media/{mediaId}` | `ReadonlyAttachment.data` | `client.media.fetch(trace_id=..., sha256=...)` |
| Media tokens (`@@@langfuseMedia:…@@@`) | `ExternalAttachment` | Left as recorded: Hue never fetches a remote URL or a file another service holds |

## Existing instrumentation

Pass an existing `opentelemetry.sdk.trace.TracerProvider` through `tracer_provider=provider` to add Hue's exporter, and an existing `opentelemetry.sdk._logs.LoggerProvider` through `logger_provider=` when the application already owns one. A provider Hue creates for the other signal reuses the borrowed provider's resource, so spans and correlated logs report the same `service.name`; `service_name` applies only when Hue creates both providers. Hue's processor then exports every span that ends on that provider, the same default as other OpenTelemetry exporters, plus [placeholders](#live-spans) for its running Hue and AI spans; wrap the processor if only part of the provider's spans should reach Hue, and forward `on_start` only for spans whose `on_end` the wrapper forwards unchanged. Session/user identifiers from `hue.context()` are stamped on Hue helper spans only. Hue does not call `set_tracer_provider`. It exposes `hue.tracer_provider`, `hue.tracer` and `hue.logger_provider` for explicit integration. `shutdown()` closes Hue's processors; borrowed providers and their other processors stay usable. Finish traced work before shutting Hue down: spans ending or external records emitted afterward increment Hue's dropped-record counters, including emissions through a borrowed provider. New Hue helpers after shutdown are no-ops. Do not repeatedly attach Hue clients to one long-lived provider: OTel has no public processor-removal API. Create one client per provider lifecycle.

An instrumentor that accepts `tracer_provider` can receive `hue.tracer_provider`; follow that instrumentor's own capture/redaction configuration. OpenInference and other OTel instrumentors are optional dependencies, not implicitly enabled. Hue's export path strips their recognized content attributes when `capture_content` is `False`, but configure their own capture controls as well: unrecognized custom keys pass through, and the instrumentor may still send content to other exporters. The optional compatibility group pins **OpenAI 3.14.0**, **OpenInference OpenAI 0.1.60** and its resolved **OpenInference instrumentation 0.1.63**. A synthetic HTTP streaming response verifies parentage, canonical model/usage attributes and enabled/disabled message capture with `TraceConfig(enable_genai_semconv=True, hide_inputs=..., hide_outputs=..., hide_input_messages=..., hide_output_messages=...)`. This is a tested adapter combination, not a claim about all OpenAI APIs or live-provider compatibility. See the [instrumentor's official source](https://github.com/Arize-ai/openinference/tree/main/python/instrumentation/openinference-instrumentation-openai). See the [Python integration guide](https://docs.hue.run/sdks/python) for application setup.

## Local development without a Hue account

Hue speaks standard OTLP, so any local collector works. Point `base_url` at a loopback receiver that accepts `/api/v1/otlp/v1/traces` and `/api/v1/otlp/v1/logs` (for example an OpenTelemetry Collector `otlp` receiver with `http.traces_url_path` and `logs_url_path` set to those paths, forwarding to Jaeger or the debug exporter) and pass any placeholder `api_key`; HTTP is allowed for loopback origins. `validate_project()` and `verify_trace()` are Hue-only diagnostics and are not available against a generic collector. Set `live_spans=False` so Hue-specific placeholders do not reach the collector's other destinations.

## Export behavior and limits

- Traces go to `/api/v1/otlp/v1/traces`; correlated logs go to `/api/v1/otlp/v1/logs`. Both use the official OTLP HTTP/protobuf exporter with gzip-compressed request bodies and a `hue-sdk-python/<version>` User-Agent ahead of the exporter's own token. The official exporter handles retryable network/service failures; Hue additionally honors 429 and Retry-After within its transport budget. A 429 whose Retry-After outlasts that budget keeps its records queued, within the queue's bounds, and sends them again once the wait has passed; an export holds its records this way for at most 60 seconds in all, and a longer wait loses them, recorded as a failed export issue. A flush or shutdown budget shorter than the hold returns `False` while the held export continues. There is no proprietary provider transport.
- Exporter work and its HTTP worker run with OpenTelemetry instrumentation suppressed. Hue ignores records emitted within that suppressed scope, preventing HTTP instrumentation and exporter diagnostics from feeding back into its own queues. Application instrumentation resumes outside that scope. If an OpenTelemetry release ever stops exposing its suppression key, Hue warns once at import and keeps exporting: its own queues still ignore its export work, but OTel HTTP instrumentors could then record Hue's export requests on other exporters.
- Requests are measured as Hue's receiver measures them: after gzip against its request limit and after decoding against its decoded limit. Until a response advertises its own limits (`Hue-Max-Request-Bytes`, `Hue-Max-Decoded-Bytes` and `Hue-Max-Value-Bytes`, on every acknowledgement and refusal) these are **1 MiB** on the wire, **4 MiB** decoded and **1 MiB** per value; advertised limits are adopted, clamped to 1–64 MiB, 1–64 MiB and 256 KiB–16 MiB, and never exceeded: a request that limits lowered while it was retried or held no longer fit is split and shed again before it is sent. Batches contain at most 64 records, are packed to **4 MiB** before gzip (or the decoded limit, when lower) and are split at record boundaries when they compress worse than the wire limit allows.
- A value over the value cap that is not uploaded (see [values over the inline limit](#values-over-the-inline-limit)), in any record (helper content, a third-party instrumentation's attribute, a log body), is cut to a UTF-8 prefix before enqueue, bytes are replaced by the receiver's marker (`{"hue.truncated": true, "hue.truncated_bytes": <size>}`), and its key is listed under `hue.truncated`, never omitted for its size; an inference log's body field over the cap is still omitted and counted, since its prefix is no JSON, unless uploads are available and the field fits the cap with its files as their digest. Tool definitions and recorded requests have their credentials removed from the whole value before that cut. A record still over the receiver's limits sheds its content values, largest first, each replaced by the marker and listed, until it fits; only a record too large without any content value is lost, recorded as a dropped export issue. Records a trace lost (dropped from a queue, too large without their content, or refused for their rate past the hold) are counted on its root span as `hue.sdk.dropped_records` when the root is exported, so Hue reads the trace as incomplete by that many records.
- A tracer provider Hue creates keeps **2,000** attributes, events and links per span and attributes per event and link (OpenTelemetry's default is 128), unless the environment sets OpenTelemetry's own limit (`OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT`, `OTEL_ATTRIBUTE_COUNT_LIMIT`, `OTEL_SPAN_EVENT_COUNT_LIMIT`, `OTEL_SPAN_LINK_COUNT_LIMIT`, `OTEL_EVENT_ATTRIBUTE_COUNT_LIMIT`, `OTEL_LINK_ATTRIBUTE_COUNT_LIMIT`), which wins. Log records and externally configured providers keep OpenTelemetry's limits. A span whose events or links do not all fit the queue's byte budget keeps its newest ones and counts the rest in its dropped event and link counts, rather than being dropped whole.
- Hue accepts at most **2,000 distinct spans per trace**. This is enforced by the receiver across distributed producers; the client cannot guarantee a global count.
- HTTP errors, malformed/non-200 success responses and OTLP `partial_success` rejected counts cause a failed export status. Partial rejection is not retried wholesale. Receiver error text is not echoed. A warning-only partial-success response with zero rejected records remains successful. A request carrying only [live-span placeholders](#live-spans) never fails the status.
- `force_flush(timeout_millis=30000)` drains both processors and returns `False` for a timeout, failed export, dropped record or instrumentation omission since this client was created. Hue's processors honor the shared deadline and serialize drains in a bounded background worker. Pending exports continue after timeout. `export_status` exposes cumulative failure counters. `shutdown()` stops new helpers, drains and closes owned exporters within the caller's wait budget; repeated calls wait for the same shutdown. After a timeout, keep the process alive and call shutdown again to confirm completion. Context-manager exit calls `shutdown_safe(timeout_millis=1000)`; check flush explicitly when an exit code must reflect delivery failure.
- Hue processors use the public OTel interfaces and bound each signal to 2,048 records and 8 MiB of encoded telemetry by default, including in-flight records (`max_queue_size`, `max_queue_bytes`). Dropped records and instrumentation omissions make cumulative `export_status.ok` false. Queue overflow, process termination and sampling can lose telemetry. Flush success reports observed exporter outcomes, not durable local delivery or proof that every application operation was instrumented. The exporter timeout controls individual export/retry operations. A caller timeout does not cancel an HTTP request already in flight; background workers continue until the operation completes.
- A timed-out HTTP worker can retain one encoded request, up to the receiver's request limit, per signal outside the queue counters. Later records remain queued within the configured limits until that worker finishes; shutdown counts any queued records it must discard. Queue bytes are not total process memory.
- A flush timeout releases drain coordination so later flushes can make progress. Both signals share the caller's remaining wait budget, including time spent waiting for another flush. Shutdown's exporter cleanup can continue after the caller returns without holding that coordination lock. Repeated shutdown calls report current failures and drops as well as cleanup completion.

## Values over the inline limit

Hue keeps a value inline up to its value limit (1 MiB unless the receiver advertises another in `Hue-Max-Value-Bytes`). A span's own string attribute larger than that (helper content such as `input.value`, `output.value` and tool results, or another instrumentation's attribute), and the files described in [Images, documents and audio](#images-documents-and-audio), are uploaded to Hue apart from their record, up to Hue's upload limit of 1,000,000,000 bytes:

1. Export computes the SHA-256 of the value's bytes (a string as UTF-8, a file as its own bytes) and reserves it with `POST /api/v1/otlp/blobs`, authenticated with the project key. Hue answers that it already stores the value under the trace, and nothing is uploaded, or with a presigned URL.
2. The bytes go straight to the project's evidence store in one `PUT` to that URL, streamed with exactly the headers Hue signed and never the project key (over HTTPS, or plain HTTP to a loopback store), and the upload is confirmed with `POST /api/v1/otlp/blobs/complete`. A PUT the store answers with 412 (the same value uploaded at the same time by another span) counts as stored.
3. Whole string values and large text media keep a UTF-8-safe 16 KiB prefix. Binary media keeps its digest on the part. The record lists stored values in `hue.blobs`, at most 64 compact JSON strings with fields ordered `key`, `sha256`, `size`, `content_type` and optional `name`: `{"key":"output.value","sha256":"<64 hex>","size":5242880,"content_type":"application/json"}`. A whole value is listed under `hue.truncated` as well, since its inline text is a prefix.

Hue stores the value under the trace, so the trace's retention, deletion and erasure cover it. Uploads run on the export worker, never on the application's thread: at most four at a time on daemon threads, each request within `export_timeout_seconds`, and all of one export's uploads within six of them; a transient failure is retried once, and a rate-limited reservation (429) waits out its `Retry-After` within the export's 60-second hold. A value not uploaded in time falls back; its upload, if still running, stops sending at the same deadline and its answer goes unused.

A value that cannot be uploaded (Hue or the store refused it or failed, the network or a deadline did, the receiver has no upload route, or the value is over 1 GB) falls back according to its form: whole attributes keep a prefix up to the cap and are listed under `hue.truncated`; media parts keep their digest without a blob entry; failed opt-in `record_file` uploads preserve the file event. The explicit helper limit is 25 MiB; whole attributes retain their 1 GB limit. Each export records such values in a `warning` export issue per cause, whose `count` is the values and `trace_ids` their traces, and counts them in `export_status.upload_fallbacks`; successful uploads are counted in `export_status.uploaded_values`. Both counters include whole attributes, eligible binary or large text media, attachments, and opt-in `record_file` uploads. A warning is not a failure: it does not affect `export_status.ok`, `force_flush()` or `export_failure_sequence()`. After a transient failure, or a refusal that is not about the value alone, uploads pause for 30 seconds, and a receiver without the upload route (a 404 that is not Hue's, a 405 or 501, or a 200 that is no reservation) is not asked again for 10 minutes, so an unavailable store or another OTLP receiver meets no retry storm. An upload still sending when its export's upload budget ends stops there.

To upload a value whole, the queued copy of its span holds it until export apart from `max_queue_bytes`, within a 128 MiB budget of held values (each charged as the interpreter holds it); a recorded message holding eligible media is held the same way, while the queue is charged its copy with the files as their digest. A value the budget cannot hold, or one queued while the receiver is known to lack the upload route, is cut (its files digested) when it is queued, as before, and reported as not uploaded, once per file; a single value larger than the whole budget is held while nothing else is. The queued copy lets go of its held values once export has placed them.

Nothing is uploaded with `capture_content=False` or a setup key (`hue_setup_…`), nor from links, resources, log records not correlated with a span or in-progress placeholders; a log record uploads only its files and the attachments in its body (see [Automatically captured media](#automatically-captured-media)). Span events upload only through explicit `record_file(upload=True, ...)`; other event values are cut as before. The redactor runs on helper content before it is queued, and the credential scrub of tool definitions and recorded requests runs on the whole value before it is hashed, so a value they rewrite is uploaded as rewritten.

## Live spans

OpenTelemetry exports a span only when it ends, so a long agent turn or model call would otherwise stay invisible until it finishes. When a Hue helper span or an AI span is still open at the export worker's next 0.5 s tick, Hue queues a placeholder: a standard OTLP span whose parent is the running span, with its name, kind, start time and current attributes, an end time of `0`, `hue.span_type = "pending_span"` and `hue.pending_parent_id` (the running span's own parent, omitted for a root). Hue shows the span as running and replaces the placeholder when the finished span arrives. Input set right after entering, such as `set_input`, is included.

The placeholder then waits for the worker's next export like any queued span: up to 0.5 s until the next tick, then the 1 s export delay when nothing else is queued, so it usually reaches Hue within about 1.5 s of its span starting. It goes out sooner when an export is already scheduled, for example because another span has just ended, and at once for 64 queued records or `force_flush()`. It goes out later while an earlier export is still in flight, because the worker runs the next tick and starts the next 1 s delay only after that export returns. A placeholder whose span ends before it is exported is not sent, so a short span may send none and appear in Hue only when it finishes.

- Only spans from `hue.tracer` (every helper) and spans with a `gen_ai.`, `ai.`, `llm.` or `traceloop.` attribute at start, or a name starting with `ai.`, are announced. HTTP, database and other framework spans are not.
- Placeholders follow the same `capture_content` policy as finished spans, so recognized content attributes are stripped from them too when it is `False`. Tool definitions, system instructions and any value over 64 KiB are left out; the finished span still carries them. The markers are written last, and these reserved keys are removed from finished spans.
- Apart from that policy (`capture_content=False` strips recognized content keys) and those omissions, a placeholder carries the running span's attributes as they stand when it is queued. `redactor=` rewrites the value passed to `set_input` or `set_output` before it is set on the span, so placeholders carry the redacted value. Any other sensitive attribute, such as custom metadata or a value recorded by an instrumentor, must be scrubbed where it is recorded: the finished span carries it too, so `live_spans=False` does not keep it from Hue. That option only prevents the placeholder's earlier copy, for example of a value the span overwrites before it ends.
- Placeholders are advisory. At most 1,024 open spans wait to be announced, and each is announced once. A placeholder is queued only while the queue is under a quarter of its record and byte budgets and is skipped silently otherwise, so placeholders use at most a quarter of the queue. While queued they count in `queued_trace_records` and `queued_trace_bytes`, but never as dropped or failed telemetry.
- Placeholders travel in their own requests, after an export's finished spans, so a rejection count is always one kind of record's: a finished span's rejection is never credited to a placeholder, and a rejected request of placeholders never fails the export status. This needs a Hue deployment that accepts placeholders; it marks every trace acknowledgement with `Hue-Pending-Spans: 1`. The first trace acknowledgement without the header, whatever its request carried, comes from a generic collector or an older Hue: the SDK sets `export_status.live_spans_rejected` (a warning that does not affect `ok`) and stops announcing spans for the rest of that client's life, so a receiver that acknowledged finished spans first never receives a placeholder.
- Pass `live_spans=False` to send none. Setup keys (`hue_setup_…`) never announce spans.
- A processor wrapper that forwards `on_start` to Hue should also forward `on_end` for the same spans. Hue builds each placeholder from the running span itself, so code in the wrapper's `on_end` never runs on it: if the wrapper scrubs attributes, renames the span or drops it there, a placeholder exported while the span is still open is sent anyway, with the span's original name and its attributes after `capture_content`. A dropped span is then forgotten and its unsent placeholder discarded, but one already sent can leave the span shown as running. Do not forward `on_start` for spans you scrub, rename or drop, or pass `live_spans=False`.

## Dependencies

The tracing core depends on the official OpenTelemetry packages and `requests` only. JSON Schema
scoring (`builtin_scorers.json_schema`) runs `jsonschema` in an isolated process and needs the optional
extra; without it `builtin_scorers.json_schema` raises `ImportError` and stored schema scorers report
`SchemaValidatorUnavailable`:

```bash
pip install 'hue-run[evals]'
```

Import the bundle as `from hue_sdk.evals import builtin_scorers`. The `builtins` name remains as an
alias for parity with TypeScript, but it shadows the standard-library module of the same name inside
any file that imports it.

See [THIRD_PARTY_NOTICES.md](https://github.com/hue-run/hue-sdk/blob/main/THIRD_PARTY_NOTICES.md) for licenses.

## Confirm a trace reached Hue

`Hue.verify_trace()` checks a server receipt for a known trace from a real application request.
It does not send a synthetic trace, invoke a model, or flush an exporter. Finish the request,
then flush the provider that produced it. If you borrow a provider, call its `force_flush()`
first, then check Hue's `force_flush()` result before verifying:

```python
# Retain these IDs while your application's instrumented request runs.
# After the request finishes and the relevant providers have flushed:
confirmation = hue.verify_trace(
    request_trace_id,
    expected_span_ids=[request_span_id, model_span_id],
    required_fields=["input", "output", "model", "usage", "session"],
    timeout_millis=10_000,
)
if confirmation.verified:
    print(confirmation.receipt.trace_url)
else:
    # The latest partial receipt, or None if this trace has not appeared yet.
    print(confirmation.receipt)
```

Only require fields your instrumentation emits and your capture policy permits. For metadata-only
capture, omit `input` and `output`. The receipt contains presence booleans and counts, not captured
content. `verified=True` confirms the requested trace, every supplied expected span, and every
required field; it does not prove that unlisted application operations were instrumented. Missing
spans or fields continue polling until the deadline, then return `verified=False` with the latest
receipt. Trace IDs must be nonzero and contain 32 lowercase hexadecimal characters; expected span
IDs must be nonzero, contain 16, be unique, and number at most 100. The timeout must be positive
and at most 60,000 ms.

Only trace-not-found responses, HTTP 429 and HTTP 503 are retried. Authentication, unsupported
receipt endpoints, malformed responses and connection failures raise `TraceVerificationError`
with a safe `code` and optional `status_code`; response bodies and keys are omitted. Redirects
are rejected. The deadline covers connection, polling and response-body reads. An in-flight network
read may finish in the background after the caller times out. This helper requires a Hue deployment
that implements `/api/v1/traces/{traceId}/receipt`.

## Supported runtimes and verification

Python 3.10+ is supported. CI tests Python 3.10 and 3.14, source imports and an independently installed wheel. Tests use synthetic loopback HTTP receivers and decode official OTLP protobuf messages to verify trace/log correlation, metadata-only capture, redaction, propagation, existing-provider ownership, authentication failures, redirects, partial rejection, retries, encoded request limits and live-span placeholders, including their downgrade against a receiver without the `Hue-Pending-Spans` header. Compatibility tests also exercise local evaluations and the optional OpenInference adapter. No live model provider is required for these checks.

See the [documentation](https://docs.hue.run/sdks/python) for integration guidance and [troubleshooting](https://docs.hue.run/guides/troubleshooting) for export failures.

## Simulated worlds

`hue_sdk.environment.EnvironmentClient` drives Hue's World API: create a world after the case's
execution starts, hand the agent the provider mirror URLs and the world token (never the project
key), finish and `wait_for_seal` before the execution completes, and read the sealed world's
evaluator-only evidence.

```python
import os
import subprocess

from hue_sdk.environment import EnvironmentClient, agent_environment, mcp_config_file, world_handoff

client = EnvironmentClient(api_key=os.environ["HUE_API_KEY"])
run = client.create_run(
    idempotency_key=f"execution:{execution_id}",
    environment_version_id=version_id,
    execution_id=execution_id,
    ttl_seconds=600,
    traceparent=f"00-{span.trace_id}-{span.span_id}-01",
    agent_revision="my-agent@1.4.2",
)
world = None
try:
    world = world_handoff(run)
    if world is None:  # the deployment's gateway is off: this run has Hue-native actions instead
        client.finish_run(
            run["id"], idempotency_key=f"execution:{execution_id}:abandoned", status="abandoned"
        )
        raise RuntimeError("this deployment does not serve simulation worlds")
    child = agent_environment(world)  # os.environ minus Hue control-plane credentials, plus the carriers
    with mcp_config_file(world) as path:  # owner-only mcp.json, removed after the block
        subprocess.run(agent_command, env={**child, "MCP_CONFIG": path}, check=True)
finally:
    if world is not None:
        finished = client.finish_run(
            run["id"], idempotency_key=f"execution:{execution_id}:completed", status="completed"
        )
        client.wait_for_seal(run["id"], completing_until=finished.get("completingUntil"))
evidence = client.get_evidence(run["id"], section="ledger")
```

`agent_environment` removes `HUE_API_KEY`, `HUE_MCP_KEY` and any value carrying a Hue control-plane
credential (`hue_sk_`, `hue_setup_`, `hue_attempt_`, `hue_mcp_`, `hue_inv_`, `hue_install_`,
`hue_at_`, `hue_rt_`, `hue_oauth_`) anywhere in it, including wrapped, percent-encoded or
JSON-Unicode-escaped values, unless
`include_hue_credentials=True`; world tokens and `hue_sim_` capabilities pass. For one compatibility
release it also sets `HUE_MCP_URL`, `HUE_MCP_TOKEN` and `HUE_MCP_EXPIRES_AT` from the first MCP
mirror. Nothing here logs the token. The world has its own date: `world["now"]` (also `HUE_WORLD_NOW` in the child's
environment) is the world's clock at creation, a trace-built world's recorded start, and
`world_now()` reads it as an aware `datetime` from a handoff or from the environment. An agent
that computes "today", "tomorrow" or `newer_than:7d` from it lands on the recorded dates however
long after the recording the run starts; one that reads the wall clock does not. The client waits Hue's `Retry-After` on 429 and 503 before retrying, and sends a read, or a mutation keyed by `idempotencyKey`, again after a connection failure, a timeout or a 408 or 5xx without the header, up to `max_attempts` (default 4) times; `is_transient_api_error` names those failures. Refusal errors expose a validated `HueEnvironmentError.diagnostic` from `X-Hue-Diagnostic` when the server sends one; the code distinguishes refusals with the same status without exposing response bodies.

## Managed targets

Start a frozen dataset run in Hue while your existing agent stays in your application:

```python
import os
from hue_sdk.managed import ManagedTargetHandler, ManagedTargetResult

def target(invocation):
    # Your function consumes unchanged inputs and verified attachment bytes.
    result = run_agent_for_evaluation(invocation)
    return ManagedTargetResult(output=result)

handler = ManagedTargetHandler(
    machine_credential=os.environ["HUE_MANAGED_TARGET_SECRET"],
    target=target,
    tracer=hue.tracer,  # Required with a Hue-owned client: Hue never sets a global tracer.
    flush_telemetry=hue.force_flush,  # Existing client; False keeps telemetry pending.
)
```

Without `tracer`, the handler falls back to the global OpenTelemetry tracer, its span is not
recorded and every invocation returns `uncertain`.

Your POST route calls `handler.handle(raw_body_bytes, request_headers)` and returns
its JSON body, status code and headers. Limit request bodies to 1 MiB; use
`asyncio.to_thread` from an async route. The target must honor `cancelled` and
`deadline_monotonic`. Use a 120-second host limit for the default 90-second callback
and 30-second finalization budget.

For generated files, return `ManagedOutputFile` entries containing actual bytes,
filename, content type and an optional primary flag. Managed outputs accept the same 22
content types as TypeScript: PDF, DOCX, PPTX, XLSX, `application/json`, `text/plain`, `text/csv`,
`image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/avif`, `audio/mpeg`, `audio/wav`,
`audio/ogg`, `audio/webm`, `audio/mp4`, `audio/flac`, `audio/opus`, `audio/aac`, `video/mp4`
and `video/webm`. Any other output content type, such as `audio/pcm`, records the invocation
as an error before any upload. Give an `.mp4` file `audio/mp4` or `video/mp4`, and a `.webm` file
`audio/webm` or `video/webm`, to match its content: the extension alone does not say which. The
helper claims the invocation, verifies files and saves the outcome without automatically rerunning
the agent. See the [managed-run guide](https://docs.hue.run/evaluations/managed-runs)
and [full adapter contract](https://github.com/hue-run/hue-sdk/blob/main/packages/sdk-python/MANAGED_TARGETS.md) for registration, existing-provider
flush callbacks and recovery. Local/CI runners remain available.

## Serving safely

Use `create_hue_safe` for best-effort startup and `enabled=False` for a local kill switch. The safe constructor returns a disabled client and records an instrumentation failure if initialization fails. Disabled helpers execute application work without exporting. Initialize after fork, once per serving process. `force_flush_safe(timeout_millis=1000)` and `shutdown_safe(timeout_millis=1000)` return booleans without raising; monitor those results and `export_status`. Keep strict project validation and receipt/delivery checks out of customer request paths. Never rerun application work to recover telemetry.

Queue bytes bound retained telemetry rather than total RSS. Network waits have a wall-clock caller bound and at most one retained HTTP worker per signal; a stuck OS call can outlive that wait. Arbitrary user hooks and third-party instrumentation retain their own behavior. See [production setup](https://docs.hue.run/sdks/python#production-setup) for lifecycle examples, failure tests and limitations.
