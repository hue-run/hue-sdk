# TypeScript tracing

An application creates a client with `createHue`, records spans and tools, and receives an export report from `flush()` that states what Hue accepted.

## Sub-features

- `ts-span` records `withSpan`, `tool` and `model` spans with input and output.
- `ts-capture` honors `captureContent` and redaction before export.
- `ts-ack` reports accepted, rejected and failed records truthfully from the receiver's acknowledgement.
- `ts-lifecycle` covers `flush`, `shutdown` and the fail-open `*Safe` variants.
- `ts-media` inspects bounded, nonempty media and exports exact digests and blob entries.
- `ts-file-upload` covers opt-in `recordFile` uploads and name validation.
- `ts-attachment` places `Attachment` in recorded values and uploads it under `<attribute>#<pointer>` or `body#<pointer>`.

## How to get to it (user POV)

- `import { createHue } from "@hue-run/sdk"` in a Node 22+ or Bun script (README "Send a trace").
- `@hue-run/sdk/ai-sdk` for Vercel AI SDK telemetry.

## Driving it with node and the loopback stub (fake Hue API)

Preconditions:

- `bun run build` done in `packages/sdk-typescript`; stub running; `HUE_BASE_URL` exported.

- **Drive.** Write the README example against the stub and run it:

  ```sh
  cat > "$V"/drive.mjs <<'JS'
  import { createHue } from "../../packages/sdk-typescript/dist/index.js";
  const hue = createHue({ apiKey: "synthetic-verify-key", baseUrl: process.env.HUE_BASE_URL, serviceName: "verify-sdk", captureContent: true });
  try {
    console.log("project", (await hue.checkConnection()).id);
    await hue.withSpan("chat", async (span) => {
      span.setOutput(await hue.tool("uppercase", "hello", () => "HELLO"));
      console.log("traceId", span.traceId);
    }, { sessionId: "verify-session", input: "hello" });
    console.log("flush", JSON.stringify(await hue.flush()));
  } finally {
    await hue.shutdownSafe();
  }
  JS
  node "$V"/drive.mjs
  cat "$V"/stub.log
  ```

  Expected: `project 00000000-0000-4000-8000-000000000001`, a trace ID, and `flush {"acceptedSpans":2,...,"failedSpans":0,...}`. The stub log gains `GET /api/v1/projects/current` and `POST /api/v1/otlp/v1/traces` with status 200.
- **Behavior test.** `cd packages/sdk-typescript && bun test tests/sdk.test.ts -t "redaction happens before export"`. Expected: `1 pass`, `0 fail` in under 1 s. Swap the pattern for the behavior you changed (`grep -n 'test(' tests/sdk.test.ts`).

## Gotchas

- The drive imports `dist/`, so rebuild after editing `src/`.
- `tests/sdk.test.ts` takes 46 s whole because one case waits out a 30 s Retry-After. Always use `-t`.
- The stub acknowledges everything. Rejection and partial-success paths need the test receivers in `tests/`, not the stub.

