import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isLoopbackHost } from "../config.js";
import { uuid } from "./json.js";

/**
 * Reading recorded media back. A trace records a large file as a digest part: the provider part
 * with its content field removed and the file's `sha256` and `size` added, its bytes uploaded
 * under the record's `hue.blobs`. `fetch` downloads one file by digest through a short-lived
 * link Hue issues; `resolve` and {@link rehydrateMedia} put the bytes back into the parts of a
 * recorded value, in the field and encoding each part's shape uses.
 */

/** Why a media read failed. */
export type MediaFetchErrorReason =
  /** Hue holds no such file for the trace or snapshot: an unknown trace, another project's, or a
   * digest none of its records list (with `spanId`, that span's record). */
  | "not_found"
  /** The trace lists the file, but its bytes were never uploaded or have been erased. */
  | "missing"
  /** Hue could not read its evidence store, again after one retry; `retryAfterSeconds` says when
   * to ask again. */
  | "unavailable"
  /** The key cannot read recorded content: use a Read or Read and write key, and a Read and write
   * key for a snapshot's copy. */
  | "forbidden"
  /** The file is larger than `maxBytes`; nothing was downloaded. */
  | "too_large"
  /** The downloaded bytes do not have the requested SHA-256 or the size Hue reported. */
  | "digest_mismatch"
  /** A connection failure, a timeout, an unexpected status or an invalid response. */
  | "failed";

const messages: Record<MediaFetchErrorReason, string> = {
  not_found: "Hue holds no file with this digest for the trace or snapshot",
  missing: "The trace lists this file, but its bytes were never uploaded or have been erased",
  unavailable: "Hue could not read the file now; retry later",
  forbidden: "The key cannot read recorded content; use a Read or Read and write key",
  too_large: "The file is larger than maxBytes",
  digest_mismatch: "The downloaded bytes do not match the requested SHA-256",
  failed: "The media request failed",
};

/** Thrown by {@link MediaClient.fetch}. The message is fixed and never includes response text. */
export class MediaFetchError extends Error {
  constructor(
    /** What failed. */
    readonly reason: MediaFetchErrorReason,
    /** HTTP status of the answer that failed, when there was one. */
    readonly status?: number,
    /** Seconds Hue asked the caller to wait, on `unavailable`, when it said. */
    readonly retryAfterSeconds?: number,
    options?: { cause?: unknown },
  ) {
    super(
      reason === "failed" && status ? `${messages.failed} (HTTP ${status})` : messages[reason],
      options,
    );
    this.name = "MediaFetchError";
  }
}

/** One recorded file, downloaded and checked against its digest. */
export interface MediaFile {
  /** The file's bytes; their SHA-256 is `sha256`. */
  bytes: Uint8Array;
  /** Lowercase hex SHA-256 of `bytes`, as requested. */
  sha256: string;
  /** Byte length of `bytes`. */
  size: number;
  /** The media type the record lists for the file; absent for a snapshot's copy, whose type is
   * the part's own. */
  contentType?: string;
  /** The recorded file name as Hue serves it; absent for a snapshot's copy. */
  fileName?: string;
}

/** The file {@link MediaClient.fetch} reads: from a trace, or from a snapshot's pinned copy. */
export type MediaFetchTarget =
  | {
      /** Hue trace ID (UUID) or the 32-hex OpenTelemetry trace ID. */
      traceId: string;
      /** Lowercase hex SHA-256 the part records. */
      sha256: string;
      /** 16-hex OpenTelemetry span ID of the span that recorded the part. Pass it when known: Hue
       * then reads that span's record alone instead of searching the trace. */
      spanId?: string;
      /** Not set when reading a live trace's file. */
      snapshotId?: undefined;
    }
  | {
      /** Trace snapshot ID (UUID), such as the one a case converted from a trace keeps. Reading
       * its copy needs a Read and write key. */
      snapshotId: string;
      /** Lowercase hex SHA-256 the part records. */
      sha256: string;
      /** Not set when reading a snapshot's pinned copy. */
      traceId?: undefined;
      /** Not set when reading a snapshot's pinned copy. */
      spanId?: undefined;
    };

/** Options for {@link MediaClient.fetch}. */
export interface MediaFetchOptions {
  /** Largest file read into memory, in bytes; a larger one fails with `too_large` before any byte
   * is downloaded. Default 64 MiB, at most 1 GB. */
  maxBytes?: number;
  /** Ends the request, the retry wait and the download. */
  signal?: AbortSignal;
}

