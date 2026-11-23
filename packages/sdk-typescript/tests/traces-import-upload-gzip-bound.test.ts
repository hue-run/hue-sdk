import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  MAX_BATCH_DECODED_BYTES,
  sha256Hex,
  traceImportLimits,
  validateManifest,
  type TraceImportManifest,
} from "../src/cli/traces-import-convert.js";
import { uploadTraceBundle, type UploadReport } from "../src/cli/traces-import-upload.js";

/**
 * `spanIdsOf` inflates a manifest-valid batch with `gunzipSync` and no output cap, then parses
 * the whole result. A batch of at most {@link traceImportLimits.batchBytes} compressed bytes whose
 * plaintext exceeds {@link MAX_BATCH_DECODED_BYTES} must come back as a failed upload instead:
 * `error.code` is `bundle_invalid`, and the message names that batch's sha256 and the decimal
 * bound. Exactly the bound still completes. The refused batch is not recorded as landed in
 * `progress.json`. A member that expands to 256 MiB must fail the same way inside a 96 MiB heap,
 * so a fix that inflates the whole member and only then checks the length still fails this file.
 */

const IMPORT_ID = "3f2c1a0e-5b6d-4c7e-8f90-a1b2c3d4e5f6";
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";
const TOKEN = `hue_it_${"a".repeat(43)}`;
const HEAP_MB = 96;
const EXPANSION_BYTES = 256 * 1024 * 1024;
const packageRoot = join(import.meta.dir, "..");

const directories: string[] = [];
const servers: Server[] = [];
let bundleDirectory = "";

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

afterAll(async () => {
  if (bundleDirectory) await rm(bundleDirectory, { recursive: true, force: true });
});

beforeAll(() => {
  bundleDirectory = mkdtempSync(join(tmpdir(), "hue-gzip-bound-bundle-"));
  const outfile = join(bundleDirectory, "upload.mjs");
  const built = spawnSync(
    process.execPath,
    [
      "build",
      join(packageRoot, "src/cli/traces-import-upload.ts"),
      "--target",
      "node",
      "--outfile",
      outfile,
    ],
    { cwd: packageRoot },
  );
  if (built.status !== 0) {
    const detail = `${built.stderr.toString()}${built.stdout.toString()}`;
    throw new Error(`bundling the upload failed: ${detail}`);
  }
  writeFileSync(
    join(bundleDirectory, "child.mjs"),
    [
      'import { uploadTraceBundle } from "./upload.mjs";',
      "const directory = process.argv[2];",
      "const importUrl = process.argv[3];",
      "const token = process.argv[4];",
      "try {",
      "  const report = await uploadTraceBundle(",
      "    { directory, token, importUrl },",
      "    { sleep: async () => {}, onInterrupt: () => () => {}, checkpointIntervalMs: 0 },",
      "  );",
      "  process.stdout.write(JSON.stringify({ kind: 'report', state: report.state, error: report.error, traces: report.traces }));",
      "} catch (error) {",
      "  process.stdout.write(JSON.stringify({ kind: 'throw', name: error.name, code: error.code, message: error.message }));",
      "  process.exitCode = 1;",
      "}",
      "",
    ].join("\n"),
  );
});

function batchPlaintext(bytes: number): Buffer {
  const head = Buffer.from(
    `{"resourceSpans":[{"scopeSpans":[{"spans":[{"spanId":"${SPAN_ID}","name":"`,
  );
  const tail = Buffer.from('"}]}]}]}');
  if (head.byteLength + tail.byteLength >= bytes)
    throw new Error("the batch frame is larger than the plaintext target");
  const body = Buffer.alloc(bytes, 0x61);
  head.copy(body, 0);
  tail.copy(body, bytes - tail.byteLength);
  return body;
}

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hue-gzip-bound-"));
  directories.push(directory);
  return directory;
}

/** A manifest-valid bundle whose one batch is `plaintext` gzip-compressed. */
async function writeBundle(
  directory: string,
  plaintext: Buffer,
): Promise<{ manifest: TraceImportManifest; sha256: string; compressed: number }> {
  const body = gzipSync(plaintext, { level: 9 });
  const sha256 = sha256Hex(body);
  const manifest: TraceImportManifest = {
    version: 1,
    source: { formats: ["otlp_json"], helper: "gzip-bound-test" },
    traces: [
      {
        trace_id: TRACE_ID,
        span_count: 1,
        batches: [{ sha256, bytes: body.byteLength, span_count: 1 }],
        blobs: [],
        origin: "unknown",
      },
    ],
  };
  expect(validateManifest(manifest)).toBeUndefined();
  expect(body.byteLength).toBeGreaterThan(0);
  expect(body.byteLength).toBeLessThanOrEqual(traceImportLimits.batchBytes);
  const manifestBytes = JSON.stringify(manifest);
  await writeFile(join(directory, "manifest.json"), manifestBytes);
  await writeFile(join(directory, `${TRACE_ID}.${sha256}.json.gz`), body);
  return { manifest, sha256, compressed: body.byteLength };
}

