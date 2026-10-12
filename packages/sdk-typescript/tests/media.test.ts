import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEvaluationClient,
  MediaFetchError,
  rehydrateMedia,
  type JsonValue,
  type LocalFile,
} from "../src/evals.js";
import { contentPath, mediaBytes } from "../src/inline-files.js";

const key = "synthetic-media-key";
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const spanId = "00f067aa0ba902b7";
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const wav = new TextEncoder().encode("RIFF....WAVEfmt synthetic");
const pdf = new TextEncoder().encode("%PDF-1.7 synthetic");
const lost = new TextEncoder().encode("never uploaded");

/** What the synthetic Hue answers for one digest. */
type Answer =
  | {
      kind: "stored";
      bytes: Uint8Array;
      contentType: string;
      fileName: string;
      served?: Uint8Array;
    }
  | { kind: "missing" }
  | { kind: "unavailable"; times: number; retryAfter?: string; then?: Answer }
  | { kind: "forbidden" }
  | { kind: "hang" }
  /** Answers the grant's headers, then breaks the connection mid-body, `times` times. */
  | { kind: "broken"; times: number; then?: Answer };

interface Seen {
  method: string;
  path: string;
  spanId: string | null;
  authorization: string | null;
}

const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) void server.stop(true);
});

function hue(answers: Record<string, Answer>, options: { timeoutMillis?: number } = {}) {
  const seen: Seen[] = [];
  const pending = { ...answers };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        path: url.pathname,
        spanId: url.searchParams.get("spanId"),
        authorization: request.headers.get("authorization"),
      });
      const stored = /^\/storage\/([0-9a-f]{64})$/.exec(url.pathname);
      if (stored) {
        const answer = pending[stored[1]!];
        if (answer?.kind !== "stored") return new Response(null, { status: 404 });
        return new Response((answer.served ?? answer.bytes) as Uint8Array<ArrayBuffer>);
      }
      const route =
        /^\/api\/v1\/(?:traces\/[0-9a-f-]+|trace-snapshots\/([0-9a-f-]+))\/blobs\/([0-9a-f]{64})$/.exec(
          url.pathname,
        );
      if (!route) return Response.json({ error: "Not found" }, { status: 404 });
      const snapshot = route[1] !== undefined;
      const digest = route[2]!;
      let answer = pending[digest];
      if (!answer) return Response.json({ error: "Not found" }, { status: 404 });
      if (answer.kind === "unavailable") {
        if (answer.times > 0) {
          answer.times--;
          return Response.json(
            { error: "Trace evidence is unavailable; retry the request", state: "unavailable" },
            {
              status: 503,
              headers: answer.retryAfter === undefined ? {} : { "retry-after": answer.retryAfter },
            },
          );
        }
        answer = pending[digest] = answer.then ?? { kind: "missing" };
      }
      if (answer.kind === "broken") {
        if (answer.times > 0) {
          answer.times--;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"sha256":"'));
              setTimeout(() => controller.error(new Error("connection lost")), 20);
            },
          });
          return new Response(body, { headers: { "content-type": "application/json" } });
        }
        answer = pending[digest] = answer.then ?? { kind: "missing" };
      }
      if (answer.kind === "hang") return new Promise<Response>(() => {});
      if (answer.kind === "missing")
        return Response.json(
          { error: "The trace lists this file, but it was never uploaded", state: "missing" },
          { status: 404 },
        );
      if (answer.kind === "forbidden")
        return Response.json({ error: "Use a Read or Read and write key" }, { status: 403 });
      if (answer.kind !== "stored") return new Response(null, { status: 500 });
      return Response.json({
        sha256: digest,
        size: answer.bytes.byteLength,
        ...(snapshot ? {} : { contentType: answer.contentType, fileName: answer.fileName }),
        url: `${url.origin}/storage/${digest}`,
        method: "GET",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    },
  });
  servers.push(server);
  const client = createEvaluationClient({
    apiKey: key,
    baseUrl: `http://127.0.0.1:${server.port}`,
    ...(options.timeoutMillis ? { timeoutMillis: options.timeoutMillis } : {}),
  });
  return { client, seen };
}

