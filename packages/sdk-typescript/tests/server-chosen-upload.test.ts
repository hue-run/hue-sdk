import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Writable } from "node:stream";
import { runWorldCommand } from "../src/cli/world.js";
import { uploadTraceBundle } from "../src/cli/traces-import-upload.js";

/**
 * Spec for a hostile Hue origin that answers an upload with its own URL, method and headers.
 *
 * `hue world create` (and the trace-import value upload, which applies the same check) may send
 * a local file only when the Hue origin itself is loopback, or to that origin. An answer whose
 * URL is http to this machine, or https to any other host, is refused before the request. The
 * file on disk stays as it was. A method or header from the answer is not a reason to send it.
 *
 * These tests fail while that request is still made.
 *
 * Not covered here: `hue world create --export-from` reaches the same `upload` as `--files`.
 * This commit has no world update command. Blob and artifact uploads force PUT and reject
 * arbitrary headers, so they are a different check.
 */

const ORIGIN = "https://hue.attacker.test";
const KEY = "hue_sk_test_world_upload_placeholder";
const CREATION = "6f9c1e2a-4b3d-4c5e-8f70-1a2b3c4d5e6f";
const VERSION = "0b7e3f5c-9d2a-4e1b-a6c8-7f9e0d1c2b3a";
const IMPORT_ID = "6f9c1e2a-4b3d-4c5e-8f70-1a2b3c4d5e6f";
const TOKEN = `hue_it_${"a".repeat(43)}`;
const FILE_TEXT = "linear-export-row\n";
const MARKER = "chosen-by-the-answer";

interface Delivery {
  method: string;
  url: string;
  marker: string | null;
  body: string;
}

const closers: (() => Promise<void>)[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function markerOf(headers: HeadersInit | undefined): string | null {
  if (headers === undefined) return null;
  if (headers instanceof Headers) return headers.get("x-attacker-choice");
  if (Array.isArray(headers)) {
    const found = headers.find(([name]) => name.toLowerCase() === "x-attacker-choice");
    return found === undefined ? null : found[1];
  }
  for (const [name, value] of Object.entries(headers))
    if (name.toLowerCase() === "x-attacker-choice") return value;
  return null;
}

async function bytesOf(body: BodyInit | null | undefined): Promise<Buffer> {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (body instanceof ReadableStream) {
    const chunks: Uint8Array[] = [];
    const reader = body.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    return Buffer.concat(chunks);
  }
  return Buffer.from(body.toString());
}

/** A loopback receiver. What arrives here left the process through fetch. */
function sink(hostname: "127.0.0.1" | "::1"): Promise<{ port: number; hits: Delivery[] }> {
  const hits: Delivery[] = [];
  const server: Server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const header = request.headers["x-attacker-choice"];
      hits.push({
        method: request.method ?? "",
        url: request.url ?? "",
        marker: typeof header === "string" ? header : null,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200);
      response.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The sink has no port"));
        return;
      }
      closers.push(
        () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      );
      resolve({ port: address.port, hits });
    });
  });
}

function creation(status: string) {
  return {
    id: CREATION,
    status,
    worldVersionId: status === "ready" ? VERSION : null,
    url: `${ORIGIN}/worlds/${CREATION}`,
  };
}

/** Runs `hue world create --files` against a remote origin whose answer names `uploadUrl`. */
async function createWithUpload(uploadUrl: string, method: string | undefined, fileText: string) {
  const directory = await mkdtemp(join(tmpdir(), "hue-upload-"));
  directories.push(directory);
  const file = join(directory, "issues.json");
  await writeFile(file, fileText);
  const uploaded: string[] = [];
  const offOrigin: Delivery[] = [];
  const fetchImpl = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.origin === ORIGIN) {
        if (url.pathname === `/api/v1/world-creations/${CREATION}/uploaded`)
          uploaded.push(url.pathname);
        const answer =
          url.pathname === "/api/v1/world-creations"
            ? {
                worldCreation: creation("uploading"),
                uploads: [
                  {
                    app: "linear",
                    file: 1,
                    urlKey: "uploadUrl",
                    ...(method === undefined ? {} : { method }),
                    uploadHeaders: {
                      "content-length": "1",
                      "x-attacker-choice": MARKER,
                    },
                  },
                ],
                uploadUrl,
              }
            : { worldCreation: creation("importing") };
        return Response.json(answer, {
          status: url.pathname === "/api/v1/world-creations" ? 201 : 200,
        });
      }
      // http to this machine is a real socket. Anything else is the exfiltration call.
      if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
        return fetch(input, init);
      offOrigin.push({
        method: init?.method ?? "",
        url: url.href,
        marker: markerOf(init?.headers),
        body: (await bytesOf(init?.body)).toString("utf8"),
      });
      return new Response(null, { status: 200 });
    },
    { preconnect: fetch.preconnect },
  );
  const discard = () =>
    new Writable({
      write: (_chunk, _encoding, done) => done(),
    });
  const code = await runWorldCommand(
    ["create", "--apps", "linear", "--files", ".", "--origin", ORIGIN, "--wait", "0"],
    {
      stdout: discard(),
      stderr: discard(),
      env: { PATH: process.env.PATH ?? "", HUE_API_KEY: KEY },
      cwd: directory,
      sleep: async () => undefined,
      onInterrupt: () => () => undefined,
      fetch: fetchImpl,
    },
  );
  return {
    code,
    uploaded,
    offOrigin,
    fileText: await readFile(file, "utf8"),
  };
}

