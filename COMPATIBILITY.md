# Compatibility

This matrix describes the next releases, TypeScript `0.2.0` and Python `0.2.0` (unreleased; see the Unreleased sections of [CHANGELOG.md](./CHANGELOG.md)). The published TypeScript `0.1.5` and Python `0.1.3` packages declare `engines.node >=24` and strip external content only in TypeScript. See [VERSIONING.md](./VERSIONING.md) for the versioning, deprecation and runtime support policy. Tested combinations establish the paths below; accepting standard OTLP is broader than testing every instrumentation library.

| Path | Verified support | Boundary |
| --- | --- | --- |
| TypeScript core and evaluations | Node.js 22 and 24 (CI also runs 26); Bun 1.4.2 runs the installed-package suite and the reference chatbot; compiled ESM and type declarations | `engines.node >= 22.12`. No CommonJS export. Resource-bound checks (heap flags, worker memory limits, export-deadline socket close) are verified on Node; Bun does not enforce worker `resourceLimits`. |
| Vercel AI SDK adapter | AI SDK / OTel pairs `7.0.99 / 1.0.99` and `7.0.100 / 1.0.100` | Install both adapter peers; preserve an existing global integration. |
| Existing JavaScript OTel provider | Hue transport attached to an application's provider; other exporters remain usable | Core-only installation supports AI SDK 6; the Hue AI SDK adapter requires version 7. |
| Python tracing and evaluations | Python 3.10 and 3.14; OpenTelemetry 1.44.0 | OTel versions are pinned. Local evaluation checkpoints require POSIX filesystem behavior. |
| Python OpenAI instrumentation | OpenAI 3.14.0 and OpenInference OpenAI 0.1.60, using a synthetic HTTP streaming provider | Configure the instrumentor's own content controls. This does not certify every provider API. |
| Direct OpenTelemetry export | OTLP HTTP protobuf/JSON traces and correlated logs, including gzip | No Hue package or model wrapper required; metrics and OTLP gRPC ingestion are not supported. |

## Existing dependencies

`@hue-run/sdk` core can coexist with AI SDK 6 (installed-package validation covers 6.0.116). The `hueTelemetry` adapter still requires AI SDK 7 and a compatible `@ai-sdk/otel` peer; it explicitly rejects AI SDK 6. Keep AI SDK 6 instrumentation on its existing provider and attach Hue transport, or use a standard OTLP exporter. Do not force dependency resolution or upgrade a framework solely to add tracing.

Python's exact OTel pins can conflict with applications that require a different version. The pins are deliberate: the Python transport relies on OpenTelemetry internals for instrumentation suppression and log encoding, so each OpenTelemetry release is adopted through a Hue patch release rather than a resolver range. Resolve the dependency set before changing the application. A lockfile records what was tested; it does not certify every compatible-looking version.

## Content and delivery

| Contract | TypeScript | Python |
| --- | --- | --- |
| Explicit content choice | Required `captureContent` | Required `capture_content` |
| Metadata-only scope | Hue helpers plus recognized external content fields on Hue's export path | Hue helpers plus recognized external content fields on Hue's export path |
| Arbitrary custom metadata | Application-controlled | Application-controlled |
| Failed delivery | `flush()` throws for new export failures; warning-only acknowledgements succeed and counters remain cumulative | `force_flush()` remains false after an export failure, dropped record or instrumentation failure during the client's lifetime |
| Borrowed provider | Not shut down by the client | Not shut down by the client |

In metadata-only mode both SDKs drop attributes whose keys start with a recognized content prefix: OpenTelemetry GenAI (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.prompt`, `gen_ai.completion`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.tool.definitions`, `gen_ai.event.content`), OpenInference (`input.value`, `output.value`, `llm.input_messages`, `llm.output_messages`, `llm.prompts`, `llm.completions`, `llm.invocation_parameters`), OpenLLMetry (`traceloop.entity.input`, `traceloop.entity.output`), Vercel AI SDK (`ai.prompt`, `ai.response.text`, `ai.response.object`, `ai.response.toolCalls`, `ai.response.body`, `ai.toolCall.args`, `ai.toolCall.result`, `ai.value`, `ai.values`, `ai.embedding`, `ai.embeddings`), plus `tool.parameters`, `exception.message` and `exception.stacktrace`. The TypeScript list is exported as `contentPrefixes`; Python uses the same list. Unrecognized custom keys pass through.

Neither SDK estimates unavailable token usage or cost. Queues are bounded and in memory; a successful model response does not establish telemetry delivery. Message content recorded through `recordMessages` / `log_inference` travels in the body of the `gen_ai.client.inference.operation.details` log record (structured in TypeScript, JSON strings in Python so null stays distinct) rather than as the Development-status event attributes; Hue's receiver reads the body.

## Evaluation coverage

Both SDKs support dataset/scorer creation, frozen versions, local experiments, built-in/custom scorers, resumable result uploads and historical rescoring. Hosted judge job/budget methods are available, but credential resolution is not proof of a successful provider call. Activation belongs to the platform environment.

The clients do not yet expose every platform REST operation. Dataset editing/archival, case replacement/deletion, promotion from a trace, copying published scorers, experiment/run listing and frozen-trace snapshot reads are not convenience methods in these clients. Trace browsing for coding agents is served by the [Hue MCP server](https://docs.hue.run/agents/mcp-server) with a separate `project_read` key capability, not by these clients. Open pull requests are not released functionality.

API responses are limited to 4 MiB by the clients. Full dataset pages can exceed this limit when cases contain large values. Use smaller explicit page limits when listing full cases; the local experiment runner separately reads summaries and individual cases. A response-size failure does not establish that the server rejected the request.

## Hue-managed runs

The TypeScript and Python managed target adapters use the same versioned HTTP contract. Hue starts runs against a registered public HTTPS endpoint; the existing agent remains in its own environment. This release supports synchronous targets, verified file transfer, stored outcome recovery and deterministic platform scoring. Hosted AI judges, arbitrary hosted code, manual evaluators and asynchronous targets are outside this managed-run release. See [managed runs](https://docs.hue.run/evaluations/managed-runs).

## Failure isolation

Serving applications should use `createHueSafe` / `create_hue_safe`, `enabled: false` / `enabled=False` for a local kill switch, and bounded safe lifecycle methods. See [production safety](https://docs.hue.run/guides/production-safety). Helper capture failures omit telemetry, preserve business results/errors and increment diagnostic counters. TypeScript defaults to an 8 MiB combined trace/log queue budget; Python defaults to 8 MiB per signal, including in-flight records. These are telemetry budgets, not process RSS ceilings. A process kill, arbitrary slow user hook, third-party instrumentation or out-of-memory condition remains outside an in-process SDK guarantee.