const stored = (
  bytes: Uint8Array,
  contentType: string,
  fileName: string,
): Extract<Answer, { kind: "stored" }> => ({
  kind: "stored",
  bytes,
  contentType,
  fileName,
});

async function failure(promise: Promise<unknown>): Promise<MediaFetchError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MediaFetchError);
    return error as MediaFetchError;
  }
  throw new Error("expected a MediaFetchError");
}

describe("client.media.fetch", () => {
  test("downloads a trace file by digest, names the span and never sends the key to storage", async () => {
    const { client, seen } = hue({ [sha256(png)]: stored(png, "image/png", "chart.png") });
    const file = await client.media.fetch({ traceId, spanId, sha256: sha256(png) });
    expect(file).toEqual({
      bytes: png,
      sha256: sha256(png),
      size: png.byteLength,
      contentType: "image/png",
      fileName: "chart.png",
    });
    expect(seen).toEqual([
      {
        method: "GET",
        path: `/api/v1/traces/${traceId}/blobs/${sha256(png)}`,
        spanId,
        authorization: `Bearer ${key}`,
      },
      { method: "GET", path: `/storage/${sha256(png)}`, spanId: null, authorization: null },
    ]);
  });

  test("refuses bytes whose SHA-256 is not the requested digest", async () => {
    const tampered = png.slice();
    tampered[7] = 9;
    const longer = new Uint8Array([...png, 0]);
    const { client } = hue({
      [sha256(png)]: { ...stored(png, "image/png", "chart.png"), served: tampered },
      [sha256(pdf)]: { ...stored(pdf, "application/pdf", "r.pdf"), served: longer },
    });
    const changed = await failure(client.media.fetch({ traceId, sha256: sha256(png) }));
    expect(changed.reason).toBe("digest_mismatch");
    const grown = await failure(client.media.fetch({ traceId, sha256: sha256(pdf) }));
    expect(grown.reason).toBe("digest_mismatch");
  });

  test("tells a listed file never uploaded (missing) from one Hue does not hold (not_found)", async () => {
    const { client, seen } = hue({ [sha256(lost)]: { kind: "missing" } });
    const missing = await failure(client.media.fetch({ traceId, sha256: sha256(lost) }));
    expect([missing.reason, missing.status]).toEqual(["missing", 404]);
    const unknown = await failure(client.media.fetch({ traceId, sha256: sha256(pdf) }));
    expect([unknown.reason, unknown.status]).toEqual(["not_found", 404]);
    // A miss is final: no retry and no storage request.
    expect(seen).toHaveLength(2);
  });

  test("asks once more after an unavailable answer, waiting its Retry-After", async () => {
    const { client, seen } = hue({
      [sha256(png)]: {
        kind: "unavailable",
        times: 1,
        retryAfter: "1",
        then: stored(png, "image/png", "chart.png"),
      },
      [sha256(pdf)]: { kind: "unavailable", times: 5, retryAfter: "0" },
      [sha256(wav)]: { kind: "unavailable", times: 5, retryAfter: "60" },
    });
    const started = performance.now();
    const file = await client.media.fetch({ traceId, sha256: sha256(png) });
    expect(performance.now() - started).toBeGreaterThanOrEqual(950);
    expect(file.bytes).toEqual(png);
    expect(seen.filter((item) => item.path.includes(sha256(png))).length).toBe(3);

    const still = await failure(client.media.fetch({ traceId, sha256: sha256(pdf) }));
    expect([still.reason, still.status, still.retryAfterSeconds]).toEqual(["unavailable", 503, 0]);
    expect(seen.filter((item) => item.path.includes(sha256(pdf))).length).toBe(2);

    // A longer wait than the client holds is the caller's to schedule.
    const later = await failure(client.media.fetch({ traceId, sha256: sha256(wav) }));
    expect([later.reason, later.retryAfterSeconds]).toEqual(["unavailable", 60]);
    expect(seen.filter((item) => item.path.includes(sha256(wav))).length).toBe(1);
  });

  test("a connection lost while the grant is read is asked once more, then fails", async () => {
    const { client, seen } = hue({
      [sha256(png)]: { kind: "broken", times: 1, then: stored(png, "image/png", "chart.png") },
      [sha256(pdf)]: { kind: "broken", times: 5 },
    });
    const file = await client.media.fetch({ traceId, sha256: sha256(png) });
    expect(file.bytes).toEqual(png);
    expect(seen.filter((item) => item.path.startsWith("/api/v1/")).length).toBe(2);
    const lost = await failure(client.media.fetch({ traceId, sha256: sha256(pdf) }));
    expect(lost.reason).toBe("failed");
    expect(seen.filter((item) => item.path.includes(sha256(pdf))).length).toBe(2);
  });

  test("a key without content access is forbidden and is not asked again", async () => {
    const { client, seen } = hue({ [sha256(png)]: { kind: "forbidden" } });
    const refused = await failure(client.media.fetch({ traceId, sha256: sha256(png) }));
    expect([refused.reason, refused.status]).toEqual(["forbidden", 403]);
    expect(seen).toHaveLength(1);
  });

  test("a request that never answers times out, once more, then fails", async () => {
    const { client, seen } = hue({ [sha256(png)]: { kind: "hang" } }, { timeoutMillis: 100 });
    const timedOut = await failure(client.media.fetch({ traceId, sha256: sha256(png) }));
    expect([timedOut.reason, timedOut.status]).toEqual(["failed", undefined]);
    expect(seen).toHaveLength(2);
  });

  test("a file over maxBytes is refused before any byte is downloaded", async () => {
    const { client, seen } = hue({ [sha256(png)]: stored(png, "image/png", "chart.png") });
    const large = await failure(
      client.media.fetch({ traceId, sha256: sha256(png) }, { maxBytes: png.byteLength - 1 }),
    );
    expect(large.reason).toBe("too_large");
    expect(seen.map((item) => item.path)).toEqual([
      `/api/v1/traces/${traceId}/blobs/${sha256(png)}`,
    ]);
  });

  test("reads a snapshot's pinned copy, which carries no type or name", async () => {
    const snapshotId = randomUUID();
    const { client, seen } = hue({ [sha256(pdf)]: stored(pdf, "application/pdf", "r.pdf") });
    const file = await client.media.fetch({ snapshotId, sha256: sha256(pdf) });
    expect(file).toEqual({ bytes: pdf, sha256: sha256(pdf), size: pdf.byteLength });
    expect(seen[0]!.path).toBe(`/api/v1/trace-snapshots/${snapshotId}/blobs/${sha256(pdf)}`);
  });

  test("invalid identifiers are refused before any request", async () => {
    const { client, seen } = hue({});
    for (const target of [
      { traceId, sha256: "abc" },
      { traceId: "0".repeat(32), sha256: sha256(png) },
      { traceId, spanId: "xyz", sha256: sha256(png) },
      { snapshotId: "not-a-uuid", sha256: sha256(png) },
    ])
      await expect(client.media.fetch(target as never)).rejects.toBeInstanceOf(TypeError);
    expect(seen).toHaveLength(0);
  });
});