/** Where {@link MediaClient.resolve} reads the files of a recorded value from, and how it writes
 * them. */
export type MediaResolveOptions = (
  | {
      /** Hue trace ID (UUID) or the 32-hex OpenTelemetry trace ID the value was recorded in. */
      traceId: string;
      /** 16-hex OpenTelemetry span ID of the span that recorded the value. */
      spanId?: string;
      /** Not set when resolving a live trace's files. */
      snapshotId?: undefined;
    }
  | {
      /** Trace snapshot ID whose pinned copies hold the files; reading them needs a Read and
       * write key. */
      snapshotId: string;
      /** Not set when resolving a snapshot's pinned copies. */
      traceId?: undefined;
      /** Not set when resolving a snapshot's pinned copies. */
      spanId?: undefined;
    }
) &
  MediaWriteOptions & {
    /** The `hue.blobs` entries of the record the value was read from, as the attribute holds
     * them: JSON object strings. A part that declares no media type, read from a copy that carries
     * none (a snapshot's), takes the type of the entry with its SHA-256 for its `data:` URL, rather
     * than `application/octet-stream`. Entries that do not parse are ignored. */
    blobs?: readonly string[];
    /** Files downloaded at once, 1–16. Default 4. */
    concurrency?: number;
    /** Largest file read, as in {@link MediaFetchOptions.maxBytes}. */
    maxBytes?: number;
    /** Ends every request and download. */
    signal?: AbortSignal;
  };

/** How resolved bytes are written into a part. */
export interface MediaWriteOptions {
  /**
   * `"dataUrl"` (the default) writes text: a `data:` URL where the part's field takes one (OpenAI
   * `image_url` and `file_data`, Responses `input_image`, `input_file` and `computer_screenshot`,
   * AI SDK `image` and `file` `data`), and bare base64 where its convention requires it (GenAI
   * `blob` `content`, OpenAI `input_audio` and assistant `audio` `data`, Anthropic `source.data`,
   * Gemini `inlineData.data`, Vertex `media` `data`, Bedrock `source.bytes`), so the value can be
   * sent to the provider again. `"bytes"` writes the `Uint8Array` itself in the same field.
   */
  as?: "dataUrl" | "bytes";
}

/** A digest part {@link MediaClient.resolve} or {@link rehydrateMedia} left unchanged. */
export interface MediaResolveFailure {
  /** RFC 6901 JSON pointer of the part in the value. */
  pointer: string;
  /** The SHA-256 the part records. */
  sha256: string;
  /** Why its bytes were not written: as {@link MediaFetchError.reason}, or `not_found` when no
   * local file has the digest. */
  reason: MediaFetchErrorReason;
}

/** A recorded value with the bytes of its digest parts written back. */
export interface MediaResolution<T = unknown> {
  /** A new value: the input is never changed. Each resolved part holds its bytes in its content
   * field and no longer carries `sha256` and `size`. */
  value: T;
  /** Parts whose bytes were written. */
  resolved: number;
  /** Parts left unchanged, in reading order. */
  failures: MediaResolveFailure[];
}

/** A local copy of a file {@link rehydrateMedia} reads by digest: a runner's verified case file
 * (`LocalFile`, read from `path`) or bytes already in memory. */
export type MediaSourceFile = {
  /** Lowercase hex SHA-256 of the file's bytes. */
  sha256: string;
  /** The file's media type, used when the part declares none. */
  contentType?: string;
} & (
  | {
      /** Path of the file on this machine. */
      path: string;
      /** Not set when the file is given as a path. */
      bytes?: undefined;
    }
  | {
      /** The file's bytes. */
      bytes: Uint8Array;
      /** Not set when the file is given as bytes. */
      path?: undefined;
    }
);

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRACE = /^[0-9a-f]{32}$/i;
const SPAN = /^[0-9a-f]{16}$/i;
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9!#$&^_.+-]+$/;
/** The default and largest `maxBytes`: Hue keeps values of up to 1 GB. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_BYTES = 1_000_000_000;
/** The least time a download may go without a byte before it ends: two minutes. Tests shorten it;
 * it is not exported from the package. */
