import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { sdkVersion } from "../version.js";
import {
  manifestTotals,
  sha256Hex,
  validateManifest,
  type TraceImportManifest,
  type TraceImportTotals,
} from "./traces-import-convert.js";
import { MANIFEST_FILE, PROGRESS_FILE } from "./traces-import-prepare.js";

/**
 * `hue traces import upload`: delivers a prepared bundle to Hue's import routes with the
 * short-lived import authorization `prepare_trace_import` minted. The manifest's exact bytes
 * are registered first; then, trace by trace in declared order and two requests at a time
 * across traces, each large value is reserved, sent to the presigned URL and completed, each
 * batch is posted with its digest, and the trace's receipt is read for every span id. A trace's
 * requests run strictly in order. Transient answers and network failures are retried with
 * bounded backoff (identical bytes are safe to resend), a rejected record is a conflict that is
 * recorded rather than retried, and an authorization Hue no longer accepts stops the upload
 * with the step to take. Progress is checkpointed to `progress.json` so a rerun resumes.
 */

export const UPLOAD_CONCURRENCY = 2;
export const RECEIPT_IDS_PER_CALL = 100;
const MAX_RESPONSE_BYTES = 256 * 1024;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000];
const MAX_RETRY_AFTER_MS = 60_000;
const JSON_TIMEOUT_MS = 30_000;
const BATCH_TIMEOUT_MS = 120_000;
/** A presigned PUT of up to 1 GB; the URL itself lasts 15 minutes. */
const BLOB_TIMEOUT_MS = 15 * 60_000;
const RECEIPT_RETRY_MS = 1_000;
const IMPORT_TOKEN = /^hue_it_[A-Za-z0-9_-]{43}$/;
const IMPORT_PATH =
  /^\/api\/v1\/trace-imports\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const DEFAULT_CHECKPOINT_INTERVAL_MS = 250;

export interface UploadIo {
  /** The HTTP seam; `globalThis.fetch` by default. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Waits `ms`, resolving early when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Registers the stop request (SIGINT and SIGTERM by default) and returns its removal. */
  onInterrupt?: (listener: () => void) => () => void;
  /** Progress lines: text, or one JSON object per line with `--json`. */
  progress?: (event: Record<string, unknown>) => void;
  /** How long checkpoint writes are coalesced; 0 writes after every step. */
  checkpointIntervalMs?: number;
}

export interface UploadOptions {
  directory: string;
  token: string;
  importUrl: string;
}

/** Why the upload stopped before it completed. */
export class UploadStop extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** Whether `prepare_trace_import` must be called again before the next run. */
    readonly prepareAgain = false,
  ) {
    super(message);
    this.name = "UploadStop";
  }
}

class Interrupted extends Error {}
/** Hue answered that the import already completed: nothing more is accepted, nothing is owed. */
class AlreadyCompleted extends Error {}

export interface UploadReport {
  state: "completed" | "incomplete" | "stopped" | "failed";
  import_url: string;
  manifest_digest: string;
  totals: TraceImportTotals;
  traces: { declared: number; verified: number; conflicted: number; unverified: number };
  batches: { declared: number; landed: number; conflicted: number; pending: number };
  blobs: { declared: number; stored: number; pending: number };
  /** Hue's own line on the import's progress, when completion was refused. */
  note?: string;
  /** The traces Hue still lists as pending or conflicting when completion was refused. */
  pending?: unknown[];
  /** A batch or value Hue refused with a fixed code, or whose records it rejected: recorded,
   * never sent again, reported with the trace. */
  conflicts: { trace_id: string; sha256: string; message: string }[];
  next_action: string;
  error?: { code: string; message: string };
}

/** The refusal codes of a batch or value that the same bytes would earn again: the bundle
 * disagrees with the manifest it declared, or with evidence Hue holds. Recorded as a conflict of
 * the trace rather than retried or allowed to stop the other traces. */