/** Recorded messages in digest form, as the SDK exports a span's large media. */
function recorded(): JsonValue {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: "Compare the chart, the recording and the report." },
        {
          type: "image_url",
          image_url: { detail: "low" },
          sha256: sha256(png),
          size: png.byteLength,
        },
        {
          type: "input_audio",
          input_audio: { format: "wav" },
          sha256: sha256(wav),
          size: wav.byteLength,
        },
        { type: "file", file: { filename: "r.pdf" }, sha256: sha256(pdf), size: pdf.byteLength },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png" },
          sha256: sha256(png),
          size: png.byteLength,
        },
      ],
    },
    {
      role: "assistant",
      parts: [
        {
          type: "blob",
          modality: "image",
          mime_type: "image/png",
          sha256: sha256(lost),
          size: lost.byteLength,
        },
      ],
    },
    {
      role: "assistant",
      content: null,
      audio: { id: "audio_1", transcript: "Here is the summary." },
      sha256: sha256(wav),
      size: wav.byteLength,
    },
  ];
}

describe("client.media.resolve", () => {
  test("writes each part's bytes back in its own field and reports the part it cannot read", async () => {
    const { client, seen } = hue({
      [sha256(png)]: stored(png, "image/png", "chart.png"),
      [sha256(wav)]: stored(wav, "audio/wav", "reply.wav"),
      [sha256(pdf)]: stored(pdf, "application/pdf", "r.pdf"),
      [sha256(lost)]: { kind: "missing" },
    });
    const input = recorded();
    const before = structuredClone(input);
    const { value, resolved, failures } = await client.media.resolve(input, { traceId, spanId });
    expect(input).toEqual(before);
    expect(resolved).toBe(5);
    expect(failures).toEqual([{ pointer: "/2/parts/0", sha256: sha256(lost), reason: "missing" }]);
    expect(value).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Compare the chart, the recording and the report." },
          {
            type: "image_url",
            image_url: { detail: "low", url: `data:image/png;base64,${base64(png)}` },
          },
          { type: "input_audio", input_audio: { format: "wav", data: base64(wav) } },
          {
            type: "file",
            file: { filename: "r.pdf", file_data: `data:application/pdf;base64,${base64(pdf)}` },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: base64(png) },
          },
        ],
      },
      (before as JsonValue[])[2]!,
      {
        role: "assistant",
        content: null,
        audio: { id: "audio_1", transcript: "Here is the summary.", data: base64(wav) },
      },
    ]);
    // Each distinct digest is read once, with the span named.
    const reads = seen.filter((item) => item.path.startsWith("/api/v1/"));
    expect(reads.map((item) => item.path.split("/").pop()).sort()).toEqual(
      [sha256(png), sha256(wav), sha256(pdf), sha256(lost)].sort(),
    );
    expect(reads.every((item) => item.spanId === spanId)).toBe(true);
  });

  test("as bytes writes the bytes themselves", async () => {
    const { client } = hue({ [sha256(png)]: stored(png, "image/png", "chart.png") });
    const parts = [
      { type: "image", sha256: sha256(png), size: png.byteLength, mediaType: "image/png" },
    ];
    const { value } = await client.media.resolve(parts, { traceId, as: "bytes" });
    expect(value as unknown).toEqual([{ type: "image", mediaType: "image/png", image: png }]);
  });
});

