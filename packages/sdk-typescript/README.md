# Hue TypeScript SDK

A client for Hue's standard OTLP HTTP endpoints on Node.js 22 or 24 and Bun 1.4.2. It uses the
OpenTelemetry JavaScript SDK and official OTLP protobuf exporter components for
traces and correlated logs. The package is named `@hue-run/sdk`.

## Install

```bash
npm install @hue-run/sdk
```

Or with Bun:

```bash
bun add @hue-run/sdk
```

Run the command in your application's server package. See the [compatibility guide](https://docs.hue.run/sdks/compatibility) before adding Hue to an application with existing OpenTelemetry or AI SDK dependencies.

## Start

```ts
import { createHue, HueExportError } from "@hue-run/sdk";

const hue = createHue({
  apiKey: process.env.HUE_API_KEY!, // a project service key, on the server only
  serviceName: "my-agent",
  captureContent: false, // required: explicitly choose true or false
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

The default destination is `https://app.hue.run`. Data goes to
`/api/v1/otlp/v1/traces` and `/api/v1/otlp/v1/logs` with a Bearer project key.
Set `baseUrl` only for another Hue deployment. It must be an origin without an API path; a trailing slash is accepted.
HTTPS is required except for loopback HTTP. Redirects are refused for both
project checks and exports. There is no proprietary tracing protocol, lab API
wrapper, database dependency, or dependency on the Hue application workspace.

## Model spans without a framework adapter

When you call a provider SDK directly, `hue.model()` creates the GenAI client span for the call:

```ts
await hue.model("gpt-5-mini", { provider: "openai" }, async (span) => {
  span.setInput(messages); // gen_ai.input.messages when captureContent is true
  const response = await openai.chat.completions.create({ model: "gpt-5-mini", messages });
  span.setOutput(response.choices.map((choice) => choice.message));
  span.setUsage({
    inputTokens: response.usage?.prompt_tokens,
    outputTokens: response.usage?.completion_tokens,
  });
  return response;
});
```

The span is named `{operation} {model}` (`operation` defaults to `chat`) with
`gen_ai.operation.name`, `gen_ai.request.model` and `gen_ai.provider.name`. `setUsage` records
nonnegative integer `gen_ai.usage.input_tokens` / `output_tokens`; other values are omitted and
counted as instrumentation failures. Unknown usage stays absent.

## Vercel AI SDK 6

AI SDK 6 accepts a per-call tracer through `experimental_telemetry`. Pass
`hueExperimentalTelemetry(hue)` from the core entry point; the generated spans parent under
`withSpan`, inherit session/user identifiers, and record prompts and responses only when
`captureContent` is true:

```ts
import { hueExperimentalTelemetry } from "@hue-run/sdk";

const result = await generateText({
  model,
  prompt,
  experimental_telemetry: hueExperimentalTelemetry(hue),
});
```

This requires no `@ai-sdk/otel` peer. `hueTelemetry` remains AI SDK 7 only.

## Vercel AI SDK 7

Compatible optional peers are `ai@^7.0.99` and `@ai-sdk/otel@^1.0.99`, alongside
`@opentelemetry/api@1.9.1`. For an app without global AI SDK telemetry integrations,
configure telemetry on each agent or generation call:

```ts
import { ToolLoopAgent } from "ai";
import { hueTelemetry } from "@hue-run/sdk/ai-sdk";

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

`hueTelemetry(hue)` supplies per-call integrations, which AI SDK 7 uses **instead of
globally registered integrations for that call**. Global registration remains intact,
but those integrations do not receive that call's events. To keep an existing
OpenTelemetry exporter, attach Hue's transport to the same provider using the
[existing-provider recipe](#existing-opentelemetry-providers).

Reuse the client across server requests. Await stream completion before flushing;
returning a streaming `Response` does not mean its stream has finished. The
[Next.js streaming recipe](https://docs.hue.run/integrations/opentelemetry#flush-streamed-responses-in-next-js)
shows how to keep completion and flushing within the request's background lifetime.
For a standalone script, put the operation in `try` and call `await hue.shutdownSafe()`
in `finally`. Shut down a shared server client only when the application stops.

The integration creates real Vercel provider, streaming and tool spans and passes
`recordInputs` and `recordOutputs` explicitly. The installed-package verification
tests the matching 7.0.99/1.0.99 and
7.0.100/1.0.100 pairs. Compatible-major ranges do not mean every later release
has been verified. Other OTel
instrumentations can use `hue.tracer` directly or explicitly attach the processors
below. Instrumentations that only use a global provider need your application's
normal OTel setup; Hue does not silently replace it.

## Privacy and content

`captureContent: false` disables manual input/output/messages/tool content and
removes recognized GenAI, Vercel, OpenInference and OpenLLMetry content attributes,
legacy GenAI content events, log bodies, status messages and exception text before
export. The exported `contentPrefixes` array lists the attribute keys (and their dotted
children) that are removed. Model/provider/token metadata remains available. Generic custom attribute
names cannot be classified automatically; use them deliberately.

`captureContent: true` captures supplied content. Accepted content is stored by Hue;
there is no SDK retention timer or automatic content expiry. To redact strings
before export, supply `redact(value, path)`; it applies to supported strings in
attributes, resources, event/link attributes and log bodies. Return a string.
Invalid/oversized helper content is omitted with an instrumentation failure; the span can still be delivered. Export-time redactor failures reject the affected record and are reported by flush. Shared resources are redacted once per
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
import { createHue, createHueTransport } from "@hue-run/sdk";

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

For external parent context pass `parentContext` to `withSpan`. Across processes, use
`hue.inject(carrier)` inside the producing span and `hue.extract(carrier)` in the worker; both
speak W3C `traceparent` only and never include the API key or baggage. Hue registers no global
propagator, so `propagation.inject()` from `@opentelemetry/api` is a no-op unless your
application configured one. `getContext()` exposes the helper's current context for APIs taking
an explicit context. Session/user identifiers are inherited within a client callback and are
stamped only on spans created through Hue's tracer (helpers and the AI SDK adapters); spans from
other instrumentations on a shared provider carry them only if that instrumentation sets them.
Separate requests require separate callbacks.

In attach mode Hue's span processor exports every span that ends on that provider, the same
default as other OpenTelemetry exporters. To send only part of a provider's spans, wrap the
processor:

```ts
const aiSpansOnly = {
  onStart: () => {},
  onEnd: (span) => {
    if ("gen_ai.operation.name" in span.attributes || span.name.startsWith("ai."))
      transport.spanProcessor.onEnd(span);
  },
  forceFlush: () => transport.spanProcessor.forceFlush(),
  shutdown: () => transport.spanProcessor.shutdown(),
};
```

## Local development without a Hue account

Hue speaks standard OTLP, so any local collector works. Point `baseUrl` at a loopback receiver
that accepts `/api/v1/otlp/v1/traces` and `/api/v1/otlp/v1/logs` (for example an OpenTelemetry
Collector `otlp` receiver with `http.traces_url_path` and `logs_url_path` set to those paths,
forwarding to Jaeger or the debug exporter) and pass any placeholder `apiKey`; HTTP is allowed
for loopback origins. `checkConnection()` and `verifyTrace()` are Hue-only diagnostics and are
not available against a generic collector.

## Delivery behavior

Exports use official OTel retry handling for temporary HTTP/network failures. Each
request is limited to 1 MiB before gzip (with space reserved for gzip overhead) and each content value to 256 KiB. Batches
split at record boundaries. Each signal queues at most 2,048 records, including
exports in flight; overflow is reported through the callback, counters and next
flush. This is an in-memory queue, not durable storage.

`flush()` waits for the current trace and log export work. A partial rejection,
invalid acknowledgement, queue drop or failure throws `HueExportError`; its
`report` contains cumulative accepted/rejected/failed counts and current pending gauges. Accepted
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

## Verify a stored application trace

After exercising a real application request and finishing its stream, flush the
providers that own its spans, then verify their OpenTelemetry IDs:

```ts
// traceId and requestSpanId come from the application request you just exercised.
await hue.flush(); // borrowed providers must also finish their own work
const result = await hue.verifyTrace(traceId, {
  expectedSpanIds: [requestSpanId], // include known model/tool span IDs when available
  requiredFields: ["input", "output", "model"], // choose fields this request should emit
});
if (!result.verified) throw new Error("Trace verification timed out; inspect missing spans and fields.");
console.log(result.receipt?.traceUrl);
```

Available in TypeScript `0.1.3`. `verifyTrace` makes a read-only, project-key-authenticated
receipt request. It does not flush, run your application, create a test span, or
read captured values. `fields` reports the presence of stored normalized input,
output, model, usage, and session data across the trace; it does not establish
content correctness or that every possible span has arrived. Leave unknown usage
and intentionally disabled content out of `requiredFields`.

The default budget is 10 seconds; set `timeoutMillis` up to 60,000. Only a recognized
missing trace, HTTP 429, or HTTP 503 is retried, respecting `Retry-After` and the
overall deadline. Incomplete evidence is also checked again within that deadline.
A timeout returns `{ verified: false, receipt }`, retaining the latest observed
receipt or `null`. Authentication, unsupported endpoint, transport, and invalid
response failures throw `HueTraceVerificationError` with a safe `code` and optional
HTTP `status`. Missing expected spans and required fields remain explicit; a 200
response alone is not success. A successful result verifies those requested
conditions only. Use Hue's UI to inspect captured values and redaction.

## Dependencies

The tracing core depends only on official `@opentelemetry/*` packages. JSON Schema scoring in
`@hue-run/sdk/evals` uses `ajv`, an optional peer dependency that is loaded inside a worker only when
`builtins.jsonSchema` scores a case; without it that scorer reports `SchemaValidatorUnavailable`.
Install it when you use that scorer:

```bash
npm install ajv
```

See [THIRD_PARTY_NOTICES.md](https://github.com/hue-run/hue-sdk/blob/main/THIRD_PARTY_NOTICES.md) for licenses.

## Package verification

From the repository root with Node 24 and Bun 1.4.2 on PATH:

```sh
node packages/sdk-typescript/scripts/verify-package.mjs
```

This copies the SDK to a temporary directory, performs a frozen installation,
builds and packs it, installs the tarball into a separate consumer, runs the real
HTTP exporter suite against that installed package, and installs/builds the
standalone reference chatbot. It prints the artifact paths. No package is
published. The chatbot README describes running that external installation.

# Local evaluation workflows

The optional `@hue-run/sdk/evals` entry point supports dataset/scorer registration, frozen-version experiments, local built-in/custom scoring, upload resume, and historical rescoring. See the [evaluation guide](https://docs.hue.run/evaluations/first-evaluation) for the complete journey, content policy and checkpoint recovery contract.

## Managed targets

Start a frozen dataset run in Hue while your agent stays in your application. Expose a
protected POST route around your existing function:

```ts
import { createManagedTargetHandler } from "@hue-run/sdk/managed";

export const POST = createManagedTargetHandler({
  machineCredential: process.env.HUE_MANAGED_TARGET_SECRET!,
  // Application-owned functions: keep your current provider, tools and tracing.
  target: async ({ input, config, inputFiles, signal }) =>
    runAgentForEvaluation({ input, config, inputFiles, signal }),
  tracer: hue.tracer, // Required with a Hue-owned client: Hue never registers a global tracer.
  flushTelemetry: () => hue.flush(), // Existing Hue client; flush traces and logs.
});
```

Without `tracer`, the handler falls back to the global OpenTelemetry tracer, its span is not
recorded, and every invocation returns `uncertain`. An application that only uses `createHue()`
also needs an OpenTelemetry context manager installed for the handler's span to propagate; see
the [managed-run guide](https://docs.hue.run/evaluations/managed-runs).

`runAgentForEvaluation` adapts your application result to `{ output, files? }`.
Files contain `filename`, `contentType`, actual `Uint8Array` data and an optional
`primary` flag. The helper verifies input bytes, claims the invocation, saves the
outcome and correlates its span with Hue. It never retries the agent automatically.
Use a 120-second host request limit for the default 90-second execution and
30-second finalization budget; your target must honor `signal`.

See the [managed-run guide](https://docs.hue.run/evaluations/managed-runs) and the
[full adapter contract](https://github.com/hue-run/hue-sdk/blob/main/packages/sdk-typescript/MANAGED_TARGETS.md) for registration, file handling,
existing-provider flush callbacks and recovery. Local/CI runners remain available.

## Serving safely

Use `createHueSafe(options)` for best-effort startup. Invalid initialization returns a disabled client with an instrumentation failure recorded. Pass `enabled: false` to disable Hue without a key; disabled helpers still execute the application callback. `flushSafe({ timeoutMillis: 1000 })` and `shutdownSafe({ timeoutMillis: 1000 })` return `{ ok, timedOut, report }` without rejecting. Strict initialization, connection checks and `flush()` remain available for diagnostics; do not gate application readiness or responses on them.

Capture/serialization/redaction/provider failures omit unsafe telemetry, record failures, and preserve the original business result/error. Async diagnostic rejections are contained; diagnostics are rate-limited. The default `maxQueueBytes` is 8 MiB across traces/logs including in-flight work, alongside the existing record cap. `pendingBytes` is a current queue gauge; `droppedSpans`, `droppedLogs` and `instrumentationFailures` are cumulative failure counters. This is a telemetry budget, not a total process memory ceiling. A timeout bounds the caller and does not cancel a borrowed provider. Never retry the business operation to recover telemetry. See [production safety](https://docs.hue.run/guides/production-safety).

Queued records snapshot supported telemetry values when a span ends or a log is emitted; later caller mutations cannot change queued data. Resource attributes still awaiting detection are omitted with a sanitized warning. Later records include them after detection finishes; await resource detection before instrumentation when those attributes are required.
