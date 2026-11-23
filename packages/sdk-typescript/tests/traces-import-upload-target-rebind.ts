/**
 * Run with LD_PRELOAD set to tests/fixtures/rebind-lookup.c (built as a shared library).
 * The first lookup of each rebind name is 203.0.113.10 and every later lookup is 127.0.0.1.
 * Prints one JSON array. A hit means the bytes were delivered.
 */
import http from "node:http";
import https from "node:https";
import {
  ARTIFACT_PAYLOAD,
  BLOB_PAYLOAD,
  IMPORT_PAYLOAD,
  WORLD_PAYLOAD,
  artifactHits,
  blobHits,
  importHits,
  listen,
  recordHits,
  removeFixtures,
  tlsMaterial,
  worldHits,
  type Hit,
} from "./traces-import-upload-target-fixture.ts";

const headers = { "content-type": "application/json", "x-evil": "chosen" };

const results: {
  name: string;
  hits: Hit[];
  state?: string;
  code?: number;
  ok?: boolean;
  rejected?: boolean;
}[] = [];

const imported = await importHits(
  "0.0.0.0",
  (port) => ({
    url: `https://rebind.test:${port}/sink/chosen?x=1`,
    method: "PUT",
    headers,
  }),
  IMPORT_PAYLOAD,
  true,
);
results.push({ name: "import-rebind", hits: imported.hits, state: imported.report.state });

const world = await worldHits(
  "0.0.0.0",
  (port) => ({
    url: `https://world-rebind.test:${port}/sink/chosen`,
    method: "POST",
    headers,
  }),
  WORLD_PAYLOAD,
  true,
);
results.push({ name: "world-rebind", hits: world.hits, code: world.code });

const material = await tlsMaterial();
const api = https.createServer(material);
await listen(api, "127.0.0.1");
const loopbackHits: Hit[] = [];
const loopback = http.createServer(recordHits(loopbackHits));
const loopbackPort = await listen(loopback, "127.0.0.1");
const rebindHits: Hit[] = [];
const rebind = https.createServer(material, recordHits(rebindHits));
const rebindPort = await listen(rebind, "0.0.0.0");

try {
  const literal = await blobHits(
    { url: `http://127.0.0.1:${loopbackPort}/sink/chosen` },
    BLOB_PAYLOAD,
    api,
    loopbackHits,
  );
  results.push({ name: "blob-loopback", hits: literal.hits, ok: literal.ok });
  const rebound = await blobHits(
    { url: `https://blob-rebind.test:${rebindPort}/sink/chosen` },
    BLOB_PAYLOAD,
    api,
    rebindHits,
  );
  results.push({ name: "blob-rebind", hits: rebound.hits, ok: rebound.ok });
  const artifact = await artifactHits(
    "0.0.0.0",
    (port) => `https://artifact-rebind.test:${port}/artifact`,
    ARTIFACT_PAYLOAD,
    true,
  );
  results.push({ name: "artifact-rebind", hits: artifact.hits, rejected: artifact.rejected });
} finally {
  api.close();
  loopback.close();
  rebind.close();
  await removeFixtures();
}

process.stdout.write(`${JSON.stringify(results)}\n`);
