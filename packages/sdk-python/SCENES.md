# Source snapshots and playback

`hue_sdk.scenes` captures explicitly selected source calls and the documents they observed. A frozen revision can later return those recorded results for the same requests. Unrecorded requests raise `SnapshotMissError`; selected calls never fall back to a live system. Model calls, reasoning, transformations and output generation stay in your application.

The module is separate from tracing. It does not modify global OpenTelemetry providers, clients, sockets or environment variables. Importing `hue_sdk` does not enable Scenes. Python 3.10+ is supported. HTTPX adapters require the optional `scenes` extra; Requests is already an SDK dependency.

```sh
# Private pilot: use your downloaded release wheel, including the optional HTTPX adapter.
pip install './hue_sdk-0.1.0.dev0-py3-none-any.whl[scenes]'
```

## Capture an observed source

```python
from hue_sdk import Hue
from hue_sdk.scenes import Binding, Scenes, SourceFile

# These two content policies are independent and both are explicit.
hue = Hue(base_url, project_key, capture_content=False)
scenes = Scenes(base_url, project_key, capture_content=True)

@scenes.tool("documents", "read_document", contract_version="1")
def read_document(document_id):
    return your_existing_document_client.read(document_id)

with hue.span("agent.run") as run:
    with scenes.capture(
        bindings=[Binding("documents", contract_version="1")],
        external_trace_id=run.trace_id,
        input={"question": "Summarize the observed document."},
    ) as capture:
        document = read_document("doc-42")
        # Register only source bytes actually observed by this run.
        capture.add_source(SourceFile(
            "query-attachment.pdf", observed_pdf_bytes, "application/pdf"
        ))
        answer = your_live_model(document)

finalized = capture.finalize(timeout=30)
if not finalized.ok:
    # Keep the process alive and retry finalization; inspect error/pending/dropped.
    raise RuntimeError("The snapshot was not finalized.")
snapshot = finalized.snapshot
```

Leaving a capture context only restores context; explicit `finalize()` exports records and freezes the revision. `async with`, `await capture.afinalize()` and `await scenes.aload(snapshot)` are available. An omitted `external_trace_id` inherits a valid current OTel span; capture does not manufacture one. Observations also retain the current span ID for trace links. This identifies the source call, without claiming its result reached the model.

`@scenes.tool` supports sync functions, coroutine functions and pull-only async item streams. Its default request arguments are the function's named parameters with defaults applied. Pass `arguments=lambda ...: portable_json` when adapting a framework signature. `scenes.call(binding_id, operation, arguments, live_callable)` and `await scenes.acall(...)` expose the same behavior without decorators. Supply `contract_version` on these helpers when using a version other than `"1"`. Bump the binding and wrapper contract version when the portable operation contract changes.

For an operation shared with TypeScript, register the same semantic argument object: a Python `search(q)` naturally records `{"q": q}`; a Python `search(input)` taking that whole object should use `arguments=lambda input: input`. Framework invocation IDs and Python's incidental parameter names should not become cross-language operation arguments.

Only JSON, explicit `bytes`, the `ABSENT` sentinel, HTTP bodies, and pull-only async item streams are supported. JSON null (`None`), absence and empty bytes remain distinct. Arbitrary classes, pickle, closures, unsafe integers and nonfinite numbers are rejected for recording. A tool's `serializer` argument on `call`/`acall` can explicitly convert a known framework result into portable JSON; replay then returns that representation. Live calls always return their original values and raise their original exception objects, including cancellation. Recorded exceptions become `RecordedToolError` with the original type name; exception messages and stacks are omitted.

## Replay a pinned revision

```python
from hue_sdk.scenes import SnapshotMissError

recording = scenes.load(snapshot)  # Verifies schema, revision identity and SHA-256 digest.
with hue.span("agent.replay") as replay_run:
    with recording.replay(
        binding_ids=["documents"], external_trace_id=replay_run.trace_id
    ) as replay:
        document = read_document("doc-42")  # Recorded content; implementation is bypassed.
        answer = your_changed_live_model(document)
        try:
            read_document("unobserved-document")
        except SnapshotMissError as miss:
            print(miss.reason)  # unrecorded; still included in replay diagnostics.

if not replay.delivery_ok:
    replay.complete()  # Retry acknowledgements; never reruns application calls.
```

Every replay reserves a fresh trace ID and fresh occurrence cursors. Matching uses SHA-256 of canonical JSON containing the binding ID, operation, contract version and sanitized arguments. Repeated identical requests consume recorded occurrences in start order; distinct requests may reorder. Overlapping identical calls with different results, or differently ordered outcomes from independent producers, are ambiguous and miss. An outer recorded tool bypasses its implementation and nested children. Selecting both a recorded ancestor and its descendant is rejected.

Playback checks each artifact's full size and SHA-256 before exposing its content. A missing, modified, unsupported or incomplete result causes a miss. `Recording(manifest, digest, artifact_loader=...)` also supports explicitly supplied local recordings; a custom loader must return bytes and receives no project credential. `recording.manifest` and binding selections return copies; modifying them cannot alter the frozen recording or active selection. Large content is fetched on demand, so access is rechecked by the hosted API. Bytes already downloaded locally cannot be recalled.

Use `recording.download_source(source_id)` or `await recording.adownload_source(source_id)` to retrieve an explicitly recorded source with the same full verification. Reference-only sources remain unavailable. Always inspect the source's `content` state when using partial observations.

## Scoped HTTP and MCP

