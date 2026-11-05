import { createServer, type IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { parseArgs } from "node:util";
import { configSchema, loginEvent, loginSchema } from "./contracts.ts";
import { Store } from "./store.ts";
import { Worker } from "./worker.ts";

const { values } = parseArgs({
  options: { config: { type: "string" }, "state-dir": { type: "string" } },
  strict: true,
});
if (!values.config || !values["state-dir"]) throw new Error("Provide --config and --state-dir");
if (process.platform === "win32") throw new Error("A POSIX process host is required");
const config = configSchema.parse(JSON.parse(readFileSync(values.config, "utf8")));
const token = process.env.HUE_HOOK_CONTROL_TOKEN;
if (!token || token.length < 32)
  throw new Error("HUE_HOOK_CONTROL_TOKEN must contain at least 32 characters");
const store = new Store(values["state-dir"], config);
const worker = new Worker(config, store, process.env);
await worker.initialize();

async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") throw new Error("invalid_request");
  const parts: Buffer[] = [];
  let length = 0;
  for await (const part of request) {
    const bytes = Buffer.from(part);
    length += bytes.length;
    if (length > 4096) throw new Error("invalid_request");
    parts.push(bytes);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}
const server = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    response.writeHead(401).end('{"error":"unauthorized"}');
    return;
  }
  try {
    if (request.method === "GET" && request.url === "/status") {
      response.end(
        JSON.stringify({
          projectId: config.projectId,
          worldId: config.worldId,
          connectionId: config.connectionId,
          events: store.status(),
        }),
      );
      return;
    }
    if (request.method !== "POST" || request.url !== "/auth/outcomes") {
      response.writeHead(404).end('{"error":"not_found"}');
      return;
    }
    const event = loginEvent(config, loginSchema.parse(await body(request)));
    if (!store.existing(event)) {
      if (store.terminal()) {
        response.writeHead(409).end('{"error":"world_not_live"}');
        return;
      }
      const world = await worker.world().catch(() => null);
      if (!world) {
        response.setHeader("retry-after", "5");
        response.writeHead(503).end('{"error":"world_status_unavailable"}');
        return;
      }
      if (world.lifecycle !== "live" || world.activity !== "active") {
        response.writeHead(409).end('{"error":"world_not_live"}');
        return;
      }
      store.enqueue(event);
    }
    response
      .writeHead(202)
      .end(JSON.stringify({ idempotencyKey: event.idempotencyKey, accepted: true }));
  } catch (error) {
    const conflict = error instanceof Error && error.message === "idempotency_conflict";
    const notLive = error instanceof Error && error.message === "world_not_live";
    const full = error instanceof Error && error.message === "queue_full";
    if (full) response.setHeader("retry-after", "5");
    response.writeHead(conflict || notLive ? 409 : full ? 429 : 400).end(
      JSON.stringify({
        error: conflict
          ? "idempotency_conflict"
          : notLive
            ? "world_not_live"
            : full
              ? "queue_full"
              : "request_refused",
      }),
    );
  }
});
server.requestTimeout = 10_000;
server.headersTimeout = 10_000;
server.maxHeadersCount = 32;
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.port, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("listen_failed");
console.log(
  JSON.stringify({
    event: "hooks.ready",
    url: `http://127.0.0.1:${address.port}`,
    worldId: config.worldId,
  }),
);
const tick = () =>
  worker.tick().catch(() => {
    console.error('{"event":"hooks.retry_pending"}');
  });
const timer = setInterval(tick, 5_000);
void tick();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await worker.close();
  store.close();
}
process.on("SIGTERM", () => {
  void close();
});
process.on("SIGINT", () => {
  void close();
});
