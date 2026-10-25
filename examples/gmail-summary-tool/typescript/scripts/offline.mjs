import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs";
import { createHue } from "@hue-run/sdk";
import { runSummary } from "../dist/main.js";

// Only the standard OTLP fields this acceptance check reads. Unknown fields are skipped.
const traceRequest = protobuf
  .parse(
    `
  syntax = "proto3";
  message Request { repeated ResourceSpans resource_spans = 1; }
  message ResourceSpans { repeated ScopeSpans scope_spans = 2; }
  message ScopeSpans { repeated Span spans = 2; }
  message Span {
    bytes trace_id = 1; bytes span_id = 2; bytes parent_span_id = 4;
    string name = 5; int32 kind = 6; repeated KeyValue attributes = 9;
  }
  message KeyValue { string key = 1; AnyValue value = 2; }
  message AnyValue {
    string string_value = 1; bool bool_value = 2; int64 int_value = 3;
  }
`,
  )
  .root.lookupType("Request");
const nextPageToken = "synthetic-next-page";
const messages = Array.from({ length: 5 }, (_, index) => ({
  id: `synthetic-${index + 1}`,
  threadId: `thread-${index + 1}`,
  snippet: `Synthetic unread message ${index + 1}`,
  payload: {
    mimeType: "text/plain",
    headers: [{ name: "Subject", value: `Synthetic subject ${index + 1}` }],
    body: { data: Buffer.from(`Synthetic content ${index + 1}`).toString("base64url") },
  },
}));
const attr = (span, key) => span.attributes?.find((item) => item.key === key)?.value;
const text = (span, key) => attr(span, key)?.stringValue;
const json = (span, key) => JSON.parse(text(span, key) ?? "null");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

