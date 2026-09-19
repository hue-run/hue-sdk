# Source capture

`hue_sdk.capture.CaptureSession` records portable source evidence independently of telemetry `capture_content`. Use a separate `capture_write` key. No capture network calls occur when `source_content=False`.

```python
from hue_sdk.capture import CaptureSession

capture = CaptureSession(
    source_content=True,
    api_key=capture_key,
    external_trace_id=trace_id,
    bindings=[{
        "id": "mail", "kind": "tool", "contractVersion": "1",
        "operations": [{"name": "read_message", "inputSchema": {
            "type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"],
        }}],
    }],
)
message = capture.observe("mail", "read_message", {"id": message_id}, lambda: read_message(message_id))
report = capture.finalize()
```

`observe` wraps a synchronous call; `aobserve` wraps an async call. Both retain live result/error identity and remove known credential fields before buffering. `state_evidence(record)` records a genuine pre-execution snapshot with declared service/account/actor, adapter semantics, supported action definitions, collection coverage and known omissions. `source(record)` attaches source metadata; `upload_source(filename=...,content_type=...,data=...)` explicitly uploads permitted bytes and returns a verified reference or `None`. The custom `redact` callback also applies to source names, URIs and metadata; changes mark the descriptor partial and callback failures record a drop. Raw file bytes are not automatically content-scrubbed. Nothing automatically fetches files, URLs or tool implementations.

`flush()` retains unacknowledged batches for identical retries. `finalize(deadline_seconds=30)` reports `status`, `pending`, `dropped`, the immutable revision/digest, and server omissions. `afinalize()` runs export in a thread for async callers. A finalized capture may remain incomplete; new arrivals can be finalized as another revision. Uncertain finalization retries its exact saved request; a decided conflict allows one fresh barrier within the deadline. When recovering an older accepted revision, newer local evidence is pinned before returning. Pending calls, queue drops, unsupported serialization and redaction are never silently declared complete.

The queue defaults to 8 MiB/2,048 records, with configurable lower bounds and a 4,000-record maximum. At most two explicit uploads run concurrently, each at most 25 MiB. The helpers do not replace model clients, create globals, intercept transport streams, replay tools, or infer missing world state. The [portable protocol](../capture-protocol/README.md) defines common wire records and canonical identity.
