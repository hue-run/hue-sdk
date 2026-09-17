import { createServer } from "node:http";
import { once } from "node:events";
import { strict as assert } from "node:assert";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";

const [consumer] = process.argv.slice(2);
const { createHue, createHueSafe, HueExportError } = await import(
  pathToFileURL(join(consumer, "node_modules/@hue-run/sdk/dist/index.js")).href
);
// A large lazy string costs little until scanning flattens it. Reject it by
// length before Unicode/NUL/UTF-8 checks allocate its complete backing storage.
// Isolate peak-memory measurement from the rest of this verification process.
const redactionProbe = spawnSync(
  process.execPath,
  [
    "--max-old-space-size=64",
    "--unhandled-rejections=strict",
    "--input-type=module",
    "-e",
    `
      import { strict as assert } from "node:assert";
      const { createHue } = await import(process.argv[1]);
      const hue = createHue({
        apiKey: "synthetic",
        serviceName: "oversized-redactor",
        captureContent: true,
        baseUrl: "http://127.0.0.1:1",
        timeoutMillis: 100,
        redact: () => "x".repeat(128 * 1024 * 1024),
      });
      assert.equal(await hue.withSpan("probe", () => 42, { input: "small" }), 42);
      const before = process.resourceUsage().maxRSS;
      const delivery = await hue.flushSafe();
      const addedPeakKiB = process.resourceUsage().maxRSS - before;
      assert.equal(delivery.ok, false);
      assert.equal(delivery.report.failedSpans, 1);
      assert.ok(addedPeakKiB < 64 * 1024, "Oversized redactor output was materialized before rejection");
      await hue.shutdownSafe();
      console.log(JSON.stringify({ oversizedRedaction: "passed", addedPeakKiB }));
    `,
    pathToFileURL(join(consumer, "node_modules/@hue-run/sdk/dist/index.js")).href,
  ],
  { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 },
);
assert.equal(redactionProbe.status, 0, redactionProbe.stderr || redactionProbe.error?.message);
console.log(redactionProbe.stdout.trim());
// Exercise the installed snapshot with a genuinely concurrent growing view.
// No hooks or mocked constructors create the race; vary the worker's delay to
// cover growth before, during and after admission while bounding total work.
const { snapshotLog } = await import(
  pathToFileURL(join(consumer, "node_modules/@hue-run/sdk/dist/snapshot.js")).href
);
const control = new Int32Array(new SharedArrayBuffer(4));
const growthWorker = new Worker(
  `const { parentPort, workerData } = require("node:worker_threads");
   const control = new Int32Array(workerData);
   parentPort.on("message", ({ buffer, delay }) => {
     Atomics.store(control, 0, 1);
     Atomics.notify(control, 0);
     while (Atomics.load(control, 0) !== 2) {}
     for (let index = 0; index < delay; index++) Atomics.load(control, 0);
     buffer.grow(65_536);
     Atomics.store(control, 0, 3);
     Atomics.notify(control, 0);
   });`,
  { eval: true, workerData: control.buffer },
);
function awaitGrowthState(expected) {
  const deadline = performance.now() + 2000;
  for (let state = Atomics.load(control, 0); state !== expected; state = Atomics.load(control, 0)) {
    assert.ok(performance.now() < deadline, "Shared-buffer test worker timed out");
    Atomics.wait(control, 0, state, 100);
  }
}
let sharedSnapshots = 0;
let sharedDrops = 0;
try {
  const deadline = performance.now() + 10_000;
  for (let attempt = 0; attempt < 5000; attempt++) {
    assert.ok(performance.now() < deadline, "Shared-buffer snapshot probe exceeded its budget");
    const buffer = new SharedArrayBuffer(1, { maxByteLength: 65_536 });
    const body = new Uint8Array(buffer);
    Atomics.store(control, 0, 0);
    growthWorker.postMessage({ buffer, delay: attempt % 512 });
    awaitGrowthState(1);
    let snapshot;
    try {
      snapshot = snapshotLog(
        {
          get body() {
            Atomics.store(control, 0, 2);
            return body;
          },
          attributes: {},
          instrumentationScope: { name: "shared-memory-budget" },
          resource: { asyncAttributesPending: false, getRawAttributes: () => [] },
        },
        8192,
      );
      sharedSnapshots++;
    } catch (error) {
      assert.ok(error instanceof RangeError, "Concurrent growth may only reject admission");
      sharedDrops++;
    }
    awaitGrowthState(3);
    if (snapshot) {
      assert.ok(
        snapshot.record.body.byteLength <= snapshot.bytes,
        "Concurrent growth retained more bytes than the admitted snapshot budget",
      );
      assert.ok(snapshot.bytes <= 8192);
      assert.notEqual(snapshot.record.body.buffer, buffer);
    }
  }
  assert.equal(sharedSnapshots + sharedDrops, 5000);
} finally {
  await growthWorker.terminate();
}
console.log(JSON.stringify({ sharedMemoryBudget: "passed", sharedSnapshots, sharedDrops }));
let mode = "unauthorized";
let closedResponses = 0;
let requests = 0;
const server = createServer(async (request, response) => {
  requests++;
  for await (const _chunk of request) {
    /* Drain upload before replying. */
  }
  response.on("close", () => {
    closedResponses++;
  });
  if (mode === "unauthorized") {
    response.writeHead(401).end("synthetic-private-body");
    return;
  }
  if (mode === "incomplete") {
    response.writeHead(200, { "Content-Type": "application/x-protobuf", "Content-Length": "4" });
    response.flushHeaders();
    response.write(Buffer.from([0]));
    setTimeout(() => response.destroy(), 10);
    return;
  }
  if (mode === "trickle") {
    response.writeHead(200, { "Content-Type": "application/x-protobuf" });
    response.flushHeaders();
    const timer = setInterval(() => response.write(Buffer.from([0])), 10);
    response.on("close", () => clearInterval(timer));
    return;
  }
  response.writeHead(200, { "Content-Type": "application/x-protobuf" }).end();
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const options = {
  apiKey: "synthetic-safety-key",
  serviceName: "node-safety",
  captureContent: true,
  baseUrl: `http://127.0.0.1:${server.address().port}`,
};
try {
  // Node's strict unhandled-rejection mode used by the parent catches the
  // original asynchronous diagnostic callback process-crash regression.
  let diagnostics = 0;
  const hue = createHue({
    ...options,
    onExportIssue: async () => {
      diagnostics++;
      throw new Error("private diagnostic failure");
    },
  });
  let sideEffects = 0;
  const huge = "x".repeat(262144);
  assert.equal(
    await hue.tool("side-effect", huge, () => {
      sideEffects++;
      return huge;
    }),
    huge,
  );
  assert.equal(sideEffects, 1);
  assert.equal((await hue.flushSafe()).ok, false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(diagnostics, 1);
  assert.equal(hue.transport.getReport().instrumentationFailures, 2);
  const original = new Error("original application exception");
  await assert.rejects(
    (async () => {
      try {
        throw original;
      } finally {
        await hue.shutdownSafe();
      }
    })(),
    (error) => error === original,
  );

  mode = "trickle";
  const delayed = createHue({ ...options, timeoutMillis: 100 });
  await delayed.withSpan("trickle", () => "ok");
  const start = performance.now();
  await assert.rejects(delayed.flush(), HueExportError);
  assert.ok(
    performance.now() - start < 750,
    "Total export deadline includes a continuously streaming response",
  );
  assert.equal(delayed.transport.getReport().acceptedSpans, 0);
  assert.equal(delayed.transport.getReport().failedSpans, 1);
  await delayed.shutdownSafe();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(closedResponses, requests, "Deadline closes the active HTTP response");

  mode = "incomplete";
  const incomplete = createHue(options);
  await incomplete.withSpan("incomplete", () => 42);
  await assert.rejects(incomplete.flush(), HueExportError);
  assert.equal(incomplete.transport.getReport().acceptedSpans, 0);
  assert.equal(incomplete.transport.getReport().failedSpans, 1);
  await incomplete.shutdownSafe();
  mode = "success";
  const badRedactor = createHue({
    ...options,
    redact: async () => {
      throw new Error("private redactor failure");
    },
  });
  assert.equal(
    await badRedactor.withSpan("invalid-redactor", () => 42, { input: "synthetic" }),
    42,
  );
  assert.equal((await badRedactor.flushSafe()).ok, false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(badRedactor.transport.getReport().failedSpans, 1);
  await badRedactor.shutdownSafe();
  const healthy = createHue(options);
  await healthy.withSpan("healthy", () => null);
  assert.equal((await healthy.flushSafe()).ok, true);
  assert.equal((await healthy.shutdownSafe()).ok, true);
  const disabled = createHueSafe({ ...options, apiKey: "" });
  assert.equal(disabled.enabled, false);
  assert.equal(await disabled.withSpan("disabled", () => 42), 42);
  await disabled.shutdownSafe();
  console.log(
    JSON.stringify({
      node: process.version,
      installedSafetyChecks: "passed",
      sideEffects,
      diagnostics,
      requestDeadlineMillis: 100,
    }),
  );
} finally {
  server.close();
  server.closeAllConnections();
}