const BATCH_CONFLICT_CODES = new Set([
  "batch_undeclared",
  "batch_digest_mismatch",
  "batch_trace_mismatch",
  "batch_span_count_mismatch",
]);
const BLOB_CONFLICT_CODES = new Set(["blob_undeclared", "blob_mismatch"]);

interface TraceProgress {
  state: "verified" | "pending";
  blobs: string[];
  batches: string[];
  conflicts: { sha256: string; message: string }[];
}

interface ProgressFile {
  version: 1;
  manifest_digest: string;
  import_url: string;
  traces: Record<string, TraceProgress>;
}

/** The import authorization file, in either shape `prepare_trace_import`'s answer is saved in:
 * its JSON (`authorization`, and `upload_url` beside it), or the authorization alone on the first
 * line, optionally with the upload URL on the second. Nothing in it is ever printed. */
export function parseAuthorizationFile(content: string): { token: string; importUrl?: string } {
  const refuse = () =>
    new UploadStop(
      "The authorization file must hold the import authorization prepare_trace_import returned (hue_it_…): its JSON answer, or the authorization alone on the first line",
      "authorization_invalid",
    );
  const trimmed = content.trim();
  let token: string;
  let importUrl: string | undefined;
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw refuse();
    }
    if (!isObject(parsed) || typeof parsed.authorization !== "string") throw refuse();
    token = parsed.authorization;
    if (typeof parsed.upload_url === "string") importUrl = parsed.upload_url;
  } else {
    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    token = lines[0] ?? "";
    importUrl = lines[1];
  }
  if (!IMPORT_TOKEN.test(token)) throw refuse();
  return { token, ...(importUrl ? { importUrl } : {}) };
}

const isLoopback = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

/** The upload URL as `prepare_trace_import` returned it, or why it is refused. */
export function parseImportUrl(value: string, origin?: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UploadStop(
      "The import URL must be the upload_url prepare_trace_import returned",
      "url_invalid",
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))
    throw new UploadStop(
      "The import URL must use https (plain http is accepted for this machine only)",
      "url_invalid",
    );
  if (url.username || url.password || url.search || url.hash)
    throw new UploadStop(
      "The import URL must not carry credentials, a query or a fragment",
      "url_invalid",
    );
  if (!IMPORT_PATH.test(url.pathname.replace(/\/+$/, "")))
    throw new UploadStop(
      "The import URL must be <origin>/api/v1/trace-imports/<import id>",
      "url_invalid",
    );
  if (origin !== undefined && url.origin !== origin)
    throw new UploadStop(`The import URL is not on ${origin}`, "url_invalid");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      done();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function defaultOnInterrupt(listener: () => void): () => void {
  process.on("SIGINT", listener);
  process.on("SIGTERM", listener);
  return () => {
    process.removeListener("SIGINT", listener);
    process.removeListener("SIGTERM", listener);
  };
}

function retryAfterMillis(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS)
    : undefined;
}

interface Reply {
  status: number;
  headers: Headers;
  body: Buffer;
  json: unknown;
  /** The fixed refusal code: the `Hue-Refusal-Code` header, else the JSON body's `code`. */
  code?: string;
  /** The refusal's message, when the body carried one. */
  message?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Writes `progress.json` (mode 0600, through a temporary file and an atomic rename) after each
 * verified step, coalescing writes that fall within the interval. */
class Progress {
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private lastWrite = 0;

  constructor(
    private readonly path: string,
    readonly file: ProgressFile,
    private readonly intervalMs: number,
  ) {}

  trace(traceId: string): TraceProgress {
    let trace = this.file.traces[traceId];
    if (!trace) {
      trace = { state: "pending", blobs: [], batches: [], conflicts: [] };
      this.file.traces[traceId] = trace;
    }
    return trace;
  }

