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
  type MediaResolveFailure,
} from "../src/evals.js";
import { mediaDownload } from "../src/evals/media.js";
import { inlineFileBytes } from "../src/inline-files.js";

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
      /** The storage route answers with this redirect status instead of the bytes. */
      storageRedirect?: number;
      /** The host the link names, with the storage route's port; its own origin by default. */
      linkHost?: string;
      /** The storage route sends the bytes in `pieces`, one every `everyMillis`; with `stallAfter`
       * it sends no more after that many. */
      trickle?: { pieces: number; everyMillis: number; stallAfter?: number };
    }
  | { kind: "missing" }
  /** Answers the grant with a redirect to the storage route. */
  | { kind: "redirect"; status: number }
  | { kind: "unavailable"; times: number; retryAfter?: string; then?: Answer }
  | { kind: "forbidden" }
  | { kind: "hang" }
  /** Answers the grant's headers and `sent`, then breaks the connection mid-body, `times` times. */
  | { kind: "broken"; times: number; sent?: string; then?: Answer };

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
        if (answer.storageRedirect)
          return new Response(null, {
            status: answer.storageRedirect,
            headers: { location: `${url.origin}/api/v1/projects/current` },
          });
        const served = answer.served ?? answer.bytes;
        const trickle = answer.trickle;
        if (trickle) {
          const size = Math.ceil(served.byteLength / trickle.pieces);
          let sent = 0;
          return new Response(
            new ReadableStream<Uint8Array>({
              async pull(controller) {
                if (trickle.stallAfter !== undefined && sent >= trickle.stallAfter)
                  return new Promise<void>(() => {});
                await Bun.sleep(trickle.everyMillis);
                controller.enqueue(served.slice(sent * size, (sent + 1) * size));
                if (++sent * size >= served.byteLength) controller.close();
              },
            }),
          );
        }
        return new Response(served as Uint8Array<ArrayBuffer>);
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
          const sent = answer.sent ?? '{"sha256":"';
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(sent));
              setTimeout(() => controller.error(new Error("connection lost")), 20);
            },
          });
          return new Response(body, { headers: { "content-type": "application/json" } });
        }
        answer = pending[digest] = answer.then ?? { kind: "missing" };
      }
      if (answer.kind === "hang") return new Promise<Response>(() => {});
      if (answer.kind === "redirect")
        return new Response(null, {
          status: answer.status,
          headers: { location: `${url.origin}/storage/${digest}` },
        });
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
        url: `${answer.linkHost ? `http://${answer.linkHost}:${url.port}` : url.origin}/storage/${digest}`,
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

  test("an answer past its bound cut mid-body is refused, not asked again", async () => {
    // The connection closes after 66,000 bytes of an answer longer than any grant: it is no grant
    // whether or not the rest arrives, so it fails at once, as the Python SDK fails it.
    const { client, seen } = hue({
      [sha256(png)]: { kind: "broken", times: 5, sent: `{"sha256":"${"a".repeat(65_989)}` },
    });
    const cut = await failure(client.media.fetch({ traceId, sha256: sha256(png) }));
    expect(cut.reason).toBe("failed");
    expect(seen.filter((item) => item.path.includes(sha256(png))).length).toBe(1);
  });

  test("a redirect is an unexpected answer: failed with its status, never followed or asked again", async () => {
    const { client, seen } = hue({
      [sha256(png)]: { kind: "redirect", status: 302 },
      [sha256(pdf)]: { ...stored(pdf, "application/pdf", "r.pdf"), storageRedirect: 307 },
    });
    const grant = await failure(client.media.fetch({ traceId, sha256: sha256(png) }));
    expect([grant.reason, grant.status]).toEqual(["failed", 302]);
    const download = await failure(client.media.fetch({ traceId, sha256: sha256(pdf) }));
    expect([download.reason, download.status]).toEqual(["failed", 307]);
    expect(seen.map((item) => item.path)).toEqual([
      `/api/v1/traces/${traceId}/blobs/${sha256(png)}`,
      `/api/v1/traces/${traceId}/blobs/${sha256(pdf)}`,
      `/storage/${sha256(pdf)}`,
    ]);
  });

  test("a plain HTTP link must write its loopback host as localhost, 127.0.0.1 or [::1]", async () => {
    const hosts = ["127.1", "0x7f.0.0.1", "2130706433", "[0::1]", "127.0.0.1.", "127.0.0.1"];
    const files = hosts.map((host) => new TextEncoder().encode(`file behind ${host}`));
    const { client, seen } = hue(
      Object.fromEntries(
        files.map((bytes, index) => [
          sha256(bytes),
          { ...stored(bytes, "text/plain", "f.txt"), linkHost: hosts[index] },
        ]),
      ),
    );
    // The URL parser would rewrite these hosts to 127.0.0.1 or [::1]; Python's would not.
    for (const bytes of files.slice(0, -1)) {
      const refused = await failure(client.media.fetch({ traceId, sha256: sha256(bytes) }));
      expect([refused.reason, refused.status]).toEqual(["failed", undefined]);
    }
    expect(seen.some((item) => item.path.startsWith("/storage/"))).toBe(false);
    const written = await client.media.fetch({ traceId, sha256: sha256(files.at(-1)!) });
    expect(written.bytes).toEqual(files.at(-1)!);
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

  test("a download ends when no byte arrives in time, not while bytes keep arriving", async () => {
    const minIdle = mediaDownload.minIdleMillis;
    mediaDownload.minIdleMillis = 400;
    try {
      const steady = new Uint8Array(4096).fill(7);
      const { client } = hue(
        {
          // Two seconds in all, a piece every 200 ms: longer than the bound, never idle as long.
          [sha256(steady)]: {
            ...stored(steady, "application/octet-stream", "steady.bin"),
            trickle: { pieces: 10, everyMillis: 200 },
          },
          [sha256(pdf)]: {
            ...stored(pdf, "application/pdf", "r.pdf"),
            trickle: { pieces: 3, everyMillis: 10, stallAfter: 1 },
          },
        },
        { timeoutMillis: 100 },
      );
      const file = await client.media.fetch({ traceId, sha256: sha256(steady) });
      expect(file.bytes).toEqual(steady);
      const started = performance.now();
      const stalled = await failure(client.media.fetch({ traceId, sha256: sha256(pdf) }));
      expect([stalled.reason, stalled.status]).toEqual(["failed", undefined]);
      expect(performance.now() - started).toBeLessThan(3000);
    } finally {
      mediaDownload.minIdleMillis = minIdle;
    }
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

  test("a snapshot's parts that declare no type take it from the record's hue.blobs", async () => {
    const snapshotId = randomUUID();
    const { client } = hue({
      [sha256(png)]: stored(png, "image/png", "chart.png"),
      [sha256(pdf)]: stored(pdf, "application/pdf", "r.pdf"),
      [sha256(wav)]: stored(wav, "audio/wav", "reply.wav"),
    });
    const parts = [
      { type: "image_url", image_url: {}, sha256: sha256(png), size: png.byteLength },
      { type: "input_file", filename: "r.pdf", sha256: sha256(pdf), size: pdf.byteLength },
      // A part's own type comes first.
      { type: "file", mediaType: "audio/x-wav", sha256: sha256(wav), size: wav.byteLength },
    ];
    const entry = (index: number, bytes: Uint8Array, contentType: string) =>
      JSON.stringify({
        key: `gen_ai.input.messages#/0/content/${index}`,
        sha256: sha256(bytes),
        size: bytes.byteLength,
        content_type: contentType,
      });
    const blobs = [
      "not an entry",
      entry(0, png, "image/png"),
      entry(1, pdf, "application/pdf"),
      entry(2, wav, "audio/wav"),
    ];
    const { value } = await client.media.resolve(parts, { snapshotId, blobs });
    expect(value as unknown).toEqual([
      { type: "image_url", image_url: { url: `data:image/png;base64,${base64(png)}` } },
      {
        type: "input_file",
        filename: "r.pdf",
        file_data: `data:application/pdf;base64,${base64(pdf)}`,
      },
      { type: "file", mediaType: "audio/x-wav", data: `data:audio/x-wav;base64,${base64(wav)}` },
    ]);
    // Without the entries, a snapshot's copy names no type.
    const bare = await client.media.resolve(parts.slice(0, 1), { snapshotId });
    expect(
      (bare.value as unknown as { image_url: { url: string } }[])[0]!.image_url.url,
    ).toStartWith("data:application/octet-stream;base64,");
    // Every form Hue reads hue.blobs in gives the same types: one string holding the JSON array,
    // and an array of objects; anything else is no list of entries and is ignored.
    const objects = blobs.slice(1).map((item) => JSON.parse(item) as Record<string, unknown>);
    for (const form of [JSON.stringify(blobs.slice(1)), objects]) {
      const read = await client.media.resolve(parts, { snapshotId, blobs: form });
      expect(read.value).toEqual(value);
    }
    const ignored = await client.media.resolve(parts.slice(0, 1), {
      snapshotId,
      blobs: "entries",
    });
    expect(
      (ignored.value as unknown as { image_url: { url: string } }[])[0]!.image_url.url,
    ).toStartWith("data:application/octet-stream;base64,");
  });

  test("an entry whose size is out of range is ignored, never thrown", async () => {
    const snapshotId = randomUUID();
    const { client } = hue({ [sha256(png)]: stored(png, "image/png", "chart.png") });
    const parts = [{ type: "image_url", image_url: {}, sha256: sha256(png), size: png.byteLength }];
    const entry = (index: number, size: unknown) => ({
      key: `gen_ai.input.messages#/${index}`,
      sha256: sha256(png),
      size,
      content_type: "image/gif",
    });
    // Sizes Hue's reader refuses: each entry is ignored, so the part takes the type of the valid
    // entry after them.
    const blobs = [
      entry(0, Number("1e400")),
      entry(1, 1_000_000_001),
      entry(2, 0),
      entry(3, true),
      entry(4, 1.5),
      entry(5, 10n ** 400n),
      entry(6, "12345678901"),
      JSON.stringify({ ...entry(7, 1), content_type: "image/png" }),
    ];
    const { value } = await client.media.resolve(parts, { snapshotId, blobs });
    expect(value as unknown).toEqual([
      { type: "image_url", image_url: { url: `data:image/png;base64,${base64(png)}` } },
    ]);
  });

  test("text kept as its first 16 KiB is reported as prefix_only and never written, whatever attribute's entry names it", async () => {
    const input = new TextEncoder().encode("A long report. ".repeat(6000));
    const output = new TextEncoder().encode("An output summary. ".repeat(5000));
    const short = new TextEncoder().encode("a short file");
    // Both files are stored: resolve still writes neither, since an entry names a pointer and not
    // the value it was read from.
    const { client, seen } = hue({
      [sha256(input)]: stored(input, "text/plain", "input.txt"),
      [sha256(output)]: stored(output, "text/plain", "output.txt"),
      [sha256(short)]: stored(short, "text/plain", "short.txt"),
    });
    const prefixOf = (bytes: Uint8Array) => Buffer.from(bytes.subarray(0, 16 * 1024)).toString();
    const message = (role: string, content: string) => ({
      role,
      parts: [{ type: "blob", mime_type: "text/plain", content }],
    });
    const inputMessages = [message("user", prefixOf(input)), message("user", "short")];
    const outputMessages = [message("assistant", prefixOf(output))];
    const entry = (key: string, bytes: Uint8Array) =>
      JSON.stringify({
        key,
        sha256: sha256(bytes),
        size: bytes.byteLength,
        content_type: "text/plain",
      });
    const blobs = [
      entry("gen_ai.input.messages#/0/parts/0/content", input),
      // The output's text file at the same pointer as the input's.
      entry("gen_ai.output.messages#/0/parts/0/content", output),
      // A field holding text shorter than a prefix is complete and left alone.
      entry("gen_ai.output.messages#/1/parts/0/content", short),
    ];
    const both: MediaResolveFailure[] = [
      { pointer: "/0/parts/0", sha256: sha256(input), reason: "prefix_only" },
      { pointer: "/0/parts/0", sha256: sha256(output), reason: "prefix_only" },
    ];
    for (const recorded of [inputMessages, outputMessages]) {
      const { value, resolved, failures } = await client.media.resolve(recorded, {
        traceId,
        blobs,
      });
      expect(value).toEqual(recorded);
      expect(resolved).toBe(0);
      expect(failures).toEqual(both);
    }
    // The entries of the value's own attribute name its own file.
    const own = await client.media.resolve(outputMessages, { traceId, blobs: blobs.slice(1) });
    expect(own.failures).toEqual([both[1]!]);
    expect(seen.filter((item) => item.path.includes("/blobs/"))).toEqual([]);
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

describe("Anthropic sources", () => {
  test("a source whose type is absent or null takes base64; a URL source is left as it is", async () => {
    const block = (source: Record<string, unknown>) => ({
      type: "image",
      source: { media_type: "image/png", ...source },
      sha256: sha256(png),
      size: png.byteLength,
    });
    const { value, resolved } = await rehydrateMedia(
      [block({}), block({ type: null }), block({ type: "url" })],
      [{ sha256: sha256(png), bytes: png }],
    );
    expect(resolved).toBe(2);
    expect(value as unknown).toEqual([
      { type: "image", source: { media_type: "image/png", data: base64(png) } },
      { type: "image", source: { media_type: "image/png", type: null, data: base64(png) } },
      block({ type: "url" }),
    ]);
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
  // Four letters of the base64 alphabet: written raw, Hue would read them as base64.
  const test4 = new TextEncoder().encode("test");
  const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
  const markdown = new TextEncoder().encode("\ufeff# Notes\n");
  /** The bytes a written part's content stands for, as Hue's reader decodes it (`inlineOf`): a
   * `data:` URL, base64 when it reads as base64, the text itself otherwise. */
  const reread = (content: string) => inlineFileBytes(content).bytes;
  const parts = (): JsonValue[] => [
    { type: "blob", mime_type: "text/plain", modality: "document", sha256: sha256(hello), size: 5 },
    { type: "blob", mime_type: "text/plain", modality: "document", sha256: sha256(test4), size: 4 },
    { type: "blob", mime_type: "text/csv", modality: "document", sha256: sha256(latin1), size: 4 },
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
    { sha256: sha256(test4), contentType: "text/plain", bytes: test4 },
    { sha256: sha256(latin1), contentType: "text/csv", bytes: latin1 },
    { sha256: sha256(markdown), contentType: "text/markdown", bytes: markdown },
    { sha256: sha256(pdf), contentType: "application/pdf", bytes: pdf },
  ];
  const expectWrittenBack = (value: JsonValue) => {
    const written = (value as Record<string, string>[]).map((part) => part.content ?? part.data!);
    // GenAI blob and Vertex media content is base64 for every media type.
    expect(written).toEqual(files.map((file) => base64(file.bytes)));
    // Read as Hue reads it, every part stands for the file's own bytes; "test" written raw would
    // not.
    for (const [index, content] of written.entries())
      expect(sha256(reread(content))).toBe(files[index]!.sha256);
    expect(sha256(reread("test"))).not.toBe(sha256(test4));
  };

  test("rehydrateMedia writes blob content as base64 for every media type", async () => {
    const { value, resolved } = await rehydrateMedia(parts(), files);
    expect(resolved).toBe(5);
    expectWrittenBack(value);
  });

  test("client.media.resolve writes blob content as base64 for every media type", async () => {
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
