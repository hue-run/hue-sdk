# Compatibility

The published releases are TypeScript `0.9.0` and Python `0.6.0`. See [VERSIONING.md](./VERSIONING.md) for the versioning, deprecation and runtime support policy. Tested combinations establish the paths below; accepting standard OTLP is broader than testing every instrumentation library.

| Path | Verified support | Boundary |
| --- | --- | --- |
| TypeScript core and evaluations | Node.js 22 and 24 (CI also runs 26); Bun 1.4.2 runs the installed-package suite and the reference chatbot; compiled ESM and type declarations | `engines.node >= 22.12`. ESM build only; CommonJS applications load it through Node's `require(esm)`. Resource-bound checks (heap flags, worker memory limits, export-deadline socket close) are verified on Node; Bun does not enforce worker `resourceLimits`. |
| Vercel AI SDK adapter | AI SDK / OTel pairs `7.0.99 / 1.0.99` and `7.0.100 / 1.0.100` | Install both adapter peers; preserve an existing global integration. |
| Existing JavaScript OTel provider | Hue transport attached to an application's provider; other exporters remain usable | Core-only installation supports AI SDK 6; the Hue AI SDK adapter requires version 7. |
| Python tracing and evaluations | Python 3.10 and 3.14 with OpenTelemetry 1.44.0, the certified combination recorded in `uv.lock`; Python 3.10 and 3.12 with OpenTelemetry 1.40.0, the declared floor | `opentelemetry-api`, `opentelemetry-sdk` and `opentelemetry-exporter-otlp-proto-http` are accepted as `>=1.40,<2`; other releases inside the range are accepted by the resolver but not individually certified; new 1.x releases are adopted through a `uv.lock` bump once the frozen CI jobs pass. Local evaluation checkpoints require POSIX filesystem behavior. |
| Python OpenAI instrumentation | OpenAI 3.14.0 and OpenInference OpenAI 0.1.60, using a synthetic HTTP streaming provider and a synthetic Responses call with a hosted MCP tool | Configure the instrumentor's own content controls. This does not certify every provider API. |
| Direct OpenTelemetry export | OTLP HTTP protobuf/JSON traces and correlated logs, including gzip | No Hue package or model wrapper required; metrics and OTLP gRPC ingestion are not supported. |
| Live spans | Placeholders for running Hue and AI spans, sent by the Hue transports from TypeScript `0.7.0` and Python `0.4.0` | Requires a Hue deployment that answers trace exports with `Hue-Pending-Spans: 1` (app.hue.run does). A receiver without that header, an older Hue or a generic collector, gets placeholders only in the first export that carries them: the SDK then records one warning and switches live spans off for that client. Turn `liveSpans` / `live_spans` off to send none at all. |

## Existing dependencies

`@hue-run/sdk` core can coexist with AI SDK 6 (installed-package validation covers 6.0.116). The `hueTelemetry` adapter still requires AI SDK 7 and a compatible `@ai-sdk/otel` peer; it explicitly rejects AI SDK 6. Keep AI SDK 6 instrumentation on its existing provider and attach Hue transport, or use a standard OTLP exporter. Do not force dependency resolution or upgrade a framework solely to add tracing.

Python declares `opentelemetry-api`, `opentelemetry-sdk` and `opentelemetry-exporter-otlp-proto-http` as `>=1.40,<2`, so `hue-run` installs next to applications and `opentelemetry-instrumentation-*` packages that are on a different OpenTelemetry 1.x release. `uv.lock` records the certified combination (OpenTelemetry 1.44.0) used by the frozen CI jobs and the release verification; a second CI job re-resolves every direct dependency at its declared floor (`uv lock --resolution lowest-direct`, OpenTelemetry 1.40.0) and runs the whole behavioral suite, including the installed wheel. The Python transport uses two OpenTelemetry internals, the instrumentation-suppression context key and the OTLP log encoder. Both are present in every release of the range and both are guarded: a missing log encoder raises an `ImportError` naming the supported range at import time, and a missing suppression key emits a one-time `RuntimeWarning`, after which Hue exports without OpenTelemetry suppression while its own queues still ignore its export work. A lockfile records what was tested; it does not certify every compatible-looking version.

## Content and delivery

