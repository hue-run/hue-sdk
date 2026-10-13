import { createHash } from "node:crypto";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import { context, type HrTime } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { isLoopbackHost } from "./config.js";
import {
  digestPart,
  hashInlineFiles,
  hashNestedInlineFiles,
  INLINE_FILE_LIMIT,
  INLINE_FILE_TEXT_PER_RECORD,
  isMessageKey,
  keepsPrefix,
  literalKeys,
  mediaBytes,
  mediaContentType,
  mediaIn,
  isTextMediaType,
  type InlineFileBytes,
  type InlineFilePart,
  type MediaDigestMemo,
  type FileDigest,
  mayInlineFiles,
  isMediaContentType,
  MAX_INLINE_FILE_TEXT,
  placeable,
  placedMediaText,
  prefixPart,
  readMediaText,
  reencodeMedia,
} from "./inline-files.js";
import {
  isByteSource,
  JoinedText,
  longFileBytes,
  longHead,
  placedLargeText,
  readLargeMediaText,
  type ByteSource,
  type LargeMediaValue,
  type LongText,
} from "./large-media.js";
import { capLogBody, TRUNCATED_KEY, truncatedMarker, withTruncatedKeys } from "./privacy.js";
import { truncateUtf8 } from "./safety.js";

/**
 * Large values and binary media travel apart from their span through reservation, presigned PUT,
 * and completion. Text keeps a 16 KiB prefix. Binary media keeps digest metadata on its part.
 * Successful uploads are listed in `hue.blobs`; failures keep inline fallback or file metadata,
 * are reported as warnings, and are counted.
 */

/** The span attribute listing the values the SDK uploaded apart from the span: one compact JSON
 * object per value, `{"key", "sha256", "size", "content_type"}`, with an optional `name`. */
export const BLOBS_KEY = "hue.blobs";
/** The largest value one upload may hold (`Hue-Max-Blob-Bytes`): a larger value is cut inline. */
export const MAX_BLOB_BYTES = 1_000_000_000;
/** What an uploaded value keeps inline: its first 16 KiB, the receiver's search excerpt. */
export const BLOB_PREFIX_BYTES = 16 * 1024;
/** The entries one record's `hue.blobs` may list; Hue reads no more. */
export const MAX_BLOB_ENTRIES = 64;
const MAX_BLOB_KEY_LENGTH = 256;
/**
 * The values over the inline limit that queued spans may hold whole for upload at once, charged
 * apart from `maxQueueBytes` (a string as two bytes a code unit, bytes as themselves). A value
 * the budget cannot hold is cut when it is queued, as before uploads existed; a single value
 * larger than the whole budget is held while nothing else is.
 */
export const MAX_HELD_BLOB_BYTES = 128 * 1024 * 1024;
/** Uploads in flight at once, across both signals' exports. */
const UPLOAD_CONCURRENCY = 4;
/** How long a receiver without the upload route is believed to stay without it. */
const UNSUPPORTED_PAUSE_MILLIS = 10 * 60_000;
/** How long uploads pause after one failed for a transient reason (a 5xx, the network, a
 * timeout), so an unavailable store meets no retry storm: values fall back to the inline cut. */
const FAILURE_PAUSE_MILLIS = 30_000;
const MAX_JSON_RESPONSE_BYTES = 64 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 4096;
/** Text is encoded to UTF-8 a slice at a time to hash and upload it: no full copy is held. */
const TEXT_CHUNK_UNITS = 1 << 20;
const RETRY_DELAY_MILLIS = 1000;
/** The longest `Retry-After` a transient refusal of a reservation is waited for. */
const MAX_TRANSIENT_WAIT_MILLIS = 5000;

/** How long one export may spend uploading its values, on top of its requests. */
export function uploadBudgetMillis(timeoutMillis: number): number {
  return timeoutMillis * 6;
}

/** Why content kept its fallback instead of being uploaded. */
export type FallbackReason = "unsupported" | "failed" | "tooLarge" | "budget";

/** The fixed description of each fallback, as an export issue reports it. */
export const FALLBACK_MESSAGES: Record<FallbackReason, string> = {
  unsupported:
    "This Hue server does not accept uploaded values; large values were cut inline and media kept digest metadata",
  failed:
    "Content could not be uploaded; large values were cut inline and media kept digest metadata",
  tooLarge: "Content over its upload limit kept inline fallback or file metadata",
  budget:
    "Content did not fit the SDK's upload budget; large values were cut inline and media kept digest metadata",
};

/** A span's own attribute value the redaction left whole for the upload step to place. */
export interface OffloadCandidate {
  key: string;
  value: string | Uint8Array;
}

/** What redaction leaves to the upload step: the candidates, and the keys of the values over the
 * inline limit the queue cut when the span was admitted (they cannot be uploaded whole). */
export interface OffloadCollector {
  candidates: OffloadCandidate[];
  cut: string[];
  attachments?: MediaAttachment[];
  /** The span's own attributes admission inspected for media within the record's allowance:
   * export inspects only these. Absent for a record admission did not copy, and for a log record,
   * which export inspects within its own allowance. */
  inspected?: ReadonlySet<string> | undefined;
  /** The span's own attributes admission held whole for upload past the inspection bounds: export
   * reads their media in place (`readLargeMediaText`). */
  large?: ReadonlySet<string> | undefined;
  /** Set for a log record: its values over the inline limit are cut, never uploaded whole; only
   * the media in its inspected attributes and its body upload, with the attachments placed in
   * its body (`attachments`, keyed `body#<pointer>`). */
  log?: boolean;
  /** A log record's structured body, redacted whole, whose media upload under `body#<pointer>`. */
  body?: { value: unknown };
  /** The strings of a log record's body the queue cut when the record was admitted: never read
   * as files, since their bytes are not the file's. */
  bodyCut?: Set<string>;
}

