import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";

const consumer = resolve(process.argv[2]);
const scenario = process.argv[3];
if (!scenario) {
  const cases = [
    "4:128",
    "16:128",
    "64:128",
    "16:8",
    "16:1",
    "64:0",
    "16:128:long",
    "0:128:long",
    "0:128:receiver",
    "vercel:4",
    "vercel:16",
  ];
  async function run(value) {
    await new Promise((done, fail) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), consumer, value], {
        stdio: "inherit",
        env: process.env,
      });
      child.once("error", fail);
      child.once("close", (code) =>
        code === 0 ? done() : fail(new Error(`HTTP provider policy case ${value} exited ${code}`)),
      );
    });
  }
  // Provider globals remain isolated while two independent policy cases run at a time.
  for (let index = 0; index < cases.length; index += 2)
    await Promise.all(cases.slice(index, index + 2).map(run));
  console.log(
    `http-capture provider policies ${process.version}${globalThis.Bun ? ` Bun ${globalThis.Bun.version}` : ""}: ${cases.length} installed cases passed`,
  );
  process.exit(0);
}

const require = createRequire(join(consumer, "package.json"));
const { createHueTransport } = await import(pathToFileURL(require.resolve("@hue-run/sdk")));
const { trace, context, SpanKind } = require("@opentelemetry/api");
const protobuf = require("protobufjs/light.js");
const schema = JSON.parse(
  await readFile(new URL("../tests/fixtures/otlp-schema.json", import.meta.url), "utf8"),
);
const wireType = protobuf.Root.fromJSON(schema).lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);
const wire = [];
const raw = [];
const received = [];
const values = (span) =>
  Object.fromEntries((span.attributes ?? []).map(({ key, value }) => [key, value]));
const dataAttributes = (span) =>
  (span.attributes ?? []).filter(
    ({ key }) => !["hue.span_type", "hue.pending_parent_id"].includes(key),
  );
const collect = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};
async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
async function stop(endpoint) {
  endpoint.server.closeAllConnections();
  await new Promise((done) => endpoint.server.close(done));
}
const receiverCap = scenario.endsWith(":receiver") ? 256 * 1024 : undefined;
const receiver = await listen(async (request, response) => {
  let bytes = await collect(request);
  if (request.headers["content-encoding"] === "gzip") bytes = gunzipSync(bytes);
  if (request.url.endsWith("/traces")) {
    const data = wireType.toObject(wireType.decode(bytes), { longs: String, bytes: String });
    wire.push(
      ...(data.resourceSpans ?? []).flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
      ),
    );
  }
  response.setHeader("content-type", "application/x-protobuf");
  response.setHeader("Hue-Pending-Spans", "1");
  if (receiverCap) response.setHeader("Hue-Max-Value-Bytes", String(receiverCap));
  response.end();
});
const responseBody = JSON.stringify({ message: "x".repeat(receiverCap ? 300000 : 200) });
const app = await listen(async (request, response) => {
  const body = await collect(request);
  received.push({ path: request.url, body: body.toString(), headers: request.headers });
  response.setHeader("content-type", "application/json");
  response.end(scenario.startsWith("vercel:") ? '{"ok":true}' : responseBody);
});

if (scenario.startsWith("vercel:")) {
  const limit = Number(scenario.split(":")[1]);
  const { registerOTel } = await import(pathToFileURL(require.resolve("@vercel/otel")));
  const hue = createHueTransport({
    apiKey: "synthetic-vercel-short",
    serviceName: "vercel-short",
    baseUrl: receiver.url,
    liveSpans: false,
  });
  const processor = {
    onStart(span, parent) {
      hue.spanProcessor.onStart(span, parent);
    },
    onEnd(span) {
      raw.push({ name: span.name, attributes: { ...span.attributes } });
      hue.spanProcessor.onEnd(span);
    },
    async forceFlush() {
      await hue.spanProcessor.forceFlush();
    },
    async shutdown() {},
  };
  registerOTel({
    serviceName: "vercel-short",
    spanProcessors: [processor],
    propagators: ["none"],
    spanLimits: { attributeValueLengthLimit: limit },
  });
  const provider = trace.getTracerProvider().getDelegate();
  const original = `${app.url}/token/synthetic-original-secret/items?access_token=synthetic-original-query`;
  try {
    assert.deepEqual(
      await fetch(original, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"id":"synthetic-request"}',
      }).then((response) => response.json()),
      { ok: true },
    );
    await provider.forceFlush();
    await hue.flush();
    assert.ok(wire.some((span) => span.kind === 3));
    assert.ok(
      raw.some((span) => span.name.includes(original)),
      "the vendor's unmatched original span name remains unchanged",
    );
    assert.equal(
      received[0].path,
      "/token/synthetic-original-secret/items?access_token=synthetic-original-query",
    );
    assert.ok(
      !JSON.stringify(wire).includes("synthetic-original-secret"),
      "unmatched CLIENT names cannot expose capability path credentials",
    );
    assert.ok(
      !JSON.stringify(wire).includes("synthetic-original-query"),
      "unmatched CLIENT names cannot expose query credentials",
    );
    console.log(
      `http-capture actual Vercel short provider ${limit}: wire private, vendor original unchanged`,
    );
  } finally {
    await hue.shutdown();
    await provider.shutdown();
    await stop(app);
    await stop(receiver);
  }
  process.exit(0);
}

