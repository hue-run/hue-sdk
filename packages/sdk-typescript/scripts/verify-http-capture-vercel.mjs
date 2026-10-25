import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";

const consumer = resolve(process.argv[2]);
const require = createRequire(join(consumer, "package.json"));
const { createHue, createHueTransport } = await import(
  pathToFileURL(require.resolve("@hue-run/sdk"))
);
const { registerOTel } = await import(pathToFileURL(require.resolve("@vercel/otel")));
const { trace } = require("@opentelemetry/api");
const protobuf = require("protobufjs/light.js");
const schema = JSON.parse(
  await readFile(new URL("../tests/fixtures/otlp-schema.json", import.meta.url), "utf8"),
);
const traceType = protobuf.Root.fromJSON(schema).lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);
if (process.argv.includes("--reservation")) {
  const { context, SpanKind } = require("@opentelemetry/api");
  const { TracerProvider } = require("@opentelemetry/sdk-trace");
  const { AsyncLocalStorageContextManager } = require("@opentelemetry/context-async-hooks");
  const manager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(manager);
  const recorded = [];
  const exported = [];
  const receiver = http.createServer(async (request, response) => {
    let bytes = await read(request);
    if (request.headers["content-encoding"] === "gzip") bytes = gunzipSync(bytes);
    const data = traceType.toObject(traceType.decode(bytes), { longs: String, bytes: String });
    exported.push(
      ...(data.resourceSpans ?? []).flatMap((group) =>
        group.scopeSpans.flatMap((scope) => scope.spans),
      ),
    );
    response.setHeader("content-type", "application/x-protobuf");
    response.setHeader("Hue-Pending-Spans", "1");
    response.end();
  });
  const app = http.createServer(async (request, response) => {
    const body = await read(request);
    response.setHeader("content-type", "application/json");
    if (request.url.startsWith("/pending")) {
      response.flushHeaders();
      setTimeout(() => response.end(body), 2600);
    } else response.end(body);
  });
  const baseUrl = await listen(receiver);
  const appUrl = `${await listen(app)}/same`;
  const hue = createHueTransport({
    apiKey: "synthetic-reservation",
    serviceName: "reservation",
    baseUrl,
    liveSpans: false,
  });
  const inspector = {
    onStart() {},
    onEnd(span) {
      if (span.name.startsWith("padding ")) return;
      recorded.push({ name: span.name, attrs: { ...span.attributes }, status: span.status });
    },
    async forceFlush() {},
    async shutdown() {},
  };
  const forwarding = {
    ...hue.spanProcessor,
    onEnd(span) {
      if (!span.name.startsWith("padding ")) hue.spanProcessor.onEnd(span);
    },
  };
  const provider = new TracerProvider({ spanProcessors: [forwarding, inspector] });
  trace.setGlobalTracerProvider(provider);
  const tracer = provider.getTracer("synthetic-foreign");
  const parent = tracer.startSpan("parent");
  let live;
  try {
    await context.with(trace.setSpan(context.active(), parent), async () => {
      const options = {
        kind: SpanKind.CLIENT,
        attributes: { "http.request.method": "POST", "url.full": appUrl },
      };
      const reserved = tracer.startSpan("reserved A", options);
      const received = Promise.withResolvers();
      const request = http.request(
        appUrl,
        { method: "POST", headers: { "content-type": "application/json" } },
        (response) => {
          response.resume();
          response.once("end", received.resolve);
        },
      );
      request.once("error", received.reject);
      const unrelated = tracer.startSpan("unrelated B", options);
      context.with(trace.setSpan(context.active(), unrelated), () =>
        request.end('{"request":"A"}'),
      );
      await received.promise;
      reserved.end();
      unrelated.end();
    });
    parent.end();
    await provider.forceFlush();
    await hue.flush();
    assert.deepEqual(
      JSON.parse(recorded.find((span) => span.name === "reserved A").attrs["input.value"]),
      { request: "A" },
    );
    const unrelated = recorded.find((span) => span.name === "unrelated B");
    assert.equal(unrelated.attrs["input.value"], undefined);
    assert.equal(unrelated.attrs["output.value"], undefined);
    assert.equal(unrelated.status.code, 0);
    console.log("http-capture request reservation survives an unrelated active writer: ok");
    const send = (url, body) =>
      new Promise((done, fail) => {
        const request = http.request(
          url,
          { method: "POST", headers: { "content-type": "application/json" } },
          (response) => {
            response.resume();
            response.once("end", done);
          },
        );
        request.once("error", fail);
        request.end(JSON.stringify(body));
      });
    const verifyUnclaimed = async (kind) => {
      const url = appUrl.replace("/same", `/${kind}`);
      const from = recorded.length;
      await tracer.startActiveSpan(`${kind} parent`, async (span) => {
        const options = {
          kind: SpanKind.CLIENT,
          attributes: { "http.request.method": "POST", "url.full": url },
        };
        const first = tracer.startSpan(`${kind} A`, options);
        const padding = [];
        if (kind === "overflow")
          for (let index = 0; index < 2047; index++)
            padding.push(
              tracer.startSpan(`padding ${index}`, {
                kind: SpanKind.CLIENT,
                attributes: {
                  "http.request.method": "POST",
                  "url.full": `${url}/unmatched-${index}`,
                },
              }),
            );
        const second = kind === "expired" ? undefined : tracer.startSpan(`${kind} B`, options);
        if (kind === "expired") await Promise.resolve();
        await send(url, { request: kind });
        first.end();
        second?.end();
        for (const candidate of padding) candidate.end();
        span.end();
      });
      await provider.forceFlush();
      await hue.flush();
      const candidates = recorded
        .slice(from)
        .filter((span) => span.name === `${kind} A` || span.name === `${kind} B`);
      assert.ok(
        candidates.every(
          (span) =>
            span.attrs["input.value"] === undefined && span.attrs["output.value"] === undefined,
        ),
        `${kind} candidates cannot receive unrelated bodies`,
      );
      const captured = recorded
        .slice(from)
        .filter((span) => span.name === "POST" && span.attrs["url.full"] === url);
      assert.equal(captured.length, 1, `${kind} request keeps its own HTTP span`);
      assert.deepEqual(JSON.parse(captured[0].attrs["input.value"]), { request: kind });
      assert.deepEqual(JSON.parse(captured[0].attrs["output.value"]), { request: kind });
    };
    await verifyUnclaimed("ambiguous");
    await verifyUnclaimed("expired");
    await verifyUnclaimed("overflow");
    console.log(
      "http-capture ambiguous, expired and overflowing candidates never claim another request: ok",
    );
    live = createHue({
      apiKey: "synthetic-live-key",
      serviceName: "live-url",
      baseUrl,
      captureContent: false,
    });
    await live.withSpan("prime pending capability", () => {});
    await live.flush();
    const secret = "synthetic-pending-query-secret";
    const pendingUrl = `${appUrl.replace("/same", "/pending")}?access_token=${secret}`;
    await live.tracer.startActiveSpan(
      `manual GET ${pendingUrl}`,
      { kind: SpanKind.CLIENT, attributes: { "http.method": "GET", "http.url": pendingUrl } },
      async (span) => {
        try {
          await new Promise((done, fail) => {
            http
              .get(pendingUrl, (response) => {
                response.resume();
                response.once("end", done);
              })
              .once("error", fail);
          });
        } finally {
          span.end();
        }
      },
    );
    await live.flush();
    const placeholders = exported.filter((span) =>
      span.attributes?.some(
        (attribute) =>
          attribute.key === "hue.span_type" && attribute.value.stringValue === "pending_span",
      ),
    );
    assert.ok(placeholders.length > 0, "observe a real pending export before response completion");
    assert.ok(
      !JSON.stringify(exported).includes(secret),
      "pending and final Hue spans cannot expose credential query values or names",
    );
    console.log("http-capture pending HTTP placeholders preserve URL and name privacy: ok");
  } finally {
    await live?.shutdownSafe();
    await hue.shutdown();
    await provider.shutdown();
    context.disable();
    trace.disable();
    manager.disable();
    await stop(app);
    await stop(receiver);
  }
  process.exit(0);
}