export const mediaDownload = { minIdleMillis: 120_000 };
/** The longest `Retry-After` the one retry of an unavailable read waits. */
const MAX_RETRY_AFTER_SECONDS = 10;
/** Bytes of a JSON answer read: a link answer or an error body. */
const MAX_ANSWER_BYTES = 64 * 1024;
/** Nesting a value is walked to; deeper parts stay as they are. */
const MAX_DEPTH = 128;

function digestOf(value: unknown): string {
  const digest = typeof value === "string" ? value.toLowerCase() : value;
  if (typeof digest !== "string" || !SHA256.test(digest))
    throw new TypeError("sha256 must be 64 hex characters");
  return digest;
}
function maxBytesOf(value: number | undefined): number {
  const bytes = value ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_BYTES)
    throw new RangeError("maxBytes must be an integer from 1 to 1000000000");
  return bytes;
}
/** The route of a file and the digest it names, validated before anything is sent. */
function routeOf(target: MediaFetchTarget): { path: string; sha256: string } {
  if (!target || typeof target !== "object") throw new TypeError("Name a traceId or snapshotId");
  const sha256 = digestOf(target.sha256);
  if (target.snapshotId !== undefined) {
    if (target.traceId !== undefined || target.spanId !== undefined)
      throw new TypeError("Name a traceId or a snapshotId, not both");
    return {
      path: `/trace-snapshots/${uuid(target.snapshotId).toLowerCase()}/blobs/${sha256}`,
      sha256,
    };
  }
  const traceId = target.traceId;
  if (
    typeof traceId !== "string" ||
    !(UUID.test(traceId) || (TRACE.test(traceId) && !/^0+$/.test(traceId)))
  )
    throw new TypeError("traceId must be a Hue trace ID or a 32-hex OpenTelemetry trace ID");
  let query = "";
  if (target.spanId !== undefined) {
    if (
      typeof target.spanId !== "string" ||
      !SPAN.test(target.spanId) ||
      /^0+$/.test(target.spanId)
    )
      throw new TypeError("spanId must be a 16-hex OpenTelemetry span ID");
    query = `?spanId=${target.spanId.toLowerCase()}`;
  }
  return { path: `/traces/${traceId.toLowerCase()}/blobs/${sha256}${query}`, sha256 };
}

/** The host an `http:` link writes, before the URL parser rewrites it: after the authority's last
 * `@`, up to its port, the authority ending at the first `/`, `?` or `#`, as Python splits it. */
const WRITTEN_HTTP_HOST = /^http:\/\/(?:[^/?#]*@)?(\[[^\]/?#]*\]|[^/?#:@]*)/i;

/**
 * A download link Hue issued: HTTPS, or HTTP to a loopback host written `localhost`, `127.0.0.1`
 * or `[::1]`, without credentials or a fragment. A host the URL parser rewrites to one of those
 * (`127.1`, `0x7f.0.0.1`, `[0::1]`) is refused, as the Python SDK refuses it.
 */
function linkOf(value: unknown): string | undefined {
  // eslint-disable-next-line no-control-regex -- control characters are refused
  if (typeof value !== "string" || value.length > 8192 || /[\x00-\x20\x7f]/u.test(value))
    return undefined;
  try {
    const url = new URL(value);
    const allowed =
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        isLoopbackHost(url.hostname) &&
        WRITTEN_HTTP_HOST.exec(value)?.[1]?.toLowerCase() === url.hostname);
    return allowed && !url.username && !url.password && !url.hash ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The whole seconds of a `Retry-After` header, up to a day, when it is one. */
function retryAfterOf(response: Response): number | undefined {
  const header = response.headers.get("retry-after")?.trim() ?? "";
  return /^\d{1,6}$/.test(header) ? Math.min(Number(header), 86_400) : undefined;
}

/** Waits `millis`, or less when `signal` ends first. */
function pause(millis: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, millis);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });
}

/** The connection failed while an answer's body was read: no answer, unlike a malformed one. */
class AnswerReadError extends Error {}

/** A JSON answer read to a bound; undefined when it is larger or not JSON. Throws
 * {@link AnswerReadError} when the connection fails while it is read. */
