import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvaluationClient, type CaseFileWrite } from "../src/evals.js";

const key = "synthetic-case-files-key";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 5, 6, 7]);
const csv = new TextEncoder().encode("question,answer\nsynthetic,yes\n");

interface Artifact {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  state: "reserved" | "ready";
  copyState: "none" | "started" | "acknowledged";
  bytes?: Uint8Array;
}

const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) void server.stop(true);
});

function receiver() {
  const versionId = randomUUID();
  const artifacts = new Map<string, Artifact>();
  const reservations = new Map<string, string>();
  const calls = {
    requests: [] as string[],
    reserves: [] as Record<string, unknown>[],
    puts: 0,
    cases: [] as Record<string, unknown>[],
  };
  const view = (stored: Artifact) => ({
    id: stored.id,
    filename: stored.filename,
    declaredContentType: stored.contentType,
    declaredBytes: stored.byteSize,
    declaredSha256: stored.sha256,
    state: stored.state,
    copyState: stored.copyState,
    verifiedBytes: stored.state === "ready" ? stored.byteSize : null,
    verifiedSha256: stored.state === "ready" ? stored.sha256 : null,
    failureCode: null,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      calls.requests.push(`${request.method} ${url.pathname}`);
      if (url.pathname.startsWith("/blob/")) {
        expect(request.headers.get("authorization")).toBeNull();
        const stored = artifacts.get(url.pathname.slice("/blob/".length))!;
        stored.bytes = new Uint8Array(await request.arrayBuffer());
        calls.puts++;
        return new Response(null, { status: 200 });
      }
      expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
      const path = url.pathname.replace("/api/v1", "");
      const body = (request.method === "GET" ? {} : await request.json()) as Record<
        string,
        unknown
      >;
      if (path === "/artifacts") {
        calls.reserves.push(body);
        let id = reservations.get(String(body.idempotencyKey));
        // As Hue does, a key already naming an artifact with other declarations is refused.
        const named = id ? artifacts.get(id)! : undefined;
        if (
          named &&
          (named.filename !== body.filename ||
            named.contentType !== body.contentType ||
            named.sha256 !== body.sha256)
        )
          return Response.json(
            { error: "Idempotency key already identifies a different artifact" },
            { status: 409 },
          );
        if (!id) {
          id = randomUUID();
          reservations.set(String(body.idempotencyKey), id);
          artifacts.set(id, {
            id,
            filename: String(body.filename),
            contentType: String(body.contentType),
            byteSize: Number(body.byteSize),
            sha256: String(body.sha256),
            state: "reserved",
            copyState: "none",
          });
        }
        return Response.json(view(artifacts.get(id)!), { status: 201 });
      }
      const action = /^\/artifacts\/([^/]+)\/(upload|complete)$/.exec(path);
      if (action) {
        const stored = artifacts.get(action[1]!)!;
        if (action[2] === "upload") {
          stored.copyState = "started";
          return Response.json({
            uploadUrl: `${url.origin}/blob/${stored.id}`,
            method: "PUT",
            headers: { "content-type": stored.contentType },
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        }
        if (!stored.bytes || sha256(stored.bytes) !== stored.sha256)
          return Response.json({ error: "mismatch" }, { status: 409 });
        stored.state = "ready";
        stored.copyState = "acknowledged";
        return Response.json(view(stored));
      }
      if (path === `/dataset-versions/${versionId}/cases`) {
        calls.cases.push(body);
        return Response.json({
          item: { id: randomUUID(), datasetVersionId: versionId, ...body },
          version: { id: versionId, revision: Number(body.expectedRevision) + 1 },
        });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });
  servers.push(server);
  const client = createEvaluationClient({
    apiKey: key,
    baseUrl: `http://127.0.0.1:${server.port}`,
  });
  return { client, versionId, artifacts, calls };
}

test("addCase uploads files given as bytes or a path and pins every file by artifact and role", async () => {
  const { client, versionId, artifacts, calls } = receiver();
  const directory = await mkdtemp(join(tmpdir(), "hue-case-files-"));
  const path = join(directory, "answers.csv");
  await writeFile(path, csv);
  const existing = randomUUID();
  const files: CaseFileWrite[] = [
    { role: "source", filename: "chart.png", contentType: "image/png", bytes: png },
    { artifactId: existing, role: "attached_reference" },
    { role: "evaluator_reference", filename: "answers.csv", contentType: "text/csv", path },
  ];
  const write = {
    expectedRevision: 1,
    externalKey: "chart-question",
    inputs: { question: "What does the chart show?" },
    files,
  };
  await client.addCase(versionId, write);
  expect(calls.reserves.map(({ idempotencyKey: _key, ...declared }) => declared)).toEqual([
    {
      filename: "chart.png",
      contentType: "image/png",
      byteSize: png.byteLength,
      sha256: sha256(png),
    },
    {
      filename: "answers.csv",
      contentType: "text/csv",
      byteSize: csv.byteLength,
      sha256: sha256(csv),
    },
  ]);
  const uploaded = [...artifacts.values()];
  expect(uploaded.map((item) => item.bytes)).toEqual([png, csv]);
  expect(uploaded.every((item) => item.state === "ready")).toBe(true);
  expect(calls.cases[0]).toEqual({
    expectedRevision: 1,
    externalKey: "chart-question",
    inputs: { question: "What does the chart show?" },
    files: [
      { artifactId: uploaded[0]!.id, role: "source" },
      { artifactId: existing, role: "attached_reference" },
      { artifactId: uploaded[1]!.id, role: "evaluator_reference" },
    ],
  });

  // The same write sent again settles on the same verified artifacts without uploading again.
  await client.addCase(versionId, write);
  expect(calls.puts).toBe(2);
  expect(artifacts.size).toBe(2);
  expect(calls.cases[1]).toEqual(calls.cases[0]!);
});

test("addCase with a corrected content type reserves a new artifact for it", async () => {
  const { client, versionId, artifacts, calls } = receiver();
  const write = (contentType: "text/plain" | "text/csv") =>
    client.addCase(versionId, {
      expectedRevision: 1,
      externalKey: "answers",
      inputs: {},
      files: [{ role: "evaluator_reference", filename: "answers.csv", contentType, bytes: csv }],
    });
  await write("text/plain");
  await write("text/csv");
  const keys = calls.reserves.map((reserve) => String(reserve.idempotencyKey));
  expect(new Set(keys).size).toBe(2);
  expect(keys.every((item) => item.length <= 200)).toBe(true);
  expect([...artifacts.values()].map((item) => [item.contentType, item.state])).toEqual([
    ["text/plain", "ready"],
    ["text/csv", "ready"],
  ]);
  const pinned = (calls.cases[1]!.files as { artifactId: string }[])[0]!.artifactId;
  expect(artifacts.get(pinned)!.contentType).toBe("text/csv");
});

test("addCase refuses files outside the artifact policy before any request", async () => {
  const { client, versionId, calls } = receiver();
  const write = (files: unknown) =>
    client.addCase(versionId, {
      expectedRevision: 1,
      externalKey: "refused",
      inputs: {},
      files: files as CaseFileWrite[],
    });
  const png = (extra: Record<string, unknown> = {}) => ({
    role: "source",
    filename: "chart.png",
    contentType: "image/png",
    bytes: new Uint8Array([1]),
    ...extra,
  });
  for (const files of [
    [png({ contentType: "image/svg+xml" })],
    [png({ contentType: "audio/pcm" })],
    [png({ filename: "../chart.png" })],
    [png({ filename: "chart\n.png" })],
    [png({ role: "output" })],
    [png({ bytes: "AQID" })],
    [png({ artifactId: randomUUID() })],
    [png(), png()],
  ])
    await expect(write(files)).rejects.toBeInstanceOf(TypeError);
  for (const files of [
    Array.from({ length: 33 }, (_, index) => png({ filename: `${index}.png` })),
    [png({ bytes: new Uint8Array() })],
    [png({ bytes: new Uint8Array(25 * 1024 * 1024 + 1) })],
  ])
    await expect(write(files)).rejects.toBeInstanceOf(RangeError);
  expect(calls.requests).toEqual([]);
});

test("addCase counts a file name in UTF-16 code units, as Hue does, before any upload", async () => {
  const { client, versionId, calls } = receiver();
  const write = (filename: string) =>
    client.addCase(versionId, {
      expectedRevision: 1,
      externalKey: "names",
      inputs: {},
      files: [
        { role: "source", filename: "chart.png", contentType: "image/png", bytes: png },
        { role: "evaluator_reference", filename, contentType: "text/csv", bytes: csv },
      ],
    });
  // 128 emoji are 128 code points but 256 UTF-16 code units, one past Hue's limit; Hue refuses
  // a name with an unpaired surrogate too.
  for (const filename of ["😀".repeat(128), "answers\ud800.csv", "\udc00"])
    await expect(write(filename)).rejects.toBeInstanceOf(TypeError);
  expect(calls.requests).toEqual([]);
  // 127 emoji and one letter are 255 code units.
  const longest = `${"😀".repeat(127)}x`;
  await write(longest);
  expect(calls.reserves.map((reserve) => reserve.filename)).toEqual(["chart.png", longest]);
});

test("addCase checks the case itself before uploading any file", async () => {
  const { client, versionId, calls } = receiver();
  const write = (fields: Record<string, unknown>) =>
    client.addCase(versionId, {
      expectedRevision: 1,
      externalKey: "checked",
      inputs: {},
      files: [{ role: "source", filename: "chart.png", contentType: "image/png", bytes: png }],
      ...fields,
    } as never);
  const values = (count: number) => Array.from({ length: count }, () => 1);
  for (const [fields, kind] of [
    [{ inputs: { x: Number.NaN } }, TypeError],
    [{ inputs: undefined }, TypeError],
    [{ expected: { bad: undefined } }, TypeError],
    [{ inputs: "x".repeat(200_000) }, RangeError],
    [{ metadata: ["not", "an", "object"] }, TypeError],
    [{ externalKey: "" }, TypeError],
    [{ externalKey: "k".repeat(201) }, TypeError],
    [{ externalKey: "key\ud800" }, TypeError],
    [{ expectedRevision: 0 }, TypeError],
    [{ environmentVersionId: "not-a-uuid" }, TypeError],
    // Each value fits on its own, but the case as sent has more than 20,000 JSON values.
    [{ inputs: values(10_500), expected: values(10_500) }, RangeError],
  ] as const)
    await expect(write(fields)).rejects.toBeInstanceOf(kind);
  expect(calls.requests).toEqual([]);
});
