import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvaluationClient } from "../src/evals/client.js";
import { uploadOutputFiles, type StagedOutputFile } from "../src/evals/files.js";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Artifact routes whose verification outlasts the client's request timeout, as Hue's can: a
 * completion marks the artifact verifying at once and ready `verifyMillis` later, whether or not
 * the client is still waiting, and Hue's rules for a verification in progress apply.
 */
function slowArtifacts(verifyMillis: number) {
  const calls = { reserves: 0, uploads: 0, completes: 0, reads: 0 };
  const reservations = new Map<string, string>();
  const artifacts = new Map<
    string,
    {
      id: string;
      body: Record<string, unknown>;
      state: "reserved" | "verifying" | "ready";
      bytes?: Uint8Array;
      capability: boolean;
    }
  >();
  const view = (stored: NonNullable<ReturnType<typeof artifacts.get>>) => ({
    id: stored.id,
    filename: stored.body.filename,
    declaredContentType: stored.body.contentType,
    declaredBytes: stored.body.byteSize,
    declaredSha256: stored.body.sha256,
    state: stored.state,
    copyState: stored.state === "ready" ? "acknowledged" : "none",
    verifiedBytes: stored.state === "ready" ? stored.body.byteSize : null,
    verifiedSha256: stored.state === "ready" ? stored.body.sha256 : null,
    failureCode: null,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/blob/")) {
        artifacts.get(url.pathname.slice("/blob/".length))!.bytes = new Uint8Array(
          await request.arrayBuffer(),
        );
        return new Response(null, { status: 200 });
      }
      const path = url.pathname.replace("/api/v1", "");
      if (path === "/artifacts" && request.method === "POST") {
        calls.reserves++;
        const body = (await request.json()) as Record<string, unknown>;
        let id = reservations.get(String(body.idempotencyKey));
        if (!id) {
          id = randomUUID();
          reservations.set(String(body.idempotencyKey), id);
          artifacts.set(id, { id, body, state: "reserved", capability: false });
        }
        return Response.json(view(artifacts.get(id)!), { status: 201 });
      }
      const match = /^\/artifacts\/([^/]+)(?:\/(upload|complete))?$/.exec(path);
      const stored = match && artifacts.get(match[1]!);
      if (!stored) return new Response(null, { status: 404 });
      if (match[2] === "upload") {
        calls.uploads++;
        // Hue issues an upload capability only to a reserved or rejected artifact.
        if (stored.state !== "reserved") return new Response(null, { status: 409 });
        stored.capability = true;
        return Response.json({
          uploadUrl: `${url.origin}/blob/${stored.id}`,
          method: "PUT",
          headers: { "content-type": String(stored.body.contentType) },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      if (match[2] === "complete") {
        calls.completes++;
        if (stored.state === "ready") return Response.json(view(stored));
        if (stored.state === "verifying") return new Response(null, { status: 409 });
        if (!stored.capability || !stored.bytes) return new Response(null, { status: 409 });
        stored.state = "verifying";
        const verified = new Promise<void>((resolve) =>
          setTimeout(() => {
            stored.state = sha256(stored.bytes!) === stored.body.sha256 ? "ready" : "reserved";
            resolve();
          }, verifyMillis),
        );
        await verified;
        return Response.json(view(stored));
      }
      calls.reads++;
      return Response.json(view(stored));
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    calls,
    artifacts,
    stop: () => server.stop(true),
  };
}

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function stagedFile(): Promise<StagedOutputFile> {
  directory = await mkdtemp(join(tmpdir(), "hue-artifact-settle-"));
  const bytes = new TextEncoder().encode("The update follows the brief.\n");
  const path = join(directory, "update.txt");
  await writeFile(path, bytes, { mode: 0o600 });
  return {
    filename: "update.txt",
    contentType: "text/plain",
    byteSize: bytes.byteLength,
    sha256: sha256(bytes),
    path,
    primary: true,
  };
}

const fast = { settleMillis: 5000, pollMillis: 50, maxPollMillis: 200 };

test("a verification that outlasts the request is waited out, not failed", async () => {
  const hue = slowArtifacts(800);
  try {
    // The completion request times out after 200 ms; Hue finishes verifying at 800 ms.
    const client = new EvaluationClient({
      apiKey: "hue_sk_test",
      baseUrl: hue.baseUrl,
      timeoutMillis: 200,
    });
    const file = await stagedFile();
    let saves = 0;
    await uploadOutputFiles(client, randomUUID(), [file], async () => void saves++, fast);
    expect(file.artifactId).toBe([...hue.artifacts.keys()][0]!);
    expect(hue.artifacts.get(file.artifactId!)!.state).toBe("ready");
    expect(saves).toBe(1);
    expect(hue.calls.uploads).toBe(1);
    expect(hue.calls.reads).toBeGreaterThan(0);
  } finally {
    hue.stop();
  }
});

test("a resume adopts the verification an earlier attempt stopped waiting for", async () => {
  const hue = slowArtifacts(1500);
  try {
    const client = new EvaluationClient({
      apiKey: "hue_sk_test",
      baseUrl: hue.baseUrl,
      timeoutMillis: 200,
    });
    const file = await stagedFile();
    const executionId = randomUUID();
    // The first attempt gives up while Hue is still verifying.
    await expect(
      uploadOutputFiles(client, executionId, [file], async () => {}, {
        ...fast,
        settleMillis: 400,
      }),
    ).rejects.toThrow("still verifying");
    expect(file.artifactId).toBeUndefined();
    // The resume finds the same reservation verifying: it asks for no second upload, which Hue
    // refuses then, and settles on the artifact once Hue has verified it.
    await uploadOutputFiles(client, executionId, [file], async () => {}, fast);
    expect(hue.artifacts.get(file.artifactId!)!.state).toBe("ready");
    expect(hue.calls.reserves).toBe(2);
    expect(hue.calls.uploads).toBe(1);
  } finally {
    hue.stop();
  }
});

test("a verification that never ends fails within its bound", async () => {
  const hue = slowArtifacts(60_000);
  try {
    const client = new EvaluationClient({
      apiKey: "hue_sk_test",
      baseUrl: hue.baseUrl,
      timeoutMillis: 200,
    });
    const file = await stagedFile();
    const started = Date.now();
    await expect(
      uploadOutputFiles(client, randomUUID(), [file], async () => {}, {
        ...fast,
        settleMillis: 600,
      }),
    ).rejects.toThrow("Hue was still verifying generated file");
    expect(Date.now() - started).toBeLessThan(5000);
  } finally {
    hue.stop();
  }
});
