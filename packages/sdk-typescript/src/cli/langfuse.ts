import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import {
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  type AttributeValue,
  type HrTime,
} from "@opentelemetry/api";
import type { Resource } from "@opentelemetry/resources";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { MAX_CONTENT_BYTES, MAX_FILE_DATA_BYTES, isLoopbackHost } from "../config.js";
import {
  BLOBS_KEY,
  MAX_BLOB_ENTRIES,
  blobEntry,
  newTally,
  offloadAttributes,
  type BlobUploader,
  type FallbackReason,
  type UploadContext,
} from "../blobs.js";
import {
  digestPart,
  isMediaContentType,
  mayInlineFiles,
  mediaIn,
  placedMediaText,
  readerParses,
  type InlineFilePart,
  type MediaValue,
} from "../inline-files.js";
import { sdkVersion } from "../version.js";

/**
 * Reading a Langfuse project through its public API and converting what it holds into the
 * OpenTelemetry spans Hue reads, with the `langfuse.*` attributes the Langfuse SDKs write. Used by
 * `hue import langfuse`; nothing here runs unless that command does.
 */

// ---------------------------------------------------------------------------------------------
// Langfuse public API
// ---------------------------------------------------------------------------------------------

/** Every API request's own deadline. */
const REQUEST_TIMEOUT_MS = 60_000;
/** A media file download's deadline: up to 25 MiB over a slow link. */
const DOWNLOAD_TIMEOUT_MS = 300_000;
/** Redirects a media download follows, each to a link checked as the first one was. */
const MAX_DOWNLOAD_REDIRECTS = 5;
/** The longest media download link accepted, as the Python SDK's media client accepts. */
const MAX_LINK_LENGTH = 8192;
/** The largest answer read from the API. Langfuse Cloud answers at most 5 MB; a larger answer is
 * asked for again in smaller pages. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Waits between attempts of a request that failed for its connection or a 5xx. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
/** Rate-limit answers (HTTP 429) waited out in a row before the request is given up. */
const MAX_RATE_LIMITED = 10;
/** The longest `Retry-After` honoured; Langfuse's buckets are per minute or per hour. */
const MAX_RETRY_AFTER_MS = 15 * 60_000;
/** Page sizes, each dividing the one before, so a page-numbered listing keeps its place when
 * its page size shrinks after an answer too large to read. */
const PAGE_SIZES = [100, 50, 25, 5, 1];
/** How many pages of the next size one page of each size holds. */
const PAGE_SPLITS = [2, 2, 5, 5];
/** Root observations read per page when the answer is too large: the core fields only. */
const ROOT_PAGE_SIZES = [1000, 100, 10, 1];
/** Observation fields read for each trace through the v2 API. */
const V2_FIELDS = "core,basic,time,io,metadata,model,usage,prompt,trace_context";
/** Langfuse cuts metadata values at 200 characters unless their keys are expanded. */
const METADATA_PREVIEW_CHARS = 200;
/** Trace ids remembered so a trace with two root observations is imported once. */
const REMEMBERED_TRACE_IDS = 100_000;

/** The Langfuse project an import reads and how it waits. */
export interface LangfuseConnection {
  /** The API's base URL, `https://cloud.langfuse.com` or a self-hosted origin, without a trailing
   * slash. */
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  fetch?: typeof fetch;
  /** Waits `ms`; resolves early when the import is stopped. */
  sleep: (ms: number) => Promise<void>;
  signal: AbortSignal;
  /** Told about each wait for a rate limit or a failed request, in whole seconds. */
  onWait?: (seconds: number, reason: string) => void;
}

/** A request Langfuse refused or did not answer; `fatal` stops the whole import. */
export class LangfuseError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly fatal = false,
  ) {
    super(message);
    this.name = "LangfuseError";
  }
}

/** The import was stopped while a request was waiting. */
export class ImportStopped extends Error {
  constructor() {
    super("Stopped");
    this.name = "ImportStopped";
  }
}

/** A trace's time window, as ISO 8601 instants. */
export interface ImportWindow {
  from?: string;
  to?: string;
}

/** The API a Langfuse deployment reads traces through: `v2` (Langfuse Cloud and self-hosted v4
 * and later, observations with cursor pages) or `v1` (self-hosted v3, traces and observations
 * with numbered pages). */
export type LangfuseApiVersion = "v1" | "v2";

/** A Langfuse observation as the v1 or v2 API returns it, only the fields the import reads. */
export interface LangfuseObservation {
  id: string;
  traceId: string;
  type?: string;
  name?: string;
  startTime: string;
  endTime?: string;
  completionStartTime?: string;
  parentObservationId?: string;
  level?: string;
  statusMessage?: string;
  version?: string;
  environment?: string;
  input?: unknown;
  output?: unknown;
  metadata?: unknown;
  model?: string;
  modelParameters?: unknown;
  usageDetails?: Record<string, unknown>;
  costDetails?: Record<string, unknown>;
  promptName?: string;
  promptVersion?: number;
  userId?: string;
  sessionId?: string;
  traceName?: string;
  tags?: string[];
  release?: string;
}

/** A Langfuse v1 trace, the fields the import reads. */
export interface LangfuseTrace {
  id: string;
  timestamp: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  metadata?: unknown;
  sessionId?: string;
  userId?: string;
  release?: string;
  version?: string;
  tags?: string[];
  public?: boolean;
  environment?: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;
}

/** An observation from an API answer, or undefined when it lacks the fields every span needs. */
export function readObservation(value: unknown): LangfuseObservation | undefined {
  const item = object(value);
  const id = text(item?.id);
  const traceId = text(item?.traceId);
  const startTime = text(item?.startTime);
  if (!item || !id || !traceId || !startTime) return undefined;
  const promptVersion = item.promptVersion;
  return {
    id,
    traceId,
    startTime,
    type: text(item.type),
    name: text(item.name),
    endTime: text(item.endTime),
    completionStartTime: text(item.completionStartTime),
    parentObservationId: text(item.parentObservationId),
    level: text(item.level),
    statusMessage: text(item.statusMessage),
    version: text(item.version),
    environment: text(item.environment),
    input: item.input,
    output: item.output,
    metadata: item.metadata,
    model: text(item.model),
    modelParameters: item.modelParameters,
    usageDetails: object(item.usageDetails),
    costDetails: object(item.costDetails),
    promptName: text(item.promptName),
    promptVersion:
      typeof promptVersion === "number" && Number.isSafeInteger(promptVersion)
        ? promptVersion
        : undefined,
    userId: text(item.userId),
    sessionId: text(item.sessionId),
    traceName: text(item.traceName),
    tags: strings(item.tags),
    release: text(item.release),
  };
}