async function answerOf(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      let read: Awaited<ReturnType<typeof reader.read>>;
      try {
        read = await reader.read();
      } catch (error) {
        throw new AnswerReadError("The answer could not be read", { cause: error });
      }
      if (read.done) break;
      size += read.value.byteLength;
      if (size > MAX_ANSWER_BYTES) return undefined;
      chunks.push(read.value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      return undefined;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

interface Grant {
  url: string;
  size: number;
  contentType?: string;
  fileName?: string;
}

function grantOf(answer: unknown, sha256: string): Grant {
  const fields =
    answer !== null && typeof answer === "object" && !Array.isArray(answer)
      ? (answer as Record<string, unknown>)
      : undefined;
  const url = linkOf(fields?.url);
  const size = fields?.size;
  if (
    !fields ||
    fields.sha256 !== sha256 ||
    url === undefined ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    (fields.method !== undefined && fields.method !== "GET")
  )
    throw new MediaFetchError("failed");
  const contentType =
    typeof fields.contentType === "string" &&
    fields.contentType.length <= 255 &&
    MEDIA_TYPE.test(fields.contentType.split(";")[0]!.trim())
      ? fields.contentType
      : undefined;
  const fileName =
    typeof fields.fileName === "string" &&
    fields.fileName.length > 0 &&
    fields.fileName.length <= 255
      ? fields.fileName
      : undefined;
  return {
    url,
    size,
    ...(contentType !== undefined ? { contentType } : {}),
    ...(fileName !== undefined ? { fileName } : {}),
  };
}

/**
 * Hue's media reads, `client.media`: one recorded file by digest (`fetch`), and every digest part
 * of a recorded value written back with its bytes (`resolve`). The project key is sent to Hue
 * only; the file itself comes from a short-lived link fetched without it.
 */
export class MediaClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #timeoutMillis: number;
  /** @internal Created by the evaluation client as its `media`. */
  constructor(options: { baseUrl: string; apiKey: string; timeoutMillis: number }) {
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey;
    this.#timeoutMillis = options.timeoutMillis;
  }

  /**
   * Downloads one recorded file and checks it against its digest: from a trace (Hue reads the
   * span's record that lists the digest under `hue.blobs`) or from a snapshot's pinned copy. A
   * read Hue answers as unavailable (503 or 429) is asked once more after its `Retry-After`, at
   * most 10 seconds, and so is one that lost its connection or timed out.
   *
   * @throws MediaFetchError for a file Hue does not hold, a refused key, an unavailable store, a
   * file over `maxBytes`, bytes that do not match the digest or a failed request.
   * @throws TypeError for an invalid trace, span or snapshot ID or digest.
   */
  async fetch(target: MediaFetchTarget, options: MediaFetchOptions = {}): Promise<MediaFile> {
    const { path, sha256 } = routeOf(target);
    const maxBytes = maxBytesOf(options.maxBytes);
    const grant = await this.#grant(path, sha256, options.signal);
    if (grant.size > maxBytes) throw new MediaFetchError("too_large");
    const bytes = await this.#download(grant, sha256, options.signal);
    return {
      bytes,
      sha256,
      size: bytes.byteLength,
      ...(grant.contentType !== undefined ? { contentType: grant.contentType } : {}),
      ...(grant.fileName !== undefined ? { fileName: grant.fileName } : {}),
    };
  }

  /**
   * Writes the bytes of every digest part in `value` back into its content field, the reverse of
   * the SDK's media capture: each distinct digest is downloaded once with {@link fetch}, at most
   * `concurrency` at a time. Returns a new value; a part whose file cannot be read stays as it is
   * and is reported in `failures`. Parse attributes recorded as JSON text (such as
   * `gen_ai.input.messages`) before passing them; pass the record's `hue.blobs` as `blobs` when
   * reading a snapshot, whose copies carry no media type.
   *
   * @throws TypeError for invalid identifiers or options; never for one file's failure.
   */
  async resolve<T>(value: T, options: MediaResolveOptions): Promise<MediaResolution<T>> {
    if (!options || typeof options !== "object")
      throw new TypeError("Name a traceId or snapshotId");
    const as = writeModeOf(options.as);
    const listed = listedTypes(options.blobs);
    const concurrency = options.concurrency ?? 4;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
      throw new RangeError("concurrency must be 1–16");
    const maxBytes = maxBytesOf(options.maxBytes);
    const target = (sha256: string): MediaFetchTarget =>
      options.snapshotId !== undefined
        ? { snapshotId: options.snapshotId, sha256 }
        : {
            traceId: options.traceId,
            sha256,
            ...(options.spanId !== undefined ? { spanId: options.spanId } : {}),
          };
    // Identifiers are checked once, before any request.
    routeOf(target("0".repeat(64)));
    const parts = digestParts(value);
    const digests = [...new Set([...parts.values()].map((part) => part.sha256))];
    const files = new Map<string, MediaFile | MediaFetchError>();
    let next = 0;
    const worker = async () => {
      for (let index = next++; index < digests.length; index = next++) {
        const sha256 = digests[index]!;
        try {
          const file = await this.fetch(target(sha256), { maxBytes, signal: options.signal });
          const listedType = file.contentType === undefined ? listed.get(sha256) : undefined;
          files.set(sha256, listedType === undefined ? file : { ...file, contentType: listedType });
        } catch (error) {
          files.set(
            sha256,
            error instanceof MediaFetchError
              ? error
              : new MediaFetchError("failed", undefined, undefined, { cause: error }),
          );
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, digests.length) }, worker));
    return writeBack(
      value,
      parts,
      (sha256) => {
        const file = files.get(sha256)!;
        return file instanceof MediaFetchError ? file.reason : file;
      },
      as,
    );
  }

  /** The download link of one file, asked once more after an unavailable answer or a lost
   * connection. */
  async #grant(path: string, sha256: string, signal?: AbortSignal): Promise<Grant> {
    for (let attempt = 0; ; attempt++) {
      /** A lost connection, before or while the answer is read: asked once more, then failed. */
      const lost = async (error: unknown) => {
        if (attempt > 0 || signal?.aborted)
          throw new MediaFetchError("failed", undefined, undefined, { cause: error });
        await pause(250 + Math.random() * 250, signal);
      };
      let response: Response;
      try {
        response = await fetch(`${this.#baseUrl}/api/v1${path}`, {
          headers: { Authorization: `Bearer ${this.#apiKey}` },
          // A redirect is never followed: it is an unexpected answer, failed with its status
          // and not asked again, as a lost connection is.
          redirect: "manual",
          signal: AbortSignal.any([
            AbortSignal.timeout(this.#timeoutMillis),
            ...(signal ? [signal] : []),
          ]),
        });
      } catch (error) {
        await lost(error);
        continue;
      }
      let answer: unknown;
      const status = response.status;
      if (status === 503 || status === 429) {
        await response.body?.cancel().catch(() => undefined);
        const seconds = retryAfterOf(response);
        const wait = seconds ?? 1;
        if (attempt > 0 || wait > MAX_RETRY_AFTER_SECONDS || signal?.aborted)
          throw new MediaFetchError("unavailable", status, seconds);
        await pause(wait * 1000, signal);
        continue;
      }
      if (status === 404 || response.ok) {
        try {
          answer = await answerOf(response);
        } catch (error) {
          if (!(error instanceof AnswerReadError)) throw error;
          await lost(error);
          continue;
        }
      }
      if (status === 404) {
        const missing =
          answer !== null &&
          typeof answer === "object" &&
          (answer as { state?: unknown }).state === "missing";
        throw new MediaFetchError(missing ? "missing" : "not_found", status);
      }
      if (status === 401 || status === 403) {
        await response.body?.cancel().catch(() => undefined);
        throw new MediaFetchError("forbidden", status);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new MediaFetchError("failed", status);
      }
      return grantOf(answer, sha256);
    }
  }

  /** The bytes behind a link, fetched without the key, stopped one byte past the reported size
   * and checked against the digest. The download ends once no byte has arrived for the client's
   * timeout, at least two minutes; a large file that keeps arriving is never cut off. */
  async #download(grant: Grant, sha256: string, signal?: AbortSignal): Promise<Uint8Array> {
    const idleMillis = Math.max(this.#timeoutMillis, mediaDownload.minIdleMillis);
    const idle = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const restart = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => idle.abort(new DOMException("No byte arrived in time", "TimeoutError")),
        idleMillis,
      );
    };
    restart();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      let response: Response;
      try {
        response = await fetch(grant.url, {
          redirect: "manual",
          signal: AbortSignal.any([idle.signal, ...(signal ? [signal] : [])]),
        });
      } catch (error) {
        throw new MediaFetchError("failed", undefined, undefined, { cause: error });
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new MediaFetchError("failed", response.status);
      }
      // The answer arrived: its body has the same time again for each piece.
      restart();
      reader = response.body?.getReader();
      const hash = createHash("sha256");
      const bytes = new Uint8Array(grant.size);
      let size = 0;
      try {
        if (reader)
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            restart();
            if (size + value.byteLength > grant.size) throw new MediaFetchError("digest_mismatch");
            bytes.set(value, size);
            hash.update(value);
            size += value.byteLength;
          }
      } catch (error) {
        if (error instanceof MediaFetchError) throw error;
        throw new MediaFetchError("failed", undefined, undefined, { cause: error });
      }
      if (size !== grant.size || hash.digest("hex") !== sha256)
        throw new MediaFetchError("digest_mismatch");
      return bytes;
    } finally {
      clearTimeout(timer);
      await reader?.cancel().catch(() => undefined);
    }
  }
}

