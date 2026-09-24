<p align="center">
  <img alt="Hue" src="https://raw.githubusercontent.com/hue-run/hue-sdk/df0443f98c6096ff331fd0400715e4f3a1936607/.github/assets/hue-ascii-neutral.png" width="720">
</p>

# Hue Python SDK

[![PyPI](https://img.shields.io/pypi/v/hue-run?label=hue-run)](https://pypi.org/project/hue-run/) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

For frozen datasets, local experiments, custom scorers, durable retries and historical rescoring, see [Local evaluations](https://docs.hue.run/evaluations/first-evaluation).

Python helpers around the official OpenTelemetry trace and log SDKs and OTLP HTTP/protobuf exporters. `opentelemetry-api`, `opentelemetry-sdk` and `opentelemetry-exporter-otlp-proto-http` are accepted as **`>=1.40,<2`**; **1.44.0** is the certified lockfile combination and **1.40.0** is tested as the floor in CI. Provider requests run in your application. This package does not proxy model calls or configure global OTel providers.

The distribution is named `hue-run` (`import hue_sdk`). Python 3.10+ is supported by the package contract; recorded validation below identifies the tested runtime.

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

The SDK uses `https://app.hue.run` by default. Set `base_url` only for a different Hue deployment or a local receiver, using an origin without an API suffix. Existing `Hue(base_url, api_key, ...)` calls remain supported; a bare key passed as the first positional argument raises `TypeError` pointing at `api_key=`. The project service key determines the project. The SDK validates the project at `GET /api/v1/projects/current` when explicitly requested; construction itself does not perform a request. HTTP is permitted only for `localhost` and loopback IPs. Userinfo, query strings, fragments, paths and redirects are rejected. The key is sent only as `Authorization: Bearer …`; `repr(hue)`, SDK errors and status counters omit it.

## Content and semantic fields

`capture_content` has no default. `False` makes `set_input` and `set_output` omit content before it reaches an OTel queue and makes `log_inference` emit no record. Explicit JSON null, empty strings and absent content stay distinct when capture is enabled. Exception recording includes the exception type and ERROR status; exception messages and stacks are always excluded by these helpers.

When capture is disabled Hue also strips recognized GenAI, OpenInference, OpenLLMetry and Vercel AI SDK content attributes (including OpenInference retrieval documents, embeddings, reranker documents, prompt-template variables and images), legacy `gen_ai.*` message events, log bodies and status descriptions from every record it exports, including spans produced by third-party instrumentors on the same provider. [COMPATIBILITY.md](https://github.com/hue-run/hue-sdk/blob/main/COMPATIBILITY.md) lists the exact keys. This setting is still **not a blanket PII filter**: custom attribute names, span names, session/user identifiers and resource attributes cannot be classified automatically and remain under your control, and other exporters keep their own policy. The server stores received content; there is no automatic telemetry expiry. Delete scoped data explicitly when required by your retention policy.

Hosted tools carry credentials in their definitions, such as the `authorization` and `headers` of an OpenAI hosted MCP tool. When content is captured, Hue's export path replaces credential-like fields including `authorization`, `authorization_token`, `headers`, `api_key`, `access_token`, `x-api-key`, and keys ending in `token`, `secret`, `password`, `apikey` or `credential` (case-insensitively, ignoring `-` and `_`) with `"[redacted]"` in recorded tool definitions (`gen_ai.tool.definitions`, `ai.prompt.tools`, `llm.tools.*.tool.json_schema`) and in the `tools` and `mcp_servers` entries of a raw provider request or response recorded as `input.value`, `output.value` or `llm.invocation_parameters`, as OpenInference does. Parameters named in a JSON Schema `properties` object keep their schemas, so a tool that takes a `headers` argument is still described. A definition nested more than 256 levels deep drops its record. Credentials elsewhere, for example in a schema `default`, are not recognized.

Use `redactor=lambda field, value: ...` to transform content in supported helpers. It runs synchronously before serialization and export. Return a redacted JSON value; failures omit the field and increment `export_status.instrumentation_failures` without changing application behavior. It does not inspect arbitrary OTel attributes or logs:

```python
def redact(field, value):
    if isinstance(value, dict):
        return {key: "[redacted]" if key == "email" else item for key, item in value.items()}
    return value
```

The callback should cover your actual nested input format; this small example is only a top-level dictionary transformation.

Before redaction, helpers copy supported content into detached built-in containers; in-place changes by a redactor cannot change application inputs or results. The input and the redactor's returned value each have a **1 MiB conservative value budget**, **64 maximum nesting depth** and **65,536 visited values/keys**. Integers and integer keys are limited to **14,000 bits** before decimal conversion. Final serialized content still has the **256 KiB** UTF-8 JSON limit. Cyclic, nonfinite, unsupported or over-budget content is omitted and counted as an instrumentation failure. See [the Python safety boundary](https://github.com/hue-run/hue-sdk/blob/main/packages/sdk-python/SAFETY.md) for supported types and callback limits.

| Helper                                         | Attributes / behavior                                                                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `span(name)`                                   | Generic `input.value` / `output.value`, optional OTel attributes and kind                                                                      |
| `model(model, provider=...)`                   | `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.provider.name`; message content in `gen_ai.input.messages` / `gen_ai.output.messages` |
| `tool(name, call_id=..., mcp=...)`             | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, call ID, optional MCP `initialize` `serverInfo` as `mcp.server.name` / `mcp.server.version` and Hue `provider` / `surface` as `hue.mcp.provider` / `hue.mcp.surface`, arguments and result |
| `context(session_id=..., user_id=...)`         | Task-local `gen_ai.conversation.id` / `user.id` on nested Hue helpers; observed users are not Hue account identities                           |
| `span.set_usage(...)`                          | Nonnegative reported `gen_ai.usage.input_tokens` / `output_tokens`; `None` leaves a field absent                                               |
| `span.log_inference(input=..., output=...)`    | Correlated `gen_ai.client.inference.operation.details` log linked to that span: structured body plus request metadata and session attributes |
| `span.record_error(error)`                     | Exception type event and ERROR status; context managers also record escaping errors/cancellation                                               |
| `Hue.inject(headers)` / `Hue.extract(headers)` | W3C trace context propagation; pass extracted context to `span(parent_context=...)`                                                            |

Tool/model metadata accepts plain strings; invalid values use stable fallback labels and increment instrumentation failures without invoking custom conversion hooks. Disabled tracing skips metadata validation.

For model helpers, pass the message representation produced by your integration. Prefer current [GenAI message conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) when authoring your own messages. Use either span content or correlated logs for a given input/output, avoiding duplicate copies. `log_inference` sends a structured body (an explicit `None` field keeps its key with an empty value, distinct from an absent field) and copies `gen_ai.operation.name`, `gen_ai.provider.name` and `gen_ai.request.model` from the enclosing `model()` block, or from its `operation=`, `provider=` and `model=` keywords, plus `gen_ai.conversation.id` from `context()`, onto the record's attributes. A blank or over-long keyword is omitted and counted as an instrumentation failure.

## Existing instrumentation

Pass an existing `opentelemetry.sdk.trace.TracerProvider` through `tracer_provider=provider` to add Hue's exporter, and an existing `opentelemetry.sdk._logs.LoggerProvider` through `logger_provider=` when the application already owns one. A provider Hue creates for the other signal reuses the borrowed provider's resource, so spans and correlated logs report the same `service.name`; `service_name` applies only when Hue creates both providers. Hue's processor then exports every span that ends on that provider, the same default as other OpenTelemetry exporters, plus [placeholders](#live-spans) for its running Hue and AI spans; wrap the processor if only part of the provider's spans should reach Hue, and forward `on_start` only for spans whose `on_end` the wrapper forwards unchanged. Session/user identifiers from `hue.context()` are stamped on Hue helper spans only. Hue does not call `set_tracer_provider`. It exposes `hue.tracer_provider`, `hue.tracer` and `hue.logger_provider` for explicit integration. `shutdown()` closes Hue's processors; borrowed providers and their other processors stay usable. Finish traced work before shutting Hue down: spans ending or external records emitted afterward increment Hue's dropped-record counters, including emissions through a borrowed provider. New Hue helpers after shutdown are no-ops. Do not repeatedly attach Hue clients to one long-lived provider: OTel has no public processor-removal API. Create one client per provider lifecycle.

An instrumentor that accepts `tracer_provider` can receive `hue.tracer_provider`; follow that instrumentor's own capture/redaction configuration. OpenInference and other OTel instrumentors are optional dependencies, not implicitly enabled. Hue's export path strips their recognized content attributes when `capture_content` is `False`, but configure their own capture controls as well: unrecognized custom keys pass through, and the instrumentor may still send content to other exporters. The optional compatibility group pins **OpenAI 3.14.0**, **OpenInference OpenAI 0.1.60** and its resolved **OpenInference instrumentation 0.1.63**. A synthetic HTTP streaming response verifies parentage, canonical model/usage attributes and enabled/disabled message capture with `TraceConfig(enable_genai_semconv=True, hide_inputs=..., hide_outputs=..., hide_input_messages=..., hide_output_messages=...)`. This is a tested adapter combination, not a claim about all OpenAI APIs or live-provider compatibility. See the [instrumentor's official source](https://github.com/Arize-ai/openinference/tree/main/python/instrumentation/openinference-instrumentation-openai). See the [Python integration guide](https://docs.hue.run/sdks/python) for application setup.

## Local development without a Hue account

Hue speaks standard OTLP, so any local collector works. Point `base_url` at a loopback receiver that accepts `/api/v1/otlp/v1/traces` and `/api/v1/otlp/v1/logs` (for example an OpenTelemetry Collector `otlp` receiver with `http.traces_url_path` and `logs_url_path` set to those paths, forwarding to Jaeger or the debug exporter) and pass any placeholder `api_key`; HTTP is allowed for loopback origins. `validate_project()` and `verify_trace()` are Hue-only diagnostics and are not available against a generic collector.

## Export behavior and limits

- Traces go to `/api/v1/otlp/v1/traces`; correlated logs go to `/api/v1/otlp/v1/logs`. Both use the official OTLP HTTP/protobuf exporter with gzip-compressed request bodies and a `hue-sdk-python/<version>` User-Agent ahead of the exporter's own token. The official exporter handles retryable network/service failures; Hue additionally honors 429 and Retry-After within its transport budget. There is no proprietary provider transport.
- Exporter work and its HTTP worker run with OpenTelemetry instrumentation suppressed. Hue ignores records emitted within that suppressed scope, preventing HTTP instrumentation and exporter diagnostics from feeding back into its own queues. Application instrumentation resumes outside that scope. If an OpenTelemetry release ever stops exposing its suppression key, Hue warns once at import and keeps exporting: its own queues still ignore its export work, but OTel HTTP instrumentors could then record Hue's export requests on other exporters.
- Batches initially contain at most 64 records and are split by encoded protobuf size to fit **1 MiB**, both on wire and after decoding. A single oversized record fails visibly through export status. Helper content exceeding **256 KiB** UTF-8 JSON is omitted before enqueue and increments instrumentation failures; it is never silently truncated by Hue. Third-party record validation remains the receiver's responsibility. OTel's own attribute/count/environment limits can still affect externally configured providers.
- Hue accepts at most **2,000 distinct spans per trace**. This is enforced by the receiver across distributed producers; the client cannot guarantee a global count.
- HTTP errors, malformed/non-200 success responses and OTLP `partial_success` rejected counts cause a failed export status. Partial rejection is not retried wholesale. Receiver error text is not echoed. A warning-only partial-success response with zero rejected records remains successful. A request carrying only [live-span placeholders](#live-spans) never fails the status.
- `force_flush(timeout_millis=30000)` drains both processors and returns `False` for a timeout, failed export, dropped record or instrumentation omission since this client was created. Hue's processors honor the shared deadline and serialize drains in a bounded background worker. Pending exports continue after timeout. `export_status` exposes cumulative failure counters. `shutdown()` stops new helpers, drains and closes owned exporters within the caller's wait budget; repeated calls wait for the same shutdown. After a timeout, keep the process alive and call shutdown again to confirm completion. Context-manager exit calls `shutdown_safe(timeout_millis=1000)`; check flush explicitly when an exit code must reflect delivery failure.
- Hue processors use the public OTel interfaces and bound each signal to 2,048 records and 8 MiB of encoded telemetry by default, including in-flight records (`max_queue_size`, `max_queue_bytes`). Dropped records and instrumentation omissions make cumulative `export_status.ok` false. Queue overflow, process termination and sampling can lose telemetry. Flush success reports observed exporter outcomes, not durable local delivery or proof that every application operation was instrumented. The exporter timeout controls individual export/retry operations. A caller timeout does not cancel an HTTP request already in flight; background workers continue until the operation completes.
- A timed-out HTTP worker can retain one encoded request of up to 1 MiB per signal outside the queue counters. Later records remain queued within the configured limits until that worker finishes; shutdown counts any queued records it must discard. Queue bytes are not total process memory.
- A flush timeout releases drain coordination so later flushes can make progress. Both signals share the caller's remaining wait budget, including time spent waiting for another flush. Shutdown's exporter cleanup can continue after the caller returns without holding that coordination lock. Repeated shutdown calls report current failures and drops as well as cleanup completion.

## Live spans

OpenTelemetry exports a span only when it ends, so a long agent turn or model call would otherwise stay invisible until it finishes. When a Hue helper span or an AI span is still open at the export worker's next 0.5 s tick, Hue queues a placeholder: a standard OTLP span whose parent is the running span, with its name, kind, start time and current attributes, an end time of `0`, `hue.span_type = "pending_span"` and `hue.pending_parent_id` (the running span's own parent, omitted for a root). Hue shows the span as running and replaces the placeholder when the finished span arrives. Input set right after entering, such as `set_input`, is included.

The placeholder then waits for the worker's next export like any queued span: up to 0.5 s until the next tick, then the 1 s export delay when nothing else is queued, so it usually reaches Hue within about 1.5 s of its span starting. It goes out sooner when an export is already scheduled, for example because another span has just ended, and at once for 64 queued records or `force_flush()`. It goes out later while an earlier export is still in flight, because the worker runs the next tick and starts the next 1 s delay only after that export returns. A placeholder whose span ends before it is exported is not sent, so a short span may send none and appear in Hue only when it finishes.

- Only spans from `hue.tracer` (every helper) and spans with a `gen_ai.`, `ai.`, `llm.` or `traceloop.` attribute at start, or a name starting with `ai.`, are announced. HTTP, database and other framework spans are not.
- Placeholders follow the same `capture_content` policy as finished spans, so recognized content attributes are stripped from them too when it is `False`. Tool definitions, system instructions and any value over 64 KiB are left out; the finished span still carries them. The markers are written last, and these reserved keys are removed from finished spans.
- Apart from that policy (`capture_content=False` strips recognized content keys) and those omissions, a placeholder carries the running span's attributes as they stand when it is queued. `redactor=` rewrites the value passed to `set_input` or `set_output` before it is set on the span, so placeholders carry the redacted value. Any other sensitive attribute, such as custom metadata or a value recorded by an instrumentor, must be scrubbed where it is recorded: the finished span carries it too, so `live_spans=False` does not keep it from Hue. That option only prevents the placeholder's earlier copy, for example of a value the span overwrites before it ends.
- Placeholders are advisory. At most 1,024 open spans wait to be announced, and each is announced once. A placeholder is queued only while the queue is under a quarter of its record and byte budgets and is skipped silently otherwise, so placeholders use at most a quarter of the queue. While queued they count in `queued_trace_records` and `queued_trace_bytes`, but never as dropped or failed telemetry.
- This needs a Hue deployment that accepts placeholders. It marks every trace acknowledgement with `Hue-Pending-Spans: 1`, and its rejections fail the export status as before. An acknowledgement without the header comes from a generic collector or an older Hue, which rejects placeholders by their zero end time: the SDK credits up to one rejection per placeholder to the placeholders, sets `export_status.live_spans_rejected` (a warning that does not affect `ok`) and stops announcing spans for the rest of that client's life. Further rejections in that response still fail the export status.
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
key), finish before the execution completes, and read the sealed world's evaluator-only evidence.

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
        client.finish_run(
            run["id"], idempotency_key=f"execution:{execution_id}:completed", status="completed"
        )
evidence = client.get_evidence(run["id"], section="ledger")
```

`agent_environment` removes `HUE_API_KEY`, `HUE_MCP_KEY` and any `hue_sk_`, `hue_mcp_` or
`hue_attempt_` value unless `include_hue_credentials=True`, and for one compatibility release also
sets `HUE_MCP_URL`, `HUE_MCP_TOKEN` and `HUE_MCP_EXPIRES_AT` from the first MCP mirror. Nothing
here logs the token. The client waits Hue's `Retry-After` on 429 and 503 before retrying.

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
filename, content type and an optional primary flag. The helper claims the
invocation, verifies files and saves the outcome without automatically rerunning
the agent. See the [managed-run guide](https://docs.hue.run/evaluations/managed-runs)
and [full adapter contract](https://github.com/hue-run/hue-sdk/blob/main/packages/sdk-python/MANAGED_TARGETS.md) for registration, existing-provider
flush callbacks and recovery. Local/CI runners remain available.

## Serving safely

Use `create_hue_safe` for best-effort startup and `enabled=False` for a local kill switch. The safe constructor returns a disabled client and records an instrumentation failure if initialization fails. Disabled helpers execute application work without exporting. Initialize after fork, once per serving process. `force_flush_safe(timeout_millis=1000)` and `shutdown_safe(timeout_millis=1000)` return booleans without raising; monitor those results and `export_status`. Keep strict project validation and receipt/delivery checks out of customer request paths. Never rerun application work to recover telemetry.

Queue bytes bound retained telemetry rather than total RSS. Network waits have a wall-clock caller bound and at most one retained HTTP worker per signal; a stuck OS call can outlive that wait. Arbitrary user hooks and third-party instrumentation retain their own behavior. See [production safety](https://docs.hue.run/guides/production-safety) for lifecycle examples, failure tests and limitations.
