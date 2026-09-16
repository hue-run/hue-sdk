import { createServer } from "node:http";
import { once } from "node:events";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { pathToFileURL } from "node:url";

const [consumer, chatbot] = process.argv.slice(2);
if (!consumer || !chatbot) throw new Error("Provide consumer and chatbot paths");
const require = createRequire(join(consumer, "package.json"));
const installedPackage = JSON.parse(
  await readFile(join(consumer, "node_modules/@hue-run/sdk/package.json"), "utf8"),
);
const protobuf = require("protobufjs/light.js");
const schema = JSON.parse(
  await readFile(new URL("../tests/fixtures/otlp-schema.json", import.meta.url), "utf8"),
);
const root = protobuf.Root.fromJSON(schema);
const requests = [];
const sdkSignals = new Set();
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, "Bearer synthetic-node24-key");
    if (request.method === "GET" && request.url === "/api/v1/projects/current") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          id: "synthetic-node-project",
          name: "Node package verification",
          organizationId: "synthetic-org",
          slug: "node-verification",
        }),
      );
      return;
    }
    const requested = new URL(request.url, `http://127.0.0.1:${server.address().port}`);
    const receiptPath = /^\/api\/v1\/traces\/([0-9a-f]{32})\/receipt$/.exec(requested.pathname);
    if (request.method === "GET" && receiptPath) {
      const spans = requests
        .filter((batch) => batch.signal === "traces")
        .flatMap((batch) => batch.records)
        .filter((span) => Buffer.from(span.traceId, "base64").toString("hex") === receiptPath[1]);
      response.setHeader("Content-Type", "application/json");
      if (!spans.length) {
        response
          .writeHead(404)
          .end(JSON.stringify({ error: "Trace not found.", code: "TRACE_NOT_FOUND" }));
        return;
      }
      const ids = new Set(spans.map((span) => Buffer.from(span.spanId, "base64").toString("hex")));
      const expected = requested.searchParams.getAll("expectedSpanId");
      response.end(
        JSON.stringify({
          traceId: receiptPath[1],
          spanCount: spans.length,
          revision: 1,
          fields: {
            input: false,
            output: false,
            model: spans.some((span) =>
              span.attributes?.some((attribute) => attribute.key === "gen_ai.request.model"),
            ),
            usage: false,
            session: false,
          },
          matchedSpanIds: expected.filter((id) => ids.has(id)),
          missingSpanIds: expected.filter((id) => !ids.has(id)),
          traceUrl: `${requested.origin}/traces/synthetic`,
        }),
      );
      return;
    }
    assert.equal(request.method, "POST");
    assert.ok(["/api/v1/otlp/v1/traces", "/api/v1/otlp/v1/logs"].includes(request.url));
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const wire = Buffer.concat(chunks);
    assert.ok(wire.byteLength <= 1048576);
    const bytes = request.headers["content-encoding"] === "gzip" ? gunzipSync(wire) : wire;
    assert.ok(bytes.byteLength <= 1048576);
    const signal = request.url.endsWith("/logs") ? "logs" : "traces";
    const namespace = `opentelemetry.proto.collector.${signal === "traces" ? "trace" : "logs"}.v1.Export${signal === "traces" ? "Trace" : "Logs"}Service`;
    const type = root.lookupType(`${namespace}Request`);
    const data = type.toObject(type.decode(bytes), { longs: String, bytes: String });
    const scopes =
      signal === "traces"
        ? data.resourceSpans.flatMap((group) => group.scopeSpans)
        : data.resourceLogs.flatMap((group) => group.scopeLogs);
    for (const group of scopes) {
      if (group.scope?.name === installedPackage.name) {
        assert.equal(group.scope.version, installedPackage.version);
        sdkSignals.add(signal);
      }
    }
    const records =
      signal === "traces"
        ? data.resourceSpans.flatMap((group) => group.scopeSpans.flatMap((scope) => scope.spans))
        : data.resourceLogs.flatMap((group) =>
            group.scopeLogs.flatMap((scope) => scope.logRecords),
          );
    requests.push({ signal, records, data });
    response.setHeader("Content-Type", "application/x-protobuf");
    const responseType = root.lookupType(`${namespace}Response`);
    response.end(responseType.encode(responseType.create({})).finish());
  } catch {
    response.writeHead(400).end("Invalid synthetic test export");
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  await assert.rejects(
    promisify(execFile)(process.execPath, ["scripts/acceptance.mjs"], {
      cwd: chatbot,
      env: {
        ...process.env,
        HUE_API_KEY: "synthetic-invalid-key",
        HUE_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      },
      timeout: 5000,
    }),
    (error) => error.code === 1 && !error.killed,
    "Rejected startup must fail promptly instead of hanging during child cleanup",
  );
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ["scripts/acceptance.mjs"],
    {
      cwd: chatbot,
      env: {
        ...process.env,
        HUE_API_KEY: "synthetic-node24-key",
        HUE_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      },
      timeout: 60000,
    },
  );
  assert.equal(stderr, "");
  assert.deepEqual(
    sdkSignals,
    new Set(["traces", "logs"]),
    "Both signals identify the installed SDK package",
  );
  const evidence = JSON.parse(stdout);
  const { createHue } = await import(
    pathToFileURL(join(consumer, "node_modules/@hue-run/sdk/dist/index.js")).href
  );
  const verifier = createHue({
    apiKey: "synthetic-node24-key",
    serviceName: "receipt-verifier",
    captureContent: false,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  });
  try {
    for (const run of evidence.evidence) {
      const requestSpans = requests
        .filter((batch) => batch.signal === "traces")
        .flatMap((batch) => batch.records)
        .filter((span) => Buffer.from(span.traceId, "base64").toString("hex") === run.traceId);
      const expectedSpanIds = requestSpans.map((span) =>
        Buffer.from(span.spanId, "base64").toString("hex"),
      );
      const result = await verifier.verifyTrace(run.traceId, { expectedSpanIds });
      assert.equal(result.verified, true);
      assert.equal(result.receipt.spanCount, requestSpans.length);
      assert.deepEqual(result.receipt.matchedSpanIds, expectedSpanIds);
    }
    assert.deepEqual(await verifier.verifyTrace("f".repeat(32), { timeoutMillis: 100 }), {
      verified: false,
      receipt: null,
    });
  } finally {
    await verifier.shutdown();
  }
  for (const run of evidence.evidence) {
    const all = requests
      .flatMap((request) => request.records.map((record) => ({ signal: request.signal, record })))
      .filter(
        ({ record }) => Buffer.from(record.traceId, "base64").toString("hex") === run.traceId,
      );
    const spans = all.filter(({ signal }) => signal === "traces").map(({ record }) => record);
    const logs = all.filter(({ signal }) => signal === "logs").map(({ record }) => record);
    assert.ok(spans.length >= 2);
    assert.ok(spans.some((span) => span.name === "chat.request"));
    if (run.scenario === "chat") {
      assert.ok(spans.some((span) => span.name.includes("tool")));
      const raw = JSON.stringify(all);
      if (run.captureContent === "true") {
        assert.ok(raw.includes("Count words in this synthetic integration request."));
        assert.equal(logs.length, 2);
      } else {
        assert.ok(!raw.includes("Count words in this synthetic integration request."));
        assert.ok(!raw.includes("The text-analysis tool counted"));
        assert.equal(logs.length, 0);
      }
      const modelSpans = spans.filter((span) =>
        span.attributes?.some((attribute) => attribute.key === "gen_ai.request.model"),
      );
      assert.ok(modelSpans.length > 0);
      for (const span of modelSpans)
        assert.ok(
          !span.attributes.some((attribute) => attribute.key.startsWith("gen_ai.usage.")),
          "Unknown synthetic provider usage must remain absent",
        );
    } else assert.ok(spans.some((span) => span.status?.code === 2));
  }
  console.log(
    JSON.stringify({
      node: process.version,
      externalChatbotScenarios: evidence.evidence.length,
      spans: requests
        .filter((request) => request.signal === "traces")
        .reduce((total, request) => total + request.records.length, 0),
      logs: requests
        .filter((request) => request.signal === "logs")
        .reduce((total, request) => total + request.records.length, 0),
    }),
  );
} finally {
  server.close();
  server.closeAllConnections();
}