function listen(): Promise<{ url: string; batchPosts: () => number }> {
  let batchPosts = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (!path.startsWith(`/api/v1/trace-imports/${IMPORT_ID}`)) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (request.method === "POST" && path.endsWith("/batches")) batchPosts++;
      const status = request.method === "PUT" && path.endsWith("/manifest") ? 201 : 200;
      const payload = path.endsWith("/receipt") ? { missingSpanIds: [] } : {};
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      resolve({
        url: `http://127.0.0.1:${address.port}/api/v1/trace-imports/${IMPORT_ID}`,
        batchPosts: () => batchPosts,
      });
    });
  });
}

function upload(directory: string, importUrl: string): Promise<UploadReport> {
  return uploadTraceBundle(
    { directory, token: TOKEN, importUrl },
    { sleep: async () => {}, onInterrupt: () => () => {}, checkpointIntervalMs: 0 },
  );
}

function expectRejected(report: UploadReport, sha256: string) {
  expect(report.state).toBe("failed");
  expect(report.traces.verified).toBe(0);
  expect(report.error?.code).toBe("bundle_invalid");
  expect(report.error?.message).toContain(sha256);
  expect(report.error?.message).toContain(String(MAX_BATCH_DECODED_BYTES));
}

/** Recording the batch as landed writes `progress.json` before the body is refused. */
async function expectNotLanded(directory: string, sha256: string) {
  const raw = await readFile(join(directory, "progress.json"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  if (!raw) return;
  const progress = JSON.parse(raw) as { traces?: Record<string, { batches?: string[] }> };
  expect(progress.traces?.[TRACE_ID]?.batches ?? []).not.toContain(sha256);
}

interface NodeUpload {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runNodeUpload(directory: string, importUrl: string): Promise<NodeUpload> {
  const child = spawn(
    "node",
    [
      `--max-old-space-size=${HEAP_MB}`,
      join(bundleDirectory, "child.mjs"),
      directory,
      importUrl,
      TOKEN,
    ],
    { stdio: ["ignore", "pipe", "pipe"], signal: AbortSignal.timeout(60_000) },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

describe("trace import upload batch gzip bound", () => {
  test("accepts a batch whose plaintext is exactly the decoded bound", async () => {
    const directory = await scratch();
    await writeBundle(directory, batchPlaintext(MAX_BATCH_DECODED_BYTES));
    const server = await listen();
    const report = await upload(directory, server.url);
    expect(report.state).toBe("completed");
    expect(report.traces).toEqual({ declared: 1, verified: 1, conflicted: 0, unverified: 0 });
    expect(server.batchPosts()).toBe(1);
  });

  test("rejects a batch whose plaintext exceeds the decoded bound by one byte", async () => {
    const directory = await scratch();
    const { sha256 } = await writeBundle(directory, batchPlaintext(MAX_BATCH_DECODED_BYTES + 1));
    const server = await listen();
    const report = await upload(directory, server.url);
    expectRejected(report, sha256);
    await expectNotLanded(directory, sha256);
  });

  test("rejects an over-bound batch that progress already lists as landed", async () => {
    const directory = await scratch();
    const { sha256 } = await writeBundle(directory, batchPlaintext(MAX_BATCH_DECODED_BYTES + 1));
    const server = await listen();
    const manifestBytes = await readFile(join(directory, "manifest.json"));
    await writeFile(
      join(directory, "progress.json"),
      JSON.stringify({
        version: 1,
        manifest_digest: sha256Hex(manifestBytes),
        import_url: server.url,
        traces: {
          [TRACE_ID]: { state: "pending", blobs: [], batches: [sha256], conflicts: [] },
        },
      }),
    );
    const report = await upload(directory, server.url);
    expect(server.batchPosts()).toBe(0);
    expectRejected(report, sha256);
  });

  test("rejects a 256 MiB expansion inside a 96 MiB heap", async () => {
    const directory = await scratch();
    const { sha256, compressed } = await writeBundle(directory, batchPlaintext(EXPANSION_BYTES));
    expect(compressed).toBeLessThanOrEqual(traceImportLimits.batchBytes);
    const server = await listen();
    const result = await runNodeUpload(directory, server.url);
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("heap out of memory");
    const report = JSON.parse(result.stdout) as {
      kind: string;
      state: UploadReport["state"];
      error?: UploadReport["error"];
      traces: UploadReport["traces"];
    };
    expect(report.kind).toBe("report");
    expectRejected(report, sha256);
    await expectNotLanded(directory, sha256);
  }, 60_000);
});
