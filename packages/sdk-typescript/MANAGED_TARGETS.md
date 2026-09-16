# Run an existing agent from Hue

`@hue-run/sdk/managed` adapts an existing server-side function to Hue's managed
evaluation protocol. Hue dispatches a frozen case; your application keeps its
model, tools and OpenTelemetry provider. This helper does not create an agent,
choose a model, install instrumentation or replace global providers.

```ts
import { createManagedTargetHandler } from "@hue-run/sdk/managed";

// Your application initializes its existing NodeSDK/context manager before requests.
export const POST = createManagedTargetHandler({
  machineCredential: process.env.HUE_MANAGED_TARGET_SECRET!,
  // baseUrl defaults to https://app.hue.run; configure it here, never from a request.
  target: async ({ input, config, inputFiles, signal }) => {
    const result = await existingAgent({ input, config, files: inputFiles, signal });
    return {
      output: { text: result.text },
      files: result.files.map((file) => ({
        filename: file.name,
        contentType: file.contentType,
        data: file.bytes, // Uint8Array; upload these exact bytes once generated.
        primary: file.isPrimary,
      })),
    };
  },
  flushTelemetry: async () => {
    await flushExistingTracesAndLogs(); // Throw if either pipeline did not flush.
  },
});
```

The example's `existingAgent` and `flushExistingTracesAndLogs` are application
functions. An optional `tracer` uses an already configured provider. The default
uses the global provider, which must record the supplied sampled trace context.
Configure a host request limit of at least 120 seconds for the defaults: 90 seconds
for the target and 30 seconds reserved for uploads, checkpointing and telemetry.
Targets must honor `signal`; JavaScript cannot forcibly stop a callback that
ignores cancellation. A callback still running at the deadline returns `uncertain`.

## What the helper guarantees

- Validates the dedicated machine credential before network access. The scoped
  `X-Hue-Invocation-Token` is used only for Hue callbacks; neither credential is
  passed to the target, output uploads or telemetry attributes.
- Claims the assigned execution before calling the target. A duplicate claim
  returns HTTP 409 without another agent call. A lost claim response is uncertain.
- Downloads only declared files from the configured Hue origin and verifies their
  length and SHA-256 before calling the target. No redirects are followed.
- Creates a real `ai.managed_target` span under the incoming W3C `traceparent`,
  using the existing provider. It records no input/output content of its own.
- Uploads returned file buffers, including valid secondary files on an error
  result. Each reservation has a stable idempotency key; an already ready file is
  reused. Only granted content-type/private-access upload headers are accepted.
- Ends the span, checkpoints the outcome, flushes existing traces and logs, then
  persists a telemetry acknowledgement before returning HTTP 200.

HTTP 200 returns `{protocolVersion:1,executionId,state:"checkpointed",telemetry}`.
`telemetry` is `"flushed"` or `"pending"`; a flush/acknowledgement failure preserves
the saved outcome. A checkpoint is not experiment completion or a receipt proving
all evidence has been stored. Hue performs that independent verification.

The callback returns `ManagedTargetResult`: optional `output` JSON, `state`
(`succeeded`, `error`, `cancelled`), a safe `{type,message?}` error, file buffers and
optional token usage. Omitted output means unavailable; `null` is present output.
At most one file can be primary. Files are limited to 16, 25 MiB each and 64 MiB
total; input/output JSON and HTTP envelopes also have bounded sizes. Error text
is caller-owned public content: never return raw provider exceptions or secrets.

Only identical idempotent upload/checkpoint/telemetry requests retry, at most once
within the finalization deadline. The helper never retries the agent, automatically
resumes a lost callback, or claims exactly-once execution across crashes. After
transport loss or a callback deadline, inspect the saved execution in Hue. An
explicitly authorized new attempt is a separate execution decision.

Protect and rate-limit the endpoint at your host as appropriate. Keep the dedicated
machine credential server-side. This API uses invocation-scoped callbacks, not the
project-wide `EvaluationClient` credential. The existing telemetry pipeline retains
its configured content-capture policy and exporter credentials.
