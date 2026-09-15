# Hue TypeScript SDK

A Node 24 / Bun 1.3.9 client for Hue's standard OTLP HTTP endpoints. It uses the
OpenTelemetry JavaScript SDK and official OTLP protobuf exporter components for
traces and correlated logs. The package is named `@hue/sdk`.

## Install

> npm installs are coming soon. During the private pilot, use the release archive below.

### Registry install (coming soon)

```bash
npm install @hue/sdk
```

### Private release (available now)

Use the GitHub CLI authenticated to an account with access to `hue-run/hue-sdk`:

```bash
gh release download typescript-v0.1.1 --repo hue-run/hue-sdk --pattern 'hue-sdk-0.1.1.tgz' --dir .hue-sdk/typescript
npm install ./.hue-sdk/typescript/hue-sdk-0.1.1.tgz @opentelemetry/api@1.9.1
```

Run these commands in your application directory. The [release guide](../../RELEASING.md#public-release) tracks registry ownership and publication; the GitHub repository can remain private.

## Start

```ts
import { createHue, HueExportError } from "@hue/sdk";

const hue = createHue({
  apiKey: process.env.HUE_API_KEY!, // a project service key, on the server only
  serviceName: "my-agent",
  captureContent: false, // required: explicitly choose true or false
  // baseUrl: "http://localhost:3000", // default: https://app.hue.run
  onExportIssue: (issue) => console.error(issue), // sanitized counts, never server bodies
});

await hue.checkConnection(); // GET /api/v1/projects/current
await hue.withSpan(
  "chat",
  async (span) => {
    const output = await hue.tool("uppercase", "hello", () => "hello".toUpperCase());
    span.setOutput(output);
    hue.recordMessages({ output: [{ role: "assistant", content: output }] });
  },
  { sessionId: "session-123", userId: "user-123", input: "hello" },
);

try {
  await hue.flush(); // await both traces and logs; don't discard this promise
} catch (error) {
  if (error instanceof HueExportError) console.error(error.issues, error.report);
}
await hue.shutdown(); // flushes and releases providers owned by this client
```

Data goes to `/api/v1/otlp/v1/traces` and `/api/v1/otlp/v1/logs` with a Bearer project
key. `baseUrl` must be an origin without an API path; a trailing slash is accepted.
HTTPS is required except for loopback HTTP. Redirects are refused for both
project checks and exports. There is no proprietary tracing protocol, lab API
wrapper, database dependency, or dependency on the Hue application workspace.

## Vercel AI SDK 7

Compatible optional peers are `ai@^7.0.99` and `@ai-sdk/otel@^1.0.99`, alongside
`@opentelemetry/api@1.9.1`. Configure telemetry on each agent or generation call:

```ts
import { ToolLoopAgent } from "ai";
import { hueTelemetry } from "@hue/sdk/ai-sdk";

const agent = new ToolLoopAgent({
  model: process.env.AI_MODEL!, // actual configured AI Gateway provider/model
  telemetry: hueTelemetry(hue),
});
await hue.withSpan(
  "chat",
  async (span) => {
    const result = await agent.stream({ prompt: "Hello" });
    // Consume the stream inside the span's callback so completion/error timing is correct.
    for await (const text of result.textStream) process.stdout.write(text);
    span.setOutput(await result.text);
  },
  { sessionId: "session-123" },
);
await hue.flush();
```

The integration creates real Vercel provider, streaming and tool spans and passes
`recordInputs` and `recordOutputs` explicitly. It doesn't register global AI SDK
integrations. The installed-package verification tests the matching 7.0.99/1.0.99 and
7.0.100/1.0.100 pairs. Compatible-major ranges do not mean every later release
has been verified. Other OTel
instrumentations can use `hue.tracer` directly or explicitly attach the processors
below. Instrumentations that only use a global provider need your application's
normal OTel setup; Hue does not silently replace it.

## Privacy and content

`captureContent: false` disables manual input/output/messages/tool content and
removes recognized GenAI, Vercel, OpenInference and OpenLLMetry content attributes,
legacy GenAI content events, log bodies, status messages and exception text before
export. Model/provider/token metadata remains available. Generic custom attribute
names cannot be classified automatically; use them deliberately.

`captureContent: true` captures supplied content. Accepted content is stored by Hue;
there is no SDK retention timer or automatic content expiry. To redact strings
before export, supply `redact(value, path)`; it applies to supported strings in
attributes, resources, event/link attributes and log bodies. Return a string.
A throwing callback or invalid/oversized content fails closed: that record is
counted as failed and the flush reports it. Shared resources are redacted once per
export batch. Do not put user content or secrets in span names or scope names.

Manual helpers encode JSON values without converting null into absence. Unknown
outputs and usage remain absent. This SDK does not estimate tokens or cost. Error
helpers mark span status and record an exception; thrown application errors remain
errors and are rethrown unchanged. `withSpan` ends its span in `finally`.

## Existing OpenTelemetry providers

Attach processors while constructing your providers. Hue uses local async context
for its own helpers and never registers/replaces the global tracer, logger, or
context manager.

```ts
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import { createHue, createHueTransport } from "@hue/sdk";

const transport = createHueTransport({
  apiKey: process.env.HUE_API_KEY!,
  serviceName: "existing-app",
  captureContent: false,
});
const tracerProvider = new TracerProvider({ spanProcessors: [transport.spanProcessor] });
const loggerProvider = new LoggerProvider({ processors: [transport.logRecordProcessor] });
const hue = createHue({ transport, tracerProvider, loggerProvider });
// Your application owns and configures these providers and their resources.
await hue.shutdown(); // flushes; does not shut down these externally owned providers
// During application shutdown, shut down your providers, then await transport.shutdown().
```

For external parent context pass `parentContext` to `withSpan`, or use standard
OTel context propagation in your application. `getContext()` exposes the helper's
current context for APIs taking an explicit context. Session/user identifiers are
inherited within a client callback. Separate requests require separate callbacks.

## Delivery behavior

Exports use official OTel retry handling for temporary HTTP/network failures. Each
request is limited to 1 MiB before gzip (with space reserved for gzip overhead) and each content value to 256 KiB. Batches
split at record boundaries. Each signal queues at most 2,048 records, including
exports in flight; overflow is reported through the callback, counters and next
flush. This is an in-memory queue, not durable storage.

`flush()` waits for the current trace and log export work. A partial rejection,
invalid acknowledgement, queue drop or failure throws `HueExportError`; its
`report` contains cumulative accepted/rejected/failed/pending counts. Accepted
means the collector acknowledged receipt, not that a complete trace has arrived.
A malformed response reports uncertain acceptance as failure. Partial successes
are not retried. Warning-only acknowledgements with zero rejected records remain
successful; the callback and issue history expose a sanitized warning. The next
non-overlapping flush reports new failures; overlapping callers also observe failures
from their shared in-flight work. Counters remain cumulative and `transport.getIssues()`
keeps the latest 128 sanitized issues. Each concurrent caller receives a fresh serialized
drain, including records emitted before its call. Stop request production
before shutdown so late spans cannot race it. A client does not own instrumented
operations still running in the application.

## Package verification

From the repository root with Node 24 and Bun 1.3.9 on PATH:

```sh
node packages/sdk-typescript/scripts/verify-package.mjs
```

This copies the SDK to a temporary directory, performs a frozen installation,
builds and packs it, installs the tarball into a separate consumer, runs the real
HTTP exporter suite against that installed package, and installs/builds the
standalone reference chatbot. It prints the artifact paths. No package is
published. The chatbot README describes running that external installation.

# Local evaluation workflows

The optional `@hue/sdk/evals` entry point supports dataset/scorer registration, frozen-version experiments, local built-in/custom scoring, upload resume, and historical rescoring. See [EVALUATIONS.md](./EVALUATIONS.md) for the complete journey, content policy and checkpoint recovery contract.

## Source snapshots

The optional [`@hue/sdk/scenes` module](./SCENES.md) records selected source tools, MCP calls, and scoped HTTP requests for exact local playback. Models and transforms remain live.
