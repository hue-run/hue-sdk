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
  type HeldText,
  type LargeMediaValue,
  type LongText,
} from "./large-media.js";
import { capLogBody, TRUNCATED_KEY, truncatedMarker, withTruncatedKeys } from "./privacy.js";
import { truncateUtf8 } from "./safety.js";

/**
 * Large values and binary media travel apart from their span through reservation, presigned PUT,
 * and completion. Export hashes each value, writes its reference (text keeps a 16 KiB prefix,
 * binary media digest metadata on its part) and its `hue.blobs` entry, and sends the record; the
 * upload runs afterwards in the background, as Langfuse uploads media. A value refused when its
 * record is exported keeps its inline fallback or file metadata; an upload that fails after export
 * leaves its entry, which Hue reads as missing. Both are reported as warnings and counted.
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
 * The values over the inline limit that queued records and unsettled uploads may hold whole at
 * once, charged apart from `maxQueueBytes` (a string as two bytes a code unit, bytes as
 * themselves): each is held until its record is exported and its upload settles. A value the
 * budget cannot hold is cut when it is queued, as before uploads existed; a single value larger
 * than the whole budget is held while nothing else is.
 */
export const MAX_HELD_BLOB_BYTES = 128 * 1024 * 1024;
/** Uploads in flight at once, across both signals' exports. */
const UPLOAD_CONCURRENCY = 4;
/** How long a receiver without the upload route is believed to stay without it: an answer misread
 * as one (a proxy's page during a deploy) turns uploads off for this long, never for good. */
const UNSUPPORTED_PAUSE_MILLIS = 10 * 60_000;
/** Values hashed at once for export, apart from the uploads' places: export never waits for an
 * upload to hash. */
const HASH_CONCURRENCY = 4;
/** Uploads queued and not yet settled; past it a value keeps its fallback. */
const MAX_QUEUED_UPLOADS = 4096;
/** How many times a reservation or a PUT is tried. */
const UPLOAD_ATTEMPTS = 3;
const MAX_JSON_RESPONSE_BYTES = 64 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 4096;
/** Text is encoded to UTF-8 a slice at a time to hash and upload it: no full copy is held. */
const TEXT_CHUNK_UNITS = 1 << 20;
const RETRY_DELAY_MILLIS = 1000;
/** The longest wait before an upload's next attempt, a `Retry-After` included. */
export const MAX_RETRY_AFTER_MILLIS = 60_000;

/** How long one export may spend hashing its values: past it a value keeps its fallback. Also
 * the import's least upload deadline, and part of an upload's lifetime. */
export function uploadBudgetMillis(timeoutMillis: number): number {
  return timeoutMillis * 6;
}

/** How long one upload may take from when its record's export queued it: six export timeouts for
 * its requests and up to a minute of Retry-After of its own. */
