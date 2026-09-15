# Hue Python SDK

For explicit source-document snapshots, scoped HTTP/MCP capture and pinned playback, see [Scenes](SCENES.md).

For frozen datasets, local experiments, custom scorers, durable retries and historical rescoring, see [Local evaluations](EVALUATIONS.md) and the [standalone evaluation example](../../examples/python-evaluation/README.md).

Python helpers around official OpenTelemetry **1.44.0** trace and log SDKs and OTLP HTTP/protobuf exporters. Provider requests run in your application. This package does not proxy model calls or configure global OTel providers.

The distribution is named `hue-sdk` (`import hue_sdk`). Python 3.10+ is supported by the package contract; recorded validation below identifies the tested runtime.

## Install

> PyPI installs are coming soon. During the private pilot, use the release archive below.

### Registry install (coming soon)

```bash
pip install hue-sdk
```

### Private release (available now)

Use the GitHub CLI authenticated to an account with access to `hue-run/hue-sdk`. In your application directory, activate a Python 3.10+ environment, then run:

```bash
gh release download python-v0.1.0.dev0 --repo hue-run/hue-sdk --pattern 'hue_sdk-0.1.0.dev0-py3-none-any.whl' --dir .hue-sdk/python
pip install ./.hue-sdk/python/hue_sdk-0.1.0.dev0-py3-none-any.whl
```

### Build from a checkout

From the repository root:

```sh
uv build packages/sdk-python --out-dir .local/python-sdk-dist
uv venv .local/python-sdk-consumer --python 3.14
uv pip install --python .local/python-sdk-consumer/bin/python .local/python-sdk-dist/hue_sdk-0.1.0.dev0-py3-none-any.whl
```

## Send a trace

In the consuming application, use only public imports:

```python
import os
from hue_sdk import Hue

with Hue(
    os.environ["HUE_BASE_URL"],
    os.environ["HUE_API_KEY"],
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

`base_url` is the Hue origin, such as `https://app.hue.run`, without an API suffix. The project service key determines the project. The SDK validates the project at `GET /api/v1/projects/current` when explicitly requested; construction itself does not perform a request. HTTP is permitted only for `localhost` and loopback IPs. Userinfo, query strings, fragments, paths and redirects are rejected. The key is sent only as `Authorization: Bearer …`; `repr(hue)`, SDK errors and status counters omit it.

## Content and semantic fields

`capture_content` has no default. `False` makes `set_input`, `set_output` and inference-log bodies omit content before it reaches an OTel queue. Explicit JSON null, empty strings and absent content stay distinct when capture is enabled. Exception recording includes the exception type and ERROR status; exception messages and stacks are always excluded by these helpers.

This setting is **not a blanket PII filter**. Custom attributes, span names, session/user identifiers, resource attributes, third-party instrumentors and other exporters remain under your control. The server stores received content; there is no automatic telemetry expiry in the pilot. Delete scoped data explicitly when required by your retention policy.

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

An instrumentor that accepts `tracer_provider` can receive `hue.tracer_provider`; follow that instrumentor's own capture/redaction configuration. OpenInference and other OTel instrumentors are optional dependencies, not implicitly enabled. They can emit content even when Hue helper capture is disabled. The optional compatibility group pins **OpenAI 3.14.0**, **OpenInference OpenAI 0.1.60** and its resolved **OpenInference instrumentation 0.1.63**. A synthetic HTTP streaming response verifies parentage, canonical model/usage attributes and enabled/disabled message capture with `TraceConfig(enable_genai_semconv=True, hide_inputs=..., hide_outputs=..., hide_input_messages=..., hide_output_messages=...)`. This is a tested adapter combination, not a claim about all OpenAI APIs or live-provider compatibility. See the [instrumentor's official source](https://github.com/Arize-ai/openinference/tree/main/python/instrumentation/openinference-instrumentation-openai). The [standalone example](../../examples/python-agent/README.md) contains a separate, optional direct official OpenAI-client path.

## Export behavior and limits

- Traces go to `/api/v1/otlp/v1/traces`; correlated logs go to `/api/v1/otlp/v1/logs`. Both use the official OTLP HTTP/protobuf exporter, uncompressed. The official retry policy remains active for retryable network/service failures. There is no proprietary provider transport.
- Batches initially contain at most 64 records and are split by encoded protobuf size to fit **1 MiB**, both on wire and after decoding. A single oversized record fails visibly through export status. Helper content exceeding **256 KiB** UTF-8 JSON raises before enqueue; it is never silently truncated by Hue. Third-party record validation remains the receiver's responsibility. OTel's own attribute/count/environment limits can still affect externally configured providers.
- Hue accepts at most **2,000 distinct spans per trace**. This is enforced by the receiver across distributed producers; the client cannot guarantee a global count.
- HTTP errors, malformed/non-200 success responses and OTLP `partial_success` rejected counts cause a failed export status. Partial rejection is not retried wholesale. Receiver error text is not echoed. A warning-only partial-success response with zero rejected records remains successful.
- `force_flush(timeout_millis=30000)` drains both processors and returns `False` for a timeout or any recorded failed export batch since this client was created. Because OTel 1.44 ignores its processor timeout, Hue serializes flushes in one background worker and bounds the caller's wait. Pending exports continue after timeout. `export_status` exposes cumulative failure counters. `shutdown()` stops new helpers, drains and closes owned exporters within the caller's wait budget; repeated calls wait for the same shutdown. After a timeout, keep the process alive and call shutdown again to confirm completion. Context-manager exit calls shutdown; check flush explicitly when an exit code must reflect delivery failure.
- Standard OTel batch queues hold 2,048 records per signal and are in-memory. Queue overflow, process termination and sampling can lose telemetry. Flush success reports observed exporter outcomes, not durable local delivery or proof that every application operation was instrumented. The exporter timeout controls individual export/retry operations. A caller timeout does not cancel an HTTP request already in flight; background workers continue until the operation completes.

## Validate locally

```sh
cd packages/sdk-python
uv sync --frozen --all-groups --python 3.14
uv run --frozen --all-groups pytest
uv run --frozen --all-groups ruff check src tests ../../examples/python-agent ../../examples/python-evaluation
uv run --frozen --all-groups python -m build --no-isolation
```

Tests decode requests received over real local HTTP into the official OTLP protobuf types. They cover correlation, capture disabled, null/empty content, redaction failure, propagation, borrowed providers, endpoint/auth failures, redirects, partial rejection, retry and encoded request limits. The wheel acceptance test runs the standalone app under a separate interpreter with no source-path imports. No real Hue or model-provider account is needed.

Standalone extraction verification: **59 tests passed on both Python 3.10.21 and Python 3.14.5**, including optional adapter cases, local evaluation recovery, and installed-wheel application runs. These tests use synthetic loopback HTTP endpoints; they do not create project keys, access a Hue account, or call live model providers.