describe("rehydrateMedia", () => {
  test("writes a case's local files back into its inputs by digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hue-media-"));
    const path = join(directory, "1-chart.png");
    await writeFile(path, png);
    const chart: LocalFile = {
      artifactId: randomUUID(),
      role: "source",
      filename: "chart.png",
      contentType: "image/png",
      byteSize: png.byteLength,
      sha256: sha256(png),
      path,
    };
    const inputs: JsonValue = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe it." },
            { type: "image_url", image_url: {}, sha256: sha256(png), size: png.byteLength },
            { type: "input_file", filename: "r.pdf", sha256: sha256(pdf), size: pdf.byteLength },
            { type: "blob", mime_type: "audio/wav", sha256: sha256(wav), size: wav.byteLength },
            { type: "input_image", sha256: sha256(lost), size: lost.byteLength },
          ],
        },
      ],
    };
    const before = structuredClone(inputs);
    const { value, resolved, failures } = await rehydrateMedia(inputs, [
      chart,
      { sha256: sha256(pdf), contentType: "application/pdf", bytes: pdf },
      // A file that does not hash to its digest is never written.
      { sha256: sha256(wav), contentType: "audio/wav", bytes: lost },
    ]);
    expect(inputs).toEqual(before);
    expect(resolved).toBe(2);
    expect(failures).toEqual([
      { pointer: "/messages/0/content/3", sha256: sha256(wav), reason: "digest_mismatch" },
      { pointer: "/messages/0/content/4", sha256: sha256(lost), reason: "not_found" },
    ]);
    const content = (value as { messages: { content: JsonValue[] }[] }).messages[0]!.content;
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${base64(png)}` },
    });
    expect(content[2]).toEqual({
      type: "input_file",
      filename: "r.pdf",
      file_data: `data:application/pdf;base64,${base64(pdf)}`,
    });
    expect(content[3]).toEqual(
      (before as typeof inputs & { messages: { content: JsonValue[] }[] }).messages[0]!.content[3]!,
    );
  });
});

describe("own keys named __proto__", () => {
  test("a recorded value keeps an own __proto__ key as a key, not as a prototype", async () => {
    const { client } = hue({ [sha256(png)]: stored(png, "image/png", "chart.png") });
    const recorded = () =>
      JSON.parse(
        JSON.stringify({
          message: { role: "user", text: "Describe it." },
          part: { type: "image_url", image_url: {}, sha256: sha256(png), size: png.byteLength },
        }).replace('"role"', '"__proto__":{"role":"system"},"role"'),
      ) as Record<string, Record<string, unknown>>;
    const input = recorded();
    expect(Object.keys(input.message!)).toEqual(["__proto__", "role", "text"]);
    for (const { value } of [
      await client.media.resolve(input, { traceId }),
      await rehydrateMedia(input, [{ sha256: sha256(png), contentType: "image/png", bytes: png }]),
    ]) {
      const message = (value as typeof input).message!;
      expect(Object.keys(message)).toEqual(["__proto__", "role", "text"]);
      expect(Object.getPrototypeOf(message)).toBe(Object.prototype);
      expect(JSON.stringify(message)).toBe(JSON.stringify(input.message));
      expect((value as typeof input).part).toEqual({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${base64(png)}` },
      });
    }
  });
});