/** A v1 trace from an API answer, or undefined when it lacks an id or timestamp. */
export function readTrace(value: unknown): LangfuseTrace | undefined {
  const item = object(value);
  const id = text(item?.id);
  const timestamp = text(item?.timestamp);
  if (!item || !id || !timestamp) return undefined;
  return {
    id,
    timestamp,
    name: text(item.name),
    input: item.input,
    output: item.output,
    metadata: item.metadata,
    sessionId: text(item.sessionId),
    userId: text(item.userId),
    release: text(item.release),
    version: text(item.version),
    tags: strings(item.tags),
    public: typeof item.public === "boolean" ? item.public : undefined,
    environment: text(item.environment),
  };
}

/** The wait a `Retry-After` header asks for (seconds or an HTTP date), or undefined. */
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d{1,7}$/u.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** A response body read up to `max` bytes; undefined past it. */
async function readBounded(response: Response, max: number): Promise<Buffer | undefined> {
  const declared = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

/** Whether a numbered page has pages after it: as its `meta.totalPages` says, or, without one,
 * when it came back full. */
function morePages(page: { data: unknown[]; meta: unknown }, number: number, limit: number) {
  const total = object(page.meta)?.totalPages;
  if (typeof total === "number" && Number.isSafeInteger(total))
    return page.data.length > 0 && number < total;
  return page.data.length >= limit;
}

/** The cursor of the page after `page`; a cursor that does not move would read it forever. */
function nextCursor(page: { meta: unknown }, current: string | undefined): string | undefined {
  const next = text(object(page.meta)?.cursor);
  if (next !== undefined && next === current)
    throw new LangfuseError("Langfuse answered the same page cursor twice");
  return next;
}

/** An answer read whole: its status and body, or `tooLarge` for a body past the bound. */
type Answer = ({ status: number; body: Buffer } | { status: number; tooLarge: true }) & {
  /** A redirect's `Location`, which no request follows itself. */
  location?: string;
};

/** Reads one Langfuse project through its public API with Basic authentication. */
export class LangfuseApi {
  private readonly fetchImpl: typeof fetch;
  private readonly authorization: string;
  private readonly seen = new Set<string>();

  constructor(private readonly connection: LangfuseConnection) {
    this.fetchImpl = connection.fetch ?? globalThis.fetch;
    this.authorization = `Basic ${Buffer.from(`${connection.publicKey}:${connection.secretKey}`).toString("base64")}`;
  }

  private stopped(): void {
    if (this.connection.signal.aborted) throw new ImportStopped();
  }

  private async wait(ms: number, reason: string): Promise<void> {
    this.connection.onWait?.(Math.ceil(ms / 1000), reason);
    await this.connection.sleep(ms);
    this.stopped();
  }

  /**
   * One GET with retries: a rate limit (HTTP 429) is waited out for as long as its `Retry-After`
   * asks (up to 15 minutes, ten times in a row), and a connection failure, a timeout or a 5xx is
   * tried again after 1, 2, 4, 8 and 16 seconds (or its `Retry-After`, up to a minute). No
   * redirect is followed (its `Location` is answered), so the keys go only to the configured host
   * and a media download reaches only links {@link LangfuseApi.media} checked; `authenticated` is
   * false for a presigned media download, which carries no Langfuse keys.
   */
  async get(
    url: URL,
    authenticated = true,
    maxBytes = MAX_RESPONSE_BYTES,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Answer> {
    let failures = 0;
    let limited = 0;
    for (;;) {
      this.stopped();
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          headers: {
            accept: "application/json",
            "user-agent": `hue-sdk-typescript/${sdkVersion} hue-import`,
            ...(authenticated ? { authorization: this.authorization } : {}),
          },
          redirect: "manual",
          signal: AbortSignal.any([this.connection.signal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch {
        this.stopped();
        if (failures >= RETRY_DELAYS_MS.length)
          throw new LangfuseError("Langfuse could not be reached");
        await this.wait(RETRY_DELAYS_MS[failures++]!, "Langfuse could not be reached");
        continue;
      }
      const status = response.status;
      if (status === 429) {
        await response.body?.cancel().catch(() => undefined);
        if (limited++ >= MAX_RATE_LIMITED)
          throw new LangfuseError("Langfuse kept refusing requests for their rate (HTTP 429)", 429);
        const asked = retryAfter(response.headers.get("retry-after"));
        await this.wait(
          Math.min(MAX_RETRY_AFTER_MS, asked ?? RETRY_DELAYS_MS[Math.min(limited, 4)]!),
          "Langfuse rate limit",
        );
        continue;
      }
      if (status >= 500 || status === 408) {
        await response.body?.cancel().catch(() => undefined);
        if (failures >= RETRY_DELAYS_MS.length)
          throw new LangfuseError(`Langfuse answered HTTP ${status}`, status);
        const asked = retryAfter(response.headers.get("retry-after"));
        await this.wait(
          asked === undefined ? RETRY_DELAYS_MS[failures]! : Math.min(60_000, asked),
          `Langfuse answered HTTP ${status}`,
        );
        failures++;
        continue;
      }
      const location = status >= 300 && status < 400 ? response.headers.get("location") : null;
      if (location !== null) {
        await response.body?.cancel().catch(() => undefined);
        return { status, body: Buffer.alloc(0), location };
      }
      let body: Buffer | undefined;
      try {
        body = await readBounded(response, maxBytes);
      } catch {
        this.stopped();
        if (failures >= RETRY_DELAYS_MS.length)
          throw new LangfuseError("Langfuse's answer could not be read");
        await this.wait(RETRY_DELAYS_MS[failures++]!, "Langfuse's answer could not be read");
        continue;
      }
      return body === undefined ? { status, tooLarge: true } : { status, body };
    }
  }

  /** A GET of `path` under the API, answered with JSON; refusals of the keys are fatal. */
  private async json(
    path: string,
    query: Record<string, string | undefined>,
  ): Promise<{ status: number; json?: unknown; tooLarge?: true }> {
    const url = new URL(`${this.connection.baseUrl}${path}`);
    for (const [name, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(name, value);
    const answer = await this.get(url);
    if (answer.status === 401 || answer.status === 403)
      throw new LangfuseError(
        `Langfuse refused the keys (HTTP ${answer.status}); check LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and the host`,
        answer.status,
        true,
      );
    if (answer.status >= 300 && answer.status < 400)
      throw new LangfuseError(
        `Langfuse redirected the request (HTTP ${answer.status}); set the host to the address it redirects to`,
        answer.status,
        true,
      );
    if ("tooLarge" in answer) return { status: answer.status, tooLarge: true };
    if (answer.status !== 200) return { status: answer.status };
    try {
      return { status: 200, json: JSON.parse(answer.body.toString("utf8")) as unknown };
    } catch {
      throw new LangfuseError("Langfuse answered with something other than JSON", 200);
    }
  }

  /** Which API the deployment reads traces through: v2 unless it answers that it has none. */
  async version(): Promise<LangfuseApiVersion> {
    const answer = await this.json("/api/public/v2/observations", { limit: "1", fields: "core" });
    if (answer.status === 200) return "v2";
    if (answer.status === 404) return "v1";
    throw new LangfuseError(`Langfuse answered HTTP ${answer.status}`, answer.status, true);
  }

  /** Whether a trace id has not been listed before in this import. */
  private first(traceId: string): boolean {
    if (this.seen.has(traceId)) return false;
    this.seen.add(traceId);
    if (this.seen.size > REMEMBERED_TRACE_IDS) this.seen.delete(this.seen.values().next().value!);
    return true;
  }

  /** The ids of the traces whose root observations started in the window, newest first. */
  async *rootTraceIds(window: ImportWindow): AsyncGenerator<string> {
    let cursor: string | undefined;
    let size = 0;
    for (;;) {
      const answer = await this.json("/api/public/v2/observations", {
        isRootObservation: "true",
        fields: "core",
        limit: String(ROOT_PAGE_SIZES[size]),
        fromStartTime: window.from,
        toStartTime: window.to,
        cursor,
      });
      if (answer.tooLarge || answer.status === 413) {
        if (size === ROOT_PAGE_SIZES.length - 1)
          throw new LangfuseError("Langfuse's list of traces is too large to read");
        size++;
        continue;
      }
      const page = this.page(answer, "observations");
      for (const item of page.data) {
        const traceId = text(object(item)?.traceId);
        if (traceId && this.first(traceId)) yield traceId;
      }
      cursor = nextCursor(page, cursor);
      if (!cursor) return;
    }
  }

  /** A trace's observations through the v2 API, a page at a time. */
  async *v2Observations(traceId: string): AsyncGenerator<LangfuseObservation[]> {
    let cursor: string | undefined;
    let size = 0;
    for (;;) {
      const query = {
        traceId,
        fields: V2_FIELDS,
        limit: String(PAGE_SIZES[size]),
        cursor,
      };
      let answer = await this.json("/api/public/v2/observations", query);
      if (answer.tooLarge || answer.status === 413) {
        if (size === PAGE_SIZES.length - 1)
          throw new LangfuseError("An observation is too large to read from Langfuse");
        size++;
        continue;
      }
      let page = this.page(answer, "observations");
      // Metadata values past Langfuse's preview length were cut: their keys are asked for whole.
      const cut = new Set<string>();
      for (const item of page.data)
        for (const [key, value] of Object.entries(object(object(item)?.metadata) ?? {}))
          if (typeof value === "string" && value.length >= METADATA_PREVIEW_CHARS) cut.add(key);
      if (cut.size) {
        answer = await this.json("/api/public/v2/observations", {
          ...query,
          expandMetadata: [...cut].join(","),
        });
        if (answer.tooLarge || answer.status === 413) {
          if (size === PAGE_SIZES.length - 1)
            throw new LangfuseError("An observation is too large to read from Langfuse");
          size++;
          continue;
        }
        page = this.page(answer, "observations");
      }
      yield this.observations(page.data);
      cursor = nextCursor(page, cursor);
      if (!cursor) return;
    }
  }

  /** The v1 traces whose timestamp falls in the window, newest first. */
  async *v1Traces(window: ImportWindow): AsyncGenerator<LangfuseTrace> {
    let number = 1;
    let size = 1;
    for (;;) {
      const limit = PAGE_SIZES[size]!;
      const answer = await this.json("/api/public/traces", {
        page: String(number),
        limit: String(limit),
        fromTimestamp: window.from,
        toTimestamp: window.to,
        orderBy: "timestamp.desc",
        fields: "core,io",
      });
      if (answer.tooLarge || answer.status === 413) {
        if (size === PAGE_SIZES.length - 1)
          throw new LangfuseError("A trace is too large to read from Langfuse");
        number = (number - 1) * PAGE_SPLITS[size++]! + 1;
        continue;
      }
      const page = this.page(answer, "traces");
      for (const item of page.data) {
        const trace = readTrace(item);
        if (!trace) throw new LangfuseError("Langfuse listed a trace without an id or timestamp");
        if (this.first(trace.id)) yield trace;
      }
      if (!morePages(page, number, limit)) return;
      number++;
    }
  }

  /** One v1 trace by id, or undefined when Langfuse holds none. */
  async v1Trace(traceId: string): Promise<LangfuseTrace | undefined> {
    const answer = await this.json(`/api/public/traces/${encodeURIComponent(traceId)}`, {
      fields: "core,io",
    });
    if (answer.status === 404) return undefined;
    if (answer.tooLarge) throw new LangfuseError("The trace is too large to read from Langfuse");
    if (answer.status !== 200) throw new LangfuseError(`Langfuse answered HTTP ${answer.status}`);
    const trace = readTrace(answer.json);
    if (!trace) throw new LangfuseError("Langfuse answered a trace without an id or timestamp");
    return trace;
  }

  /** A trace's observations through the v1 API, a page at a time. */
  async *v1Observations(traceId: string): AsyncGenerator<LangfuseObservation[]> {
    let number = 1;
    let size = 0;
    for (;;) {
      const limit = PAGE_SIZES[size]!;
      const answer = await this.json("/api/public/observations", {
        traceId,
        page: String(number),
        limit: String(limit),
      });
      if (answer.tooLarge || answer.status === 413) {
        if (size === PAGE_SIZES.length - 1)
          throw new LangfuseError("An observation is too large to read from Langfuse");
        number = (number - 1) * PAGE_SPLITS[size++]! + 1;
        continue;
      }
      const page = this.page(answer, "observations");
      yield this.observations(page.data);
      if (!morePages(page, number, limit)) return;
      number++;
    }
  }

  private page(
    answer: { status: number; json?: unknown },
    what: string,
  ): { data: unknown[]; meta: unknown } {
    if (answer.status !== 200)
      throw new LangfuseError(
        `Langfuse answered HTTP ${answer.status} when listing ${what}`,
        answer.status,
      );
    const body = object(answer.json);
    if (!body || !Array.isArray(body.data))
      throw new LangfuseError(`Langfuse answered a list of ${what} without data`);
    return { data: body.data as unknown[], meta: body.meta };
  }

  private observations(data: unknown[]): LangfuseObservation[] {
    return data.map((item) => {
      const observation = readObservation(item);
      if (!observation)
        throw new LangfuseError(
          "Langfuse listed an observation without an id, trace id or start time",
        );
      return observation;
    });
  }

  /**
   * A media file's bytes through `GET /api/public/media/{id}` and the download link it answers
   * (fetched without the Langfuse keys): `missing` when Langfuse holds no bytes for it (no record,
   * no link, or a link whose object is gone), `tooLarge` past {@link MAX_FILE_DATA_BYTES}. The link
   * and each redirect from it must pass {@link refusedDownload}; one that does not fails the file.
   */
  async media(id: string): Promise<Uint8Array | "missing" | "tooLarge"> {
    const answer = await this.json(`/api/public/media/${encodeURIComponent(id)}`, {});
    if (answer.status === 404 || answer.status === 400) return "missing";
    if (answer.status !== 200 || answer.tooLarge)
      throw new LangfuseError(`Langfuse answered HTTP ${answer.status} for a media file`);
    const record = object(answer.json);
    const length = record?.contentLength;
    if (typeof length === "number" && length > MAX_FILE_DATA_BYTES) return "tooLarge";
    let url: URL;
    try {
      url = new URL(text(record?.url) ?? "");
    } catch {
      return "missing";
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return "missing";
    const langfuse = new URL(this.connection.baseUrl);
    for (let redirects = 0; ; redirects++) {
      const refused = await refusedDownload(url, langfuse, this.connection.signal);
      this.stopped();
      if (refused) throw new LangfuseError(`Langfuse named a media download link that ${refused}`);
      const download = await this.get(url, false, MAX_FILE_DATA_BYTES, DOWNLOAD_TIMEOUT_MS);
      if (download.location !== undefined) {
        if (redirects === MAX_DOWNLOAD_REDIRECTS)
          throw new LangfuseError("The media download redirected too many times");
        try {
          url = new URL(download.location, url);
        } catch {
          throw new LangfuseError("The media download redirected to something other than a URL");
        }
        continue;
      }
      if ("tooLarge" in download) return download.status === 200 ? "tooLarge" : "missing";
      if (download.status === 200) return new Uint8Array(download.body);
      if ([403, 404, 410].includes(download.status)) return "missing";
      throw new LangfuseError(`The media download answered HTTP ${download.status}`);
    }
  }
}

/** Addresses a media download may not reach: this machine, private networks, link-local
 * (cloud metadata), shared, benchmarking, multicast and reserved ranges. IPv4-mapped IPv6
 * addresses are checked as their IPv4 address. */
const INTERNAL_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  INTERNAL_ADDRESSES.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  INTERNAL_ADDRESSES.addSubnet(network, prefix, "ipv6");

/** Whether an IP address is one {@link INTERNAL_ADDRESSES} holds; false for anything else. */
export function isInternalAddress(address: string): boolean {
  const version = isIP(address);
  return version !== 0 && INTERNAL_ADDRESSES.check(address, version === 4 ? "ipv4" : "ipv6");
}

/**
 * Why a media download link is refused, or undefined when it may be fetched: it must be HTTPS
 * (plain HTTP only to this machine), at most 8192 characters, without credentials or a fragment,
 * and name a host whose every address is public, unless it names the configured Langfuse host or
 * that host is on this machine. Langfuse chooses the link, so this keeps a hostile or compromised
 * deployment from sending requests to this machine's network. The name's lookup gives up after a
 * minute or once `signal` stops the import.
 */
export async function refusedDownload(
  url: URL,
  langfuse: URL,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (url.href.length > MAX_LINK_LENGTH) return "is too long";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname)))
    return "does not use https";
  if (url.username || url.password || url.hash) return "carries credentials or a fragment";
  if (isLoopbackHost(langfuse.hostname) || url.hostname === langfuse.hostname) return undefined;
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  const named = host === "localhost" || host.endsWith(".localhost");
  // shortcut: the name is resolved apart from the request's own lookup, so a host that answers a
  // second lookup differently (DNS rebinding) is not caught; pin the lookup if fetch gains a hook.
  let addresses: string[];
  try {
    addresses =
      named || isIP(host)
        ? [named ? "127.0.0.1" : host]
        : await resolved(host, AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]));
  } catch {
    return "names a host that could not be resolved";
  }
  if (addresses.length === 0 || addresses.some(isInternalAddress))
    return "names an address on this machine or a private network";
  return undefined;
}

/** Every address `host` resolves to; rejects once `signal` aborts, since a lookup cannot be
 * cancelled. */
function resolved(host: string, signal: AbortSignal): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new Error("The lookup was abandoned"));
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    lookup(host, { all: true }).then(
      (entries) => resolve(entries.map((entry) => entry.address)),
      reject,
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------------------------

const HEX32 = /^[0-9a-f]{32}$/u;
const HEX16 = /^[0-9a-f]{16}$/u;

function digestHex(input: string, length: number): string {
  for (let salt = 0; ; salt++) {
    const hex = createHash("sha256")
      .update(salt ? `${input}#${salt}` : input)
      .digest("hex")
      .slice(0, length);
    if (!/^0+$/u.test(hex)) return hex;
  }
}

/** The OpenTelemetry trace id of a Langfuse trace: its own id when it is one (32 lowercase hex
 * digits, as the Langfuse OpenTelemetry SDKs write), otherwise one derived from it by SHA-256, so
 * the same trace always takes the same id. */
export function hueTraceId(langfuseTraceId: string): string {
  return HEX32.test(langfuseTraceId) && !/^0+$/u.test(langfuseTraceId)
    ? langfuseTraceId
    : digestHex(`langfuse.trace:${langfuseTraceId}`, 32);
}

/** The OpenTelemetry span id of a Langfuse observation: its own id when it is one (16 lowercase
 * hex digits), otherwise one derived from the trace's and its own id. */
export function hueSpanId(langfuseTraceId: string, observationId: string): string {
  return HEX16.test(observationId) && !/^0+$/u.test(observationId)
    ? observationId
    : digestHex(`langfuse.observation:${langfuseTraceId}:${observationId}`, 16);
}

/** The span id of the span that stands for a v1 trace itself. */
export function traceSpanId(langfuseTraceId: string): string {
  return digestHex(`langfuse.trace-span:${langfuseTraceId}`, 16);
}

/** An ISO 8601 instant as OpenTelemetry time, keeping up to nanosecond digits; undefined for
 * anything else. */
export function hrTimeOf(value: string | undefined): HrTime | undefined {
  if (!value) return undefined;
  const match =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/iu.exec(
      value.trim(),
    );
  if (!match) return undefined;
  const zone = match[4] === undefined || match[4].toUpperCase() === "Z" ? "Z" : match[4];
  const millis = Date.parse(
    `${match[1]}T${match[2]}${zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone}`,
  );
  if (!Number.isFinite(millis) || millis < 0) return undefined;
  return [Math.floor(millis / 1000), Number((match[3] ?? "").padEnd(9, "0"))];
}

function later(a: HrTime, b: HrTime): HrTime {
  return a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]) ? a : b;
}