describe("hue world create upload destination", () => {
  test("a remote origin cannot POST the file to 127.0.0.1 with the answer's header", async () => {
    const receiver = await sink("127.0.0.1");
    const uploadUrl = `http://127.0.0.1:${receiver.port}/taken?signature=not-a-secret`;
    const result = await createWithUpload(uploadUrl, "POST", FILE_TEXT);
    expect(receiver.hits).toEqual([]);
    expect(result.offOrigin).toEqual([]);
    expect(result.uploaded).toEqual([]);
    expect(result.fileText).toBe(FILE_TEXT);
    expect(result.code).toBe(1);
  });

  test("a remote origin cannot PUT the file to localhost", async () => {
    const receiver = await sink("127.0.0.1");
    const uploadUrl = `http://localhost:${receiver.port}/taken`;
    const result = await createWithUpload(uploadUrl, "PUT", FILE_TEXT);
    expect(receiver.hits).toEqual([]);
    expect(result.offOrigin).toEqual([]);
    expect(result.uploaded).toEqual([]);
    expect(result.fileText).toBe(FILE_TEXT);
    expect(result.code).toBe(1);
  });

  test("a remote origin cannot POST the file to [::1]", async () => {
    const receiver = await sink("::1");
    const uploadUrl = `http://[::1]:${receiver.port}/taken`;
    const result = await createWithUpload(uploadUrl, "POST", FILE_TEXT);
    expect(receiver.hits).toEqual([]);
    expect(result.offOrigin).toEqual([]);
    expect(result.uploaded).toEqual([]);
    expect(result.fileText).toBe(FILE_TEXT);
    expect(result.code).toBe(1);
  });

  test("a decimal loopback address is the same request after the URL is parsed", async () => {
    const receiver = await sink("127.0.0.1");
    // `new URL` rewrites this to http://127.0.0.1. A check of the raw text misses the host that is fetched.
    const uploadUrl = `http://2130706433:${receiver.port}/taken`;
    const result = await createWithUpload(uploadUrl, "POST", FILE_TEXT);
    expect(receiver.hits).toEqual([]);
    expect(result.offOrigin).toEqual([]);
    expect(result.uploaded).toEqual([]);
    expect(result.fileText).toBe(FILE_TEXT);
    expect(result.code).toBe(1);
  });

  test("userinfo on a loopback upload URL still addresses this machine", async () => {
    const receiver = await sink("127.0.0.1");
    const uploadUrl = `http://upload:marker@127.0.0.1:${receiver.port}/taken`;
    const result = await createWithUpload(uploadUrl, "POST", FILE_TEXT);
    expect(receiver.hits).toEqual([]);
    expect(result.offOrigin).toEqual([]);
    expect(result.uploaded).toEqual([]);
    expect(result.fileText).toBe(FILE_TEXT);
    expect(result.code).toBe(1);
  });

  test("a remote origin cannot send the file to an arbitrary https host", async () => {
    const uploadUrl = "https://collect.attacker.test/object?signature=not-a-secret";
    const result = await createWithUpload(uploadUrl, "DELETE", FILE_TEXT);
    expect(result.offOrigin).toEqual([]);
    expect(result.uploaded).toEqual([]);
    expect(result.fileText).toBe(FILE_TEXT);
    expect(result.code).toBe(1);
  });

  test("an omitted method still defaults to PUT toward that https host", async () => {
    const uploadUrl = "https://collect.attacker.test/object";
    const result = await createWithUpload(uploadUrl, undefined, FILE_TEXT);
    expect(result.offOrigin).toEqual([]);
    expect(result.uploaded).toEqual([]);
    expect(result.fileText).toBe(FILE_TEXT);
    expect(result.code).toBe(1);
  });
});

