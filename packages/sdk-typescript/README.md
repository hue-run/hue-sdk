<p align="center">
  <img alt="Hue" src="https://raw.githubusercontent.com/hue-run/hue-sdk/df0443f98c6096ff331fd0400715e4f3a1936607/.github/assets/hue-ascii-neutral.png" width="720">
</p>

# Hue TypeScript SDK

[![npm](https://img.shields.io/npm/v/%40hue-run%2Fsdk?label=%40hue-run%2Fsdk)](https://www.npmjs.com/package/@hue-run/sdk) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

A client for Hue's standard OTLP HTTP endpoints on Node.js 22 or 24 and Bun 1.4.2. It uses the
OpenTelemetry JavaScript SDK and official OTLP protobuf exporter components for
traces and correlated logs. The package is named `@hue-run/sdk`.

[Documentation](https://docs.hue.run) · [Sign in](https://app.hue.run)

## Install

```bash
npm install @hue-run/sdk
```

Or with Bun:

```bash
bun add @hue-run/sdk
```

Run the command in your application's server package. The package is ESM; CommonJS applications on
Node.js 22.12 or later load it with `require("@hue-run/sdk")`. See the [compatibility guide](https://docs.hue.run/sdks/compatibility) before adding Hue to an application with existing OpenTelemetry or AI SDK dependencies.

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
HTTPS is required except for loopback HTTP or the explicit
[`allowInsecureHttp`](#local-development-without-a-hue-account) opt-in. Redirects are refused for both
project checks and exports.

The setup CLI shipped in TypeScript `0.4.0` also prepares the `hue` executable. The unreleased
`npx --yes @hue-run/sdk@latest setup --agent` path supports Express with npm, Express with Bun, and
Flask with uv in one application package with an unambiguous entrypoint and existing GET route. It
installs the runtime, wires the application, makes one request and verifies that request's exact
trace/span receipt. Unsupported or ambiguous repositories receive a structured action. Technical
preflight checks availability and presents the published [privacy notice](https://hue.run/privacy)
and [security information](https://trust.hue.run/) before telemetry. Anonymous trials last 24 hours
and are limited to 100 traces, 1,000 spans and 2 MiB. A private owner-only browser handoff supports
account linkage; the original request evidence is retained and business work is never replayed on
claim. Setup never enables content capture or creates a simulation, Hue Run, evaluation, source capture
or remote execution. See the [setup CLI contract](./CLI.md) for the supported shapes and release gates.

For an existing account, `hue login` validates keys created in Hue Settings and stores them in
`.env.hue` without printing them, and `hue mcp install --client claude-code` (or `cursor`, `codex`,
`vscode`, `windsurf`, `gemini`) writes the Hue MCP configuration that references `HUE_MCP_KEY`. See
[Sign in and store keys](./CLI.md#sign-in-and-store-keys) and
[Install the MCP for your coding agent](./CLI.md#install-the-mcp-for-your-coding-agent).

`checkConnection()` rejects with `HueConnectionError`: its fixed message is safe to log, `status`
carries the HTTP status when Hue answered, and `cause` carries the underlying network, timeout or
parsing error. `serviceVersion` and `resourceAttributes` (for example
`{ "deployment.environment.name": "production", "service.namespace": "agents" }`) describe the
deployment; a client that owns its providers merges them into its resource, with `serviceName`
and `serviceVersion` taking precedence over same-named keys.

## Model spans without a framework adapter

When you call a provider SDK directly, `hue.model()` creates the GenAI client span for the call.
Inside it, `setInput` and `setOutput` record `gen_ai.input.messages` / `gen_ai.output.messages`
when `captureContent` is true. Those attributes carry the OpenTelemetry GenAI message shape
(`{ role, parts: [{ type: "text", content }] }`, with `finish_reason` on output messages) defined
by the semantic conventions'
[input messages](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/gen-ai-input-messages.json)
and
[output messages](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/gen-ai-output-messages.json)
JSON schemas, so any semantic-convention-aware backend can read them. Convert provider-native
messages before recording them:

```ts
await hue.model(
  "gpt-5-mini",
  async (span) => {
    span.setInput(
      messages.map((message) => ({
        role: message.role,
        parts: [{ type: "text", content: message.content }],
      })),
    );
    const response = await openai.chat.completions.create({ model: "gpt-5-mini", messages });
    span.setOutput(
      response.choices.map((choice) => ({
        role: choice.message.role,
        parts: [{ type: "text", content: choice.message.content ?? "" }],
        finish_reason: choice.finish_reason,
      })),
    );
    span.setUsage({
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
    });
    return response;
  },
  { provider: "openai" },
);
```

The span is named `{operation} {model}` (`operation` defaults to `chat`) with
`gen_ai.operation.name`, `gen_ai.request.model` and `gen_ai.provider.name`. Like `withSpan`, the
options come after the callback and also accept `name`, `sessionId`, `userId`, `input` (recorded as
`gen_ai.input.messages`) and `parentContext`. `setUsage` records
nonnegative integer `gen_ai.usage.input_tokens` / `output_tokens`; other values are omitted and
counted as instrumentation failures. Unknown usage stays absent. `hue.tool(name, input, execute)`
creates an `execute_tool {name}` span with `gen_ai.tool.name`, arguments and result; an optional
fourth argument `{ callId }` records the provider's tool call id as `gen_ai.tool.call.id`. When the
tool came from an MCP server, pass `{ mcp: client.getServerVersion() }` (the MCP `initialize`
`serverInfo`) to record `mcp.server.name` and `mcp.server.version` so a generic verb such as
`get_thread` is attributed to that server. When the server is a Hue surface, `mcp.provider` and
`mcp.surface` (for example `google.gmail` and `google.gmail/mcp`) record `hue.mcp.provider` and
`hue.mcp.surface`. A blank, over-256-character or otherwise invalid label is omitted and counted as
an instrumentation failure; the tool still runs. Content
helpers (`setInput`, `setOutput`, `tool` arguments and results, `recordMessages`,
`SpanOptions.input`) accept any value and encode plain JSON data (`JsonValue`) at runtime; a value
that is not JSON, such as a `Date` or a class instance, is omitted with an instrumentation failure
while the callback result is returned unchanged.

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

This requires no `@ai-sdk/otel` peer. `hueTelemetry` remains AI SDK 7 only: it reads the
installed `ai` major version once per process and throws a `TypeError` below 7.

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

Provider-executed tools, such as OpenAI hosted MCP (`openai.tools.mcp`), appear as
`execute_tool mcp.<name>` spans with `gen_ai.tool.type` `extension`. The server is named only
by `serverLabel` inside the recorded result, so before export the TypeScript SDK copies it to
`mcp.server.name`, and a result with an MCP `error` sets ERROR status and `error.type`
`mcp_error`. Metadata-only export keeps these two attributes while stripping arguments and
results. The label can only be read when AI SDK recorded the result: `hueTelemetry(hue)` with
`captureContent: false` records none, whereas an application whose AI SDK integration records
outputs and exports through Hue's attached processors keeps the label.

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

Hosted tools carry credentials in their definitions, such as the `authorization` and `headers` of
an OpenAI hosted MCP tool. Before export, and before `redact`, Hue replaces the values of
credential-like fields including `authorization`, `authorization_token`, `headers`, `api_key`,
`access_token`, `x-api-key`, and keys ending in `token`, `secret`, `password`, `apikey` or
`credential` (case-insensitively, ignoring `-` and `_`) with `"[redacted]"` in recorded tool definitions
(`gen_ai.tool.definitions`, `ai.prompt.tools`, `llm.tools.*.tool.json_schema`) and in the `tools`
and `mcp_servers` entries of a raw provider request or response recorded as `input.value`,
`output.value` or `llm.invocation_parameters`. Parameters named in a JSON Schema `properties`
object keep their schemas, so a tool that takes a `headers` argument is still described. A
definition nested more than 256 levels deep rejects its record. Sensitive `default`, `const`,
`examples` and `enum` values under credential-named schema parameters are redacted too.

Manual helpers encode JSON values without converting null into absence. Unknown
outputs and usage remain absent. This SDK does not estimate tokens or cost. A thrown
application error marks the span with `error.type` (the error's `name`), an ERROR status and an
`exception` event carrying only the type; exception messages and stack traces are never recorded by
the helpers, whatever `captureContent` is, and the error is rethrown unchanged. `withSpan` ends its
span in `finally`.

`recordMessages` emits the `gen_ai.client.inference.operation.details` log record correlated with
the active span, with the messages in its body. The record also carries `gen_ai.operation.name`,
`gen_ai.provider.name` and `gen_ai.request.model` as attributes, copied from the enclosing
`hue.model()` span or passed as `operation`, `provider` and `model`, and `gen_ai.conversation.id`
from the active session, so a collector fan-out to another GenAI-aware backend keeps the request
context.

## Existing OpenTelemetry providers

Attach processors while constructing your providers. Hue uses local async context
for its own helpers and never registers/replaces the global tracer, logger, or
context manager. When your application has registered a context manager, Hue helpers also make
their span the active OpenTelemetry span for the duration of the callback, so spans from other
instrumentations (HTTP clients, provider SDKs) that use the global API parent under it.

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

The application's providers own the resource in this mode, so `resourceAttributes` on the
transport options is ignored and reported as a `warning` issue; set `deployment.environment.name`
and similar attributes on your own providers.

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

A collector on a private network is not loopback: a docker-compose sibling such as
`http://otel-collector:4318` or an in-cluster service requires the explicit opt-in
`allowInsecureHttp: true`. The client then records a one-time `warning` issue because the key and
telemetry travel unencrypted. Use a placeholder key with such a collector, and never enable the
option for a real project key on a network you do not control.

```ts
const hue = createHue({
  apiKey: "local-placeholder",
  serviceName: "my-agent",
  captureContent: true,
  baseUrl: "http://otel-collector:4318",
  allowInsecureHttp: true,
});
```

## Delivery behavior

Exports retry temporary HTTP/network failures (429, 502, 503, 504 and connection errors,
honoring `Retry-After`) within the export timeout, by OpenTelemetry's OTLP/HTTP exporter rules. Each
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

## Live spans

OpenTelemetry exports a span only when it ends, so a long streamed turn would otherwise stay
invisible until it finishes. When a Hue or AI span is still open at the transport's next 500 ms
tick, the transport queues a placeholder: an ordinary OTLP span whose parent is the running span,
with its name, kind, start time and current attributes, an end time of 0,
`hue.span_type = "pending_span"` and `hue.pending_parent_id` (the running span's own parent,
omitted for a root). Hue shows the span as running and replaces the placeholder when the real span
arrives.

The placeholder then waits for the next batch export like any queued span: up to 500 ms until the
next tick, then the 1 s batch delay when nothing else is queued, so it usually reaches Hue within
about 1.5 s of its span starting. It goes out sooner when a batch is already scheduled, for example
because another span has just ended, and at once for a full batch or `flush()`. It goes out later
while an earlier export is still in flight, because the next batch is scheduled only after that
export finishes. A placeholder whose span has ended by the time it is exported is not sent, so a
short span may send none and appear in Hue only when it finishes.

- Only spans from the client's tracer (`withSpan`, `tool`, `model`, `hue.tracer` and the AI SDK
  adapters) and spans with a `gen_ai.`, `ai.`, `llm.` or `traceloop.` attribute at start, or a
  name starting with `ai.`, are announced. HTTP, database and other framework spans are not.
- Placeholder attributes follow `captureContent` and `redact` like the real span. Tool
  definitions, system instructions and any value over 64 KiB are left out.
- The transport builds each placeholder from the running span itself, so code in a wrapping
  processor's `onEnd` never runs on it. If a wrapper forwards `onStart` to Hue but scrubs
  attributes, renames the span or drops it in `onEnd`, a placeholder exported while the span is
  still open is sent anyway: it has the span's original name, and its attributes as set on the span
  with `captureContent` and `redact` applied. Scrub with `redact`, which applies to placeholders
  too, or before the value is set on the span; do not forward `onStart` for spans you rename or
  drop; or turn live spans off with `liveSpans: false`.
- Placeholders are advisory. They are queued only while the queue is under a quarter of its
  record and byte budgets, and skipped silently otherwise. While queued they count in
  `pendingSpans` and `pendingBytes`, but never as accepted, rejected, failed or dropped records.
  Losing only placeholders records a warning and does not make `flush()` throw.
- A Hue server that accepts placeholders sends `Hue-Pending-Spans: 1` on trace acknowledgements.
  When a response to a request carrying placeholders lacks it, the receiver predates them: the
  transport attributes up to one rejection per placeholder to them, records one warning and stops
  sending placeholders for that client. Other rejections count against real spans as usual.
- Opt out with `liveSpans: false`. Setup credentials never send placeholders.
- With an existing provider, announcements start in `spanProcessor.onStart`. A wrapping processor
  that forwards `onStart` should forward `onEnd` for the same spans: a span that ends without
  reaching Hue is forgotten at the next tick, but a placeholder already sent keeps it showing as
  running until Hue marks the trace stalled. The filtering wrapper above forwards no starts, so it
  sends no placeholders.

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

The tracing core depends only on official `@opentelemetry/*` packages. The optional
`@hue-run/sdk/evals` entry point uses `zod` for its bounded runtime contracts; install that peer
when you use evaluations or simulations. JSON Schema scoring also uses `ajv`, an optional peer
loaded inside a worker only when `builtins.jsonSchema` scores a case; without it that scorer
reports `SchemaValidatorUnavailable`. Install it when you use that scorer:

```bash
npm install zod
# Add ajv too when using builtins.jsonSchema.
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

## Local evaluation workflows

The optional `@hue-run/sdk/evals` entry point supports dataset/scorer registration, frozen-version experiments, local built-in/custom scoring, upload resume, and historical rescoring. See the [evaluation guide](https://docs.hue.run/evaluations/first-evaluation) for the complete journey, content policy and checkpoint recovery contract.

### App-launched local workers

`runLocalAgent()` shipped in TypeScript `0.3.0` and is available from npm. It connects a fixed local
callback to app-launched simulation work while keeping the agent and provider orchestration in
the developer's process. It shares
`runSimulation()`'s provider-aware world lifecycle, keeps scoped credentials in callback memory,
skips target/scorer execution for incomplete environments, and never reacquires or replays after
an uncertain preparation. See the
[outbound worker contract](EVALUATIONS.md#outbound-local-agent-worker) and
[simulated environment guide](ENVIRONMENTS.md). Tests exercise local control-plane fixtures, not
an issued facade endpoint or the official Gmail service, and do not claim universal provider
parity.

An unreleased `directTarget` callback extends the same worker to cases without a world: the runner
verifies the case's pinned input files, hands them to the agent, and uploads the documents it
returns as verified Hue artifacts for scoring. See
[direct cases and files](EVALUATIONS.md#direct-cases-and-files).

Scorer deferral shipped in TypeScript `0.3.1`. Only built-ins
and bound `local_code` callbacks run here; other pins remain pending for their authorized executor.
See [scorer execution](EVALUATIONS.md#hosted-and-manual-scorer-pins).

The published [setup CLI](CLI.md) is a resumable local inspection core; the unreleased `0.4.0`
candidate adds the bounded application onboarding flow described above. Existing customers connect
their agents with `runLocalAgent()`; setup does not register workers or launch simulations.

### Command-line evaluation

The unreleased `hue eval` command wraps `runSimulation()` and `runLocalAgent()` for an adapter
file or a shell command: `hue eval --case "<name>" ./hue-agent.ts` creates a fresh run
from a published case's immutable pins, runs the agent in one isolated world per case, waits
for Hue's outcome checks and prints the run URL and per-case PASS/FAIL verdicts with an exit code;
`--worker` registers the same adapter for runs launched from Hue. It needs a Read and
write key in `HUE_API_KEY` (never printed) and keeps content capture off unless `--content`
is passed. See [Evaluate an agent against a case](CLI.md#evaluate-an-agent-against-a-case).
Eval sets whose cases pin files instead of a world run as direct cases through `runExperiment()`:
`hue eval --set <slug> --scorer <slug> --command "…"` hands the agent each case's pinned files in a
private directory, uploads the documents it writes and waits for Hue's grading executor to score
them. See [Evaluate a document eval set](CLI.md#evaluate-a-document-eval-set).

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

Use `createHueSafe(options)` for best-effort startup. Invalid initialization returns a disabled client that keeps your `onExportIssue` hook and records the reason as an instrumentation failure. Pass `enabled: false` to disable Hue without a key or a `captureContent` choice; disabled helpers still execute the application callback, and `inject()` keeps propagating the application's own trace context. `flushSafe({ timeoutMillis: 1000 })` and `shutdownSafe({ timeoutMillis: 1000 })` return `{ ok, timedOut, report }` without rejecting. Strict initialization, connection checks and `flush()` remain available for diagnostics; do not gate application readiness or responses on them.

Capture/serialization/redaction/provider failures omit unsafe telemetry, record failures, and preserve the original business result/error. Async diagnostic rejections are contained; diagnostics are rate-limited. The default `maxQueueBytes` is 8 MiB across traces/logs including in-flight work, alongside the existing record cap. `pendingBytes` is a current queue gauge; `droppedSpans`, `droppedLogs` and `instrumentationFailures` are cumulative failure counters. This is a telemetry budget, not a total process memory ceiling. A timeout bounds the caller and does not cancel a borrowed provider. Never retry the business operation to recover telemetry. See [production safety](https://docs.hue.run/guides/production-safety).

Queued records snapshot supported telemetry values when a span ends or a log is emitted; later caller mutations cannot change queued data. Resource attributes still awaiting detection are omitted with a sanitized warning. Later records include them after detection finishes; await resource detection before instrumentation when those attributes are required.
