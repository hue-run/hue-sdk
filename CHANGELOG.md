# Changelog

Both packages follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the pre-1.0 rules in
[VERSIONING.md](./VERSIONING.md): a `0.MINOR` release may contain **Breaking** entries with migration
notes; a patch release adds or fixes without changing capture semantics, default budgets or the wire
format. Entries marked **Wire** change emitted attributes, events or endpoints. The release workflow
refuses to publish a version without a matching entry below.

## @hue-run/sdk (TypeScript)

### [0.21.0] - 2026-10-20

#### Breaking

- `hue eval` runs up to four cases concurrently by default in one-shot and worker modes,
  rather than one. Migration: pass `--concurrency 1` for serial execution. Explicit values
  from 1 to 100 still take precedence. Case files and environments stay isolated. Existing
  agent registrations and checkpoints remain compatible with earlier serial runs.
- `hue eval` requests its run's pinned `llm_judge` evaluators by default after outputs upload.
  Migration: pass `--no-judges` to keep the previous default. `--judges` remains accepted.
  `--no-output` skips automatic judge requests, and explicitly combining it with `--judges`
  remains an error. Preflight, runs without a pinned model judge, and judge creation alone
  start no model jobs. Interrupted dispatch retains its existing idempotency and recovery.
  Switching to `--no-judges` or `--no-output` with a pending dispatch stops before another
  agent run and requires recovery with the original flags.

#### Added

- **Wire** HTTP tool spans accept endpoint evidence from the request, resolved client configuration, or receipt. URLs exclude credentials and fragments, redact query values by default, and follow the content-capture and redaction policies. An explicit allowlist can retain permitted routing query values. Instrumentation records the existing execution without another lookup or tool call.
- **Wire** `hue.subagent(name, callback, options)` runs a sub-agent inside an `invoke_agent {name}`
  span carrying `gen_ai.operation.name` `invoke_agent`, `gen_ai.agent.name` and the new
  `hue.agent.role` `subagent`. The span nests under the active span, normally the `tool()` span
  of the call that started the sub-agent, or under `options.parentContext`, so the sub-agent's
  model and tool spans sit inside it. In another process, `hue.extract(headers)` of the
  `traceparent` that `hue.inject()` wrote continues the caller's trace. `options.input` and the
  callback's result follow `captureContent` as `input.value` / `output.value`; errors are recorded
  as in `withSpan`. The calling agent's role stays explicit: set `hue.agent.role` `orchestrator`
  on its own span to label it.

#### Changed

- Update the certified OpenTelemetry dependencies to `0.223.0` / `2.12.0` and the AI SDK adapter pair to `7.0.137` / `1.0.137`. The exporter User-Agent version follows the locked exporter dependency. Babel stays on 7 to preserve Node 22.12 support.

### [0.20.8] - 2026-10-19

#### Fixed

- Exports work when a framework bundles the SDK into its server, as Next.js (Turbopack and
  webpack) does by default. The transport loaded `node:http` or `node:https` through one dynamic
  import with a computed specifier, which bundlers replace with a throw, so every export failed
  with `Hue telemetry request failed` and no status while plain Node was unaffected. Both modules
  are now literal imports, and the package verifier rejects a computed specifier in any module an
  application bundles. `serverExternalPackages` is no longer needed.

#### Changed
- `hue login` prints next steps that fit the repository: `hue mcp install --client` names the one client whose configuration the root holds (`.mcp.json` or `.claude`, `.cursor`, `.vscode`, `.codex`, `.gemini`, `.windsurf`) and otherwise lists the clients; the `hue eval` hint shows `./hue-agent.ts` for a TypeScript repository, `--command` for a Python one and nothing when the language is unknown.
- The optional Vercel AI SDK peers widen to `ai@^6.0.0 || ^7.0.0` and `@ai-sdk/otel@^1.0.0`. `hueTelemetry` uses only the per-call `integrations` option and `OpenTelemetry({ tracer, usage })`, present since `ai@7.0.0` / `@ai-sdk/otel@1.0.0`, so apps on other AI SDK 7 patch releases no longer get peer warnings. The installed-package tests still run the `7.0.99 / 1.0.99` and `7.0.100 / 1.0.100` pairs.
- `verifyTrace` adds `project` to a result without a receipt once Hue reports the trace missing: the project the key searched (`checkConnection()` shape), so a key for another project is told apart from a trace that is not stored yet. `verified` and `receipt` are unchanged.
- `hue login` warns on stderr when the shell already exports a different `HUE_API_KEY`, naming the project each key resolves to and never the keys: loaders such as `uv run --env-file` and dotenv keep the exported value over the env file.

### [0.20.7] - 2026-10-18

#### Changed

- `hue traces import prepare` matches the import limits current servers accept: one import takes
  up to 25,000 traces (was 10,000), a trace up to 512 batches (was 64) and 10,000 large values
  (was 1,000), and the manifest up to 32 MiB decoded (was 8 MiB). A manifest over 4 MiB
  compressed, the most a registration takes, is refused by `prepare` and by `upload` before
  anything is sent. The import authorization `prepare_trace_import` returns now lasts a day (was an
  hour); renewal, spans per trace, batch size, two requests at a time and the import's week are
  unchanged.

### [0.20.6] - 2026-10-18

#### Added

- **Wire** `hue import langfuse` also sends the environment Langfuse recorded for an observation,
  or a v1 trace, as recorded in `hue.import.source_environment` on its span, beside
  `langfuse.environment`. Hue's World capture reads it as import provenance: an imported trace adds
  to its user's World only when the trace itself declares production, and never when any of its
  spans names another environment, such as Langfuse's `default`. An observation without an
  environment carries neither attribute, and the resource still declares no deployment
  environment. Hue refuses a different payload for a span it already holds, so finish an import
  started with an earlier version with that version.

### [0.20.5] - 2026-10-18

#### Fixed

- **Wire** `hue traces import prepare` names a trace converted from ATIF, the Agent Trajectory
  Interchange Format, by the format alone: its spans carry `hue.import.format` `atif` under the
  instrumentation scope `hue.import.atif`, and the run's agent span is `invoke_agent <agent.name>`
  from the export's own `agent.name` (`invoke_agent` when it names none). 0.20.2 through 0.20.4
  wrote one producer's name into all three. The conversion's identity seed changes with the
  label, so the trace and span ids derived from an ATIF export differ from the ids those versions
  derived: prepare such a bundle again before uploading it, and do not mix bundles prepared by
  both. `gen_ai.agent.name` and `service.name` are unchanged; they already come from the export.

### [0.20.4] - 2026-10-18

#### Added

- `JudgeBudget`, which `getJudgeBudget()` returns, types the optional `organizationBudget` that
  current servers report: the organization's monthly AI budget (`monthlyAllowanceUsd`,
  `actualSpendUsd`, `reservedUsd`, `unresolvedUsd`, `unresolvedCalls`, `remainingUsd`,
  `periodStart`, `resetsAt` and `paused`; amounts as decimal USD strings), or `null` when there is
  none to report, and the optional `organizationAvailableMicroUsd`. Older servers omit both; the
  existing fields are unchanged.

### [0.20.3] - 2026-10-18

#### Added

- `hue eval` runs an eval set that mixes cases pinning a World with cases pinning none as one
  run: each case takes its own kind's path (a fresh World through the simulation adapter, or the
  direct adapter), under one experiment and one `mixed` checkpoint identity that a direct or
  simulation run of the same selection neither resumes nor is resumed by. A World case a crashed
  run left running runs again in a fresh World; a direct case it left running stays uncertain, as
  before. `--mode simulation` over such a set is still refused before a run exists, and `--check`
  reports `mode: "mixed"` with `worldCases` and `directCases`. Before, the set was refused.

### [0.20.2] - 2026-10-18

#### Added

- `hue traces import prepare <path> --out <directory> --json` converts files, directories or ZIP
  archives of OTLP/JSON trace exports, complete Langfuse observation exports and text ATIF v1.7 and
  v1.8 exports into gzip OTLP/JSON batches beside an immutable `manifest.json`, and prints the
  manifest digest and totals that Hue MCP's `prepare_trace_import` takes. `hue traces import upload
  <directory> --authorization-file <file> --json` delivers the bundle to Hue's import routes with the
  short-lived `hue_it_` authorization that tool returns, two requests at a time and in order within a
  trace, confirms every span's receipt, and resumes from `progress.json` after an interruption. No
  project key is involved.
- `agentEnvironment` strips `hue_it_` import authorizations from an agent child's environment like
  the other Hue control-plane credentials (`HUE_CONTROL_PLANE_CREDENTIAL_PREFIXES`).

### [0.20.1] - 2026-10-18

#### Added

- `WorldClient.createWorld`, `listWorlds` and `getWorld` provide canonical registry method names.
  Existing environment methods and routes remain supported.
- World model results and errors expose optional typed processing and preparation progress.

#### Fixed

- World model errors retain only validated progress fields from at most 16 KiB of response data.
  Insufficient-evidence and processing-limit diagnostics stop unchanged retries. Ordinary transient
  failures keep their existing retry behavior.

### [0.20.0] - 2026-10-18

#### Changed

- **Breaking** World materialization, instance creation and reproduction now wait up to 120 seconds
  when Hue explicitly reports `world_preparing`, separately from the ordinary `maxAttempts` limit.
  Retries preserve the request body and idempotency identity. Migration: pass `{ signal }` to cancel
  a preparation wait or active request. Other failures retain the configured attempt limit.

#### Added

- **Wire** `hue eval --judges` explicitly requests the run's pinned hosted model judges after outputs
  upload, in direct, simulation and worker modes. It is off by default, uses the project's judge
  budget, and supports `--wait 0`. Interrupted dispatch resumes saved outputs with stable
  idempotency keys instead of running the agent again, even if the project's judge budget is
  later disabled. The upload handoff is durable before run completion. Workers discard terminal
  claim handoffs and keep accepting runs after a post-dispatch verdict-read failure.
- `runSimulation` and `runLocalAgent` accept an optional `onUploaded` callback before their
  completion marker or queue acknowledgement, for resumable application handoffs.
- The World client names, `WorldModelClient` and instance methods use the canonical World,
  World model and instance routes. The environment module
  and its HTTP paths remain supported. The handoff's legacy `worldId` still identifies an instance.


### [0.19.1] - 2026-10-16

#### Changed

- **Wire** An attribute Hue reads as JSON whose whole text is a `data:` URL instead is read as that file, as Hue's reader reads it: it uploads in the background and becomes a digest-form `blob` part keyed `<attribute>#`. This is what a Langfuse SDK records for a string input or output, such as `observation.update({ output: "data:audio/wav;base64,…" })` on a provider that also carries Hue's span processor; before, the base64 was exported inline. Other text that is not JSON stays as recorded. `hue import langfuse` places such an observation's file the same way before it sends the span.
- **Wire** Raw 16-bit PCM keeps the format its media type declares. A file typed `audio/pcm`, `audio/x-pcm` or `audio/L16` with a `rate` from 8000 to 192000 and 1 or 2 `channels` (a `data:` URL's header or a part's declared type) is reserved and listed as `audio/pcm;rate=<rate>;channels=<n>` (`audio/L16;…` for big-endian samples), and OpenAI `pcm16` audio as `audio/pcm;rate=24000;channels=1`, so Hue plays the stored file; the part's own fields stay as recorded. Before, the parameters were dropped and the file could only be downloaded.

#### Fixed

- A file upload's PUT answered with no reply, 408, 429 or a 5xx now waits its `Retry-After` (up to 60 s) before the next attempt, as 0.19.0 described; before, it waited the 1 s then 2 s backoff.

### [0.19.0] - 2026-10-16

#### Changed

- **Breaking** **Wire** File and large-value uploads no longer hold up export, as with Langfuse and Braintrust. Export hashes each value, writes its reference into the record (the digest part, or the 16 KiB prefix with `hue.truncated`, and its `hue.blobs` entry), sends the record, and uploads the bytes in the background. A slow, rate-limited or failing upload never delays, holds or drops a span or log record, and spans recorded after an upload started are sent as soon as their own flush or batch runs. Hue shows the file once its bytes land; until then it reads the entry as not uploaded. A value refused when its record is exported (uploads ended by shutdown, a receiver without the upload route, over 1 GB, or the upload budget full) keeps the earlier fallback form. Migration: call `flush()`, `shutdown()` or the `Safe` variants before the process exits, with a budget that covers your uploads.
- **Breaking** Uploads no longer share an export's 60-second rate-limit hold or upload budget, and the 30-second upload pause after a failure is removed. Each reservation and PUT is tried up to three times on no answer, 408, 429 or 5xx, waiting `Retry-After` (up to 60 s) or 1 s then 2 s with jitter, and gives up its upload slot while it waits; the completion is sent once. At most four uploads run at once and 4,096 are queued; each ends within six export timeouts plus 60 s of being queued (2 minutes at the defaults). The 128 MiB budget for values awaiting upload also covers uploads not yet finished.
- **Breaking** `flush()`, `shutdown()` and the span and log processors' `forceFlush()`/`shutdown()` (attach mode included) send their records first, then wait for the uploads queued before them, bounded by each upload's lifetime. `report.uploadedValues` counts an upload when it completes; `report.uploadFallbacks` also counts uploads that failed after export, reported in their own warning.
- **Wire** A `hue.blobs` entry's `content_type` is the type its own reference declared. `hue import langfuse` still stores each file before it sends the span, with Hue's stored type.
- **Wire** A receiver without the upload route (a local OpenTelemetry Collector) is remembered for the life of the client, so only records exported before its first answer list entries it never stores.

#### Fixed

- `hue import langfuse --media` downloads only links that use HTTPS, carry no credentials or fragment, fit in 8192 characters and reach a public address (or the configured Langfuse host), and checks each redirect the same way, up to five. 0.18.2 fetched any `http`/`https` link the Langfuse media record named and followed redirects anywhere, so a hostile or compromised Langfuse deployment could make the import request addresses on the user's machine or network (such as `169.254.169.254`) and upload the answers to Hue. A refused link fails its file and holds the span back, with the reason reported. With the Langfuse host on this machine, any address is accepted, and plain HTTP to this machine.

### [0.18.2] - 2026-10-13

#### Added

- `Attachment({ path })` and `recordFile({ path })` take a regular file over 25 MiB, up to Hue's 1 GB upload limit: the file is hashed a 1 MiB slice at a time when it is recorded and read again from disk when it is uploaded, so it is never held in memory and does not count against the 128 MiB budget for values awaiting upload. Each slice is hashed as it is sent and the last is sent only once the file ended at the size and SHA-256 it was recorded with; a file that changed, is gone or is no longer a regular file by then is not uploaded, without waiting on a named pipe in its place (the request ends before its body is complete, and Hue's upload URL signs the size and SHA-256, so the store refuses other bytes) and counts in `report.uploadFallbacks`, its part or event keeping the digest it was recorded with. `recordFile` takes `path` in place of `data` (not both); a file up to 25 MiB given by path is read when it is recorded, as `data` is. Bytes given in memory (`data`) keep their 25 MiB limit, since they are held until export. Uploads follow `captureContent`, setup credentials, `redact` and fallback counting as before. All uploads of one export share its upload budget, six export timeouts (60 seconds at the default `timeoutMillis` of 10000), so a 1 GB file needs about 17 MB/s at the defaults; raise `timeoutMillis` (up to 60000) for slower links.

#### Fixed

- **Wire** Inline media in a span's own attribute past the media inspection bounds (8 Mi UTF-16 code units for one attribute, 16 Mi for a record) is uploaded as files: 0.18.1 uploaded such a value whole as JSON text, its first 16 KiB inline, so a model call's 10 MB base64 audio part reached Hue inside that text instead of as an audio file. An attribute held whole for upload past the bounds (it is over the value limit) now has its media read in place when it is exported: each string in it longer than 16 Ki code units and written without escapes as strict base64 or a base64 `data:` URL is decoded, hashed and uploaded a 1 MiB window at a time from the recorded text, never parsed or copied out of it, up to Hue's 1 GB upload limit, and the value is placed exactly as one within the bounds: the same digest form, `hue.blobs` entries and fallbacks, every other byte of the recorded text kept. The scan reads the value a window at a time between turns of the event loop; at 300 MB of audio the longest event-loop stall during the flush is about 50 ms (Node 24) and the flush holds about 3 MB beside the value (13 MB on Bun 1.4.2). The JSON around those strings, files written with escapes or inside a JSON-encoded string included, is parsed within the 8 Mi bound; a value past it, or one whose long file is a percent-escaped `data:` URL, still uploads whole. Admission parses nothing more on the application's thread; each such value's JSON is read within the 8 Mi bound on its own, apart from the record's 16 Mi allowance, while the value stays held within the 128 MiB budget for values awaiting upload, and fallback counting and the exporter's request limits are unchanged. Log records keep the bounds. The shared corpus gains cases with files of 6.3 MB in both SDKs.
- Placing many files in one value no longer takes time quadratic in them: 20,000 edited parts took about 11 seconds and now take well under one. Uploading a text or a source reuses one buffer for its slices, so an export no longer leaves a slice of garbage per MiB sent (on Bun 1.4.2 that grew with the value).
- A path that is not a regular file, such as a named pipe or a device, no longer blocks the application: `Attachment({ path })` and `recordFile({ path })` open it without waiting and refuse it, an invalid attachment recorded as `null` and a refused file omitted, each counted as an instrumentation failure. A named pipe given by path used to block the caller until something wrote to it.

### [0.18.1] - 2026-10-12

A limitation that 0.18.0 already had and that this release keeps: an `Attachment` in a value that is still over the value limit with its files as digest parts is uploaded and listed under `hue.blobs` at `<attribute>#<pointer>`. Its bytes are stored, and `client.media.fetch({ traceId, sha256 })` and Hue's span read reach them by digest. The value itself uploads whole and keeps only its first 16 KiB inline, so readers do not place the file at its position in the value.

#### Added

- **Wire** `hue import langfuse` copies a Langfuse project's traces into Hue from your machine, with the Langfuse project's own keys (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` from the environment or `--env-path`, never the command line; `LANGFUSE_BASE_URL` or `LANGFUSE_HOST`), which go only to Langfuse. It reads the Observations API v2 (Langfuse Cloud and self-hosted v4) or, where that answers `404`, the v1 traces and observations API (self-hosted v3), newest first, selected by start time (`--from`, and `--to`, which defaults to an hour before the command starts so traces still running are left for a later run), `--limit` or `--trace-id`. Each observation becomes the completed span a Langfuse OpenTelemetry SDK records, with `langfuse.observation.*` (type, input, output, one `metadata.<key>` per key, level, status message, model, model parameters, usage and cost details, completion start, prompt), `langfuse.trace.name` and `.tags`, `langfuse.user.id`, `langfuse.session.id`, `langfuse.release`, `langfuse.version`, `langfuse.environment`, `gen_ai.request.model` and the input and output token counts; a v1 trace also becomes a span of its own with `langfuse.trace.input`, `.output`, `.metadata.<key>` and `.public`. Hex Langfuse ids are kept and other ids derived from them with SHA-256 (the originals kept as `langfuse.trace.id` and `langfuse.observation.id`), so running the same command again resumes an import without duplicates; nothing sent depends on the run: no root carries `hue.sdk.dropped_records`, and before a span is sent its inline files and its values over the 1 MiB inline limit are stored with the exporter's own placement, so a failed upload holds the span back instead of leaving a value inline or cut. Spans are exported through the SDK's transport with its content-capture default (`--no-content` sends metadata only), its queue drained every 1,024 spans or 32 MiB. `--media` downloads the files Langfuse media references (`@@@langfuseMedia:…@@@`) point to, up to 25 MiB each, uploads them under the trace and places them in the SDK's digest form listed in `hue.blobs` under `<attribute>#<JSON pointer>`; a reference without bytes stays as recorded, and a file that cannot be copied now holds its span back for the next run. `--dry-run` counts without a Hue key, Langfuse `429` answers are waited out by `Retry-After`, and the exit code is `1` when a trace, span or file was not imported. The Python SDK has no counterpart.

#### Fixed

- **Wire** A text file that a GenAI `blob`, Vertex `media` or AI SDK `file` or `image` part holds as bare base64 is read as Hue reads it: its decoded bytes are measured against the 64 KiB inline limit, uploaded and placed in the digest form, keyed at the part. Base64 is the encoding the GenAI conventions give `blob` content, and what `client.media.resolve` and `rehydrateMedia` write back into a `blob` or `media` part for every media type; 0.18.0 read such content as the text itself whenever its media type was textual, so recording a resolved 72,000-byte text file again uploaded its base64 text and kept that text's first 16 KiB. Content that does not read as base64 (a length divisible by four, base64 characters only) is still the file's own text and keeps the 16 KiB prefix form; a `data:` URL and a field its convention declares base64 are read as before.
- A refused `client.media.fetch` of a snapshot's copy (`MediaFetchError` reason `forbidden`) says that a snapshot's files need a Read and write key; its message named a Read or Read and write key, which is what a trace's files need. `MediaFetchError` takes a `snapshot` option that selects this message.
- `CaseWrite.files` given as a `path` (`addCase`, `addEvalSetCase`) are no longer all held in memory at once: each file is hashed in 1 MiB slices when the case is checked and read again when it is uploaded, one file at a time, so 32 files of 25 MiB no longer peak at about 850 MiB. Only bytes that match the checked size and SHA-256 are sent, as in 0.18.0 only the checked bytes were; a file that changed after its check, or can no longer be read, sends nothing: the write throws `TypeError` (`Case file N changed after it was checked`, or `could not be read`) and the case is not written. The upload's requests, `Content-Length`, reservation keys and checks are unchanged; bytes given in memory are used as before.

### [0.18.0] - 2026-10-12

#### Breaking

- **Wire** Inline media is found and uploaded beyond the three recorded message attributes. On a span's own attributes the SDK now also reads the AI SDK's `ai.prompt`, `input.value` and `output.value` (what `withSpan` records), `traceloop.entity.input`/`output`, Langfuse's `langfuse.observation.input`/`output` and `langfuse.trace.input`/`output`, the tool keys `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `ai.toolCall.args`, `ai.toolCall.result`, `tool.parameters`, `tool_arguments` and `tool_response`, the metadata keys `metadata`, `langfuse.observation.metadata[.<key>]`, `langfuse.trace.metadata[.<key>]` and `ai.telemetry.metadata.<key>`, OpenLLMetry's `gen_ai.prompt.<n>.content` and `gen_ai.completion.<n>.content` parts lists, and OpenInference's flattened `llm.input_messages.<n>.message.contents.<m>.message_content.image.image.url` (and output). An uploaded file takes the digest form in place, listed in `hue.blobs` under `<attribute>#<JSON pointer>`. A file in one of these attributes that is not uploaded keeps its bytes inline, as in 0.17.0. Files are read only where Hue's reader reads them: no deeper than ten levels below a value's root, not in attribute JSON Hue keeps as text (nested past 32 levels, or holding an integer past 2^53), and not in an OpenInference `input.value` or `output.value` declared `text/plain` by `input.mime_type` or `output.mime_type`. The same holds for the recorded message attributes (`gen_ai.input.messages`, `gen_ai.output.messages`, `ai.prompt.messages`): a message attribute holding an integer past 2^53 (or nested past 32 levels), or a part more than ten levels deep, now keeps its media inline where 0.17.0 uploaded it or replaced it by its digest, because Hue keeps such JSON as text and never reads those files. Migration: a reader of these attributes finds `sha256` and `size` where inline bytes were and resolves the bytes through the entry (or `client.media`); Hue reads every form.
- **Wire** Placing a file changes only its own value (a whole `data:` URL string) or the members of the part that held it (its content removed, `sha256` and `size` set); every other byte of the recorded JSON text, its key order, number spellings, escapes and spacing included, is kept, in the recorded messages too. 0.17.0 wrote a message attribute's JSON again as `JSON.stringify` writes it. Migration: none for a JSON reader; a reader that compared the text byte for byte sees the recorded spacing kept.
- **Wire** A whole string that is a `data:` URL declaring a media type, anywhere inside an inspected value, is uploaded and replaced by a GenAI `blob` part, `{"type":"blob","mime_type":…,"modality":…,"sha256":…,"size":…}`, keyed at the string's pointer; a metadata value that is entirely one becomes the part's JSON text, keyed `<attribute>#`. Text data URLs up to 64 KiB stay inline. Migration: read the part, or the entry, for the file.
- **Wire** New provider shapes upload: an OpenAI Chat assistant message's `audio` (the message carries `sha256` and `size`, `audio.data` is removed, the entry is keyed at the message, typed by `audio.format` or the bytes' signature) and a Responses `computer_screenshot`. Files inside a tool call's `arguments` or a tool result's JSON-encoded string are uploaded and take the digest form inside the string, the rest of the string kept byte for byte; Hue matches them by digest. In the recorded messages, such files keep their digest without an entry when they are not uploaded, as other message parts do.
- **Wire** Log records correlated with a span upload their media: `recordMessages`' `gen_ai.client.inference.operation.details` record and any `gen_ai.*` event with a structured body, under the log record's trace, listed in the log record's own `hue.blobs` with keys `body#<JSON pointer>` (for example `body#/gen_ai.input.messages/0/parts/1`) or `<attribute>#<JSON pointer>` for the attributes above; its inline media take the 64 places before the attachments in its body. In 0.17.0, a log record's media up to 64 KiB stayed inline and larger media became its digest without an upload. A log file that is not uploaded is placed as in 0.17.0: a file over 64 KiB in a recorded message attribute becomes its digest and anything else keeps its bytes; text over the value limit is still cut inline and listed under `hue.truncated`, and no log value is uploaded whole. `recordMessages` records a body over the value limit when, with its files as their digest, it fits the limit while uploads are available; 0.17.0 refused such a body. Migration: a log reader that takes a body's inline bytes reads the digest form and the entry instead.

