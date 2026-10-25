import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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
const originalMessages = Array.from({ length: 5 }, (_, index) => ({
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

const modelScope = process.argv.includes("--model-scope");
const canonical = process.argv.includes("--canonical");
assert.ok(!(modelScope && canonical), "Choose one offline scenario");
const fixtureBytes = canonical
  ? await readFile(new URL("../../fixtures/canonical-gmail.json", import.meta.url))
  : undefined;
const fixture = fixtureBytes ? JSON.parse(fixtureBytes.toString("utf8")) : undefined;
const messages = fixture?.messages ?? originalMessages;
const listResponse = fixture?.list ?? {
  messages: messages.map(({ id, threadId }) => ({ id, threadId })),
  resultSizeEstimate: 5,
  nextPageToken,
};
const exportDir = process.argv
  .find((arg) => arg.startsWith("--export-dir="))
  ?.slice("--export-dir=".length);
if (exportDir) await mkdir(exportDir, { recursive: true });
const policies = modelScope
  ? [["model-scope", {}, true, true]]
  : canonical
    ? [["canonical", {}, true, true]]
    : [
        ["defaults", {}, true, true],
        ["identity-only", { captureHttpBodies: false }, true, false],
        ["http-off", { captureHttp: false }, false, false],
        ["metadata-only", { captureContent: false, captureHttpBodies: true }, true, false],
      ];
for (const [policy, options, expectHttp, expectBodies] of policies) {
  const spans = [];
  const payloads = [];
  const gmailCalls = [];
  const providerCalls = [];
  const exports = [];
  const failures = [];
  const gmail = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    assert.equal(request.headers.authorization, "Bearer synthetic-gmail-token");
    assert.equal(request.headers.traceparent, undefined, "Capture must not inject traceparent");
    if (url.pathname === "/synthetic-model") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        assert.equal(request.method, "POST");
        assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
          prompt: "Synthetic model prompt",
        });
        providerCalls.push(url.pathname);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ reply: "Synthetic model reply" }));
      });
      return;
    }
    gmailCalls.push(`${request.method} ${url.pathname}${url.search}`);
    let body;
    if (url.pathname === "/gmail/v1/users/me/messages") {
      assert.equal(url.searchParams.get("maxResults"), "5");
      assert.equal(url.searchParams.get("q"), "is:unread");
      body = listResponse;
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
    const gmailConfig = { baseUrl: gmailUrl, accessToken: "synthetic-gmail-token" };
    async function callSyntheticModel() {
      const response = await fetch(`${gmailUrl}/synthetic-model`, {
        method: "POST",
        headers: {
          Authorization: "Bearer synthetic-gmail-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ prompt: "Synthetic model prompt" }),
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { reply: "Synthetic model reply" });
    }
    const { summary, traceId } = modelScope
      ? await hue.model(
          "synthetic-model",
          async () => {
            await callSyntheticModel();
            const result = await runSummary(hue, gmailConfig);
            await callSyntheticModel();
            return result;
          },
          { provider: "synthetic" },
        )
      : await runSummary(hue, gmailConfig);
    assert.deepEqual(summary, { count: 5, ids: messages.map((message) => message.id) });
    const report = await hue.flush();
    await hue.shutdown();
    assert.deepEqual(failures, []);
    assert.ok(exports.length > 0, "No OTLP request received");
    const finished = spans.filter((span) => text(span, "hue.span_type") !== "pending_span");
    const tools = finished.filter((span) => text(span, "gen_ai.operation.name") === "execute_tool");
    const allHttp = finished.filter((span) => span.kind === 3 && text(span, "http.request.method"));
    const providerHttp = allHttp.filter((span) =>
      text(span, "url.full").endsWith("/synthetic-model"),
    );
    const http = allHttp.filter((span) => !providerHttp.includes(span));
    assert.equal(providerCalls.length, modelScope ? 2 : 0);
    assert.equal(providerHttp.length, modelScope ? 2 : 0);
    if (modelScope) {
      const models = finished.filter((span) => text(span, "gen_ai.operation.name") === "chat");
      assert.equal(models.length, 1);
      assert.equal(text(models[0], "gen_ai.request.model"), "synthetic-model");
      assert.equal(text(models[0], "gen_ai.provider.name"), "synthetic");
      for (const span of providerHttp) {
        assert.equal(span.parentSpanId, models[0].spanId);
        assert.equal(text(span, "http.request.method"), "POST");
        assert.equal(attr(span, "http.response.status_code")?.intValue, "200");
        assert.equal(text(span, "input.value"), undefined);
        assert.equal(text(span, "output.value"), undefined);
      }
    }
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
      modelScope ? 11 : expectHttp ? 8 : 2,
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
          assert.deepEqual(output, listResponse);
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
    if (modelScope) {
      assert.ok(!wire.includes(Buffer.from("Synthetic model prompt")));
      assert.ok(!wire.includes(Buffer.from("Synthetic model reply")));
    }
    assert.ok(!wire.includes(Buffer.from("synthetic-gmail-token")));
    assert.ok(!wire.includes(Buffer.from("synthetic-hue-key")));
    if (!expectBodies) {
      assert.ok(!wire.includes(Buffer.from("Synthetic unread message")));
      assert.ok(!wire.includes(Buffer.from("Synthetic subject")));
      assert.ok(!wire.includes(Buffer.from(nextPageToken)));
    }
    if (exportDir) {
      const batches = [];
      for (const [index, payload] of payloads.entries()) {
        const file = `${policy}-${index}.otlp.pb`;
        await writeFile(resolve(exportDir, file), payload, { flag: "wx" });
        batches.push({
          file,
          sha256: createHash("sha256").update(payload).digest("hex"),
          bytes: payload.length,
        });
      }
      await writeFile(
        resolve(exportDir, `${policy}-manifest.json`),
        JSON.stringify(
          {
            fixture: fixture?.name ?? "original-gmail-summary",
            sourceFixtureSha256: fixtureBytes
              ? createHash("sha256").update(fixtureBytes).digest("hex")
              : undefined,
            policy,
            traceId,
            summary,
            batches,
            encoding: "OTLP protobuf after gzip decompression; attributes and content unchanged",
          },
          null,
          2,
        ) + "\n",
        { flag: "wx" },
      );
    }
    console.log(
      JSON.stringify({
        mode: "offline",
        policy,
        traceId,
        summary,
        gmailReads: gmailCalls.length,
        httpSpans: allHttp.length,
        modelHttpSpans: providerHttp.length,
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