| Contract | TypeScript | Python |
| --- | --- | --- |
| Explicit content choice | Required `captureContent` for enabled clients (`enabled: false` defaults it to false) | Required `capture_content` |
| Metadata-only scope | Hue helpers plus recognized external content fields on Hue's export path | Hue helpers plus recognized external content fields on Hue's export path |
| Arbitrary custom metadata | Application-controlled | Application-controlled |
| Failed delivery | `flush()` throws for new export failures; warning-only acknowledgements succeed and counters remain cumulative | `force_flush()` remains false after an export failure, dropped record or instrumentation failure during the client's lifetime |
| Borrowed provider | Not shut down by the client | Not shut down by the client |
| Non-loopback HTTP collector | `allowInsecureHttp: true` opt-in with a one-time warning | Not available; use HTTPS or a loopback sidecar |
| Inline files in recorded messages | A `blob`/`file` part longer than 64 KiB in `gen_ai.input.messages`, `gen_ai.output.messages` or `ai.prompt.messages` is exported as its `sha256` and `size` instead of its content. In the next release (unreleased) this happens at admission, before the queue budget is charged; earlier releases do it only in the exporter, so under the default 8 MiB `maxQueueBytes` a span inlining a file over about 3 MiB is dropped. A message attribute longer than 8 MiB is left to the snapshot budget, which drops it | From `0.5.1`, the same at admission on the application thread (since then); a message attribute longer than 8 MiB is left to the snapshot budget, which drops it |

In metadata-only mode both SDKs drop attributes whose keys start with a recognized content prefix: OpenTelemetry GenAI (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.prompt`, `gen_ai.completion`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.tool.definitions`, `gen_ai.event.content`), OpenInference (`input.value`, `output.value`, `input.images`, `output.images`, `llm.input_messages`, `llm.output_messages`, `llm.prompts`, `llm.completions`, `llm.choices`, `llm.function_call`, `llm.tools`, `llm.invocation_parameters`, `llm.prompt_template.template`, `llm.prompt_template.variables`, `retrieval.documents`, `embedding.embeddings`, `reranker.query`, `reranker.input_documents`, `reranker.output_documents`), OpenLLMetry (`traceloop.entity.input`, `traceloop.entity.output`), Vercel AI SDK (`ai.prompt`, `ai.response.text`, `ai.response.object`, `ai.response.reasoning`, `ai.response.files`, `ai.response.toolCalls`, `ai.response.body`, `ai.toolCall.args`, `ai.toolCall.result`, `ai.value`, `ai.values`, `ai.embedding`, `ai.embeddings`), plus `tool.parameters`, `exception.message` and `exception.stacktrace`. The TypeScript list is exported as `contentPrefixes`; Python's `CONTENT_PREFIXES` is identical and both test suites assert the full list. Unrecognized custom keys (for example a document's `metadata` under a custom key) pass through. Before stripping, TypeScript copies the OpenAI hosted MCP `serverLabel` from a recorded AI SDK 7 `extension` tool result to `mcp.server.name` and marks a result carrying an MCP `error` with `error.type` `mcp_error` and ERROR status; both survive metadata-only export.

Neither SDK estimates unavailable token usage or cost. Queues are bounded and in memory; a successful model response does not establish telemetry delivery. Message content recorded through `recordMessages` / `log_inference`, including optional `gen_ai.system_instructions`, travels as the structured body of the `gen_ai.client.inference.operation.details` log record rather than as the Development-status event attributes; Hue's receiver reads the body. `model()` records optional system instructions and tool definitions as the `gen_ai.system_instructions` and `gen_ai.tool.definitions` span attributes, only when content is captured (TypeScript `0.8.1`, Python `0.5.1`; since those releases). In both SDKs an explicit null field keeps its key with an empty value, so it stays distinct from an absent field. Both SDKs set `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model` and `gen_ai.conversation.id` as attributes on that record when they are known from the enclosing `model()` span, the caller or the active session, and emit no record in metadata-only mode.

When content is captured, both SDKs (TypeScript `0.8.1`, Python `0.5.1`; since those releases) replace hosted-tool credentials with `"[redacted]"` before export: credential-like fields including `authorization`, `authorization_token`, `headers`, `api_key`, `access_token`, `x-api-key`, and keys ending in `token`, `secret`, `password`, `apikey` or `credential` (case-insensitively, ignoring `-` and `_`) in `gen_ai.tool.definitions`, `ai.prompt.tools` and `llm.tools.*.tool.json_schema`, and in the `tools` and `mcp_servers` entries of a raw request or response recorded as `input.value`, `output.value` or `llm.invocation_parameters`. Names of JSON Schema parameters under `properties` are kept. TypeScript applies `redact` afterwards. URL userinfo, query values and fragments are removed before export. A tool definition nested more than 256 levels deep rejects its record rather than being exported unchecked.

