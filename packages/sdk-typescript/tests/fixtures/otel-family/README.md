# OpenTelemetry-family import fixtures

Synthetic exports for `tests/traces-import-otel-family.test.ts`: invented ids, users, services and
content, each shaped as the vendor's own export writes it. Every file tells the same story, an agent
that answers an order question with one model call that requests a tool and one tool call whose
arguments name an account (never the trace's user), and most add a second trace with a malformed
record that must be refused alone.

- `jaeger-ui.json`: the Jaeger query service's `/api/traces` answer and UI download,
  `{data, total, limit, offset, errors}` with typed tags, logs, references and a process table, as
  written by `internal/uimodel` and its v1 JSON converter in jaegertracing/jaeger v2.22.0. The
  second trace has a 64-bit trace id and a span whose `startTime` is not a number.
- `jaeger-api-v3.jsonl`: a Jaeger API v3 NDJSON stream, one `{"result": {"resourceSpans": …}}`
  object per message and the closing `{"end": true}` (the HTTP gateway and RFC 0018 in the same
  repository), the OTLP/JSON as the OpenTelemetry Collector's JSON marshaler writes it.
- `zipkin-v2.json`: a Zipkin v2 trace (`zipkin2-api.yaml` in openzipkin/zipkin-api): text tags,
  microsecond `timestamp` and `duration`, endpoints, an annotation, a server span `shared` with its
  client's id and a child of it, an `error` tag, and a span with no timestamp.
- `phoenix-otlpv1.json` and `phoenix-spans.json`: Arize Phoenix's `GET
  /v1/projects/{project}/spans/otlpv1` and `GET /v1/projects/{project}/spans` pages
  (`src/phoenix/server/api/routers/v1/spans.py` and the REST API's OpenAPI schema), with the null
  fields the server writes, nanosecond integers past 2^53 and OpenInference attributes flattened
  to dotted keys.
- `datadog-llmobs.json`: a Datadog LLM Observability export API page (the "Export API" page of
  Datadog's LLM Observability documentation; field values as dd-trace-py records them: a decimal
  `span_id`, a root `parent_id` of `undefined`, nanosecond `start_ns` and `duration`, and
  `session_id`), with a span whose `metrics` is not an object.
- `otlp-request.json`: an OTLP/JSON `ExportTraceServiceRequest` the tests encode to protobuf with
  `../otlp-schema.json`, and frame as the OpenTelemetry Collector file exporter does.