const TRACE = "a1b2c3d4e5f6789012345678abcdef01";
const SPAN = "0123456789abcdef";

async function importWithUpload(uploadUrl: string, method: string) {
  const directory = await mkdtemp(join(tmpdir(), "hue-import-upload-"));
  directories.push(directory);
  const blob = Buffer.from("exported-value");
  const batch = gzipSync(
    Buffer.from(
      JSON.stringify({
        resourceSpans: [{ scopeSpans: [{ spans: [{ spanId: SPAN }] }] }],
      }),
    ),
  );
  const blobSha = createHash("sha256").update(blob).digest("hex");
  const batchSha = createHash("sha256").update(batch).digest("hex");
  const manifest = {
    version: 1 as const,
    source: { formats: ["otlp_json" as const], helper: "upload-url-test" },
    traces: [
      {
        trace_id: TRACE,
        span_count: 1,
        origin: "unknown" as const,
        batches: [{ sha256: batchSha, bytes: batch.byteLength, span_count: 1 }],
        blobs: [{ sha256: blobSha, byte_size: blob.byteLength, content_type: "text/plain" }],
      },
    ],
  };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(directory, `${blobSha}.blob`), blob);
  await writeFile(join(directory, `${TRACE}.${batchSha}.json.gz`), batch);
  const importUrl = `${ORIGIN}/api/v1/trace-imports/${IMPORT_ID}`;
  const offOrigin: Delivery[] = [];
  const report = await uploadTraceBundle(
    { directory, token: TOKEN, importUrl },
    {
      sleep: async () => undefined,
      onInterrupt: () => () => undefined,
      checkpointIntervalMs: 0,
      fetch: async (input, init) => {
        const url = new URL(input);
        if (url.origin === ORIGIN) {
          if (url.pathname.endsWith("/manifest"))
            return Response.json(
              { trace_import: { id: IMPORT_ID, state: "registered" } },
              { status: 201 },
            );
          if (url.pathname.endsWith("/blobs") && init?.method === "POST")
            return Response.json({
              status: "upload",
              url: uploadUrl,
              method,
              headers: { "content-length": "1", "x-attacker-choice": MARKER },
            });
          if (url.pathname.endsWith("/blobs/complete")) return Response.json({ stored: true });
          if (url.pathname.endsWith("/batches")) return Response.json({});
          if (url.pathname.endsWith("/receipt")) return Response.json({ missingSpanIds: [] });
          if (url.pathname.endsWith("/reconcile") || url.pathname.endsWith("/complete"))
            return Response.json({ trace_import: { id: IMPORT_ID, state: "completed" } });
          return Response.json({ error: "unexpected" }, { status: 404 });
        }
        if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
          return fetch(input, init);
        offOrigin.push({
          method: init?.method ?? "",
          url: url.href,
          marker: markerOf(init?.headers),
          body: (await bytesOf(init?.body)).toString("utf8"),
        });
        return new Response(null, { status: 200 });
      },
    },
  );
  return {
    report,
    offOrigin,
    blobText: await readFile(join(directory, `${blobSha}.blob`), "utf8"),
  };
}

describe("hue traces import value upload destination", () => {
  test("a remote import origin cannot POST the value to 127.0.0.1", async () => {
    const receiver = await sink("127.0.0.1");
    const uploadUrl = `http://127.0.0.1:${receiver.port}/blob`;
    const result = await importWithUpload(uploadUrl, "POST");
    expect(receiver.hits).toEqual([]);
    expect(result.offOrigin).toEqual([]);
    expect(result.blobText).toBe("exported-value");
    expect(result.report.state).toBe("failed");
  });

  test("a remote import origin cannot send the value to an arbitrary https host", async () => {
    const uploadUrl = "https://collect.attacker.test/blob";
    const result = await importWithUpload(uploadUrl, "DELETE");
    expect(result.offOrigin).toEqual([]);
    expect(result.blobText).toBe("exported-value");
    expect(result.report.state).toBe("failed");
  });
});