#### Added

- **Wire** `Attachment` places a file anywhere in a recorded value, the equivalent of Langfuse's `LangfuseMedia` and Braintrust's `Attachment`: `new Attachment({ data | path, contentType, name })` in a `withSpan()` input or output, `model()` messages, a tool's arguments or result, `recordMessages()` messages, or a `withSpan()` attribute (`SpanOptions.attributes` accepts an attachment, a JSON object or an array OpenTelemetry cannot hold, with or without attachments, recorded as JSON text). It is recorded at its position as a GenAI `blob` part in digest form, `{"type":"blob","mime_type","modality","sha256","size","name"}`, and its bytes are uploaded during export and listed under the record's `hue.blobs` as `<attribute>#<JSON pointer>`; in a `recordMessages()` body it uploads with the body's other media, under `body#<JSON pointer>`. `data` accepts bytes or a base64 string or `data:` URL; `path` is read when the attachment is created; both are limited to 25 MiB. Uploads follow `captureContent`, setup credentials, `redact`, the upload budget and fallback counting of other media; a part nested more than 10 levels deep keeps its digest without an upload. An invalid attachment is recorded as `null` and counted as an instrumentation failure; an invalid name alone is omitted and counted.
- **Wire** `EvaluationClient.media.fetch({ traceId, sha256, spanId? })` reads one recorded file back by digest through `GET /api/v1/traces/{traceId}/blobs/{sha256}` (`{ snapshotId, sha256 }` reads a trace snapshot's pinned copy), downloads the short-lived link without the project key and refuses bytes whose SHA-256 is not the digest. It returns `{ bytes, sha256, size, contentType, fileName }` and throws `MediaFetchError` with a `reason` (`not_found`, `missing`, `unavailable`, `forbidden`, `too_large`, `digest_mismatch`, `failed`); an unavailable answer is asked once more after its `Retry-After` of up to 10 seconds, as is a request whose connection fails or times out; an answer over 64 KiB fails at once, even when its connection then fails; a redirect fails with its status, a plain HTTP link is taken only to a host written `localhost`, `127.0.0.1` or `[::1]`, and the download times out only when no byte arrives within its timeout. A trace's files need a Read or Read and write key, a snapshot's a Read and write key. This is the counterpart of Braintrust's `ReadonlyAttachment` and Langfuse's media fetch.
- `EvaluationClient.media.resolve(value, { traceId | snapshotId, spanId?, as?, blobs? })` writes the bytes of every digest part in a recorded value back into the part's own field, as a `data:` URL or the bare base64 its convention requires (`as: "dataUrl"`, the default; a GenAI `blob` or Vertex `media` part receives base64 for every media type) or as a `Uint8Array` (`as: "bytes"`), downloading each distinct digest once with bounded concurrency; `blobs`, the record's `hue.blobs` entries in any form Hue reads (JSON strings, objects, or one string holding the JSON array), gives a part that declares no media type its entry's type (a snapshot's copy carries none). It returns a new value with the parts it could not read listed in `failures`, like Langfuse's `resolveMediaReferences`; a part holding only the first 16 KiB of a text file over 64 KiB, its content field named by an entry, is never written and is listed as `prefix_only` with the entry's SHA-256, whose whole file `media.fetch({ traceId, sha256 })` returns. Parts inside JSON-encoded strings, such as tool-call arguments, are left as they are.
- `rehydrateMedia(inputs, files)` writes a case's local files back into the digest parts of its inputs by SHA-256, so a target can send a recorded model call again with the real image, document or audio.
- **Wire** `CaseWrite.files` pins up to 32 input files on `addCase` and `addEvalSetCase`: `{ artifactId, role }` references, or files given as `bytes` or a `path` that the client checks against the artifact policy (content type, a name of 1 to 255 UTF-16 code units, 1 byte to 25 MiB) and uploads as verified artifacts under keys that make a repeated write reuse them and a corrected name or content type reserve a new one. The whole case is checked before the first upload, each artifact is pinned once per role, and an `artifactId` given with file fields, or a `path` that cannot be read, is refused with a `TypeError`.

#### Changed

- A direct case's evaluator-only input files are removed when the case ends, so no later case's target can read them; the agent's own files still stay for inspection.
- A case that fails after its target finished (fetching the scorers' files, uploading the target's files) saves the count of spans it ended with its outcome, so a resume completes it under required trace evidence once the trace's receipt holds them, instead of refusing for want of the count. The target is never run again.

### [0.17.0] - 2026-10-10

#### Breaking

- **Wire** Nonempty binary media in a span's own recorded message attributes is now eligible for upload at every size within the media inspection limits and exports as the part's `sha256` and `size`. The `hue.blobs` key points to the part, for example `gen_ai.input.messages#/0/parts/1`. Successful uploads previously kept a 16 KiB prefix in the byte field and pointed to that field. Text media over 64 KiB still keeps a 16 KiB UTF-8 prefix and a content-field entry. Upload failures retain the digest without a blob entry. Migration: readers must resolve the part-level entry for binary media. Hue reads both forms.
- `hue.file.name` now uses the same rule as blob names: nonblank after trimming, at most 256 UTF-16 code units, well-formed Unicode, and no C0 characters (U+0000–U+001F) or DEL (U+007F). Migration: remove tabs, newlines and DEL from names, and limit astral characters to 128 when the name contains only those characters. An invalid `recordFile` name is omitted and counted as an instrumentation failure; the otherwise valid `hue.file` event remains. Existing role, media-type, digest and size validation is preserved.

#### Added

- Recorded media supports GenAI, AI SDK, OpenAI Chat and Responses, Anthropic, Gemini, Vertex and Bedrock shapes, including OpenAI content arrays. The three inspected attributes remain `gen_ai.input.messages`, `gen_ai.output.messages` and `ai.prompt.messages`. Remote URLs and file IDs stay unchanged; the SDK never fetches them.
- Blob entries preserve a valid recorded filename, name or title. Names must be nonblank after trimming, contain at most 256 UTF-16 code units, be well-formed Unicode and contain no C0 characters (U+0000–U+001F) or DEL (U+007F).
- `recordFile({ upload: true, ... })` uploads supplied file data up to 25 MiB and adds a `hue.blobs` entry to the same span, keyed `event:hue.file:<sha256>`. The existing `hue.file` event remains. Upload defaults to false and is disabled by `captureContent: false` or setup credentials. A requested upload that is not made, for example because its event was redacted or its span was dropped, counts in `uploadFallbacks`. An export uploads the files of all its spans together, four at a time, within one upload budget; copies of one file in a trace share a single upload and never hold a place another file needs.
- **Wire** Generated evaluation files now accept `image/gif`, `image/avif`, `audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/opus`, `audio/webm`, `audio/mp4`, `audio/aac`, `audio/flac`, `video/mp4` and `video/webm` in addition to the existing content types: the same 22 types Hue stores as artifacts. `hue eval --command` collects `.gif .avif .mp3 .mpeg .wav .ogg .m4a .flac .opus .aac .mp4 .webm` outputs. An `.mp4` or `.webm` output needs its type declared in `manifest.json` `contentTypes` (`audio/mp4` or `video/mp4`, `audio/webm` or `video/webm`); the extension alone does not distinguish audio from video.

#### Changed

- The 8 Mi bound on one inspected message attribute counts UTF-16 code units, like the 16 Mi per-record bound, instead of UTF-8 bytes.
- **Wire** Recorded message attributes on resources follow the rule events, links and log records keep from 0.16: inline media up to 64 KiB stays verbatim and larger media becomes its `sha256` and `size`, as in the Python SDK. These nested values never upload.

### [0.16.0] - 2026-10-08

#### Added

- `hue eval --check` resolves the key's project, the selection, the case kind and the agent, prints what the run would do and exits without creating a run, a world or a checkpoint. `--json` prints it as one `check` object. A selection that mixes world and answer-only cases is refused, by `--check` and by the run, before anything is created.

#### Changed

- `zod` is a regular dependency instead of an optional peer, so `npx -y @hue-run/sdk@0.16.0 eval` runs without a second `--package "zod@…"`; `hue` is the package's only binary, so npx needs no `--package … hue`. Migration: nothing is required; a project that installed `zod` only for the SDK may remove it.
- `hue eval` loads `./.env.hue`, the file `hue login` writes, when no `--env-file` is named and the shell has no `HUE_API_KEY`; a key already in the shell keeps its own origin, so a checkout's file cannot redirect it. The `hue login` next-step hint drops `--env-file .env.hue` for the default file.
- `hue eval`, `runSimulation()` and the worker print run links as `/runs/<id>`; `--baseline` accepts both `/runs/<id>` and legacy `/experiments/<id>` URLs.
- An interrupted `hue eval` (Ctrl+C or SIGTERM) leaves its run open instead of finishing it with the case in flight scored as cancelled, and prints that the same command resumes it. Rerunning it keeps the finished cases and runs the interrupted ones again as a new attempt, in a fresh world for a world case. `runExperiment()` and `runSimulation()` behave the same when their `signal` aborts: no further case starts, the experiment stays unfinished and the call rejects with `TargetCancelledError`.
- A checkpoint lock left by a crashed or killed process is reclaimed once that process has exited on the same machine, and a world case it left running runs again as a new attempt in a fresh world; an answer-only case it left running stays uncertain, since its agent may still be acting. A lock whose owner may still be running still refuses. Before, every leftover `.lock` had to be removed by hand.

### [0.15.3] - 2026-10-08

#### Fixed

- The optional `zod` peer accepts `^3.25.76 || ^4.6.5`. `@hue-run/sdk/evals` now imports `zod/v4`, which zod 3.25.76 and later also ship, so npm installs the SDK next to zod 3 applications (including AI SDK 6 and 7 apps) without `--legacy-peer-deps`.

### [0.15.2] - 2026-10-08

#### Fixed

- Trace and log exporters retry transient HTTP 500 responses within the existing retry and timeout budgets.

### [0.15.1] - 2026-10-07

#### Changed

- `runExperiment()`, `rescore()`, `runLocalAgent()`, simulations and `hue eval --concurrency`
  (one-shot and `--worker`) accept up to 100 cases in flight (was 64), so a 100-case eval set can
  run as one wave. The default stays 1. Cases that use Hue worlds also count toward the project's
  live-world quota, which every run and worker in the project shares.

#### Fixed

- The evaluation guide and the `RunLocalAgentOptions.concurrency` documentation give the enforced
  bound; since 0.8.0 they had still said 1–16.

### [0.15.0] - 2026-10-06

This release follows Hue's receiver limits and uploads values over its inline limit to Hue, which
changes default value, request, queue and wait budgets and what export sends (see Breaking), so it
is a `0.MINOR` release. `hue eval` also needs a decision from each required evaluator before a case
passes.

#### Breaking

- **Wire** A span's own string attribute over Hue's inline value limit (helper content such as
  `input.value`, `output.value` and tool results, or another instrumentation's attribute) is
  uploaded to Hue apart from the span, up to 1,000,000,000 bytes: reserved with
  `POST /api/v1/otlp/blobs` under the project key (skipped when Hue already stores the value
  under the trace), sent straight to the project's evidence store with the presigned `PUT` Hue
  answers, and completed. The span keeps the value's first 16 KiB and lists it in the new
  `hue.blobs` attribute, one compact JSON object per value (`key`, `sha256`, `size`,
  `content_type`), and under `hue.truncated`. Uploads run in the export, at most four at once,
  within six export timeouts per export, retried once, with a 429 waited out within the export's
  60 s hold. A value that cannot be uploaded is exported cut as before, reported as a `warning`
  issue per cause (its `count` the values, `traceIds` their traces) and counted in the new
  `ExportReport.uploadFallbacks`; uploads are counted in `ExportReport.uploadedValues`. A
  transient failure, or a refusal that is not about the value alone, pauses uploads for 30 s, and
  a receiver without the upload route (a 404 that is not Hue's, a 405 or 501, or a 200 that is no
  reservation) is not asked again for 10 minutes. Nothing is uploaded with
  `captureContent: false`, a setup credential, or from log records, events, links, resources or
  placeholders. `redact` and the credential scrub run on the whole value first; the uploaded bytes
  are their answer. Migration: none for Hue, which reads an uploaded value whole from `hue.blobs`;
  the span's own attribute keeps 16 KiB of it rather than a prefix up to the value limit. Where
  egress is restricted, allow export's HTTPS `PUT` to the upload URLs Hue answers, or such values
  fall back to the cut and are reported.
- **Wire** An inline file over 64 KiB in a span's own recorded messages (`gen_ai.input.messages`,
  `gen_ai.output.messages`, `ai.prompt.messages`) is uploaded with its part's media type and keeps
  the first 16 KiB of its `content`/`data` in place, listed in `hue.blobs` as
  `<attribute>#<JSON pointer>` (`gen_ai.input.messages#/0/parts/1/content`), instead of being
  replaced by its `sha256` and `size`. A file that is not uploaded, and one in a log record or a
  span event, is still exported as its digest. Migration: none for Hue, which reads the file from
  `hue.blobs`; a reader that expected the digest in place finds the file's first 16 KiB there and
  its `sha256` and `size` in `hue.blobs`.
- A span's own string over the value cap, and a recorded message of its own holding an inline
  file over 64 KiB, is held whole in the queue until export, within a 128 MiB budget of held
  values apart from `maxQueueBytes`, instead of being cut (or its files digested) when queued;
  `maxQueueBytes` is still charged what the cut or digested copy would cost. A value the budget
  cannot hold, or one queued while the receiver is known to lack the upload route, is cut (its
  files digested) when queued as before, and reported as not uploaded, once per file. While
  values can be uploaded, helpers encode content whole (up to 1 GB and 1,048,576 values) instead
  of cutting it at the cap when they record it, and `redact` sees the whole value. Migration: allow
  for up to 128 MiB of held values beside `maxQueueBytes` in the process's memory limits, and for a
  `redact` that sees whole values. A client with `captureContent: false` holds and uploads nothing.
- Processors and a client's own providers wait up to six export timeouts longer for an export,
  the uploads' budget. A `shutdownSafe()` whose budget runs out ends uploads in flight too; their
  values are exported cut. Migration: allow for the longer drain in job and shutdown timeouts, or
  bound shutdown with `shutdownSafe()`'s budget.
- **Wire** Content values are kept whole up to 1 MiB, the value limit Hue's receiver stores,
  instead of being cut at 256 KiB. A value over it is still cut to a UTF-8 prefix (bytes and a
  structured log body replaced by the receiver's marker) and listed under `hue.truncated`.
  Migration: none for Hue's receiver, which stores values up to 1 MiB; another OTLP receiver behind
  `baseUrl` must accept them or advertise its own `Hue-Max-Value-Bytes`.
- **Wire** Requests are measured as Hue's receiver measures them: after gzip against its request
  limit (1 MiB) and after decompression against its decoded limit (4 MiB), instead of 1 MiB before
  gzip, which was up to four times stricter. Batches are packed to 4 MiB before gzip; a batch over
  the wire limit is sent in halves, and a single record over a limit sheds its largest content
  values as before, finding how many with a number of encodings logarithmic in its values rather
  than one encoding per value shed. A record that compresses well is no longer shed for its size
  before gzip. Migration: none for Hue's receiver; another OTLP receiver behind `baseUrl` must
  accept requests of 1 MiB after gzip that decode to 4 MiB, or advertise its own limits (next
  entry).
- The limits a response advertises in `Hue-Max-Request-Bytes`, `Hue-Max-Decoded-Bytes` and
  `Hue-Max-Value-Bytes`, on any status, are adopted for later requests, value cuts and helper
  content, clamped to 1–64 MiB, 1–64 MiB and 256 KiB–16 MiB; a lower limit is adopted as readily
  as a higher one. Batches stay at 4 MiB, or the advertised decoded limit when that is lower; only
  a single record that needs more travels alone in a larger request. A request that limits
  lowered while it was retried or held no longer fit is split and shed again before it is sent.
  Migration: none; the limits change only for a receiver that sends these headers.
- A request Hue refuses with HTTP 429 and a `Retry-After` longer than the request deadline keeps
  its records queued, within the queue's bounds, and is sent again once the wait has passed; an
  export holds its records for at most 60 s in all. Before, the batch was lost. A longer wait loses
  the records at once, reported as a `failed` issue with status 429 and counted on the trace's root
  span as `hue.sdk.dropped_records`. A root reads its trace's count when its request is made, so
  one sent later in the same export carries such losses, and its acknowledgement consumes only
  the count it carried. `flush()` and `shutdown()` wait for a held export, and a
  client's own providers allow for the hold when they drain. When `shutdownSafe()`'s budget runs
  out first, a client that owns its providers ends the hold and reports its records lost the same
  way, so the hold does not keep the process running. Migration: allow up to 60 s more for `flush()`
  and `shutdown()` in job and shutdown timeouts, or bound shutdown with `shutdownSafe()`'s budget.
- **Wire** A client's own tracer provider keeps 2,000 attributes, events and links per span and
  2,000 attributes per event and link, and its logger provider 2,000 attributes per log record,
  instead of OpenTelemetry's 128, which silently dropped the rest of a long conversation's
  flattened messages. Providers an application attaches Hue to keep their own limits. One record
  may hold 1,048,576 values when it is queued and exported, up from 16,384, so a span with 2,000
  events of several attributes each is exported; the queue's byte budget still bounds it. A span
  whose events or links do not all fit that budget keeps its newest ones and counts the rest in
  its dropped event and link counts, where before the whole span was dropped. Migration: none for
  most applications, since the queue's byte budget still bounds a span; attach Hue to a provider of
  your own to keep other limits.
- `collectExperimentVerdicts` and `hue eval` need a decision from every applicable outcome evaluator
  (`world_outcome`) and every judge version pinned with `config.required: true`, as the experiment's
  immutable scorer versions define them. A required result that is skipped, or scored without a
  pass/fail metric, leaves the case inconclusive (`skipped`, shown as `INCONCLUSIVE`, exit 1)
  instead of letting the other evaluators pass it (exit 0), and a required judge's result is never
  advisory, whatever its evidence says. A recorded failure takes precedence over an error from a
  required evaluator, so such a case is `failed` rather than `error` (exit 1 either way). Genuine
  not-applicable results and judges that are not required keep their behavior. Migration: allow for
  exit 1 where a required evaluator cannot decide a case, and read the case's explanations for why
  it did not.

#### Added

- `summarizeVerdicts` accepts `scorerVersions`, the experiment's immutable pinned definitions;
  outcome evaluators and judge versions with `config.required: true` among them need a decision
  before a case passes, as in `collectExperimentVerdicts`. Without it, results are summarized as
  before.

#### Changed

- A string far over the value cap is cut when its record is queued, to the cap and 64 Ki code
  units of context, rather than charged to `maxQueueBytes` whole: a span holding a value of
  millions of characters is exported with the value cut instead of being dropped before the cut
  ran. `redact` still sees text past the cap; for a text cut when queued, the last 64 Ki code
  units of its answer are never exported, so a secret it saw without its continuation is not
  sent. Tool definitions and recorded requests cut there have their credentials removed from the
  whole value first; one too long to parse within what the record's budget has left is replaced
  by the receiver's marker instead, as in the Python SDK.
- `recordProviderToolCalls` turns up to 1,024 items of a response into spans, up from 128; the
  rest are still counted as skipped.
- Helper content (`setInput`, `setOutput`, `hue.tool`, `recordMessages`) may hold 65,536 values,
  up from 16,384, so a structured value of many small members is cut at the 1 MiB cap rather than
  omitted for its count.

#### Fixed

- `EvaluationClient` and `EnvironmentClient` keep the project API key in a runtime-private field, so
  `JSON.stringify`, object spread, `Object.keys` and `util.inspect` no longer reveal it.

### [0.14.0] - 2026-10-05

#### Breaking

- Enabled clients and transports capture supplied content by default when `captureContent` is omitted. Pass `captureContent: false` for metadata-only export; existing explicit choices and redaction continue to apply. `hue eval` now captures telemetry content by default; use `--no-content` to opt out. To resume an older metadata-only run, repeat its output policy and add `--no-content`.

### [0.13.2] - 2026-10-05

#### Fixed

- `hue eval --worker --command` runs cases with or without a world, including mixed eval sets,
  using the same command from the application's launch directory. Direct cases receive no world
  credentials; stale inherited world/MCP settings and environment-run identity are stripped.
  **Wire** Command workers also register `direct:v1`; restart an existing environment-only
  registration with a new `--revision`, because capabilities are fixed per agent revision.
- Public evaluator definitions accept the current answer-only pins (`hue.answer_outcome.v1/v2`)
  and gateway-world pins (`hue.outcome_assertions.v4/v5/v6`), preserving their metric and judge contracts.
- Adapter-file workers retain their environment-only default and can opt into their direct
  context (`mode: "direct"`, no world or tools) with `--capability direct:v1`.

### [0.13.1] - 2026-10-04

#### Added

- Optional per-metric descriptions in TypeScript scorer declarations; publishing them requires a
  Hue server that accepts metric descriptions.
- Tags on datasets, scorers and experiments, by name: `tags` on `createDataset`, `createScorer`
  and `createExperiment` (and `createEvalSet`, `createEvaluator`, `createRun`), a `tags` filter on
  the registry lists, `updateDataset`, `updateScorer` and `updateExperiment` (and `updateEvalSet`,
  `updateEvaluator`, `updateRun`) to replace them, and `listTags`. They require a Hue server that
  supports tags.

#### Fixed

- `agentEnvironment` strips every Hue control-plane credential from inherited values, including
  wrapped, percent-encoded and JSON-Unicode-escaped forms, while preserving world tokens and
  `hue_sim_` capabilities.

### [0.13.0] - 2026-10-02

#### Added

- A target's throw on a service that refused it is completed with the service's own word for what
  failed as the error's `cause`, when its answer names one: Hue's simulation gateway's diagnostic
  (`authorization_unavailable` when Hue could not authorize the world token because its database
  could not answer, `gateway_failure`), read from the answer's `x-hue-diagnostic` header or its
  JSON body's `diagnostic` through the error's `cause`, `lastError` and `errors` chains, and from
  Hue's own clients' `diagnostic`. `TypedError.cause` carries it; Hue shows it beside the
  infrastructure or configuration label, so a run refused on its first call reads as what refused
  it. `serviceFailureCause` exposes the reading beside `serviceFailureType`.
- The MCP SDK's transport errors (`StreamableHTTPError`, `SseError`), which carry the HTTP status
  as `code` and no response, are read as the exchange they are: a simulated server that answered a
  5xx through an agent's MCP client completes the case as `ServiceRefused`, counted as
  infrastructure, where before it was the agent's `TargetError`; a 4xx (a bad world token, an
  unknown route) stays the agent's.
