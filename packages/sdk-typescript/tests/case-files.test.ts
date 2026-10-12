import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  open,
  rm,
  truncate,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
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
/** Directories a test wrote files to, removed once it ends, whether or not it passed. */
const directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) void server.stop(true);
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A new directory for a test's files, removed after the test. */
async function testDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hue-case-files-"));
  directories.push(directory);
  return directory;
}

/** A synthetic Hue; `onReserve` runs when a file's artifact is reserved, before its upload. */
function receiver(onReserve?: (declared: Record<string, unknown>) => Promise<void> | void) {
  const versionId = randomUUID();
  const artifacts = new Map<string, Artifact>();
  const reservations = new Map<string, string>();
  const calls = {
    requests: [] as string[],
    reserves: [] as Record<string, unknown>[],
    puts: 0,
    /** Uploads whose client stopped before sending every declared byte. */
    abandoned: 0,
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
        // As storage does, a body sent without its length is refused.
        if (
          request.headers.get("transfer-encoding") !== null ||
          request.headers.get("content-length") === null
        )
          return new Response(null, { status: 411 });
        const stored = artifacts.get(url.pathname.slice("/blob/".length))!;
        let bytes: ArrayBuffer;
        try {
          bytes = await request.arrayBuffer();
        } catch {
          calls.abandoned++;
          return new Response(null, { status: 400 });
        }
        stored.bytes = new Uint8Array(bytes);
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
        await onReserve?.(body);
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
      // As Hue does, a version ID is read in either case.
      if (path.toLowerCase() === `/dataset-versions/${versionId}/cases`) {
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
  const directory = await testDirectory();
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
    // A reference takes only its artifact and role; a name or type beside it is refused.
    [{ artifactId: randomUUID(), role: "source", filename: "renamed.png" }],
    [{ artifactId: randomUUID(), role: "source", contentType: "image/png" }],
    [png(), png()],
    // A path with no file behind it is refused as any other file that cannot be read.
    [png({ bytes: undefined, path: join(tmpdir(), `hue-missing-${randomUUID()}.png`) })],
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

test("addCase pins an artifact once when a reference names the artifact a file uploads as", async () => {
  const { client, versionId, calls } = receiver();
  const upload = {
    role: "source" as const,
    filename: "chart.png",
    contentType: "image/png",
    bytes: png,
  };
  const write = (files: CaseFileWrite[]) =>
    client.addCase(versionId, { expectedRevision: 1, externalKey: "chart", inputs: {}, files });
  await write([upload]);
  const [{ artifactId }] = calls.cases[0]!.files as { artifactId: string }[];
  // The same artifact pinned with another role is a second pin, as Hue takes it.
  await write([
    { artifactId: artifactId!.toUpperCase(), role: "source" },
    upload,
    { artifactId: artifactId!, role: "evaluator_reference" },
  ]);
  expect(calls.cases[1]!.files).toEqual([
    { artifactId, role: "source" },
    { artifactId, role: "evaluator_reference" },
  ]);
});

test("addCase reuses a file's artifact whatever the case of the version ID", async () => {
  const { client, versionId, artifacts, calls } = receiver();
  for (const id of [versionId, versionId.toUpperCase()])
    await client.addCase(id, {
      expectedRevision: 1,
      externalKey: "chart",
      inputs: {},
      files: [{ role: "source", filename: "chart.png", contentType: "image/png", bytes: png }],
    });
  expect(new Set(calls.reserves.map((reserve) => reserve.idempotencyKey)).size).toBe(1);
  expect(artifacts.size).toBe(1);
  expect(calls.cases[1]).toEqual(calls.cases[0]!);
});

test("addCase hashes a file given by path in slices and holds at most one file at a time", async () => {
  const { client, versionId, artifacts, calls } = receiver();
  const directory = await testDirectory();
  // Each file spans several slices and ends partway through one.
  const contents = [0, 1, 2].map((index) => randomBytes(3 * 1024 * 1024 + 7 + index));
  const paths = contents.map((_, index) => join(directory, `${index}.pdf`));
  for (const [index, path] of paths.entries()) await writeFile(path, contents[index]!);
  const probe = await open(paths[0]!, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  // Each read: how much it asked for, and how many files had been uploaded when it was made.
  const reads: { length: number; uploaded: number }[] = [];
  const read = prototype.read;
  const spy = spyOn(prototype, "read").mockImplementation(function (
    this: FileHandle,
    ...args: unknown[]
  ) {
    reads.push({ length: Number(args[2]), uploaded: calls.puts });
    return (read as (...args: unknown[]) => unknown).apply(this, args) as never;
  });
  try {
    await client.addCase(versionId, {
      expectedRevision: 1,
      externalKey: "large-files",
      inputs: {},
      files: paths.map((path, index) => ({
        role: "source" as const,
        filename: `${index}.pdf`,
        contentType: "application/pdf",
        path,
      })),
    });
  } finally {
    spy.mockRestore();
  }
  // The check hashes every file at most 1 MiB at a time before anything is uploaded; each file
  // is then read whole only once the one before it was sent, so no two are held at once.
  const checked = reads.filter(({ length }) => length <= 1024 * 1024 && length > 1);
  expect(checked.length).toBeGreaterThan(0);
  expect(checked.every(({ uploaded }) => uploaded === 0)).toBe(true);
  const whole = reads.filter(({ length }) => length > 1024 * 1024);
  expect(whole).toEqual(
    contents.map((bytes, index) => ({ length: bytes.byteLength, uploaded: index })),
  );
  expect(calls.puts).toBe(3);
  expect([...artifacts.values()].map((item) => sha256(item.bytes!))).toEqual(contents.map(sha256));
});

test("addCase refuses a file given by path that changed after it was checked, without staging it", async () => {
  const directory = await testDirectory();
  const path = join(directory, "report.pdf");
  // Several slices long: the check hashes it in pieces, the upload reads it again whole.
  const original = randomBytes(2.5 * 1024 * 1024);
  const rewritten = Buffer.from(original);
  rewritten[rewritten.byteLength - 1]! ^= 1;
  const changes: [() => Promise<void>, string][] = [
    [() => writeFile(path, rewritten), "Case file 2 changed after it was checked"],
    [() => appendFile(path, "x"), "Case file 2 changed after it was checked"],
    [() => truncate(path, original.byteLength - 1), "Case file 2 changed after it was checked"],
    [() => rm(path), "Case file 2 could not be read"],
  ];
  for (const [change, message] of changes) {
    await writeFile(path, original);
    // The file changes once its reservation, made from the checked size and SHA-256, arrives.
    const { client, versionId, artifacts, calls } = receiver(async (declared) => {
      if (declared.filename === "report.pdf") await change();
    });
    const error = await client
      .addCase(versionId, {
        expectedRevision: 1,
        externalKey: "changed",
        inputs: {},
        files: [
          { role: "source", filename: "chart.png", contentType: "image/png", bytes: png },
          { role: "source", filename: "report.pdf", contentType: "application/pdf", path },
        ],
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe(message);
    // None of the report's bytes are sent: no upload is asked for, nothing is staged or
    // completed, and no case is written.
    const report = [...artifacts.values()].find((item) => item.filename === "report.pdf")!;
    expect(report.state).toBe("reserved");
    expect(report.bytes).toBeUndefined();
    expect(calls.abandoned).toBe(0);
    expect(calls.requests.filter((request) => request.includes(report.id))).toEqual([]);
    expect(calls.cases).toEqual([]);
  }
});