/** The media type each digest has in a record's `hue.blobs` entries, the first valid one of a
 * digest; an entry that does not parse, or names no valid digest or type, is ignored. */
function listedTypes(entries: unknown): Map<string, string> {
  const types = new Map<string, string>();
  if (entries === undefined) return types;
  if (!Array.isArray(entries)) throw new TypeError("blobs must be the record's hue.blobs entries");
  for (const entry of entries as unknown[]) {
    if (typeof entry !== "string" || entry.length > 2048) continue;
    let fields: Plain | undefined;
    try {
      fields = plain(JSON.parse(entry));
    } catch {
      continue;
    }
    const sha256 = typeof fields?.sha256 === "string" ? fields.sha256.toLowerCase() : "";
    const type: unknown = fields?.content_type ?? fields?.contentType;
    if (
      SHA256.test(sha256) &&
      !types.has(sha256) &&
      typeof type === "string" &&
      type.length <= 255 &&
      MEDIA_TYPE.test(type.split(";")[0]!.trim())
    )
      types.set(sha256, type);
  }
  return types;
}

function writeModeOf(value: unknown): "dataUrl" | "bytes" {
  if (value === undefined) return "dataUrl";
  if (value !== "dataUrl" && value !== "bytes")
    throw new TypeError('as must be "dataUrl" or "bytes"');
  return value;
}

