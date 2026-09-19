# Run an existing agent from Hue

`hue_sdk.managed` adapts a synchronous Python function to Hue's managed evaluation
protocol. Hue dispatches a frozen case; your application keeps its model, tools
and OpenTelemetry providers. The helper never installs or replaces global providers.

```python
from hue_sdk.managed import ManagedTargetHandler, ManagedTargetResult, ManagedOutputFile


def target(invocation):
    result = existing_agent(
        invocation.input,
        config=invocation.config,
        files=invocation.input_files,  # verified bytes and original metadata
        cancelled=invocation.cancelled,
        deadline=invocation.deadline_monotonic,
    )
    return ManagedTargetResult(
        output={"text": result.text},
        files=tuple(
            ManagedOutputFile(
                filename=file.name,
                content_type=file.content_type,
                data=file.bytes,
                primary=file.is_primary,
            )
            for file in result.files
        ),
    )


handler = ManagedTargetHandler(
    machine_credential=server_secret,
    target=target,
    tracer=existing_tracer_provider.get_tracer("my-agent"),
    flush_telemetry=flush_existing_traces_and_logs,
)
# Inside your framework's protected POST route:
response = handler.handle(request_body_bytes, request_headers)
# Return response.body as JSON, with response.status_code and response.headers.
```

The example uses application-owned agent, provider and flush functions. Flush
must raise if either trace or log delivery failed, or return `False`. The handler
recognizes an explicit `False` from a provider's `force_flush`; when combining
multiple providers, check every boolean result and raise if any failed. Hue exporters provide their
own acknowledgement-aware flush API. Never shut down a shared provider per request.

Use a host request limit of at least 120 seconds for the defaults: 90 seconds for
the callback and a separate 30-second finalization allowance. The callback runs
in a daemon thread with the active span context. It must honor `cancelled` and
`deadline_monotonic`; Python cannot forcibly stop an uncooperative thread. An
unresolved callback deadline returns uncertain, without inventing a terminal result.
The host should bound inbound request reading before calling `handle`.

## Delivery and recovery

The helper validates machine authentication before network calls, then claims the
assigned execution using `X-Hue-Invocation-Token`. A duplicate claim returns HTTP
409 without invoking the target. A lost claim response is uncertain. The configured
`base_url` defaults to `https://app.hue.run`; request-supplied callback URLs are
rejected. Redirects and environment/netrc credentials are disabled for callbacks.

Declared input files are downloaded only through the scoped Hue endpoint and
verified against their byte size and SHA-256. The callback receives bytes and
metadata; credentials never enter its context or telemetry attributes. The helper
creates a real `ai.managed_target` span under the supplied W3C context with the
existing recording provider. Its own span contains no prompt/output content.

Returned `bytes` are uploaded with stable idempotency keys, including valid
secondary files on an error result. Ready reservations are reused. Signed upload
URLs receive only the permitted content-type/private-access headers, never either
invocation credential. Files are limited to 16, 25 MiB each and 64 MiB total.
Output JSON is bounded; omitted output means unavailable while `None` means JSON
null. At most one file may be primary. Return only safe public error summaries,
never raw provider errors, stack traces or credentials.

The span ends before the outcome is checkpointed. The helper then flushes traces
and logs and checkpoints a telemetry acknowledgement. HTTP 200 returns
`{protocolVersion:1,executionId,state:"checkpointed",telemetry:"flushed"|"pending"}`.
A failed flush or lost acknowledgement preserves the saved outcome as telemetry
pending. Hue independently verifies evidence before completing the experiment.

Signed file PUTs make one attempt and never follow redirects. If their acknowledgement
is lost, Hue's completion callback verifies the stored bytes before accepting the file.
Identical idempotent reservation/completion/checkpoint/telemetry callbacks retry at most
once within the deadline.
The agent never retries automatically. HTTP 503 `uncertain` means inspect Hue's
saved execution before explicitly authorizing another attempt. The helper does
not promise exactly-once execution across crashes or resume a lost callback.
Protect/rate-limit the endpoint at your host and keep the dedicated machine
credential separate from telemetry/project API credentials.
