# TypeScript tracing

An application creates a client with `createHue`, records spans and tools, and receives an export report from `flush()` that states what Hue accepted.

## Sub-features

- `ts-span` records `withSpan`, `tool` and `model` spans with input and output.
- `ts-capture` honors `captureContent` and redaction before export.
- `ts-ack` reports accepted, rejected and failed records truthfully from the receiver's acknowledgement.
- `ts-lifecycle` covers `flush`, `shutdown` and the fail-open `*Safe` variants.

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