  /** Records a step; the file is written now, or at the end of the interval. */
  changed(): Promise<void> {
    this.dirty = true;
    const due = this.lastWrite + this.intervalMs - Date.now();
    if (due <= 0) return this.flush();
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, due);
    return Promise.resolve();
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty) return this.writing;
    this.dirty = false;
    this.lastWrite = Date.now();
    const bytes = JSON.stringify(this.file);
    this.writing = this.writing.then(async () => {
      await writeFile(`${this.path}.tmp`, bytes, { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
    });
    return this.writing;
  }
}

/** Runs the upload; resolves to the report. Throws only for a programming error. */
export async function uploadTraceBundle(
  options: UploadOptions,
  io: UploadIo = {},
): Promise<UploadReport> {
  const fetcher = io.fetch ?? fetch;
  const sleep = io.sleep ?? defaultSleep;
  const progress = io.progress ?? (() => {});
  const importUrl = parseImportUrl(options.importUrl);
  const base = importUrl.href;
  const importId = IMPORT_PATH.exec(importUrl.pathname)![1]!;
  const manifestBytes = await readFile(join(options.directory, MANIFEST_FILE)).catch(() => {
    throw new UploadStop(
      `${options.directory} holds no ${MANIFEST_FILE}; run hue traces import prepare first`,
      "bundle_invalid",
    );
  });
  let manifest: TraceImportManifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8")) as TraceImportManifest;
  } catch {
    throw new UploadStop(`${MANIFEST_FILE} is not JSON`, "bundle_invalid");
  }
  const invalid = validateManifest(manifest);
  if (invalid) throw new UploadStop(`${MANIFEST_FILE} is not valid: ${invalid}`, "bundle_invalid");
  const manifestDigest = sha256Hex(manifestBytes);
  const totals = manifestTotals(manifest);
  // Every declared file must be present before the first request: a bundle missing a batch
  // would otherwise be registered and never complete.
  for (const trace of manifest.traces) {
    for (const batch of trace.batches)
      await stat(join(options.directory, `${trace.trace_id}.${batch.sha256}.json.gz`)).catch(() => {
        throw new UploadStop(
          `The bundle lacks batch ${batch.sha256} of trace ${trace.trace_id}`,
          "bundle_invalid",
        );
      });
    for (const blob of trace.blobs)
      await stat(join(options.directory, `${blob.sha256}.blob`)).catch(() => {
        throw new UploadStop(
          `The bundle lacks value ${blob.sha256} of trace ${trace.trace_id}`,
          "bundle_invalid",
        );
      });
  }
  const progressPath = join(options.directory, PROGRESS_FILE);
  let saved: ProgressFile | undefined;
  try {
    saved = JSON.parse(await readFile(progressPath, "utf8")) as ProgressFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new UploadStop(
        `${PROGRESS_FILE} could not be read; remove it to start over`,
        "progress_invalid",
      );
  }
  if (saved) {
    if (!isObject(saved) || saved.version !== 1 || !isObject(saved.traces))
      throw new UploadStop(
        `${PROGRESS_FILE} is not a progress file; remove it to start over`,
        "progress_invalid",
      );
    if (saved.manifest_digest !== manifestDigest)
      throw new UploadStop(
        `${PROGRESS_FILE} belongs to another manifest (${saved.manifest_digest}); remove it to upload this bundle`,
        "progress_mismatch",
      );
    if (saved.import_url !== base)
      throw new UploadStop(
        `${PROGRESS_FILE} belongs to another import (${saved.import_url}); remove it to upload to ${base}`,
        "progress_mismatch",
      );
  }
  const checkpoint = new Progress(
    progressPath,
    saved ?? { version: 1, manifest_digest: manifestDigest, import_url: base, traces: {} },
    io.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS,
  );

  const stopping = new AbortController();
  const forced = new AbortController();
  const removeInterrupt = (io.onInterrupt ?? defaultOnInterrupt)(() => {
    if (!stopping.signal.aborted) stopping.abort();
    else forced.abort();
  });
  const userAgent = `hue-sdk-typescript/${sdkVersion} hue-traces-import`;

