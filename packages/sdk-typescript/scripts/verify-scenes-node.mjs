import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
const consumer = resolve(process.argv[2] ?? ".");
const require = createRequire(join(consumer, "package.json"));
import {
  ScenesClient,
  CaptureSession,
  Playback,
  wrapTool,
  canonical,
  wrapFetch,
} from "@hue/sdk/scenes";
import { installNodeHttpCapture } from "@hue/sdk/scenes/node";
import axios from "axios";
const hash = (x) => createHash("sha256").update(x).digest("hex");
const scenes = new Map(),
  artifacts = new Map();
let upstream = 0;
const replayEvents = [];
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const data = bytes.length ? JSON.parse(bytes) : {};
    const url = req.url;
    if (url.startsWith("/source")) {
      upstream++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: url, body: data }));
      return;
    }
    if (url === "/unselected") {
      upstream++;
      res.end("live");
      return;
    }
    assert.equal(req.headers.authorization, "Bearer synthetic-scenes-node-key");
    res.setHeader("content-type", "application/json");
    const reply = (x) => res.end(JSON.stringify(x));
    if (url === "/api/v1/scenes") {
      const id = `scene-${scenes.size + 1}`;
      scenes.set(id, {
        id,
        revision: 1,
        options: data,
        observations: [],
        sources: [],
        producers: [],
      });
      reply({ id, captureRevision: 1 });
      return;
    }
    if (url === "/api/v1/scene-replays") {
      reply({ id: "replay" });
      return;
    }
    if (url.endsWith("/events")) {
      replayEvents.push(...data.events);
      reply({ accepted: data.events.length });
      return;
    }
    if (url === "/api/v1/scene-replays/replay/complete") {
      reply({ id: "replay", state: data.state, missCount: 0 });
      return;
    }
    const match = url.match(/^\/api\/v1\/scenes\/(scene-\d+)\/(.*)$/);
    if (match) {
      const s = scenes.get(match[1]),
        op = match[2];
      if (op === "observations") {
        s.observations.push(...data.observations);
        reply({
          accepted: data.observations.length,
          captureRevision: ++s.revision,
        });
        return;
      }
      if (op === "sources") {
        s.sources.push(...data.sources);
        reply({ accepted: data.sources.length, captureRevision: ++s.revision });
        return;
      }
      if (op === "finalize") {
        s.manifest = {
          schemaVersion: "1",
          sceneId: s.id,
          projectId: "project",
          revision: s.revision,
          externalTraceId: s.options.externalTraceId,
          bindings: s.options.bindings,
          observations: s.observations,
          sources: s.sources,
          producers: data.producers,
          createdAt: "2026-09-15",
        };
        s.digest = hash(canonical(s.manifest));
        reply({ sceneId: s.id, revision: s.revision, digest: s.digest });
        return;
      }
      if (op.startsWith("revisions/")) {
        reply({ manifest: s.manifest, digest: s.digest });
        return;
      }
    }
    res.writeHead(404).end();
  } catch (e) {
    console.error("Synthetic receiver failure", e);
    res.writeHead(400).end();
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const native = (url, options = {}) =>
  new Promise((resolve, reject) => {
    const req = httpRequest(url, options, (res) => {
      const b = [];
      res.on("data", (x) => b.push(x));
      res.on("end", () =>
        resolve({ status: res.statusCode, body: Buffer.concat(b).toString() }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(options.body);
  });
const client = new ScenesClient({
  apiKey: "synthetic-scenes-node-key",
  capture: true,
  baseUrl,
});
const installed = installNodeHttpCapture();
let child;
try {
  const binding = {
    id: "http",
    kind: "http",
    contractVersion: "1",
    http: { origin: baseUrl, pathPrefix: "/source" },
  };
  const capture = await CaptureSession.create(client, {
    bindings: [binding],
    externalTraceId: "1".repeat(32),
  });
  await capture.run(async () => {
    assert.equal(
      JSON.parse((await native(`${baseUrl}/source/native`)).body).path,
      "/source/native",
    );
    assert.equal(
      (await axios.get(`${baseUrl}/source/axios`, { adapter: "http" })).data
        .path,
      "/source/axios",
    );
    assert.equal(
      JSON.parse(
        (
          await native(`${baseUrl}/source/post`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": "7",
            },
            body: '{"n":1}',
          })
        ).body,
      ).body.n,
      1,
    );
  });
  const pin = await capture.finalize();
  assert.equal(scenes.get(pin.sceneId).observations.length, 6);
  const replay = await Playback.load(client, pin, ["http"]);
  const before = upstream;
  await replay.run(async () => {
    assert.equal(
      (await axios.get(`${baseUrl}/source/axios`, { adapter: "http" })).data
        .path,
      "/source/axios",
    );
    assert.equal(
      JSON.parse((await native(`${baseUrl}/source/native`)).body).path,
      "/source/native",
    );
    assert.equal(
      JSON.parse(
        (
          await native(`${baseUrl}/source/post`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": "7",
            },
            body: '{"n":1}',
          })
        ).body,
      ).body.n,
      1,
    );
    await assert.rejects(
      native(`${baseUrl}/source/new`),
      (e) => e.code === "HUE_SNAPSHOT_MISS",
    );
    await assert.rejects(
      native(`${baseUrl}/source/native`, { method: "DELETE" }),
      (e) => e.code === "HUE_SNAPSHOT_MISS",
    );
    assert.equal(upstream, before);
    assert.equal((await native(`${baseUrl}/unselected`)).body, "live");
  });
  await replay.complete();
  // Request-valued fetch calls retain live body ownership even when capture marks them unsupported.
  const f = wrapFetch();
  const request = new Request(`${baseUrl}/source/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"n":2}',
  });
  await capture.run(async () => {
    assert.equal((await (await f(request)).json()).body.n, 2);
  });
  // Native Node requires duplex for stream overrides; metadata inspection must not
  // construct a second Request that drops that option or takes body ownership.
  await capture.run(async () => {
    for (const path of ["/source/stream", "/unselected"]) {
      const streamed = new Request(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const response = await f(streamed, {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"n":3}'));
            controller.close();
          },
        }),
        duplex: "half",
      });
      assert.equal(response.status, 200);
      if (path === "/source/stream")
        assert.equal((await response.json()).body.n, 3);
      else assert.equal(await response.text(), "live");
    }
  });

  let beginRead;
  const reading = new Promise((resolve) => {
    beginRead = resolve;
  });
  const cancelled = [];
  const pendingBody = new ReadableStream(
    {
      pull() {
        beginRead();
        return new Promise(() => {});
      },
      cancel(reason) {
        cancelled.push(reason);
      },
    },
    { highWaterMark: 0 },
  );
  const slowFetch = wrapFetch(async () => new Response(pendingBody));
  const slow = await capture.run(() => slowFetch(`${baseUrl}/source/slow`));
  const reader = slow.body.getReader();
  const read = reader.read();
  await reading;
  await reader.cancel("synthetic-cancellation");
  assert.deepEqual(await read, { done: true, value: undefined });
  assert.deepEqual(cancelled, ["synthetic-cancellation"]);
  assert.equal(pendingBody.locked, false);
  const toolBinding = {
    id: "docs",
    kind: "tool",
    contractVersion: "1",
    operations: [
      {
        name: "search",
        description: "Find source documents",
        inputSchema: {
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"],
        },
      },
    ],
  };
  const toolCapture = await CaptureSession.create(client, {
    bindings: [toolBinding],
    externalTraceId: "2".repeat(32),
  });
  const tool = wrapTool("docs", "search", ({ q }) => ({
    q,
    title: "Captured source",
  }));
  toolCapture.run(() => tool({ q: "known" }));
  const toolPin = await toolCapture.finalize();
  const cli = new URL("./scenes-cli.js", import.meta.resolve("@hue/sdk/scenes"))
    .pathname;
  child = spawn(
    process.execPath,
    [
      cli,
      "--scene",
      toolPin.sceneId,
      "--revision",
      String(toolPin.revision),
      "--digest",
      toolPin.digest,
      "--binding",
      "docs",
    ],
    {
      env: {
        ...process.env,
        HUE_API_KEY: "synthetic-scenes-node-key",
        HUE_BASE_URL: baseUrl,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "",
    stderr = "",
    id = 0;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
    while (output.includes("\n")) {
      const end = output.indexOf("\n"),
        line = output.slice(0, end);
      output = output.slice(end + 1);
      const message = JSON.parse(line);
      if (message.id !== undefined) {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    }
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.on("exit", (code) => {
    for (const fn of pending.values())
      fn({ error: { message: `CLI exit ${code}: ${stderr}` } });
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const key = ++id,
        timer = setTimeout(
          () => reject(new Error(`MCP timeout ${method}: ${stderr}`)),
          5000,
        );
      pending.set(key, (message) => {
        clearTimeout(timer);
        message.error
          ? reject(new Error(JSON.stringify(message.error)))
          : resolve(message.result);
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: key, method, params }) + "\n",
      );
    });
  assert.ok(
    (
      await call("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "synthetic", version: "1" },
      })
    ).capabilities.tools,
  );
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );
  const list = await call("tools/list", {});
  assert.equal(list.tools[0].name, "search");
  assert.deepEqual(
    list.tools[0].inputSchema,
    toolBinding.operations[0].inputSchema,
  );
  const success = await call("tools/call", {
    name: "search",
    arguments: { q: "known" },
  });
  assert.equal(JSON.parse(success.content[0].text).title, "Captured source");
  const miss = await call("tools/call", {
    name: "search",
    arguments: { q: "changed" },
  });
  assert.equal(miss.isError, true);
  assert.equal(JSON.parse(miss.content[0].text).code, "HUE_SNAPSHOT_MISS");
  const exited = once(child, "exit");
  child.stdin.end();
  assert.equal((await exited)[0], 0);
  assert.equal(stderr, "");
  console.log(
    JSON.stringify({
      node: process.version,
      scenes:
        "native HTTP, Axios, Request bodies, installed imports and stdio MCP passed",
      upstream,
      replayEvents: replayEvents.length,
    }),
  );
} finally {
  child?.kill();
  installed.dispose();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
