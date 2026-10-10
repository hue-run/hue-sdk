# Reference chatbot

A Node HTTP app (`examples/reference-chatbot`) serving a chat page at `/`, its settings at `/config` and a streaming `/chat` endpoint. Each request records root, model and tool spans plus correlated logs, and the stream ends with a telemetry acknowledgement event.

## Sub-features

- `chat-stream` streams `trace`, tool call, tool result, text deltas and `done`.
- `chat-error` reports a controlled error separately from telemetry.
- `chat-capture` honors `HUE_CAPTURE_CONTENT=false` (metadata only).
- `chat-telemetry` waits for both trace and log acknowledgements before reporting `accepted`.

## How to get to it (user POV)

- `bun install && bun run build && node dist/server.js` in the example, then open `http://127.0.0.1:3401/`.

## Driving it with curl

Preconditions:

- Skill Launch done (stub running, `HUE_BASE_URL` and `HUE_API_KEY` exported). Run from the repository root.

- **Install the branch's SDK** (about 20 s):

  ```sh
  (cd packages/sdk-typescript && bun run build && npm pack --ignore-scripts --pack-destination ../../.context/verify-examples)
  rsync -a --exclude node_modules --exclude dist examples/reference-chatbot/ .context/verify-examples/chatbot/
  cd .context/verify-examples/chatbot && bun add ../hue-run-sdk-*.tgz && bun run build
  ```

- **Start it.** `HUE_CHAT_MODE=synthetic PORT=3401 node dist/server.js > ../server.log 2>&1 & echo $! > ../server.pid; sleep 1; curl -s http://127.0.0.1:3401/config`. Expected: JSON with `"mode":"synthetic"`.
- **Chat.** `curl -sN http://127.0.0.1:3401/chat -H 'content-type: application/json' -d "{\"sessionId\":\"$(python3 -c 'import uuid;print(uuid.uuid4())')\",\"messages\":[{\"role\":\"user\",\"content\":\"count the words in hello world\"}]}"`. Expected: SSE `trace`, a `textStatistics` tool call and result, text deltas, a telemetry event with `accepted`, then `done`. The stub log gains `POST /api/v1/otlp/v1/traces` and `/v1/logs` with status 200.
- **Controlled error.** Same request with `,"mode":"controlled-error"` in the body. Expected: an `error` event and telemetry still `accepted`.
- **Print the export evidence.** `cat ../stub.log ../server.log` from the chatbot copy.
- **Both capture policies at once** (about 10 s). `node scripts/acceptance.mjs` from the chatbot copy runs the server for `HUE_CAPTURE_CONTENT=true` and `false` against `HUE_BASE_URL` (the stub) and prints its JSON report.

## Gotchas

- `sessionId` must be a UUID; anything else returns `Invalid chat request`.
- `bun add` of the local tarball is allowed by `bunfig.toml` (`@hue-run/sdk` is excluded from the release-age cooldown); a different new package would need `--minimum-release-age 0`.
- The full package verifier also runs `acceptance.mjs` against the packed tarball; that is the CI path.
- Stop the server with `kill $(cat .context/verify-examples/server.pid)`.