  /** One request with bounded retries of transient failures. Resolves to the final answer, which
   * the caller interprets; throws {@link Interrupted} when a stop was requested. */
  const request = async (
    method: string,
    url: string,
    init: {
      headers?: Record<string, string>;
      body?: Uint8Array | string;
      authorized?: boolean;
      timeoutMs?: number;
    } = {},
  ): Promise<Reply> => {
    const headers: Record<string, string> = { "user-agent": userAgent, ...init.headers };
    if (init.authorized !== false) headers.authorization = `Bearer ${options.token}`;
    for (let attempt = 0; ; attempt++) {
      if (stopping.signal.aborted) throw new Interrupted();
      const timeout = AbortSignal.timeout(init.timeoutMs ?? JSON_TIMEOUT_MS);
      let response: Response | undefined;
      let retryAfter: number | undefined;
      try {
        response = await fetcher(url, {
          method,
          headers,
          ...(init.body !== undefined ? { body: init.body as RequestInit["body"] } : {}),
          redirect: "manual",
          cache: "no-store",
          credentials: "omit",
          signal: AbortSignal.any([timeout, forced.signal]),
        });
      } catch {
        if (forced.signal.aborted) throw new Interrupted();
        response = undefined;
      }
      if (response) {
        const transient =
          response.status === 408 ||
          response.status === 429 ||
          (response.status >= 500 && response.status <= 504);
        if (!transient) {
          const body = await readBounded(response);
          let json: unknown;
          try {
            json = body.byteLength ? JSON.parse(body.toString("utf8")) : undefined;
          } catch {
            json = undefined;
          }
          const header = response.headers.get("hue-refusal-code");
          const code =
            header ?? (isObject(json) && typeof json.code === "string" ? json.code : undefined);
          // The JSON routes answer `error`; the batch route answers an OTLP Status, `message`.
          const message = isObject(json)
            ? typeof json.error === "string"
              ? json.error
              : typeof json.message === "string"
                ? json.message
                : undefined
            : undefined;
          return {
            status: response.status,
            headers: response.headers,
            body,
            json,
            ...(code ? { code } : {}),
            ...(message ? { message } : {}),
          };
        }
        retryAfter = retryAfterMillis(response.headers.get("retry-after"));
        await response.body?.cancel().catch(() => {});
      }
      if (attempt >= RETRY_DELAYS_MS.length)
        throw new UploadStop(
          response
            ? `Hue answered ${response.status} to ${method} ${new URL(url).pathname} ${attempt + 1} times`
            : `Hue could not be reached at ${new URL(url).origin}`,
          response ? "busy" : "unreachable",
        );
      await sleep(Math.max(RETRY_DELAYS_MS[attempt]!, retryAfter ?? 0), stopping.signal);
    }
  };

  /** A refusal every route may answer: the authorization or the import is no longer usable. The
   * fixed code (`Hue-Refusal-Code`) decides; the message is passed on, never branched on. */
  const stopFor = (reply: Reply, context: string): UploadStop | undefined => {
    const message = reply.message ?? `Hue answered ${reply.status}.`;
    if (reply.status === 401)
      return new UploadStop(
        `${message} Call prepare_trace_import again with the same manifest_digest and totals and write the new authorization to the file.`,
        reply.code ?? "unauthorized",
        true,
      );
    if (reply.status === 403 && reply.code === "authority_lapsed")
      return new UploadStop(
        `${message} Call prepare_trace_import again with a connection that can write the project.`,
        reply.code,
        true,
      );
    if (reply.status === 403 && reply.code === "import_mismatch")
      return new UploadStop(
        `${message} Use the authorization prepare_trace_import returned for this import.`,
        reply.code,
      );
    if (reply.status === 410 && reply.code === "import_completed") throw new AlreadyCompleted();
    if (reply.status === 410 && reply.code === "import_canceled")
      return new UploadStop(`${message} It cannot be resumed.`, reply.code);
    if (reply.status === 410)
      return new UploadStop(
        `${message} Call prepare_trace_import again with the same manifest_digest and totals to continue.`,
        reply.code ?? "gone",
        true,
      );
    if (reply.status === 404 && (!reply.code || reply.code === "import_not_found"))
      return new UploadStop(`${message} Check the import URL.`, reply.code ?? "not_found");
    if (reply.status >= 300)
      return new UploadStop(
        `${context}: ${message}${reply.code ? ` (${reply.code})` : ""}`,
        reply.code ?? `http_${reply.status}`,
      );
    return undefined;
  };