/** The time a set of spans covers, from the earliest start to the latest end. */
export interface TimeBounds {
  start: HrTime;
  end: HrTime;
}

function earlier(a: HrTime, b: HrTime): HrTime {
  return later(a, b) === a ? b : a;
}

/** `bounds` widened to cover `span`. */
export function widen(bounds: TimeBounds | undefined, span: TimeBounds): TimeBounds {
  return bounds
    ? { start: earlier(bounds.start, span.start), end: later(bounds.end, span.end) }
    : { start: span.start, end: span.end };
}

function minus(end: HrTime, start: HrTime): HrTime {
  let seconds = end[0] - start[0];
  let nanos = end[1] - start[1];
  if (nanos < 0) {
    seconds -= 1;
    nanos += 1_000_000_000;
  }
  return [seconds, nanos];
}

/** A Langfuse value as attribute text: a string as it is, anything else as its JSON. */
function attributeText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value === "" ? undefined : value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Metadata as the Langfuse SDKs record it on a span: one attribute per top-level key under
 * `prefix`, a string as it is and any other value as its JSON; metadata that is no object is
 * recorded whole under `prefix`. */
function metadataAttributes(
  prefix: string,
  metadata: unknown,
  into: Record<string, AttributeValue>,
): void {
  const fields = object(metadata);
  if (!fields) {
    const whole = attributeText(metadata);
    if (whole !== undefined) into[prefix] = whole;
    return;
  }
  for (const [key, value] of Object.entries(fields)) {
    const recorded = attributeText(value);
    if (recorded !== undefined && key !== "") into[`${prefix}.${key}`] = recorded;
  }
}