- `EnvironmentRun.now` and `WorldHandoff.now`: the world's clock at creation as an RFC 3339
  timestamp (a trace-built world's recorded start), read from the World API's `now` or from
  `HUE_WORLD_NOW` in its `env`, which `agentEnvironment` and `hue eval --command` pass to the
  agent with the world's other carriers. `worldNow()` reads it as a `Date` from a handoff or from
  an environment, so an agent computes "today", "tomorrow" or `newer_than:7d` from the world's date
  and lands on the recorded dates however long after the recording the run starts. Null or absent
  from a Hue that predates it.

#### Changed

- **Breaking:** `captureContent: false` also removes Langfuse's content attributes before export:
  `langfuse.observation.input`, `langfuse.observation.output`,
  `langfuse.observation.status_message`, `langfuse.observation.model.parameters`,
  `langfuse.trace.input` and `langfuse.trace.output`, with their dotted children, from every
  record Hue exports, beside the GenAI, OpenInference, OpenLLMetry and Vercel AI SDK content it
  already removed. Langfuse's model name, usage and cost details, observation type, session and
  user identifiers, trace name, release, environment and `metadata.*` keys are metadata and stay;
  `contentPrefixes` lists the six. **Wire** Migration: an application that set
  `captureContent: false` and relied on Langfuse inputs and outputs reaching Hue sets
  `captureContent: true`; Langfuse's own export is unaffected.
- **Wire** A content value over Hue's 256 KiB value cap is no longer a reason to lose the record.
  Text is cut to a UTF-8 prefix and bytes or a structured log body are replaced by the receiver's
  own marker (`{ "hue.truncated": true, "hue.truncated_bytes": <size> }`), and the value's key is
  listed in the record's `hue.truncated` attribute, where Hue's receiver lists the values it cuts
  itself. This holds for a helper's own content (`hue.tool`, `setInput`, `setOutput`) and for any
  attribute a third-party instrumentation set on a span exported through Hue's processors, such
  as an AI SDK tool result. Before, the helper omitted the value and counted a failure, and the
  exporter rejected the whole span as invalid, so a 300 KB tool result lost the tool call, the
  model call that followed and the turn's root span.
- **Wire** A record over the 1 MiB request limit on its own sheds its content values, largest
  first, each replaced by the receiver's marker and listed under `hue.truncated`, until it fits.
  Only a record too large without any content value is still lost; it is counted on its trace's
  root span as `hue.sdk.dropped_records` when the root is exported, so Hue reads the trace as
  incomplete by that many records rather than as whole. The count is forgotten only once the
  request carrying the root is acknowledged, so a root written again says the same.
- **Wire** A structured helper value cut at the cap (`hue.tool`, `setInput`, `setOutput`) is cut
  to a UTF-8 prefix of its JSON text at exactly the cap, inside whichever member the cap fell in,
  never to a shorter document of its first members that would read as the whole value.

#### Fixed

- Live-span placeholders travel in their own requests, after an export's completed spans, so a
  rejection count is always one kind of record's: a completed span's rejection is never credited
  to a placeholder (a receiver without `Hue-Pending-Spans: 1` that rejected a completed span could
  hide it behind a placeholder before), and a rejected request of placeholders is a warning. The
  first trace acknowledgement without the header, whatever its request carried, turns live spans
  off with one warning, so a generic collector that acknowledged completed spans first never
  receives a placeholder. An export whose spans are still running makes one more request than
  before, for the placeholders alone; the export cadence is unchanged. **Wire**
- The README quickstart no longer calls `recordMessages` outside a model call: `span.setOutput`
  already records the output, and a message record without `gen_ai.operation.name`,
  `gen_ai.provider.name` and `gen_ai.request.model` describes no inference. The reference
  chatbot's records name their operation, provider and model.

### [0.12.1] - 2026-10-02

This release says what stopped a case: a service the agent called that refused, dropped the
connection or timed out is completed as infrastructure, a status Hue's own clients were refused
with is completed as configuration, and neither is filed as the agent's `TargetError`. A case
whose telemetry Hue did not accept in time can complete with its trace evidence pending, and
`hue eval` names an inconclusive case apart from a skipped one. Additive; no capture, default
budget or wire change.

#### Added

- A target's throw is completed with an error type that says what stopped the case: a service the
  agent called that refused with a retryable status (`ServiceRefused`), whose connection failed
  (`ConnectionFailed`) or that timed out (`TimedOut`), read from the error and its `cause`,
  `lastError` and `errors` chains, beside the agent's own `TargetError`. Hue counts the three as
  infrastructure and leaves them out of the agent's pass rate.
- A status Hue's own clients (`HueApiError`, `HueEnvironmentError`, `HueConnectionError`) were
  refused with that is neither a success nor retryable, a 4xx such as a key, a project, an
  environment version or a world Hue refused, completes the case as `ConfigurationRejected`
  instead of `TargetError`: Hue counts it as configuration and leaves it out of the agent's pass
  rate, so an error from Hue's own clients is never filed as the agent's. The clients fetch with
  `redirect: "error"`, so a redirect from the configured endpoint surfaces without a status, as
  `ConnectionFailed`. `TypedError.class` lets a runner of your own that completes an execution
  with a `type` of its own say which class Hue files it under.
- `traceNotAccepted: "pending"` on `runExperiment` and `runSimulation`, and `hue eval
  --trace-not-accepted pending`: a case whose telemetry Hue did not accept in time completes in
  its true state with `traceEvidence: "pending"` and the count of spans the case ended
  (`traceSpanCount`), so Hue scores the sealed world at once and attaches the trace once it holds
  every span, or records the evidence omitted a day later. Such cases are listed in
  `RunnerReport.tracePending`. A saved outcome whose export the trace receipt does not accept on
  resume completes the same way instead of being refused. Needs a Hue that knows pending
  evidence; an older platform refuses the completion with 400.

#### Changed

- `hue eval` names an inconclusive case apart from a skipped one: a case whose deciding evaluator
  could not decide it (its result is skipped with an explanation that begins `Inconclusive:`, as
  when a required judge could not run or answer) shows `INCONCLUSIVE` in the verdict table and is
  counted as `inconclusive`, not `skipped`, in the summary line. Exit codes are unchanged: such a
  case still exits `1`.

### [0.12.0] - 2026-10-01

This release keeps a local worker running through transient failures: the client retries reads
and keyed mutations, `runLocalAgent` polls on after a failed claim and resumes a failed run from
its checkpoints before giving it up as attention, a hung target is ended at its world's expiry,
and an export failure is attributed to the traces it concerned so one case's telemetry failure
does not flag the cases beside it. Two **Breaking** entries under Changed need a look from
callers that matched a single error class on a multi-case run or awaited `runLocalAgent` to
reject on an attention run.

#### Added

- Export issues name the traces of the records they concerned (`ExportIssue.traceIds`, up to 64
  ids): a refused or rejected batch names the traces in it, a dropped record and a record the
  processor could not accept name theirs, and a capture or instrumentation failure names the
  trace active where it happened. The runner reads them after each case's flush: a failure that
  names the case's trace marks that case `failed` (its evidence is incomplete, and resume refuses
  it), one that names only other traces leaves it accepted, and one that names no trace is
  decided by the case's trace receipt, at once or on resume for a checkpoint still `pending`: the
  receipt must hold the case's root span and at least as many spans as the case ended, which the
  checkpoint records at the flush. One case's telemetry failure no longer flags the cases running
  beside it.

- `EvaluationClient` sends a read, or a mutation the server deduplicates by its idempotency key
  (the local worker's register, claim, heartbeat, completion and capability routes included),
  again after a connection failure, a timeout or a 408 or 5xx that carried no `Retry-After`, up
  to `maxAttempts` (default 4) times with a jittered backoff. `isTransientApiError` names those
  failures; `HueApiError` carries Hue's `X-Hue-Diagnostic` code as `diagnostic`. A mutation
  without a key and the credential-bearing attempt preparation are still sent once.
- `runLocalAgent` no longer stops with one failure. A registration or claim that fails
  transiently past the client's retries is reported through `onPollError` and polled again with
  a growing wait. A claimed run whose attempt fails transiently keeps its claim and is resumed
  by the same process from its checkpoints (`onRunFailed` says `retry`), and after
  `maxRunAttempts` (default 5) failures is given up as `attention` for a project member to
  requeue or cancel; a failure that would recur (an outcome unsafe to resume, a refusal Hue
  decided on, an input the SDK refuses such as a case file whose bytes differ from its manifest)
  is attention at once, and a completion Hue refuses because the run was released or cancelled
  meanwhile is reported as `refused`.
  `maxRuns` counts runs that settled either way. `worldTtlSeconds` sets each world's lifetime,
  and the candidate receives `signal` in its context.
- `TargetTimeoutError`: a target still running five seconds past its world's `expiresAt` is
  told through its `signal`, its case ends as an `error` of type `TargetTimeout` and the world
  is sealed abandoned, so a hung agent ends its case instead of holding the run open.
- `hue eval --worker` reports failed polls, resumed and given-up runs.
- `TraceExportUnacknowledgedError`: the error a resumed case throws when its saved outcome still
  waits for a trace export Hue never acknowledged, in place of a plain `Error` with the same
  message; it is that case's own state on resume, and the cases beside it still run.

#### Changed

- **Breaking:** the runner's case pool no longer stops at a case's own failure (an attempt
  without a saved outcome, an unserializable output, refused inputs): the cases beside it run,
  and the failures are thrown together as an `AggregateError` naming its first cause. A failure
  the next case would meet too (Hue not answering or refusing, telemetry not accepted, a world
  that could not be sealed) still stops new cases. Callers that matched a single error class on
  a multi-case run now inspect `AggregateError.errors`.
- **Breaking:** `runLocalAgent` resolves, rather than rejects, when a run is given up as
  attention; the failure reaches `onRunFailed`. It still rejects on a refusal Hue decided on
  (a revoked key, a disabled agent, a malformed claim) and when it cannot record attention.

### [0.11.4] - 2026-09-29

This release makes sign-in with Hue the default of `hue mcp install` for Claude Code and Codex
while keeping existing key setups, and stops `hue eval --command` from passing inherited world
variables to the agent.

#### Changed

- `hue mcp install --client claude-code` and `codex` sign in with Hue by default, as `conductor`
  already did: without `--auth` they configure only the server URL, and the client opens Hue in a
  browser to approve the connection. They keep the choice of the server's existing entry, in
  `./.mcp.json` or as `codex mcp get` reports it, so a rerun keeps a key and its `read_only`; a new
  entry uses a key when `HUE_MCP_KEY` is set (only its presence is checked). When `codex mcp get`
  fails for another reason, the command asks for `--auth` rather than guess. `--read-only`, or
  `read_only=true` or `1` in `--url` (the values Hue reads), also selects a key, for `conductor`
  too, which refused `--read-only` without `--auth key` before. A sign-in configuration still
  refuses any other `read_only` value in `--url`. `cursor`, `vscode`, `windsurf` and `gemini` still
  use a key. The command names its choice, and how to change it, in one line on stderr; `--auth
  key` configures a key.
- Without `--auth` and outside a terminal (CI, an agent's shell tool), `codex` and `conductor`
  print `codex mcp add` instead of running it: it signs in at once and waits up to 5 minutes for the
  browser. When a Codex sign-in does not finish but Codex registered the server, the command no
  longer fails: it names `codex mcp login hue` and prints the next steps.
- `hue login` prints `hue mcp install --client claude-code --auth key` as its next step, so the
  configuration uses the key it stored. The sign-in next steps no longer ask you to choose an
  organization, since Hue's consent page has no organization picker, and say to restart Claude Code
  or start a new Codex session. After `--read-only`, the key steps name
  `hue login --keys coding-agent`, which accepts a **Read** key, instead of suggesting sign-in.

#### Fixed

- Security: `hue eval --command` no longer passes a world variable inherited from its own
  environment (`HUE_SIM_*_URL`, `HUE_SIM_*_ALIAS`, `HUE_WORLD_*`, and `HUE_MCP_CONFIG`,
  `HUE_MCP_URL`, `HUE_MCP_TOKEN` and `HUE_MCP_EXPIRES_AT`) to the agent command. Only the current
  case's world sets them, so an agent can no longer reach a surface outside that world with its
  token. `HUE_MCP_KEY` is a project key, not a world variable: it still reaches the command only
  with `--allow-hue-credentials`.

### [0.11.3] - 2026-09-27

This release fixes security issues in `hue mcp install` and evaluation checkpoint paths, scrubs
more credentials from exported MCP error text and `hue listen` messages, and paces `hue listen`.

#### Fixed

- Security: `hue mcp install` no longer makes a client configuration it replaces world-readable.
  Since 0.5.0 it wrote every file with mode `0644`, so a `.mcp.json`, `.cursor/mcp.json` or
  `.vscode/mcp.json` kept at `0600` because it holds other servers' literal tokens became readable
  by every local account. A replaced file now keeps its permission bits, its group and, run as root,
  its owner, except that other accounts lose write access; an access control list on it is not kept.
  A new file is created `0600`. A file an earlier version already made world-readable keeps that
  mode: run `chmod 600` on one that holds tokens.
- Security: `hue mcp install --dry-run` shows header and `env` values, and other credentials it
  recognizes in the resulting file (credential options and fields, known token prefixes, token-like
  URL path segments and query values, the last percent-encoded), as `[redacted]` unless they only
  reference a variable or input such as `${HUE_MCP_KEY}`. Before, it printed other servers' literal
  tokens. Its output, and the lines reporting what the command did, show Hue's URL with any
  token-like path segment and every query value other than its `toolsets`, `project` and `read_only`
  selections as `[redacted]`. It shows a string longer than 16,384 code points only to there, ending
  in `…`; the file it writes keeps the whole value.
- Security: `hue mcp install` refuses a symlinked `.cursor` or `.vscode` directory, as it already
  refused a symlinked file, and a different file found in place of the one it read. Before, it read
  and wrote `mcp.json` wherever that link pointed. The checks run before the file is read and again
  before the rename, but are not atomic against an account that can write the project directory and
  races the command.
- Security: `hue eval` and the SDK's `runSimulation` and `runLocalAgent` accept a project or
  experiment id from Hue as a checkpoint path component only when it is a single name of letters,
  digits, `.`, `_` and `-` that starts with a letter or digit, and refuse a resolved checkpoint path
  outside its directory. Before, an id containing `../` from a hostile or compromised origin made
  them create directories and write checkpoint files outside `.hue/eval` or `--checkpoint-dir`.
- A failed OpenAI MCP call's error text, exported with `captureContent: true`, is scrubbed of
  credentials it kept before. A JSON escape (`\n`, `\t`, `\u0022`) or `%` escape (`%20`, `%3D`) ends
  a word as a space does, so a prefixed token, or `Bearer`, `Basic` or `Token`, right after one is
  found (`…\nhue_sk_…`, `token%3Dghp_…`), as is a credential key that `:`, `=` or `=>` follows
  (`\nheaders: …`), and an escaped space separates a scheme from its credential
  (`Authorization%3A%20Bearer%20…`). A key or separator that is itself escaped (`%22token%22%3A`,
  `\u0022token\u0022:`) is still not read. A credential key's whole `[…]` or `{…}` value is
  replaced, where only its `[` or `{` was, and one that does not close is replaced to the end of the
  text, and `key => value` pairs are read. JSON inside a JSON string keeps its escaped quotes
  (`\\\"`) inside a value, and a value that only starts with `[redacted]` (`token=[redacted]…`) is
  no longer taken for one already replaced. `hue listen` scrubs its messages with the same rules,
  reading at most 16,384 code points of each and marking a cut with `…`. **Wire**
- In the same text, a quoted value whose quote does not close on its line, as when the text was cut
  inside it, is replaced to the end of the line, where only its first word was. A URL's quoted query
  value (`?token="…"`), or a value between backslash-escaped quotes anywhere in it that ends the URL
  or a query value (`=\"…\"&…`), is replaced whole, so an `&` inside it no longer leaves the rest as
  a query name. The value of the next key of the JSON around such a value is no longer exported
  (`?state=","client_secret":"…"`), the value of a key or scheme word that a URL takes in
  (`?t="a"&Bearer …`) is still replaced after it, and a query name holding a `:`, a scheme word
  before an escape other than of a bracket, or a credential pair once `%3A` and `%3D` are read
  (`?mongodb://u:…@…`, `&token:…`, `&Bearer%20…`, `&client_secret%3A…`) is replaced. A URL that
  would be rewritten with a credential (a prefixed token included) in its host or path is replaced
  whole; one in its own userinfo, which is dropped, does not count. Where a URL now ends sooner or
  later than 0.11.0 read it, what 0.11.0 hid there stays hidden: around the URL, by replacing a
  rewritten URL whole that holds some of it in its host or path, and in a query name. A URL nested
  in another's path (`…/p&mongodb://u:…@…`) loses its userinfo, after any extra `/`, or, when its
  scheme is not `http(s)`, `ws(s)` or `ftp` and it holds an `@`, everything to the end of that
  path. Only the first 16,384 code points are scrubbed; a URL or prefixed token that this cut
  interrupts is now replaced whole, as is the word of scheme characters the cut ends in, and the
  text is still scrubbed before it is cut to 1,024 characters. Hue's OAuth tokens (`hue_at_`,
  `hue_rt_`, `hue_oauth_`), its `hue_ss_` and `hue_vt_` tokens, Slack refresh tokens (`xoxe-`) and
  Google OAuth client secrets (`GOCSPX-`) are replaced by their prefix. **Wire**
- `hue listen` repeats a waiting pull that forwarded something no sooner than 50 ms after it began,
  so a Hue that answers every pull at once with new deliveries is pulled at most 20 times a second;
  before, with a local receiver, it pulled about a thousand times a second.

### [0.11.2] - 2026-09-27

This release pins MCP connections to one project, matches the current Hue MCP toolsets and object
vocabulary, and fixes bounded waits and shutdown behavior in the evaluation and listen CLIs.

#### Added

- `hue mcp install --project <id-or-slug>` pins a key or sign-in connection to one project and
  names it `hue-<value>` so it can coexist with an organization-wide `hue` connection. Its tools
  omit `project_id`; the printed sign-in Codex TOML sends the pin as `X-Hue-MCP-Project`.
- `hue mcp install --toolsets` accepts the `author` and `evaluate` profiles and the current
  `eval_sets`, `runs`, `judges`, `cases` and `runners` groups alongside the existing selections.
- `EvaluationClient.getArtifact` and `completeArtifact` take an optional `{ signal }`, which ends
  the request and the client's own wait to send it again.

#### Changed

- `hue mcp install` validates the current MCP toolset names, uses product object names in its guide
  and skill, and documents `https://mcp.hue.run/mcp` as the only production MCP URL.
- Hue skill 0.5.9 describes pinned connections, current MCP parameter and result names, the catalog
  executors and the current evaluation profiles and groups.

#### Fixed

- The local runner's wait for Hue to verify a generated file ends at its three minutes: each
  completion and read it makes, and the client's wait to repeat one Hue refused with a short
  `Retry-After`, stops there. Before, a completion refused that way or answered slowly near the end
  could run about a minute past.
- `hue listen` no longer pulls in a loop when a pull brings nothing new to forward, such as a
  delivery it already answered that Hue hands out again, or one whose acknowledgements Hue refuses.
  Before, it sent about 1,600 pulls and acknowledgements a second; it now waits a second before the
  next pull, as it already did after an empty pull.
- `hue listen` refuses a credential equal to the value of any Hue control-plane variable,
  `HUE_PROJECT_KEY` and `HUE_SERVICE_KEY` included, not only `HUE_API_KEY` and `HUE_MCP_KEY`.
- One Ctrl+C no longer abandons `hue listen`'s deliveries in flight under `npx`. npm forwards the
  terminal's SIGINT to the command, which counted it as a second Ctrl+C, exited 130 and left the
  deliveries unacknowledged. A stop request within a second of the first is now the same stop, and
  the command exits no sooner than that second, so a copy arriving as it exits cannot end it by
  SIGINT; a second Ctrl+C after that still abandons them.
- `hue eval` names the agent after the script that follows an interpreter written with a Windows
  executable suffix (`node.exe`, or `bun.exe`, as npm installs Bun on every platform), where it
  took the interpreter's name.

### [0.11.1] - 2026-09-26

`hue mcp install` gives agents that search their own tools every Hue tool, and every selection travels in the server URL.

#### Changed

- `hue mcp install --client claude-code`, `codex` and `conductor` write `?toolsets=all` into the
  server URL, with a key or with sign-in: these agents defer MCP tools behind their own tool
  search, so listing every tool costs them little. `cursor` keeps `?toolsets=observe`. `vscode`,
  `windsurf` and `gemini` list Hue's default: the production reads, plus `search_hue_tools`,
  `execute_hue_tool` and `execute_hue_write_tool`, which find and call every other tool the
  connection allows.
- A sign-in configuration carries `--toolsets` in its URL, as a key configuration does, and a
  selection already in a sign-in `--url` is kept. The printed sign-in Codex TOML keeps its URL bare
  and sends the selection as the `X-Hue-MCP-Toolsets` header, as Hue's connection guide does.
- Every printed Codex TOML block sets `supports_parallel_tool_calls = true`, so Codex runs Hue's
  independent calls in parallel. After `codex mcp add`, which has no option for it, the command
  names the line to add.

#### Fixed

- `--toolsets all` writes `?toolsets=all` instead of leaving the URL bare, since a bare URL lists
  Hue's default.

### [0.11.0] - 2026-09-26

This release changes two defaults of `hue mcp install` (see Breaking), so it is a `0.MINOR` release; three changes to evaluation results and waits were listed as Breaking after it was published. It also adds `hue mcp install` options (sign-in with Hue, Conductor, read-only and toolsets), `hue listen` and new tracing and evaluation APIs.

#### Breaking

- `hue mcp install --client cursor` writes the URL with `?toolsets=observe`, so Cursor lists only
  Hue's production reads, as Hue's own Cursor snippet does; before, it listed every tool the key
  allows. Migration: pass `--toolsets all` to keep the whole catalog, or remove `?toolsets=observe`
  from `.cursor/mcp.json`.
- `hue mcp install --client gemini` runs `gemini mcp add --scope user --transport http hue URL
  --header 'Authorization: Bearer ${HUE_MCP_KEY}'`, the form in Hue's connection guide, so the
  server is registered for the user in every project; before, it wrote a project-scope entry with
  `-H '… $HUE_MCP_KEY'`. Migration: an earlier project entry keeps working and takes precedence in
  that project; remove it with `gemini mcp remove hue` there to use the user entry.

These three entries were added after 0.11.0 was published; 0.11.0 already behaves as they describe.

- A pinned Hue judge's (`world_judge`) result that Hue marks advisory, as it marks every judge's
  today, no longer decides a case unless it is an error or one of its metrics carries `passed`, so
  `collectExperimentVerdicts` and `hue eval` (and `summarizeVerdicts`, for results marked
  advisory) can report a different state and exit code. A case that only advisory judges graded
  took their verdict (`passed`, exit 0, or `failed`, exit 1) and is now `error` (exit 1), so an
  eval set graded only by such judges fails every case. A case whose other evaluators passed and
  whose advisory judge said `false` was `failed` (exit 1) and is now `passed` (exit 0).
  Migration: pin an evaluator that decides each case, such as a code evaluator, beside the judge,
  or read `CaseVerdict.advisory` (`cases[].advisory` in `hue eval --json`) and the judge's metrics
  to act on its verdict yourself.
- `hue eval` gives each export of its own telemetry 30 seconds instead of 10 seconds, retries
  included, so a case whose trace Hue acknowledges slowly waits up to 20 seconds longer per export
  before it fails as `TelemetryNotAccepted`, and the longest `hue eval` waits on one batch of its
  spans or log records grows from 161 to 481 seconds. `createHue`'s default stays 10 seconds.
  Migration: allow for the longer waits in CI and job timeouts.
- The local runner (`runExperiment`, and so `hue eval`) waits about three minutes for Hue to verify
  each generated file it uploads, instead of failing at the 10-second request timeout, and an
  artifact's completion that cannot reach Hue takes about those three minutes to fail. Migration:
  allow about three more minutes per generated file in CI and job timeouts.

#### Added

- `hue listen --subscription <id> --forward-to <url>` delivers a simulated world's events (Slack
  Events API requests) to a bot on this machine without a public URL. It pulls with the
  subscription's own world token or connection key (`HUE_WORLD_TOKEN` or `HUE_CONNECTION_KEY`, never
  a project key and never from the command line), forwards each signed request unchanged to a
  loopback receiver (`--allow-remote-forward` for another host, over HTTPS only) without following
  redirects, acknowledges it with the local answer within Slack's three-second window, and on Ctrl+C
  finishes and acknowledges the deliveries in flight before it exits. It needs event subscriptions
  on the Hue origin, which `https://app.hue.run` does not offer yet. See
  [CLI.md](./packages/sdk-typescript/CLI.md#deliver-simulated-events-to-a-local-bot).
- The `ScorerDefinition` type, and the scorer definitions `runSimulation` publishes, know every
  Hue-executed `world_outcome` entry: `hue.conversion_outcome.v2`,
  `hue.outcome_assertions.v2` and `hue.outcome_assertions.v3`, whose version pins its judge in
  `config.judge` (new `OutcomeJudgeConfig` type). Each entry's metrics are fixed by the entry and
  filled in when omitted; the local runner defers all of them to Hue, as it does v1.
- `VerdictResult.advisory`, `CaseVerdict.advisory` and
  `WaitForResultsOptions.judgeScorerVersionIds`: a result of a pinned Hue judge (`world_judge`)
  whose evidence says `advisory: true`, as Hue records for every judge today, is listed with its
  metrics but never decides its case.
  `collectExperimentVerdicts` passes the experiment's judge pins. Any other evaluator can write the
  same evidence, so no other result, no error and no metric carrying `passed` is advisory.
- `HueApiError.retryAfterSeconds`: the `Retry-After` of a 429 or 503, when Hue sent one.
- Provider tool spans from `recordProviderToolCalls` carry `hue.tool.call.position`, the 0-based
  position of the call's item in the provider response (the OpenAI `output` index or the Anthropic
  `content` block index), in both capture modes, so calls from one response that share a start
  time keep their order. **Wire**
- A `tools/list` span from `recordProviderToolCalls` with `captureContent: false` carries
  `hue.tool.names` and `hue.tool.definitions.sha256`, the same metadata-only summary export gives
  any record's tool definitions; before, it carried neither. Descriptions and schemas are still
  exported only with content capture. **Wire**
- With `captureContent: true`, a failed OpenAI MCP call's span has the provider's error text as its
  ERROR status description, credentials scrubbed and cut to 1,024 characters and a `…`. Scrubbing
  drops an `http(s)`, `ws(s)` or `ftp` URL's userinfo and fragment and replaces its query values
  (quoted ones included) with `[redacted]`, replaces a URL with any other scheme whole when it has
  an `@`, `?` or `#`, and replaces a token with a known credential prefix (Hue's `hue_sk_`,
  `hue_mcp_`, `hue_world_`, `hue_attempt_`, `hue_sim_`, `hue_setup_`, `hue_install_` and `hue_inv_`,
  and `sk-`, Stripe, Slack, Google OAuth, GitHub and GitLab tokens), the credential after `Bearer`,
  `Basic` or `Token`, an `Authorization` header's whole value and the value of a credential-named
  `key=value` or `key: value` pair (a key such as `--token` or `_authToken` included, as is `API
  key:`; the value quoted, with backslash-escaped quotes as in JSON inside a string, or bare, and a
  pair inside another pair's value). The `redact` hook sees the text as `status.message`. Without
  content capture the span keeps `error.type` only. **Wire**

- `hue mcp install --auth oauth` configures only the server URL, so the client signs in with Hue
  in the browser instead of sending a key: a URL-only `.mcp.json` or `claude mcp add` for
  `claude-code`, and `codex mcp add hue --url URL` for `codex`. The connection it signs in is
  Hue's organization connection: **Read and write** access to the active projects of one
  organization, selected per call with `project_id` from `list_projects`. The default stays
  `--auth key`, whose key keeps reaching its one project.
  Sign-in is refused for `cursor`, whose callback Hue does not yet accept, and for `vscode`,
  `windsurf` and `gemini`.
- `hue mcp install --client conductor` registers the server for Conductor's Claude Code (user
  scope) and Codex agents with each CLI on `PATH`, and signs in by default. Hue has not yet
  verified the complete signed-in Conductor flow end to end, so the next steps name `--auth key`
  as the fallback.