```python
import httpx
import requests
from hue_sdk.scenes.httpx import SceneTransport, AsyncSceneTransport
from hue_sdk.scenes.requests import SceneAdapter
from hue_sdk.scenes.mcp import SceneMCPClient

http_binding = Binding("source-http", kind="http",
                       http_origin="https://documents.example", path_prefix="/files/",
                       headers=("x-source-version",))
http = httpx.Client(transport=SceneTransport(scenes))
async_http = httpx.AsyncClient(transport=AsyncSceneTransport(scenes))
session = requests.Session()
session.mount("https://", SceneAdapter(scenes))
mcp = SceneMCPClient(scenes, "source-mcp", your_initialized_mcp_session)
```

Include the corresponding `Binding` in capture, then select its ID for playback. HTTP ownership is the normalized origin plus path prefix. A new method or request inside a selected scope misses; a request outside that scope stays live. Headers affecting representation—including `Accept`, `Content-Type`, range and conditional headers—always participate, with configured extra headers added. JSON request bodies use canonical JSON for their digest; other supported bodies use exact bytes. Query order and repeated values are preserved. Streamed/multipart request bodies are ineligible for replay. HTTP status errors remain recorded responses.

The JSON body rule applies to `application/json` and valid `type/subtype+json` media types, ignoring case and media-type parameters. These bodies require strict UTF-8, with an optional leading UTF-8 BOM. Invalid JSON, nonfinite/unsafe numbers and UTF-16/UTF-32 JSON become ineligible; they never silently fall back to raw-body matching. An empty request body keeps the empty-byte digest.

The HTTP transports observe response bytes only as the caller reads them, preserving streaming, gzip and close behavior. An early close records incomplete content. Requests' standard `.content`, `.iter_content()` and `.raw.read()` paths are supported. Other raw reader methods may yield incomplete capture. Bodies exceeding limits are omitted without interrupting the consumer. Hue's own traffic cannot be selected as an HTTP source. HTTP scope interception uses only these explicitly injected clients; it does not cover arbitrary networking or subprocesses.

Consumed PDF, DOCX, PPTX and attachment responses are automatically linked as source files. HEAD responses retain file metadata without manufacturing a document body. Requests playback supports bounded gzip/deflate decoding of shared raw HTTP recordings; unsupported content encodings miss explicitly. Credential-bearing JSON response bodies, including supported compressed JSON, are ineligible and are omitted from the capture queue. Replay diagnoses partial-stream failures without turning them into complete recorded errors.

The MCP wrapper supports tool calls, resource reads and tools/resources/resource-template listings. Capture returns the original MCP result object. Playback returns its portable dictionary; provide `result_decoder(operation, payload)` if the consuming framework requires its SDK result class. Misses are MCP `isError` results containing `HUE_SNAPSHOT_MISS`. The wrapper owns no connection lifecycle and does not implement sampling, elicitation or the stdio server. The interoperable local stdio server is supplied by the TypeScript Scenes SDK.

Embedded MCP resources are linked as sources from their observed text or bytes. Pass `contract_version` to `SceneMCPClient` for a binding contract other than `"1"`.

## Source files, content policy and delivery

`SourceFile(data=...)` registers explicitly supplied source bytes; `SourceFile.from_path(path)` reads only that explicit local file. A URI by itself is a reference and is never fetched automatically. Relations are `query_attachment` and `tool_source`; `sources=lambda result: [...]` on a tool links extracted source files to the observed call. Generated output documents are outside this feature.

The default credential filter removes common authorization, cookie, password, API-key, token and signed-URL credential fields before buffering. Generic document/object `key` fields remain meaningful arguments. A `sanitizer(field, value)` callback can apply your additional policy; bytes require an explicit byte-aware sanitizer. Source content is intentionally retained and is not automatically stripped of personal information. If sanitization changes a result, that result becomes replay-ineligible; sanitized inspection content may still be preserved. Capture records `capturePolicy={sourceContent:true, redactionVersion:"1"}`.

Capture buffering is bounded per Scenes client: 64 MiB of unsent payloads and 2,048 records by default, with at most two simultaneous uploads. Individual inline payloads are at most 256 KiB and artifacts at most 25 MiB. Oversized metadata or unsupported content records an omission. A capture cannot retain more than 2,000 calls. Queue overflow increments dropped counts; export and policy failures never substitute for a live return or exception.

`finalize()` has a 30-second default caller deadline. A timed-out export continues in one background worker; retry to obtain its result. Failed acknowledgements retain stable record idempotency keys. Pending streams are visible in the frozen revision; later arrivals can produce a new revision without changing earlier pins. `FinalizeResult.ok` means finalization was acknowledged, not that coverage is complete: inspect `pending` and `dropped`. Queues are in-memory; process termination can lose unexported data. Replays deliver caught misses and wait for in-flight dispatches before completing; inspect `delivery_ok` and retry `complete()` after a transport failure.

Replay diagnostics retain at most 4,000 events. Overflow increments `dropped_events` and makes `delivery_ok` false; discarded events cannot be recovered by retrying completion. Finalized captures refresh an updated capture revision after a concurrent producer causes a conflict, with at most three attempts. Repeating finalization without new observations returns the same acknowledged pin.

Pilot data has no automatic retention timer; project erasure is explicit. Rendering previews is a hosted viewer concern and does not change the original source or replay bytes. The runnable [synthetic example](examples/scenes/main.py) exercises observed source documents, large artifact upload/download, scoped HTTP, exact playback and a caught miss from an installed wheel.