export interface MediaAttachment {
  /** The file's bytes, or for a file given by path over the in-memory limit, its source on disk. */
  bytes: Uint8Array | ByteSource;
  digest: FileDigest;
  contentType: string;
  name?: string;
  eventTime?: HrTime;
  /** For an attachment placed in a value: the record's attribute (or `body`) that holds its part. */
  attribute?: string;
  /** For a placed attachment found in its value: its `hue.blobs` key, `<attribute>#<pointer>`. */
  key?: string;
}

/** The `hue.blobs` key of a staged file: its part's for an attachment placed in a value, else
 * its `hue.file` event's. */
export function mediaKey(file: MediaAttachment): string {
  return file.key ?? `event:hue.file:${file.digest.sha256}`;
}

/** The outcome of one export's uploads, reported once the export's records are placed. */
export interface OffloadTally {
  uploaded: number;
  fallbacks: Map<FallbackReason, { count: number; traceIds: Set<string> }>;
}

export function newTally(): OffloadTally {
  return { uploaded: 0, fallbacks: new Map() };
}

export function countFallback(tally: OffloadTally, reason: FallbackReason, traceId: string): void {
  const entry = tally.fallbacks.get(reason) ?? { count: 0, traceIds: new Set<string>() };
  entry.count++;
  entry.traceIds.add(traceId);
  tally.fallbacks.set(reason, entry);
}

/** A media type accepted by the upload contract. */
export function isBlobContentType(value: unknown): value is string {
  return isMediaContentType(value);
}

function isBlobKey(key: string): boolean {
  if (key.length < 1 || key.length > MAX_BLOB_KEY_LENGTH) return false;
  for (let index = 0; index < key.length; index++) {
    const code = key.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** The media type an uploaded text is stored under: JSON when it reads as a JSON object or array
 * (a structured value's text), plain UTF-8 text otherwise. Both are previewed as text. */
export function textContentType(text: string): string {
  const head = text.slice(0, 256).trimStart();
  const tail = text.slice(-256).trimEnd();
  return (head.startsWith("{") && tail.endsWith("}")) ||
    (head.startsWith("[") && tail.endsWith("]"))
    ? "application/json"
    : "text/plain; charset=utf-8";
}

/** What an uploaded value keeps inline: its first 16 KiB (text cut back to a character), held
 * as its own copy so the whole value is not kept alive by it. */
export function blobPrefix(value: string): string;
export function blobPrefix(value: Uint8Array): Uint8Array;
export function blobPrefix(value: string | Uint8Array): string | Uint8Array {
  if (typeof value !== "string")
    return Uint8Array.prototype.slice.call(value, 0, BLOB_PREFIX_BYTES);
  // A slice of a longer string can keep the whole string alive; the decoded copy holds only the
  // prefix.
  return Buffer.from(truncateUtf8(value, BLOB_PREFIX_BYTES), "utf8").toString("utf8");
}

/** A value's size in bytes as it is uploaded: a string's UTF-8 encoding, counted, not made. */
export function sizeOf(value: string | Uint8Array | ByteSource): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  return isByteSource(value) ? value.size : value.byteLength;
}

/** The bytes a value holds in memory: none for a source read as it is uploaded. */
export function heldBytesOf(value: Uint8Array | ByteSource): number {
  return isByteSource(value) ? 0 : value.byteLength;
}

/** A string's UTF-8 encoding a slice at a time, never splitting a surrogate pair. */
function* utf8Chunks(text: string): Generator<Buffer> {
  // One buffer, reused: a reader is done with each slice before it asks for the next.
  const buffer = Buffer.allocUnsafe(TEXT_CHUNK_UNITS * 3);
  for (let start = 0; start < text.length; ) {
    let end = Math.min(text.length, start + TEXT_CHUNK_UNITS);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    yield buffer.subarray(0, buffer.write(text.slice(start, end), "utf8"));
    start = end;
  }
}

/** The bytes an upload carries, a slice at a time: no second copy of a large value is made. */
function uploadChunks(
  value: string | Uint8Array | ByteSource,
): Iterable<Uint8Array> | AsyncIterable<Uint8Array> {
  if (isByteSource(value)) return value.chunks();
  return (function* () {
    if (typeof value === "string") {
      yield* utf8Chunks(value);
      return;
    }
    for (let start = 0; start < value.byteLength; start += TEXT_CHUNK_UNITS)
      yield value.subarray(start, Math.min(value.byteLength, start + TEXT_CHUNK_UNITS));
  })();
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The SHA-256 (lowercase hex) and byte size of what an upload of `value` carries, yielding to
 * the event loop between slices so a large value does not stall the application. Past
 * `deadline`, it throws rather than read on. */
export async function digestOf(
  value: string | Uint8Array | ByteSource,
  deadline = Infinity,
): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of uploadChunks(value)) {
    hash.update(chunk);
    size += chunk.byteLength;
    await nextTurn();
    if (Date.now() >= deadline) throw new Error("The upload ran out of time");
  }
  return { sha256: hash.digest("hex"), size };
}

/** The `hue.blobs` element for one uploaded value. */
export function blobEntry(
  key: string,
  sha256: string,
  size: number,
  contentType: string,
  name?: string,
): string {
  return JSON.stringify({
    key,
    sha256,
    size,
    content_type: contentType,
    ...(name ? { name } : {}),
  });
}

/** What one export's uploads share: their deadline, and the export's hold for a receiver that
 * limited the rate (`wait` resolves false when the hold may not take `millis` more). */
export interface UploadContext {
  deadline: number;
  wait(millis: number): Promise<boolean>;
}

interface Grant {
  url: URL;
  headers: Record<string, string>;
  expiresAt: number;
}

type Reservation =
  | { exists: true; contentType: string }
  | { exists: false; contentType: string; grant: Grant }
  | { fallback: FallbackReason };

/** An upload's outcome; `changed` when the value's own source no longer held its bytes (a file
 * that changed since it was recorded), which says nothing of another reference's bytes. */
type Outcome =
  | { ok: true; contentType: string }
  | { ok: false; reason: FallbackReason; changed?: boolean };

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** Whether the request's whole body was written before the answer arrived. */
  complete: boolean;
}