/** A span before it is handed to the exporter. */
export interface ImportSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  start: HrTime;
  end: HrTime;
  attributes: Record<string, AttributeValue>;
  /** Set for an observation at level `ERROR`: the span's status is an error with this message. */
  error?: string;
}

/** What a v1 trace gives each of its observations, as the Langfuse SDKs propagate it. */
export interface TraceContext {
  langfuseTraceId: string;
  /** The v1 trace's own span, the parent of its observations without one. */
  rootSpanId?: string;
  name?: string;
  userId?: string;
  sessionId?: string;
  tags?: string[];
  release?: string;
}

function setText(into: Record<string, AttributeValue>, key: string, value: string | undefined) {
  if (value !== undefined && value !== "") into[key] = value;
}

/**
 * A Langfuse observation as the span the Langfuse OpenTelemetry SDKs would have recorded:
 * `langfuse.observation.*` (type in lower case, input, output, one `metadata.<key>` attribute per
 * key, level, status message, model, model parameters, usage and cost details, completion start,
 * prompt), `langfuse.trace.name`, `langfuse.trace.tags`, `langfuse.user.id`,
 * `langfuse.session.id`, `langfuse.release`, `langfuse.version` and `langfuse.environment`, with
 * `gen_ai.request.model` and the input and output token counts as GenAI attributes. The
 * observation's and trace's own ids are kept as `langfuse.observation.id` and
 * `langfuse.trace.id`. Throws for a start time that is no ISO 8601 instant.
 */