- `hue mcp install --toolsets <names>` lists only the named tools: `observe` for production reads,
  `all`, or the catalog groups. A key configuration adds `?toolsets=<names>` to the URL; a sign-in
  configuration sends the `X-Hue-MCP-Toolsets` header, which Claude Code stores and Codex's
  configuration needs added by hand. `--client cursor` selects `observe` by default (see
  Breaking). Unknown names are refused.
- `hue mcp install --read-only` adds `?read_only=true` to a key configuration's URL, so Hue hides
  and rejects write tools whatever the key allows. With `--auth oauth` it is refused, since a
  sign-in connection has **Read and write** access; a **Read** project key is the read-only
  option.

#### Changed

- The prompt `hue mcp install` prints to verify the connection starts with `list_projects`, which
  every credential answers, and passes `project_id` on an organization connection. It then asks
  for the traces from the last 24 hours that need attention or have errors, and for the 5 most
  recent traces when there are none, instead of only the 5 most recent error traces.
- The VS Code key prompt that `hue mcp install --client vscode` writes reads "Hue Read or Read and
  write API key".
- After a key installation, `hue mcp install` says that an app started from the Dock or a launcher
  does not see the shell's `HUE_MCP_KEY`, and names sign-in as the alternative where it works.

#### Fixed

- `hue eval`, `hue login` and `hue mcp` name a missing peer dependency, such as the optional `zod`
  that `hue eval` needs, with the command that installs it, and exit 2, instead of failing with the
  runtime's module resolution error.
- A target output over what Hue stores for one case (200,000 bytes of JSON, 20,000 values or 32
  levels of nesting) no longer stops the whole run with `OutcomeSerializationError`: that case
  completes as `error` with the type `OutputTooLarge` and, when result content is persisted, a
  message naming the bound, and the other cases keep running. Output within the bounds that is not
  JSON still raises `OutcomeSerializationError`.
- An advisory judge's `false` verdict no longer fails a case or the run. Hue reports a judge's
  `verdict` without `passed` and marks the result advisory, so a judge never decides a case;
  `summarizeVerdicts`, and so `hue eval`, counted the boolean anyway, so a judge pinned across an
  eval set failed every case it had nothing to grade and `hue eval` exited 1. Advisory results are
  now shown and never counted; a case only advisory results ran for is an error, and says why an
  advisory evaluator skipped it. The `hue eval`
  table gives each evaluator its own column when several report a metric of the same name (two
  judges' `verdict`), marks advisory columns, and counts advisory failures as not counted.
- An artifact whose verification outlasts a request no longer fails the upload. Hue verifies
  within a two-minute lease, and a 47-second verification failed at the client's 10-second
  timeout. A completion that times out, finds verification running (409) or is refused with 429 or
  503 now reads the artifact until it is ready or leaves verification, completing again while it
  verifies, and up to three more times when a 429, 503 or lost response left it unverified, for up
  to three minutes, honouring a `Retry-After`; a mismatched, cancelled or abandoned artifact, or
  one a 409 left unverified, is still refused. A completion that cannot reach Hue now takes those
  three minutes to fail; a reservation or upload that cannot reach it still fails at once. A resumed upload whose artifact is already verifying no longer asks
  for another upload capability, which Hue refuses then, and settles on the same artifact.
- `hue eval` exports its own telemetry, and so each case's required trace, with a 30-second
  deadline instead of 10 seconds, retries included, so a slow acknowledgement or a `Retry-After`
  within it no longer fails the case as `TelemetryNotAccepted`. Retries are unchanged (up to five,
  on 429, 502, 503, 504 and network errors), and any other response, or rejected records, still
  fails the case at once.
- A large inline file whose `data:` URL has a pathological number of `;` parameters is hashed as
  the bytes its own encoding gives. The header was read with a pattern repeated per parameter,
  which throws on Node (from about 3.4 million), leaving the message unhashed, or stops matching
  on Bun (from about 1.1 million), hashing the URL's text. The Python SDK reads the header the
  same way. **Wire**
- An OpenAI `mcp_list_tools` tool's null `name`, `description`, `input_schema` or `annotations` is
  left out of its `tools/list` definition, as the Python SDK leaves it out, so both SDKs record
  the same definitions and give a catalog the same digest. **Wire**
- `recordProviderToolCalls` no longer drops a whole response when one item's `type` (or any field)
  throws when read: the item is skipped and counted, and the other calls are recorded, as the
  Python SDK does.
- An output too long for the runtime to serialize (on Node, JSON longer than V8's longest string,
  such as 120 MB of control characters) completes its case as `OutputTooLarge`; before, Node's
  `Invalid string length` stopped the run with `OutcomeSerializationError` and a resume kept
  refusing. The JSON byte length is counted as the output is read but still checked last, so an
  output past the byte bound that is also not JSON raises `OutcomeSerializationError`, and an
  array or object with more elements than values allowed, or keys longer than the bytes left, is
  refused before its keys are listed or sorted. A run that already stopped this way still refuses
  to resume from its checkpoint; run it again with a new checkpoint directory.

### [0.10.0] - 2026-09-25

This release changes a default of the `hue` binary (see Breaking), so it is a `0.MINOR` release.

#### Breaking

- One-shot `hue eval` stores each case's output, error message and explanations in Hue by default,
  as `--worker` already did, so answer checks can grade the output and the run page shows it.
  Everything the command prints on stdout is its answer and is stored, so an agent must not print
  credentials or debug logs there. Before storing, `hue eval` replaces with `[redacted]` the
  credentials it handed the case (the world token and MCP headers, a legacy MCP token, attempt
  bearers) and every Hue control-plane credential in its environment, in the answer, in an
  adapter's thrown message and in the checkpoint. `--content` now governs only telemetry content
  capture, which stays off by default. `--no-output` keeps outputs, error messages and
  explanations out of a one-shot run's stored results (with `--content`, the case span still
  carries the output); `--worker` refuses it. Migration: pass `--no-output` to keep the previous
  default. An interrupted one-shot run keeps the choice it started with, so resume one started
  without `--content` by an earlier version with `--no-output`; a rerun with other flags is refused
  with a message naming the flags the run started with.

#### Added

- `traceNotAccepted: "fail_case"` for `runExperiment`, `runSimulation` and `runLocalAgent`: a case
  whose required telemetry Hue did not accept is completed as failed (error `TelemetryNotAccepted`,
  evidence omitted with a reason starting `telemetry_not_accepted`, no output or generated files
  attached) instead of being left started, reported to the new `onTelemetryNotAccepted(entry)` as it
  completes and listed in the new `RunnerReport.telemetryNotAccepted` with sanitized issue counts.
  The default, `"stop"`, keeps the previous behavior. Exported types `TelemetryNotAccepted` and
  `TelemetryIssueCount`.
- Cases pinned to a world can carry input files. `runSimulation` and `runLocalAgent` download
  the case's agent-visible files before its execution starts, verify each one's size and SHA-256
  against the case manifest and hand the verified copies to the environment callback as
  `context.files`, beside the world, with a private `context.outputDirectory`. Evaluator-only
  files (`org_template`, `evaluator_reference`) never reach the agent. The callback may return
  `withFiles(output, files)`: the files are uploaded and linked to the execution as `artifactIds`
  and `primaryArtifactId`, within the limits of direct cases. The world token is never written
  to the case directory, which is removed when the case ends; only staged outputs an interrupted
  upload resumes from are kept until it does.
- `localAgentCapabilities.environmentFiles` (`environment-files:v1`). A worker that declares it,
  with `input:<extension>` for each file type it accepts, is offered world cases whose manifest
  holds agent-visible files; it requires `target`. The worker never adds it to a registration
  itself, so existing registrations keep their capabilities.
- `CaseFileError`, with the stable `code` `case_file_mismatch` when a downloaded pinned file
  differs from the manifest's size or SHA-256, and `case_file_name_refused` when a file for an
  agent in a world is not one safe file name (a path separator, `.` or `..`, a C0 or C1 control
  character, a character Windows reserves such as `:` or `?`, a Windows device name such as
  `CON`, a trailing dot or space, or more than 200 bytes). Both are raised before the case's
  execution starts, so no execution or world is spent on it.
- `EvaluationClient.downloadArtifact(id, { maxBytes })` stops one byte past `maxBytes` and throws
  the new `ArtifactSizeError`. Pinned downloads pass the manifest's size, so a longer body is a
  `case_file_mismatch` without reading the rest.
- `hue eval` hands a world case's files to the agent: an adapter receives `context.files` and
  `context.outputDirectory` and may return `withFiles`, and a `--command` also gets
  `HUE_CASE_DIR`, `HUE_CASE_INPUTS` and `HUE_CASE_OUTPUT_DIR` with the direct-case layout; every
  file it leaves in `output/` is uploaded. `--worker` registers each repeated
  `--capability <value>`, such as `environment-files:v1` and `input:pdf`, beside `environment:v1`.
- Evaluators that do not apply to a case. `StoredResult.notApplicable` is true for a skipped result
  Hue's own outcome scoring records because the case has no outcome criteria or conversion rubric
  to grade; `waitForResults` carries it, with what the evaluator needs, as
  `VerdictResult.notApplicable` and `requires`. `summarizeVerdicts` decides a case by the
  evaluators that apply to it, lists the others in the new `CaseVerdict.notApplicable` and counts
  them in `totals.notApplicable`, and makes a case no pinned evaluator applies to an error that
  names what they need. `hue eval` shows `n/a` in such a case's columns, counts the
  not-applicable results in its pass line and `--json`, and exits 0 when every case passed the
  evaluators that apply to it. Before, such a result was an ordinary skip: its columns showed `-`,
  its explanation was printed with a failing case's own, and a case no pinned evaluator applied to
  was reported as skipped. Only Hue's flag on a skipped result marks it not applicable: a scored
  or errored result keeps its verdict whatever flag it carries, and a skip without the flag, such
  as one for an incomplete environment, is still a skip.

#### Changed

- A downloaded pinned file that differs from its manifest now raises `CaseFileError`
  (`case_file_mismatch`) instead of a plain `Error`, for direct cases and `rescore` too.
- Evaluator-only files for a local code evaluator are still checked before the execution starts,
  but saved only after the target finished, just before scoring, apart from the agent's copies, so
  they are not on disk while the agent runs. They are downloaded twice as a result. Before, they
  were saved with the agent's files before the execution started.
- A generated file declared by `path` is read once as a regular file, its size checked before
  reading, and staged owner-only (0600) from those bytes; a symlink, FIFO or device is the
  target's error. Before, it was read whole, then copied with its own mode.
- `safeFilename` keeps at most 200 UTF-8 bytes instead of 200 characters, so a long multibyte
  name no longer fails with the operating system's name-length error. A longer name keeps its
  extension (`.pdf` stays `.pdf`) and its shortened stem ends in `~` and 8 hex digits of the whole
  name's SHA-256, so two long names stay distinct.
- A files directory must be owned by the current user and closed to everyone else (mode 0700).
- `hue eval` stops whatever a command left running in its process group (SIGTERM, then SIGKILL
  after 5 seconds) before reading its answer and files. A forced exit (a second Ctrl+C) also
  removes the world case's files and the checkpoint locks, so a rerun is not refused on a stale
  lock.

#### Security

- `hue eval` collects a command's `output/` without following the agent's links. The output
  directory must be a real directory and a helper (`manifest.json`, `result.json`, `summary.txt`,
  …) a regular file; every file is opened without following a final symlink or blocking on a
  FIFO, must be the file the listing saw and within its limit (checked before reading), and is
  uploaded from the bytes read. Before, a helper or an output directory linked to a host path
  sent that host file to Hue, a file swapped for a link after the listing could be uploaded, and
  a FIFO named like a helper hung the CLI. The listing also stops past 32 documents or 1024
  entries, and an entry that vanishes or changes while it is collected fails the case with a
  plain "changed while it was collected" error. This applies to direct cases and world cases
  alike.
- Input copies in a direct case directory whose names differ only in case or Unicode
  normalization no longer overwrite each other on case-insensitive or normalizing filesystems.

#### Fixed

- **Wire.** A large inline file part in a recorded message is exported with the `sha256` and
  `size` of the file's own bytes whatever its media type. Base64 content is decoded for text,
  JSON and untyped parts too, and a `data:` URL without `;base64` is percent-decoded. Before,
  those were hashed as the UTF-8 of their base64 or URL text, so the digest did not match the
  file's bytes, and a text file sent as base64 could not be linked to its upload. Behavior change:
  content made only of base64 characters and padded to a multiple of four is now read as base64
  even under a text media type, as Hue reads it, so such a text (`AAAA…`, for example) is hashed
  as the bytes it decodes to and stays inline while those fit in 64 KiB. A text file's own text
  is still hashed as UTF-8. The Python SDK follows the same rule, checked against a shared fixture.
- `hue eval` completes a case whose telemetry Hue did not accept as failed with
  `telemetry_not_accepted`, prints the export issue counts for it as it completes (and adds them to
  the case's `--json` entry), counts it as an error whatever its scores, exits 1 and goes on with
  the run. Before, the run stopped with "Hue could not accept all
  telemetry. Inspect issues and report for sanitized counts.", pointing at a report the CLI never
  printed, and the case's execution stayed started. Other export errors now print their counts
  too.
- `hue eval` treats a second SIGINT within 50 ms as the same Ctrl+C, since `npm run` and `npx`
  forward the terminal's own a moment later; before, a single Ctrl+C under them took the forced
  path. A forced exit now also removes the owner-only MCP configuration that holds the world
  token, a failure to signal an agent's process group is reported once rather than on every
  poll, and an interrupt that lands before a command starts stops it at once.

- The seal wait of `runSimulation`, `runLocalAgent` and `runEnvironmentTarget` honors a status
  read's `Retry-After` when a 429 or 503 outlasts the client's retries: it waits at least that
  long, capped at the time left, instead of polling again after 250 ms.
- A large inline file in a recorded message no longer drops its span. Inline files longer than
  64 KiB are replaced by their `sha256` and `size` when the record is queued, before its bytes are
  charged to the queue budget, as Python does; before, the full file was charged first, so under
  the default 8 MiB `maxQueueBytes` a span inlining a file over about 3 MiB was dropped. A message
  attribute longer than 8 MiB is still left to the budget. The same text is hashed once per record,
  a record inspects at most 16 MiB of message text, and with `captureContent: false` the messages
  export removes are neither hashed nor charged.
- `hue eval` stops a timed-out or cancelled `--command` by signalling its whole process group even
  after the shell has exited, then kills whatever is left after the 5-second grace, and settles the
  case only once the group is gone; a group found empty is never signalled again. Before, an agent
  started by a compound command (`a; b`, `a | b`) that ignored SIGTERM kept running, with its world
  credentials, after the case failed. A second Ctrl+C during the grace now kills the agent's group
  at once and exits with 130 instead of ending the CLI and leaving the agent running.
- `hue eval` replaces an adapter error whose message cannot be reassigned (a frozen error, or one
  whose `message` is a getter) with a new `Error` carrying the redacted message and name, instead
  of storing the unredacted message. An error's name, which the case span exports as its error
  type, is redacted the same way as its message. Values shorter than 16 characters are no longer
  treated as credentials, so a short environment value no longer redacts ordinary text in the
  answer.
- `hue eval` also replaces the credentials it redacts from the answer in the UTF-8 `.txt`, `.csv`
  and `.json` documents it collects from `output/`, and in every generated file's name, before
  uploading them; a name that redaction makes equal to another file's gains `-2`, `-3`, … before
  its extension, so both are still uploaded. PDF, Office and image documents and files an adapter
  returns by `path` are uploaded as written, so an agent must still never write credentials to
  `output/`.
- `hue eval --case` and `resolveScenarioPins` accept the published eval set case's own ID, the one
  Hue shows on the case page, and URLs naming `/cases/<id>` or `/case-conversions/<id>`. Before,
  only the case conversion's ID or a `/scenarios/<id>` URL resolved, and the case's own ID failed
  with HTTP 404. A case ID is looked up among the first 1,000 Scenarios listed, and a listing that
  repeats a cursor ends the lookup, or a name search, instead of paging forever.
- `EvaluationClient.registerLocalAgent` reads the registered key from the response's `agentKey`
  when it has no `key`, so `RegisteredLocalAgent.key` is set and `hue eval --worker` no longer
  prints "Registered agent undefined".
- `EvaluationClient` sends a request again, up to four times, when Hue refused it before acting on
  it with a short `Retry-After` (HTTP 429 or 503 asking for at most 5 seconds), and waits at least
  that long first. Hue does this when its key check is busy, which parallel cases can trigger; such
  a request previously failed the run. A refusal that asks for longer or gives a date, a timeout and
  any other failure still fail at once, so a write whose outcome is uncertain is never sent twice.
  A refused `downloadArtifact` is fetched again the same way and still stops at `maxBytes`.
- The retry jitter in `EvaluationClient` is written as `Math.random() * 0.5` instead of a bare
  division, so the release workflow's inspection of the built archive, which refuses ambiguous
  `/` syntax, accepts the package. The waits are unchanged. CI now runs that inspection on every
  change.

### [0.9.0] - 2026-09-24

#### Breaking

- `GmailProviderInstance.configuration` is now `GmailMailboxConfiguration`, a union discriminated
  by `kind`, instead of the `gmail_mailbox/v1` object alone. The change is type-only, with no
  runtime or wire effect, but code that assigns a read-back `configuration`, or its `kind`, to the
  old `gmail_mailbox/v1` type, or that checks `kind` exhaustively, no longer compiles. Migration:
  narrow on `configuration.kind` before treating a value as `GmailMailboxConfigurationV1` (the
  exported name of the old shape), and handle `gmail_mailbox/v2` in exhaustive checks.

#### Added

- `HueEnvironmentError.diagnostic` exposes a validated `X-Hue-Diagnostic` code from World API
  refusals. This is new after TypeScript 0.8.1, which does not include it.
- `gmail_mailbox/v2` Gmail provider instances. `GmailMailboxConfigurationV2` adds
  `labelsCollection`, so `publishVersion` and `runSimulation` author worlds on that carrier
  without a cast and `getVersion` reads `labelsCollection` back. `GmailMailboxConfiguration`,
  `GmailMailboxConfigurationV1` and `GmailMailboxConfigurationV2` are exported from
  `@hue-run/sdk/environment`. Hue accepts that carrier only with the synthetic mailbox address
  `owner@example.test`, and a definition whose provider instances all use it may publish with no
  actions.
- `runSimulation`, `runLocalAgent` and `runEnvironmentTarget` wait up to about 40 seconds for a
  gateway world to seal after its completion grace before the execution completes.
- `isTransientEnvironmentError` classifies retryable World API failures for bounded polling.

#### Changed

- `resolveScenarioPins`, and so `hue eval --case`, pin every scorer version a published Scenario
  lists in `publication.scorerVersionIds` (its outcome scorer first), falling back to the single
  `scorerVersionId` of older publications; extra `--scorer` pins still merge in.
  `CaseConversionPublication` gains the optional `scorerVersionIds`.

#### Fixed

- The hosted-tool recorder resolves `servers` entries with own-property lookup, so labels such as
  `constructor` keep their server name instead of inheriting from `Object.prototype`.
- Truncated provider responses count only provider tool calls toward instrumentation failures, so
  harmless message and reasoning tails no longer make strict `flush()` throw.

### [0.8.1] - 2026-09-24

#### Added

- **Wire.** `hue.recordFile(file, explicitContext?)` adds a `hue.file` event to the active span:
  `hue.file.sha256`, `hue.file.role` (`input`, `attachment` or `output`), `hue.file.media_type`,
  `hue.file.size` when known and, only when content is captured, `hue.file.name`. File bytes are
  hashed locally and never exported; the event is recorded in both capture modes. Exported type
  `FileRecord`.
- **Wire.** `hue.recordProviderToolCalls(response, { provider?, request?, servers?, parentContext? })`
  records OpenAI Responses `mcp_call`, `web_search_call`, `file_search_call` and
  `code_interpreter_call` items and Anthropic `mcp_tool_use` / `server_tool_use` blocks as
  `execute_tool` child spans with `gen_ai.tool.type` `extension`, `mcp.server.name` and, with
  `request`, `server.address`. Arguments and results are content. An OpenAI `mcp_list_tools` item
  becomes a `tools/list` span carrying that server's `gen_ai.tool.definitions`. Exported types
  `ProviderToolCallOptions`, `HostedServerInfo` and `HostedToolProvider`.
- **Wire.** `model()` accepts `systemInstructions` and `tools`, recorded as
  `gen_ai.system_instructions` and `gen_ai.tool.definitions` when content is captured;
  `recordMessages({ systemInstructions })` adds the instructions to the inference log body.
- **Wire.** `SpanOptions.workspaceId` (also on `model()`) records `hue.workspace.id`, inherited by
  nested helper spans and the AI SDK adapters like `userId`.
- **Wire.** `hue.tool(..., { mcp })` accepts `provider` and `surface`, recorded as
  `hue.mcp.provider` and `hue.mcp.surface`; `bindEnvironmentTools` passes a catalog entry's values.
- **Wire.** Metadata-only export that removes tool definitions leaves `hue.tool.names` and
  `hue.tool.definitions.sha256` (RFC 8785 canonical JSON of the credential-scrubbed definitions) on
  the same record.
- **Wire.** AI SDK 7 provider-executed (`extension`) MCP tool spans get `mcp.server.name` from the
  recorded `serverLabel`, and an MCP `error` in the result sets ERROR status and
  `error.type: mcp_error`. Both survive metadata-only export.
- `hue login --env-path <path>` and `hue eval --env-path <path>` name the env file like
  `--env-file`.

#### Changed

- Correction: multi-pin `resolveScenarioPins` (`publication.scorerVersionIds`) shipped after 0.8.1; it is documented under 0.9.0.
- `hue eval` names a run `<agent key> @ <revision>` when `--name` is not passed (commit hashes
  shortened to 7 characters); the eval set is already shown on the run page. Previously the name
  repeated the eval set name in a `·`-separated string.

#### Fixed

- **Wire.** Hosted-tool credentials in exported tool definitions (`authorization`,
  `authorization_token`, `headers`, `api_key`, `access_token`, `x-api-key`) are replaced with
  `"[redacted]"` before `redact` runs, in `gen_ai.tool.definitions`, `ai.prompt.tools`,
  `llm.tools.*.tool.json_schema` and the `tools` / `mcp_servers` entries of recorded raw requests
  and responses. Schema parameters with those names are kept.
- **Wire.** A `blob` or `file` part over 64 KiB in `gen_ai.input.messages`,
  `gen_ai.output.messages` or `ai.prompt.messages` is exported without its payload, with `sha256`
  and `size` instead, so a span that inlines a large file is no longer rejected at export. The
  digest matches `hue.file.sha256` for the same bytes.
- `hue login --env-path <path>` creates a new env file. With `--env-file`, Node 22 and 24 exit with
  `node: <path>: not found` before `hue` runs when the file does not exist yet, because Node reads
  `--env-file` from the whole command line. `--env-file` still works for an existing file.

### [0.8.0] - 2026-09-24

#### Added

- **World API handoff.** `createRun` accepts `traceparent` and `agentRevision`, and its response
  carries the world's `token`, `surfaces`, `env` and `mcpConfig` where Hue's simulation gateway
  serves the world. `worldHandoff`, `agentEnvironment`, `stripHueControlPlaneCredentials`,
  `legacyMcpCapability` and `writeMcpConfig` in `@hue-run/sdk/environment` build an agent child's
  configuration from it without the project key; `getEvidence` reads a sealed world's
  evaluator-only evidence; `HueEnvironmentError` carries `retryAfterMs` and the client waits
  Hue's `Retry-After` on 429 and 503. `runSimulation`, `runLocalAgent` and `runEnvironmentTarget`
  create the world with the case span's context and the agent revision (`agentRevision` on
  `runSimulation`), pass `context.world`, and finish before completing. `hue eval --command`
  hands the child the world's environment and an owner-only `HUE_MCP_CONFIG` file, removes
  `HUE_API_KEY` and other Hue control-plane credentials from it unless `--allow-hue-credentials`
  is passed, and sends `--revision` as the agent revision.

#### Changed

- `SimulationTargetContext.mcp`, `LocalAgentTargetContext.mcp` and `EnvironmentTargetContext.mcp`
  are optional: for a gateway world they hold the first MCP mirror with the world token; for a
  world created while the gateway is off they still hold the `hue_sim_` capability, now with a
  one-time `DeprecationWarning` (`HUE_NATIVE_SIMULATION_TOOLS`; the provider facade warns
  `HUE_PROVIDER_FACADE`). `SealedRun.sealedAt` is null while a gateway world is `completing`.
- `runExperiment()`, simulations and `hue eval --concurrency` accept up to 64 cases in flight
  (was 16). The default stays 1.

### [0.7.0] - 2026-09-23

#### Breaking

- Live spans are on by default: while a span from Hue's own helpers, the AI SDK adapter or a
  recognized AI instrumentation is still running, the transport also exports a placeholder for
  it (see Added). A Hue deployment that accepts placeholders answers with `Hue-Pending-Spans: 1`;
  if a receiver without that header gets placeholders, their rejections are credited to them, one
  `warning` issue is recorded and live spans switch off for that client. Placeholders may use up
  to a quarter of the export queue, and placeholder warnings carry a nonzero `count`.
  Migration: set `liveSpans: false` for the previous wire behavior. A wrapping processor that
  forwards `onStart` but scrubs, renames or drops spans in `onEnd` does not change their
  placeholders; scrub with `redact`, do not forward `onStart` for spans you filter, or set
  `liveSpans: false`. **Wire**