/** HTTP header names (tokens) and values without line breaks or NUL. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

function retryAfterMillis(headers: IncomingHttpHeaders): number | undefined {
  const value = headers["retry-after"];
  if (typeof value !== "string" || !/^\s*\d{1,6}\s*$/.test(value)) return undefined;
  return Number(value.trim()) * 1000;
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The upload route's options, from the transport's validated options. */
export interface UploaderOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMillis: number;
  allowInsecureHttp: boolean;
  userAgent: string;
}

/**
 * Uploads values to Hue: reserves each with `POST /api/v1/otlp/blobs`, PUTs its bytes to the
 * presigned URL Hue answers (skipped when Hue already stores the value), and completes it. At
 * most {@link UPLOAD_CONCURRENCY} uploads run at once; every request has a deadline and none
 * follows a redirect. A receiver without the route (a 404 without Hue's JSON error, a 405 or
 * 501, or a 200 that is no reservation) is remembered for {@link UNSUPPORTED_PAUSE_MILLIS}, and a
 * transient failure or a refusal that is not about the value alone pauses uploads for
 * {@link FAILURE_PAUSE_MILLIS}, so values fall back to the inline cut instead of retrying.
 */
export class BlobUploader {
  private unsupportedUntil = 0;
  private pausedUntil = 0;
  private closed = false;
  private running = 0;
  private waiting: (() => void)[] = [];
  private requests = new Set<ClientRequest>();
  private outcomes = new Map<string, { promise: Promise<Outcome>; settled: boolean }>();

  constructor(private readonly options: UploaderOptions) {}

  /** Whether a value over the inline limit is worth holding whole for upload now. */
  available(): boolean {
    return !this.closed && Date.now() >= this.unsupportedUntil;
  }

  /** Whether the receiver lacks the upload route, as it last answered. */
  unsupported(): boolean {
    return Date.now() < this.unsupportedUntil;
  }

  /** Ends uploads in flight and refuses new ones: their values fall back to the inline cut. */
  close(): void {
    this.closed = true;
    for (const request of this.requests) request.destroy();
    this.requests.clear();
    this.outcomes.clear();
    for (const run of this.waiting.splice(0)) {
      this.running++;
      run();
    }
  }

  /** Runs `work` once fewer than {@link UPLOAD_CONCURRENCY} uploads are in flight. */
  async limit<R>(work: () => Promise<R>): Promise<R> {
    // A finishing upload hands its place to the next one waiting, so none is ever taken twice.
    if (this.running >= UPLOAD_CONCURRENCY && !this.closed)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.running++;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }

  /** Why a value cannot be uploaded right now without trying, if it cannot. */
  refusal(): FallbackReason | undefined {
    if (this.closed) return "failed";
    if (this.unsupported()) return "unsupported";
    if (Date.now() < this.pausedUntil) return "failed";
    return undefined;
  }

  private pause(): void {
    this.pausedUntil = Date.now() + FAILURE_PAUSE_MILLIS;
  }

  /**
   * Stores `value` under `key` of the trace: reserved, uploaded unless Hue already holds it, and
   * completed. Only a fresh upload takes a {@link limit} slot: another reference to bytes the
   * trace is already storing shares that upload's outcome without one, so repeated files never
   * hold the slots new files need. The caller must not hold a slot.
   */
  async store(
    traceId: string,
    key: string,
    value: string | Uint8Array | ByteSource,
    contentType: string,
    digest: FileDigest,
    upload: UploadContext,
  ): Promise<Outcome> {
    // Every occurrence is validated even when a previous occurrence already uploaded the bytes.
    if (
      !isBlobKey(key) ||
      !isBlobContentType(contentType) ||
      !/^[0-9a-f]{32}$/.test(traceId) ||
      /^0+$/.test(traceId) ||
      !/^[0-9a-f]{64}$/.test(digest.sha256) ||
      !Number.isSafeInteger(digest.size) ||
      digest.size <= 0 ||
      digest.size !== sizeOf(value)
    )
      return { ok: false, reason: "failed" };
    if (digest.size > MAX_BLOB_BYTES) return { ok: false, reason: "tooLarge" };
    const identity = `${traceId}:${digest.sha256}`;
    for (let known = this.outcomes.get(identity); known; known = this.outcomes.get(identity)) {
      const shared = await known.promise;
      // Another reference's file changed since it was recorded: this one tries its own bytes.
      if (shared.ok || !shared.changed) return shared;
    }
    if (this.outcomes.size >= 4096) {
      const oldest = [...this.outcomes].find(([, item]) => item.settled)?.[0];
      if (oldest === undefined) return { ok: false, reason: "budget" };
      this.outcomes.delete(oldest);
    }
    const item = {
      promise: Promise.resolve<Outcome>({ ok: false, reason: "failed" }),
      settled: false,
    };
    this.outcomes.set(identity, item);
    item.promise = this.limit(() =>
      this.storeFresh(traceId, key, value, contentType, digest, upload),
    )
      .catch((): Outcome => ({ ok: false, reason: "failed" }))
      .then((outcome) => {
        item.settled = true;
        if (!outcome.ok && this.outcomes.get(identity) === item) this.outcomes.delete(identity);
        return outcome;
      });
    return item.promise;
  }

