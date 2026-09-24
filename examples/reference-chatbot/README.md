# Standalone Hue reference chatbot

A Node.js 22+ (or Bun 1.4) HTTP server with a small streaming chat page, Vercel AI SDK 7
`ToolLoopAgent`, a real text-statistics tool and a controlled-error action. The
browser receives streamed model text and a trace ID; the server exports standard
OTLP traces and correlated message logs. It imports only the packed public SDK.

## Install and build

From this directory, install the published SDK and build:

```sh
bun install
bun run build
```

`bun install` resolves `@hue-run/sdk` from npm. To test an unpublished archive instead, run
`node packages/sdk-typescript/scripts/verify-package.mjs` from the repository root: it copies this
example, points it at the freshly packed tarball, builds it and runs the acceptance script, then
prints the `chatbot` directory it created. It never publishes anything.

## Run with a synthetic provider

In the installed `chatbot` directory, set these server-only environment variables
using an ignored `.env` file or your secret manager:

```sh
HUE_API_KEY=<project service key>
HUE_CAPTURE_CONTENT=true
HUE_CHAT_MODE=synthetic
PORT=3401
```

`HUE_CAPTURE_CONTENT` and `HUE_CHAT_MODE` are required explicit decisions.
`HUE_CAPTURE_CONTENT=true`, the recommended setting, records prompts, responses and tool
inputs/outputs so you can inspect full traces in Hue; `false` sends metadata only, for when a
policy forbids sending that content. Set
`HUE_BASE_URL` only for a different Hue deployment; omitting it uses
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
with `HUE_CAPTURE_CONTENT=false` to check the metadata-only opt-out. Trace IDs are shown on the page. Telemetry export
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