- A finished span no longer carries `hue.span_type` or `hue.pending_parent_id` attributes set by
  the application; Hue reserves them for placeholders. Migration: rename application attributes
  that use those keys. **Wire**

#### Added

- **Live spans.** A placeholder lets Hue show a trace, its request and its running model and tool
  calls before they finish. It is an ordinary OTLP span that names the running span as its
  parent, ends at 0 and carries `hue.span_type = "pending_span"` and `hue.pending_parent_id`;
  markers are added after redaction, and the content policy applies as for finished spans. A
  placeholder is queued at the transport's next 500 ms tick and sent with the next batch export
  (1 s batch delay), so it usually reaches Hue within about 1.5 s of its span starting: sooner when
  a batch is already scheduled, later while an earlier export is still in flight. A placeholder
  whose span has ended by export time is not sent, so a short span may send none. A request
  carrying only placeholders never fails `flush()`. **Wire**
- `liveSpans` option (default `true`; always off for setup credentials).

### [0.6.0] - 2026-09-23

#### Added

- Product-named eval set, evaluator, run and scoring methods on `EvaluationClient`, using the
  existing v1 paths. Responses retain both field names, and a run ID remains distinct from its
  scoring ID. Existing client methods and local runners remain callable.
- `hue eval --case` selects a published case by name, ID or URL; `--scenario` remains an alias for
  existing scripts.

#### Deprecated

- Older low-level evaluation client method names and the `--scenario` CLI flag now have product
  replacements. They remain supported for at least two subsequent `0.MINOR` releases. The v1
  response aliases remain available while the server compatibility window is open.

### [0.5.1] - 2026-09-23

#### Changed

- `hue login` asks for one **Read and write** key and stores it as both `HUE_API_KEY` and
  `HUE_MCP_KEY` (with `HUE_BASE_URL` and `HUE_MCP_URL`) in a single write. It checks evaluation
  access with `GET /api/v1/datasets`, so a **Read** or **Tracing only** key is refused before
  anything is stored instead of failing later in `hue eval`. `--keys evaluations` and
  `--keys coding-agent` still store one variable each; `--keys coding-agent` accepts a **Read**
  key.
- `hue login`, `hue eval`, the evaluation guides and the Hue skill name Hue's consolidated access
  presets: **Read and write** replaces **Tracing and evaluations** and **Coding agent (read +
  evaluations)**, and **Read** replaces **Coding agent (read-only)**. **Tracing only** is unchanged.
  Existing keys keep their access; only the names printed in prompts and errors change.

### [0.5.0] - 2026-09-22

#### Added

- `hue eval` runs document eval sets as **direct** cases: when the saved version's cases pin no
  simulated world (or with `--mode direct`), it creates one experiment through `runExperiment()`,
  hands each case's agent-visible pinned files to the agent and uploads the documents it produces.
  `--command` is spawned inside a private case directory with `HUE_CASE_DIR`, `HUE_CASE_INPUTS`,
  `HUE_CASE_OUTPUT_DIR`, `HUE_CASE_ID`, `HUE_CASE_KEY` and `HUE_EXECUTION_ID`; every file written
  to `output/` is uploaded (`manifest.json`, `result.json` and `summary.txt` are optional helpers).
  Adapter files receive a `DirectTargetContext` (`mode: "direct"`) and may return `withFiles(...)`.
  Code evaluators pinned to the run are left to Hue's grading executor (`deferUnboundLocalScorers`)
  and the verdict wait covers them; `--json` reports `mode` and `deferredScorerVersionIds`.
  `--set` also matches an eval set's slug, `--set-version <n>` pins a saved version and
  `--scorer <slug|name|id>` pins an evaluator at its newest published version.
- `runExperiment()` and `rescore()` accept `deferUnboundLocalScorers`: a pinned `local_code`
  version with no local binding is reported in `deferredScorerVersionIds` instead of refusing the
  run, so a customer process can upload outputs while a Hue-operated worker grades them, and a
  grading worker bound to one evaluator leaves other evaluators' pins alone. Scorer-only pinned
  files are downloaded only when a bound code evaluator runs in the process.
- `EvaluationClient.listEvaluationRuns()` pages the project's evaluation runs; `CaseFile.role`
  gains `evaluator_reference`, a scorer-only role for customer material an evaluator compares
  against. **Wire**
- `hue eval` runs a local adapter file or shell command against a published Scenario or a saved
  eval set through `runSimulation()`, or as an outbound worker through `runLocalAgent()`. It
  resolves Scenarios by name, ID or URL, creates a fresh experiment from the published pins, prints
  the run URL and per-case PASS/FAIL verdicts once Hue's outcome checks finish, compares against a
  `--baseline` experiment, emits `--json`, and exits 0, 1, 2 or 130. `HUE_API_KEY` must be a
  Tracing and evaluations key and is never printed; content capture stays off unless `--content`
  is passed, and in one-shot mode so does persisting case outputs and explanations (`--worker`
  keeps `runLocalAgent()`'s existing behavior of persisting them). A timed-out or interrupted
  `--command` agent is stopped by process group and then SIGKILL, and an interrupt during the
  verdict wait exits 130. Existing `setup`, `resume`, `status` and `claim` behavior and the
  JSONL event contract are unchanged.
- `runSimulation()` accepts `scenario: { kind: "pins", datasetVersionId, scorerVersionIds, config?, name? }`
  for already published immutable pins; the checkpoint identity binds those pins.
- `@hue-run/sdk/evals` exports `listScenarios`, `getScenario`, `resolveScenarioPins`,
  `resolveEvalSetPins`, `parseScenarioSelector` and `matchByName`, the `EvaluationClient` methods
  `listCaseConversions` and `getCaseConversion`, and the verdict helpers `waitForResults`,
  `summarizeVerdicts`, `compareVerdicts`, `collectExperimentVerdicts` and `metricPassed`, with
  their types.
- The portable skill gains an "Evaluate against a Scenario" section describing the `hue eval` loop
  for coding agents.
- `hue login` validates and stores keys created in Hue Settings > Integrations & API keys. The
  "Tracing and evaluations" key is checked with `GET /api/v1/projects/current` and stored as
  `HUE_API_KEY` with `HUE_BASE_URL`; the "Coding agent (read + evaluations)" key is checked with an
  MCP `tools/list` request and stored as `HUE_MCP_KEY` with `HUE_MCP_URL`. Keys are read without
  echo and never printed; `.env.hue` is written with mode `0600` through an atomic rename, symlinks
  are refused, `--force` replaces a different existing value and `--gitignore` adds the file to
  `.gitignore`. A run that stops after storing one key still applies that protection, and the
  printed next step carries `--url` for a non-default origin. The command never mints a key.
- `hue mcp install --client <claude-code|cursor|codex|vscode|windsurf|gemini>` writes, runs or
  prints Hue's canonical MCP client configuration for `https://mcp.hue.run/mcp` (`--url` selects
  another endpoint). The configuration references the `HUE_MCP_KEY` environment variable or a VS
  Code password input, never a key value; JSON files are merged so other servers are preserved,
  `--dry-run` previews the result and `--print` shows the snippet.
- `runExperiment()` runs file-based cases. Before an execution exists it downloads every pinned
  `inputFiles` entry of the frozen case, verifies its byte count and SHA-256, and passes the
  agent-visible roles (`source`, `attached_template`, `attached_reference`, `original`) as
  `context.files` with a private per-case `context.outputDirectory`. A download failure is an SDK
  failure that consumes no execution slot; evaluator-only `org_template` files reach scorers but not
  the target. **Wire**
- Targets return `withFiles(output, files)`, a `TargetResult`, to save generated documents. The
  runner stages each declared `path` or in-memory `bytes`, publishes them through artifact
  reservation, upload and verified completion with stable per-execution keys, and completes the
  execution with `artifactIds` and `primaryArtifactId`. Generated files are uploaded regardless of
  `persistResultContent`. A file that cannot be read, exceeds 25 MiB, repeats a filename or has an
  unsupported content type becomes the target's `TargetError` instead of an uncertain execution, and
  a crash after the target finished resumes from the staged files without invoking it again. **Wire**
- The `LocalFile`, `CaseFile`, `SubjectFile`, `OutputFile` and `TargetResult` types, the
  `targetFileRoles`, `outputContentTypes`, `outputFileLimits` and `safeFilename` helpers, and the
  `OutputFileError` raised for an unusable declared file.
- Local scorers receive `context.files`: every pinned input and every generated output with its
  verified local path, role, filename, content type, byte size, SHA-256 and artifact ID, using
  `role: "output"` for generated documents. A bound `local_code` callback runs when generated files
  exist even without a JSON output.
- `rescore()` downloads a subject's frozen `files` so code evaluators can grade saved documents
  without invoking an agent. It preserves terminal scores already recorded for an item and evaluator
  version, including built-in checks scheduled by Hue's **Grade again** flow, computes only the
  missing local scores, and accepts an exact matching item/version receipt when another executor
  finished the same score during upload; an unrelated conflict still fails. **Wire**
- `runLocalAgent()` accepts a `directTarget` callback for cases without a world. Supplying it
  registers the `direct:v1` capability and supplying `target` registers `environment:v1`, beside
  declared file capabilities such as `input:docx`, `input:pdf` and `output:docx`. New exports
  `localAgentCapabilities` and `registeredCapabilities`, which refuses a registration naming a
  capability without its callback.
- `runExperiment()` and `rescore()` accept `environmentEvidence: "when_pinned"` beside `"required"`,
  so direct cases skip the environment evidence read while cases pinned to a world still require
  sealed evidence; workers with `directTarget` use it. The new `filesDirectory` option relocates the
  verified input and generated output copies, which default to `<checkpointDirectory>/files`.
- `EvaluationClient` gains `getArtifact()`, `reserveArtifact()`, `requestArtifactUpload()`,
  `uploadArtifactBytes()`, `completeArtifact()` and `downloadArtifact()` for the artifact lifecycle
  the runner uses. **Wire**

**Requires** a Hue deployment that serves case input files on experiment items, subject files on
evaluation subjects, and the artifact reservation, upload, completion and download APIs. Python
remains at `0.2.3` and has no file-based cases.

#### Changed

- Documentation and examples now name the simulation `definition` / `SimulationDefinition` and
  use case terminology; the deprecated `scenario` option and `SimulationScenario` alias are
  unchanged. No API change.

No registry release is claimed until publication and registry acceptance complete.

### [0.4.2] - 2026-09-22

#### Added

- `runSimulation` accepts `definition` for the simulation definition, and `SimulationDefinition`
  is exported alongside the options type.

#### Deprecated

- The `runSimulation` `scenario` option and the `SimulationScenario` alias are deprecated in
  favour of `definition` and `SimulationDefinition`; they are removed no earlier than two
  subsequent `0.MINOR` releases per VERSIONING.md.

No registry release is claimed until publication and registry acceptance complete.

### [0.4.1] - 2026-09-21

#### Added

- `hue.tool(..., { mcp })` records the MCP `initialize` `serverInfo` as `mcp.server.name` and
  `mcp.server.version`, so a generic tool name can be attributed to the server that handled it.
  Pass `client.getServerVersion()` after connect; any MCP server works. Environment catalog
  entries may include the same `mcp` object, and `bindEnvironmentTools` stamps it automatically.
  **Wire**

No registry release is claimed until publication and registry acceptance complete.

### [0.4.0] - 2026-09-20

#### Breaking

- The unreleased setup-session placeholder is replaced by Setup HTTP protocol v1. The exported
  `SetupBackendAdapter` is now a concrete installation/status/credential/OTLP-receipt adapter rather
  than the historical `createTrial`/`verifyReceipt`/`getClaim` stub boundary. Migration: construct it
  with `{ projectRoot, origin? }` and pass it to `runSetup`, or use the `hue` executable. Existing
  `createHue`, exporter, evaluation and environment APIs are unchanged.
- Setup JSONL events now carry `contractVersion: 2` and schema identity
  `https://hue.run/schemas/setup-events-v2.json`. Version 1 shipped in `0.3.1` and `0.3.2` with a public
  claim URL and different step/action fields. Migration: consume the bundled v2 schema, handle the
  non-secret local-handoff actions and `privacy.notice`, use `verify-application-receipt`, and require
  `receipt.verified.source: "repository-http-boundary"`. Claim events no longer include a URL.
  Setup HTTP `protocolVersion: 1` is independent and remains an unreleased protocol candidate.

#### Added

- The `hue` executable implements the unreleased Setup HTTP protocol v1 candidate: per-project/per-origin
  installation proof is persisted before network writes, provisioning and credential recovery are
  idempotent, and account claim reconciles generation 1 while checking generation 0 revocation.
- The automatic matrix is Express with npm, Express with Bun, and Flask with uv in one package
  with an unambiguous existing entrypoint, literal GET route and environment-selected port. Setup
  installs exact runtime versions through that manager, adds bounded owned middleware blocks without
  rewriting business logic, makes one request to the existing route and verifies its exact trace/span
  receipt. That original evidence is preserved through account claim without replaying business work.
  Monorepos, mixed managers, custom runtime versions and unfamiliar shapes require an explicit action.
- Technical preflight reports availability and presents the published privacy and security notice
  before telemetry. The anonymous ingestion window is 24 hours with limits of 100 traces, 1,000 spans
  and 2 MiB; unclaimed data is purged seven days after expiry.
- Both credential generations use the isolated setup token namespace and sole
  `setup_telemetry_write` capability. Exact receipts use the dedicated setup route. Normal and unknown
  token substitutions are refused; content capture requires a separate account-managed key.
- Managed credentials stay in ignored atomic `0600` files; custom conflicts, symlinks, unsafe paths,
  insecure hosted origins, redirects and unexpected edits fail closed. Setup creates no Scenario,
  Hue Run, evaluation, source capture, worker or remote execution.
- Human terminal and noninteractive version-2 JSONL agent modes support interruption/resume, private
  one-time browser handoff, post-claim status reconciliation and bounded retries. Handoffs last at
  most ten minutes, browser sessions at most thirty minutes, and each installation permits at most
  32 handoff IDs. Only an explicit human restart replaces a handoff; public output contains no claim
  capability. Installed-tarball checks cover both modes and both project languages against a loopback
  protocol service; a separate
  staging/live runner records only secret-free evidence.
- The unpublished `hue-run` npm alias tracks `0.4.0`, pins `@hue-run/sdk@0.4.0`, mirrors setup exports
  and includes its own `hue` executable wrapper. Alias publication remains a separate release gate.

No registry release is claimed until publication and registry acceptance complete.

### [0.3.2] - 2026-09-20

#### Fixed

- `runSimulation()` and `runLocalAgent()` accept an authoritative `expired` world after a failed
  finish request, allowing execution and experiment finalization while preserving the target
  outcome and expired evidence. Unconfirmed seals still remain uncertain without replaying the agent.
- Availability documentation records TypeScript `0.3.1` as published, including scorer deferral
  and the local setup CLI core.

The [release artifacts](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.3.2) are published and passed registry acceptance.

### [0.3.1] - 2026-09-20

#### Added

- The `ScorerDefinition` union and publication validator accept Hue-executed `world_outcome`
  pins with their fixed entry and metrics. They require no local scorer registration.
- A dependency-free `hue` setup-session CLI and `@hue-run/sdk/setup` installer contract provide
  deterministic local project detection, private resumable checkpoints, append-only human/plain
  renderers and versioned JSONL agent events. This first slice does not change project files, contact
  the Hue backend, or create a Scenario, evaluation, worker or Hue Run.
- The unpublished npm alias tracks the new package exports and version. Public installation still
  uses `@hue-run/sdk`; alias publication remains separate.

#### Fixed

- Local evaluation runners execute only known `builtin` entries and bound `local_code` scorers. Other kinds
  remain pending and appear in `deferredScorerVersionIds`, including kinds introduced by a newer
  server. Unknown built-in entries are deferred too. The SDK does not upload placeholder results
  for deferred scorers, including placeholders saved by an older SDK before an interrupted upload.
- Availability documentation now records the already-published worker correctly. The setup CLI core
  was merged after publication and first belongs to this new release, not the existing 0.3.0 archive.

The existing `runLocalAgent` API, V2 connection bundle, provider transport, environment lifecycle,
checkpoint formats, telemetry ownership and capture defaults are unchanged. Python remains at 0.2.2.
No registry release is claimed until publication and registry acceptance complete.

### [0.3.0](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.3.0) - 2026-09-19

#### Breaking

- `runSimulation()` now gives candidate callbacks only case identity and cloned task inputs, excluding expected criteria, case metadata and environment pins. Migration: move candidate-visible metadata into task inputs or candidate configuration. Scorers retain their evaluation context; generic `runExperiment()` callbacks are unchanged.
- `EnvironmentVersion.definition`, `EnvironmentClient.publishVersion()` and repository-authored simulation definitions now use `PublishableEnvironmentDefinition`, whose discriminator is `schemaVersion: 1 | 2`, rather than assuming V1. Migration: consumers that access V1-only definition fields must first narrow `definition.schemaVersion === 1`, or annotate known V1 values as `EnvironmentDefinitionV1`; use `EnvironmentDefinitionV2` only when supplying `providerInstances`.

#### Added

- `runLocalAgent()` connects a fixed local TypeScript agent entry point to app-launched, versioned simulation jobs while preserving checkpoint recovery and the developer's existing process, debugger and provider orchestration.
- `runLocalAgent()` and `runSimulation()` share one provider-aware world lifecycle: V2 manifest preflight runs once before target code, ready bundles remain memory-only, incomplete environments skip targets and scorers, and uncertain preparation is never reacquired or replayed.
- Environment publication supports explicit V1 and V2 definitions, including immutable Gmail provider-instance bindings and canonical synthetic-principal UUID comparison.

### [0.2.2](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.2.2) - 2026-09-18

#### Fixed

- Export-time byte accounting walks arrays by element, matching admission, so array-heavy records such as embeddings that fit `maxQueueBytes` are exported instead of failed as `invalid`.

### [0.2.1](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.2.1) - 2026-09-18

#### Changed

- The package description no longer ends with `(hue.run, not Philips Hue)`.

### [0.2.0](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.2.0) - 2026-09-18

#### Breaking