for (const [policy, options, expectHttp, expectBodies] of [
  ["defaults", {}, true, true],
  ["identity-only", { captureHttpBodies: false }, true, false],
  ["http-off", { captureHttp: false }, false, false],
  ["metadata-only", { captureContent: false, captureHttpBodies: true }, true, false],
]) {
  const spans = [];
  const payloads = [];
  const gmailCalls = [];
  const exports = [];
  const failures = [];
  const gmail = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    gmailCalls.push(`${request.method} ${url.pathname}${url.search}`);
    assert.equal(request.headers.authorization, "Bearer synthetic-gmail-token");
    assert.equal(request.headers.traceparent, undefined, "Capture must not inject traceparent");
    let body;
    if (url.pathname === "/gmail/v1/users/me/messages") {
      assert.equal(url.searchParams.get("maxResults"), "5");
      assert.equal(url.searchParams.get("q"), "is:unread");
      body = {
        messages: messages.map(({ id, threadId }) => ({ id, threadId })),
        resultSizeEstimate: 5,
        nextPageToken,
      };
    } else {
      assert.equal(url.searchParams.get("format"), "full");
      body = messages.find(
        (message) => url.pathname === `/gmail/v1/users/me/messages/${message.id}`,
      );
    }
    response.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(body ?? { error: "not found" }));
  });
  const receiver = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        let bytes = Buffer.concat(chunks);
        if (request.headers["content-encoding"] === "gzip") bytes = gunzipSync(bytes);
        payloads.push(bytes);
        assert.equal(request.url, "/api/v1/otlp/v1/traces");
        const decoded = traceRequest.toObject(traceRequest.decode(bytes), {
          bytes: String,
          longs: String,
        });
        for (const resource of decoded.resourceSpans ?? [])
          for (const scope of resource.scopeSpans ?? []) spans.push(...(scope.spans ?? []));
        exports.push({ path: request.url, bytes: bytes.length, status: 200 });
        response.writeHead(200, {
          "content-type": "application/x-protobuf",
          "hue-pending-spans": "1",
        });
        response.end();
      } catch (error) {
        failures.push(error);
        response.writeHead(500).end();
      }
    });
  });
  const gmailUrl = await listen(gmail);
  const hueUrl = await listen(receiver);
  // Distinct origins matter: Hue excludes traffic to its own export origin.
  const hue = createHue({
    apiKey: "synthetic-hue-key",
    baseUrl: hueUrl,
    serviceName: "gmail-summary-tool",
    ...options,
  });
  try {
    const { summary, traceId } = await runSummary(hue, {
      baseUrl: gmailUrl,
      accessToken: "synthetic-gmail-token",
    });
    assert.deepEqual(summary, { count: 5, ids: messages.map((message) => message.id) });
    const report = await hue.flush();
    await hue.shutdown();
    assert.deepEqual(failures, []);
    assert.ok(exports.length > 0, "No OTLP request received");
    const finished = spans.filter((span) => text(span, "hue.span_type") !== "pending_span");
    const tools = finished.filter((span) => text(span, "gen_ai.operation.name") === "execute_tool");
    const http = finished.filter((span) => span.kind === 3);
    assert.equal(gmailCalls.length, 6, "Application must execute each Gmail read once");
    assert.equal(tools.length, 1);
    assert.equal(Buffer.from(tools[0].traceId, "base64").toString("hex"), traceId);
    if (options.captureContent !== false) {
      assert.deepEqual(json(tools[0], "gen_ai.tool.call.arguments"), {
        maxResults: 5,
        q: "is:unread",
      });
      assert.deepEqual(json(tools[0], "gen_ai.tool.call.result"), summary);
    } else {
      assert.equal(text(tools[0], "gen_ai.tool.call.arguments"), undefined);
      assert.equal(text(tools[0], "gen_ai.tool.call.result"), undefined);
    }
    assert.equal(
      report.failedSpans + report.failedLogs + report.rejectedSpans + report.rejectedLogs,
      0,
    );
    assert.equal(http.length, expectHttp ? 6 : 0);
    assert.equal(
      finished.length,
      expectHttp ? 8 : 2,
      "Unexpected spans, including export recursion",
    );
    for (const span of http) {
      assert.equal(span.parentSpanId, tools[0].spanId);
      assert.equal(span.traceId, tools[0].traceId);
      assert.equal(text(span, "http.request.method"), "GET");
      assert.ok(text(span, "url.full").startsWith(`${gmailUrl}/gmail/v1/users/me/messages`));
      assert.equal(new URL(text(span, "url.full")).search, "");
      assert.equal(attr(span, "http.response.status_code")?.intValue, "200");
      if (expectBodies) {
        const isList = text(span, "url.full").endsWith("/messages");
        assert.deepEqual(
          json(span, "input.value"),
          isList ? { maxResults: "5", q: "is:unread" } : { format: "full" },
        );
        const output = json(span, "output.value");
        if (isList) {
          assert.deepEqual(output, {
            messages: messages.map(({ id, threadId }) => ({ id, threadId })),
            resultSizeEstimate: 5,
            nextPageToken,
          });
        } else {
          assert.deepEqual(
            output,
            messages.find((message) => text(span, "url.full").endsWith(`/${message.id}`)),
          );
        }
      } else {
        assert.equal(text(span, "input.value"), undefined);
        assert.equal(text(span, "output.value"), undefined);
      }
    }
    const wire = Buffer.concat(payloads);
    assert.ok(!wire.includes(Buffer.from("synthetic-gmail-token")));
    assert.ok(!wire.includes(Buffer.from("synthetic-hue-key")));
    if (!expectBodies) {
      assert.ok(!wire.includes(Buffer.from("Synthetic unread message")));
      assert.ok(!wire.includes(Buffer.from("Synthetic subject")));
      assert.ok(!wire.includes(Buffer.from(nextPageToken)));
    }
    console.log(
      JSON.stringify({
        mode: "offline",
        policy,
        traceId,
        summary,
        gmailReads: gmailCalls.length,
        httpSpans: http.length,
        bodies: expectBodies,
        exported: true,
        exports,
        report,
      }),
    );
  } finally {
    await hue.shutdownSafe();
    await close(gmail);
    await close(receiver);
  }
}