export function observationSpan(
  observation: LangfuseObservation,
  context: TraceContext,
): ImportSpan {
  const start = hrTimeOf(observation.startTime);
  if (!start) throw new LangfuseError("An observation's start time is not an ISO 8601 instant");
  // An observation without an end (an event, or one never ended) lasts no time.
  const end = later(hrTimeOf(observation.endTime) ?? start, start);
  const type = observation.type?.toLowerCase();
  const attributes: Record<string, AttributeValue> = {};
  setText(attributes, "langfuse.observation.type", type);
  setText(attributes, "langfuse.observation.input", attributeText(observation.input));
  setText(attributes, "langfuse.observation.output", attributeText(observation.output));
  metadataAttributes("langfuse.observation.metadata", observation.metadata, attributes);
  setText(attributes, "langfuse.observation.level", observation.level);
  setText(attributes, "langfuse.observation.status_message", observation.statusMessage);
  if (observation.model) {
    attributes["langfuse.observation.model.name"] = observation.model;
    attributes["gen_ai.request.model"] = observation.model;
  }
  setText(
    attributes,
    "langfuse.observation.model.parameters",
    attributeText(observation.modelParameters),
  );
  const usage = observation.usageDetails;
  if (usage && Object.keys(usage).length) {
    attributes["langfuse.observation.usage_details"] = JSON.stringify(usage);
    for (const [field, key] of [
      ["input", "gen_ai.usage.input_tokens"],
      ["output", "gen_ai.usage.output_tokens"],
    ] as const) {
      const count = usage[field];
      if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
        attributes[key] = count;
    }
  }
  if (observation.costDetails && Object.keys(observation.costDetails).length)
    attributes["langfuse.observation.cost_details"] = JSON.stringify(observation.costDetails);
  setText(
    attributes,
    "langfuse.observation.completion_start_time",
    observation.completionStartTime,
  );
  setText(attributes, "langfuse.observation.prompt.name", observation.promptName);
  if (observation.promptVersion !== undefined)
    attributes["langfuse.observation.prompt.version"] = observation.promptVersion;
  setText(attributes, "langfuse.trace.name", observation.traceName ?? context.name);
  const tags = observation.tags ?? context.tags;
  if (tags?.length) attributes["langfuse.trace.tags"] = [...tags];
  setText(attributes, "langfuse.user.id", observation.userId ?? context.userId);
  setText(attributes, "langfuse.session.id", observation.sessionId ?? context.sessionId);
  setText(attributes, "langfuse.release", observation.release ?? context.release);
  setText(attributes, "langfuse.version", observation.version);
  setText(attributes, "langfuse.environment", observation.environment);
  attributes["langfuse.trace.id"] = context.langfuseTraceId;
  attributes["langfuse.observation.id"] = observation.id;
  const parent = observation.parentObservationId
    ? hueSpanId(context.langfuseTraceId, observation.parentObservationId)
    : context.rootSpanId;
  return {
    traceId: hueTraceId(context.langfuseTraceId),
    spanId: hueSpanId(context.langfuseTraceId, observation.id),
    ...(parent ? { parentSpanId: parent } : {}),
    name: observation.name ?? type ?? "observation",
    start,
    end,
    attributes,
    ...(observation.level === "ERROR" ? { error: observation.statusMessage ?? "" } : {}),
  };
}

