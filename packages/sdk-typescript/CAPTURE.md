# Source capture

This API is prepared for unreleased `@hue-run/sdk@0.3.1`. Capture requests require a Hue server that supports
the capture protocol and a separately authorized capture key. The package version alone does
not establish hosted availability.

`@hue-run/sdk/capture` records portable source evidence for reviewed trace-to-case conversion. It is independent of telemetry's `captureContent`. This optional entry point requires the `ajv` peer; core tracing does not. After publication, install with `npm install @hue-run/sdk@0.3.1 ajv`. Before publication, installed-package verification uses the exact local archive produced by `node packages/sdk-typescript/scripts/verify-package.mjs`; it does not establish registry availability. Use a separate `capture_write` key; that key cannot send telemetry or access the general artifact API.

```ts
import { CaptureSession } from "@hue-run/sdk/capture";

const capture = new CaptureSession({
  sourceContent: true,
  apiKey: process.env.HUE_CAPTURE_API_KEY!,
  externalTraceId: currentTraceId,
  bindings: [
    {
      id: "mail",
      kind: "tool",
      contractVersion: "1",
      operations: [
        {
          name: "read_message",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
      ],
    },
  ],
});

const message = await capture.observe("mail", "read_message", { id }, () => readMessage(id));
const report = await capture.finalize();
// Keep report.captureId, revision and digest with the trace's provenance.
```

`observe` is an explicit async function boundary and preserves the live value/error object. Default credential fields and URL credentials are removed before buffering. Unsupported/capped results, redaction and queue pressure remain evidence gaps. Custom `redact` applies to tool content, snapshots and source descriptors, including names, URIs and metadata. Changed source descriptors are marked partial; callback failures become drops and never replace live results. Raw source file uploads are explicit and are not automatically content-scrubbed; pass only bytes your capture policy permits.

Call `stateEvidence(record)` with an actual snapshot captured before execution, or an explicitly labeled post-execution journal. Declare the service/account/actor identity, semantic adapter version, initial state, supported action definitions, complete collections and known omissions. Do not label post-write data as an initial snapshot. `source(record)` attaches verified artifact references; `uploadSource({filename,contentType,bytes})` returns a ready immutable reference or `null`. No files or URLs are automatically fetched. Signed uploads make one native PUT attempt with no
redirect or transport replay. A missing acknowledgement is settled by the completion endpoint's
independent byte/hash verification; failed verification returns `null`. The SDK forwards only
approved upload headers, defaults missing headers to the declared content type, and never sends
the capture key to storage.

`flush()` returns pending/dropped counts and retains an unacknowledged batch with the same idempotency key for a later retry. `finalize({deadlineMillis:30000})` pins a server revision and reports omissions. A finalized revision is not proof that every possible tool result or state entity was captured. Open calls, uploads, dropped records and gaps remain explicit. New evidence can be finalized later without changing an earlier manifest. An uncertain finalization retries the exact saved request. A decided revision conflict permits one fresh barrier and finalization within the deadline; recovering an older accepted revision also pins newer local evidence before returning.

Inline tool payloads are limited to 256 KiB and individual queued records to 300 KiB (also subject to bounded portable-JSON traversal). The local queue defaults to 8 MiB and 2,048 records; options can lower either, with a 4,000-record maximum. Uploads are limited to two concurrently and 25 MiB each. Export uses a bounded request deadline, no redirects and sanitized reports; failures do not throw into `observe`. `sourceContent:false` disables recording and all capture network calls.

Bindings and capture records follow the language-neutral [protocol](https://github.com/hue-run/hue-sdk/tree/main/packages/capture-protocol). `canonicalCaptureJson` and `captureRequestKey` expose its stable canonicalization for independent producers. Ordinary OTel telemetry remains usable without this optional package entrypoint.

## Provider source capture

`StateEvidence` also accepts `adapter: "gmail-provider@1"`. A provider initial snapshot must
include `providerInterface` (`gmail-provider/v1`) with the complete selected MCP and native HTTP
operation schemas, provider configuration, scopes and immutable world/execution identities.
Acknowledge this record with `flush()` **before** invoking the agent. Inspect `status`, `pending`
and `dropped`; `stateEvidence()` preserves live execution on failure by reporting a drop, not throwing.

After an acknowledged world seal, export all committed steps and the complete provider-call
inventory. Record them as `kind: "execution_journal"`, `boundary.phase: "after_execution"` and
`journal.schemaVersion: "hue.environment-journal/v1"`. Then finalize and require zero pending/dropped
records, inspect server omissions, and retain the exact `captureId`, revision and digest with the
actual OTel trace identity. An open world, partial pagination or unknown coverage is not a complete
recording. The runtime schema rejects journals mislabeled as initial snapshots.

The SDK records these explicit inputs; the application must obtain them through its supported
provider adapter. It does not discover accounts or activate a provider facade. Never supply the
runtime connection bundle, private endpoints or bearers as evidence. Known credential fields,
including V2 bearers and their paired endpoints, are stripped as defense in depth. No credential
filter can classify arbitrary application strings; review the selected content and redactor.
