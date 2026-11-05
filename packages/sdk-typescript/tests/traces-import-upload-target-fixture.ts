import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import type { Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { gzipSync } from "node:zlib";
import { BlobUploader } from "../src/blobs.js";
import { runWorldCommand, type WorldCommandIo } from "../src/cli/world.js";
import { createEvaluationClient } from "../src/evals/client.js";
import {
  uploadTraceBundle,
  type UploadIo,
  type UploadReport,
} from "../src/cli/traces-import-upload.js";

export const IMPORT_ID = "3f2c1a0e-5b6d-4c7e-8f90-a1b2c3d4e5f6";
export const IMPORT_ORIGIN = "https://import.example";
export const IMPORT_URL = `${IMPORT_ORIGIN}/api/v1/trace-imports/${IMPORT_ID}`;
/** Obvious placeholder. The importer accepts only this shape; it is not a real authorization. */
export const IMPORT_TOKEN = `hue_it_${"a".repeat(43)}`;
/** Obvious placeholder. Not a project key. */
export const WORLD_KEY = "synthetic-project-key";
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const WORLD_ID = "6c84fb90-12c4-11e1-840d-7b25c5ee775a";

export interface Hit {
  localAddress: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface Reservation {
  url: string;
  method?: string;
  headers?: Record<string, string>;
}

const directories: string[] = [];

export async function removeFixtures(): Promise<void> {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hue-upload-target-"));
  directories.push(directory);
  return directory;
}

/** A prepared bundle with one small value. The batch is valid so a mistaken upload can finish. */
async function bundle(payload: Buffer): Promise<string> {
  const directory = await scratch();
  const digest = sha256(payload);
  const batch = gzipSync(
    Buffer.from(
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [{ spans: [{ spanId: "b7ad6b7169203331", name: "synthetic" }] }],
          },
        ],
      }),
    ),
  );
  const manifest = {
    version: 1,
    source: { formats: ["otlp_json"], helper: "upload-target-fixture" },
    traces: [
      {
        trace_id: TRACE_ID,
        span_count: 1,
        batches: [{ sha256: sha256(batch), bytes: batch.byteLength, span_count: 1 }],
        blobs: [{ sha256: digest, byte_size: payload.byteLength, content_type: "text/plain" }],
        origin: "unknown",
      },
    ],
  };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(directory, `${TRACE_ID}.${sha256(batch)}.json.gz`), batch);
  await writeFile(join(directory, `${digest}.blob`), payload);
  return directory;
}

function headersOf(request: http.IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers[name] = value;
    else if (Array.isArray(value)) headers[name] = value.join(",");
  }
  return headers;
}

async function readBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** Records every request, then answers 200. A refusal that still delivered bytes fails the test. */
export function recordHits(hits: Hit[]) {
  return async (request: http.IncomingMessage, response: http.ServerResponse) => {
    const body = await readBody(request);
    hits.push({
      localAddress: request.socket.localAddress ?? "",
      method: request.method ?? "",
      url: request.url ?? "",
      headers: headersOf(request),
      body: body.toString("utf8"),
    });
    response.writeHead(200);
    response.end();
  };
}

export function portOf(server: NetServer): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The listener has no port");
  return address.port;
}

export function listen(server: NetServer, hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, hostname, () => resolve(portOf(server)));
  });
}

export async function tlsMaterial(): Promise<{ key: Buffer; cert: Buffer }> {
  const directory = await scratch();
  const key = join(directory, "key.pem");
  const cert = join(directory, "cert.pem");
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=rebind.test",
      "-addext",
      "subjectAltName=DNS:rebind.test,DNS:world-rebind.test,DNS:blob-rebind.test,DNS:artifact-rebind.test,DNS:import.example,IP:127.0.0.1",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr || "openssl failed");
  const { readFile } = await import("node:fs/promises");
  return { key: await readFile(key), cert: await readFile(cert) };
}

function responseJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Hue's import routes, answered in this process. Every other URL is a real fetch. */
export function importFetch(reservation: Reservation): UploadIo["fetch"] {
  return async (input, init) => {
    const url = new URL(input);
    if (url.origin !== IMPORT_ORIGIN) return fetch(input, init);
    const action = url.pathname.slice(`/api/v1/trace-imports/${IMPORT_ID}`.length);
    if (init?.method === "PUT" && action === "/manifest")
      return responseJson(
        { trace_import: { id: IMPORT_ID, state: "registered" }, registered: true },
        201,
      );
    if (init?.method === "POST" && action === "/blobs")
      return responseJson({
        status: "upload",
        url: reservation.url,
        ...(reservation.method === undefined ? {} : { method: reservation.method }),
        headers: reservation.headers ?? { "content-type": "text/plain" },
      });
    if (init?.method === "POST" && action === "/blobs/complete")
      return responseJson({ status: "complete" });
    if (init?.method === "POST" && action === "/batches") return responseJson({});
    if (init?.method === "GET" && action.endsWith("/receipt"))
      return responseJson({ missingSpanIds: [] });
    if (init?.method === "POST" && (action === "/reconcile" || action === "/complete"))
      return responseJson({});
    return responseJson({ error: "unexpected", code: "not_found" }, 404);
  };
}

const instant: UploadIo["sleep"] = async () => {};
const quiet = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