- `zod` is an optional peer required when importing `@hue-run/sdk/evals`; `ajv` remains a separate optional peer used only by `builtins.jsonSchema`, which reports `SchemaValidatorUnavailable` when it is absent. The tracing core now depends only on `@opentelemetry/*` packages. Migration: run `npm install zod` (4.6.5 or later) for evaluations or simulations, and add `ajv` (8.17 or later) when using JSON Schema scorers.
- Export requests use explicit configuration only: `OTEL_EXPORTER_OTLP_*` environment variables no longer reach Hue's endpoint, and requests carry a `hue-sdk-typescript/<version>` User-Agent. **Wire** Migration: none for documented configuration; headers or endpoints that reached Hue through those variables were unintended and have no replacement.
- `hue.tool()` spans are named `execute_tool {name}` (`gen_ai.tool.name` keeps the bare name), matching the Python SDK and the GenAI semantic conventions. **Wire** Migration: match tool spans on `gen_ai.tool.name` or the `execute_tool ` prefix instead of the bare span name.
- Failed helper spans carry `error.type` (the error's `name`), an ERROR status without a description and an `exception` event with only `exception.type`; exception messages and stack traces are no longer recorded even with `captureContent: true`, matching the Python SDK. **Wire** Migration: group error dashboards on `error.type` and keep stack traces in application logs.
- Metadata-only mode also strips OpenInference retrieval documents, embeddings, reranker query and documents, prompt-template text and variables, `llm.tools`, `llm.function_call`, `llm.choices`, input/output images, and AI SDK `ai.response.reasoning` and `ai.response.files`; `contentPrefixes` lists the full set. **Wire** Migration: applications that relied on those fields reaching Hue with `captureContent: false` must set `captureContent: true`.
- `HueTransport`'s exporter plumbing (`finish`, `acceptedRecords`, `issue`, `instrumentationFailure`) is `@internal` and no longer appears in the published declarations. Migration: none for documented usage; read `getReport()`, `getIssues()` and `getFailureSequence()` instead of calling these members.

#### Added

- TypeScript environment APIs and bounded local tools through the new `@hue-run/sdk/environment` export, plus evaluation-client support for execution-scoped hosted MCP capabilities.
- TypeScript `runSimulation()` for repository-authored or app-authored scenarios, with immutable definition pins, fresh isolated worlds, resumable uploads, evidence-aware scoring, and early run URLs.
- V2 attempt-profile preflight for `runSimulation()`, including explicit actual-manifest evidence, typed provider connection bundles, secret-free V1/V2 binding reads, stable refresh/revocation checks, and the backwards-compatible `context.mcp` projection.
- `./package.json` export, `sideEffects` metadata, `bugs` and `keywords` in the package manifest.
- `hue.model(model, callback, options)` creates a GenAI client span for a direct provider call, taking the callback before its options like `withSpan`; `options` carries `provider`, `operation` and `name` plus `sessionId`, `userId`, `input` (recorded as `gen_ai.input.messages`) and `parentContext`. `HueSpan.setUsage()` records validated token counts, matching the Python helpers.
- `hue.inject()` / `hue.extract()` carry W3C trace context between processes without baggage or credentials.
- `hueExperimentalTelemetry(hue)` from the core entry point for AI SDK 6 `experimental_telemetry`; `hueTelemetry` remains AI SDK 7 only.
- `contentPrefixes` exports the attribute keys removed in metadata-only mode.
- Bun 1.4.2 runs the installed-package behavioral suite and the reference chatbot in package verification, and `bun pm pack` must agree with `npm pack` on package contents.
- `require("@hue-run/sdk")` and the other entry points work from CommonJS on Node.js 22.12 or later: every `exports` entry carries a `default` condition and the build has no top-level `await`; package verification exercises the `require()` path.
- `resourceAttributes` on owned-client options adds resource attributes such as `deployment.environment.name` to the owned resource, with `serviceName` and `serviceVersion` taking precedence over same-named keys; attach mode ignores it with a warning issue.
- `allowInsecureHttp: true` permits `http://` to hosts other than loopback, such as a docker-compose or in-cluster collector, and records a one-time warning issue.
- `HueConnectionError.cause` carries the underlying network, timeout or parsing error from `checkConnection()`.
- `recordMessages` accepts `operation`, `provider` and `model` for the request attributes of the details record.
- `hue.tool(name, input, execute, { callId })` records `gen_ai.tool.call.id` on the tool span, matching the Python `call_id=` keyword; a blank id is omitted with an instrumentation failure.

#### Changed

- The instrumentation scope version and export User-Agent come from a literal generated from `package.json` at build time; nothing reads `package.json` at import time, so bundled deployments are unaffected.
- `engines.node` is `>=22.12`; Node 22 and 24 are tested and Node 26 runs in CI.
- npm releases carry provenance attestations; the release workflow refuses to publish from a private source repository.
- `createHue({ enabled: false })` no longer requires `captureContent`; a disabled client defaults it to `false`.
- Export requests are sized from each record's own encoding and encoded once when sent, instead of re-encoding the growing batch for every record; the 1 MiB request split and oversized-record reporting are unchanged.
- `hue.tool`, `setInput`, `setOutput`, `recordMessages` and `SpanOptions.input` accept `unknown`, so interface-typed values compile without casts; `JsonValue` remains the documented wire shape and values that are not JSON are still omitted at runtime with an instrumentation failure.
- `recordMessages` sets `gen_ai.operation.name`, `gen_ai.provider.name` and `gen_ai.request.model` (from the enclosing `model()` span or the caller) and `gen_ai.conversation.id` (from the active session) as attributes on the `gen_ai.client.inference.operation.details` log record, alongside the existing body. **Wire** The Python `log_inference` record does not carry these attributes yet (tracked in #37).
- `hueTelemetry` reads the installed `ai` major version once per process and rejects only versions below 7; the peer range enforces the `7.0.99` floor.
- Every exported type, option and member of the four entry points carries API documentation, and the TypeScript reference build fails on undocumented public API.
- The package description ends with `(hue.run, not Philips Hue)` so registry listings are not mistaken for smart-lighting libraries.

#### Fixed

- Repository simulations normalize every public scorer definition default before immutable digest lookup and reject unsupported server-only scorer kinds instead of publishing an incompatible identity.
- The managed-target README snippet passes `tracer: hue.tracer`; without it every invocation returned `uncertain`.
- `withSpan`, `tool`, `model` and `hue.tracer.startActiveSpan` make their span the active OpenTelemetry span while the callback runs, so spans from instrumentations that use the global API parent under Hue spans when the application has registered a context manager; Hue still registers none. A disabled client leaves the application's active span visible through `getContext()`, `HueSpan.context` and `inject()`.
- Owned providers export the OpenTelemetry default resource (`telemetry.sdk.language`, `telemetry.sdk.name`, `telemetry.sdk.version`) beside `service.name` and `service.version`. **Wire**
- `createHueSafe` keeps the caller's `onExportIssue` on the disabled fallback client and records the configuration error's message as the reported issue.
- `hue.inject()` propagates W3C trace context when the client is disabled or closed, matching the Python SDK.

### [0.1.5](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.1.5) - 2026-09-17

#### Changed

- Pending telemetry is bounded by bytes as well as records, including in-flight exports; the default `maxQueueBytes` is 8 MiB across traces and logs. Omissions and drops are reported through cumulative health counters.
- The `ai` peer range accepts AI SDK 6 for core installation; `hueTelemetry` still requires AI SDK 7.

#### Added

- `createHueSafe`, `enabled: false`, `flushSafe` and `shutdownSafe` with a default one-second caller deadline. Strict diagnostic APIs remain.
- Installed-package regressions for outages, oversized data, redactor failures, queue saturation, cancellation, stuck providers and trickling responses.

#### Fixed

- Helper capture, redaction and provider failures are isolated from application results and errors; business callbacks never rerun.
- Transport work and acknowledgements are bounded, and rejected diagnostics are isolated from the application.

### [0.1.4](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.1.4) - 2026-09-16

#### Added

- `@hue-run/sdk/managed`: managed-target adapters with scoped execution claims, verified file bytes, existing-provider trace context, idempotent outcomes and telemetry acknowledgements.

#### Fixed

- Saved outcomes are preserved when flush callbacks report failure or pending records; expired callback budgets and malformed trace or file identities are rejected before agent work starts.

### [0.1.3](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.1.3) - 2026-09-16

#### Added

- `hue.verifyTrace()` verifies persisted application traces by OpenTelemetry trace ID, expected span IDs and required field presence using bounded, authenticated receipt requests. Export acknowledgement, stored evidence and content inspection stay distinct; incomplete receipts and safe authentication or transport failures are reported.

### [0.1.2](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.1.2) - 2026-09-15

#### Added

- First public npm release under MIT with the core, AI SDK and evaluation entry points.
- Hosted-judge authentication and charge-reconciliation metadata in the TypeScript declarations.
- Documented runtime and integration matrix, including dependency-resolution and cross-language content and delivery boundaries; verified release archives and registry bytes.

## hue-run (Python)

### [0.13.4] - 2026-10-20

#### Added

- **Wire** HTTP tool spans accept endpoint evidence from the request, resolved client configuration, or receipt. URLs exclude credentials and fragments, redact query values by default, and follow the content-capture and redaction policies. An explicit allowlist can retain permitted routing query values. Instrumentation records the existing execution without another lookup or tool call.
- **Wire** `hue.subagent(name, input=..., parent_context=...)`, a context manager and a decorator
  for functions and coroutine functions, opens an `invoke_agent {name}` span carrying
  `gen_ai.operation.name` `invoke_agent`, `gen_ai.agent.name` and the new `hue.agent.role`
  `subagent`, as the TypeScript SDK does. It nests under the active span, normally the `tool()`
  span of the call that started the sub-agent, or under `parent_context`, for example
  `Hue.extract(headers)` in another process. `input` and a decorated function's result follow
  `capture_content` as `input.value` / `output.value`; errors are recorded as in `span()`.

#### Changed

- Update the certified OpenTelemetry dependencies to `1.45.1` / `0.66b1`, OpenInference OpenAI to `0.1.65`, instrumentation to `0.1.71`, and semantic conventions to `0.1.41`. Update development type tooling and the pinned release Actions.

### [0.13.3] - 2026-10-20

#### Added

- `verify_trace` adds `project` (a `Project` or `None`, default `None`) to `TraceVerificationResult` once Hue reports the trace missing: the project the key searched, so a key for another project is told apart from a trace that is not stored yet. `verified` and `receipt` are unchanged.

### [0.13.2] - 2026-10-18

#### Added

- `agent_environment` strips `hue_it_` import authorizations from an agent child's environment like
  the other Hue control-plane credentials (`HUE_CONTROL_PLANE_CREDENTIAL_PREFIXES`).

### [0.13.1] - 2026-10-18

#### Added

- World model results and errors expose optional typed processing and preparation progress.

#### Fixed

- World model errors retain only validated progress fields from at most 16 KiB of response data.
  Insufficient-evidence and processing-limit diagnostics stop unchanged retries. Ordinary transient
  failures keep their existing retry behavior.

### [0.13.0] - 2026-10-18

#### Changed

- **Breaking** World materialization, instance creation and reproduction now wait up to 120 seconds
  when Hue explicitly reports `world_preparing`, separately from the ordinary `max_attempts` limit.
  Retries preserve the request body and idempotency identity. Migration: pass a `threading.Event`
  through `cancel_event` to cancel a preparation wait or active HTTP read. Other failures retain
  the configured attempt limit.

#### Added

- The World client names, `WorldModelClient` and instance methods use the canonical World,
  World model and instance routes. The environment module
  and its HTTP paths remain supported. The handoff's legacy `worldId` still identifies an instance.


### [0.12.1] - 2026-10-16

#### Changed

- **Wire** An attribute Hue reads as JSON whose whole text is a `data:` URL instead is read as that file, as Hue's reader reads it: it uploads in the background and becomes a digest-form `blob` part keyed `<attribute>#`, as in the TypeScript SDK. Before, the base64 was exported inline. Other text that is not JSON stays as recorded.
- **Wire** Raw 16-bit PCM keeps the format its media type declares. A file typed `audio/pcm`, `audio/x-pcm` or `audio/L16` with a `rate` from 8000 to 192000 and 1 or 2 `channels` (a `data:` URL's header or a part's declared type) is reserved and listed as `audio/pcm;rate=<rate>;channels=<n>` (`audio/L16;…` for big-endian samples), and OpenAI `pcm16` audio as `audio/pcm;rate=24000;channels=1`, so Hue plays the stored file; the part's own fields stay as recorded. Before, the parameters were dropped and the file could only be downloaded.

### [0.12.0] - 2026-10-16

#### Changed

- **Breaking** **Wire** File and large-value uploads no longer hold up export, as with Langfuse and Braintrust. The export thread hashes each value, writes its reference into the record (the digest part, or the 16 KiB prefix with `hue.truncated`, and its `hue.blobs` entry) and sends the record; the bytes upload on up to four background `hue-upload` threads. A slow, rate-limited or failing upload never delays, holds or drops a span or log record, and a later `force_flush` sends its own records without waiting for earlier uploads. Hue shows the file once its bytes land; until then it reads the entry as not uploaded. A value refused when its record is exported (uploads closed, a receiver without the upload route, over 1 GB, 1,024 uploads already pending, or the held budget full) keeps the earlier fallback form.
- **Breaking** Uploads no longer share an export's 60-second rate-limit hold or upload budget, and the 30-second upload pause after a failure is removed. Reservation, PUT and completion are each tried up to three times on no answer, 408, 429 or 5xx, waiting `Retry-After` (up to 60 s) or a jittered backoff; a failed completion never fails the upload. The 128 MiB held budget stays charged until a record's uploads settle.
- **Breaking** `force_flush()` and `shutdown()` (and a borrowed provider's flush through Hue's processors) send records first, then wait for uploads already queued within the same deadline; shutdown gives pending uploads up to 30 s. `export_status.uploaded_values` counts an upload when it completes; an upload that fails after export counts in `export_status.upload_fallbacks` under the `not_uploaded` warning.
- **Wire** A `hue.blobs` entry's `content_type` is the type its own reference declared, and a receiver without the upload route is remembered for the life of the client.

### [0.11.2] - 2026-10-13

#### Added

- `Attachment(path=...)` and `span.record_file(path=...)` take a regular file over 25 MiB, up to Hue's 1 GB upload limit, as in the TypeScript SDK 0.18.2: the file is hashed a 1 MiB slice at a time when it is recorded and read again from disk when it is uploaded, so it is never held in memory and does not count against the 128 MiB held for values awaiting upload. Each slice is hashed as it is sent and the last is sent only once the file ended at the size and SHA-256 it was recorded with; a file that changed, is gone or is no longer a regular file by then is not uploaded, without waiting on a named pipe in its place (the request ends before its body is complete, and Hue's upload URL signs the size and SHA-256, so the store refuses other bytes) and counts in `export_status.upload_fallbacks`, its part or event keeping the digest it was recorded with. `record_file` takes `path` in place of `data` (not both); a file up to 25 MiB given by path is read when it is recorded, as `data` is. Bytes given in memory (`data`) keep their 25 MiB limit, since they are held until export. Uploads follow `capture_content`, setup keys, the redactor and fallback counting as before. All uploads of one export share its upload budget, six export timeouts (60 seconds at the default `export_timeout_seconds` of 10), so a 1 GB file needs about 17 MB/s at the defaults; raise `export_timeout_seconds` for slower links.

#### Fixed

- **Wire** Inline media in a span's own attribute past the media inspection bounds (8 Mi UTF-16 code units for one attribute, 16 Mi for a record) is uploaded as files, as in the TypeScript SDK 0.18.2: 0.11.1 uploaded such a value whole as JSON text, its first 16 KiB inline, so a model call's 10 MB base64 audio part reached Hue inside that text instead of as an audio file. An attribute held whole for upload past the bounds (it is over the value limit) now has its media read in place when it is exported: each string in it longer than 16 Ki code units and written without escapes as strict base64 or a base64 `data:` URL is decoded, hashed and uploaded a 1 MiB window at a time from the recorded text, never parsed or copied out of it, up to Hue's 1 GB upload limit, and the value is placed exactly as one within the bounds: the same digest form, `hue.blobs` entries and fallbacks, every other byte of the recorded text kept. No step of the scan holds the interpreter for more than a window; at 300 MB of audio the longest pause another thread saw during the flush was about 60 ms, and the flush held about 2.4 MB beside the value. A long string no file replaced is uploaded or kept from its place without a second copy. The JSON around those strings, files written with escapes or inside a JSON-encoded string included, is parsed within the 8 Mi bound; a value past it, or one whose long file is a percent-escaped `data:` URL, still uploads whole. Admission parses nothing more on the application's thread; each such value's JSON is read within the 8 Mi bound on its own, apart from the record's 16 Mi allowance, while the value stays held within the 128 MiB for values awaiting upload, and fallback counting and the exporter's request limits are unchanged. Log records keep the bounds. The shared corpus gains cases with files of 6.3 MB in both SDKs.
- **Wire** Text with a lone surrogate is hashed, uploaded and cut as the TypeScript SDK encodes it, each lone surrogate as U+FFFD (`EF BF BD`): 0.11.1 failed to encode such a value, so its fallback went uncounted and an upload over the value limit was cut instead. A shared corpus section, `placements`, pins both outcomes in both SDKs.
- Placing many files in one value no longer takes time quadratic in them: 20,000 edited parts took about 90 seconds and now take well under one.
- A path that is not a regular file, such as a named pipe or a device, no longer blocks the application: `Attachment(path=...)` and `span.record_file(path=...)` open it without waiting and refuse it, an invalid attachment recorded as `None` and a refused file omitted, each counted as an instrumentation failure, as in the TypeScript SDK 0.18.2. A named pipe given by path used to block the caller until something wrote to it.
- **Wire** The media type a `data:` URL names is trimmed of the whitespace JavaScript trims, as the TypeScript SDK reads it: a type followed by another Unicode space character (such as U+0085) is no valid type, and the file uploads as `application/octet-stream` in both SDKs, where 0.11.1 trimmed the character and uploaded the declared type. The shared corpus pins the case.

### [0.11.1] - 2026-10-12

A limitation that 0.11.0 already had and that this release keeps: an `Attachment` in a value that is still over the value limit with its files as digest parts is uploaded and listed under `hue.blobs` at `<attribute>#<pointer>`. Its bytes are stored, and `client.media.fetch(trace_id=..., sha256=...)` and Hue's span read reach them by digest. The value itself uploads whole and keeps only its first 16 KiB inline, so readers do not place the file at its position in the value.

#### Fixed

- **Wire** A text file that a GenAI `blob`, Vertex `media` or AI SDK `file` or `image` part holds as bare base64 is read as Hue reads it, as in the TypeScript SDK 0.18.1: its decoded bytes are measured against the 64 KiB inline limit, uploaded and placed in the digest form, keyed at the part. Base64 is the encoding the GenAI conventions give `blob` content, and what `client.media.resolve` and `rehydrate_media` write back into a `blob` or `media` part for every media type; 0.11.0 read such content as the text itself whenever its media type was textual, so recording a resolved 72,000-byte text file again uploaded its base64 text and kept that text's first 16 KiB. Content that does not read as base64 (a length divisible by four, base64 characters only) is still the file's own text and keeps the 16 KiB prefix form; a `data:` URL and a field its convention declares base64 are read as before.
- A refused `client.media.fetch` of a snapshot's copy (`MediaFetchError` reason `forbidden`) says that a snapshot's files need a Read and write key; its message named a Read or Read and write key, which is what a trace's files need. `MediaFetchError` takes a keyword-only `snapshot` argument that selects this message.
- `add_case(files=...)` and `add_eval_set_case(files=...)` no longer hold every file given as a `path` in memory at once: each file is hashed in 1 MiB slices when the case is checked and read again when it is uploaded, one file at a time, so 32 files of 25 MiB no longer peak at about 850 MiB. Only bytes that match the checked size and SHA-256 are sent, as in 0.11.0 only the checked bytes were; a file that changed after its check, or can no longer be read, sends nothing: the write raises `ValueError` (`Case file N changed after it was checked.`, or `could not be read.`) and the case is not written. The upload's requests, `Content-Length`, reservation keys and checks are unchanged; `data` given in memory is used as before.
- A span with large inline media in `input.value`, or in any other attribute the SDK inspects, no longer leaves about three copies of the value for Python's cycle collector: the media walk, the JSON locator and the JSON editor each kept the value's parse, its decoded files and its text alive through a reference cycle after they returned. Strict base64 is decoded without an extra ASCII copy, and uploads read bytes through views. Exported attributes, `hue.blobs` entries, upload bodies and the held-value budget are unchanged. Spans exported one at a time, each with a 576 KiB image in `input.value`, peak at about 4.6 MiB of Python allocations, as with 0.10.0 (4.4 MiB), instead of 27.5 MiB; 280 such spans queued at once peak at about 190 MiB RSS instead of 207–220 MiB, most of it the 128 MiB budget for values awaiting upload. 0.10.0 dropped most of those spans from its queue instead.

### [0.11.0] - 2026-10-12

#### Breaking

- **Wire** Inline media is found and uploaded beyond the three recorded message attributes, as in the TypeScript SDK 0.18.0: `ai.prompt`, `input.value` and `output.value` (what `span()` records), `traceloop.entity.input`/`output`, Langfuse observation and trace inputs and outputs, tool arguments and results (`gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `ai.toolCall.args`, `ai.toolCall.result`, `tool.parameters`, `tool_arguments`, `tool_response`), metadata (`metadata`, `langfuse.observation.metadata[.<key>]`, `langfuse.trace.metadata[.<key>]`, `ai.telemetry.metadata.<key>`), OpenLLMetry's `gen_ai.prompt.<n>.content` and `gen_ai.completion.<n>.content` parts lists, and OpenInference's flattened image URLs. An uploaded file takes the digest form in place, listed in `hue.blobs` under `<attribute>#<JSON pointer>`. A file in one of these attributes that is not uploaded keeps its bytes inline, as in 0.10.0. Files are read only where Hue's reader reads them: no deeper than ten levels below a value's root, not in attribute JSON Hue keeps as text (nested past 32 levels, or holding an integer past 2^53), and not in an OpenInference `input.value` or `output.value` declared `text/plain`. The same holds for the recorded message attributes: a message attribute holding an integer past 2^53 (or nested past 32 levels), or a part more than ten levels deep, now keeps its media inline where 0.10.0 uploaded it or replaced it by its digest, because Hue keeps such JSON as text and never reads those files. Migration: a reader of these attributes finds `sha256` and `size` where inline bytes were and resolves the bytes through the entry (or `client.media`); Hue reads every form.
- **Wire** Placing a file changes only its own value (a whole `data:` URL string) or the members of the part that held it; every other byte of the recorded JSON text, its key order, number spellings, escapes and spacing included, is kept, in the recorded messages too, so both SDKs write the same bytes. 0.10.0 wrote a message attribute's JSON again with Python's `json.dumps`. Migration: none for a JSON reader.
- **Wire** A whole `data:` URL string declaring a media type is uploaded and replaced by a GenAI `blob` part keyed at its pointer (a metadata value that is entirely one becomes the part's JSON text, keyed `<attribute>#`); text data URLs up to 64 KiB stay inline. OpenAI Chat assistant `audio` and Responses `computer_screenshot` upload; files inside JSON-encoded tool arguments and results upload and take the digest form inside the string, the rest of the string kept byte for byte. The shared corpus pins byte-identical entries and values with the TypeScript SDK.
- **Wire** Log records correlated with a span upload their media: `log_inference`'s `gen_ai.client.inference.operation.details` record and any `gen_ai.*` event with a structured body, under the log record's trace, listed in its own `hue.blobs` with keys `body#<JSON pointer>` or `<attribute>#<JSON pointer>`; its inline media take the 64 places before the attachments in its body. In 0.10.0, a log record's media up to 64 KiB stayed inline and larger media became its digest without an upload. A log file that is not uploaded is placed as in 0.10.0: a file over 64 KiB in a recorded message attribute becomes its digest and anything else keeps its bytes; text over the value limit is still cut inline. `log_inference` records a field over the value limit when, with its files as their digest, it fits the limit while uploads are available; 0.10.0 omitted the field. Migration: a log reader that takes a body's inline bytes reads the digest form and the entry instead.

#### Added

- **Wire** `hue_sdk.Attachment` places a file anywhere in a recorded value, the equivalent of Langfuse's `LangfuseMedia` and Braintrust's `Attachment`: `Attachment(data, path=..., content_type=..., name=...)` in a `span()` input or output, `model()` messages, a tool's arguments or result, `log_inference()` messages, or a span attribute passed to `span(attributes=...)` or `set_attribute` (an attachment, a dict or a list OpenTelemetry cannot hold, with or without attachments, recorded as JSON text). It is recorded at its position as a GenAI `blob` part in digest form, `{"type":"blob","mime_type","modality","sha256","size","name"}`, and its bytes are uploaded during export and listed under the record's `hue.blobs` as `<attribute>#<JSON pointer>`; in a `log_inference()` body it uploads with the body's other media, under `body#<JSON pointer>`. `data` accepts bytes or a base64 string or `data:` URL; `path` is read when the attachment is created; both are limited to 25 MiB. Uploads follow `capture_content`, setup keys, the redactor, the upload budget and fallback counting of other media; a part nested more than 10 levels deep keeps its digest without an upload. An invalid attachment is recorded as `None` and counted as an instrumentation issue; an invalid name alone is omitted and counted.
- **Wire** `EvaluationClient.media.fetch(trace_id=..., sha256=..., span_id=None)` reads one recorded file back by digest through `GET /api/v1/traces/{traceId}/blobs/{sha256}` (`snapshot_id=` reads a trace snapshot's pinned copy), downloads the short-lived link without the project key and refuses bytes whose SHA-256 is not the digest. It returns a `MediaFile` (`data`, `sha256`, `size`, `content_type`, `file_name`) and raises `MediaFetchError` with a `reason` (`not_found`, `missing`, `unavailable`, `forbidden`, `too_large`, `digest_mismatch`, `failed`); an unavailable answer is asked once more after its `Retry-After` of up to 10 seconds, as is a request whose connection fails or times out; an answer over 64 KiB fails at once, even when its connection then fails; a redirect fails with its status. A trace's files need a Read or Read and write key, a snapshot's a Read and write key. This is the counterpart of Braintrust's `ReadonlyAttachment` and Langfuse's media fetch.
- `EvaluationClient.media.resolve(value, trace_id=..., span_id=None, as_="data_url", blobs=None)` writes the bytes of every digest part in a recorded value back into the part's own field, as a `data:` URL or the bare base64 its convention requires (a GenAI `blob` or Vertex `media` part receives base64 for every media type), or as `bytes` (`as_="bytes"`), downloading each distinct digest once with bounded concurrency; `blobs`, the record's `hue.blobs` entries in any form Hue reads (JSON strings, dicts, or one string holding the JSON array), gives a part that declares no media type its entry's type (a snapshot's copy carries none); a part holding only the first 16 KiB of a text file over 64 KiB, its content field named by an entry, is never written and is listed in `failures` as `prefix_only` with the entry's SHA-256, whose whole file `media.fetch(trace_id=..., sha256=...)` returns. It returns a `ResolvedMedia` whose new `value` leaves the parts it could not read unchanged and lists them in `failures`, like Langfuse's `resolve_media_references`. Parts inside JSON-encoded strings, such as tool-call arguments, are left as they are.
- `rehydrate_media(inputs, files)` writes a case's local files back into the digest parts of its inputs by SHA-256, so a target can send a recorded model call again with the real image, document or audio.
- **Wire** `add_case(files=...)` and `add_eval_set_case(files=...)` pin up to 32 input files: `CaseFileWrite(role=..., artifact_id=...)` references, or files given as `data` or a `path` that the client checks against the artifact policy (content type, a name of 1 to 255 UTF-16 code units, 1 byte to 25 MiB) and uploads as verified artifacts under keys that make a repeated write reuse them and a corrected name or content type reserve a new one. The whole case is checked before the first upload, each artifact is pinned once per role, and a `path` that cannot be read is refused with a `ValueError`. The client gains the artifact methods it uses: `reserve_artifact`, `request_artifact_upload`, `upload_artifact_bytes`, `complete_artifact`, `get_artifact` and `download_artifact` (`ArtifactSizeError`).
- `run_experiment` downloads a case's pinned input files under `files_directory` (default `<checkpoint_directory>/files`) and checks them against the manifest before the execution starts, as the TypeScript runner does: targets receive the agent-visible ones as `TargetContext.files` (`LocalFile`); evaluator-only files are checked then but written for local code scorers only after the target finishes, never on disk while it runs, and removed when the case ends; scorers receive every file as `ScoreContext["files"]`. The target's outcome is saved before those files are fetched, with the count of spans the case ended, so a failure there resumes and completes without running the target again, as in TypeScript. A mismatch raises `CaseFileError` without spending the execution. `rescore` passes a subject's frozen files to local code scorers the same way.

#### Fixed

- A `hue.blobs` key's 256 limit is counted in UTF-16 code units, as Hue and the TypeScript SDK count it: a key of astral characters past the limit was reserved and refused by Hue. Such a file now stays inline and is counted in `export_status.upload_fallbacks`.

### [0.10.0] - 2026-10-10

#### Breaking

- **Wire** Nonempty binary media in a span's own recorded message attributes is now eligible for upload at every size within the media inspection limits and exports as the part's `sha256` and `size`. The `hue.blobs` key points to the part, for example `gen_ai.input.messages#/0/parts/1`. Successful uploads previously kept a 16 KiB prefix in the byte field and pointed to that field. Text media over 64 KiB still keeps a 16 KiB UTF-8 prefix and a content-field entry. Upload failures retain the digest without a blob entry. Migration: readers must resolve the part-level entry for binary media. Hue reads both forms.
- `hue.file.name` now uses the same rule as blob names: nonblank after trimming, at most 256 UTF-16 code units, well-formed Unicode, and no C0 characters (U+0000–U+001F) or DEL (U+007F). Migration: remove tabs, newlines and DEL from names, and limit astral characters to 128 when the name contains only those characters. An invalid `record_file` name is omitted and counted as an instrumentation failure; the otherwise valid `hue.file` event remains. Existing role, media-type, digest and size validation is preserved.
- **Wire** Managed evaluation outputs now accept only the same 22 content types as TypeScript: PDF, DOCX, PPTX, XLSX, JSON, plain text, CSV, PNG, JPEG, WebP, GIF, AVIF, MPEG audio, WAV, Ogg, WebM audio, MP4 audio, FLAC, Opus, AAC, MP4 video and WebM video. Previously, Python accepted arbitrary valid output MIME types. Migration: return a supported type that matches the actual bytes or convert the file to a supported format. `audio/pcm` outputs are unsupported. Give an `.mp4` file `audio/mp4` or `video/mp4`, and a `.webm` file `audio/webm` or `video/webm`, to match its content. Input file validation is unchanged.

#### Added

- Recorded media supports GenAI, AI SDK, OpenAI Chat and Responses, Anthropic, Gemini, Vertex and Bedrock shapes, including OpenAI content arrays. The three inspected attributes remain `gen_ai.input.messages`, `gen_ai.output.messages` and `ai.prompt.messages`. Remote URLs and file IDs stay unchanged; the SDK never fetches them.
- Blob entries preserve a valid recorded filename, name or title. Names must be nonblank after trimming, contain at most 256 UTF-16 code units, be well-formed Unicode and contain no C0 characters (U+0000–U+001F) or DEL (U+007F).
- `record_file(upload=True, ...)` uploads supplied file data up to 25 MiB and adds a `hue.blobs` entry to the same span, keyed `event:hue.file:<sha256>`. The existing `hue.file` event remains. Upload defaults to false and is disabled by `capture_content=False` or setup credentials. A requested upload that is not made, for example because its event was redacted or its span was dropped at the queue, counts in `export_status.upload_fallbacks`. An export uploads the files of all its spans together, four at a time, within one upload budget; copies of one file in a trace share a single upload and never hold a place another file needs.
- Documented the shared 22-type allowlist for generated evaluation files, including GIF, audio and video.

#### Changed

- Media inspection is bounded as in TypeScript: at most 8 Mi UTF-16 code units per message attribute (previously 8 MiB of UTF-8) and, newly, 16 Mi per record. Recorded message attributes on resources, events, links and log records keep the 0.9 rule: inline media up to 64 KiB stays verbatim and larger media becomes its `sha256` and `size`, without upload.

### [0.9.1] - 2026-10-07

#### Changed

- `run_experiment` and `rescore` accept `concurrency` up to 100 (was 64). The default stays 1.

### [0.9.0] - 2026-10-06

This release follows Hue's receiver limits, waits out rate limits and uploads values over its inline
limit to Hue, as the TypeScript SDK does, which changes default value, request, queue and wait
budgets and what export sends (see Breaking), so it is a `0.MINOR` release.

#### Breaking

- **Wire** A span's own string attribute over Hue's inline value limit (helper content such as
  `input.value`, `output.value` and tool results, or another instrumentation's attribute) is
  uploaded to Hue apart from the span, up to 1,000,000,000 bytes, as the TypeScript SDK uploads
  it: reserved with `POST /api/v1/otlp/blobs` (skipped when Hue already stores the value under
  the trace), streamed to the presigned `PUT` Hue answers, and completed. The span keeps the
  value's first 16 KiB and lists it in the new `hue.blobs` attribute and under `hue.truncated`.
  Uploads run on the export worker, at most four at once on daemon threads, within six export
  timeouts per export. A value that cannot be uploaded is exported cut as before, recorded as a
  `warning` export issue per cause and counted in the new `ExportStatus.upload_fallbacks`; uploads
  are counted in `ExportStatus.uploaded_values`. Pauses after failures and a receiver without the
  upload route are handled as in the TypeScript SDK, and an upload still sending past its export's
  budget ends there. Nothing is uploaded with `capture_content=False`, a setup key, or from log
  records, events, links or resources. Migration: none for Hue, which reads an uploaded value whole
  from `hue.blobs`; the span's own attribute keeps 16 KiB of it rather than a prefix up to the value
  limit. Where egress is restricted, allow export's HTTPS `PUT` to the upload URLs Hue answers, or
  such values fall back to the cut and are reported.
- **Wire** An inline file over 64 KiB in a span's own recorded messages is uploaded with its
  part's media type and keeps the first 16 KiB of its `content`/`data` in place, listed in
  `hue.blobs` as `<attribute>#<JSON pointer>`, instead of being replaced by its `sha256` and
  `size`; a file that is not uploaded, and one in a log record or a span event, is still exported
  as its digest. Migration: none for Hue, which reads the file from `hue.blobs`; a reader that
  expected the digest in place finds the file's first 16 KiB there and its `sha256` and `size` in
  `hue.blobs`.
- A span's own value over the value cap, and a recorded message of its own holding an inline file
  over 64 KiB, is held whole with its queued copy until export, within a 128 MiB budget of held
  values apart from `max_queue_bytes` (the queue is still charged the cut or digested copy),
  instead of being cut when queued; a value the budget cannot hold, or one queued while the
  receiver is known to lack the upload route, is cut (its files digested) as before and reported
  as not uploaded, once per file. The queued copy lets go of its held values once export has
  placed them. While values can be uploaded, `set_input` and `set_output` content has
  a 1 GB snapshot budget and 1,048,576 values (instead of 4 MiB and 65,536, past which it was
  omitted) and is serialized whole; the redactor sees the whole value. Migration: allow for up to
  128 MiB of held values beside `max_queue_bytes` in the process's memory limits, and for a redactor
  that sees whole values. A client with `capture_content=False` holds and uploads nothing.
- **Wire** A record over the request limit is no longer dropped whole. A value over the value cap
  (1 MiB) is cut when the record is queued, to a UTF-8 prefix (bytes replaced by the receiver's
  marker), and listed under `hue.truncated`; a record still over the receiver's limits sheds its
  largest content values, each replaced by the marker and listed, as the TypeScript SDK does. A
  span with a 2 MB input is exported with the input cut instead of being lost. One record's copy
  may take the whole queue budget (`max_queue_bytes`) rather than 1 MiB. Tool definitions and
  recorded requests cut there have their credentials removed from the whole value first; one too
  long to parse within the record's budget is replaced by the marker instead. Migration: none;
  `max_queue_bytes` still bounds the queue, one record's copy included.
- **Wire** Helper content is kept whole up to 1 MiB instead of 256 KiB, and a redactor sees up to
  4 MiB of it (was 1 MiB). Migration: none for Hue's receiver, which stores values up to 1 MiB;
  another OTLP receiver behind `base_url` must accept them or advertise its own
  `Hue-Max-Value-Bytes`, and a redactor sees longer values.
- **Wire** Requests are measured as Hue's receiver measures them: after gzip against its request
  limit (1 MiB) and after decompression against its decoded limit (4 MiB), instead of 1 MiB before
  gzip. Batches are packed to 4 MiB before gzip and a batch over the wire limit is sent in parts.
  A record over a limit finds how many content values to shed with a number of encodings
  logarithmic in its values. Migration: none for Hue's receiver; another OTLP receiver behind
  `base_url` must accept requests of 1 MiB after gzip that decode to 4 MiB, or advertise its own
  limits (next entry).
- The limits a response advertises in `Hue-Max-Request-Bytes`, `Hue-Max-Decoded-Bytes` and
  `Hue-Max-Value-Bytes`, on any status, are adopted for later requests, value cuts and helper
  content, clamped to 1–64 MiB, 1–64 MiB and 256 KiB–16 MiB; a lower limit is adopted as readily
  as a higher one. Batches stay at 4 MiB, or the advertised decoded limit when that is lower. A
  request that limits lowered while it was retried or held no longer fit is split and shed again
  before it is sent. Migration: none; the limits change only for a receiver that sends these
  headers.
- A request Hue refuses with HTTP 429 and a `Retry-After` longer than the request deadline keeps
  its records queued, within the queue's bounds, and is sent again once the wait has passed; an
  export holds its records for at most 60 s in all. Before, the batch was lost. A longer wait loses
  the records at once, recorded as a `failed` export issue and counted in
  `hue.sdk.dropped_records`. A flush or shutdown budget shorter than the hold returns `False` while
  the held export continues in the background. Migration: allow up to 60 s more for `force_flush()`
  and `shutdown()` in job and shutdown timeouts, or accept their `False` result for a shorter
  budget.
- **Wire** A tracer provider Hue creates keeps 2,000 attributes, events and links per span and
  2,000 attributes per event and link, instead of OpenTelemetry's 128, unless the environment sets
  OpenTelemetry's own limit (`OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT`, `OTEL_ATTRIBUTE_COUNT_LIMIT` and
  the event and link variables), which still wins. A borrowed provider keeps its own limits. Log
  records keep OpenTelemetry's limits: its logger provider takes none in the supported range. A
  span whose events or links do not all fit the queue's byte budget keeps its newest ones and
  counts the rest in its dropped event and link counts, where before the whole span was dropped.
  Migration: set OpenTelemetry's limit variables, or pass a `tracer_provider` of your own, to keep
  other limits.

#### Added

- `ExportIssue.kind` may be `warning`: values exported cut because they could not be uploaded.
  A warning does not affect `export_status.ok` or `force_flush()`, does not move
  `export_failure_sequence()` (now the last failure's sequence), and evaluation runs do not count
  it as a case's export failure.
- **Wire** `hue.sdk.dropped_records` on a trace's root span, as the TypeScript SDK writes it: the
  records of the trace the SDK never sent (dropped from a queue, too large to send without their
  content, or refused for their rate for longer than an export holds them), so Hue reads the trace
  as incomplete by that many records. A root reads the count when its request is made, so one sent
  later in the same export carries the losses earlier requests met; the count stays until the
  request carrying the root is acknowledged, which consumes only what it carried, and is
  remembered for the newest 1,024 traces.

#### Changed

- `record_provider_tool_calls` turns up to 1,024 items of a response into spans, up from 128; the
  rest are still counted as skipped.

### [0.8.0] - 2026-10-05

#### Breaking

- `Hue` and `create_hue_safe` capture supplied content by default when `capture_content` is omitted. Pass `capture_content=False` for metadata-only export; existing explicit choices and redaction continue to apply.

### [0.7.1] - 2026-10-04

#### Added

- Optional per-metric descriptions in Python scorer declarations; publishing them requires a Hue
  server that accepts metric descriptions.
- Tags on datasets, scorers and experiments, by name: `tags` on `create_dataset`, `create_scorer`
  and `create_experiment` (and `create_eval_set`, `create_evaluator`, `create_run`), a `tags`
  filter on the registry lists, `update_dataset`, `update_scorer` and `update_experiment` (and
  `update_eval_set`, `update_evaluator`, `update_run`) to replace them, and `list_tags`. They
  require a Hue server that supports tags.

#### Fixed

- `agent_environment` strips every Hue control-plane credential from inherited values, including
  wrapped, percent-encoded and JSON-Unicode-escaped forms, while preserving world tokens and
  `hue_sim_` capabilities.

### [0.7.0] - 2026-10-02

#### Added

- A target's raise on a service that refused it is completed with the service's own word for what
  failed as the error's `cause`, when its answer names one: Hue's simulation gateway's diagnostic
  (`authorization_unavailable`, `gateway_failure`), read from the answer's `X-Hue-Diagnostic`
  header or its JSON body's `diagnostic` on the error's `response` (httpx, requests, the MCP
  client), its `headers` or `body` (openai, anthropic) through the `__cause__` chain, and from
  Hue's own clients' `diagnostic`. `hue_sdk.evals._failure.error_cause` is the reading beside
  `error_type`; Hue shows the cause beside the infrastructure or configuration label.
- `EnvironmentRun["now"]` and `WorldHandoff["now"]`: the world's clock at creation as an RFC 3339
  timestamp (a trace-built world's recorded start), read from the World API's `now` or from
  `HUE_WORLD_NOW` in its `env`, which `agent_environment` passes to the agent with the world's other
  carriers. `world_now()` reads it as an aware `datetime` from a handoff or from an environment, so
  an agent computes "today", "tomorrow" or `newer_than:7d` from the world's date and lands on the
  recorded dates however long after the recording the run starts. `None` or absent from a Hue that
  predates it.

#### Changed

- **Breaking:** `capture_content=False` also removes Langfuse's content attributes before export:
  `langfuse.observation.input`, `langfuse.observation.output`,
  `langfuse.observation.status_message`, `langfuse.observation.model.parameters`,
  `langfuse.trace.input` and `langfuse.trace.output`, with their dotted children, from every
  record Hue exports, beside the GenAI, OpenInference, OpenLLMetry and Vercel AI SDK content it
  already removed. Langfuse's model name, usage and cost details, observation type, session and
  user identifiers, trace name, release, environment and `metadata.*` keys are metadata and stay;
  `CONTENT_PREFIXES` lists the six, identical to TypeScript's `contentPrefixes`. **Wire**
  Migration: an application that set `capture_content=False` and relied on Langfuse inputs and
  outputs reaching Hue sets `capture_content=True`; Langfuse's own export is unaffected.
- **Wire** Helper content over Hue's 256 KiB value cap (`set_input`, `set_output`, a tool call's
  arguments or result) is cut to a UTF-8 prefix of its JSON text and the key listed in the span's
  `hue.truncated` attribute, where Hue's receiver lists the values it cuts itself, instead of
  being omitted and counted as an instrumentation failure. A whole value replacing a cut one
  unmarks its key, and the list is kept under a lock per span so two threads cutting on one span
  at once both stay listed. An inference log's body over the cap is still omitted and counted,
  since its prefix is no JSON.

#### Fixed

- Live-span placeholders travel in their own requests, after an export's finished spans, so a
  rejection count is always one kind of record's: a finished span's rejection is never credited
  to a placeholder (a receiver without `Hue-Pending-Spans: 1` that rejected a finished span could
  hide it behind a placeholder before), and a rejected request of placeholders never fails the
  export status. The first trace acknowledgement without the header, whatever its request
  carried, sets `export_status.live_spans_rejected` and stops announcing spans, so a generic
  collector that acknowledged finished spans first never receives a placeholder. An export whose
  spans are still running makes one more request than before, for the placeholders alone; the
  export cadence is unchanged. **Wire**

### [0.6.4] - 2026-10-02

This release says what stopped a case: a world `create_run` could not create, a service the
agent called that refused, dropped the connection or timed out, or a status Hue's own clients
were refused with is completed as setup, infrastructure or configuration, and none is filed as
the agent's `TargetError`. A case whose export was not acknowledged in time can complete with
its trace evidence pending. Additive; no capture, default budget or wire change.

#### Added

- A status Hue's own clients (`HueApiError`, `HueEnvironmentError`) were refused with that is
  neither a success nor retryable, a 3xx or 4xx such as a key, a project, an environment version
  or a world Hue refused, or an endpoint that redirected (the clients follow none), completes the
  case as `ConfigurationRejected` instead of `TargetError`: Hue counts it as
  configuration and leaves it out of the agent's pass rate, so an error from Hue's own clients is
  never filed as the agent's.
- `TraceEvidence("pending")`: a case whose export `force_flush` did not acknowledge completes in
  its true state with `traceEvidence: "pending"` and the count of spans the case ended, as the
  checkpoint recorded at its flush (`traceSpanCount`), so Hue attaches the trace once it holds
  every span, or records it omitted a day later; a resumed checkpoint the receipt does not accept
  completes the same way. Only `omit` carries a reason.
- A target's exception is completed with an error type that says what stopped the case:
  `EnvironmentSetupFailed` when `create_run` could not create the world (the new
  `WorldCreationError`, a `HueEnvironmentError`), `ServiceRefused` for a retryable status from a
  service the agent called, `ConnectionFailed` and `TimedOut`, beside the agent's own
  `TargetError`. Hue counts the service failures as infrastructure.

### [0.6.3] - 2026-10-01

This release gives the Python evaluation client the TypeScript SDK's resilience: reads and keyed
mutations are sent again after transient failures, and an export failure is attributed to the
case whose trace it concerned, so one case's telemetry failure no longer fails the cases beside
it or every case that follows. Additive; no capture, default budget or wire change.

#### Added

- `EvaluationClient` sends a read, or a mutation the server deduplicates by the `idempotencyKey`
  in its body (`create_experiment`, `start_execution`, `complete_execution`, `finish_experiment`,
  `submit_results`, `create_run`, `start_run_execution`, `complete_run_execution`, `finish_run`,
  `create_scoring`, `submit_scoring_results`, `create_judge_jobs` and their keyed peers), again
  after a connection failure, a timeout or a 408 or 5xx that carried no `Retry-After`, up to
  `max_attempts` (default 4, 1–10) times with a jittered backoff, as the TypeScript SDK does.
  `is_transient_api_error` names those failures; `HueApiError` carries Hue's `X-Hue-Diagnostic`
  code as `diagnostic`, the wait of a long `Retry-After` as `retry_after_seconds`, and
  `reason="malformed_response"` for a body the client refused, which is not sent again. A
  mutation without a key is still sent once.
- Export issues name the traces of the records they concerned (`Hue.export_issues()`, each an
  `ExportIssue` with `trace_ids` of up to 64 traces, `Hue.export_failure_sequence()` and
  `Hue.spans_ended(trace_id)`). `run_experiment` reads them after each case's flush: a failure
  that names the case's trace marks that case `failed` (its evidence is incomplete, and resume
  refuses it), one that names only other traces leaves it accepted, and one that names no trace,
  or a flush that did not succeed without a new failure, is decided by the case's trace receipt,
  at once or on resume for a checkpoint still `pending`: the receipt must hold the case's root
  span and at least as many spans as the case ended, which the checkpoint records at the flush.
  One case's telemetry failure no longer fails the cases running beside it, and a client's
  earlier failure no longer fails every later case; `Hue.force_flush()` keeps its cumulative
  answer.

### [0.6.2] - 2026-09-27

#### Added

- Provider tool spans from `record_provider_tool_calls` carry `hue.tool.call.position`, the
  0-based position of the call's item in the provider response, in both capture modes. **Wire**
- A `tools/list` span from `record_provider_tool_calls` with `capture_content=False` carries
  `hue.tool.names` and `hue.tool.definitions.sha256`, the same metadata-only summary export gives
  any record's tool definitions. **Wire**
- With `capture_content=True`, a failed OpenAI MCP call's span has the provider's error text as
  its ERROR status description, credentials scrubbed and cut to 1,024 characters and a `…` exactly
  as TypeScript SDK 0.11.3 does, before your `redactor` sees it as `status.message`.
  Without content capture the span keeps `error.type` only. **Wire**

#### Fixed

- `run_experiment` no longer stops the whole run with `OutcomeSerializationError` when a target's
  output is over what Hue stores for one case (200,000 bytes of JSON, 20,000 values or 32 levels
  of nesting): that case completes as `error` with the type `OutputTooLarge` and, when result
  content is persisted, the TypeScript SDK's message naming the bound, and the other cases keep
  running. Output within the bounds that is not JSON still raises `OutcomeSerializationError`.
- A large inline file whose text has a lone surrogate is hashed with U+FFFD in its place, as the
  TypeScript SDK hashes it; before, encoding it raised and the message was exported unhashed. The
  lone surrogates are replaced once for the whole part. A `data:` URL's parameters are read after
  matching its header, as in the TypeScript SDK. **Wire**
- `server.address` keeps a host name with an underscore, such as a Docker Compose service
  (`http://mcp_server:8080`), as WHATWG URL parsing and the TypeScript SDK do; before, it was
  dropped. **Wire**
- An output's JSON byte length is counted as the output is read, as in the TypeScript SDK, so an
  output too large to serialize is refused without serializing it (eleven references to a 50 MB
  string took tens of seconds and a gigabyte); an output the process cannot hold in memory completes
  its case as `OutputTooLarge`. Object keys no longer count toward the 20,000 values, so an object
  of more than 10,000 members, which 0.6.1 refused with `OutcomeSerializationError`, is accepted as
  in the TypeScript SDK, and a list or object with more elements than values left, or keys longer
  than the bytes left, is refused before it is read. The output is read in the TypeScript SDK's
  order, and the byte bound is still checked last, so both SDKs refuse an output for the same
  reason.
- A URL's query names are decoded and encoded together in C rather than byte by byte, so
  scrubbing a URL with thousands of parameters, in a tool definition's `url` or in MCP error text,
  takes about half the time it did. The exported text is unchanged.
- On Python 3.13 and later, a URL with an `xn--` host label whose Punycode overflows
  (`http://xn--11111111111111111w`) stopped the credential scrubber with `OverflowError`: with
  content capture, a record whose tool definitions held one was dropped, and without it the record
  lost `hue.tool.names` and `hue.tool.definitions.sha256`. Such a URL, and an `http`, `https`, `ws`,
  `wss` or `ftp` URL whose parse fails in any other way, is now replaced whole with `[redacted]`, as
  in the TypeScript SDK, including in the MCP error text this release exports. Each failed call's
  error text is scrubbed on its own: text that cannot be scrubbed leaves only its span without a
  description, counted as an instrumentation failure, and the later calls are still recorded.
  **Wire**

### [0.6.1] - 2026-09-25

#### Fixed

- **Wire.** A large inline file part in a recorded message is exported with the `sha256` and
  `size` of the file's own bytes whatever its media type. Base64 content is decoded for text,
  JSON and untyped parts too, and a `data:` URL without `;base64` is percent-decoded. Before,
  those were hashed as the UTF-8 of their base64 or URL text, so the digest did not match the
  file's bytes. Behavior change: content made only of base64 characters and padded to a
  multiple of four is now read as base64 even under a text media type, as Hue reads it, so such a
  text (`AAAA…`, for example) is hashed as the bytes it decodes to and stays inline while those
  fit in 64 KiB. A text file's own text is still hashed as UTF-8. This matches the TypeScript
  SDK, checked against a shared fixture.
- Provider-tool argument size checks stop in bounded UTF-8 chunks, and oversized MCP arguments are
  counted as skipped instrumentation rather than silently omitted.
- Provider-tool tail classification isolates broken item types, and strict hostname validation
  rejects ambiguous URL text before it can enter `server.address`.
- Model dumps disable Pydantic content warnings when supported.
- `EnvironmentClient.wait_for_seal` ends each status read by elapsed time. A socket timeout
  restarts with every byte, so a server that sent its handshake, headers or body a byte at a time
  could hold one read for many times its window; the read's sockets are now shut down when the
  window passes, and the wait ends on time with `EnvironmentSealTimeoutError`.
- The `wait_for_seal` docstring names `EnvironmentSealTimeoutError`, which keeps `status=None`
  like a connection failure, so callers check for it before `status`.
- A tool definition containing an integer longer than CPython's `int()` digit limit (about 4,300
  digits) failed to parse, so it was exported with its credentials unscrubbed and without a
  metadata-only summary. Such an integer is now read as JavaScript reads it, the definition is
  scrubbed, and a non-finite number is written as `null`, as `JSON.stringify` writes it.
- A scrubbed `url` or `server_url` with an `http`, `https`, `ws`, `wss` or `ftp` scheme is
  serialized as WHATWG `URL` does (lowercase scheme and host, IDN hosts in Punycode, default
  ports dropped, the path percent-encoded and its dot segments resolved, query names encoded as
  `URLSearchParams` encodes them), and a URL WHATWG refuses becomes `[redacted]`. For ordinary
  hosts the exported text and `hue.tool.definitions.sha256` now match the TypeScript SDK's; some
  internationalized hosts still differ, as the README describes, and an IDN host longer than
  1,024 characters is refused before any IDNA work.
- `EvaluationClient` sends a request again, up to four times, when Hue refused it before acting on
  it with a short `Retry-After` (HTTP 429 or 503 asking for at most 5 seconds), and waits at least
  that long first. Hue does this when its key check is busy, which parallel cases can trigger; such
  a request previously failed the run. A refusal that asks for longer or gives a date, a timeout and
  any other failure still fail at once, so a write whose outcome is uncertain is never sent twice.
- The inline-file digest tests skip, rather than fail to collect, when the TypeScript suite's
  shared fixtures are absent, as the other cross-language tests do. Every cross-language test now
  finds the TypeScript suite at the same relative place, and the release's installed-wheel check
  copies its fixtures and content-prefix list there, so the digest, tool-definition, URL and
  hosted-tool-call fixtures and the prefix list are checked against the installed wheel with none
  skipped. CI runs that check on every change. The published package is unchanged by this.

### [0.6.0] - 2026-09-24

#### Added

- `HueEnvironmentError.diagnostic` exposes a validated `X-Hue-Diagnostic` code from World API
  refusals. This is new after Python 0.5.1, which does not include it.
- **Wire.** `record_provider_tool_calls` records provider-executed OpenAI and Anthropic tool
  activity as child spans, with bounded diagnostics and content capture matching TypeScript.
- `EnvironmentClient.wait_for_seal` waits through a gateway world's completion grace with bounded,
  retry-aware status reads before returning the sealed run and raises
  `EnvironmentSealTimeoutError` when the bounded wait expires.

### [0.5.1] - 2026-09-24

#### Added

- Correction: `wait_for_seal` and `EnvironmentSealTimeoutError` shipped after Python 0.5.1; they are documented under 0.6.0.
- **Wire.** `span.record_file(role=..., media_type=..., sha256=..., data=..., byte_size=..., name=...)`
  adds a `hue.file` event with the same attributes as TypeScript `hue.recordFile`.
- **Wire.** `hue.model(..., system_instructions=..., tools=...)` and
  `span.log_inference(system_instructions=...)` record `gen_ai.system_instructions` and
  `gen_ai.tool.definitions` when content is captured.
- **Wire.** `hue.context(workspace_id=...)` records `hue.workspace.id` on nested helper spans.
- **Wire.** `hue.tool(..., mcp=)` accepts `provider` and `surface`, recorded as
  `hue.mcp.provider` and `hue.mcp.surface`.
- **Wire.** Metadata-only export that removes tool definitions leaves `hue.tool.names` and
  `hue.tool.definitions.sha256`, with the same digest as TypeScript.

#### Fixed

- **Wire.** Hosted-tool credentials in exported tool definitions and recorded raw requests are
  replaced with `"[redacted]"` at export, as in TypeScript.
- **Wire.** A `blob` or `file` part over 64 KiB in recorded messages is exported as its `sha256`
  and `size` instead of its payload, so a 2 MiB inline document no longer drops the record.

### [0.5.0] - 2026-09-24

#### Added

- **`hue_sdk.environment`.** `EnvironmentClient` for Hue's World API: `create_run` (with
  `execution_id`, `traceparent` and `agent_revision`), `get_run`, `finish_run`, `get_evidence`,
  `act`, `list_steps` and `record_coverage_gap`, retrying deduplicated mutations and waiting Hue's
  `Retry-After` on 429 and 503. `world_handoff`, `agent_environment`,
  `strip_hue_control_plane_credentials`, `legacy_mcp_capability` and `mcp_config_file` build an
  agent child's configuration from the world's token, mirror URLs, `env` and `mcpConfig` without
  the project key. No tool binding is included.

#### Changed

- `run_experiment` and `rescore` accept `concurrency` up to 64 (was 16). The default stays 1.

### [0.4.0] - 2026-09-23

#### Breaking

- Live spans are on by default: while a span from Hue's own helpers or a recognized AI
  instrumentation is still running, the exporter also exports a placeholder for it (see Added). A
  Hue deployment that accepts placeholders answers with `Hue-Pending-Spans: 1`; if a receiver
  without that header gets placeholders, their rejections are credited to them,
  `ExportStatus.live_spans_rejected` is set and live spans switch off for that client.
  Placeholders may use up to a quarter of the export queue. Migration: pass `live_spans=False`
  for the previous wire behavior. A processor wrapper that forwards `on_start` but scrubs,
  renames or drops spans in `on_end` does not change their placeholders; do not forward
  `on_start` for spans you filter, or pass `live_spans=False`. **Wire**
- A finished span no longer carries `hue.span_type` or `hue.pending_parent_id` attributes set by
  the application; Hue reserves them for placeholders. Migration: rename application attributes
  that use those keys. **Wire**

#### Added

- **Live spans.** A placeholder lets Hue show a trace, its request and its running model and tool
  calls before they finish. It is an ordinary OTLP span that names the running span as its
  parent, ends at 0 and carries `hue.span_type = "pending_span"` and `hue.pending_parent_id`;
  markers are added after the content policy and redaction. Queued placeholders are never counted
  as dropped, a placeholder whose span has ended by export time is not sent, and a request
  carrying only placeholders never fails the export status; rejections in a request that also
  carries finished spans fail it as before. **Wire**
- `live_spans` keyword (default `True`; always off for setup credentials) and
  `ExportStatus.live_spans_rejected`.

### [0.3.0] - 2026-09-23

#### Added

- Product-named eval set, evaluator, run and scoring methods on `EvaluationClient`, using the
  existing v1 paths. Responses retain both field names, and a run ID remains distinct from its
  scoring ID. Existing client methods and local runners remain callable.

#### Deprecated

- Older low-level evaluation client method names now have product replacements. They remain
  supported for at least two subsequent `0.MINOR` releases. The v1 response aliases remain
  available while the server compatibility window is open.

#### Changed

- The evaluation guide names Hue's consolidated **Read and write** access preset, which replaces
  **Tracing and evaluations**. Existing keys keep their access.

### [0.2.3] - 2026-09-21

#### Added

- `hue.tool(..., mcp={"name", "version"})` records the MCP `initialize` `serverInfo` as
  `mcp.server.name` and `mcp.server.version`, matching TypeScript `hue.tool(..., { mcp })`.
  **Wire**

No registry release is claimed until publication and registry acceptance complete.

### [0.2.2](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.2.2) - 2026-09-18

#### Changed

- `log_inference` emits the `gen_ai.client.inference.operation.details` record with a structured body instead of JSON-string fields (an explicit `None` field keeps its key with an empty value, as in TypeScript), sets `gen_ai.operation.name`, `gen_ai.provider.name` and `gen_ai.request.model` as record attributes from the enclosing `model()` block or the new `operation=`, `provider=` and `model=` keywords, and `gen_ai.conversation.id` from the enclosing `context()`, matching TypeScript `recordMessages` (#37). With `capture_content=False` no record is emitted, and the Python-only `hue.capture_content` record attribute is gone. **Wire**

### [0.2.1](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.2.1) - 2026-09-18

#### Changed

- The package summary no longer ends with `(hue.run, not Philips Hue)`.

### [0.2.0](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.2.0) - 2026-09-18

#### Breaking

- `capture_content=False` now strips recognized GenAI, OpenInference, OpenLLMetry and Vercel AI SDK content attributes, legacy `gen_ai.*` message events, log bodies and status descriptions from every exported record, including spans from third-party instrumentors on the same provider, matching the TypeScript export path. **Wire** Migration: applications that expected third-party instrumentor content to reach Hue in metadata-only mode must set `capture_content=True` and rely on the instrumentor's own capture controls and the redactor.
- `jsonschema` and `referencing` move to the optional `hue-run[evals]` extra used only by `builtin_scorers.json_schema` (alias `builtins`); without it that helper raises `ImportError` and stored schema scorers report `SchemaValidatorUnavailable`. The tracing core now depends only on OpenTelemetry packages and `requests`. Migration: install `hue-run[evals]` where `builtin_scorers.json_schema` or stored schema scorers are used.
- The metadata-only content list also covers OpenInference retrieval documents, embeddings, reranker query and documents, prompt-template text and variables, `llm.tools`, `llm.function_call`, `llm.choices`, input/output images, and AI SDK `ai.response.reasoning` and `ai.response.files`, identical to TypeScript's `contentPrefixes`. **Wire** Migration: set `capture_content=True` where those fields must reach Hue.
- In attach mode the `LoggerProvider` Hue creates for correlated logs reuses the borrowed `tracer_provider`'s resource instead of a resource built from `service_name`, so logs and spans report one `service.name`. **Wire** Migration: none for applications expecting a single service; set `service.name` on the borrowed provider's resource, or pass `logger_provider=` to control the log resource explicitly.

#### Added

- Repository, changelog and issue URLs, classifiers and keywords in the package metadata.
- `logger_provider=` attaches Hue's log processor to an existing SDK `LoggerProvider`, mirroring the TypeScript existing-provider mode; borrowed providers are not shut down by the client.
- `hue_sdk.evals.builtin_scorers` names the built-in scorer bundle without shadowing the standard-library `builtins` module; `builtins` remains an alias.

#### Changed

- OTLP export requests are gzip-compressed and carry a `hue-sdk-python/<version>` User-Agent ahead of the OpenTelemetry exporter's token, matching TypeScript. **Wire**
- `Hue("<key>")` and `EvaluationClient("<key>")` raise `TypeError` naming `api_key=` instead of a `base_url` `ValueError`; existing positional `(base_url, api_key)` calls are unchanged.
- `Hue.base_url`, `Hue.tracer`, `Hue.tracer_provider`, `Hue.logger_provider`, `EvaluationClient.base_url` and the evaluation error attributes carry class-level annotations, and the mypy gate no longer ignores missing stubs (`types-protobuf` and `types-jsonschema` join the dev group).
- `opentelemetry-api`, `opentelemetry-sdk` and `opentelemetry-exporter-otlp-proto-http` are accepted as `>=1.40,<2` instead of exactly 1.44.0, so `hue-run` installs next to applications and instrumentation packages on another OpenTelemetry 1.x release. `uv.lock` keeps 1.44.0 as the certified combination, and a new CI job re-resolves every direct dependency at its declared floor (`uv lock --resolution lowest-direct`) and runs the full suite, including the installed wheel, on Python 3.10 and 3.12 with OpenTelemetry 1.40.0. The two OpenTelemetry internals the transport uses are guarded: a missing OTLP log encoder raises an `ImportError` naming the supported range, and a missing instrumentation-suppression key emits a one-time `RuntimeWarning` and exports without suppression.
- The package summary ends with `(hue.run, not Philips Hue)` so registry listings are not mistaken for smart-lighting libraries.

#### Fixed

- The managed-target README snippet passes `tracer=hue.tracer`; without it every invocation returned `uncertain`.

### [0.1.3](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.1.3) - 2026-09-17

#### Changed

- Pending telemetry is bounded by bytes (8 MiB per signal by default) as well as records, including in-flight exports; omissions and drops are reported through cumulative counters.

#### Added

- `create_hue_safe`, `enabled=False`, `force_flush_safe` and `shutdown_safe` with a default one-second deadline; HTTP 429 and `Retry-After` handling; inherited clients are safe after fork.
- Installed-wheel regressions for outages, oversized data, redactor failures, queue saturation, cancellation and stuck providers.

#### Fixed

- Helper capture, redaction and provider failures are isolated from application results and exceptions; business callbacks never rerun.

### [0.1.2](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.1.2) - 2026-09-16

#### Added

- `hue_sdk.managed`: managed-target adapters with the same contract as TypeScript 0.1.4.

#### Fixed

- Saved outcomes are preserved when flush callbacks report failure or pending records; expired budgets and malformed identities are rejected before agent work starts.

### [0.1.1](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.1.1) - 2026-09-16

#### Added

- `Hue.verify_trace()` stored-trace receipts with the same contract as TypeScript 0.1.3.

### [0.1.0](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.1.0) - 2026-09-15

#### Changed

- Clients default to Hue Cloud (`https://app.hue.run`); explicit origins and existing positional calls keep working.

#### Added

- First public PyPI release under MIT with unchanged `hue_sdk` imports and package-page-safe links.

## Coding-agent skill (skills/hue)

The skill is installed from the default branch (`npx skills add hue-run/hue-sdk --skill hue`), so an entry takes effect when it merges into `main`.

- 0.8.17 (2026-10-20): pin Python `0.13.4`, document released HTTP endpoint evidence, and include Node 26.
- 0.8.16 (2026-10-20): the TypeScript installation command pins `@hue-run/sdk@0.21.0`.
- 0.8.14 (2026-10-20): the Python installation commands pin `hue-run==0.13.3`.
- 0.8.13 (2026-10-19): the integration table routes an application whose framework owns the agent loop or the root span (LangChain, LangGraph) to the LangChain and LangGraph integration page and the OpenTelemetry root-span section.
- 0.8.12 (2026-10-19): the file is formatted with Prettier's defaults (table cell alignment), so `prettier --check` passes in repositories that vendor it. No wording changes.
- 0.8.11 (2026-10-19): **Verify delivery** gives the running-server pattern (log or return the request span's `traceId`, verify from a diagnostic client), names the receipt fields once and says what a `null` receipt means.
- 0.8.10 (2026-10-19): the TypeScript installation command pins `@hue-run/sdk@0.20.8`.
- 0.8.9 (2026-10-19): the other-workflows table routes importing existing traces from OTLP JSON, Langfuse or ATIF exports to the bulk import guide (`load_hue_guide` with `import` returns the same guide).
- 0.8.8 (2026-10-18): the TypeScript installation command pins `@hue-run/sdk@0.20.7`.
- 0.8.7 (2026-10-18): the TypeScript installation command pins `@hue-run/sdk@0.20.6`.
- 0.8.6 (2026-10-18): the TypeScript installation command pins `@hue-run/sdk@0.20.5`.
- 0.8.5 (2026-10-18): the rule for other workflows no longer asks before every write to a Hue project, matching the Hue MCP server, which dropped its blanket write confirmation; its other rules are unchanged. The TypeScript installation command pins `@hue-run/sdk@0.20.4`.
- 0.8.4 (2026-10-18): the TypeScript installation command pins `@hue-run/sdk@0.20.3`.
- 0.8.3 (2026-10-18): the installation commands pin `@hue-run/sdk@0.20.2` and `hue-run==0.13.2`.
- 0.8.2 (2026-10-18): the rule for other workflows names the evaluation-only values production configuration must not hold (mirror URLs, world tokens, `HUE_MCP_*` values and the development **Read and write** key) instead of all Hue URLs and keys, which contradicted the **Tracing only** key a production server uses.
- 0.8.1 (2026-10-18): pin current install commands to TypeScript `@hue-run/sdk@0.20.1` and Python `hue-run==0.13.1`; retain the tracing guidance and documentation routing from 0.8.0.
- 0.8.0 (2026-10-18): the skill centers on SDK work: choosing the integration, preserving the application's provider, framework, prompts, behavior, exporters and redaction, instrumenting request, model and tool spans with real content and streaming lifetimes, content and media capture, and verifying stored spans and content with a separate check for uploaded media. Production investigation, MCP setup, classifiers, cases from traces, Worlds and evaluations become routing links to their docs.hue.run pages, which own those procedures; the duplicated case, eval-ready and evaluation procedures, case tiers and the mirrors' release-state note are removed. The key section tells an agent arriving from the agent setup page to return there after **Verify delivery** instead of starting it again and tells a user without an account that one is required, with no contact address or booking link, the install commands pin `@hue-run/sdk@0.20.0` (saved exactly) and `hue-run==0.13.0`, and setup test runs added AI SDK 6 `consumeStream()` and Python `GeneratorExit` streaming guidance, redaction notes for wrapping processors, user and session IDs and file bytes, and where verification's span IDs come from.
- 0.7.8 (2026-10-18): the evaluation procedure and its three `hue eval` commands use `@hue-run/sdk@0.20.0`. The registry availability check before installation is unchanged.
- 0.7.7 (2026-10-16): the evaluation procedure and its three `hue eval` commands use `@hue-run/sdk@0.19.1` instead of 0.19.0. The registry availability check before installation is unchanged.
- 0.7.6 (2026-10-16): the evaluation procedure and its three `hue eval` commands use `@hue-run/sdk@0.19.0` instead of 0.18.2. The registry availability check before installation is unchanged.
- 0.7.5 (2026-10-14): the key steps name the settings page by its current label, **Settings → API keys**, instead of **Settings → Integrations & API keys**.
- 0.7.2 (2026-10-12): the evaluation procedure and its three `hue eval` commands use `@hue-run/sdk@0.18.0` instead of 0.17.0. The registry availability check before installation is unchanged.
- 0.7.1 (2026-10-11): the evaluation procedure and its three `hue eval` commands use `@hue-run/sdk@0.17.0` instead of 0.16.0. The registry availability check before installation is unchanged.
- 0.7.0 (2026-10-08): evals run through `hue eval` with SDK 0.16.0: `--check` first, one command is one run, never a custom harness or tool stand-ins; an interrupted run stays open and the identical command resumes it.
- 0.6.9 (2026-10-08): link the skill and SDK guides to the consolidated Quickstart, production setup, and MCP recipes pages.
- 0.6.3 (2026-10-05): align the evaluation procedure and verification checklist with answer-only cases: either execution or world token marks an eval, answer paths skip app clients, and required app connections still fail without a world. Direct adapters pass their execution marker to the helper; one-shot direct commands use an absolute entry path. The **Answers the task** judge in the **Answer outcome** evaluator is required for answer-only cases; worker exit codes do not report run verdicts.
- 0.6.2 (2026-10-05): answer-only cases need no starting world or app-client initialization; command workers run both case kinds from the application directory with SDK 0.13.2. Existing registrations need a new revision, and adapter-file workers opt into direct cases explicitly. The Answer outcome judge decides answer-only results.

- 0.6.0 (2026-10-02): the skill's scope grows from tracing to evaluation, so its description names setting up tracing, investigating production, turning traces into reviewed cases, making an agent eval-ready and running `hue eval`, and the title becomes "Hue". New section **Create a case from a trace**: the UI path (**Create case**, "Did the agent complete the task correctly?", **Build case**, **Publish case**), the MCP sequence (`get_trace`, `add_case_conversion`, `get_case_conversion`, `update_case_conversion`, `publish_case_conversion` only at `ready: true`), the `case_from_trace` prompt, saving the eval-set version, and the T1 to T4 tiers. The capture section says which traces can become cases and the eligibility codes a creation refuses. **Evaluate a published case** is a generic end-to-end procedure: pinned two-package `npx --yes --package @hue-run/sdk@0.13.0 --package "zod@^4.6.5" hue eval` commands; a Preview note on the mirrors' release state; a stopgap not to use the `./hue-agent.ts` run block `get_case` returns; call-site detection that includes meta-tools and code execution; a helper with an injectable environment, the surface-id variable table (Gmail MCP and REST, Slack Web API and MCP, experimental mirrors), `appInWorld` for worlds that include fewer apps, resolution at startup, stdio servers kept rather than swapped, and a fail-closed error naming the variables present; routing rules for tool proxies, model-written code and remote sandboxes, `worldNow()` for date-relative tasks, and deployed agents; the `--command` contract (`inputs` shape, stdout parsing, 4 MiB cap, timeout), the child environment list, `--env-file`, checkpoints, input files and the adapter's `context.world.env` caveat; `get_case_divergence`, tiers, advisory judges, `no_calls` as advisory and what `hue eval` strips from the agent's tracing; a verification checklist with an adapter check; exit code 130; and an evaluation troubleshooting table. The handoff gains an Evaluated variant.
- 0.5.12 (2026-10-02), after the 0.5.11 metadata bump that the 0.13.0 release made for its Langfuse wording: the published-case loop is an end-to-end procedure that hands the agent the world, never Hue-native tools, with `@hue-run/sdk` 0.12.1 or later. A case's world is served through mirrors, one stable Hue URL per app (`https://app.hue.run/api/sim/<real host>/<real path>`) that answers in the real app's format from that run's private world, with a per-run world token where the real credential went; the agent reaches a mirror with its own production client. The agent detects how the codebase reaches each app (an `mcpServers` file, an MCP client in code, a hosted connector, a REST SDK with a base URL, raw HTTP), adds one committed helper in the codebase's language that treats `HUE_WORLD_TOKEN`, set only in the process `hue eval` starts, as the sign of an eval, reads each app's mirror URL from its `HUE_SIM_<SURFACE>_URL` variable or hands a framework the `mcpServers` file at `HUE_MCP_CONFIG`, fails closed when a needed variable is missing instead of calling the real app, and returns the production URL and credential unchanged otherwise; routes every call site through it; adds no tool and writes no Hue variable into production configuration. The loop runs `hue eval --case` and `--worker` with `--command`, names the variables each case receives, says that a TypeScript adapter passes `context.world` the same way and must not hand the deprecated `context.tools` or `context.mcp` to a gateway world's agent, reads a `no_calls` world as a call site that still reaches the real app, and ends with a verification checklist: production unchanged, fail closed, same tools, clean diff, a real run. Links the new [Make your agent eval-ready](https://docs.hue.run/evaluations/eval-ready-agent) guide.
- 0.5.5 (2026-09-26): a tool missing from the agent's list is one search away. Hue's default connection lists the production reads and `search_hue_tools`, whose results give each tool's input schema and the name to call: the tool itself when listed, otherwise `execute_hue_tool` for a read or `execute_hue_write_tool` for a write. The production investigation describes that `list_projects`, `search_hue_tools`, `execute_hue_tool` flow, and the published-case loop reaches its eval tools through it when they are not listed.
- 0.5.4 (2026-09-26): the production investigation counts before it samples. `aggregate` counts traces, errors and duration percentiles over a whole window, grouped by task type, attention state, finding, release, user, intent or time, and groups steps by tool, name or model. `search_traces` gains filters for findings, user, release, trace name and model and sorts by duration, `search_spans` lists individual steps such as failing tool calls, `get_trace` returns stored findings and span sizes, and `get_span_content` reads exact recorded values. Answers name the window, filters and any sampling or scan cap behind each number.
- 0.5.3 (2026-09-26): a Hue MCP connection can cover every project in an organization. When the Hue tools take a `project_id` argument, the skill has agents call `list_projects`, confirm the project with the user when more than one could apply, and pass its id as `project_id` on every call, including `verify_trace`, `get_trace`, the production investigation and every call of the published-case loop; without that argument the connection reaches one project. The account check also accepts a connection that answers `list_projects`. A **Read** key still suffices for inspection, and the skill no longer says a browser sign-in can be approved for **Read**: a sign-in connection can have **Read and write** access, so agents ask before any write.
- 0.5.2 (2026-09-26): one setup path for everyone. The invite-only section, which relayed the reply from https://docs.hue.run/guides/agent-setup.md and stopped, becomes **Get a Hue API key**. The agent checks only that `HUE_API_KEY` is present, never its value; a key of any preset, a key configured as `HUE_MCP_KEY` or a Hue MCP connection on which `get_project_context` succeeds means the user has a Hue account. An agent that came from the agent setup page confirms the same way that `HUE_API_KEY` is now present before it continues with Install and configure, and repeats that page's key message and the contact line instead of installing packages if the key is still missing; otherwise a first-time setup follows that page, which brings the agent back to the skill for tracing and ends by connecting the Hue MCP server. The user creates a **Read and write** key under **Settings → Integrations & API keys** and stores it as `HUE_API_KEY` themselves, never pasting it into chat. A user without an account gets one contact line: email founders@hue.run or book a time with the Hue team. Without a key, the agent installs no packages and changes no files unless the user asks it to prepare tracing against a local OpenTelemetry collector; anonymous setup (`setup --agent`, `resume`, `hue claim`) stays inactive. A missing Hue account or key defers to that section. The handoff offers a user with a Hue account and a **Read** or **Read and write** key to connect the Hue MCP server when it is not connected, with the user also storing that key as `HUE_MCP_KEY` if it is not set yet (not after a keyless setup against a local OpenTelemetry collector), and the description says "set up or integrate Hue".
- 0.5.1 (2026-09-26): the production investigation follows `get_trace`'s `next_span_cursor` until it is `null`, so error spans past the first 200 are read, and gives each trace-check tool its own arguments: `get_trace_check_summary` takes `since` and `check_key`, and only `get_trace_check_results` takes `state: "present"`.
- 0.5.0 (2026-09-26): a new section, "Investigate production with the Hue MCP", has agents fetch production data with the MCP read tools and do the analysis themselves: `get_project_context`, then `search_traces` over one window for volume, errors, `attention` and `min_duration_ms`, `get_trace` for the span tree, `get_span` with `include_content` only when the content is needed, trace-check and intent reads where the project set them up, bounded samples with their size stated, and links to the [production recipes](https://docs.hue.run/agents/investigate-production). The description now covers reading production traces. The invite-only check also admits a user whose key is configured as `HUE_MCP_KEY` or whose Hue MCP connection answers `get_project_context`. The MCP key guidance names both variables: the application and `hue eval` read `HUE_API_KEY`, an MCP client reads `HUE_MCP_KEY`, `hue login` stores one **Read and write** key under both, and a **Read** key or a sign-in approved for **Read** suffices for inspection. The handoff gains an ending for a completed investigation that separates what Hue recorded from the agent's reading.
- 0.4.5 (2026-09-25), recorded with 0.5.1: the published case loop uses `hue eval --case` with `@hue-run/sdk` 0.9.0 or later; the MCP tool names are the current `get_run`, `get_run_item`, `list_eval_sets` and `list_evaluators` instead of the retired `get_experiment`, `get_experiment_item`, `list_datasets` and `list_scorers`; `--baseline` takes the previous run's `experimentId`, not its `runId`; content inspection uses the Hue UI or an authorized MCP connection; and cases can be reviewed and published through the project-write case-conversion MCP tools when authorized.
- 0.4.4 (2026-09-25): `@hue-run/sdk` 0.10.0 is published, so the evaluation section says what changed "since" it rather than "from" it: an evaluator that does not apply to a case shows `n/a`, and one-shot `hue eval` stores outputs by default. Also collects the unreleased metadata change merged since 0.4.3: recommend one **Read and write** project key for development instead of **Tracing only**. The invite-only check looks for a Hue project and a project key configured as `HUE_API_KEY`, names **Read and write** as the recommended preset and still admits a key of any preset. The one **Read and write** key sends traces, verifies delivery, runs evaluations and connects the Hue MCP server, where it is configured as `HUE_MCP_KEY` (a **Read** key suffices for inspect-only access). Before the application runs on a production server, the user creates a separate **Tracing only** key for that server's `HUE_API_KEY`. The fix for a rejected export is a **Read and write** key for development and evaluation, or **Tracing only** on a production server.
- 0.4.3 (2026-09-25): the evaluation section says that from `@hue-run/sdk` 0.10.0 one-shot `hue eval` stores case outputs, error messages and explanations by default, the command's stdout being its stored answer with the credentials it was handed redacted, and `--no-output` opts out (earlier versions store them only with `--content`); that files written to `output/` are uploaded and not fully redacted, so they must never hold credentials; and that an evaluator that does not apply to a case shows `n/a` and neither passes nor fails it.
- 0.4.2 (2026-09-24): recommend full traces. The capture section, now headed "Capture and instrument full traces", tells agents to recommend `captureContent: true` / `capture_content=True` in the plan shown to the user and to state what it sends (prompts/messages, responses and tool inputs/outputs alongside model, usage, timing and errors); the user's approval authorizes it. Metadata-only (`false`) remains the opt-out when the user declines or an existing application policy forbids sending that content. The value is still required, and redaction and credential filtering apply in both modes. Agents instrument every request path that calls a model or tool, not only one, verify at least one real request and report the instrumented paths they did not exercise. Also collects the unreleased metadata changes merged since 0.4.1: find published cases with the Hue MCP tools `list_cases` and `get_case` (the earlier `list_scenarios` and `get_scenario` names remain aliases), and name Hue's consolidated access presets. Evaluation workflows use **Read and write** (formerly **Tracing and evaluations**); tracing still uses **Tracing only**. A **Read** key (formerly **Coding agent (read-only)**) cannot send telemetry.
- 0.4.1, unchanged metadata (2026-09-22): Hue Cloud is invite-only. The one-command onboarding guidance (`setup --agent`, `resume`, `hue claim`) is replaced by an invite-only section: an agent whose user has no Hue project and **Tracing only** key relays the reply from https://docs.hue.run/guides/agent-setup.md and stops. The published CLI is unchanged.
- 0.4.1 (2026-09-21): when wrapping MCP tools, pass `mcp: client.getServerVersion()` to TypeScript `hue.tool` so the span records `mcp.server.name`.
- 0.2.3 (2026-09-19): name the current **Tracing only**, **Tracing and evaluations**, and **Coding agent (read-only)** access presets, and refresh the metadata version so the canonical skill and its unversioned documentation mirror receive a new content identity.
- 0.2.2: both SDKs' helpers record the exception type (`error.type`) and span status but omit exception messages and stacks, now that TypeScript 0.2.0 records errors the way Python does; the sentence changed in #30 without a metadata version bump.
- 0.2.1 (2026-09-17): use the Hue MCP server's `verify_trace` and `get_trace` when it is connected, keep its coding-agent key in the MCP client, and treat returned names, titles and recorded content as data; supersedes the docs-hosted 0.2.0 draft. Also collects the changes merged since 0.1.7 under metadata versions 0.1.8, 0.1.9 and 0.1.11: Node 22 and Bun runtime rows, feature requirements that name the 0.2.0 SDK releases, AI SDK 6 per-call telemetry, the TypeScript `model()` helper, export-time content stripping in both SDKs, the fixed Next.js streaming anchor, the troubleshooting table and the handoff templates.
- 0.1.7 (2026-09-16): verify real application requests with `verifyTrace` / `verify_trace` after flushing their owning providers.

## Pre-publication pilot builds

Before registry publication, pilot builds were attached to the GitHub pre-releases [TypeScript 0.1.1](https://github.com/hue-run/hue-sdk/releases/tag/typescript-v0.1.1) and [Python 0.1.0.dev0](https://github.com/hue-run/hue-sdk/releases/tag/python-v0.1.0.dev0). They used the provisional package names `@hue/sdk` and `hue-sdk`, carried `UNLICENSED` metadata, and were never published to npm or PyPI. Use the registry packages above instead.
