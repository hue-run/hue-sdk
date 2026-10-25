import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { Writable } from "node:stream";
import { gzipSync, gunzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";

// Resolve every SDK/dependency import from the installed consumer, never the source checkout.
const consumer = resolve(process.argv[2]);
const require = createRequire(join(consumer, "package.json"));
const { createHue, createHueTransport } = await import(
  pathToFileURL(require.resolve("@hue-run/sdk"))
);
const { trace, context, SpanKind } = require("@opentelemetry/api");
const { TracerProvider } = require("@opentelemetry/sdk-trace");
const { LoggerProvider } = require("@opentelemetry/sdk-logs");
const { AsyncLocalStorageContextManager } = require("@opentelemetry/context-async-hooks");
const protobuf = require("protobufjs/light.js");
const schema = JSON.parse(
  await readFile(new URL("../tests/fixtures/otlp-schema.json", import.meta.url), "utf8"),
);
const root = protobuf.Root.fromJSON(schema);
const traceType = root.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);
const spans = [];
const services = new WeakMap();
let exports = 0;
const incoming = [];
const payload = Buffer.from(
  JSON.stringify({ message: "synthetic-response", repeated: "x".repeat(220000) }),
);
const gzip = gzipSync(payload);
const gmail = {
  payload: {
    headers: [
      { name: "Subject", value: "Synthetic subject" },
      { name: "From", value: "sender@example.test" },
    ],
  },
  nextPageToken: "synthetic-next-page-cursor",
  page_token: "synthetic-page-cursor",
};
const listen = async (server) => {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${server.address().port}`;
};
const stop = async (server) => {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
};
const read = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};
const receiver = http.createServer(async (request, response) => {
  let bytes = await read(request);
  if (request.headers["content-encoding"] === "gzip") bytes = gunzipSync(bytes);
  if (request.url.endsWith("/traces")) {
    exports++;
    const data = traceType.toObject(traceType.decode(bytes), { longs: String, bytes: String });
    for (const group of data.resourceSpans ?? []) {
      const service = group.resource?.attributes.find(
        (attribute) => attribute.key === "service.name",
      )?.value.stringValue;
      for (const scope of group.scopeSpans)
        for (const span of scope.spans) {
          spans.push(span);
          services.set(span, service);
        }
    }
  }
  response.writeHead(200, { "content-type": "application/x-protobuf" });
  response.end();
});
const target = http.createServer(async (request, response) => {
  const body = await read(request);
  incoming.push({ path: request.url, method: request.method, headers: request.headers, body });
  response.setHeader("content-type", "application/json");
  response.setHeader("notion-version", "2022-06-28");
  if (request.method === "HEAD") response.removeHeader("content-type");
  if (request.url.startsWith("/gmail-response")) {
    response.end(
      JSON.stringify({
        ...gmail,
        opaque: JSON.stringify({ ...gmail, access_token: "synthetic-opaque-access-token" }),
        access_token: "synthetic-access-token",
      }),
    );
  } else if (request.url.startsWith("/plain")) {
    response.setHeader("content-type", "text/plain");
    response.end("synthetic plain response");
  } else if (request.url.startsWith("/slow-large")) {
    response.setHeader("content-type", "text/plain");
    const chunk = Buffer.alloc(65536, "s");
    let sent = 0;
    const send = () => {
      if (response.destroyed) return;
      sent++;
      const writable = response.write(chunk);
      if (sent === 80) response.end();
      else if (writable) timer = setTimeout(send, 5);
      else
        response.once("drain", () => {
          timer = setTimeout(send, 5);
        });
    };
    let timer;
    response.once("close", () => clearTimeout(timer));
    send();
  } else if (request.url.startsWith("/redirect")) {
    response.writeHead(302, { location: "/bytes" });
    response.end();
  } else if (request.url.startsWith("/empty")) {
    response.removeHeader("content-type");
    response.writeHead(204);
    response.end();
  } else if (request.url.startsWith("/small-reply")) {
    response.end('{"ok":true}');
  } else if (request.url.startsWith("/mcp")) {
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "synthetic-tool-result" }] },
      }),
    );
  } else if (request.url.startsWith("/linear")) {
    response.end(
      JSON.stringify({
        data: {
          viewer: {
            id: "synthetic-linear-user",
            name: "Synthetic User",
            email: "synthetic@example.test",
          },
        },
      }),
    );
  } else if (request.url.startsWith("/notion")) {
    response.end(
      JSON.stringify({
        object: "user",
        id: "00000000-0000-4000-8000-000000000001",
        type: "bot",
        bot: { owner: { type: "workspace", workspace: true } },
      }),
    );
  } else if (request.url.startsWith("/gzip")) {
    response.setHeader("content-encoding", "gzip");
    response.end(gzip);
  } else if (request.url.startsWith("/large")) {
    response.setHeader("content-type", "text/plain");
    response.end("z".repeat(1200000));
  } else if (request.url.startsWith("/binary")) {
    response.setHeader("content-type", "application/octet-stream");
    response.end(Buffer.from([0, 255, 127, 0]));
  } else if (request.url.startsWith("/abort")) {
    response.write('{"unfinished":');
    const timer = setTimeout(() => response.end("true}"), 250);
    response.once("close", () => clearTimeout(timer));
  } else if (request.url.startsWith("/length")) {
    response.setHeader("content-length", payload.byteLength);
    response.end(payload);
  } else if (request.url.startsWith("/bytes")) {
    response.write(payload.subarray(0, 30000));
    setTimeout(() => response.end(payload.subarray(30000)), 5);
  } else {
    response.end(
      JSON.stringify({
        ok: true,
        input: body.length ? body.toString() : null,
        password: "synthetic-response-password",
      }),
    );
  }
});
const baseUrl = await listen(receiver);
const targetUrl = await listen(target);
const options = {
  apiKey: "synthetic-http-capture-key",
  serviceName: "http-capture-runtime",
  baseUrl,
  liveSpans: false,
};
const attributes = (span) =>
  Object.fromEntries(
    (span.attributes ?? []).map(({ key, value }) => [
      key,
      value.stringValue ??
        value.intValue ??
        value.boolValue ??
        value.arrayValue?.values.map((item) => item.stringValue),
    ]),
  );
const httpSpans = (from = 0) =>
  spans.slice(from).filter((span) => attributes(span)["http.request.method"]);
const flush = async (hue) => {
  await delay(20);
  await hue.flush();
};
const failures = [];
const check = async (label, run) => {
  try {
    await run();
    console.log(`http-capture ${label}: ok`);
  } catch (error) {
    failures.push({ label, error });
    console.error(`http-capture ${label}: FAILED`, error);
  }
};
const nodeRequest = (path, mode = "async", requestBody) =>
  new Promise((done, fail) => {
    const request = http.request(
      `${targetUrl}${path}`,
      {
        method: requestBody === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", "notion-version": "2022-06-28" },
      },
      async (response) => {
        try {
          if (mode === "late") {
            await delay(30);
            done(await read(response));
          } else if (mode === "paused") {
            const chunks = [];
            response.on("readable", () => {
              for (let chunk; (chunk = response.read()) !== null; ) chunks.push(chunk);
            });
            response.once("end", () => done(Buffer.concat(chunks)));
          } else if (mode === "pipe") {
            await delay(10);
            const chunks = [];
            const sink = new Writable({
              write(chunk, _encoding, callback) {
                chunks.push(Buffer.from(chunk));
                callback();
              },
            });
            sink.once("finish", () => done(Buffer.concat(chunks)));
            response.pipe(sink);
          } else if (mode === "flowing") {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.once("end", () => done(Buffer.concat(chunks)));
          } else {
            done(await read(response));
          }
        } catch (error) {
          fail(error);
        }
      },
    );
    request.once("error", fail);
    if (requestBody !== undefined) {
      request.write(requestBody.subarray(0, 7));
      request.end(requestBody.subarray(7));
    } else request.end();
  });

try {
  await check(
    "defaults, parenting, identity, query, bodies, headers and credential filtering",
    async () => {
      const hue = createHue(options);
      const from = spans.length;
      let parent;
      try {
        await hue.withSpan("parent", async (span) => {
          parent = Buffer.from(span.spanId, "hex").toString("base64");
          const response = await fetch(
            `${targetUrl}/default?q=synthetic-query&q=second&token=synthetic-query-token#fragment`,
            {
              method: "POST",
              body: JSON.stringify({ name: "Ada", password: "synthetic-request-password" }),
              headers: {
                "content-type": "application/json",
                authorization: "Bearer synthetic-authorization",
                "notion-version": "2022-06-28",
              },
            },
          );
          assert.equal((await response.json()).ok, true);
        });
        await flush(hue);
        const records = httpSpans(from);
        assert.equal(records.length, 1);
        const attrs = attributes(records[0]);
        assert.equal(records[0].parentSpanId, parent);
        assert.equal(attrs["url.full"], `${targetUrl}/default`);
        assert.equal(attrs["http.request.method"], "POST");
        assert.equal(Number(attrs["http.response.status_code"]), 200);
        assert.equal(attrs["http.request.header.notion_version"], "2022-06-28");
        assert.equal(attrs["http.response.header.notion_version"], "2022-06-28");
        const input = JSON.parse(attrs["input.value"]);
        assert.deepEqual(input.q, ["synthetic-query", "second"]);
        assert.equal(input.name, "Ada");
        const output = JSON.parse(attrs["output.value"]);
        assert.equal(output.ok, true);
        const serialized = JSON.stringify(records);
        for (const secret of [
          "synthetic-query-token",
          "synthetic-request-password",
          "synthetic-response-password",
          "synthetic-authorization",
        ])
          assert.ok(!serialized.includes(secret), secret);
        assert.equal(
          incoming.at(-1).headers.traceparent,
          undefined,
          "capture must not inject a traceparent header",
        );
        assert.equal(incoming.at(-1).headers.authorization, "Bearer synthetic-authorization");
        const count = spans.length;
        await hue.flush();
        assert.equal(spans.length, count, "export requests must not recurse");
      } finally {
        await hue.shutdownSafe();
      }
    },
  );

  for (const [label, overrides, count, content] of [
    ["captureHttp false", { captureHttp: false }, 0, false],
    ["captureHttpBodies false", { captureHttpBodies: false }, 1, false],
    ["captureContent false", { captureContent: false }, 1, false],
    [
      "captureContent false overrides bodies true",
      { captureContent: false, captureHttpBodies: true },
      1,
      false,
    ],
    ["disabled", { enabled: false }, 0, false],
  ])
    await check(label, async () => {
      const hue = createHue({ ...options, ...overrides });
      const from = spans.length;
      try {
        await fetch(`${targetUrl}/toggle?query=private-content`).then((response) =>
          response.text(),
        );
        await flush(hue);
        const records = httpSpans(from);
        assert.equal(records.length, count);
        for (const span of records) {
          const attrs = attributes(span);
          assert.equal(attrs["input.value"] !== undefined, content);
          assert.equal(attrs["output.value"] !== undefined, content);
          assert.equal(attrs["url.full"], `${targetUrl}/toggle`);
        }
      } finally {
        await hue.shutdownSafe();
      }
    });

  await check("custom redaction", async () => {
    const hue = createHue({
      ...options,
      redact: (value) => value.replaceAll("synthetic-business-value", "custom-redacted"),
    });
    const from = spans.length;
    try {
      await fetch(`${targetUrl}/redact?q=synthetic-business-value`).then((response) =>
        response.text(),
      );
      await flush(hue);
      assert.ok(JSON.stringify(httpSpans(from)).includes("custom-redacted"));
      assert.ok(!JSON.stringify(httpSpans(from)).includes("synthetic-business-value"));
    } finally {
      await hue.shutdownSafe();
    }
  });

  await check("node:http consumer byte identity", async () => {
    for (const mode of ["flowing", "late", "paused", "pipe", "async"]) {
      const baseline = await nodeRequest("/bytes", mode);
      const hue = createHue(options);
      const from = spans.length;
      try {
        assert.deepEqual(await nodeRequest("/bytes", mode), baseline);
        assert.deepEqual(baseline, payload);
        await flush(hue);
        const records = httpSpans(from);
        assert.equal(records.length, 1, mode);
        assert.deepEqual(JSON.parse(attributes(records[0])["output.value"]), JSON.parse(payload));
      } finally {
        await hue.shutdownSafe();
      }
    }
    const hue = createHue(options);
    const from = spans.length;
    try {
      assert.deepEqual(
        await nodeRequest("/length", "async", Buffer.from('{"sent":"request-chunks"}')),
        payload,
      );
      await flush(hue);
      assert.equal(
        JSON.parse(attributes(httpSpans(from)[0])["input.value"]).sent,
        "request-chunks",
      );
    } finally {
      await hue.shutdownSafe();
    }
  });

  await check("gzip wire bytes, binary and truncation", async () => {
    const hue = createHue(options);
    const from = spans.length;
    try {
      assert.deepEqual(await nodeRequest("/gzip"), gzip);
      assert.deepEqual(
        await fetch(`${targetUrl}/gzip`)
          .then((response) => response.arrayBuffer())
          .then(Buffer.from),
        payload,
      );
      assert.deepEqual(await nodeRequest("/binary"), Buffer.from([0, 255, 127, 0]));
      assert.equal(
        (await fetch(`${targetUrl}/large`).then((response) => response.text())).length,
        1200000,
      );
      await flush(hue);
      const records = httpSpans(from);
      assert.equal(records.length, 4);
      for (const span of records.filter((span) => attributes(span)["url.full"].endsWith("/gzip"))) {
        const value = attributes(span)["output.value"];
        if (value !== undefined)
          assert.deepEqual(
            JSON.parse(value),
            JSON.parse(payload),
            "wire gzip cannot be interpreted as JSON text",
          );
      }
      assert.equal(
        attributes(records.find((span) => attributes(span)["url.full"].endsWith("/binary")))[
          "output.value"
        ],
        undefined,
      );
      const largeSpan = records.find((span) => attributes(span)["url.full"].endsWith("/large"));
      const large = attributes(largeSpan);
      const marker = largeSpan.attributes.find(
        (attribute) => attribute.key === "output.value",
      ).value;
      assert.equal(marker.stringValue, undefined, "truncation must be a structured OTLP value");
      assert.equal(
        marker.kvlistValue.values.find((attribute) => attribute.key === "hue.truncated").value
          .boolValue,
        true,
      );
      assert.ok(large["hue.truncated"].includes("output.value"));
      assert.equal(Number(large["http.response.body.size"]), 1200000);
    } finally {
      await hue.shutdownSafe();
    }
  });

  await check("request truncation retains HTTP identity and structured marker", async () => {
    const hue = createHue(options);
    const from = spans.length;
    try {
      await fetch(`${targetUrl}/small-reply`, {
        method: "POST",
        body: "r".repeat(1200000),
        headers: { "content-type": "text/plain" },
      }).then((response) => response.text());
      await flush(hue);
      const records = httpSpans(from);
      assert.equal(records.length, 1);
      const marker = records[0].attributes.find(
        (attribute) => attribute.key === "input.value",
      ).value;
      assert.equal(marker.stringValue, undefined);
      assert.equal(
        marker.kvlistValue.values.find((attribute) => attribute.key === "hue.truncated").value
          .boolValue,
        true,
      );
      assert.equal(Number(attributes(records[0])["http.request.body.size"]), 1200000);
      assert.deepEqual(JSON.parse(attributes(records[0])["output.value"]), { ok: true });
    } finally {
      await hue.shutdownSafe();
    }
  });

  await check("empty 204 and HEAD responses record null", async () => {
    const hue = createHue(options);
    const from = spans.length;
    try {
      assert.equal((await fetch(`${targetUrl}/empty`, { method: "DELETE" })).status, 204);
      const head = await fetch(`${targetUrl}/head`, { method: "HEAD" });
      assert.equal(await head.text(), "");
      await flush(hue);
      const records = httpSpans(from);
      assert.equal(records.length, 2);
      for (const span of records) assert.equal(JSON.parse(attributes(span)["output.value"]), null);
    } finally {
      await hue.shutdownSafe();
    }
  });

  await check("fetch identity, consumer cloning, delayed reads and streaming uploads", async () => {
    const hue = createHue(options);
    const originalClone = Response.prototype.clone;
    let captureClones = 0;
    Response.prototype.clone = function (...args) {
      captureClones++;
      return originalClone.apply(this, args);
    };
    try {
      const request = new Request(`${targetUrl}/bytes`, {
        headers: { "x-synthetic-preserved": "yes" },
      });
      const response = await fetch(request);
      assert.ok(response instanceof Response);
      assert.equal(response.status, 200);
      assert.equal(response.url, `${targetUrl}/bytes`);
      assert.equal(response.bodyUsed, false);
      assert.equal(captureClones, 0, "instrumentation must not clone a response");
      const copy = response.clone();
      assert.equal(copy.url, response.url);
      assert.equal(copy.redirected, response.redirected);
      assert.equal(copy.type, response.type);
      const descendant = copy.clone();
      assert.equal(descendant.url, response.url);
      assert.equal(descendant.redirected, response.redirected);
      assert.equal(descendant.type, response.type);
      const redirected = await fetch(`${targetUrl}/redirect`);
      const redirectedCopy = redirected.clone();
      assert.equal(redirected.redirected, true);
      assert.equal(redirectedCopy.url, redirected.url);
      assert.equal(redirectedCopy.redirected, true);
      assert.equal(redirectedCopy.type, redirected.type);
      assert.deepEqual(Buffer.from(await redirected.arrayBuffer()), payload);
      assert.deepEqual(Buffer.from(await redirectedCopy.arrayBuffer()), payload);
      await delay(20);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
      assert.deepEqual(Buffer.from(await copy.arrayBuffer()), payload);
      assert.deepEqual(Buffer.from(await descendant.arrayBuffer()), payload);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('{"streamed":'));
          controller.enqueue(Buffer.from("true}"));
          controller.close();
        },
      });
      await fetch(`${targetUrl}/stream-upload`, {
        method: "POST",
        body: stream,
        duplex: "half",
        headers: { "content-type": "application/json" },
      }).then((reply) => reply.text());
      assert.equal(incoming.at(-1).body.toString(), '{"streamed":true}');
      await flush(hue);
      const streamed = httpSpans().findLast((span) =>
        attributes(span)["url.full"].endsWith("/stream-upload"),
      );
      if (globalThis.Bun)
        assert.equal(
          attributes(streamed)["input.value"],
          undefined,
          "unobserved stream upload cannot be recorded as empty input",
        );
      else assert.equal(JSON.parse(attributes(streamed)["input.value"]).streamed, true);
    } finally {
      Response.prototype.clone = originalClone;
      await hue.shutdownSafe();
    }
  });

  if (globalThis.Bun)
    await check(
      "RequestInit accessors retain native evaluation count and wire values",
      async () => {
        const observations = [];
        for (const captureHttp of [false, true]) {
          const hue = createHue({ ...options, captureHttp });
          const counts = { method: 0, headers: 0, body: 0 };
          const init = {
            get method() {
              counts.method++;
              return "POST";
            },
            get headers() {
              counts.headers++;
              return { "content-type": "text/plain" };
            },
            get body() {
              counts.body++;
              return `synthetic-getter-body-${counts.body}`;
            },
          };
          try {
            await fetch(`${targetUrl}/getter`, init).then((response) => response.text());
            observations.push({ counts, body: incoming.at(-1).body.toString() });
          } finally {
            await hue.shutdownSafe();
          }
        }
        assert.deepEqual(observations[1], observations[0]);
      },
    );

  if (globalThis.Bun)
    await check("Bun response setup failure returns the untouched readable response", async () => {
      const hue = createHue(options);
      const define = Object.defineProperties;
      let failed = false;
      Object.defineProperties = function (target, properties) {
        if (properties.url && properties.redirected && properties.type && properties.clone) {
          failed = true;
          throw new Error("synthetic response decoration failure");
        }
        return Reflect.apply(define, Object, [target, properties]);
      };
      try {
        const response = await fetch(`${targetUrl}/bytes?setup-failure=1`);
        Object.defineProperties = define;
        assert.ok(failed);
        assert.equal(response.url, `${targetUrl}/bytes?setup-failure=1`);
        assert.equal(response.bodyUsed, false);
        assert.equal(response.body.locked, false);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
        assert.ok(hue.transport.getReport().instrumentationFailures > 0);
      } finally {
        Object.defineProperties = define;
        await hue.shutdownSafe();
      }
    });

  await check("normalized methods, inferred text and form request content types", async () => {
    const hue = createHue(options);
    const from = spans.length;
    try {
      await fetch(`${targetUrl}/inferred-text`, { method: "post", body: "synthetic-text" }).then(
        (response) => response.text(),
      );
      await fetch(`${targetUrl}/inferred-form?q=top`, {
        method: "post",
        body: new URLSearchParams({ name: "Ada", password: "synthetic-form-password" }),
      }).then((response) => response.text());
      await flush(hue);
      const records = httpSpans(from);
      assert.equal(records.length, 2);
      for (const span of records) assert.equal(attributes(span)["http.request.method"], "POST");
      assert.equal(JSON.parse(attributes(records[0])["input.value"]).body, "synthetic-text");
      assert.equal(JSON.parse(attributes(records[1])["input.value"]).name, "Ada");
      assert.equal(JSON.parse(attributes(records[1])["input.value"]).q, "top");
      assert.ok(!JSON.stringify(records).includes("synthetic-form-password"));
    } finally {
      await hue.shutdownSafe();
    }
  });

  await check("HTTP privacy preserves Gmail headers and pagination cursors", async () => {
    const hue = createHue(options);
    const from = spans.length;
    try {
      await fetch(
        `${targetUrl}/gmail-response?page_token=synthetic-query-cursor&nextPageToken=synthetic-query-next&pageToken=synthetic-query-page`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...gmail,
            opaque: JSON.stringify({ ...gmail, access_token: "synthetic-opaque-access-token" }),
            password: "synthetic-gmail-password",
          }),
        },
      ).then((response) => response.text());
      await flush(hue);
      const records = httpSpans(from);
      assert.equal(records.length, 1);
      const input = JSON.parse(attributes(records[0])["input.value"]);
      const output = JSON.parse(attributes(records[0])["output.value"]);
      for (const value of [input, output, JSON.parse(input.opaque), JSON.parse(output.opaque)]) {
        assert.deepEqual(value.payload.headers, gmail.payload.headers);
        assert.equal(value.nextPageToken, gmail.nextPageToken);
        assert.equal(value.page_token, gmail.page_token);
      }
      assert.equal(input.pageToken, "synthetic-query-page");
      assert.ok(!JSON.stringify(records).includes("synthetic-gmail-password"));
      assert.ok(!JSON.stringify(records).includes("synthetic-opaque-access-token"));
      assert.ok(!JSON.stringify(records).includes("synthetic-access-token"));
    } finally {
      await hue.shutdownSafe();
    }
  });

  await check(
    "JSON-encoded content declares JSON MIME and preserves exact plain text",
    async () => {
      const hue = createHue(options);
      const from = spans.length;
      try {
        assert.equal(
          await fetch(`${targetUrl}/plain?q=synthetic-query`, {
            method: "POST",
            body: "synthetic plain input",
          }).then((response) => response.text()),
          "synthetic plain response",
        );
        await flush(hue);
        const records = httpSpans(from);
        assert.equal(records.length, 1);
        const attrs = attributes(records[0]);
        assert.deepEqual(JSON.parse(attrs["input.value"]), {
          q: "synthetic-query",
          body: "synthetic plain input",
        });
        assert.equal(JSON.parse(attrs["output.value"]), "synthetic plain response");
        assert.equal(attrs["input.mime_type"], "application/json");
        assert.equal(attrs["output.mime_type"], "application/json");
        assert.ok(attrs["http.request.header.content_type"].startsWith("text/plain"));
        assert.equal(attrs["http.response.header.content_type"], "text/plain");
      } finally {
        await hue.shutdownSafe();
      }
    },
  );

  await check("MCP JSON-RPC response remains the raw wire object", async () => {
    const hue = createHue(options);
    const from = spans.length;
    try {
      const input = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "synthetic_tool", arguments: { input: "synthetic" } },
      };
      const response = await fetch(`${targetUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }).then((reply) => reply.json());
      await flush(hue);
      const records = httpSpans(from);
      assert.equal(records.length, 1);
      assert.deepEqual(JSON.parse(attributes(records[0])["input.value"]), input);
      assert.deepEqual(JSON.parse(attributes(records[0])["output.value"]), response);
    } finally {
      await hue.shutdownSafe();
    }
  });

  await check("model exclusion", async () => {
    const hue = createHue(options);
    const from = spans.length;
    try {
      await hue.model(
        "synthetic-model",
        async () => {
          await fetch(`${targetUrl}/model`).then((response) => response.text());
        },
        { provider: "synthetic" },
      );
      await flush(hue);
      assert.equal(httpSpans(from).length, 0);
    } finally {
      await hue.shutdownSafe();
    }
  });

  await check(
    "read-only HTTP methods cannot change application bytes or crash the process",
    async () => {
      const sdk = JSON.stringify(pathToFileURL(require.resolve("@hue-run/sdk")).href);
      for (const frozen of ["write", "end", "emit", "response.push", "response.emit"]) {
        const outputs = [];
        for (const captureHttp of [false, true]) {
          const setup = frozen.startsWith("response.")
            ? `Object.defineProperty(http.IncomingMessage.prototype, ${JSON.stringify(frozen.split(".")[1])}, { value:http.IncomingMessage.prototype[${JSON.stringify(frozen.split(".")[1])}], writable:false, configurable:true });`
            : `subscribe("http.client.request.created", ({request})=>Object.defineProperty(request, ${JSON.stringify(frozen)}, {value:request[${JSON.stringify(frozen)}],writable:false,configurable:true}));`;
          const script = `import http from "node:http";import {subscribe} from "node:diagnostics_channel";import {createHue} from ${sdk};${setup}const server=http.createServer((request,response)=>response.end("synthetic-readonly-bytes"));await new Promise(done=>server.listen(0,"127.0.0.1",done));createHue(${JSON.stringify({ ...options, baseUrl: "http://127.0.0.1:1", captureHttp })});const body=await new Promise((done,fail)=>{http.get("http://127.0.0.1:"+server.address().port+"/",response=>{let body="";response.on("data",chunk=>body+=chunk);response.on("end",()=>done(body));}).once("error",fail);});console.log(body);process.exit(0);`;
          const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
            encoding: "utf8",
            timeout: 5000,
          });
          assert.equal(result.status, 0, `${frozen}: ${result.stderr}`);
          outputs.push(result.stdout.trim());
        }
        assert.deepEqual(outputs, ["synthetic-readonly-bytes", "synthetic-readonly-bytes"], frozen);
      }
    },
  );

  if (globalThis.Bun)
    await check(
      "read-only fetch preserves constructor, application calls and shutdown",
      async () => {
        const script = `import {createHue} from ${JSON.stringify(pathToFileURL(require.resolve("@hue-run/sdk")).href)};const original=globalThis.fetch;Object.defineProperty(globalThis,"fetch",{value:original,writable:false,configurable:true});const hue=createHue(${JSON.stringify(options)});const response=await fetch("data:text/plain,synthetic-readonly-fetch");console.log(await response.text());await hue.shutdownSafe();if(globalThis.fetch!==original)throw new Error("fetch changed");`;
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
          encoding: "utf8",
          timeout: 5000,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), "synthetic-readonly-fetch");
      },
    );

  await check(
    "large unread fetch responses add no eager reader calls or clone branch",
    async () => {
      const counts = [];
      for (const captureHttp of [false, true]) {
        const hue = createHue({ ...options, captureHttp });
        const getReader = ReadableStream.prototype.getReader;
        const clone = Response.prototype.clone;
        let reads = 0;
        let clones = 0;
        ReadableStream.prototype.getReader = function (...args) {
          const reader = Reflect.apply(getReader, this, args);
          const read = reader.read;
          reader.read = function (...args) {
            reads++;
            return Reflect.apply(read, this, args);
          };
          return reader;
        };
        Response.prototype.clone = function (...args) {
          clones++;
          return Reflect.apply(clone, this, args);
        };
        try {
          const response = await fetch(`${targetUrl}/slow-large`);
          await delay(50);
          counts.push(reads);
          assert.equal(response.bodyUsed, false);
          assert.equal(response.body.locked, false);
          assert.equal(clones, 0);
          await response.body.cancel();
        } finally {
          ReadableStream.prototype.getReader = getReader;
          Response.prototype.clone = clone;
          await hue.shutdownSafe();
        }
      }
      assert.equal(counts[1], counts[0], "capture cannot start an eager stream reader");
    },
  );

  await check("node:http unhandled and handled errors preserve process behavior", async () => {
    const closed = http.createServer();
    const closedUrl = await listen(closed);
    await stop(closed);
    const results = [];
    for (const settings of [{ captureHttp: false }, { captureHttp: true }, { enabled: false }]) {
      const setup = `import http from "node:http"; import { createHue } from ${JSON.stringify(pathToFileURL(require.resolve("@hue-run/sdk")).href)}; const hue=createHue(${JSON.stringify({ ...options, ...settings })});`;
      const unhandled = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", `${setup} http.get(${JSON.stringify(closedUrl)});`],
        { encoding: "utf8", timeout: 5000 },
      );
      assert.ok(
        unhandled.status > 0,
        `unhandled error must terminate: ${JSON.stringify(settings)} ${unhandled.stderr}`,
      );
      assert.equal(unhandled.signal, null);
      assert.match(unhandled.stderr, /ECONNREFUSED/);
      results.push(unhandled.status);
      const handled = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `${setup} const request=http.get(${JSON.stringify(closedUrl)}); request.once("error", error=>{ console.log(error.code); process.exit(0); });`,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      assert.equal(handled.status, 0, handled.stderr);
      assert.equal(handled.stdout.trim(), "ECONNREFUSED");
    }
    assert.equal(
      new Set(results).size,
      1,
      "instrumentation cannot change unhandled-error exit status",
    );
  });

  await check("unread responses, abort and shutdown", async () => {
    const hue = createHue(options);
    let unread;
    let unreadNode;
    try {
      unread = await fetch(`${targetUrl}/bytes`);
      unreadNode = await new Promise((done, fail) => {
        const request = http.get(`${targetUrl}/bytes`, done);
        request.once("error", fail);
      });
      assert.equal(unreadNode.readableFlowing, null);
      assert.equal(unreadNode.listenerCount("data"), 0);
      await delay(20);
      assert.equal(unreadNode.readableFlowing, null);
      await new Promise((done, fail) => {
        const request = http.get(`${targetUrl}/small-reply`);
        request.once("close", done);
        request.once("error", fail);
      });
      assert.equal(unread.bodyUsed, false);
      assert.equal(unread.body.locked, false);
      const controller = new AbortController();
      const response = await fetch(`${targetUrl}/abort`, { signal: controller.signal });
      controller.abort();
      await assert.rejects(response.text());
      await new Promise((done) => {
        const request = http.get(`${targetUrl}/abort`, (response) => {
          response.once("error", () => {});
          request.destroy();
          done();
        });
        request.once("error", () => done());
      });
      const result = await Promise.race([
        hue.shutdownSafe(),
        delay(2000).then(() => {
          throw new Error("shutdown held an unread response");
        }),
      ]);
      assert.ok(result);
      assert.deepEqual(Buffer.from(await unread.arrayBuffer()), payload);
      assert.deepEqual(await read(unreadNode), payload);
    } finally {
      await hue.shutdownSafe();
    }
  });

  await check("multiple client lifecycle", async () => {
    const first = createHue({ ...options, serviceName: "http-first" });
    const second = createHue({ ...options, serviceName: "http-second" });
    try {
      await first.shutdownSafe();
      const from = spans.length;
      await fetch(`${targetUrl}/second`).then((response) => response.text());
      await flush(second);
      assert.equal(httpSpans(from).length, 1);
      await second.shutdownSafe();
      const after = spans.length;
      await fetch(`${targetUrl}/after-shutdown`).then((response) => response.text());
      assert.equal(spans.length, after);
    } finally {
      await first.shutdownSafe();
      await second.shutdownSafe();
    }
  });

  await check(
    "nested independent clients choose the innermost scope in both directions",
    async () => {
      const first = createHue({ ...options, serviceName: "http-first" });
      const second = createHue({ ...options, serviceName: "http-second" });
      const from = spans.length;
      try {
        for (const [outer, inner, name] of [
          [first, second, "http-second"],
          [second, first, "http-first"],
        ]) {
          let parent;
          await outer.withSpan("outer", () =>
            inner.withSpan("inner", async (span) => {
              parent = Buffer.from(span.spanId, "hex").toString("base64");
              await fetch(`${targetUrl}/nested-${name}`).then((response) => response.text());
            }),
          );
          await first.flush();
          await second.flush();
          const recorded = httpSpans(from).filter((span) =>
            attributes(span)["url.full"].endsWith(`/nested-${name}`),
          );
          assert.equal(recorded.length, 1);
          assert.equal(recorded[0].parentSpanId, parent);
          assert.equal(services.get(recorded[0]), name);
        }
      } finally {
        await first.shutdownSafe();
        await second.shutdownSafe();
      }
    },
  );

  await check("client HTTP opt-outs suppress another registered client's fallback", async () => {
    for (const off of [{ captureHttp: false }, { enabled: false }]) {
      const first = createHue({ ...options, ...off });
      const second = createHue(options);
      const from = spans.length;
      try {
        await second.withSpan("enabled-outer", () =>
          first.withSpan("disabled-inner", async () => {
            await fetch(`${targetUrl}/opt-out-helper`).then((response) => response.text());
          }),
        );
        await second.withSpan("enabled-outer", () =>
          first.tracer.startActiveSpan("disabled-direct", async (span) => {
            await fetch(`${targetUrl}/opt-out-direct`).then((response) => response.text());
            span.end();
          }),
        );
        await first.flush();
        await second.flush();
        assert.equal(httpSpans(from).length, 0, JSON.stringify(off));
      } finally {
        await first.shutdownSafe();
        await second.shutdownSafe();
      }
    }
  });

  await check("a closed client scope cannot fall through to another live client", async () => {
    const first = createHue(options);
    const second = createHue(options);
    const entered = Promise.withResolvers();
    const gate = Promise.withResolvers();
    const from = spans.length;
    try {
      const work = first.withSpan("closing-parent", async () => {
        entered.resolve();
        await gate.promise;
        await fetch(`${targetUrl}/closed-client`).then((response) => response.text());
      });
      await entered.promise;
      await first.shutdownSafe();
      gate.resolve();
      await work;
      await second.flush();
      assert.equal(httpSpans(from).length, 0);
    } finally {
      gate.resolve();
      await first.shutdownSafe();
      await second.shutdownSafe();
    }
  });

  await check("shared transport restores surviving client source after unsubscribe", async () => {
    const transport = createHueTransport(options);
    const provider = new TracerProvider({ spanProcessors: [transport.spanProcessor] });
    const logger = new LoggerProvider({ processors: [transport.logRecordProcessor] });
    const first = createHue({ transport, tracerProvider: provider, loggerProvider: logger });
    const second = createHue({ transport, tracerProvider: provider, loggerProvider: logger });
    try {
      for (const stopped of [false, true]) {
        if (stopped) await second.shutdownSafe();
        const from = spans.length;
        let parent;
        await first.withSpan("shared-parent", async (span) => {
          parent = Buffer.from(span.spanId, "hex").toString("base64");
          await fetch(`${targetUrl}/shared-${stopped}`).then((response) => response.text());
        });
        await flush(first);
        const recorded = httpSpans(from);
        assert.equal(recorded.length, 1);
        assert.equal(recorded[0].parentSpanId, parent);
      }
    } finally {
      await first.shutdownSafe();
      await second.shutdownSafe();
      await transport.shutdown();
      await provider.shutdown();
      await logger.shutdown();
    }
  });

  if (process.argv.includes("--clients")) {
    const loaderClient = createHue(options);
    try {
      const load = async (name) =>
        import(
          pathToFileURL(
            require.resolve(
              name === "node-fetch"
                ? "node-fetch/lib/index.js"
                : name === "undici"
                  ? "undici/index.js"
                  : name,
            ),
          )
        );
      const undici = await load("undici");
      const [
        { default: axios },
        { default: nodeFetch },
        { default: got },
        gaxios,
        { google },
        { WebClient },
        linearModule,
        { Client: NotionClient },
      ] = await Promise.all([
        load("axios"),
        load("node-fetch"),
        load("got"),
        load("gaxios"),
        load("googleapis"),
        load("@slack/web-api"),
        load("@linear/sdk"),
        load("@notionhq/client"),
      ]);
      const LinearClient = linearModule.LinearClient ?? linearModule.default.LinearClient;
      const calls = [
        ["axios", () => axios.post(`${targetUrl}/axios`, { message: "axios" })],
        [
          "node-fetch v2",
          () =>
            nodeFetch(`${targetUrl}/node-fetch`, {
              method: "POST",
              body: JSON.stringify({ message: "node-fetch" }),
              headers: { "content-type": "application/json" },
            }).then((response) => response.json()),
        ],
        [
          "got",
          () =>
            got.post(`${targetUrl}/got`, { json: { message: "got" }, retry: { limit: 0 } }).json(),
        ],
        [
          "gaxios",
          () =>
            gaxios.request({
              url: `${targetUrl}/gaxios`,
              method: "POST",
              data: { message: "gaxios" },
              retry: false,
            }),
        ],
        [
          "googleapis",
          () =>
            google
              .gmail({ version: "v1" })
              .users.messages.list({ userId: "me", maxResults: 5 }, { rootUrl: `${targetUrl}/` }),
        ],
        [
          "@slack/web-api",
          () =>
            new WebClient("synthetic-slack-token", {
              slackApiUrl: `${targetUrl}/slack/`,
              retryConfig: { retries: 0 },
            }).apiCall("auth.test"),
        ],
        [
          "undici fetch",
          () =>
            undici
              .fetch(`${targetUrl}/undici`, {
                method: "POST",
                body: JSON.stringify({ message: "undici" }),
                headers: { "content-type": "application/json" },
              })
              .then((response) => response.json()),
        ],
        [
          "@linear/sdk",
          () =>
            new LinearClient({ apiKey: "synthetic-linear-token", apiUrl: `${targetUrl}/linear` })
              .viewer,
        ],
        [
          "@notionhq/client",
          () =>
            new NotionClient({
              auth: "synthetic-notion-token",
              baseUrl: `${targetUrl}/notion`,
            }).users.me({}),
        ],
      ];
      for (const [name, call] of calls) {
        const unsupported = globalThis.Bun && ["gaxios", "googleapis"].includes(name);
        await check(
          `real client ${name}${unsupported ? " default unsupported on Bun (node-fetch built-in alias)" : ""}`,
          async () => {
            const hue = createHue(options);
            const from = spans.length;
            try {
              await call();
              await flush(hue);
              const records = httpSpans(from);
              assert.equal(records.length, unsupported ? 0 : 1, name);
              if (unsupported) return;
              assert.ok(attributes(records[0])["input.value"], `${name} request content`);
              assert.ok(attributes(records[0])["output.value"], `${name} response content`);
              assert.equal(Number(attributes(records[0])["http.response.status_code"]), 200);
            } finally {
              await hue.shutdownSafe();
            }
          },
        );
        if (unsupported)
          await check(`real client ${name} with explicit fetchImplementation on Bun`, async () => {
            const hue = createHue(options);
            const from = spans.length;
            try {
              if (name === "gaxios")
                await gaxios.request({
                  url: `${targetUrl}/gaxios-explicit`,
                  method: "POST",
                  data: { message: "gaxios" },
                  fetchImplementation: globalThis.fetch,
                });
              else
                await google
                  .gmail({ version: "v1" })
                  .users.messages.list(
                    { userId: "me", maxResults: 5 },
                    { rootUrl: `${targetUrl}/`, fetchImplementation: globalThis.fetch },
                  );
              await flush(hue);
              const records = httpSpans(from);
              assert.equal(records.length, 1);
              assert.ok(attributes(records[0])["input.value"]);
              assert.ok(attributes(records[0])["output.value"]);
            } finally {
              await hue.shutdownSafe();
            }
          });
      }
    } finally {
      await loaderClient.shutdownSafe();
    }
  }

  await check(
    "createHueTransport, application provider ownership and existing HTTP span",
    async () => {
      const manager = new AsyncLocalStorageContextManager().enable();
      context.setGlobalContextManager(manager);
      const transport = createHueTransport(options);
      const applicationSpans = [];
      const applicationProcessor = {
        onStart() {},
        onEnd(span) {
          applicationSpans.push(span);
        },
        async forceFlush() {},
        async shutdown() {},
      };
      const provider = new TracerProvider({
        spanProcessors: [transport.spanProcessor, applicationProcessor],
      });
      trace.setGlobalTracerProvider(provider);
      const tracer = provider.getTracer("application");
      const from = spans.length;
      try {
        await tracer.startActiveSpan("application-parent", async (span) => {
          await fetch(`${targetUrl}/transport`).then((response) => response.text());
          span.end();
        });
        await flush(transport);
        assert.equal(httpSpans(from).length, 1);
        const existing = tracer.startSpan("GET", {
          kind: SpanKind.CLIENT,
          attributes: { "http.request.method": "GET", "url.full": `${targetUrl}/existing` },
        });
        await context.with(trace.setSpan(context.active(), existing), async () => {
          await fetch(`${targetUrl}/existing`).then((response) => response.text());
        });
        existing.end();
        await provider.forceFlush();
        await flush(transport);
        assert.equal(
          httpSpans(from).filter((span) => attributes(span)["url.full"] === `${targetUrl}/existing`)
            .length,
          1,
        );
        const unfinished = tracer.startSpan("external-unfinished", {
          kind: SpanKind.CLIENT,
          attributes: {
            "http.request.method": "GET",
            "url.full": `${targetUrl}/slow-large`,
            "input.value": "application-owned-input",
          },
        });
        const response = await context.with(trace.setSpan(context.active(), unfinished), () =>
          fetch(`${targetUrl}/slow-large`),
        );
        await transport.shutdown();
        assert.ok(
          unfinished.isRecording(),
          "unsubscribe cannot end the application's existing span",
        );
        assert.equal((await response.text()).length, 80 * 65536);
        unfinished.end();
        const applicationSpan = applicationSpans.find(
          (span) => span.spanContext().spanId === unfinished.spanContext().spanId,
        );
        assert.equal(applicationSpan.attributes["input.value"], "application-owned-input");
        assert.equal(applicationSpan.attributes["error.type"], undefined);
        assert.equal(
          applicationSpan.status.code,
          0,
          "unsubscribe cannot turn an application-owned span into an error",
        );
        const span = tracer.startSpan("provider-still-owned-by-application");
        assert.ok(span.isRecording());
        span.end();
      } finally {
        await transport.shutdown();
        await provider.shutdown();
        trace.disable();
        context.disable();
        manager.disable();
      }
    },
  );
  if (process.env.HUE_HTTP_CAPTURE_FIXTURE)
    await writeFile(
      process.env.HUE_HTTP_CAPTURE_FIXTURE,
      JSON.stringify(
        {
          resourceSpans: [
            {
              scopeSpans: [
                {
                  spans: spans.filter((span) =>
                    ["/default", "/large"].some((path) =>
                      attributes(span)["url.full"]?.endsWith(path),
                    ),
                  ),
                },
              ],
            },
          ],
        },
        null,
        2,
      ),
    );
  assert.equal(failures.length, 0, failures.map(({ label }) => label).join(", "));
  console.log(
    `http-capture runtime ${process.version}${globalThis.Bun ? ` Bun ${globalThis.Bun.version}` : ""}: ${exports} OTLP exports, all supported checks passed`,
  );
} finally {
  await stop(target);
  await stop(receiver);
}