/** Uploads one value. `bind` is where the listener sits; the reservation URL can name another host. */
export async function importHits(
  bind: string,
  reservation: (port: number) => Reservation,
  payload: Buffer,
  secure = false,
): Promise<{ hits: Hit[]; report: UploadReport }> {
  const hits: Hit[] = [];
  const server = secure
    ? https.createServer(await tlsMaterial(), recordHits(hits))
    : http.createServer(recordHits(hits));
  const port = await listen(server, bind);
  const directory = await bundle(payload);
  try {
    const report = await uploadTraceBundle(
      { directory, token: IMPORT_TOKEN, importUrl: IMPORT_URL },
      {
        fetch: importFetch(reservation(port)),
        sleep: instant,
        onInterrupt: () => () => {},
      },
    );
    return { hits, report };
  } finally {
    server.close();
  }
}

function worldFetch(reservation: Reservation): WorldCommandIo["fetch"] {
  return async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin !== IMPORT_ORIGIN) return fetch(input, init);
    if (url.pathname === "/api/v1/world-creations" && init?.method === "POST")
      return responseJson(
        {
          worldCreation: { id: WORLD_ID, status: "uploading" },
          uploads: [
            {
              app: "linear",
              file: 1,
              urlKey: "uploadUrl_linear_1",
              ...(reservation.method === undefined ? {} : { method: reservation.method }),
              uploadHeaders: reservation.headers ?? { "content-type": "application/json" },
            },
          ],
          uploadUrl_linear_1: reservation.url,
        },
        201,
      );
    if (url.pathname === `/api/v1/world-creations/${WORLD_ID}/uploaded`)
      return responseJson({ worldCreation: { id: WORLD_ID, status: "importing" } });
    return responseJson({ error: "unexpected" }, 404);
  };
}

/** `hue world create` against a remote origin that chooses the upload URL. */
export async function worldHits(
  bind: string,
  reservation: (port: number) => Reservation,
  payload: Buffer,
  secure = false,
): Promise<{ hits: Hit[]; code: number }> {
  const hits: Hit[] = [];
  const server = secure
    ? https.createServer(await tlsMaterial(), recordHits(hits))
    : http.createServer(recordHits(hits));
  const port = await listen(server, bind);
  const cwd = await scratch();
  await mkdir(join(cwd, "data"));
  await writeFile(join(cwd, "data", "issues.json"), payload);
  try {
    const code = await runWorldCommand(
      ["create", "--apps", "linear", "--files", "data", "--origin", IMPORT_ORIGIN, "--wait", "0"],
      {
        stdout: quiet,
        stderr: quiet,
        env: { PATH: process.env.PATH ?? "", HUE_API_KEY: WORLD_KEY },
        cwd,
        fetch: worldFetch(reservation(port)),
        sleep: async () => {},
        onInterrupt: () => () => {},
      },
    );
    return { hits, code };
  } finally {
    server.close();
  }
}

interface BlobReservation {
  url: string;
  headers?: Record<string, string>;
}

/**
 * A remote Hue origin (https://import.example, resolved only when the test preloads the
 * lookup) that answers one presigned PUT. `hits` collects bytes on `sink` when `url` points there.
 */
export async function blobHits(
  reservation: BlobReservation,
  payload: Buffer,
  api: https.Server,
  sinkHits: Hit[],
): Promise<{ ok: boolean; hits: Hit[] }> {
  const before = sinkHits.length;
  const digest = sha256(payload);
  const uploader = new BlobUploader({
    baseUrl: `https://import.example:${portOf(api)}`,
    apiKey: WORLD_KEY,
    timeoutMillis: 5_000,
    allowInsecureHttp: false,
    userAgent: "upload-target-fixture",
  });
  const answer = {
    status: "upload",
    method: "PUT",
    url: reservation.url,
    headers: {
      "content-type": "text/plain",
      "x-evil": "chosen",
      ...reservation.headers,
    },
    ref: { content_type: "text/plain" },
  };
  const onRequest = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    await readBody(request);
    if (request.url === "/api/v1/otlp/blobs") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(answer));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  };
  api.removeAllListeners("request");
  api.on("request", onRequest);
  try {
    const outcome = await uploader.store(
      TRACE_ID,
      "input.value",
      payload,
      "text/plain",
      { sha256: digest, size: payload.byteLength },
      { deadline: Date.now() + 8_000, wait: async () => false },
    );
    return { ok: outcome.ok, hits: sinkHits.slice(before) };
  } finally {
    uploader.close();
  }
}

/** Stages artifact bytes at a server-chosen URL. The Hue origin is never contacted. */
export async function artifactHits(
  bind: string,
  url: (port: number) => string,
  payload: Buffer,
  secure = false,
): Promise<{ hits: Hit[]; rejected: boolean }> {
  const hits: Hit[] = [];
  const server = secure
    ? https.createServer(await tlsMaterial(), recordHits(hits))
    : http.createServer(recordHits(hits));
  const port = await listen(server, bind);
  const client = createEvaluationClient({
    apiKey: WORLD_KEY,
    baseUrl: IMPORT_ORIGIN,
    timeoutMillis: 100,
  });
  let rejected = false;
  try {
    await client.uploadArtifactBytes(
      {
        uploadUrl: url(port),
        method: "PUT",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      payload,
      "text/plain",
    );
  } catch {
    rejected = true;
  } finally {
    server.close();
  }
  return { hits, rejected };
}

export const IMPORT_PAYLOAD = Buffer.from("synthetic-import-blob");
export const WORLD_PAYLOAD = Buffer.from("synthetic-world-file");
export const BLOB_PAYLOAD = Buffer.from("synthetic-value-bytes");
export const ARTIFACT_PAYLOAD = Buffer.from("synthetic-artifact-bytes");
