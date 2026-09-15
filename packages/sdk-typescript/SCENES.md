# Scenes: source capture and exact playback

Scenes are optional imports and use an explicit source-content policy. They share your Hue project and can link observations to an existing Hue/OpenTelemetry span. Existing `captureContent`, tracer ownership, and exporter queues are unchanged.

A scene stores source requests, recorded results, source documents, and incomplete observations. A frozen revision supplies those results to selected dependencies while the agent's model, reasoning, and transforms continue running. Playback matches recorded requests; it does not answer new queries against a document index.

## Capture selected source tools

```typescript
import { createHue } from "@hue/sdk";
import { ScenesClient, CaptureSession, wrapTool } from "@hue/sdk/scenes";

const hue = createHue({
  apiKey: process.env.HUE_API_KEY!,
  serviceName: "research-agent",
  captureContent: false,
});
const scenes = new ScenesClient({
  apiKey: process.env.HUE_API_KEY!,
  capture: true,
  hue,
  onIssue: ({ kind, count }) => console.error({ kind, count }),
});
const search = wrapTool("documents", "search", liveDocumentSearch);

const pin = await hue.withSpan("research", async () => {
  const capture = await CaptureSession.create(scenes, {
    bindings: [
      {
        id: "documents",
        kind: "tool",
        contractVersion: "1",
        operations: [
          {
            name: "search",
            description: "Search source documents",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
            },
          },
        ],
      },
    ],
  });
  await capture.source({
    id: "query-attachment",
    relation: "query_attachment",
    name: "brief.pdf",
    mimeType: "application/pdf",
    bytes: uploadedSourceBytes,
  });
  await capture.run(() => runAgent({ search }));
  return capture.finalize();
});
```

`liveDocumentSearch`, `uploadedSourceBytes`, and `runAgent` above are your application's dependencies. Without a Hue context, supply the existing trace's 32-character hexadecimal `externalTraceId` to `CaptureSession.create`. Sources may also specify `uri`, `callId`, or a verified artifact `reference`. A URI without bytes is a reference only and is never downloaded automatically. Register original query attachments and retrieved source documents; do not register generated output documents.

Creating a scene and finalizing it are explicit API operations and may fail. Once started, capture failures, queue overflow, unsupported values, and collector outages preserve the original function results and exceptions. `flush()` reports `{pending,dropped}`. `finalize()` drains for at most 30 seconds by default, then requests an immutable revision that retains pending/incomplete evidence. A later successful finalization may create a newer revision. Production replay should use a complete revision.

## Playback

```typescript
import { loadPlayback, SnapshotMissError } from "@hue/sdk/scenes";

const playback = await loadPlayback(scenes, pin, ["documents"]);
try {
  await playback.run(() => runAgent({ search }));
  await playback.complete();
} catch (error) {
  await playback.complete("failed");
  if (error instanceof SnapshotMissError) console.error(error.reason);
  throw error;
}
```

The pin contains `sceneId`, `revision`, and the SHA-256 digest of the canonical manifest. Loading verifies the manifest and artifact length/hash before results are available. Selected tools never invoke their live implementations, including on misses. Unselected functions remain live. Recording and playback use async scope, so parallel agents have independent contexts.

Matching uses binding ID, operation, contract version, and credential-sanitized canonical JSON arguments. Use distinct binding IDs for distinct accounts; `accountScope` documents their identity. Bump `contractVersion` when a tool's meaning or schema changes. Tool wrappers expect version `1` by default; set `ToolOptions.contractVersion` to the current contract when registering another version (also available in `wrapAiTools` and `wrapMcpClient` options). A different snapshot version produces an `incompatible` miss. The wrapper uses its single argument, or an array for multiple arguments; pass an `argsOf` callback to select semantic arguments.

Repeated requests consume recordings in start order. Independent request keys can reorder. Exhaustion is a miss. Overlapping identical requests with different outcomes are ambiguous and cannot replay. Selecting both an observed ancestor and descendant binding is rejected; an outer mock bypasses its children. Source writes may only be selected deliberately: mocked writes have no live side effects.

`SnapshotMissError` exposes `code: 'HUE_SNAPSHOT_MISS'` and `reason` (`unrecorded`, `exhausted`, `incompatible`, `ambiguous`, `incomplete`, `unavailable_content`, `nonportable`, `overlapping_bindings`, or `integrity`). Unknown original function exceptions become `RecordedToolError`; exception text is omitted from capture. HTTP error statuses and MCP `isError` results remain recorded results.

Native `async` functions retain Promise behavior. For ordinary functions that return Promises, declare it explicitly:

```typescript
const source = wrapTool("documents", "search", liveSource, (input) => input, {
  resultMode: "promise",
});
```