const [limitText, countText, mode] = scenario.split(":");
const limit = Number(limitText);
const count = Number(countText);
const { TracerProvider } = require("@opentelemetry/sdk-trace");
const { AsyncLocalStorageContextManager } = require("@opentelemetry/context-async-hooks");
const shortUrl = `http://a:${app.server.address().port}/`;
const callbackUrl = `${shortUrl}${"r".repeat(100)}`;
const hue = createHueTransport({
  apiKey: "synthetic-provider-limit",
  serviceName: "provider-limit",
  baseUrl: receiver.url,
  liveSpans: true,
  ...(mode === "long"
    ? { redact: (value, path) => (path === "attributes.url.full" ? callbackUrl : value) }
    : {}),
});
const inspector = {
  onStart() {},
  onEnd(span) {
    raw.push({ name: span.name, attributes: { ...span.attributes } });
  },
  async forceFlush() {},
  async shutdown() {},
};
const provider = new TracerProvider({
  spanLimits: { attributeValueLengthLimit: limit, attributeCountLimit: count },
  spanProcessors: [hue.spanProcessor, inspector],
});
trace.setGlobalTracerProvider(provider);
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
const tracer = provider.getTracer("synthetic-borrowed-provider");
try {
  tracer.startSpan("prime receiver capabilities").end();
  await provider.forceFlush();
  await hue.flush();
  await tracer.startActiveSpan(
    "ai.http",
    { kind: SpanKind.CLIENT, attributes: { "http.request.method": "GET", "url.full": shortUrl } },
    async (span) => {
      try {
        await new Promise((done, fail) => {
          http
            .get(
              shortUrl,
              {
                lookup(_host, options, callback) {
                  callback(
                    null,
                    options?.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1",
                    4,
                  );
                },
              },
              async (response) => {
                try {
                  assert.equal((await collect(response)).toString(), responseBody);
                  done();
                } catch (error) {
                  fail(error);
                }
              },
            )
            .once("error", fail);
        });
        await delay(650);
        await provider.forceFlush();
        await hue.flush();
        await delay(150);
      } finally {
        span.end();
      }
    },
  );
  await provider.forceFlush();
  await hue.flush();
  const observed = wire.filter((span) => values(span)["http.response.status_code"]);
  assert.ok(wire.some((span) => span.kind === 3));
  for (const span of wire.filter((span) => span.kind === 3)) {
    assert.ok(
      dataAttributes(span).length <= count,
      "private metadata cannot exceed the provider attribute count",
    );
    for (const { key, value } of dataAttributes(span))
      if (value.stringValue !== undefined && limit > 0)
        assert.ok(
          value.stringValue.length <= limit,
          `${key} cannot exceed the provider string limit`,
        );
  }
  if (count === 0 || count === 1) {
    assert.ok(
      wire
        .filter((span) => span.kind === 3)
        .every((span) => values(span)["output.value"] === undefined),
      "dropped output cannot be restored",
    );
  } else {
    assert.ok(observed.length > 0);
    for (const span of observed) {
      const attributes = values(span);
      if (count === 8) {
        assert.equal(
          attributes["output.value"],
          undefined,
          "a dropped content slot cannot be restored",
        );
        assert.equal(
          attributes["hue.truncated"],
          undefined,
          "a dropped cut-list slot cannot be restored",
        );
      } else if (limit === 0 && !receiverCap) {
        assert.deepEqual(
          JSON.parse(attributes["output.value"].stringValue),
          JSON.parse(responseBody),
          "zero means the provider imposes no string-length limit",
        );
        assert.equal(attributes["url.full"].stringValue, callbackUrl);
      } else {
        const output = attributes["output.value"];
        assert.ok(output?.kvlistValue, "cut bodies must remain structured OTLP markers");
        const marker = Object.fromEntries(
          output.kvlistValue.values.map(({ key, value }) => [key, value]),
        );
        assert.equal(marker["hue.truncated"].boolValue, true);
        assert.equal(
          Number(marker["hue.truncated_bytes"].intValue),
          Buffer.byteLength(responseBody),
        );
        assert.deepEqual(
          attributes["hue.truncated"].arrayValue.values.map((value) => value.stringValue),
          ["output.value"],
        );
        assert.ok(
          !JSON.stringify(span).includes("x".repeat(80)),
          "private cuts carry no captured body overlay",
        );
      }
      if (mode === "long" && limit > 0)
        for (const key of ["url.full", "http.url", "http.target", "url.path", "resource.name"])
          assert.equal(
            attributes[key],
            undefined,
            "a URL redactor cannot bypass the provider string limit",
          );
    }
    if ((limit === 16 || limit === 64 || receiverCap) && count >= 128)
      assert.ok(
        observed.some((span) => values(span)["hue.span_type"]?.stringValue === "pending_span"),
        "live placeholders must preserve the same provider policy and cut metadata",
      );
  }
  console.log(
    `http-capture provider ${scenario}: string/count policy, final/live content and cut metadata passed`,
  );
} finally {
  await hue.shutdown();
  await provider.shutdown();
  context.disable();
  trace.disable();
  manager.disable();
  await stop(app);
  await stop(receiver);
}
