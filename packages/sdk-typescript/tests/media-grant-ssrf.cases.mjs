/**
 * A non-loopback Hue origin must not be able to aim a media download at this machine.
 *
 * `media.evil.test` answers 127.0.0.1 on the first lookup and 127.0.0.2 on every later one.
 * Both addresses run the probe, so a fix that resolves the name, treats it as safe, then
 * lets fetch resolve it again still connects here.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import dns from "node:dns";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { createEvaluationClient, MediaFetchError } from "../dist/evals.js";

const cert = process.env.HUE_MEDIA_GRANT_CERT;
const key = process.env.HUE_MEDIA_GRANT_KEY;
if (!cert || !key) throw new Error("HUE_MEDIA_GRANT_CERT and HUE_MEDIA_GRANT_KEY are required");

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const snapshotId = "4bf92f35-77b3-4da6-a3ce-929d0e0e4736";
const declared = Buffer.from("recorded-file");
const digest = createHash("sha256").update(declared).digest("hex");
const probeBody = Buffer.alloc(declared.length, 0x78);
const apiKey = "synthetic-media-key";

const downloads = [];
const grants = [];
let evilLookups = 0;
const originalLookup = dns.lookup;

function answerLookup(options, callback, address) {
  if (options.all) callback(null, [{ address, family: 4 }]);
  else callback(null, address, 4);
}

dns.lookup = function lookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  } else if (typeof options === "number") options = { family: options };
  else options = options ?? {};
  if (hostname === "hue-media-api.test") return answerLookup(options, callback, "127.0.0.1");
  if (hostname === "media.evil.test") {
    evilLookups += 1;
    return answerLookup(options, callback, evilLookups === 1 ? "127.0.0.1" : "127.0.0.2");
  }
  return originalLookup.call(dns, hostname, options, callback);
};

/** @type {{ url: string; method?: string } | undefined} */
let nextGrant;
const tls = { cert: readFileSync(cert), key: readFileSync(key) };

function seen(request) {
  return {
    method: request.method,
    path: new URL(request.url ?? "/", "http://127.0.0.1").pathname,
    authorization: request.headers.authorization ? "present" : "absent",
  };
}

function apiHandler(request, response) {
  grants.push(seen(request));
  const match = /\/blobs\/([0-9a-f]{64})/.exec(request.url ?? "");
  const asked = match?.[1];
  if (!asked || !nextGrant || asked !== digest) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"Not found"}');
    return;
  }
  const body = {
    sha256: digest,
    size: probeBody.length,
    url: nextGrant.url,
    ...(nextGrant.method === undefined ? {} : { method: nextGrant.method }),
  };
  response.writeHead(200, { "content-type": "application/json", connection: "close" });
  response.end(JSON.stringify(body));
}

function probeHandler(request, response) {
  downloads.push(seen(request));
  response.writeHead(200, { "content-type": "application/octet-stream", connection: "close" });
  response.end(probeBody);
}

function listen(server, host, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

const api = createHttpsServer(tls, apiHandler);
const httpProbe = createHttpServer(probeHandler);
const httpProbeV6 = createHttpServer(probeHandler);
const tlsProbe = createHttpsServer(tls, probeHandler);
const tlsProbeNext = createHttpsServer(tls, probeHandler);
let client;

before(async () => {
  const apiPort = await listen(api, "127.0.0.1");
  const httpPort = await listen(httpProbe, "127.0.0.1");
  await listen(httpProbeV6, "::1", httpPort);
  const tlsPort = await listen(tlsProbe, "127.0.0.1");
  await listen(tlsProbeNext, "127.0.0.2", tlsPort);
  client = createEvaluationClient({
    apiKey,
    baseUrl: `https://hue-media-api.test:${apiPort}`,
  });
  httpProbe.port = httpPort;
  tlsProbe.port = tlsPort;
});

after(() => {
  dns.lookup = originalLookup;
  for (const server of [api, httpProbe, httpProbeV6, tlsProbe, tlsProbeNext]) server.close();
});

const targets = [
  {
    name: "http://127.0.0.1 with method GET",
    url: () => `http://127.0.0.1:${httpProbe.port}/admin`,
    method: "GET",
  },
  {
    name: "http://127.0.0.1 with method omitted",
    url: () => `http://127.0.0.1:${httpProbe.port}/omitted`,
  },
  {
    name: "http://[::1]",
    url: () => `http://[::1]:${httpProbe.port}/v6`,
    method: "GET",
  },
  {
    name: "http://localhost",
    url: () => `http://localhost:${httpProbe.port}/local`,
    method: "GET",
  },
  {
    name: "https://127.0.0.1",
    url: () => `https://127.0.0.1:${tlsProbe.port}/admin`,
    method: "GET",
  },
  {
    name: "https://media.evil.test, first lookup 127.0.0.1 and later lookups 127.0.0.2",
    url: () => `https://media.evil.test:${tlsProbe.port}/rebind`,
    method: "GET",
    rebind: true,
  },
];

for (const target of targets) {
  test(`fetch from a non-loopback origin does not GET ${target.name}`, async () => {
    downloads.length = 0;
    grants.length = 0;
    if (target.rebind) evilLookups = 0;
    nextGrant = {
      url: target.url(),
      ...(target.method === undefined ? {} : { method: target.method }),
    };
    let error;
    try {
      await client.media.fetch({ traceId, sha256: digest });
    } catch (caught) {
      error = caught;
    }
    assert.ok(grants.length >= 1, "the grant request did not reach the Hue origin");
    assert.deepEqual(downloads, []);
    assert.ok(error instanceof MediaFetchError);
    assert.equal(error.reason, "failed");
  });
}

test("fetch of a snapshot copy uses the same download and does not GET loopback", async () => {
  downloads.length = 0;
  grants.length = 0;
  nextGrant = { url: `http://127.0.0.1:${httpProbe.port}/snapshot`, method: "GET" };
  let error;
  try {
    await client.media.fetch({ snapshotId, sha256: digest });
  } catch (caught) {
    error = caught;
  }
  assert.ok(grants.some((hit) => hit.path.startsWith("/api/v1/trace-snapshots/")));
  assert.deepEqual(downloads, []);
  assert.ok(error instanceof MediaFetchError);
  assert.equal(error.reason, "failed");
});

test("resolve does not GET the grant URL", async () => {
  downloads.length = 0;
  grants.length = 0;
  nextGrant = { url: `http://127.0.0.1:${httpProbe.port}/resolve`, method: "GET" };
  const resolution = await client.media.resolve(
    [{ type: "image_url", image_url: {}, sha256: digest, size: declared.length }],
    { traceId },
  );
  assert.ok(grants.length >= 1, "the grant request did not reach the Hue origin");
  assert.deepEqual(downloads, []);
  assert.equal(resolution.resolved, 0);
  assert.equal(resolution.failures[0]?.reason, "failed");
});
