# Gmail summary tool in TypeScript

This example requires Node 22.12+ or Bun 1.4.2 and TypeScript SDK 0.26.0. An ordinary
helper lists five unread Gmail messages, reads each full message, and returns
`{count, ids}`. The HTTP child spans hold the API exchanges separately from that summary.

## Run without credentials

From this directory:

```sh
npm install
npm run build
npm run offline
```

The offline runner starts separate synthetic Gmail and OTLP loopback servers. It
runs default capture, identity-only capture, HTTP off, and metadata-only capture.
Each run asserts the actual exported spans and the same five-message summary.
Default capture exports six CLIENT children under one tool, with query inputs
and full JSON responses. The output includes `traceId`, `"httpSpans":6`,
`"exported":true`, and each receiver acknowledgement.

No model or external app is called. These assertions prove local capture and
export acknowledgement, not storage in Hue or a World build. The OTLP decoder
is test support and is separate from the copyable helper in `src/main.ts`.

To verify an unpublished checkout, install its packed tarball in a copy of this
example before building. See the repository's
[examples verification recipe](../../../.agents/skills/verify-examples/features/gmail-summary-tool.md).

To check model and tool nesting separately, run:

```sh
npm run offline -- --model-scope
```

This mode wraps the same Gmail helper in a synthetic model span, with loopback
model HTTP before and after the tool. Both model HTTP calls keep identity and
omit request and response bodies. The six Gmail children retain their bodies.
The model metadata is unchanged. No paid model or external service is called.

For a separate fixture with explicit MIME fields and distinct message dates, run:

```sh
npm run offline -- --canonical --export-dir=../../../.context/gmail-canonical-run
```

The [canonical fixture](../fixtures/README.md) contains synthetic values chosen
before capture. The runner compares each exported JSON value with the server's
response and saves the unchanged OTLP protobuf batches after gzip decompression.
It refuses to overwrite an existing batch or manifest. Keep these artifacts
separate from the original fixture's results. A downstream World replay result
is separate evidence and may still expose a replay limit.

## Read a live mailbox

Copy `.env.example` to ignored `.env` and set `HUE_API_KEY` and a short-lived OAuth
`GMAIL_ACCESS_TOKEN`. Give the token the
`https://www.googleapis.com/auth/gmail.readonly` scope. Never commit or print the
credentials. Then run:

```sh
node --env-file=.env dist/main.js --live
```

Live mode makes only Gmail GET requests. It prints the count and trace ID after
Hue acknowledges export. It makes no model request and changes no mailbox data.
Create Hue before API clients on Node 22 and Bun so the fetch fallback can observe
those clients. A fetch reference saved before Hue initialization can escape capture.

These application environment switches map to constructor options:

| Environment variable | SDK option | Default |
| --- | --- | --- |
| `HUE_CAPTURE_CONTENT` | `captureContent` | `true` |
| `HUE_CAPTURE_HTTP` | `captureHttp` | `true` |
| `HUE_CAPTURE_HTTP_BODIES` | `captureHttpBodies` | Follows content capture |

`HUE_CAPTURE_HTTP=false` disables automatic HTTP spans.
`HUE_CAPTURE_HTTP_BODIES=false` keeps identity without query inputs or bodies.
`HUE_CAPTURE_CONTENT=false` disables all content, including HTTP bodies even if
body capture is explicitly enabled. The SDK reads none of these variables itself.
`HUE_BASE_URL` optionally selects a different Hue deployment.

Gmail response content can include private email. Apply your app's existing
redaction policy before using live capture. Text and JSON capture is bounded by
the receiver's value limit, 1 MiB by default. Truncated content is incomplete
evidence; a successful export alone does not prove replay is possible.