  private async storeFresh(
    traceId: string,
    key: string,
    value: string | Uint8Array | ByteSource,
    contentType: string,
    digest: FileDigest,
    upload: UploadContext,
  ): Promise<Outcome> {
    const refused = this.refusal();
    if (refused) return { ok: false, reason: refused };
    if (digest.size > MAX_BLOB_BYTES) return { ok: false, reason: "tooLarge" };
    if (
      !isBlobKey(key) ||
      !isBlobContentType(contentType) ||
      !/^[0-9a-f]{32}$/.test(traceId) ||
      /^0+$/.test(traceId)
    )
      return { ok: false, reason: "failed" };
    const body = JSON.stringify({
      traceId,
      sha256: digest.sha256,
      byteSize: digest.size,
      contentType,
      key,
    });
    let reservation = await this.reserve(body, digest.size, upload);
    let presigns = 1;
    let attempts = 0;
    while (!("fallback" in reservation) && !reservation.exists) {
      const { grant } = reservation;
      const put = await this.put(grant, value, digest.size, upload.deadline);
      if (put === "stored") break;
      if (put === "changed") return { ok: false, reason: "failed", changed: true };
      if (this.closed) return { ok: false, reason: "failed" };
      const expired = put === "expired" || Date.now() >= grant.expiresAt;
      if (
        put === "transient" &&
        ++attempts < 2 &&
        Date.now() + RETRY_DELAY_MILLIS < upload.deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MILLIS));
        if (Date.now() < grant.expiresAt) continue;
      } else if (put === "transient") {
        this.pause();
        return { ok: false, reason: "failed" };
      } else if (!expired) return { ok: false, reason: "failed" };
      // The URL expired: reserved again once.
      if (presigns++ >= 2) return { ok: false, reason: "failed" };
      reservation = await this.reserve(body, digest.size, upload);
    }
    if ("fallback" in reservation) return { ok: false, reason: reservation.fallback };
    if (!reservation.exists) {
      // For Hue's accounting only: a value is read whether or not it was completed, so a failed
      // completion is not retried.
      const completion = await this.request(
        "POST",
        new URL("/api/v1/otlp/blobs/complete", this.options.baseUrl),
        this.jsonHeaders(),
        JSON.stringify({ traceId, sha256: digest.sha256 }),
        Math.min(upload.deadline, Date.now() + this.options.timeoutMillis),
        MAX_JSON_RESPONSE_BYTES,
      );
      if (!completion || completion.status >= 500 || completion.status === 429) this.pause();
    }
    return { ok: true, contentType: reservation.contentType };
  }

  private jsonHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": this.options.userAgent,
    };
  }

  /** Reserves the value: Hue answers that it holds it already, or a presigned PUT. A rate limit
   * is waited out within the export's hold, a transient refusal retried once. */
  private async reserve(body: string, size: number, upload: UploadContext): Promise<Reservation> {
    const url = new URL("/api/v1/otlp/blobs", this.options.baseUrl);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.closed) return { fallback: "failed" };
      const reply = await this.request(
        "POST",
        url,
        this.jsonHeaders(),
        body,
        Math.min(upload.deadline, Date.now() + this.options.timeoutMillis),
        MAX_JSON_RESPONSE_BYTES,
      );
      if (!reply) {
        if (attempt === 0 && (await this.delay(RETRY_DELAY_MILLIS, upload))) continue;
        this.pause();
        return { fallback: "failed" };
      }
      const { status } = reply;
      const answer =
        status === 200 || status === 404 || status === 409 ? parseJson(reply.body) : undefined;
      // A receiver without the route answers its framework's not-found (Hue's own 404, an
      // archived project, is JSON with an `error`), refuses the method, or answers something
      // that is no reservation at all: it is not asked again for a while.
      if (
        status === 405 ||
        status === 501 ||
        (status === 404 && !(isObject(answer) && typeof answer.error === "string")) ||
        (status === 200 &&
          !(isObject(answer) && (answer.status === "exists" || answer.status === "upload")))
      ) {
        this.unsupportedUntil = Date.now() + UNSUPPORTED_PAUSE_MILLIS;
        return { fallback: "unsupported" };
      }
      if (status === 200) {
        const reservation = this.reservation(answer, size);
        // A reservation that cannot be used would fail every value alike.
        if ("fallback" in reservation) this.pause();
        return reservation;
      }
      if (status === 409 && isObject(answer) && answer.status === "exists")
        return this.reservation(answer, size);
      if (status === 413) return { fallback: "tooLarge" };
      if (status === 429) {
        const wait = retryAfterMillis(reply.headers) ?? RETRY_DELAY_MILLIS;
        if (Date.now() + wait < upload.deadline && (await upload.wait(wait))) continue;
        this.pause();
        return { fallback: "failed" };
      }
      if (status >= 500) {
        const wait = retryAfterMillis(reply.headers) ?? RETRY_DELAY_MILLIS;
        if (attempt === 0 && wait <= MAX_TRANSIENT_WAIT_MILLIS && (await this.delay(wait, upload)))
          continue;
        this.pause();
        return { fallback: "failed" };
      }
      // Bad values and conflicts refuse only this value. Transient service failures pause uploads.
      if (status !== 400 && status !== 409) this.pause();
      return { fallback: "failed" };
    }
    this.pause();
    return { fallback: "failed" };
  }

  private async delay(millis: number, upload: UploadContext): Promise<boolean> {
    if (Date.now() + millis >= upload.deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, millis));
    return !this.closed;
  }

  /** A 200 answer read: `exists`, or an upload whose URL and headers are usable as given. */
  private reservation(answer: unknown, size: number): Reservation {
    if (!isObject(answer)) return { fallback: "failed" };
    const ref = isObject(answer.ref) ? answer.ref : {};
    const contentType = isBlobContentType(ref.content_type) ? ref.content_type : undefined;
    if (answer.status === "exists" && contentType) return { exists: true, contentType };
    if (
      answer.status !== "upload" ||
      answer.method !== "PUT" ||
      typeof answer.url !== "string" ||
      !isObject(answer.headers) ||
      !contentType
    )
      return { fallback: "failed" };
    let url: URL;
    try {
      url = new URL(answer.url);
    } catch {
      return { fallback: "failed" };
    }
    // The bytes go only where TLS protects them, or to a loopback development store.
    const secure =
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        (isLoopbackHost(url.hostname) || this.options.allowInsecureHttp));
    if (!secure || url.username || url.password) return { fallback: "failed" };
    const headers: Record<string, string> = {};
    const entries = Object.entries(answer.headers);
    if (entries.length > 32) return { fallback: "failed" };
    for (const [name, value] of entries) {
      if (typeof value !== "string" || !HEADER_NAME.test(name) || !HEADER_VALUE.test(value))
        return { fallback: "failed" };
      // Hue's credentials never travel to the store; the signature is in the URL.
      if (name.toLowerCase() === "authorization") return { fallback: "failed" };
      headers[name] = value;
    }
    const length = Object.entries(headers).find(
      ([name]) => name.toLowerCase() === "content-length",
    );
    if (length && length[1] !== String(size)) return { fallback: "failed" };
    if (!length) headers["Content-Length"] = String(size);
    const expiresAt = typeof answer.expiresAt === "string" ? Date.parse(answer.expiresAt) : NaN;
    return {
      exists: false,
      contentType,
      grant: { url, headers, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Infinity },
    };
  }

  /** The PUT of the value's bytes, with exactly the headers Hue signed. A source that no longer
   * holds its bytes (a file changed since it was recorded) ends the request before its body is
   * complete, and fails the value without a retry. */
  private async put(
    grant: Grant,
    value: string | Uint8Array | ByteSource,
    size: number,
    deadline: number,
  ): Promise<"stored" | "expired" | "transient" | "failed" | "changed"> {
    const reply = await this.request(
      "PUT",
      grant.url,
      grant.headers,
      value,
      deadline,
      MAX_ERROR_RESPONSE_BYTES,
      size,
    );
    if (isByteSource(value) && value.changed) return "changed";
    if (!reply) return "transient";
    // 412: the object exists already (another upload of the same value won). A success answered
    // before the whole body was written stores nothing that was sent.
    if (reply.status === 412) return "stored";
    if (reply.status >= 200 && reply.status < 300) return reply.complete ? "stored" : "failed";
    if (reply.status === 403)
      return reply.body.toString("utf8").includes("Request has expired") ? "expired" : "failed";
    if (reply.status >= 500 || reply.status === 408 || reply.status === 429) return "transient";
    return "failed";
  }

  /**
   * One HTTP request with a deadline and an idle timeout, never following a redirect, its
   * response body bounded. Undefined for a network error, a timeout or a closed uploader. A text
   * or byte body larger than one slice is written a slice at a time with backpressure; `length`
   * is then its byte size.
   */
  private async request(
    method: "POST" | "PUT",
    url: URL,
    headers: Record<string, string>,
    body: string | Uint8Array | ByteSource,
    deadline: number,
    maxResponseBytes: number,
    length?: number,
  ): Promise<Reply | undefined> {
    if (this.closed || deadline <= Date.now()) return undefined;
    let http: typeof import("node:http");
    try {
      // Loaded on first use, as the OTLP transport loads it, after the application's own http
      // instrumentation could patch it. Each specifier is a literal, so the package's import
      // boundary can be checked.
      http = (
        url.protocol === "https:" ? await import("node:https") : await import("node:http")
      ) as never;
    } catch {
      return undefined;
    }
    if (this.closed) return undefined;
    return new Promise<Reply | undefined>((resolve) => {
      let settled = false;
      // Whether the whole body was handed to the request.
      let ended = false;
      let request: ClientRequest | undefined;
      const finish = (reply?: Reply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (request) {
          this.requests.delete(request);
          // An answer before the whole body was handed over ends the request: a store that
          // neither reads nor closes would otherwise hold it, and its source, open.
          if (!reply || !ended) request.destroy();
        }
        resolve(reply);
      };
      const timer = setTimeout(() => finish(), Math.max(1, deadline - Date.now()));
      // The bytes handed to the request: its body is complete once they are its length.
      let sentBytes = 0;
      const written = () => length === undefined || sentBytes === length;
      const requestHeaders: Record<string, string | number> = { ...headers };
      if (length === undefined) requestHeaders["Content-Length"] = sizeOf(body);
      try {
        // Uploads are the SDK's own export traffic: an http instrumentation must not trace them.
        request = context.with(suppressTracing(context.active()), () =>
          http.request(
            url,
            { method, headers: requestHeaders, agent: false },
            (response: IncomingMessage) => {
              const chunks: Buffer[] = [];
              let size = 0;
              const reply = () => ({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body: Buffer.concat(chunks),
                complete: written(),
              });
              response.on("data", (chunk: Buffer) => {
                size += chunk.byteLength;
                if (size <= maxResponseBytes) {
                  chunks.push(chunk);
                  return;
                }
                // Hue's answers and the store's errors are small: what follows is not read.
                finish(reply());
                response.destroy();
              });
              response.on("end", () => finish(reply()));
              response.on("error", () => finish());
            },
          ),
        );
      } catch {
        finish();
        return;
      }
      const sent = request;
      this.requests.add(sent);
      sent.on("error", () => finish());
      sent.setTimeout(this.options.timeoutMillis, () => finish());
      void (async () => {
        if (length === undefined && !isByteSource(body)) {
          ended = true;
          sent.end(body);
          return;
        }
        // A source or a text may reuse a slice's memory for the next: each slice is written out
        // before the next is read. Bytes are views of memory that does not change.
        const reused = !(body instanceof Uint8Array);
        for await (const chunk of uploadChunks(body)) {
          if (settled) return;
          sentBytes += chunk.byteLength;
          await new Promise<void>((proceed) => {
            const done = () => {
              sent.off("drain", done);
              sent.off("close", done);
              proceed();
            };
            sent.on("close", done);
            if (reused) {
              sent.write(chunk, () => done());
              return;
            }
            if (sent.write(chunk)) done();
            else sent.on("drain", done);
          });
          if (settled) return;
        }
        if (settled) return;
        ended = true;
        sent.end();
      })().catch(() => finish());
    });
  }
}