export function uploadLifetimeMillis(timeoutMillis: number): number {
  return uploadBudgetMillis(timeoutMillis) + MAX_RETRY_AFTER_MILLIS;
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

/** The fixed description of each failure of an upload that ran after its record was exported:
 * the record lists the value under `hue.blobs`, and Hue reads it as missing. */
export const LATE_FALLBACK_MESSAGES: Record<FallbackReason, string> = {
  unsupported:
    "This Hue server does not accept uploaded values; values exported before it answered list hue.blobs entries that it does not store",
  failed:
    "Content could not be uploaded after its record was exported; its hue.blobs entry names a value Hue does not store",
  tooLarge:
    "Content over its upload limit could not be uploaded after its record was exported; its hue.blobs entry names a value Hue does not store",
  budget:
    "Content did not fit the SDK's upload budget after its record was exported; its hue.blobs entry names a value Hue does not store",
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

/** Adds one tally's outcomes to another's. */
export function mergeTally(into: OffloadTally, from: OffloadTally): void {
  into.uploaded += from.uploaded;
  for (const [reason, { count, traceIds }] of from.fallbacks) {
    const entry = into.fallbacks.get(reason) ?? { count: 0, traceIds: new Set<string>() };
    entry.count += count;
    for (const traceId of traceIds) entry.traceIds.add(traceId);
    into.fallbacks.set(reason, entry);
  }
}

/** Adds `from` to `into` once `settled` all settle. Built apart from the step that queued the
 * uploads, so a pending upload keeps alive the two tallies alone, never that step's record. */
export function mergeWhenSettled(
  into: OffloadTally,
  from: OffloadTally,
  settled: Promise<void>[],
): Promise<void> {
  return Promise.all(settled).then(() => mergeTally(into, from));
}

/** Counts an upload's outcome in `tally` once it settles. Built apart from the placement that
 * queued it, so the upload keeps alive its own bytes alone, never the record placed around it. */
function countWhenSettled(done: Promise<Outcome>, tally: OffloadTally, traceId: string) {
  return done.then((outcome) => {
    if (outcome.ok) tally.uploaded++;
    else countFallback(tally, outcome.reason, traceId);
  });
}

/** The uploads an export queued after placing its records, and what they came to once settled:
 * each record's own are added when its placement returns. */
export interface LateUploads {
  tally: OffloadTally;
  settled: Promise<void>[];
  /** Told of each upload as it is queued: when it settles, how many of the bytes it charges its
   * record holds too (none for bytes decoded or rewritten apart from the record), and when that
   * charge is released. */
  queued?(settled: Promise<void>, shared: number, released: Promise<void>): void;
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

/** The memory a queued upload keeps alive until it settles: a string as two bytes a code unit,
 * bytes as themselves, a source the strings it reads from, each whole. */
function heldBy(value: string | Uint8Array | ByteSource): readonly HeldText[] {
  if (isByteSource(value)) return value.held ?? [];
  return [{ bytes: typeof value === "string" ? value.length * 2 : value.byteLength }];
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

/** What an upload may spend: its deadline, and its wait before another attempt (`wait` resolves
 * false when the wait was ended early or may not be taken). An export's own context bounds its
 * hashing only. */
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

/** Places for work of one kind: a finishing run hands its place to the next one waiting, so none
 * is ever taken twice. */
class Slots {
  private running = 0;
  private waiting: (() => void)[] = [];
  private released = false;

  constructor(private readonly size: number) {}

  /** Runs `work` once fewer than `size` runs are in progress. */
  async run<R>(work: () => Promise<R>): Promise<R> {
    await this.take();
    try {
      return await work();
    } finally {
      this.give();
    }
  }

  /** Runs `work` (a wait) from within a run without its place, and takes a place again after:
   * a run that waits never holds the place another could use. Once `deadline` passes it stops
   * waiting for a place and goes on with one over the size, to end without more work. */
  async away<R>(work: () => Promise<R>, deadline = Infinity): Promise<R> {
    this.give();
    try {
      return await work();
    } finally {
      await this.take(deadline);
    }
  }

  private async take(deadline = Infinity): Promise<void> {
    if (this.running < this.size || this.released) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve) => {
      const start = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer =
        deadline < Infinity
          ? setTimeout(() => {
              const at = this.waiting.indexOf(start);
              if (at >= 0) this.waiting.splice(at, 1);
              this.running++;
              resolve();
            }, deadline - Date.now())
          : undefined;
      this.waiting.push(start);
    });
  }

  private give(): void {
    // A place taken over the size, past a deadline, is given back rather than handed on.
    const next = this.running > this.size ? undefined : this.waiting.shift();
    if (next) next();
    else this.running--;
  }

  /** Starts every waiting run now; none waits again. */
  release(): void {
    this.released = true;
    for (const run of this.waiting.splice(0)) {
      this.running++;
      run();
    }
  }
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
 * presigned URL Hue answers (skipped when Hue already stores the value), and completes it. An
 * export queues its values ({@link enqueue}) and sends its records without waiting for them; the
 * import stores each value before it sends its span ({@link store}). At most
 * {@link UPLOAD_CONCURRENCY} uploads run at once, and {@link HASH_CONCURRENCY} hashes apart from
 * them. A reservation or PUT that gets no answer, a 408, a 429 or a 5xx is tried
 * {@link UPLOAD_ATTEMPTS} times; every request has a deadline and none follows a redirect. A
 * receiver without the route (a 404 without Hue's JSON error, a 405 or 501, or a 200 that is no
 * reservation) is remembered for {@link UNSUPPORTED_PAUSE_MILLIS}: values exported meanwhile keep
 * their fallback, never an entry the receiver cannot resolve.
 */
export class BlobUploader {
  /** Until when the receiver is taken to lack the upload route. */
  private unsupportedUntil = 0;
  private closed = false;
  private uploads = new Slots(UPLOAD_CONCURRENCY);
  private hashes = new Slots(HASH_CONCURRENCY);
  private queued = 0;
  private queuedBytes = 0;
  /** What queued uploads keep alive, each charged once, from the first upload holding it until
   * the last settles: two files read in place from one recorded string charge it once, whole. */
  private holding = new Map<HeldText, { uploads: number; release(): void }>();
  private sleeps = new Set<() => void>();
  private requests = new Set<ClientRequest>();
  private outcomes = new Map<string, { promise: Promise<Outcome>; settled: boolean }>();
  /** The first wait before another attempt, doubled each time; tests shorten it. */
  private retryDelayMillis = RETRY_DELAY_MILLIS;
  /** How long a queued upload may take; tests shorten it. */
  private lifetimeMillis: number;

  constructor(private readonly options: UploaderOptions) {
    this.lifetimeMillis = uploadLifetimeMillis(options.timeoutMillis);
  }

  /** Whether a value over the inline limit is worth holding whole for upload now. */
  available(): boolean {
    return !this.closed && Date.now() >= this.unsupportedUntil;
  }

  /** Whether the receiver lacks the upload route, as it last answered. */
  unsupported(): boolean {
    return Date.now() < this.unsupportedUntil;
  }

  /** Ends uploads in flight, queued uploads and their waits, and refuses new ones: values not
   * yet exported fall back to the inline cut, and uploads queued by exported records fail. */
  close(): void {
    this.closed = true;
    for (const request of this.requests) request.destroy();
    this.requests.clear();
    this.outcomes.clear();
    for (const cancel of [...this.sleeps]) cancel();
    this.uploads.release();
    this.hashes.release();
  }

  /** Runs `work` once fewer than {@link UPLOAD_CONCURRENCY} uploads are in flight. */
  limit<R>(work: () => Promise<R>): Promise<R> {
    return this.uploads.run(work);
  }

  /** The SHA-256 and size of `value` (see {@link digestOf}), hashed in a place of its own: an
   * export never waits for an upload to hash its values. */
  digest(value: string | Uint8Array | ByteSource, deadline: number): Promise<FileDigest> {
    return this.hashes.run(() => digestOf(value, deadline));
  }

  /** The bytes queued uploads keep alive until they settle. */
  pendingBytes(): number {
    return this.queuedBytes;
  }

  /** Why a value cannot be uploaded right now without trying, if it cannot. */
  refusal(): FallbackReason | undefined {
    if (this.closed) return "failed";
    if (this.unsupported()) return "unsupported";
    return undefined;
  }

  /** Why the value cannot be uploaded at all, whatever Hue would answer. */
  private invalid(
    traceId: string,
    key: string,
    value: string | Uint8Array | ByteSource,
    contentType: string,
    digest: FileDigest,
  ): FallbackReason | undefined {
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
      return "failed";
    if (digest.size > MAX_BLOB_BYTES) return "tooLarge";
    return undefined;
  }

  /**
   * Queues `value`'s upload for an exported record, deciding now what the record lists: a value
   * refused without trying (see {@link refusal}), invalid, or past the queue's
   * {@link MAX_QUEUED_UPLOADS} uploads or {@link MAX_HELD_BLOB_BYTES} keeps its fallback. A queued
   * upload runs within {@link uploadLifetimeMillis} of now, holding `value` until it settles;
   * `done` never rejects. `bytes` is what it adds to {@link pendingBytes}: the strings it keeps
   * alive that no other queued upload holds, charged until `released`, once the last upload
   * holding them settles.
   */
  enqueue(
    traceId: string,
    key: string,
    value: string | Uint8Array | ByteSource,
    contentType: string,
    digest: FileDigest,
  ):
    | { ok: false; reason: FallbackReason }
    | { ok: true; done: Promise<Outcome>; bytes: number; released: Promise<void> } {
    const refused = this.refusal() ?? this.invalid(traceId, key, value, contentType, digest);
    if (refused) return { ok: false, reason: refused };
    const held = heldBy(value);
    const fresh = held.filter((text) => !this.holding.has(text));
    const bytes = fresh.reduce((total, text) => total + text.bytes, 0);
    // An upload whose strings are all held already adds no memory, so only the job cap applies.
    if (
      this.queued >= MAX_QUEUED_UPLOADS ||
      (bytes > 0 && this.queuedBytes > 0 && this.queuedBytes + bytes > MAX_HELD_BLOB_BYTES)
    )
      return { ok: false, reason: "budget" };
    this.queued++;
    this.queuedBytes += bytes;
    const released = fresh.map(
      (text) =>
        new Promise<void>((release) => {
          this.holding.set(text, { uploads: 0, release });
        }),
    );
    for (const text of held) this.holding.get(text)!.uploads++;
    const upload: UploadContext = {
      deadline: Date.now() + this.lifetimeMillis,
      wait: (millis) => this.sleep(millis),
    };
    // store() never rejects; the job holds `value` only until it settles.
    const done = this.store(traceId, key, value, contentType, digest, upload).finally(() => {
      this.queued--;
      for (const text of held) {
        const holding = this.holding.get(text)!;
        if (--holding.uploads > 0) continue;
        this.holding.delete(text);
        this.queuedBytes -= text.bytes;
        holding.release();
      }
    });
    return { ok: true, done, bytes, released: Promise.all(released).then(() => {}) };
  }

  /** Waits `millis`; false when {@link close} ended the wait first. The timer keeps the process
   * running, as an export in progress does, within the upload's lifetime. */
  sleep(millis: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (ran: boolean) => {
        clearTimeout(timer);
        this.sleeps.delete(cancel);
        resolve(ran && !this.closed);
      };
      const cancel = () => done(false);
      const timer = setTimeout(() => done(true), millis);
      this.sleeps.add(cancel);
    });
  }

  /** Waits before attempt `attempt + 1`: `Retry-After` when the answer gave one, otherwise a
   * second doubled each attempt with jitter, at most a minute. The upload's place is given up
   * meanwhile, so uploads queued behind it run. False when the wait would pass the upload's
   * deadline, was ended, or no place came free again before the deadline. */
  private async retryWait(
    attempt: number,
    retryAfter: number | undefined,
    upload: UploadContext,
  ): Promise<boolean> {
    const millis = Math.min(
      retryAfter ?? this.retryDelayMillis * (2 ** attempt + Math.random()),
      MAX_RETRY_AFTER_MILLIS,
    );
    if (this.closed || Date.now() + millis >= upload.deadline) return false;
    return (
      (await this.uploads.away(() => upload.wait(millis), upload.deadline)) &&
      !this.closed &&
      Date.now() < upload.deadline
    );
  }

  /**
   * Stores `value` under `key` of the trace: reserved, uploaded unless Hue already holds it, and
   * completed. Only a fresh upload takes a {@link limit} slot: another reference to bytes the
   * trace is already storing shares that upload's outcome without one, so repeated files never
   * hold the slots new files need. The caller must not hold a slot. Never rejects.
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
    const invalid = this.invalid(traceId, key, value, contentType, digest);
    if (invalid) return { ok: false, reason: invalid };
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
    // Queued past its lifetime: not tried. Failed, not budget: the import holds its span back.
    if (Date.now() >= upload.deadline) return { ok: false, reason: "failed" };
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
    for (let attempt = 0; !("fallback" in reservation) && !reservation.exists; ) {
      const { grant } = reservation;
      const put = await this.put(grant, value, digest.size, upload.deadline);
      if (put === "stored") break;
      if (put === "changed") return { ok: false, reason: "failed", changed: true };
      if (this.closed) return { ok: false, reason: "failed" };
      if (typeof put === "object") {
        if (
          ++attempt >= UPLOAD_ATTEMPTS ||
          !(await this.retryWait(attempt - 1, put.retryAfter, upload))
        )
          return { ok: false, reason: "failed" };
        if (Date.now() < grant.expiresAt) continue;
      } else if (put !== "expired" && Date.now() < grant.expiresAt)
        return { ok: false, reason: "failed" };
      // The URL expired: reserved again once.
      if (presigns++ >= 2) return { ok: false, reason: "failed" };
      reservation = await this.reserve(body, digest.size, upload);
    }
    if ("fallback" in reservation) return { ok: false, reason: reservation.fallback };
    if (!reservation.exists)
      // For Hue's accounting only: a value is read whether or not it was completed, and Hue
      // stamps a missed completion on the next reservation, so its outcome is not read.
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

  /** Reserves the value: Hue answers that it holds it already, or a presigned PUT. No answer, a
   * 408, a 429 or a 5xx other than 501 is tried again, after its `Retry-After` when it gave one,
   * within the upload's deadline. */
  private async reserve(body: string, size: number, upload: UploadContext): Promise<Reservation> {
    const url = new URL("/api/v1/otlp/blobs", this.options.baseUrl);
    for (let attempt = 0; ; attempt++) {
      if (this.closed) return { fallback: "failed" };
      const reply = await this.request(
        "POST",
        url,
        this.jsonHeaders(),
        body,
        Math.min(upload.deadline, Date.now() + this.options.timeoutMillis),
        MAX_JSON_RESPONSE_BYTES,
      );
      let retryAfter: number | undefined;
      if (reply) {
        const { status } = reply;
        const answer =
          status === 200 || status === 404 || status === 409 ? parseJson(reply.body) : undefined;
        // A receiver without the route answers its framework's not-found (Hue's own 404, an
        // archived project, is JSON with an `error`), refuses the method, or answers something
        // that is no reservation at all: it is not asked again for a while, since the values
        // exported while it answers are listed for bytes it cannot store.
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
        // A reservation that cannot be used fails its value.
        if (status === 200) return this.reservation(answer, size);
        if (status === 409 && isObject(answer) && answer.status === "exists")
          return this.reservation(answer, size);
        if (status === 413) return { fallback: "tooLarge" };
        // Refusals of the value or the key (400, 401, 403, Hue's own 404, a conflict) are final.
        if (status !== 408 && status !== 429 && status < 500) return { fallback: "failed" };
        retryAfter = retryAfterMillis(reply.headers);
      }
      if (attempt + 1 >= UPLOAD_ATTEMPTS || !(await this.retryWait(attempt, retryAfter, upload)))
        return { fallback: "failed" };
    }
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

  /** The PUT of the value's bytes, with exactly the headers Hue signed. No answer, a 408, a 429 or
   * a 5xx is transient, with the answer's `Retry-After` when it gave one. A source that no longer
   * holds its bytes (a file changed since it was recorded) ends the request before its body is
   * complete, and fails the value without a retry. */
  private async put(
    grant: Grant,
    value: string | Uint8Array | ByteSource,
    size: number,
    deadline: number,
  ): Promise<"stored" | "expired" | "failed" | "changed" | { retryAfter: number | undefined }> {
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
    if (!reply) return { retryAfter: undefined };
    // 412: the object exists already (another upload of the same value won). A success answered
    // before the whole body was written stores nothing that was sent.
    if (reply.status === 412) return "stored";
    if (reply.status >= 200 && reply.status < 300) return reply.complete ? "stored" : "failed";
    if (reply.status === 403)
      return reply.body.toString("utf8").includes("Request has expired") ? "expired" : "failed";
    if (reply.status >= 500 || reply.status === 408 || reply.status === 429)
      return { retryAfter: retryAfterMillis(reply.headers) };
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

/** Where one record's values are uploaded, and what it learned of them. */
export interface OffloadOptions {
  uploader: BlobUploader;
  traceId: string;
  /** The receiver's inline value limit. */
  valueBytes: number;
  /** The deadline for hashing, and for a blocking store (no `background`) its uploads too. */
  upload: UploadContext;
  tally: OffloadTally;
  memo?: MediaDigestMemo;
  /** For tests: the length past which a long string is read in place (`LONG_STRING_UNITS`). */
  longUnits?: number;
  /** Set by an export: values are placed as uploaded and their uploads queued, each counted in
   * `background.tally` once it settles; `tally` counts the values refused when placed. Absent
   * for the import, which stores each value, under the type Hue stores it as, before placing it. */
  background?: LateUploads;
}

/**
 * A span's own attributes with each candidate placed: binary media becomes a digest, while
 * text media over 64 KiB retains a 16 KiB prefix once uploaded or queued, or a digest when
 * refused. A value still over the inline limit is uploaded and replaced by its first 16 KiB (or
 * cut to the limit when refused), each upload listed under `hue.blobs`, each whole value cut or
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
 * {@link offloadAttributes}). A file is uploaded (or, for an export, queued) and placed in its
 * digest form (a text file in a provider part keeps a 16 KiB prefix), its `hue.blobs` entry keyed
 * `<attribute>#<pointer>` or, in a log record's body, `body#<pointer>`. A file refused or not
 * uploaded before it is placed keeps its bytes inline, except in a span's own recorded messages,
 * where it keeps its digest as before. A log record's values over the inline limit are cut, never
 * uploaded whole, and a body still over it is replaced by the receiver's marker, as before.
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
  /** Stores a value (the import), or queues its upload (an export): what the record lists. A
   * queued value's entry names the type its own reference declared. `shared` when the value is
   * memory its record holds (not decoded or rewritten from it). */
  const submit = async (
    key: string,
    value: string | Uint8Array | ByteSource,
    contentType: string,
    digest: FileDigest,
    shared: boolean,
  ): Promise<Outcome> => {
    const late = options.background;
    if (!late) {
      const outcome = await uploader.store(traceId, key, value, contentType, digest, upload);
      if (outcome.ok) tally.uploaded++;
      return outcome;
    }
    const queued = uploader.enqueue(traceId, key, value, contentType, digest);
    if (!queued.ok) return queued;
    const settled = countWhenSettled(queued.done, late.tally, traceId);
    late.settled.push(settled);
    late.queued?.(settled, shared ? queued.bytes : 0, queued.released);
    return { ok: true, contentType };
  };
  // A value the queue cut when it was admitted was never held whole to upload.
  for (let index = 0; index < collector.cut.length; index++)
    fallback(uploader.unsupported() ? "unsupported" : "budget");
  let inspected = 0;

  /** Uploads (or queues) each file of a value and places it; whether any was placed. A file
   * refused or not uploaded keeps its bytes inline, except in a recorded message: a span's own
   * message keeps its digest, and a log record's keeps the digest of a file over the inline limit,
   * as nested messages kept them before log records uploaded. */
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
          // A long file is hashed in a hashing place, as a large value is; one the export's
          // hashing deadline cannot hash stays as recorded and is not uploaded.
          let digest: FileDigest;
          try {
            digest = isByteSource(bytes)
              ? await uploader.digest(bytes, upload.deadline)
              : options.memo
                ? options.memo.digest(file, decoded as InlineFileBytes, traceId)
                : await digestOf(bytes);
          } catch {
            fallback("failed");
            return;
          }
          const outcome: Outcome = slot
            ? await submit(partKey, bytes, contentType, digest, isByteSource(bytes))
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
      // A large value is hashed in a hashing place; its upload takes an upload place.
      let digest: FileDigest;
      try {
        digest = await uploader.digest(placed, upload.deadline);
      } catch {
        return { ok: false as const, reason: "failed" as const };
      }
      const contentType = joined
        ? textContentType(joined.head(256) + joined.tail(256))
        : typeof placed === "string"
          ? textContentType(placed)
          : "application/octet-stream";
      const outcome = await submit(key, placed, contentType, digest, !!joined || read === value);
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
          ? await submit(key, file.bytes, file.contentType, file.digest, true)
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