  const conflicts: UploadReport["conflicts"] = [];
  let verified = 0,
    conflicted = 0,
    unverified = 0,
    landed = 0,
    stored = 0;
  const countSaved = () => {
    for (const [traceId, trace] of Object.entries(checkpoint.file.traces)) {
      for (const conflict of trace.conflicts)
        conflicts.push({ trace_id: traceId, sha256: conflict.sha256, message: conflict.message });
    }
  };

  const uploadBlob = async (
    traceId: string,
    blob: TraceImportManifest["traces"][number]["blobs"][number],
    state: TraceProgress,
  ) => {
    const bytes = await readFile(join(options.directory, `${blob.sha256}.blob`));
    if (sha256Hex(bytes) !== blob.sha256 || bytes.byteLength !== blob.byte_size)
      throw new UploadStop(
        `Value ${blob.sha256} of trace ${traceId} was altered after preparation`,
        "bundle_invalid",
      );
    const reservation = JSON.stringify({
      traceId,
      sha256: blob.sha256,
      byteSize: blob.byte_size,
      contentType: blob.content_type,
    });
    /** A refusal the same value would earn again: the reservation named a size or type the
     * manifest did not declare, the value is undeclared, or the stored object differs. */
    const conflict = (reply: Reply, fallback: string) => {
      state.conflicts.push({
        sha256: blob.sha256,
        message: `${reply.message ?? fallback}${reply.code ? ` (${reply.code})` : ""}`,
      });
      return false;
    };
    for (let round = 0; round < 2; round++) {
      const presign = await request("POST", `${base}/blobs`, {
        headers: { "content-type": "application/json" },
        body: reservation,
      });
      if (
        presign.status === 409 ||
        (presign.status === 403 &&
          presign.code !== undefined &&
          BLOB_CONFLICT_CODES.has(presign.code))
      )
        return conflict(presign, "The value conflicts with one Hue holds.");
      const stop = stopFor(presign, `Value ${blob.sha256} was refused`);
      if (stop) throw stop;
      const answer = presign.json;
      if (!isObject(answer))
        throw new UploadStop("Hue answered a value reservation without JSON", "protocol");
      if (answer.status === "upload") {
        if (typeof answer.url !== "string" || !isObject(answer.headers))
          throw new UploadStop(
            "Hue answered a value reservation without an upload URL",
            "protocol",
          );
        let target: URL;
        try {
          target = new URL(answer.url);
        } catch {
          throw new UploadStop(
            "Hue answered a value reservation with an invalid upload URL",
            "protocol",
          );
        }
        if (
          target.protocol !== "https:" &&
          !(target.protocol === "http:" && isLoopback(target.hostname))
        )
          throw new UploadStop(
            "Hue answered a value reservation with an insecure upload URL",
            "protocol",
          );
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(answer.headers))
          if (typeof value === "string" && name.toLowerCase() !== "content-length")
            headers[name] = value;
        const put = await request(
          typeof answer.method === "string" ? answer.method : "PUT",
          target.href,
          {
            headers,
            body: bytes,
            authorized: false,
            timeoutMs: BLOB_TIMEOUT_MS,
          },
        );
        // 412: the object exists already (another upload of the same value won).
        const storedNow = (put.status >= 200 && put.status < 300) || put.status === 412;
        if (!storedNow) {
          if (
            put.status === 403 &&
            round === 0 &&
            put.body.toString("utf8").includes("Request has expired")
          )
            continue;
          throw new UploadStop(
            `The store answered ${put.status} to the upload of value ${blob.sha256}`,
            "upload_failed",
          );
        }
      } else if (answer.status !== "exists")
        throw new UploadStop("Hue answered a value reservation with an unknown status", "protocol");
      const completion = await request("POST", `${base}/blobs/complete`, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ traceId, sha256: blob.sha256 }),
      });
      // 404: no reservation stands for the value (Hue's own answer, with no import code).
      if (
        completion.status === 409 ||
        (completion.status === 404 && completion.code === undefined) ||
        (completion.status === 403 &&
          completion.code !== undefined &&
          BLOB_CONFLICT_CODES.has(completion.code))
      )
        return conflict(completion, "The stored value does not match.");
      const refused = stopFor(completion, `Value ${blob.sha256} could not be completed`);
      if (refused) throw refused;
      return true;
    }
    throw new UploadStop(`The upload URL of value ${blob.sha256} expired twice`, "upload_failed");
  };

  const sendBatch = async (
    traceId: string,
    batch: { sha256: string; bytes: number },
    state: TraceProgress,
  ) => {
    const body = await readFile(join(options.directory, `${traceId}.${batch.sha256}.json.gz`));
    if (sha256Hex(body) !== batch.sha256 || body.byteLength !== batch.bytes)
      throw new UploadStop(
        `Batch ${batch.sha256} of trace ${traceId} was altered after preparation`,
        "bundle_invalid",
      );
    const reply = await request("POST", `${base}/batches`, {
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "hue-import-batch": batch.sha256,
      },
      body,
      timeoutMs: BATCH_TIMEOUT_MS,
    });
    // A refusal the same bytes would earn again (undeclared, another digest, another trace's
    // records, fewer finished spans than declared) is the trace's conflict, not the upload's end.
    if (reply.code !== undefined && BATCH_CONFLICT_CODES.has(reply.code)) {
      state.conflicts.push({
        sha256: batch.sha256,
        message: `${reply.message ?? "The batch was refused."} (${reply.code})`,
      });
      return false;
    }
    const stop = stopFor(reply, `Batch ${batch.sha256} of trace ${traceId} was refused`);
    if (stop) throw stop;
    const partial =
      isObject(reply.json) && isObject(reply.json.partialSuccess)
        ? reply.json.partialSuccess
        : undefined;
    const rejected = partial ? Number(partial.rejectedSpans ?? 0) : 0;
    if (rejected > 0) {
      const message =
        typeof partial?.errorMessage === "string" && partial.errorMessage
          ? partial.errorMessage
          : "Records were refused.";
      state.conflicts.push({
        sha256: batch.sha256,
        message: `${rejected} span(s) rejected: ${message}`,
      });
      return false;
    }
    return true;
  };

  /** The span ids a batch holds, read back from its body. */
  const spanIdsOf = async (traceId: string, sha256: string): Promise<string[]> => {
    const body = await readFile(join(options.directory, `${traceId}.${sha256}.json.gz`));
    const decoded = JSON.parse(gunzipSync(body).toString("utf8")) as {
      resourceSpans?: { scopeSpans?: { spans?: { spanId?: unknown }[] }[] }[];
    };
    const ids: string[] = [];
    for (const group of decoded.resourceSpans ?? [])
      for (const scope of group.scopeSpans ?? [])
        for (const span of scope.spans ?? [])
          if (typeof span.spanId === "string") ids.push(span.spanId);
    return ids;
  };

  const confirmReceipt = async (traceId: string, spanIds: string[]): Promise<number> => {
    let missing = 0;
    for (let at = 0; at < spanIds.length; at += RECEIPT_IDS_PER_CALL) {
      const page = spanIds.slice(at, at + RECEIPT_IDS_PER_CALL);
      const url = new URL(`${base}/traces/${traceId}/receipt`);
      for (const id of page) url.searchParams.append("expectedSpanId", id);
      for (let attempt = 0; ; attempt++) {
        const reply = await request("GET", url.href, { headers: { accept: "application/json" } });
        let missingHere: number;
        if (reply.status === 404) missingHere = page.length;
        else {
          const stop = stopFor(reply, `The receipt of trace ${traceId} was refused`);
          if (stop) throw stop;
          const ids =
            isObject(reply.json) && Array.isArray(reply.json.missingSpanIds)
              ? reply.json.missingSpanIds
              : undefined;
          if (!ids) throw new UploadStop("Hue answered a receipt without span ids", "protocol");
          missingHere = ids.length;
        }
        if (!missingHere || attempt >= 1) {
          missing += missingHere;
          break;
        }
        // Acknowledged records are durable; one more read covers a receipt served ahead of them.
        await sleep(RECEIPT_RETRY_MS, stopping.signal);
        if (stopping.signal.aborted) throw new Interrupted();
      }
    }
    return missing;
  };

  const processTrace = async (trace: TraceImportManifest["traces"][number], index: number) => {
    const state = checkpoint.trace(trace.trace_id);
    if (state.state === "verified") {
      verified++;
      return;
    }
    const conflict = () => {
      conflicted++;
      progress({
        event: "trace.conflicted",
        trace_id: trace.trace_id,
        index: index + 1,
        of: manifest.traces.length,
      });
    };
    const refusedBefore = (sha256: string) =>
      state.conflicts.some((conflict) => conflict.sha256 === sha256);
    // Values first: a trace whose value Hue refused can never verify, so none of its records
    // are sent and Hue is left without a partly stored trace.
    let complete = true;
    for (const blob of trace.blobs) {
      if (state.blobs.includes(blob.sha256)) continue;
      if (refusedBefore(blob.sha256)) {
        complete = false;
        continue;
      }
      if (await uploadBlob(trace.trace_id, blob, state)) state.blobs.push(blob.sha256);
      else complete = false;
      await checkpoint.changed();
    }
    if (!complete) return conflict();
    // Batches in declared order; a refused batch ends the trace's delivery there, so no later
    // batch lands ahead of an earlier one.
    const spanIds: string[] = [];
    for (const batch of trace.batches) {
      if (refusedBefore(batch.sha256)) return conflict();
      if (!state.batches.includes(batch.sha256)) {
        const landed = await sendBatch(trace.trace_id, batch, state);
        if (landed) state.batches.push(batch.sha256);
        await checkpoint.changed();
        if (!landed) return conflict();
      }
      spanIds.push(...(await spanIdsOf(trace.trace_id, batch.sha256)));
    }
    const missing = await confirmReceipt(trace.trace_id, spanIds);
    if (missing) {
      unverified++;
      progress({
        event: "trace.unverified",
        trace_id: trace.trace_id,
        missing_spans: missing,
        index: index + 1,
        of: manifest.traces.length,
      });
      return;
    }
    state.state = "verified";
    verified++;
    await checkpoint.changed();
    progress({
      event: "trace.verified",
      trace_id: trace.trace_id,
      index: index + 1,
      of: manifest.traces.length,
    });
  };

  let failure: UploadStop | undefined;
  let interrupted = false;
  let pendingFromHue: unknown[] | undefined;
  let note: string | undefined;
  let completed = false;
  let alreadyCompleted = false;
  let incompleteMessage: string | undefined;
  try {
    const registration = await request("PUT", `${base}/manifest`, {
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: gzipSync(manifestBytes, { level: 6 }),
    });
    if (registration.status === 409 || registration.status === 422)
      throw new UploadStop(
        `Hue did not register the manifest: ${registration.message ?? `HTTP ${registration.status}`}${registration.code === "digest_mismatch" || registration.code === "totals_differ" ? ". Call prepare_trace_import with this bundle's manifest_digest and totals." : ""}`,
        registration.code ?? "manifest_refused",
      );
    const refused = stopFor(registration, "The manifest was refused");
    if (refused) throw refused;
    progress({
      event: "manifest.registered",
      registered: registration.status === 201,
      import_id: importId,
    });

    let next = 0;
    const worker = async () => {
      while (!stopping.signal.aborted) {
        const index = next++;
        if (index >= manifest.traces.length) return;
        await processTrace(manifest.traces[index]!, index);
      }
    };
    const outcomes = await Promise.allSettled(
      Array.from({ length: Math.min(UPLOAD_CONCURRENCY, manifest.traces.length) }, () =>
        worker().catch((error: unknown) => {
          // One worker's stop ends the others after their request in flight.
          stopping.abort();
          throw error;
        }),
      ),
    );
    for (const outcome of outcomes)
      if (outcome.status === "rejected") {
        if (outcome.reason instanceof Interrupted) continue;
        throw outcome.reason;
      }
    if (stopping.signal.aborted) throw new Interrupted();

    const reconciled = await request("POST", `${base}/reconcile`);
    const reconcileStop = stopFor(reconciled, "Reconciliation was refused");
    if (reconcileStop) throw reconcileStop;
    progress({ event: "reconciled", ...(isObject(reconciled.json) ? reconciled.json : {}) });
    const completion = await request("POST", `${base}/complete`);
    if (completion.status === 409 && completion.code === "incomplete") {
      incompleteMessage = completion.message ?? "Some traces are not verified yet.";
      const listing = await request("GET", base);
      if (listing.status === 200 && isObject(listing.json)) {
        if (Array.isArray(listing.json.traces)) pendingFromHue = listing.json.traces;
        if (typeof listing.json.note === "string") note = listing.json.note;
      }
    } else {
      const completeStop = stopFor(completion, "Completion was refused");
      if (completeStop) throw completeStop;
      completed = true;
      progress({ event: "completed", import_id: importId });
    }
  } catch (error) {
    if (error instanceof Interrupted) interrupted = true;
    else if (error instanceof AlreadyCompleted) {
      completed = true;
      alreadyCompleted = true;
      note = "Hue answered that this import already completed; nothing more was sent.";
    } else if (error instanceof UploadStop) failure = error;
    else throw error;
  } finally {
    removeInterrupt();
    await checkpoint.flush().catch(() => {});
  }
  countSaved();
  for (const trace of Object.values(checkpoint.file.traces)) {
    landed += trace.batches.length;
    stored += trace.blobs.length;
  }
  const state: UploadReport["state"] = completed
    ? "completed"
    : failure
      ? "failed"
      : interrupted
        ? "stopped"
        : "incomplete";
  if (alreadyCompleted) progress({ event: "completed", import_id: importId, already: true });
  const nextAction = completed
    ? `Call get_trace_import with trace_import_id ${importId} for the results.`
    : failure?.prepareAgain
      ? "Call prepare_trace_import again with the same manifest_digest and totals, write the new authorization to the file and run the same command again."
      : failure?.code === "import_canceled"
        ? `This import was canceled in Hue and takes no more requests. Call get_trace_import with trace_import_id ${importId} for its state.`
        : failure && !["busy", "unreachable"].includes(failure.code)
          ? "Fix the reported problem; then run the same command again to resume."
          : conflicted && !unverified && !interrupted && !failure
            ? `The conflicting traces keep the evidence Hue already holds. Call get_trace_import with trace_import_id ${importId} to review them.`
            : "Run the same command again to resume; what Hue already holds is not sent twice.";
  return {
    state,
    import_url: base,
    manifest_digest: manifestDigest,
    totals,
    traces: {
      declared: manifest.traces.length,
      verified,
      conflicted,
      unverified: manifest.traces.length - verified - conflicted,
    },
    batches: {
      declared: totals.batches,
      landed,
      conflicted: conflicts.filter((conflict) =>
        manifest.traces.some((trace) =>
          trace.batches.some((batch) => batch.sha256 === conflict.sha256),
        ),
      ).length,
      pending: totals.batches - landed,
    },
    blobs: { declared: totals.blobs, stored, pending: totals.blobs - stored },
    ...(note ? { note } : {}),
    ...(pendingFromHue ? { pending: pendingFromHue } : {}),
    conflicts,
    next_action: nextAction,
    ...(failure
      ? { error: { code: failure.code, message: failure.message } }
      : incompleteMessage
        ? { error: { code: "incomplete", message: incompleteMessage } }
        : {}),
  };
}

async function readBounded(response: Response): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(next.value);
    }
  } catch {
    // A body that breaks off is read as what arrived.
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