/** Where one export's values are uploaded, and what it learned of them. */
export interface OffloadOptions {
  uploader: BlobUploader;
  traceId: string;
  /** The receiver's inline value limit. */
  valueBytes: number;
  upload: UploadContext;
  tally: OffloadTally;
  memo?: MediaDigestMemo;
  /** For tests: the length past which a long string is read in place (`LONG_STRING_UNITS`). */
  longUnits?: number;
}

/**
 * A span's own attributes with each candidate placed: binary media becomes a digest, while
 * text media over 64 KiB retains a 16 KiB prefix after upload or a digest on failure.
 * A value still over the inline limit is uploaded and replaced by its first
 * 16 KiB (or cut to the limit), each upload listed under `hue.blobs`, each whole value cut or
 * uploaded listed under `hue.truncated`. Every fallback is counted in the tally.
 */
export async function offloadAttributes(
  attributes: Record<string, unknown>,
  collector: OffloadCollector,
  options: OffloadOptions,
): Promise<Record<string, unknown>> {
  return (await offloadRecord(attributes, collector, options)).attributes;
}

/**
 * A record's own attributes, and a log record's body, with each candidate placed (see
 * {@link offloadAttributes}). A file is uploaded and placed in its digest form (a text file in a
 * provider part keeps a 16 KiB prefix), its `hue.blobs` entry keyed `<attribute>#<pointer>` or, in
 * a log record's body, `body#<pointer>`. A file that is not uploaded keeps its bytes inline, except
 * in a span's own recorded messages, where it keeps its digest as before. A log record's values
 * over the inline limit are cut, never uploaded whole, and a body still over it is replaced by the
 * receiver's marker, as before.
 */
