import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { HueWorldError, WorldClient, WorldModelClient } from "../src/world.js";

const key = "synthetic-preparation-key";
const at = "2026-10-17T00:00:00Z";
const preparing = () =>
  new Response("private response", {
    status: 503,
    headers: { "X-Hue-Diagnostic": "world_preparing", "Retry-After": "0" },
  });

test("preparing World operations preserve bytes beyond ordinary attempts and materialization identities are per call", async () => {
  const requests: { path: string; body: string }[] = [];
  let calls = 0;
  const input = { at };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({ path: new URL(request.url).pathname, body: await request.text() });
      input.at = "2026-11-01T00:00:00Z";
      return ++calls % 6 ? preparing() : Response.json({ ready: true });
    },
  });
  const modelId = randomUUID();
  const client = new WorldModelClient({ apiKey: key, baseUrl: server.url.origin, maxAttempts: 1 });
  const world = new WorldClient({ apiKey: key, baseUrl: server.url.origin, maxAttempts: 1 });
  try {
    await client.materialize(modelId, input);
    await client.materialize(modelId, { at });
    await client.startInstance(modelId, { at, idempotencyKey: "stable-start" });
    await client.reproduceInstance(randomUUID(), { idempotencyKey: "stable-reproduction" });
    await world.createRun({ environmentVersionId: randomUUID(), idempotencyKey: "stable-run" });
    await world.createInstance({ worldVersionId: randomUUID(), idempotencyKey: "stable-instance" });
    for (let i = 0; i < requests.length; i += 6)
      expect(requests.slice(i, i + 6)).toEqual(Array(6).fill(requests[i]));
    const first = JSON.parse(requests[0]!.body) as { at: string; idempotencyKey: string };
    const second = JSON.parse(requests[6]!.body) as { idempotencyKey: string };
    expect(first.at).toBe(at);
    expect(first.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    expect(requests).toHaveLength(36);
  } finally {
    server.stop(true);
  }
}, 15_000);

test("ordinary and terminal failures retain maxAttempts and unrelated reads do not preparation-poll", async () => {
  let calls = 0;
  let diagnostic = "world_unavailable";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;
      return new Response("private response", {
        status: 503,
        headers: { "X-Hue-Diagnostic": diagnostic, "Retry-After": "0" },
      });
    },
  });
  const client = new WorldModelClient({ apiKey: key, baseUrl: server.url.origin, maxAttempts: 2 });
  try {
    await expect(client.materialize(randomUUID(), { at })).rejects.toBeInstanceOf(HueWorldError);
    expect(calls).toBe(2);
    diagnostic = "world_preparing";
    await expect(client.getModel(randomUUID())).rejects.toBeInstanceOf(HueWorldError);
    expect(calls).toBe(4);
    diagnostic = "WORLD_PREPARING";
    await expect(
      client.startInstance(randomUUID(), { at, idempotencyKey: "start" }),
    ).rejects.toBeInstanceOf(HueWorldError);
    expect(calls).toBe(6);
  } finally {
    server.stop(true);
  }
});

test("preparation has a fixed monotonic deadline across later responses", async () => {
  const now = performance.now.bind(performance);
  let offset = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now() + offset);
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      if (++calls === 2) offset = 120_001;
      return preparing();
    },
  });
  try {
    const client = new WorldModelClient({
      apiKey: key,
      baseUrl: server.url.origin,
      maxAttempts: 1,
    });
    await expect(client.materialize(randomUUID(), { at })).rejects.toBeInstanceOf(HueWorldError);
    expect(calls).toBe(2);
  } finally {
    clock.mockRestore();
    server.stop(true);
  }
});

for (const phase of ["sleep", "request"] as const)
  test(`cancellation ends preparation during ${phase}`, async () => {
    const controller = new AbortController();
    let calls = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        calls++;
        if (phase === "request" && calls === 1) return preparing();
        setTimeout(() => controller.abort(), 30);
        if (phase === "request") return new Promise<Response>(() => {});
        return new Response(null, {
          status: 503,
          headers: { "X-Hue-Diagnostic": "world_preparing", "Retry-After": "10" },
        });
      },
    });
    const start = performance.now();
    try {
      const client = new WorldModelClient({ apiKey: key, baseUrl: server.url.origin });
      await expect(
        client.materialize(randomUUID(), { at }, { signal: controller.signal }),
      ).rejects.toBeInstanceOf(HueWorldError);
      expect(performance.now() - start).toBeLessThan(1000);
      expect(calls).toBe(phase === "request" ? 2 : 1);
    } finally {
      server.stop(true);
    }
  });