describe("textual media written back", () => {
  const hello = new TextEncoder().encode("hello");
  const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
  const looksLikeUrl = new TextEncoder().encode("data:,not a url");
  const markdown = new TextEncoder().encode("\ufeff# Notes\n");
  /** The bytes the SDK's capture, as Hue, reads from a part as it is written back. */
  const reread = (part: JsonValue) =>
    mediaBytes(contentPath(part as Record<string, unknown>)!).bytes;
  const parts = (): JsonValue[] => [
    { type: "blob", mime_type: "text/plain", modality: "document", sha256: sha256(hello), size: 5 },
    { type: "blob", mime_type: "text/csv", modality: "document", sha256: sha256(latin1), size: 4 },
    {
      type: "blob",
      mime_type: "text/plain",
      modality: "document",
      sha256: sha256(looksLikeUrl),
      size: looksLikeUrl.byteLength,
    },
    {
      type: "media",
      mime_type: "text/markdown",
      sha256: sha256(markdown),
      size: markdown.byteLength,
    },
    { type: "blob", mime_type: "application/pdf", sha256: sha256(pdf), size: pdf.byteLength },
  ];
  const files = [
    { sha256: sha256(hello), contentType: "text/plain", bytes: hello },
    { sha256: sha256(latin1), contentType: "text/csv", bytes: latin1 },
    { sha256: sha256(looksLikeUrl), contentType: "text/plain", bytes: looksLikeUrl },
    { sha256: sha256(markdown), contentType: "text/markdown", bytes: markdown },
    { sha256: sha256(pdf), contentType: "application/pdf", bytes: pdf },
  ];
  const expectWrittenBack = (value: JsonValue) => {
    const written = value as Record<string, unknown>[];
    // Text is written as its UTF-8, a byte order mark included; bytes that are no UTF-8, or text
    // that would read as a data: URL, as a typed data: URL; binary media as base64.
    expect(written.map((part) => part.content ?? part.data)).toEqual([
      "hello",
      `data:text/csv;base64,${base64(latin1)}`,
      `data:text/plain;base64,${base64(looksLikeUrl)}`,
      "\ufeff# Notes\n",
      base64(pdf),
    ]);
    // Recorded again, every part reads as the same bytes.
    for (const [index, part] of written.entries())
      expect(sha256(reread(part as JsonValue))).toBe(files[index]!.sha256);
  };

  test("rehydrateMedia writes textual blobs as the text Hue reads them as", async () => {
    const { value, resolved } = await rehydrateMedia(parts(), files);
    expect(resolved).toBe(5);
    expectWrittenBack(value);
  });

  test("client.media.resolve writes textual blobs as the text Hue reads them as", async () => {
    const { client } = hue(
      Object.fromEntries(
        files.map((file) => [file.sha256, stored(file.bytes, file.contentType, "file")]),
      ),
    );
    const { value, resolved } = await client.media.resolve(parts(), { traceId });
    expect(resolved).toBe(5);
    expectWrittenBack(value);
  });
});
