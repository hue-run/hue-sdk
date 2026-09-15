# Compatibility

This matrix describes TypeScript `0.1.2` and Python `0.1.0`. Tested combinations establish the paths below; accepting standard OTLP is broader than testing every instrumentation library.

| Path | Verified support | Boundary |
| --- | --- | --- |
| TypeScript core and evaluations | Node.js 24; compiled ESM and type declarations | No CommonJS export; older Node releases are not in the test matrix. |
| Vercel AI SDK adapter | AI SDK / OTel pairs `7.0.99 / 1.0.99` and `7.0.100 / 1.0.100` | Install both adapter peers; preserve an existing global integration. |
| Existing JavaScript OTel provider | Hue transport attached to an application's provider; other exporters remain usable | The current npm package's optional AI peers still constrain any AI SDK already installed. |
| Python tracing and evaluations | Python 3.10 and 3.14; OpenTelemetry 1.44.0 | OTel versions are pinned. Local evaluation checkpoints require POSIX filesystem behavior. |
| Python OpenAI instrumentation | OpenAI 3.14.0 and OpenInference OpenAI 0.1.60, using a synthetic HTTP streaming provider | Configure the instrumentor's own content controls. This does not certify every provider API. |
| Direct OpenTelemetry export | OTLP HTTP protobuf/JSON traces and correlated logs, including gzip | No Hue package or model wrapper required; metrics and OTLP gRPC ingestion are not supported. |

## Existing dependencies

The current `@hue-run/sdk` package cannot be installed alongside `ai@6`: npm enforces the optional `ai@^7.0.99` peer even if the application only imports the core client. Do not bypass the resolver with `--force` or `--legacy-peer-deps`, or upgrade an application's framework solely to add tracing. An existing OTel application can send records with its standard exporter using the [OTLP integration guide](https://docs.hue.run/integrations/opentelemetry).

Python's exact OTel pins can conflict with applications that require a different version. Resolve the dependency set before changing the application. A lockfile records what was tested; it does not certify every compatible-looking version.

## Content and delivery

| Contract | TypeScript | Python |
| --- | --- | --- |
| Explicit content choice | Required `captureContent` | Required `capture_content` |
| Metadata-only scope | Hue helpers plus recognized external content fields on Hue's export path | Hue helpers; external instrumentation needs separate configuration |
| Arbitrary custom metadata | Application-controlled | Application-controlled |
| Failed delivery | `flush()` throws for new export failures; warning-only acknowledgements succeed and counters remain cumulative | `force_flush()` remains false after an export failure during the client's lifetime |
| Borrowed provider | Not shut down by the client | Not shut down by the client |

Neither SDK estimates unavailable token usage or cost. Queues are bounded and in memory; a successful model response does not establish telemetry delivery.

## Evaluation coverage

Both SDKs support dataset/scorer creation, frozen versions, local experiments, built-in/custom scorers, resumable result uploads and historical rescoring. Hosted judge job/budget methods are available, but credential resolution is not proof of a successful provider call. Activation belongs to the platform environment.

The clients do not yet expose every platform REST operation. Dataset editing/archival, case replacement/deletion, promotion from a trace, copying published scorers, experiment/run listing and frozen-trace snapshot reads are not convenience methods in these clients. There is no general service-key trace-search client. Open pull requests are not released functionality.

API responses are limited to 4 MiB by the clients. Full dataset pages can exceed this limit when cases contain large values. Use smaller explicit page limits when listing full cases; the local experiment runner separately reads summaries and individual cases. A response-size failure does not establish that the server rejected the request.