In metadata-only mode a record whose tool definitions are removed carries `hue.tool.names` (each definition's `name`, Chat Completions `function.name` or the `type` of an unnamed built-in tool, in order) and `hue.tool.definitions.sha256`, the lowercase hex SHA-256 of the RFC 8785 canonical JSON of the credential-scrubbed definition list, taken from `gen_ai.tool.definitions`, else `ai.prompt.tools`, else `llm.tools.{i}.tool.json_schema` in index order. Both SDKs (TypeScript `0.8.1`, Python `0.5.1`; since those releases) derive the same names and digest from the same definitions; both suites check a shared fixture. Definitions that are not JSON, or longer than 1 MiB of text, produce no summary, and attributes a record already sets are kept.

## Evaluation coverage

Both SDKs expose product-named eval set, evaluator, run and scoring client methods while retaining the older low-level names and v1 paths. They support frozen versions, local runs, built-in and custom evaluators, resumable result uploads and historical rescoring. Hosted judge job and budget methods are available, but credential resolution is not proof of a successful provider call. Activation belongs to the platform environment.

TypeScript local experiments, connected workers and rescoring also handle file-based cases: the runner downloads and verifies a case's pinned input files, uploads the documents a target returns as verified Hue artifacts, and hands both to local scorers, including when it regrades files a previous run saved. That file handling is unreleased, needs a Hue deployment that serves case input files, subject files and the artifact APIs, and has no Python equivalent.

The clients do not yet expose every platform REST operation. Dataset editing/archival, case replacement/deletion, promotion from a trace, copying published scorers, experiment/run listing and frozen-trace snapshot reads are not convenience methods in these clients. Trace browsing for coding agents is served by the [Hue MCP server](https://docs.hue.run/agents/mcp-server) with a separate **Read** key, not by these clients. Open pull requests are not released functionality.

API responses are limited to 4 MiB by the clients. Full dataset pages can exceed this limit when cases contain large values. Use smaller explicit page limits when listing full cases; the local experiment runner separately reads summaries and individual cases. A response-size failure does not establish that the server rejected the request.

## Hue-managed runs

The TypeScript and Python managed target adapters use the same versioned HTTP contract. Hue starts runs against a registered public HTTPS endpoint; the existing agent remains in its own environment. This release supports synchronous targets, verified file transfer, stored outcome recovery and deterministic platform scoring. Hosted AI judges, arbitrary hosted code, manual evaluators and asynchronous targets are outside this managed-run release. See [managed runs](https://docs.hue.run/evaluations/managed-runs).

## Failure isolation

Serving applications should use `createHueSafe` / `create_hue_safe`, `enabled: false` / `enabled=False` for a local kill switch, and bounded safe lifecycle methods. See [production safety](https://docs.hue.run/guides/production-safety). Helper capture failures omit telemetry, preserve business results/errors and increment diagnostic counters. TypeScript defaults to an 8 MiB combined trace/log queue budget; Python defaults to 8 MiB per signal, including in-flight records. These are telemetry budgets, not process RSS ceilings. A process kill, arbitrary slow user hook, third-party instrumentation or out-of-memory condition remains outside an in-process SDK guarantee.

## App-launched local agents

`runLocalAgent()` shipped in TypeScript `0.3.0` with the restricted
`runSimulation()` candidate projection; generic evaluations remain compatible. Both paths share
the same provider-aware world lifecycle and uncertainty rules. A matching Hue API deployment is
required. Public package tests exercise local control-plane responses and connection-bundle
handling; they do not call an issued provider facade. These tests do not call the official Gmail
service or establish universal Gmail or Slack parity. Python does not
include a native local-worker implementation.

## Scorer forward compatibility

Scorer deferral shipped in TypeScript `0.3.1`: only known `builtin` entries and bound `local_code` scorers execute locally.
Every other kind is reported in `deferredScorerVersionIds` without a local result upload,
including unknown kinds and built-in entries returned by a newer server. The responsible server or human executor
must complete those scores. Legacy local-code pins still require their exact callback binding.
The V2 connection bundle, provider transport, worker recovery and OpenTelemetry ownership remain
unchanged. Setup is a separate local inspection CLI, not a simulation launcher.
