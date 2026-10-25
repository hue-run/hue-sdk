# Reference chatbot

A Node HTTP app (`examples/reference-chatbot`) serving a chat page at `/`, its settings at `/config` and a streaming `/chat` endpoint. Each request records root, model and tool spans plus correlated logs, and the stream ends with a telemetry acknowledgement event.

## Sub-features

- `chat-stream` streams `trace`, tool call, tool result, text deltas and `done`.
- `chat-error` reports a controlled error separately from telemetry.
- `chat-capture` honors `HUE_CAPTURE_CONTENT=false` (metadata only), `HUE_CAPTURE_HTTP=false`, and `HUE_CAPTURE_HTTP_BODIES=false`. The app validates and passes these options to the SDK.
- `chat-telemetry` waits for both trace and log acknowledgements before reporting `accepted`.
- `chat-http-policy` imports the app's configured Hue client in a separate acceptance child and checks a real loopback HTTP exchange in its exported OTLP.

## How to get to it (user POV)

- `bun install && bun run build && node dist/server.js` in the example, then open `http://127.0.0.1:3401/`.

## Driving it with curl

Preconditions:

- Skill Launch done (`V`, stub, `HUE_BASE_URL` and `HUE_API_KEY` exported). Run every step from the repository root; the shell never leaves it.

- **Install the branch's SDK** (about 20 s):

  ```sh
  (cd packages/sdk-typescript && bun run build && npm pack --ignore-scripts --pack-destination "$V")
  rsync -a --exclude node_modules --exclude dist examples/reference-chatbot/ "$V"/chatbot/
  example_archive="$V/hue-run-sdk-$(node -p 'require("./packages/sdk-typescript/package.json").version').tgz"
  (cd "$V"/chatbot && bun add "@hue-run/sdk@file:$example_archive" && bun run build)
  ```

- **Start it.** `HUE_CHAT_MODE=synthetic PORT=3401 node "$V"/chatbot/dist/server.js > "$V"/server.log 2>&1 & echo $! > "$V"/server.pid; sleep 1; curl -s http://127.0.0.1:3401/config`. Expected: JSON with `"mode":"synthetic"`.
- **Chat.** `curl -sN http://127.0.0.1:3401/chat -H 'content-type: application/json' -d "{\"sessionId\":\"$(python3 -c 'import uuid;print(uuid.uuid4())')\",\"messages\":[{\"role\":\"user\",\"content\":\"count the words in hello world\"}]}"`. Expected: SSE `trace`, a `textStatistics` tool call and result, text deltas, a telemetry event with `accepted`, then `done`. The stub log gains `POST /api/v1/otlp/v1/traces` and `/v1/logs` with status 200.
- **Controlled error.** Same request with `,"mode":"controlled-error"` in the body. Expected: an `error` event and telemetry still `accepted`.
- **Print the export evidence.** `cat "$V"/stub.log "$V"/server.log`.
- **Content and HTTP policies at once** (about 10 s). `node "$V"/chatbot/scripts/acceptance.mjs "$V"/chatbot` runs four combinations of content and HTTP settings against `HUE_BASE_URL` (the stub) and prints its JSON report. Each setting also imports the app's actual configured client in a separate child, sends one parented JSON request to a loopback app API, and receives its OTLP on a separate origin. The `httpPolicies` report records the trace ID, HTTP span count, content policy and real receiver acknowledgement bytes. The check decodes OTLP with the development-only `protobufjs` package and verifies the HTTP parent, method, sanitized URL, status, query, request and response. Identity-only and metadata-only modes retain one HTTP span without content; HTTP-off retains none. Raw protobuf bytes must omit credentials and, when bodies are off, all request, response and query sentinels.

## Gotchas

- `sessionId` must be a UUID; anything else returns `Invalid chat request`.
- `bun add` of the local tarball is allowed by `bunfig.toml` (`@hue-run/sdk` is excluded from the release-age cooldown); a different new package would need `--minimum-release-age 0`.
- The full package verifier also runs `acceptance.mjs` against the packed tarball; that is the CI path.
- Stop the server with `kill $(cat "$V"/server.pid)`.