export async function offloadRecord(
  attributes: Record<string, unknown>,
  collector: OffloadCollector,
  options: OffloadOptions,
): Promise<{ attributes: Record<string, unknown>; body?: unknown }> {
  const { uploader, traceId, valueBytes, upload, tally } = options;
  const result: Record<string, unknown> = { ...attributes };
  const existing = Array.isArray(attributes[BLOBS_KEY])
    ? (attributes[BLOBS_KEY] as unknown[]).filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  let slots = MAX_BLOB_ENTRIES - existing.length;
  // Places are taken in candidate order, synchronously, so entries are listed in that order
  // whatever order the uploads finish in.
  const entries: { order: number[]; entry: string }[] = [];
  const listed: { order: number; key: string }[] = [];
  const fallback = (reason: FallbackReason) => countFallback(tally, reason, traceId);
  // A value the queue cut when it was admitted was never held whole to upload.
  for (let index = 0; index < collector.cut.length; index++)
    fallback(uploader.unsupported() ? "unsupported" : "budget");
  let inspected = 0;

  /** Uploads each file of a value and places it; whether any was placed. A file that is not
   * uploaded keeps its bytes inline, except in a recorded message: a span's own message keeps its
   * digest, and a log record's keeps the digest of a file over the inline limit, as nested
   * messages kept them before log records uploaded. */
  const placeFiles = async (
    index: number,
    key: string,
    files: readonly InlineFilePart[],
    long?: ReadonlyMap<string, LongText>,
  ): Promise<boolean> => {
    const message = isMessageKey(key);
    let changed = false;
    await Promise.all(
      files.map((file, position) => {
        // A file whose content is a long string is read from its place in the recorded text, a
        // slice at a time: never decoded or copied whole.
        const inPlace = long?.get(file.content);
        const decoded = inPlace ? longFileBytes(file, inPlace) : mediaBytes(file);
        const bytes = "source" in decoded ? decoded.source : decoded.bytes;
        const size = sizeOf(bytes);
        if (!placeable(file, decoded, size)) return Promise.resolve();
        const contentType = mediaContentType(file, decoded);
        const textual = isTextMediaType(contentType);
        if (textual && size <= INLINE_FILE_LIMIT) return Promise.resolve();
        const prefix = keepsPrefix(file, textual, decoded);
        const partKey = `${key}#${prefix ? file.pointer : file.partPointer}`;
        const slot = slots > 0 && isBlobKey(partKey) ? (slots--, true) : false;
        return (async () => {
          // Hashing a long file takes an upload place, as hashing a large value does; one the
          // export's upload budget cannot hash stays as recorded and is not uploaded.
          let digest: FileDigest;
          try {
            digest = isByteSource(bytes)
              ? await uploader.limit(() => digestOf(bytes, upload.deadline))
              : options.memo
                ? options.memo.digest(file, decoded as InlineFileBytes, traceId)
                : await digestOf(bytes);
          } catch {
            fallback("failed");
            return;
          }
          const outcome: Outcome = slot
            ? await uploader.store(traceId, partKey, bytes, contentType, digest, upload)
            : { ok: false, reason: "budget" };
          if (outcome.ok) {
            if (prefix)
              prefixPart(
                file,
                blobPrefix(inPlace ? longHead(inPlace, BLOB_PREFIX_BYTES + 1) : file.content),
              );
            else digestPart(file, digest);
            changed = true;
            entries.push({
              order: [index, position],
              entry: blobEntry(partKey, digest.sha256, digest.size, outcome.contentType, file.name),
            });
            tally.uploaded++;
          } else {
            if (message && (!collector.log || size > INLINE_FILE_LIMIT)) {
              digestPart(file, digest);
              changed = true;
            }
            fallback(outcome.reason);
          }
        })();
      }),
    );
    return changed;
  };

  const literal = literalKeys(attributes);
  const parts = async (index: number, key: string, text: string): Promise<string | JoinedText> => {
    // Literal text holds no file.
    if (!mayInlineFiles(key, text) || literal.has(key)) return text;
    let media: ReturnType<typeof readMediaText>;
    let large: LargeMediaValue | undefined;
    if (collector.large?.has(key)) {
      // Held whole past the inspection bounds: its long strings were read in place, the JSON
      // around them within the per-attribute bound.
      media = large = largeReads.get(index);
    } else {
      // Both bounds count UTF-16 code units, as admission does.
      if (text.length > MAX_INLINE_FILE_TEXT) return text;
      if (collector.inspected) {
        // A value admission skipped stays as recorded.
        if (!collector.inspected.has(key)) return text;
      } else {
        if (inspected + text.length > INLINE_FILE_TEXT_PER_RECORD) return text;
        inspected += text.length;
      }
      try {
        media = readMediaText(key, text);
      } catch {
        return text;
      }
    }
    if (!media?.files.length) return text;
    if (!(await placeFiles(index, key, media.files, large?.long))) return text;
    return large ? await placedLargeText(large) : placedMediaText(media);
  };
  // The values read in place are scanned first, in candidate order, between turns of the event
  // loop: places in `hue.blobs` are then taken in candidate order, as for any value.
  const largeReads = new Map<number, LargeMediaValue | undefined>();
  for (const [index, { key, value }] of collector.candidates.entries()) {
    if (
      typeof value !== "string" ||
      !collector.large?.has(key) ||
      !mayInlineFiles(key, value) ||
      literal.has(key)
    )
      continue;
    try {
      largeReads.set(index, await readLargeMediaText(key, value, options.longUnits));
    } catch {
      // JSON that does not parse holds no file: the value stays as recorded.
    }
  }

  /** A log record's body with its files placed. Each file's content counts toward the record's
   * inspection bounds, as an attribute's text does. */
  const placeBody = async (body: unknown): Promise<unknown> => {
    let media: ReturnType<typeof mediaIn>;
    try {
      media = mediaIn(body);
    } catch {
      return body;
    }
    const files = media.files.filter((file) => {
      // A string the queue cut holds only the start of its file: it stays as cut.
      if (collector.bodyCut?.has(file.content)) return false;
      const units = file.content.length;
      if (units > MAX_INLINE_FILE_TEXT || inspected + units > INLINE_FILE_TEXT_PER_RECORD)
        return false;
      inspected += units;
      return true;
    });
    if (await placeFiles(-1, "body", files)) reencodeMedia(media);
    return media.box.value;
  };

  const place = async (index: number, { key, value }: OffloadCandidate): Promise<void> => {
    const read = typeof value === "string" ? await parts(index, key, value) : value;
    // Text joined from pieces of the recorded text is made one string only when it is kept
    // inline; otherwise it is measured, hashed, uploaded and cut from its pieces.
    const joined = read instanceof JoinedText ? read : undefined;
    const size = joined ? joined.utf8Size() : sizeOf(read as string | Uint8Array);
    if (size <= valueBytes) {
      result[key] = joined ? joined.text() : read;
      return;
    }
    const placed = joined ? joined.source(size) : (read as string | Uint8Array);
    listed.push({ order: index, key });
    const cut = () =>
      joined
        ? truncateUtf8(joined.head(valueBytes + 1), valueBytes)
        : typeof placed === "string"
          ? truncateUtf8(placed, valueBytes)
          : truncatedMarker(size);
    // A log record's value is cut, as no log reader pages an uploaded text value.
    if (collector.log) {
      result[key] = cut();
      return;
    }
    if (slots <= 0) {
      result[key] = cut();
      fallback("budget");
      return;
    }
    slots--;
    const stored = await (async () => {
      if (size > MAX_BLOB_BYTES) return { ok: false as const, reason: "tooLarge" as const };
      // Hashing a large value takes a slot as its upload does; the upload takes its own.
      let digest: FileDigest;
      try {
        digest = await uploader.limit(() => digestOf(placed, upload.deadline));
      } catch {
        return { ok: false as const, reason: "failed" as const };
      }
      const contentType = joined
        ? textContentType(joined.head(256) + joined.tail(256))
        : typeof placed === "string"
          ? textContentType(placed)
          : "application/octet-stream";
      const outcome = await uploader.store(traceId, key, placed, contentType, digest, upload);
      return outcome.ok ? { ...outcome, digest } : outcome;
    })();
    if (stored.ok) {
      result[key] = joined
        ? blobPrefix(joined.head(BLOB_PREFIX_BYTES + 1))
        : typeof placed === "string"
          ? blobPrefix(placed)
          : blobPrefix(placed as Uint8Array);
      entries.push({
        order: [index, Infinity],
        entry: blobEntry(key, stored.digest.sha256, stored.digest.size, stored.contentType),
      });
      tally.uploaded++;
    } else {
      result[key] = cut();
      fallback(stored.reason);
    }
  };

  const body = collector.body ? placeBody(collector.body.value) : undefined;
  await Promise.all(collector.candidates.map((candidate, index) => place(index, candidate)));
  await Promise.all(
    (collector.attachments ?? []).map((file, position) => {
      if (!sizeOf(file.bytes)) return Promise.resolve();
      const slot = slots > 0 ? (slots--, true) : false;
      return (async () => {
        const key = mediaKey(file);
        const outcome: Outcome = slot
          ? await uploader.store(traceId, key, file.bytes, file.contentType, file.digest, upload)
          : { ok: false, reason: "budget" };
        if (outcome.ok) {
          entries.push({
            order: [collector.candidates.length, position],
            entry: blobEntry(
              key,
              file.digest.sha256,
              file.digest.size,
              outcome.contentType,
              file.name,
            ),
          });
          tally.uploaded++;
        } else fallback(outcome.reason);
      })();
    }),
  );
  let placedBody: unknown;
  if (body) {
    const capped = capLogBody(await body, valueBytes);
    placedBody = capped.body;
    if (capped.cut) listed.push({ order: -1, key: "body" });
  }
  if (listed.length)
    result[TRUNCATED_KEY] = withTruncatedKeys(
      result[TRUNCATED_KEY],
      listed.sort((a, b) => a.order - b.order).map(({ key }) => key),
    );
  if (entries.length) {
    entries.sort((a, b) => a.order[0]! - b.order[0]! || a.order[1]! - b.order[1]!);
    result[BLOBS_KEY] = [...existing, ...entries.map(({ entry }) => entry)];
  }
  return { attributes: result, ...(collector.body ? { body: placedBody } : {}) };
}

