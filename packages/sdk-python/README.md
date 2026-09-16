# Hue Python SDK

For frozen datasets, local experiments, custom scorers, durable retries and historical rescoring, see [Local evaluations](https://docs.hue.run/evaluations/first-evaluation).

Python helpers around official OpenTelemetry **1.44.0** trace and log SDKs and OTLP HTTP/protobuf exporters. Provider requests run in your application. This package does not proxy model calls or configure global OTel providers.

The distribution is named `hue-run` (`import hue_sdk`). Python 3.10+ is supported by the package contract; recorded validation below identifies the tested runtime.

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
    capture_content=False,  # Required: choose explicitly.
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

The SDK uses `https://app.hue.run` by default. Set `base_url` only for a different Hue deployment or a local receiver, using an origin without an API suffix. Existing `Hue(base_url, api_key, ...)` calls remain supported. The project service key determines the project. The SDK validates the project at `GET /api/v1/projects/current` when explicitly requested; construction itself does not perform a request. HTTP is permitted only for `localhost` and loopback IPs. Userinfo, query strings, fragments, paths and redirects are rejected. The key is sent only as `Authorization: Bearer …`; `repr(hue)`, SDK errors and status counters omit it.

## Content and semantic fields

`capture_content` has no default. `False` makes `set_input`, `set_output` and inference-log bodies omit content before it reaches an OTel queue. Explicit JSON null, empty strings and absent content stay distinct when capture is enabled. Exception recording includes the exception type and ERROR status; exception messages and stacks are always excluded by these helpers.

This setting is **not a blanket PII filter**. Custom attributes, span names, session/user identifiers, resource attributes, third-party instrumentors and other exporters remain under your control. The server stores received content; there is no automatic telemetry expiry. Delete scoped data explicitly when required by your retention policy.

Use `redactor=lambda field, value: ...` to transform content in supported helpers. It runs synchronously before serialization and export. Return a redacted JSON value; failures raise a generic `ValueError` and the field is not recorded. It does not inspect arbitrary OTel attributes or logs:

```python
def redact(field, value):
    if isinstance(value, dict):
        return {key: "[redacted]" if key == "email" else item for key, item in value.items()}
    return value
```

The callback should cover your actual nested input format; this small example is only a top-level dictionary transformation.

| Helper                                         | Attributes / behavior                                                                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `span(name)`                                   | Generic `input.value` / `output.value`, optional OTel attributes and kind                                                                      |
| `model(model, provider=...)`                   | `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.provider.name`; message content in `gen_ai.input.messages` / `gen_ai.output.messages` |
| `tool(name, call_id=...)`                      | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, call ID, arguments and result                                                        |
| `context(session_id=..., user_id=...)`         | Task-local `gen_ai.conversation.id` / `user.id` on nested Hue helpers; observed users are not Hue account identities                           |
| `span.set_usage(...)`                          | Nonnegative reported `gen_ai.usage.input_tokens` / `output_tokens`; `None` leaves a field absent                                               |
| `span.log_inference(input=..., output=...)`    | Correlated `gen_ai.client.inference.operation.details` log, explicitly linked to that span                                                     |
| `span.record_error(error)`                     | Exception type event and ERROR status; context managers also record escaping errors/cancellation                                               |
| `Hue.inject(headers)` / `Hue.extract(headers)` | W3C trace context propagation; pass extracted context to `span(parent_context=...)`                                                            |

For model helpers, pass the message representation produced by your integration. Prefer current [GenAI message conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) when authoring your own messages. Use either span content or correlated logs for a given input/output, avoiding duplicate copies. Structured log fields contain JSON strings so null remains distinguishable from protobuf's absent value.

## Existing instrumentation

Pass an existing `opentelemetry.sdk.trace.TracerProvider` through `tracer_provider=provider` to add Hue's exporter. Hue does not call `set_tracer_provider`. It exposes `hue.tracer_provider`, `hue.tracer` and `hue.logger_provider` for explicit integration. `shutdown()` closes Hue's processors; a borrowed tracer provider and its other processors stay usable. Do not repeatedly attach Hue clients to one long-lived provider: OTel has no public processor-removal API. Create one client per provider lifecycle.

An instrumentor that accepts `tracer_provider` can receive `hue.tracer_provider`; follow that instrumentor's own capture/redaction configuration. OpenInference and other OTel instrumentors are optional dependencies, not implicitly enabled. They can emit content even when Hue helper capture is disabled. The optional compatibility group pins **OpenAI 3.14.0**, **OpenInference OpenAI 0.1.60** and its resolved **OpenInference instrumentation 0.1.63**. A synthetic HTTP streaming response verifies parentage, canonical model/usage attributes and enabled/disabled message capture with `TraceConfig(enable_genai_semconv=True, hide_inputs=..., hide_outputs=..., hide_input_messages=..., hide_output_messages=...)`. This is a tested adapter combination, not a claim about all OpenAI APIs or live-provider compatibility. See the [instrumentor's official source](https://github.com/Arize-ai/openinference/tree/main/python/instrumentation/openinference-instrumentation-openai). See the [Python integration guide](https://docs.hue.run/sdks/python) for application setup.

## Export behavior and limits

- Traces go to `/api/v1/otlp/v1/traces`; correlated logs go to `/api/v1/otlp/v1/logs`. Both use the official OTLP HTTP/protobuf exporter, uncompressed. The official retry policy remains active for retryable network/service failures. There is no proprietary provider transport.
- Batches initially contain at most 64 records and are split by encoded protobuf size to fit **1 MiB**, both on wire and after decoding. A single oversized record fails visibly through export status. Helper content exceeding **256 KiB** UTF-8 JSON raises before enqueue; it is never silently truncated by Hue. Third-party record validation remains the receiver's responsibility. OTel's own attribute/count/environment limits can still affect externally configured providers.
- Hue accepts at most **2,000 distinct spans per trace**. This is enforced by the receiver across distributed producers; the client cannot guarantee a global count.
- HTTP errors, malformed/non-200 success responses and OTLP `partial_success` rejected counts cause a failed export status. Partial rejection is not retried wholesale. Receiver error text is not echoed. A warning-only partial-success response with zero rejected records remains successful.
- `force_flush(timeout_millis=30000)` drains both processors and returns `False` for a timeout or any recorded failed export batch since this client was created. Because OTel 1.44 ignores its processor timeout, Hue serializes flushes in one background worker and bounds the caller's wait. Pending exports continue after timeout. `export_status` exposes cumulative failure counters. `shutdown()` stops new helpers, drains and closes owned exporters within the caller's wait budget; repeated calls wait for the same shutdown. After a timeout, keep the process alive and call shutdown again to confirm completion. Context-manager exit calls shutdown; check flush explicitly when an exit code must reflect delivery failure.
- Standard OTel batch queues hold 2,048 records per signal and are in-memory. Queue overflow, process termination and sampling can lose telemetry. Flush success reports observed exporter outcomes, not durable local delivery or proof that every application operation was instrumented. The exporter timeout controls individual export/retry operations. A caller timeout does not cancel an HTTP request already in flight; background workers continue until the operation completes.

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

Python 3.10+ is supported. CI tests Python 3.10 and 3.14, source imports and an independently installed wheel. Tests use synthetic loopback HTTP receivers and decode official OTLP protobuf messages to verify trace/log correlation, metadata-only capture, redaction, propagation, existing-provider ownership, authentication failures, redirects, partial rejection, retries and encoded request limits. Compatibility tests also exercise local evaluations and the optional OpenInference adapter. No live model provider is required for these checks.

See the [documentation](https://docs.hue.run/sdks/python) for integration guidance and [troubleshooting](https://docs.hue.run/guides/troubleshooting) for export failures.

## Managed targets

Run your existing agent from Hue with authenticated execution claims, verified files,
real trace context and saved outcomes. See [Managed targets](MANAGED_TARGETS.md).