## Recorded media and file uploads
- `ts-media` covers the shared `tests/fixtures/media-parts/cases.json` corpus across `gen_ai.input.messages`, `gen_ai.output.messages` and `ai.prompt.messages`, including OpenAI content arrays, and the other attributes Hue reads files from (`ai.prompt`, `input.value`/`output.value`, tool arguments and results, OpenLLMetry entities and `gen_ai.prompt.<n>.content`, Langfuse inputs, outputs and metadata, `metadata`, `ai.telemetry.metadata.<key>`, OpenInference flattened image URLs). A case's `value` is raw attribute text compared exactly; `messages` is JSON compared parsed. Outside the recorded messages a failed upload leaves the file inline. The corpus's `logs` cases drive `recordMessages` and compare the log body, its `body#<pointer>` entries and the trace the bytes were stored under. Compare both successful uploads and failed uploads with each fixture's exact messages and ordered compact JSON strings in `hue.blobs`. Hash the decoded bytes, not their base64 spelling. Content that reads as base64 is decoded whatever its declared type, as Hue reads it (`YWJj` is `abc`; corpus `genai-text-base64-*`, `vertex-media-text-base64-over-limit`, `ai-file-text-base64-over-limit`); other content is its own UTF-8 text. An invalid declared MIME type falls back to a valid data URL MIME type, then the binary/text default.
- Nonempty eligible binary parts within inspection limits export part-level `sha256` and `size` at every size. Empty values stay recorded without uploads. Successful text uploads over 64 KiB retain a UTF-8-safe 16 KiB prefix and a content-field blob entry; a text file held as bare base64 takes the digest form. Failed text uploads retain the digest and size without an entry.
- Placing a file keeps every other byte of the recorded JSON, in the attribute and in a JSON-encoded tool string (corpus `tool-strings-keep-recorded-bytes`, `tool-call-arguments-js-numbers`, `input-value-request-numbers`). Files more than ten levels deep, attribute JSON nested past 32 levels or holding an integer past 2^53, and an `input.value` declared `text/plain` are left as recorded (corpus `input-value-file-deeper-than-the-reader`, `input-value-nested-past-the-reader`, `input-value-js-numbers`; `bun test tests/blobs.test.ts -t "declared text/plain"`).
- Names must be nonblank after trimming, contain at most 256 UTF-16 code units, be well-formed Unicode and contain no C0 characters (U+0000–U+001F) or DEL (U+007F). Invalid source names stay in the message but do not enter blob metadata. Remote URLs, file IDs and S3 locations stay unchanged and cause no fetch.
- `ts-file-upload` covers `recordFile`: the existing `hue.file` event stays present, `upload` defaults to `false`, and supplied data is limited to 25 MiB. With `upload: true`, a successful upload adds `event:hue.file:<sha256>` to the same span. Digest-only records do not upload. An invalid helper name omits only the name and counts an instrumentation failure while preserving the otherwise valid event.
- Verify duplicate media is reserved once per trace, failed uploads add no entries, and `captureContent: false` and setup credentials cause no upload requests. Whole string attributes retain their separate 1,000,000,000-byte upload limit.
- One export fits every span before any helper upload, then uploads the admitted files of all its spans four at a time within one upload budget; a file whose event was redacted or shed is not uploaded, and copies of one file share a single upload without holding a place another file needs. A requested upload of a span dropped at the queue counts in `uploadFallbacks`.
- Media inspection is bounded to 8 Mi UTF-16 code units per attribute and 16 Mi per record. A skipped value keeps its original content for ordinary hold, cut or drop admission, and export inspects only the span attributes admission inspected. In recognized message attributes on resources, events, links and log records that are not offloaded, inline media up to 64 KiB stays verbatim; larger inline media becomes a digest, preserving legacy behavior. Resources, events and links never upload; a log record correlated with a span uploads its inspected attributes' and its `gen_ai.*` structured body's media under its own trace, together with the attachments its body holds, in one placement step; a log record's message file that is not uploaded keeps the same 64 KiB rule. Verify both sides of the threshold and that no nested upload requests occur. Explicit `recordFile({ upload: true, ... })` remains the event upload opt-in.

Use a loopback receiver that implements blob reservation, byte upload and completion for the success path, then refuse reservation or upload for the fallback path. The generic `stub-hue.py` returns 404 for blobs and proves only fallback. Repeat the helper upload and privacy checks from an installed npm tarball and inspect the decoded OTLP payload and received bytes.

The shared corpus covers empty byte fields, null alternate MIME/name/inline-data selectors, a valid 128-astral-character name (256 UTF-16 units), invalid 129- and 256-astral-character names, blank names, C0, DEL and lone surrogates. Keep both fixture files byte-identical.

Run from `packages/sdk-typescript`:

```sh
bun test tests/blobs.test.ts -t "media wire"
bun test tests/blobs.test.ts -t "log media wire|media beyond the recorded messages|queue cut"
bun test tests/blobs.test.ts -t "recordFile uploads are opt-in"
bun test tests/blobs.test.ts -t "concurrently within one export|repeated files share|dropped at the queue|code units|admission skipped"
bun test tests/inline-files.test.ts -t "media digest fallback"
```

## Attachments placed in values
- `ts-attachment` covers the `attachments` section of the shared corpus: an `Attachment` in `setInput`/`setOutput`, `model()` input, a `metadata` attribute passed to `withSpan()` (whole and nested) and `recordMessages()` input, with the exact recorded JSON text (the part as `{"type":"blob","mime_type","modality","sha256","size","name"}`) and the ordered `hue.blobs` strings, for successful and refused uploads. The log case's entry sits on the log record, keyed `body#/gen_ai.input.messages/0/parts/1`. A file used twice in one trace is PUT once.
- Also check: `path` and every `data` form give the same digest and the bytes are copied; an invalid attachment records `null` and an invalid name is omitted, each counted as an instrumentation failure (the flush throws, the span is accepted); `captureContent: false` keeps the metadata part without its name and sends no reservations; a redacted or replaced value uploads nothing and counts nothing; a part deeper than 10 levels keeps its digest and counts one fallback; setup credentials upload nothing.
- A `withSpan()` attribute OpenTelemetry cannot hold (a JSON object, an array not of one primitive type) is recorded as JSON text with or without attachments; bytes over 25 MiB are refused before they are copied.
- One step places a log record's files: an `Attachment` next to an inline image in one `recordMessages()` body is reserved once, by `offloadLog`, never by the span helper step, and both entries sit on the log record, the inline image's first; refused, both fall back together. A log record's message file that is not uploaded keeps the 64 KiB rule: a small image stays inline and a large one becomes its digest.

Run from `packages/sdk-typescript` (under 1 s):

```sh
bun test tests/blobs.test.ts -t "attachment"
bun test tests/blobs.test.ts -t "one upload step"
```

Expected: `11 pass` and `3 pass`, `0 fail`. `verify-package.mjs` runs `blobs.test.ts` against the packed tarball.
