import { createHash } from "node:crypto";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { isLoopbackHost } from "./config.js";
import {
  digestPart,
  hashInlineFiles,
  INLINE_FILE_LIMIT,
  INLINE_FILE_TEXT_PER_RECORD,
  inlineFileBytes,
  isMessageKey,
  largeInlineFileParts,
  MAX_INLINE_FILE_TEXT,
  type InlineFileBytes,
} from "./inline-files.js";
import { TRUNCATED_KEY, truncatedMarker, withTruncatedKeys } from "./privacy.js";
import { truncateUtf8 } from "./safety.js";

/**
 * Values larger than Hue's inline limit travel apart from their span: the SDK uploads the value's
 * bytes straight to the project's evidence store through a presigned PUT that Hue answers at
 * `POST /api/v1/otlp/blobs`, keeps the value's first 16 KiB in the attribute it replaced, and
 * lists the value in the span attribute `hue.blobs`. A value that cannot be uploaded is exported
 * as it was before uploads existed: cut to the inline limit and listed under `hue.truncated` (an
 * inline file as its digest), reported as a warning and counted.
 */

/** The span attribute listing the values the SDK uploaded apart from the span: one compact JSON
 * object per value, `{"key", "sha256", "size", "content_type"}`, as Hue reads it. */
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

/** Why a value over the inline limit was exported cut instead of uploaded. */
export type FallbackReason = "unsupported" | "failed" | "tooLarge" | "budget";

/** The fixed description of each fallback, as an export issue reports it. */
export const FALLBACK_MESSAGES: Record<FallbackReason, string> = {
  unsupported:
    "This Hue server does not accept uploaded values; values over its inline limit were exported cut to it (inline files as their digest)",
  failed:
    "Values over Hue's inline limit could not be uploaded; they were exported cut to it (inline files as their digest)",
  tooLarge: "Values over Hue's 1 GB upload limit were exported cut to the inline limit",
  budget:
    "Values over Hue's inline limit did not fit the SDK's upload budget; they were exported cut to it (inline files as their digest)",
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
}

/** The outcome of one export's uploads, reported once the export's records are placed. */
export interface OffloadTally {
  uploaded: number;
  fallbacks: Map<FallbackReason, { count: number; traceIds: Set<string> }>;
}

export function newTally(): OffloadTally {
  return { uploaded: 0, fallbacks: new Map() };
}

function countFallback(tally: OffloadTally, reason: FallbackReason, traceId: string): void {
  const entry = tally.fallbacks.get(reason) ?? { count: 0, traceIds: new Set<string>() };
  entry.count++;
  entry.traceIds.add(traceId);
  tally.fallbacks.set(reason, entry);
}

/** A media type Hue accepts for a value: `type/subtype` with optional parameters, 3 to 255
 * printable ASCII characters. */
const CONTENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9!#$&^_.+-]+(?: *;[ -~]*)?$/;

export function isBlobContentType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 255 &&
    CONTENT_TYPE.test(value)
  );
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

/** The media type an inline file is stored under: the part's own (`mime_type`, `mediaType`), its
 * `data:` URL's, or else bytes, or UTF-8 text for content that was not encoded. */