/** The context a v1 trace gives its observations. */
export function traceContext(trace: LangfuseTrace): TraceContext {
  return {
    langfuseTraceId: trace.id,
    rootSpanId: traceSpanId(trace.id),
    name: trace.name,
    userId: trace.userId,
    sessionId: trace.sessionId,
    tags: trace.tags,
    release: trace.release,
  };
}

/**
 * The span that stands for a v1 trace, the parent of its observations without one, as the trace
 * Langfuse shows above them: `langfuse.trace.*` (name, input, output, one `metadata.<key>`
 * attribute per key, tags, public), the user, session, release, version and environment. It
 * covers the trace's timestamp and its observations, `observed`. Throws for a timestamp that is
 * no ISO 8601 instant.
 */
export function traceSpan(trace: LangfuseTrace, observed: TimeBounds | undefined): ImportSpan {
  const timestamp = hrTimeOf(trace.timestamp);
  if (!timestamp) throw new LangfuseError("A trace's timestamp is not an ISO 8601 instant");
  // An observation can start before the trace's own timestamp: the span covers both.
  const start = observed ? earlier(timestamp, observed.start) : timestamp;
  const attributes: Record<string, AttributeValue> = {};
  setText(attributes, "langfuse.trace.name", trace.name);
  setText(attributes, "langfuse.trace.input", attributeText(trace.input));
  setText(attributes, "langfuse.trace.output", attributeText(trace.output));
  metadataAttributes("langfuse.trace.metadata", trace.metadata, attributes);
  if (trace.tags?.length) attributes["langfuse.trace.tags"] = [...trace.tags];
  if (trace.public !== undefined) attributes["langfuse.trace.public"] = trace.public;
  setText(attributes, "langfuse.user.id", trace.userId);
  setText(attributes, "langfuse.session.id", trace.sessionId);
  setText(attributes, "langfuse.release", trace.release);
  setText(attributes, "langfuse.version", trace.version);
  setText(attributes, "langfuse.environment", trace.environment);
  attributes["langfuse.trace.id"] = trace.id;
  return {
    traceId: hueTraceId(trace.id),
    spanId: traceSpanId(trace.id),
    name: trace.name ?? "trace",
    start,
    end: observed ? later(observed.end, start) : start,
    attributes,
  };
}

