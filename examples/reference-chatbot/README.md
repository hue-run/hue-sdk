# Standalone Hue reference chatbot

A Node 24 HTTP server with a small streaming chat page, Vercel AI SDK 7
`ToolLoopAgent`, a real text-statistics tool and a controlled-error action. The
browser receives streamed model text and a trace ID; the server exports standard
OTLP traces and correlated message logs. It imports only the packed public SDK.
It has no Hue application or database imports.

## Build and install outside the repository

Run the SDK package verifier from the Hue repository with Node 24 and Bun 1.3.9:

```sh
node packages/sdk-typescript/scripts/verify-package.mjs
```

It prints `tarball`, `consumer` and `chatbot` absolute paths. The chatbot directory
is a complete, installed external application. Its generated package manifest
contains the actual local `@hue-run/sdk` tarball dependency; the source manifest omits
that unpublished dependency so it cannot accidentally resolve an unrelated
registry package. The verifier never publishes anything.

For a separate checkout, run `bun add /absolute/path/to/hue-run-sdk-0.1.3.tgz` in this
example directory, then `bun install` and `bun run build`.

## Run with a synthetic provider

In the installed `chatbot` directory, set these server-only environment variables
using an ignored `.env` file or your secret manager:

```sh
HUE_API_KEY=<project service key>
HUE_BASE_URL=http://localhost:3000
HUE_CAPTURE_CONTENT=false
HUE_CHAT_MODE=synthetic
PORT=3401
```

`HUE_CAPTURE_CONTENT` and `HUE_CHAT_MODE` are required explicit decisions. Use the
actual Hue application's address for `HUE_BASE_URL`; omitting it uses
`https://app.hue.run`. Start with `node --env-file=.env dist/server.js` or provide the
variables in your process environment and run `node dist/server.js`. Open the
printed loopback URL. The app verifies the service key's project at startup.

Synthetic mode is visibly labeled. It runs the AI SDK's actual streaming and tool
execution machinery through the official test provider, returns deterministic
text-analysis results and leaves token usage unknown. It is for compatibility
checks, not evaluation of model quality. The controlled-error button intentionally
throws inside a traced tool to exercise the failure path.

## Run a real model

Set `HUE_CHAT_MODE=live`, `AI_GATEWAY_API_KEY` and `HUE_CHAT_MODEL=provider/model`.
Choose an available model from the [AI Gateway model catalog](https://ai-gateway.vercel.sh/v1/models).
The AI SDK uses the actual gateway provider. A missing key/model or provider
failure produces an error; there is no synthetic fallback. Ask “Count the words
in: ...” to exercise the tool. Calls may incur your normal provider charges.

This example binds to loopback and is intended for local verification. It has no
user authentication, deployment integration or production rate limiter. The API
key stays in the server process. Browser requests are capped at 32 KiB. Content
capture affects telemetry storage, not the text shown to the person chatting.

For acceptance, send a normal request and a controlled error with the same
session, verify root/provider/tool spans and correlated logs in Hue, then repeat
with content capture disabled. Trace IDs are shown on the page. Telemetry export
failures are displayed separately from provider errors; the app waits for both
signals before it reports telemetry accepted.

Automated receiver acceptance is available from the installed chatbot:

```sh
node --env-file=.env scripts/acceptance.mjs
```

It starts the real Node server separately for each capture policy, exercises
streaming text, the tool and the controlled error, and requires successful
acknowledgement for both telemetry signals. It prints trace/session IDs and
counts without the project key. The SDK package verifier runs this same script
against an independent HTTP/protobuf capture server as part of package checks.