Completed async iterables replay item order and binary items. Unconsumed, cancelled, throwing, oversized, redacted, or unsupported streams miss. Generator return values and bidirectional iterator interaction are not portable. Timing, chunk boundaries, original exception classes, and object prototypes are not reproduced.

## Adapters

```typescript
import { wrapAiTools, wrapMcpClient, wrapFetch } from "@hue/sdk/scenes";
import { installNodeHttpCapture } from "@hue/sdk/scenes/node";

const tools = wrapAiTools("documents", sourceTools);
const mcp = wrapMcpClient("source-mcp", connectedMcpClient);
const sourceFetch = wrapFetch(fetch);
const nativeHttp = installNodeHttpCapture();
// Execute capture.run(...) or playback.run(...).
nativeHttp.dispose();
```

`wrapAiTools` wraps only `execute`, retaining the tool definition and execution options. It does not wrap a model or `toModelOutput`. MCP wraps `callTool`, `readResource`, and source listing methods on a connected client, preserving `this` and schemas supplied in the binding. Tool operations use `tools/call:<name>`; resources use `resources/read`. MCP continuation, sampling, elicitation, notifications, and subscription sessions are not replayed. Embedded resource bytes/text are associated as source artifacts; external URLs remain references.

For HTTP register an origin and path prefix:

```typescript
const binding = {
  id: "files-api",
  kind: "http" as const,
  contractVersion: "1",
  http: {
    origin: "https://files.example.com",
    pathPrefix: "/api/",
    headers: ["x-source-version"],
  },
};
```

Every request in the selected origin/path scope is owned, including changed methods and unknown paths under the prefix. Misses have no upstream fallback. Keys preserve query ordering/repeated keys, include method, body digest, and semantic headers. JSON request bodies use canonical JSON; other supported bodies use exact bytes. Standard semantic headers are `accept`, `content-type`, `range`, `if-match`, `if-none-match`, `if-modified-since`, `if-unmodified-since`, and `if-range`; configured names add to them. Credential headers, credential query fields, and common credential-named JSON fields are removed before queuing. An output that requires redaction is ineligible. This filter cannot identify every secret embedded in arbitrary text or binary files; register only intended sources.

The fetch adapter accepts buffered `RequestInit` bodies (strings, bytes, blobs, URL search parameters). A `Request` with an existing body, multipart bodies, and streaming request bodies are ineligible; their live requests still work. Enclose unsupported client operations in a source tool wrapper. Fetch capture follows response consumption without a clone branch or eager drain. HTTP replay returns a readable body; consumed PDF/DOCX/PPTX and attachment responses are associated as source documents, with 206 responses marked partial.

The optional Node interceptor covers `http`/`https` and Axios's native HTTP adapter, including cached request functions. Fixed-length request bodies are supported; chunked/multipart/streaming requests are ineligible. Response observation uses native `IncomingMessage` backpressure, with no independent response reader. Install once and dispose after all scoped work has finished. Raw sockets, HTTP/2, other processes, service workers, and arbitrary transports are not universal hook surfaces. Use injected fetch or an enclosing registered tool for clients outside supported surfaces. Interceptors installed by other libraries may conflict and should be validated in the host application.

## Local MCP process

Install the SDK archive, set `HUE_API_KEY` (and `HUE_BASE_URL` for a preview), and launch:

```bash
hue-scenes-mcp --scene SCENE_ID --revision 1 --digest MANIFEST_SHA256 --binding documents
```

Use one process per selected source namespace. The CLI preserves declared tool names, descriptions, and input schemas. Original MCP results retain their content envelope; ordinary function results receive a JSON text envelope and bytes receive an embedded resource envelope. Function streams cannot be served through this JSON MCP surface. HTTP-only namespaces are rejected: their requests have no original MCP tool names. Point the agent's MCP configuration at this command; its model still runs in the agent. Python MCP clients can connect to the same stdio process. Stdout carries MCP messages only; startup/reporting errors go to stderr without keys or payloads.

## Limits

Capture queues are in memory, bounded per `ScenesClient` to 64 MiB and 2,048 records; uploads have at most two concurrent transfers. Inline payloads are capped at 256 KiB, artifacts at 25 MiB, metadata API requests at 1 MiB, and a capture at 2,000 calls. Oversized or unsupported data remains incomplete evidence. Replay preloading is bounded to 64 MiB of selected response payloads. `onIssue` reports counts without captured content. Replay diagnostics are capped at 4,000 events; inspect `playback.diagnostics` for `droppedEvents` and `deliveryOk` if that bound is reached. Await lifecycle operations before exiting; queued work is not durable across process termination.