/**
 * Writes case files back into the digest parts of a case's inputs, by SHA-256: the files a runner
 * hands a target (`context.files`) or any bytes the caller holds, so a target can send the
 * recorded model call again with the real image, document or audio. Each file is read once and
 * checked against its digest; a part with no matching file, or whose file does not match, stays
 * as it is and is reported in `failures`. Returns a new value; the input is never changed.
 */
export async function rehydrateMedia<T>(
  value: T,
  files: readonly MediaSourceFile[],
  options: MediaWriteOptions = {},
): Promise<MediaResolution<T>> {
  const as = writeModeOf(options.as);
  if (!Array.isArray(files)) throw new TypeError("files must be a list of files");
  const byDigest = new Map<string, MediaSourceFile>();
  for (const file of files) {
    const digest = typeof file?.sha256 === "string" ? file.sha256.toLowerCase() : undefined;
    if (digest !== undefined && SHA256.test(digest) && !byDigest.has(digest))
      byDigest.set(digest, file);
  }
  const parts = digestParts(value);
  const read = new Map<string, MediaFile | MediaFetchErrorReason>();
  for (const sha256 of new Set([...parts.values()].map((part) => part.sha256))) {
    const file = byDigest.get(sha256);
    if (!file) {
      read.set(sha256, "not_found");
      continue;
    }
    let bytes: Uint8Array;
    try {
      if (file.bytes !== undefined && !(file.bytes instanceof Uint8Array))
        throw new TypeError("bytes must be a Uint8Array");
      bytes = file.bytes ?? (await readFile(file.path));
    } catch {
      read.set(sha256, "failed");
      continue;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
      read.set(sha256, "digest_mismatch");
      continue;
    }
    read.set(sha256, {
      bytes,
      sha256,
      size: bytes.byteLength,
      ...(file.contentType !== undefined ? { contentType: file.contentType } : {}),
    });
  }
  return writeBack(value, parts, (sha256) => read.get(sha256)!, as);
}

/** Where a digest part keeps its content: the objects from the part to the field's owner, the
 * field, the encoding the shape's convention uses, and the media type the part declares. */
interface Slot {
  owner: readonly string[];
  key: string;
  encoding: "base64" | "dataUrl";
  mediaType?: string;
}
interface DigestPart {
  pointer: string;
  sha256: string;
  slot: Slot;
}

