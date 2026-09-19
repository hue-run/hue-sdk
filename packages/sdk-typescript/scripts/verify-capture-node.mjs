import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { CaptureSession } from "@hue-run/sdk/capture";

const records = [];
const sourceBytes = Buffer.from("synthetic source bytes");
const contentType = "text/plain";
const artifactId = "22222222-2222-4222-8222-222222222222";
const signedPath = "/upload?signature=A%2fb+%2B&empty=&duplicate=x&duplicate=y";
const storageRequests = [];
let storageFailure;
let storedBytes;
let suppliedHeaders;
let uploadUrlOverride;
let completionStatus = 200;
let completionCalls = 0;
const storage = createHttpsServer(
  {
    cert: await readFile(new URL("./tests/fixtures/capture-localhost-cert.pem", import.meta.url)),
    key: await readFile(new URL("./tests/fixtures/capture-localhost-key.pem", import.meta.url)),
  },
  async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    storageRequests.push({
      path: request.url,
      headers: request.headers,
      method: request.method,
      body,
    });
    storedBytes = body;
    if (storageFailure === "disconnect") request.socket.destroy();
    else if (storageFailure === "http503") {
      response.writeHead(503);
      response.end();
    } else if (storageFailure === "redirect") {
      storedBytes = undefined;
      response.writeHead(307, { location: "/redirected" });
      response.end();
    } else {
      response.writeHead(201);
      response.end();
    }
  },
);
storage.listen(0, "127.0.0.1");
await once(storage, "listening");
const storageOrigin = `https://127.0.0.1:${storage.address().port}`;
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
    } else if (request.url.endsWith("/artifacts")) {
      assert.equal(body.byteSize, sourceBytes.byteLength);
      assert.equal(body.contentType, contentType);
      response.end(JSON.stringify({ id: artifactId }));
    } else if (request.url.endsWith("/upload")) {
      response.end(
        JSON.stringify({
          method: "PUT",
          uploadUrl: uploadUrlOverride ?? `${storageOrigin}${signedPath}`,
          ...(suppliedHeaders === undefined ? {} : { headers: suppliedHeaders }),
        }),
      );
    } else if (request.url.endsWith("/complete")) {
      completionCalls++;
      response.statusCode = storedBytes?.equals(sourceBytes) ? completionStatus : 409;
      response.end(JSON.stringify({ id: artifactId, state: "ready" }));
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
  let uploadCases = 0;
  for (const headers of [
    undefined,
    null,
    { "content-type": contentType, "x-vercel-blob-access": "private" },
  ]) {
    for (const failure of [undefined, "disconnect", "http503"]) {
      suppliedHeaders = headers;
      storageFailure = failure;
      storedBytes = undefined;
      const writesBefore = storageRequests.length;
      const completionsBefore = completionCalls;
      const uploaded = await capture.uploadSource({
        filename: "source.txt",
        contentType,
        bytes: sourceBytes,
      });
      assert.equal(
        uploaded?.artifactId,
        artifactId,
        "authoritative completion settles a lost PUT acknowledgement",
      );
      assert.equal(storageRequests.length, writesBefore + 1, "the signed PUT is never replayed");
      assert.equal(completionCalls, completionsBefore + 1);
      const write = storageRequests.at(-1);
      assert.equal(write.path, signedPath, "signed query bytes reach storage unchanged");
      assert.equal(write.method, "PUT");
      assert.deepEqual(write.body, sourceBytes);
      assert.equal(write.headers["content-type"], contentType);
      assert.equal(write.headers["content-length"], String(sourceBytes.byteLength));
      assert.equal(
        write.headers.authorization,
        undefined,
        "the project key is never sent to storage",
      );
      assert.equal(write.headers.cookie, undefined);
      uploadCases++;
    }
  }
  for (const failure of ["disconnect", "redirect"]) {
    storageFailure = failure;
    completionStatus = 409;
    const before = storageRequests.length;
    assert.equal(
      await capture.uploadSource({ filename: "source.txt", contentType, bytes: sourceBytes }),
      null,
    );
    assert.equal(
      storageRequests.length,
      before + 1,
      "failed verification and redirects never replay the PUT",
    );
    uploadCases++;
  }
  storageFailure = undefined;
  completionStatus = 200;
  for (const headers of [
    { authorization: "synthetic-forbidden-credential" },
    { cookie: "synthetic-forbidden-cookie" },
    { "content-type": "application/json" },
  ]) {
    suppliedHeaders = headers;
    const before = storageRequests.length;
    assert.equal(
      await capture.uploadSource({ filename: "source.txt", contentType, bytes: sourceBytes }),
      null,
    );
    assert.equal(
      storageRequests.length,
      before,
      "unapproved capability headers are rejected before the write",
    );
    uploadCases++;
  }
  suppliedHeaders = null;
  for (const url of [
    `http://127.0.0.1:${storage.address().port}${signedPath}`,
    `${storageOrigin}${signedPath}#fragment`,
    `https://user:synthetic-secret@127.0.0.1:${storage.address().port}${signedPath}`,
  ]) {
    uploadUrlOverride = url;
    const before = storageRequests.length;
    assert.equal(
      await capture.uploadSource({ filename: "source.txt", contentType, bytes: sourceBytes }),
      null,
    );
    assert.equal(
      storageRequests.length,
      before,
      "capture rejects non-HTTPS, credentials and fragments",
    );
    uploadCases++;
  }
  console.log(
    JSON.stringify({
      node: process.version,
      installedCapture: "passed",
      observations: records.length,
      uploadCases,
      signedWrites: storageRequests.length,
    }),
  );
} finally {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
  storage.closeAllConnections();
  storage.close();
  await once(storage, "close");
}
