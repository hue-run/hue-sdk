import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { once } from "node:events";
import { CaptureSession } from "@hue-run/sdk/capture";

const records = [];
let revision = 0;
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, "Bearer synthetic-capture-key");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "null");
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/captures") {
      response.end(
        JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", captureRevision: revision }),
      );
    } else if (request.url.endsWith("/append")) {
      records.push(...body.observations);
      response.end(JSON.stringify({ captureRevision: ++revision }));
    } else if (request.url.endsWith("/finalize")) {
      assert.equal(body.producers[0].pending, 0);
      response.end(JSON.stringify({ revision, digest: "a".repeat(64), omissions: [] }));
    } else response.end(JSON.stringify({ captureRevision: revision }));
  } catch {
    response.statusCode = 500;
    response.end();
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const capture = new CaptureSession({
    sourceContent: true,
    apiKey: "synthetic-capture-key",
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    bindings: [
      {
        id: "mail",
        kind: "tool",
        contractVersion: "1",
        operations: [{ name: "read", inputSchema: { type: "object" } }],
      },
    ],
  });
  const original = { body: "source", access_token: "synthetic-secret" };
  assert.equal(await capture.observe("mail", "read", { id: "m1" }, async () => original), original);
  assert.equal((await capture.finalize()).status, "finalized");
  assert.equal(records.length, 2);
  assert.deepEqual(records[1].result.value, { body: "source" });
  assert.equal(records[1].omissionReason, "redacted_result");
  console.log(
    JSON.stringify({
      node: process.version,
      installedCapture: "passed",
      observations: records.length,
    }),
  );
} finally {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
}