type Plain = Record<string, unknown>;
/** A plain object, the only kind of object the walk copies and writes into. */
function plain(value: unknown): Plain | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null ? (value as Plain) : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function declaredType(part: Plain): string | undefined {
  return text(part.mime_type ?? part.mediaType ?? part.media_type ?? part.mimeType);
}
const AUDIO_FORMATS: Record<string, string> = {
  mp3: "audio/mpeg",
  mpeg: "audio/mpeg",
  mpga: "audio/mpeg",
  wav: "audio/wav",
  wave: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  webm: "audio/webm",
  pcm16: "audio/pcm",
  pcm: "audio/pcm",
};
const BEDROCK_TYPES: Record<string, Record<string, string>> = {
  image: {
    png: "image/png",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  },
  document: {
    pdf: "application/pdf",
    csv: "text/csv",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    html: "text/html",
    txt: "text/plain",
    md: "text/markdown",
  },
};
const audioType = (format: unknown) =>
  typeof format === "string" ? AUDIO_FORMATS[format.trim().toLowerCase()] : undefined;

/** The content slot of a part read by its shape, the shapes Hue reads media parts in; undefined
 * for text, tool and reference parts (a provider file ID, a remote URL). */
function slotOf(part: Plain): Slot | undefined {
  const type =
    typeof part.type === "string" ? part.type.toLowerCase().replaceAll("-", "_") : undefined;
  const reference = typeof part.file_id === "string";
  switch (type) {
    case "blob":
      return {
        owner: [],
        key: "content",
        encoding: "base64",
        mediaType: declaredType(part),
      };
    case "file": {
      const file = plain(part.file);
      if (file)
        return typeof file.file_id === "string"
          ? undefined
          : {
              owner: ["file"],
              key: "file_data",
              encoding: "dataUrl",
              mediaType: declaredType(part),
            };
      return reference
        ? undefined
        : { owner: [], key: "data", encoding: "dataUrl", mediaType: declaredType(part) };
    }
    case "image":
    case "document": {
      const source = plain(part.source);
      // A source without a type, absent or null, is read as base64, as Hue reads it.
      if (source)
        return source.type === undefined || source.type === null || source.type === "base64"
          ? {
              owner: ["source"],
              key: "data",
              encoding: "base64",
              mediaType: text(source.media_type) ?? declaredType(part),
            }
          : undefined;
      return type === "image"
        ? { owner: [], key: "image", encoding: "dataUrl", mediaType: declaredType(part) }
        : undefined;
    }
    case "image_url":
      return plain(part.image_url)
        ? { owner: ["image_url"], key: "url", encoding: "dataUrl", mediaType: declaredType(part) }
        : { owner: [], key: "image_url", encoding: "dataUrl", mediaType: declaredType(part) };
    case "input_image":
    case "computer_screenshot":
      return reference
        ? undefined
        : { owner: [], key: "image_url", encoding: "dataUrl", mediaType: declaredType(part) };
    case "input_audio": {
      const audio = plain(part.input_audio);
      return audio
        ? {
            owner: ["input_audio"],
            key: "data",
            encoding: "base64",
            mediaType: audioType(audio.format),
          }
        : {
            owner: [],
            key: "data",
            encoding: "base64",
            mediaType: audioType(part.format) ?? declaredType(part),
          };
    }
    case "input_file":
      return reference || typeof part.file_url === "string"
        ? undefined
        : { owner: [], key: "file_data", encoding: "dataUrl", mediaType: declaredType(part) };
    case "media":
      return {
        owner: [],
        key: "data",
        encoding: "base64",
        mediaType: declaredType(part),
      };
    case undefined: {
      for (const key of ["inlineData", "inline_data"]) {
        const data = plain(part[key]);
        if (data)
          return {
            owner: [key],
            key: "data",
            encoding: "base64",
            mediaType: text(data.mimeType ?? data.mime_type),
          };
      }
      for (const key of ["image", "document"]) {
        const block = plain(part[key]);
        const source = plain(block?.source);
        if (block && source && source.s3Location === undefined)
          return {
            owner: [key, "source"],
            key: "bytes",
            encoding: "base64",
            mediaType:
              typeof block.format === "string"
                ? BEDROCK_TYPES[key]![block.format.toLowerCase()]
                : undefined,
          };
      }
      // An OpenAI Chat assistant message's spoken reply: the message itself is the part.
      const audio = plain(part.audio);
      if (audio && typeof audio.id === "string")
        return {
          owner: ["audio"],
          key: "data",
          encoding: "base64",
          mediaType: audioType(audio.format),
        };
      return undefined;
    }
    default:
      return undefined;
  }
}