function fileContentType(part: Record<string, unknown>, file: InlineFileBytes): string {
  for (const declared of [part.mime_type, part.mimeType, part.mediaType, part.media_type])
    if (isBlobContentType(declared)) return declared;
  if (isBlobContentType(file.urlMediaType)) return file.urlMediaType;
  return file.decoded ? "application/octet-stream" : "text/plain; charset=utf-8";
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
function sizeOf(value: string | Uint8Array): number {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
}

/** A string's UTF-8 encoding a slice at a time, never splitting a surrogate pair. */
function* utf8Chunks(text: string): Generator<Buffer> {
  for (let start = 0; start < text.length; ) {
    let end = Math.min(text.length, start + TEXT_CHUNK_UNITS);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    yield Buffer.from(text.slice(start, end), "utf8");
    start = end;
  }
}

/** The bytes an upload carries, a slice at a time: no second copy of a large value is made. */
function* uploadChunks(value: string | Uint8Array): Generator<Uint8Array> {
  if (typeof value === "string") {
    yield* utf8Chunks(value);
    return;
  }
  for (let start = 0; start < value.byteLength; start += TEXT_CHUNK_UNITS)
    yield value.subarray(start, Math.min(value.byteLength, start + TEXT_CHUNK_UNITS));
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The SHA-256 (lowercase hex) and byte size of what an upload of `value` carries, yielding to
 * the event loop between slices so a large value does not stall the application. */
export async function digestOf(
  value: string | Uint8Array,
): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  let slices = 0;
  for (const chunk of uploadChunks(value)) {
    hash.update(chunk);
    size += chunk.byteLength;
    if (++slices % 4 === 0) await nextTurn();
  }
  return { sha256: hash.digest("hex"), size };
}

/** The `hue.blobs` element for one uploaded value. */
function blobEntry(key: string, sha256: string, size: number, contentType: string): string {
  return JSON.stringify({ key, sha256, size, content_type: contentType });
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

type Outcome = { ok: true; contentType: string } | { ok: false; reason: FallbackReason };

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
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
   * completed. The caller holds a {@link limit} slot.
   */
  async store(
    traceId: string,
    key: string,
    value: string | Uint8Array,
    contentType: string,
    digest: { sha256: string; size: number },
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
    if (!reservation.exists)
      // For Hue's accounting only: a value is read whether or not it was completed, so a failed
      // completion is not retried.
      await this.request(
        "POST",
        new URL("/api/v1/otlp/blobs/complete", this.options.baseUrl),
        this.jsonHeaders(),
        JSON.stringify({ traceId, sha256: digest.sha256 }),
        Math.min(upload.deadline, Date.now() + this.options.timeoutMillis),
        MAX_JSON_RESPONSE_BYTES,
      );
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
      const answer = status === 200 || status === 404 ? parseJson(reply.body) : undefined;
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
      if (status === 413) return { fallback: "tooLarge" };
      if (status === 429) {
        const wait = retryAfterMillis(reply.headers) ?? RETRY_DELAY_MILLIS;
        if (Date.now() + wait < upload.deadline && (await upload.wait(wait))) continue;
        return { fallback: "failed" };
      }
      if (status >= 500) {
        const wait = retryAfterMillis(reply.headers) ?? RETRY_DELAY_MILLIS;
        if (attempt === 0 && wait <= MAX_TRANSIENT_WAIT_MILLIS && (await this.delay(wait, upload)))
          continue;
        this.pause();
        return { fallback: "failed" };
      }
      // A conflict over this value alone (409) fails only it. Any other refusal (a refused key,
      // an archived project, a request Hue could not read, a redirect) would meet every value
      // alike, so uploads pause; the export's own requests report a key problem.
      if (status !== 409) this.pause();
      return { fallback: "failed" };
    }
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

  /** The PUT of the value's bytes, with exactly the headers Hue signed. */
  private async put(
    grant: Grant,
    value: string | Uint8Array,
    size: number,
    deadline: number,
  ): Promise<"stored" | "expired" | "transient" | "failed"> {
    const reply = await this.request(
      "PUT",
      grant.url,
      grant.headers,
      value,
      deadline,
      MAX_ERROR_RESPONSE_BYTES,
      size,
    );
    if (!reply) return "transient";
    // 412: the object exists already (another upload of the same value won).
    if ((reply.status >= 200 && reply.status < 300) || reply.status === 412) return "stored";
    if (reply.status === 403)
      return reply.body.toString("utf8").includes("Request has expired") ? "expired" : "failed";
    if (reply.status >= 500 || reply.status === 408) return "transient";
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
    body: string | Uint8Array,
    deadline: number,
    maxResponseBytes: number,
    length?: number,
  ): Promise<Reply | undefined> {
    if (this.closed || deadline <= Date.now()) return undefined;
    let http: typeof import("node:http");
    try {
      // Loaded on first use, as the OTLP transport loads it, after the application's own http
      // instrumentation could patch it.
      http = (await import(url.protocol === "https:" ? "node:https" : "node:http")) as never;
    } catch {
      return undefined;
    }
    if (this.closed) return undefined;
    return new Promise<Reply | undefined>((resolve) => {
      let settled = false;
      let request: ClientRequest | undefined;
      const finish = (reply?: Reply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (request) {
          this.requests.delete(request);
          if (!reply) request.destroy();
        }
        resolve(reply);
      };
      const timer = setTimeout(() => finish(), Math.max(1, deadline - Date.now()));
      const requestHeaders: Record<string, string | number> = { ...headers };
      if (length === undefined)
        requestHeaders["Content-Length"] =
          typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.byteLength;
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
        if (length === undefined) {
          sent.end(body);
          return;
        }
        for (const chunk of uploadChunks(body)) {
          if (settled) return;
          if (!sent.write(chunk))
            await new Promise<void>((drained) => {
              const done = () => {
                sent.off("drain", done);
                sent.off("close", done);
                drained();
              };
              sent.on("drain", done);
              sent.on("close", done);
            });
        }
        if (!settled) sent.end();
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
}

/**
 * A span's own attributes with each candidate placed: an inline file part over 64 KiB in a
 * recorded message uploaded and replaced by its first 16 KiB (or by its digest, as before, when
 * it could not be), and a value still over the inline limit uploaded and replaced by its first
 * 16 KiB (or cut to the limit), each upload listed under `hue.blobs`, each whole value cut or
 * uploaded listed under `hue.truncated`. Every fallback is counted in the tally.
 */
export async function offloadAttributes(
  attributes: Record<string, unknown>,
  collector: OffloadCollector,
  options: OffloadOptions,
): Promise<Record<string, unknown>> {
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

  const parts = async (index: number, key: string, text: string): Promise<string> => {
    if (
      !isMessageKey(key) ||
      text.length * 3 <= INLINE_FILE_LIMIT ||
      !(text.includes('"blob"') || text.includes('"file"'))
    )
      return text;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes <= INLINE_FILE_LIMIT || bytes > MAX_INLINE_FILE_TEXT) return text;
    if (inspected + text.length > INLINE_FILE_TEXT_PER_RECORD) return text;
    inspected += text.length;
    let parsed: unknown;
    let found: ReturnType<typeof largeInlineFileParts>;
    try {
      parsed = JSON.parse(text);
      found = largeInlineFileParts(parsed);
    } catch {
      return text;
    }
    if (!found.length) return text;
    let changed = false;
    await Promise.all(
      found.map((file, position) => {
        const partKey = `${key}#${file.pointer}`;
        const slot = slots > 0 && isBlobKey(partKey) ? (slots--, true) : false;
        return uploader.limit(async () => {
          const decoded = inlineFileBytes(file.content);
          if (decoded.bytes.byteLength <= INLINE_FILE_LIMIT) {
            if (slot) slots++;
            return;
          }
          changed = true;
          const digest = await digestOf(decoded.bytes);
          const outcome: Outcome = slot
            ? await uploader.store(
                traceId,
                partKey,
                decoded.bytes,
                fileContentType(file.part, decoded),
                digest,
                upload,
              )
            : { ok: false, reason: "budget" };
          if (outcome.ok) {
            file.part[file.key] = blobPrefix(file.content);
            entries.push({
              order: [index, position],
              entry: blobEntry(partKey, digest.sha256, digest.size, outcome.contentType),
            });
            tally.uploaded++;
          } else {
            digestPart(file.part, file.key, digest);
            fallback(outcome.reason);
          }
        });
      }),
    );
    return changed ? JSON.stringify(parsed) : text;
  };

  const place = async (index: number, { key, value }: OffloadCandidate): Promise<void> => {
    const placed = typeof value === "string" ? await parts(index, key, value) : value;
    const size = sizeOf(placed);
    if (size <= valueBytes) {
      result[key] = placed;
      return;
    }
    listed.push({ order: index, key });
    const cut = () =>
      typeof placed === "string" ? truncateUtf8(placed, valueBytes) : truncatedMarker(size);
    if (slots <= 0) {
      result[key] = cut();
      fallback("budget");
      return;
    }
    slots--;
    const stored = await uploader.limit(async () => {
      if (size > MAX_BLOB_BYTES) return { ok: false as const, reason: "tooLarge" as const };
      const refused = uploader.refusal();
      if (refused) return { ok: false as const, reason: refused };
      const digest = await digestOf(placed);
      const contentType =
        typeof placed === "string" ? textContentType(placed) : "application/octet-stream";
      const outcome = await uploader.store(traceId, key, placed, contentType, digest, upload);
      return outcome.ok ? { ...outcome, digest } : outcome;
    });
    if (stored.ok) {
      result[key] = typeof placed === "string" ? blobPrefix(placed) : blobPrefix(placed);
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

  await Promise.all(collector.candidates.map((candidate, index) => place(index, candidate)));
  if (listed.length)
    result[TRUNCATED_KEY] = withTruncatedKeys(
      result[TRUNCATED_KEY],
      listed.sort((a, b) => a.order - b.order).map(({ key }) => key),
    );
  if (entries.length) {
    entries.sort((a, b) => a.order[0]! - b.order[0]! || a.order[1]! - b.order[1]!);
    result[BLOBS_KEY] = [...existing, ...entries.map(({ entry }) => entry)];
  }
  return result;
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
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...attributes };
  const listed: string[] = [];
  for (let index = 0; index < collector.cut.length; index++)
    countFallback(tally, "failed", traceId);
  for (const { key, value } of collector.candidates) {
    let placed: unknown = value;
    try {
      placed = hashInlineFiles(key, value);
    } catch {
      // Left as it is: cut below when over the limit.
    }
    if (typeof placed === "string") {
      if (Buffer.byteLength(placed, "utf8") > valueBytes) {
        placed = truncateUtf8(placed, valueBytes);
        listed.push(key);
        countFallback(tally, "failed", traceId);
      }
    } else if (placed instanceof Uint8Array && placed.byteLength > valueBytes) {
      placed = truncatedMarker(placed.byteLength);
      listed.push(key);
      countFallback(tally, "failed", traceId);
    }
    result[key] = placed;
  }
  if (listed.length) result[TRUNCATED_KEY] = withTruncatedKeys(result[TRUNCATED_KEY], listed);
  return result;
}