/**
 * The span's own attributes with every candidate placed as it was before uploads existed, for an
 * upload step that failed unexpectedly: a message's large inline files as their digest, a value
 * over the inline limit cut to it (bytes replaced by the receiver's marker) and listed under
 * `hue.truncated`.
 */
export function fallbackAttributes(
  attributes: Record<string, unknown>,
  collector: OffloadCollector,
  valueBytes: number,
  tally: OffloadTally,
  traceId: string,
  memo?: MediaDigestMemo,
): Record<string, unknown> {
  return fallbackRecord(attributes, collector, valueBytes, tally, traceId, memo).attributes;
}

/** A record's attributes, and a log record's body, placed as {@link fallbackAttributes} places
 * them: a log record's files keep their bytes inline, and its body over the inline limit is
 * replaced by the receiver's marker, as before. */
export function fallbackRecord(
  attributes: Record<string, unknown>,
  collector: OffloadCollector,
  valueBytes: number,
  tally: OffloadTally,
  traceId: string,
  memo?: MediaDigestMemo,
): { attributes: Record<string, unknown>; body?: unknown } {
  const result: Record<string, unknown> = { ...attributes };
  const listed: string[] = [];
  let body: unknown;
  if (collector.body) {
    const capped = capLogBody(collector.body.value, valueBytes);
    body = capped.body;
    if (capped.cut) listed.push("body");
  }
  for (const _file of collector.attachments ?? []) countFallback(tally, "failed", traceId);
  for (let index = 0; index < collector.cut.length; index++)
    countFallback(tally, "failed", traceId);
  for (const { key, value } of collector.candidates) {
    let placed: unknown = value;
    // Each large inline file is reported as a value not uploaded, as the upload step reports it.
    const count = { files: 0 };
    try {
      // A log record's files stay inline, its messages' files over the inline limit as their
      // digest, as nested messages kept them before log records uploaded.
      if (collector.log) placed = hashNestedInlineFiles(key, value, count);
      else if (!collector.inspected || collector.inspected.has(key))
        placed = hashInlineFiles(key, value, count, memo, traceId);
    } catch {
      // Left as it is: cut below when over the limit.
    }
    for (let file = 0; file < count.files; file++) countFallback(tally, "failed", traceId);
    // A log record's value over the limit is cut whether or not uploads work.
    if (typeof placed === "string") {
      if (Buffer.byteLength(placed, "utf8") > valueBytes) {
        placed = truncateUtf8(placed, valueBytes);
        listed.push(key);
        if (!collector.log) countFallback(tally, "failed", traceId);
      }
    } else if (placed instanceof Uint8Array && placed.byteLength > valueBytes) {
      placed = truncatedMarker(placed.byteLength);
      listed.push(key);
      if (!collector.log) countFallback(tally, "failed", traceId);
    }
    result[key] = placed;
  }
  if (listed.length) result[TRUNCATED_KEY] = withTruncatedKeys(result[TRUNCATED_KEY], listed);
  return { attributes: result, ...(collector.body ? { body } : {}) };
}