/** A converted span as the OpenTelemetry SDK hands a finished span to a processor. */
export function readableSpan(
  span: ImportSpan,
  resource: Resource,
  scope: { name: string },
): ReadableSpan {
  const context = { traceId: span.traceId, spanId: span.spanId, traceFlags: TraceFlags.SAMPLED };
  return {
    name: span.name,
    kind: SpanKind.INTERNAL,
    spanContext: () => context,
    ...(span.parentSpanId
      ? {
          parentSpanContext: {
            traceId: span.traceId,
            spanId: span.parentSpanId,
            traceFlags: TraceFlags.SAMPLED,
          },
        }
      : {}),
    startTime: span.start,
    endTime: span.end,
    duration: minus(span.end, span.start),
    status:
      span.error === undefined
        ? { code: SpanStatusCode.UNSET }
        : { code: SpanStatusCode.ERROR, ...(span.error ? { message: span.error } : {}) },
    attributes: span.attributes,
    links: [],
    events: [],
    ended: true,
    resource,
    instrumentationScope: scope,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------------------------

/** A Langfuse media reference, as the Langfuse SDKs write it in place of a file they uploaded. */
export interface MediaToken {
  type: string;
  id: string;
  source: string;
}

const TOKEN_MARK = "@@@langfuseMedia:";
const EMBEDDED_TOKENS = /@@@langfuseMedia:[^@]*@@@/gu;

/** The token a whole string is (`@@@langfuseMedia:type=<media type>|id=<id>|source=<source>@@@`),
 * or undefined when it is not exactly one. */
export function parseMediaToken(value: string): MediaToken | undefined {
  if (!value.startsWith(TOKEN_MARK) || !value.endsWith("@@@")) return undefined;
  const inner = value.slice(TOKEN_MARK.length, -3);
  if (inner.includes("@") || /\s/u.test(inner)) return undefined;
  const fields = new Map<string, string>();
  for (const field of inner.split("|")) {
    const equals = field.indexOf("=");
    if (equals === -1) return undefined;
    const name = field.slice(0, equals);
    if (fields.has(name)) return undefined;
    fields.set(name, field.slice(equals + 1));
  }
  const type = fields.get("type");
  const id = fields.get("id");
  const source = fields.get("source");
  if (!type || !id || !source || !/^[A-Za-z0-9_-]{1,128}$/u.test(id) || !isMediaContentType(type))
    return undefined;
  return { type, id, source };
}

function countTokens(value: string): number {
  let count = 0;
  for (const match of value.matchAll(EMBEDDED_TOKENS)) if (parseMediaToken(match[0])) count++;
  return count;
}

/** The span attributes whose text Hue reads files from and the import rewrites tokens in. */
export function isMediaAttribute(key: string): boolean {
  return (
    key === "langfuse.observation.input" ||
    key === "langfuse.observation.output" ||
    key === "langfuse.trace.input" ||
    key === "langfuse.trace.output" ||
    key === "langfuse.observation.metadata" ||
    key === "langfuse.trace.metadata" ||
    key.startsWith("langfuse.observation.metadata.") ||
    key.startsWith("langfuse.trace.metadata.")
  );
}

/** One token found where Hue reads a file, and the place it takes once its bytes are uploaded. */
export interface MediaUse {
  attribute: string;
  token: MediaToken;
  /** The token's JSON pointer in the attribute's value. */
  pointer: string;
  /** The `hue.blobs` key the file is listed under: `<attribute>#<pointer of its part>`. */
  key: string;
}

/** The tokens of one attribute and the SDK's reading of its value with each token's place. */
interface AttributeMedia {
  attribute: string;
  uses: MediaUse[];
  media: MediaValue;
  /** The files of `media` at each use's pointer. */
  files: Map<string, InlineFilePart>;
}

/** The tokens a span carries: where each takes a file's place, and how many stay as they are
 * (inside longer text, deeper than Hue reads, or in a place Hue reads no file from). */
export interface SpanMedia {
  attributes: AttributeMedia[];
  kept: number;
}

/** What a token's file is replaced by when Hue reads it: a `data:` URL or bare base64 that the
 * SDK's own reader finds at the token's place. Its bytes are never read. */
function probe(token: MediaToken, kind: "url" | "base64"): string {
  return kind === "url" ? `data:${token.type};base64,AAAA` : "AAAA";
}

/** Each string of a parsed value that is exactly a token, replaced with `replace(token,
 * pointer)`; the tokens inside longer text are counted. Whether Hue reads a file at a token's
 * place (no deeper than ten levels, in a part it reads) is left to the SDK's
 * reader. The value nests at most 32 levels (`readerParses`). */
function walkTokens(
  value: unknown,
  replace: (token: MediaToken, pointer: string) => string,
): { found: { token: MediaToken; pointer: string }[]; kept: number; root?: string } {
  const found: { token: MediaToken; pointer: string }[] = [];
  let kept = 0;
  let root: string | undefined;
  const visit = (node: unknown, pointer: string, set: (next: string) => void): void => {
    if (typeof node === "string") {
      if (!node.includes(TOKEN_MARK)) return;
      const token = parseMediaToken(node);
      if (token) {
        found.push({ token, pointer });
        set(replace(token, pointer));
      } else kept += countTokens(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) =>
        visit(item, `${pointer}/${index}`, (next) => (node[index] = next)),
      );
      return;
    }
    const fields = object(node);
    if (!fields) return;
    for (const [key, item] of Object.entries(fields))
      visit(
        item,
        `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
        (next) => (fields[key] = next),
      );
  };
  visit(value, "", (next) => (root = next));
  return { found, kept, root };
}

/**
 * The tokens in an attribute's text, found as Hue reads that text: a text that is exactly one
 * token, or JSON Hue parses (not nested past 32 levels, with no integer past 2^53), its tokens no
 * deeper than ten levels. Each is placed by the SDK's own reader of recorded media: a token where
 * a provider part keeps its bytes (OpenAI `image_url.url` and `input_audio.data`, Anthropic
 * `source.data`, Gemini `inlineData.data`, a GenAI `blob` part's `content`, …) is that part's
 * file, and any other token is a whole-string file. Undefined when the text holds no token.
 */
function attributeMedia(
  attribute: string,
  textValue: string,
): { located?: AttributeMedia; kept: number } | undefined {
  if (!textValue.includes(TOKEN_MARK)) return undefined;
  const bare = parseMediaToken(textValue);
  const parse = (): unknown => {
    if (bare) return textValue;
    if (!/^\s*[[{"]/u.test(textValue)) return undefined;
    try {
      const parsed: unknown = JSON.parse(textValue);
      return readerParses(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
  const read = (choose: (token: MediaToken, pointer: string) => "url" | "base64") => {
    const value = parse();
    if (value === undefined) return undefined;
    const walked = walkTokens(value, (token, pointer) => probe(token, choose(token, pointer)));
    const root = walked.root ?? value;
    // A bare token is the text itself, not JSON: the reading's edits replace it whole.
    const media = bare ? mediaIn(root) : mediaIn(root, textValue);
    const files = new Map<string, InlineFilePart>();
    for (const file of media.files) files.set(file.pointer, file);
    return { walked, media, files };
  };
  const first = read(() => "url");
  if (!first) return { kept: countTokens(textValue) };
  // Tokens a `data:` URL does not fill are tried as bare base64 (an OpenAI `input_audio`, an
  // Anthropic or Gemini source): the part reads its bytes as base64 there.
  const missing = new Set(
    first.walked.found.filter(({ pointer }) => !first.files.has(pointer)).map((use) => use.pointer),
  );
  const chosen = missing.size
    ? read((_token, pointer) => (missing.has(pointer) ? "base64" : "url"))!
    : first;
  const uses: MediaUse[] = [];
  const files = new Map<string, InlineFilePart>();
  let kept = chosen.walked.kept;
  for (const { token, pointer } of chosen.walked.found) {
    const file = chosen.files.get(pointer);
    if (!file || file.encoded?.length) {
      kept++;
      continue;
    }
    files.set(pointer, file);
    uses.push({ attribute, token, pointer, key: `${attribute}#${file.partPointer}` });
  }
  return uses.length
    ? { located: { attribute, uses, media: chosen.media, files }, kept }
    : { kept };
}

/** The tokens of a span's media attributes. */
export function spanMedia(span: ImportSpan): SpanMedia {
  const result: SpanMedia = { attributes: [], kept: 0 };
  for (const [key, value] of Object.entries(span.attributes)) {
    if (typeof value !== "string" || !isMediaAttribute(key)) continue;
    const found = attributeMedia(key, value);
    if (!found) continue;
    result.kept += found.kept;
    if (found.located) result.attributes.push(found.located);
  }
  return result;
}

/** A token's file once its bytes were read and uploaded under the span's trace. */
export interface UploadedMedia {
  sha256: string;
  size: number;
  /** The media type Hue stored the file under. */
  contentType: string;
}

/** What became of one token's file. */
export type MediaOutcome =
  | { kind: "uploaded"; file: UploadedMedia }
  /** Langfuse holds no bytes for it, or more than an import reads: it stays a token. */
  | { kind: "kept" }
  /** Its bytes could not be read or stored now: the span is not sent, so a later run can. */
  | { kind: "failed"; reason: string };

/**
 * The span's attributes with each token whose file was uploaded in the digest form the SDK
 * writes for a recorded file, `{"type":"blob","mime_type","modality","sha256","size"}` for a
 * whole string or the provider part with its bytes removed and `sha256` and `size` set, every
 * other byte of the attribute's text kept, and each file listed under `hue.blobs` as
 * `<attribute>#<pointer>`. At most {@link MAX_BLOB_ENTRIES} files per span are placed; the rest
 * stay tokens. Returns how many were placed.
 */
export function placeMedia(
  span: ImportSpan,
  media: SpanMedia,
  outcomes: ReadonlyMap<MediaUse, UploadedMedia>,
): number {
  const entries: string[] = [];
  for (const located of media.attributes) {
    let changed = false;
    for (const use of located.uses) {
      const file = outcomes.get(use);
      if (!file) continue;
      digestPart(located.files.get(use.pointer)!, { sha256: file.sha256, size: file.size });
      entries.push(blobEntry(use.key, file.sha256, file.size, file.contentType));
      changed = true;
    }
    if (changed) span.attributes[located.attribute] = placedMediaText(located.media);
  }
  if (entries.length) span.attributes[BLOBS_KEY] = entries;
  return entries.length;
}

/** Whether Hue accepts a `hue.blobs` key: 1 to 256 code units, no control characters. A file
 * whose key it would refuse stays a token. */
function isBlobKey(key: string): boolean {
  if (key.length < 1 || key.length > 256) return false;
  for (let index = 0; index < key.length; index++) {
    const code = key.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** The uses of a span that may be uploaded: the first {@link MAX_BLOB_ENTRIES} with a key Hue
 * accepts. */
export function uploadableUses(media: SpanMedia): { uses: MediaUse[]; kept: number } {
  const uses: MediaUse[] = [];
  let kept = 0;
  for (const located of media.attributes)
    for (const use of located.uses) {
      if (uses.length < MAX_BLOB_ENTRIES && isBlobKey(use.key)) uses.push(use);
      else kept++;
    }
  return { uses, kept };
}

/**
 * Reads each file of a trace's tokens from Langfuse once and uploads it under the trace with the
 * SDK's upload route (reservation, presigned PUT, completion); another reference to the same
 * file in the trace reuses the outcome. Bytes are held only while their file uploads.
 */
export class TraceMedia {
  private readonly outcomes = new Map<string, Promise<MediaOutcome>>();

  constructor(
    private readonly api: LangfuseApi,
    private readonly uploader: BlobUploader,
    private readonly traceId: string,
    private readonly upload: () => UploadContext,
  ) {}

  /** The outcome for a token's file, read and uploaded on its first use in the trace. */
  file(use: MediaUse): Promise<MediaOutcome> {
    let outcome = this.outcomes.get(use.token.id);
    if (!outcome) {
      outcome = this.fresh(use);
      this.outcomes.set(use.token.id, outcome);
    }
    return outcome;
  }

  private async fresh(use: MediaUse): Promise<MediaOutcome> {
    let bytes: Uint8Array | "missing" | "tooLarge";
    try {
      bytes = await this.api.media(use.token.id);
    } catch (error) {
      if (error instanceof ImportStopped || (error instanceof LangfuseError && error.fatal))
        throw error;
      return { kind: "failed", reason: (error as Error).message };
    }
    if (typeof bytes === "string" || bytes.byteLength === 0) return { kind: "kept" };
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const stored = await this.uploader.store(
      this.traceId,
      use.key,
      bytes,
      use.token.type,
      { sha256, size: bytes.byteLength },
      this.upload(),
    );
    if (stored.ok)
      return {
        kind: "uploaded",
        file: { sha256, size: bytes.byteLength, contentType: stored.contentType },
      };
    // A file over Hue's limit for one value stays a token; any other refusal is tried again later.
    if (stored.reason === "tooLarge") return { kind: "kept" };
    return { kind: "failed", reason: FALLBACK_REASONS[stored.reason] };
  }
}

/**
 * The rest of a span's content stored as the SDK's exporter stores it, but before the span is
 * sent: files inline in the attributes Hue reads files from (a `data:` URL or base64 a provider
 * part holds) uploaded and placed in their digest form, and text values still over Hue's inline
 * limit (1 MiB of UTF-8, the limit Hue advertises) uploaded whole and replaced by their first
 * 16 KiB, each listed in `hue.blobs` (and a whole value in `hue.truncated`). This is the
 * exporter's own placement (`offloadAttributes`), run here so that a file or value that cannot be
 * stored now holds its span back rather than being kept inline or cut, and every run sends the
 * same span. A file or value over a limit (Hue's size limit, the span's 64 entries) is placed
 * alike on every run and only counted. Resolves to the reason the span is held back, if it is.
 */
export async function storeSpanContent(
  span: ImportSpan,
  uploader: BlobUploader,
  upload: UploadContext,
): Promise<{ heldBack?: string; stored: number; overLimits: number }> {
  const candidates = Object.entries(span.attributes).flatMap(([key, value]) =>
    typeof value === "string" &&
    (mayInlineFiles(key, value) || Buffer.byteLength(value, "utf8") > MAX_CONTENT_BYTES)
      ? [{ key, value }]
      : [],
  );
  if (!candidates.length) return { stored: 0, overLimits: 0 };
  const tally = newTally();
  // One attribute at a time, in the span's order: the exporter places a value's files and then
  // the value itself, so values placed together would take the span's last `hue.blobs` places in
  // the order their uploads finish, which a later run could reverse.
  let placed: Record<string, unknown> = span.attributes;
  for (const candidate of candidates) {
    placed = await offloadAttributes(
      placed,
      { candidates: [candidate], cut: [] },
      { uploader, traceId: span.traceId, valueBytes: MAX_CONTENT_BYTES, upload, tally },
    );
    for (const reason of ["unsupported", "failed"] as const)
      if (tally.fallbacks.has(reason))
        return { heldBack: FALLBACK_REASONS[reason], stored: 0, overLimits: 0 };
  }
  span.attributes = placed as Record<string, AttributeValue>;
  let overLimits = 0;
  for (const { count } of tally.fallbacks.values()) overLimits += count;
  return { stored: tally.uploaded, overLimits };
}

const FALLBACK_REASONS: Record<FallbackReason, string> = {
  unsupported: "this Hue server does not accept uploaded files",
  failed: "Hue did not store the file",
  tooLarge: "the file is over Hue's limit",
  budget: "the upload did not finish in time",
};