const spans = [];
const applicationSpans = [];
const requests = [];
const attempts = new Map();
let exports = 0;
let transport;

async function read(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function listen(server) {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${server.address().port}`;
}
async function stop(server) {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
const receiver = http.createServer(async (request, response) => {
  let bytes = await read(request);
  if (request.headers["content-encoding"] === "gzip") bytes = gunzipSync(bytes);
  if (request.url.endsWith("/traces")) {
    const data = traceType.toObject(traceType.decode(bytes), { longs: String, bytes: String });
    spans.push(
      ...(data.resourceSpans ?? []).flatMap((group) =>
        group.scopeSpans.flatMap((scope) => scope.spans),
      ),
    );
    exports++;
  }
  response.writeHead(200, { "content-type": "application/x-protobuf" });
  response.end();
});
const app = http.createServer(async (request, response) => {
  const body = JSON.parse((await read(request)).toString() || "{}");
  requests.push({ path: request.url, headers: request.headers, body });
  const attempt = (attempts.get(body.id) ?? 0) + 1;
  attempts.set(body.id, attempt);
  const status = request.url === "/retry" && attempt === 1 ? 503 : 200;
  response.writeHead(status, { "content-type": "application/json" });
  response.flushHeaders();
  setTimeout(
    () =>
      response.end(
        JSON.stringify({ id: body.id, attempt, status, result: `synthetic-${body.id}` }),
      ),
    300,
  );
});
const baseUrl = await listen(receiver);
const appUrl = await listen(app);
const options = {
  apiKey: "synthetic-vercel-http-key",
  serviceName: "vercel-http-capture",
  baseUrl,
  liveSpans: false,
};
transport = createHueTransport(options);
const processor = {
  onStart(span, parent) {
    transport?.spanProcessor.onStart(span, parent);
  },
  onEnd(span) {
    applicationSpans.push({
      id: span.spanContext().spanId,
      name: span.name,
      attributes: { ...span.attributes },
      service: span.resource.attributes["service.name"],
    });
    transport?.spanProcessor.onEnd(span);
  },
  async forceFlush() {
    await transport?.spanProcessor.forceFlush();
  },
  async shutdown() {},
};
registerOTel({
  serviceName: "vercel-http-capture",
  spanProcessors: [processor],
  propagators: ["none"],
});
const provider = trace.getTracerProvider().getDelegate();
const tracer = trace.getTracer("synthetic-vercel-application");
const attrs = (span) =>
  Object.fromEntries(
    (span.attributes ?? []).map(({ key, value }) => [
      key,
      value.stringValue ?? value.intValue ?? value.boolValue,
    ]),
  );
const isHttp = (span) =>
  span.kind === 3 && Boolean(attrs(span)["http.request.method"] ?? attrs(span)["http.method"]);
async function flush() {
  await provider.forceFlush();
  await transport.flush();
}
async function postFetch(path, id) {
  const response = await fetch(`${appUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  const body = await response.json();
  assert.equal(body.id, id);
  return body;
}
async function postHttp(path, id) {
  return new Promise((done, fail) => {
    const request = http.request(
      `${appUrl}${path}`,
      { method: "POST", headers: { "content-type": "application/json" } },
      async (response) => {
        try {
          const body = JSON.parse((await read(response)).toString());
          assert.equal(body.id, id);
          done(body);
        } catch (error) {
          fail(error);
        }
      },
    );
    request.once("error", fail);
    request.end(JSON.stringify({ id }));
  });
}
async function check(label, work, expected, content = true) {
  const from = spans.length;
  await tracer.startActiveSpan(label, async (span) => {
    try {
      await work();
    } finally {
      span.end();
    }
  });
  await flush();
  const recorded = spans.slice(from).filter(isHttp);
  assert.equal(recorded.length, expected.length, `${label}: one span per physical request`);
  for (const span of recorded) {
    const attributes = attrs(span);
    assert.ok(!attributes["url.full"]?.includes("/api/v1/otlp/"), "exports cannot recurse");
    if (!content) {
      assert.equal(attributes["input.value"], undefined);
      assert.equal(attributes["output.value"], undefined);
      continue;
    }
    const input = JSON.parse(attributes["input.value"]);
    const output = JSON.parse(attributes["output.value"]);
    assert.equal(output.id, input.id, "concurrent requests cannot exchange their bodies");
    const match = expected.find(([id, attempt]) => id === input.id && attempt === output.attempt);
    assert.ok(match, `${label}: expected request and response body pair`);
    expected.splice(expected.indexOf(match), 1);
    assert.equal(Number(attributes["http.response.status_code"]), output.status);
  }
  if (content) assert.equal(expected.length, 0);
  console.log(`http-capture @vercel/otel ${label}: ok`);
}

try {
  await check(
    "delayed fetch and node:http",
    async () => {
      await postFetch("/fetch", "fetch-delay");
      await postHttp("/http", "http-delay");
    },
    [
      ["fetch-delay", 1],
      ["http-delay", 1],
    ],
  );
  await check(
    "Hue URL privacy preserves the application's exporter policy",
    async () => {
      await postFetch("/query?business=synthetic-vendor-query", "query");
      await postHttp("/query?business=synthetic-vendor-http-query", "query-http");
    },
    [
      ["query", 1],
      ["query-http", 1],
    ],
  );
  for (const query of ["synthetic-vendor-query", "synthetic-vendor-http-query"]) {
    const vendor = applicationSpans.find(
      (span) => span.attributes["http.url"] === `${appUrl}/query?business=${query}`,
    );
    assert.ok(vendor, "the application exporter retains its original URL and query");
    assert.equal(
      vendor.attributes["url.full"],
      undefined,
      "Hue cannot normalize the application's live span URL",
    );
    const hueQuery = spans.find(
      (span) => span.spanId === Buffer.from(vendor.id, "hex").toString("base64"),
    );
    assert.equal(attrs(hueQuery)["url.full"], `${appUrl}/query`);
    assert.equal(JSON.parse(attrs(hueQuery)["input.value"]).business, query);
  }
  await check(
    "concurrent identical URLs",
    async () => {
      await Promise.all([
        postFetch("/concurrent", "fetch-one"),
        postFetch("/concurrent", "fetch-two"),
        postHttp("/concurrent", "http-one"),
        postHttp("/concurrent", "http-two"),
      ]);
    },
    [
      ["fetch-one", 1],
      ["fetch-two", 1],
      ["http-one", 1],
      ["http-two", 1],
    ],
  );
  await check(
    "retries remain separate physical exchanges",
    async () => {
      assert.equal((await postFetch("/retry", "retry")).status, 503);
      assert.equal((await postFetch("/retry", "retry")).status, 200);
    },
    [
      ["retry", 1],
      ["retry", 2],
    ],
  );
  await transport.shutdown();
  transport = createHueTransport({ ...options, captureContent: false });
  await check(
    "metadata-only transport restart",
    async () => {
      await postFetch("/metadata?business=synthetic-metadata-query", "metadata-fetch");
      await postHttp("/metadata?business=synthetic-http-metadata-query", "metadata-http");
    },
    [
      ["metadata-fetch", 1],
      ["metadata-http", 1],
    ],
    false,
  );
  for (const query of ["synthetic-metadata-query", "synthetic-http-metadata-query"]) {
    const metadataVendor = applicationSpans.find(
      (span) => span.attributes["http.url"] === `${appUrl}/metadata?business=${query}`,
    );
    assert.ok(
      metadataVendor,
      "metadata-only mode preserves the application exporter's own URL policy",
    );
    const metadataHue = spans.find(
      (span) => span.spanId === Buffer.from(metadataVendor.id, "hex").toString("base64"),
    );
    assert.equal(attrs(metadataHue)["url.full"], `${appUrl}/metadata`);
    assert.ok(!JSON.stringify(metadataHue).includes(query));
  }
  await transport.shutdown();
  transport = createHueTransport(options);
  await check(
    "body capture after transport restart",
    async () => {
      await postFetch("/restart", "restart-fetch");
      await postHttp("/restart", "restart-http");
    },
    [
      ["restart-fetch", 1],
      ["restart-http", 1],
    ],
  );
  for (const captureContent of [true, false])
    for (const mode of ["default", "resource", "target", "path", "invalid", "throw", "custom"]) {
      await transport.shutdown();
      const hooks = new Map();
      const replacement =
        "https://synthetic-user:synthetic-callback-password@replacement.example.test/new?q=synthetic-callback-query#fragment";
      transport = createHueTransport({
        ...options,
        captureContent,
        redact: (value, path) => {
          if (
            [
              "attributes.url.full",
              "attributes.http.url",
              "attributes.resource.name",
              "attributes.http.target",
              "attributes.url.path",
            ].includes(path)
          )
            hooks.set(path, (hooks.get(path) ?? 0) + 1);
          if (mode === "resource" && path === "attributes.resource.name") return replacement;
          if (mode === "target" && path === "attributes.http.target") return replacement;
          if (mode === "path" && path === "attributes.url.path") return replacement;
          if (mode === "invalid" && path === "attributes.http.target")
            return "file:///synthetic-invalid";
          if (mode === "throw" && path === "attributes.url.path")
            throw new Error("synthetic path callback failure");
          return value;
        },
      });
      const rawPath = "/token/synthetic-original-capability";
      const original = `${appUrl}${rawPath}?business=synthetic-uri-business`;
      const from = spans.length;
      const vendorFrom = applicationSpans.length;
      const requestFrom = requests.length;
      const extra = {
        "http.target": rawPath,
        "url.path": rawPath,
        ...(mode === "custom" ? { "resource.name": "synthetic custom resource label" } : {}),
      };
      await fetch(original, { opentelemetry: { attributes: extra } }).then((response) =>
        response.text(),
      );
      let report;
      try {
        await flush();
        report = transport.getReport();
      } catch (error) {
        if (!error || typeof error !== "object" || !("report" in error)) throw error;
        report = error.report;
      }
      const exported = spans.slice(from).filter(isHttp);
      const vendor = applicationSpans
        .slice(vendorFrom)
        .find((span) => span.attributes["http.url"] === original);
      assert.equal(exported.length, 1);
      assert.ok(vendor);
      assert.equal(vendor.name, `fetch GET ${original}`);
      assert.equal(
        vendor.attributes["resource.name"],
        mode === "custom" ? "synthetic custom resource label" : `${appUrl}${rawPath}`,
      );
      assert.equal(vendor.attributes["http.target"], rawPath);
      assert.equal(vendor.attributes["url.path"], rawPath);
      assert.equal(vendor.service, "vercel-http-capture");
      assert.equal(requests[requestFrom].path, `${rawPath}?business=synthetic-uri-business`);
      assert.ok(
        [...hooks.values()].every((count) => count === 1),
        "URI alias hooks run once per field",
      );
      assert.equal(hooks.get("attributes.resource.name"), 1);
      const attributes = attrs(exported[0]);
      assert.equal(exported[0].name, "GET");
      assert.ok(
        !JSON.stringify(exported).includes("synthetic-original-capability"),
        "resource.name and every URI alias must hide capability paths",
      );
      assert.ok(!JSON.stringify(exported).includes("synthetic-callback-password"));
      assert.ok(!JSON.stringify(exported).includes("synthetic-callback-query"));
      if (!captureContent) {
        assert.equal(attributes["input.value"], undefined);
        assert.equal(attributes["output.value"], undefined);
        assert.ok(!JSON.stringify(exported).includes("synthetic-uri-business"));
      }
      if (mode === "invalid" || mode === "throw") {
        for (const key of ["url.full", "http.url", "http.target", "url.path", "resource.name"])
          assert.equal(attributes[key], undefined, "failed URI callbacks remove all aliases");
        assert.equal(report.instrumentationFailures, 1);
      } else {
        const canonical = ["resource", "target", "path"].includes(mode)
          ? "https://replacement.example.test/new"
          : `${appUrl}/token/[redacted]`;
        assert.equal(attributes["url.full"], canonical);
        assert.equal(attributes["http.url"], canonical);
        assert.equal(attributes["http.target"], new URL(canonical).pathname);
        assert.equal(attributes["url.path"], new URL(canonical).pathname);
        assert.equal(
          attributes["resource.name"],
          mode === "custom" ? "synthetic custom resource label" : canonical,
        );
      }
      console.log(
        `http-capture @vercel/otel URI aliases ${mode} content=${captureContent}: private Hue copy, unchanged vendor`,
      );
    }
  assert.ok(
    requests.every((request) => request.headers.traceparent === undefined),
    "Hue cannot add traceparent to application requests",
  );
  const before = exports;
  await flush();
  await delay(50);
  await flush();
  assert.equal(exports, before, "flush must not create export spans");
  const reservation = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), consumer, "--reservation"],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(reservation.status, 0, reservation.stderr);
  assert.match(reservation.stdout, /request reservation survives an unrelated active writer: ok/);
  process.stdout.write(reservation.stdout);
  await new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./verify-http-capture-limits.mjs", import.meta.url)), consumer],
      { stdio: "inherit", env: process.env },
    );
    child.once("error", fail);
    child.once("close", (code) =>
      code === 0 ? done() : fail(new Error(`HTTP provider limits drive exited ${code}`)),
    );
  });
  console.log(
    `http-capture @vercel/otel 2.1.3 ${process.version}${globalThis.Bun ? ` Bun ${globalThis.Bun.version}` : ""}: ${requests.length} physical requests, ${spans.filter(isHttp).length} HTTP spans, all checks passed`,
  );
} finally {
  await transport.shutdown();
  transport = undefined;
  await provider.shutdown();
  await stop(app);
  await stop(receiver);
}