/** The slot of a part in digest form: a known shape that records a SHA-256 in place of its
 * content, its content field absent or empty. */
function digestSlotOf(part: Plain): Slot | undefined {
  if (typeof part.sha256 !== "string" || !SHA256.test(part.sha256)) return undefined;
  const slot = slotOf(part);
  if (!slot) return undefined;
  let owner: Plain | undefined = part;
  for (const segment of slot.owner) owner = plain(owner?.[segment]);
  if (!owner) return undefined;
  const content = owner[slot.key];
  return content === undefined || content === null || content === "" ? slot : undefined;
}

const escape = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");

/** The digest parts of a value, by the part object, each once, in reading order. */
function digestParts(value: unknown): Map<object, DigestPart> {
  const found = new Map<object, DigestPart>();
  const visit = (node: unknown, pointer: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${pointer}/${index}`, depth + 1));
      return;
    }
    const part = plain(node);
    if (!part) return;
    const slot = digestSlotOf(part);
    // The slot's owners must sit within the depth the copy is made to.
    if (slot && depth + slot.owner.length < MAX_DEPTH && !found.has(part))
      found.set(part, { pointer, sha256: part.sha256 as string, slot });
    // A message whose `audio` is a part still holds the parts of its `content`.
    for (const [key, item] of Object.entries(part))
      visit(item, `${pointer}/${escape(key)}`, depth + 1);
  };
  visit(value, "", 0);
  return found;
}

/** The type a `data:` URL declares: the part's own, else the file's, without parameters. */
function dataUrlType(slot: Slot, file: MediaFile): string {
  for (const candidate of [slot.mediaType, file.contentType]) {
    const type = candidate?.split(";")[0]!.trim();
    if (type && MEDIA_TYPE.test(type)) return type.toLowerCase();
  }
  return "application/octet-stream";
}

/**
 * A file's bytes as a slot's convention spells them: bare base64 or a `data:` URL. A GenAI `blob`
 * or Vertex `media` part takes base64 for every media type, as the GenAI conventions define its
 * content and as Hue's reader decodes content that reads as base64; raw text such as `test`
 * would itself read as base64 and stand for other bytes.
 */
function spelled(slot: Slot, file: MediaFile): string {
  const base64 = Buffer.from(file.bytes).toString("base64");
  return slot.encoding === "dataUrl" ? `data:${dataUrlType(slot, file)};base64,${base64}` : base64;
}

/** Sets an own enumerable property, a key named `__proto__` included, which assignment would take
 * as the object's prototype instead. */
function setOwn(target: Plain, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** A copy of `value` with each digest part whose file was read holding its bytes. */
function writeBack<T>(
  value: T,
  parts: Map<object, DigestPart>,
  fileOf: (sha256: string) => MediaFile | MediaFetchErrorReason,
  as: "dataUrl" | "bytes",
): MediaResolution<T> {
  const failures: MediaResolveFailure[] = [];
  let resolved = 0;
  const reported = new Set<object>();
  const visit = (node: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) return node;
    if (Array.isArray(node)) return node.map((item) => visit(item, depth + 1));
    const source = plain(node);
    if (!source) return node;
    const part = parts.get(source);
    const file = part && fileOf(part.sha256);
    if (part && typeof file === "string" && !reported.has(source)) {
      failures.push({ pointer: part.pointer, sha256: part.sha256, reason: file });
      reported.add(source);
    }
    const copy: Plain = {};
    for (const [key, item] of Object.entries(source)) setOwn(copy, key, visit(item, depth + 1));
    if (part && file !== undefined && typeof file !== "string") {
      // The owners along the slot are this copy's own objects: the walk copied every plain one.
      let owner = copy;
      for (const segment of part.slot.owner) owner = owner[segment] as Plain;
      owner[part.slot.key] = as === "bytes" ? file.bytes : spelled(part.slot, file);
      delete copy.sha256;
      delete copy.size;
      resolved++;
    }
    return copy;
  };
  const result = visit(value, 0) as T;
  return { value: result, resolved, failures };
}
