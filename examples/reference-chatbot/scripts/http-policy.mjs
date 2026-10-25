import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs";

// Standard OTLP field numbers; protobufjs skips fields this check does not inspect.
const traceRequest = protobuf
  .parse(
    `
  syntax = "proto3";
  message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
  message ResourceSpans { repeated ScopeSpans scope_spans = 2; }
  message ScopeSpans { repeated Span spans = 2; }
  message Span {
    bytes trace_id = 1; bytes span_id = 2; bytes parent_span_id = 4;
    string name = 5; int32 kind = 6; repeated KeyValue attributes = 9;
  }
  message KeyValue { string key = 1; AnyValue value = 2; }
  message AnyValue {
    string string_value = 1; bool bool_value = 2; int64 int_value = 3;
    double double_value = 4; ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6; bytes bytes_value = 7;
  }
  message ArrayValue { repeated AnyValue values = 1; }
  message KeyValueList { repeated KeyValue values = 1; }
`,
  )
  .root.lookupType("ExportTraceServiceRequest");

const requestContent = "synthetic-http-policy-request-content";
const responseContent = "synthetic-http-policy-response-content";
const queryContent = "synthetic-http-policy-query-content";
const responseBody = { response: responseContent };
const attr = (span, key) => span.attributes?.find((item) => item.key === key)?.value;

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

// Import the app's configured client, so missing environment-option forwarding fails here.
export async function verifyHttpPolicy({ cwd, captureContent, captureHttp, captureHttpBodies }) {
  const payloads = [];
  const spans = [];
  const acknowledgements = [];
  const failures = [];
  let appRequests = 0;
  const app = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      assert.equal(request.method, "POST");
      assert.equal(request.url, `/policy?probe=${queryContent}`);
      assert.equal(request.headers.traceparent, undefined);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { request: requestContent });
      appRequests++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody));
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  const receiver = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/api/v1/projects/current") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "00000000-0000-4000-8000-000000000001",
            name: "HTTP policy verification",
            slug: "http-policy-verification",
            organizationId: "00000000-0000-4000-8000-000000000002",
          }),
        );
        return;
      }
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/api/v1/otlp/v1/traces");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      let bytes = Buffer.concat(chunks);
      if (request.headers["content-encoding"] === "gzip") bytes = gunzipSync(bytes);
      payloads.push(bytes);
      const decoded = traceRequest.toObject(traceRequest.decode(bytes), {
        bytes: String,
        longs: String,
      });
      for (const resource of decoded.resourceSpans ?? [])
        for (const scope of resource.scopeSpans ?? []) spans.push(...(scope.spans ?? []));
      acknowledgements.push({ path: request.url, bytes: bytes.length, status: 200 });
      response
        .writeHead(200, { "content-type": "application/x-protobuf", "Hue-Pending-Spans": "1" })
        .end();
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  let child;
  let timer;
  try {
    const appOrigin = await listen(app);
    const receiverOrigin = await listen(receiver);
    const childSource = `
      import assert from "node:assert/strict";
      import { pathToFileURL } from "node:url";
      import { resolve } from "node:path";
      const { hue } = await import(pathToFileURL(resolve("dist/server.js")).href);
      try {
        let traceId;
        await hue.withSpan("acceptance.http-policy", async (span) => {
          traceId = span.traceId;
          const response = await fetch(${JSON.stringify(`${appOrigin}/policy?probe=${queryContent}`)}, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer synthetic-policy-token" },
            body: JSON.stringify(${JSON.stringify({ request: requestContent })}),
          });
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), ${JSON.stringify(responseBody)});
        });
        const report = await hue.flush();
        assert.equal(report.failedSpans + report.rejectedSpans + report.droppedSpans, 0);
        assert.ok(report.acceptedSpans > 0);
        console.log(JSON.stringify({ httpPolicy: true, traceId }));
      } finally {
        process.kill(process.pid, "SIGTERM");
      }
    `;
    child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
      cwd,
      env: {
        ...process.env,
        HUE_API_KEY: "synthetic-http-policy-key",
        HUE_BASE_URL: receiverOrigin,
        HUE_CHAT_MODE: "synthetic",
        HUE_CAPTURE_CONTENT: captureContent,
        HUE_CAPTURE_HTTP: captureHttp,
        HUE_CAPTURE_HTTP_BODIES: captureHttpBodies,
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    const [code, signal] = await once(child, "exit");
    assert.equal(signal, null, "HTTP policy child timed out or was killed");
    assert.equal(code, 0, stderr);
    assert.equal(stderr, "", "HTTP policy child wrote diagnostics");
    assert.deepEqual(failures, []);
    assert.equal(appRequests, 1);
    assert.ok(acknowledgements.length > 0, "No real OTLP acknowledgement");
    const completed = JSON.parse(
      stdout.split("\n").find((line) => line.startsWith('{"httpPolicy":')),
    );
    const completedSpans = spans.filter(
      (span) => attr(span, "hue.span_type")?.stringValue !== "pending_span",
    );
    const root = completedSpans.find((span) => span.name === "acceptance.http-policy");
    assert.ok(root, "HTTP policy root was not exported");
    assert.equal(Buffer.from(root.traceId, "base64").toString("hex"), completed.traceId);
    const http = completedSpans.filter((span) => attr(span, "http.request.method"));
    assert.equal(
      http.length,
      captureHttp === "true" ? 1 : 0,
      "HTTP capture policy was not applied",
    );
    const bodies =
      captureContent === "true" && captureHttp === "true" && captureHttpBodies === "true";
    if (http.length) {
      const span = http[0];
      assert.equal(span.kind, 3);
      assert.equal(span.parentSpanId, root.spanId);
      assert.equal(span.traceId, root.traceId);
      assert.equal(attr(span, "http.request.method")?.stringValue, "POST");
      assert.equal(attr(span, "url.full")?.stringValue, `${appOrigin}/policy`);
      assert.equal(Number(attr(span, "http.response.status_code")?.intValue), 200);
      if (bodies) {
        assert.deepEqual(JSON.parse(attr(span, "input.value")?.stringValue), {
          probe: queryContent,
          request: requestContent,
        });
        assert.deepEqual(JSON.parse(attr(span, "output.value")?.stringValue), responseBody);
      } else {
        assert.equal(attr(span, "input.value"), undefined, "HTTP request content was captured");
        assert.equal(attr(span, "output.value"), undefined, "HTTP response content was captured");
      }
    }
    for (const bytes of payloads) {
      for (const secret of ["synthetic-policy-token", "synthetic-http-policy-key"])
        assert.ok(!bytes.includes(Buffer.from(secret)), "Credential entered OTLP");
      if (!bodies)
        for (const content of [requestContent, responseContent, queryContent])
          assert.ok(!bytes.includes(Buffer.from(content)), "HTTP content entered OTLP");
    }
    return {
      captureContent,
      captureHttp,
      captureHttpBodies,
      traceId: completed.traceId,
      httpSpans: http.length,
      bodies,
      acknowledgements,
    };
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
    await close(app);
    await close(receiver);
  }
}
