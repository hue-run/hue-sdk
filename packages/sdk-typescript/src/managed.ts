import { createHash, timingSafeEqual } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { context, ROOT_CONTEXT, SpanStatusCode, trace, type Tracer } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { validateOptions } from "./config.js";
import { json, uuid } from "./evals/json.js";
import type { JsonValue } from "./types.js";

const MIB = 1024 * 1024;
const MAX_FILE = 25 * MIB;
const MAX_TOTAL = 64 * MIB;
const STATES = new Set([
  "queued",
  "dispatched",
  "running",
  "uncertain",
  "checkpointed",
  "completed",
  "unsupported",
  "error",
  "cancelled",
  "superseded",
]);
const propagator = new W3CTraceContextPropagator();

/** A declared input file the handler downloads and verifies before calling the target. */
export interface ManagedInputFile {
  /** Hue artifact ID. */
  artifactId: string;
  /** File name without path separators. */
  filename: string;
  /** MIME type. */
  contentType: string;
  /** Exact size in bytes; verified after download. */
  byteSize: number;
  /** Lowercase hex SHA-256 of the bytes; verified after download. */
  sha256: string;
  /** Caller-defined role of the file in the case, up to 64 characters. */
  role: string;
}
/** The request body Hue POSTs to a managed target (protocol version 1). */
export interface ManagedInvocation {
  /** Always 1. */
  protocolVersion: 1;
  /** Execution to claim and complete. */
  executionId: string;
  /** Attempt number, starting at 1. */
  attempt: number;
  /** Frozen case inputs. */
  input: JsonValue;
  /** Experiment configuration. */
  config: JsonValue;
  /** Up to 16 declared input files. */
  inputFiles: ManagedInputFile[];
  /** RFC 3339 UTC deadline for the whole invocation. */
  deadline: string;
  /** Sampled W3C `traceparent` the target span must continue. */
  traceparent: string;
}
/** What the target callback receives after the claim and file verification succeed. */
export interface ManagedTargetContext {
  /** Execution being run. */
  executionId: string;
  /** Attempt number, starting at 1. */
  attempt: number;
  /** Frozen case inputs. */
  input: JsonValue;
  /** Experiment configuration. */
  config: JsonValue;
  /** Verified input files with their bytes. */
  inputFiles: Array<
    ManagedInputFile & {
      /** Verified file contents. */
      data: Uint8Array;
    }
  >;
  /** Aborts at the execution deadline; the target must honor it. */
  signal: AbortSignal;
  /** Trace ID of the `ai.managed_target` span the target runs under. */
  traceId: string;
}
/** A file the target returns for upload. */
export interface ManagedOutputFile {
  /** File name without path separators. */
  filename: string;
  /** MIME type. */
  contentType: string;
  /** Exact bytes to store, at most 25 MiB. */
  data: Uint8Array;
  /** Marks the single primary artifact of the outcome. */
  primary?: boolean;
}
/** The target callback's return value. */
export interface ManagedTargetResult {
  /** Outcome state; `succeeded` by default. */
  state?: "succeeded" | "error" | "cancelled";
  /** Output JSON; omitted means unavailable, `null` is a present output. */
  output?: JsonValue;
  /** Public, safe error summary. Never include provider errors, credentials or stacks. */
  error?: {
    /** Stable lowercase type such as `target_error`. */
    type: string;
    /** Bounded public message. */
    message?: string;
  };
  /** Up to 16 files, 64 MiB in total. */
  files?: ManagedOutputFile[];
  /** Provider-reported token usage, when known. */
  usage?: {
    /** Prompt tokens. */
    inputTokens?: number;
    /** Completion tokens. */
    outputTokens?: number;
  };
}
/** Options for {@link createManagedTargetHandler}. */
export interface ManagedTargetOptions {
  /** Dedicated shared secret Hue presents as a Bearer token; validated before any network access. */
  machineCredential: string;
  /** Hue origin for invocation callbacks, `https://app.hue.run` by default; never taken from a request. */
  baseUrl?: string;
  /** The application's existing agent function; called at most once per invocation. */
  target: (invocation: ManagedTargetContext) => Promise<ManagedTargetResult>;
  /** Flush the application's existing trace AND log pipelines; do not shut them down. */
  flushTelemetry: () => Promise<unknown>;
  /** Tracer that records under the incoming trace context; defaults to the global tracer, which must be configured. */
  tracer?: Tracer;
  /** Reserve finalization time inside the host's request limit. Default 90 seconds. */
  maxExecutionMillis?: number;
  /** Upload/checkpoint/flush grace after execution deadline, at most 30 seconds. */
  finalizationMillis?: number;
}

/**
 * Creates a machine-authenticated, framework-neutral POST handler that claims the invocation,
 * verifies input files, runs `target` under the incoming trace context, uploads output files,
 * saves the outcome and acknowledges telemetry. It never retries the target.
 *
 * @throws TypeError for an invalid credential, origin, budget or missing callbacks at construction.
 */
export function createManagedTargetHandler(
  options: ManagedTargetOptions,
): (request: Request) => Promise<Response> {
  token(options.machineCredential);
  const baseUrl = validateOptions({
    apiKey: "managed-invocation",
    serviceName: "managed-target",
    captureContent: false,
    baseUrl: options.baseUrl,
  }).baseUrl;
  const maxExecution = bounded(options.maxExecutionMillis ?? 90_000, 1, 90_000);
  const grace = bounded(options.finalizationMillis ?? 30_000, 1, 30_000);
  if (typeof options.target !== "function" || typeof options.flushTelemetry !== "function")
    throw new TypeError("target and flushTelemetry are required");
  const credential = createHash("sha256").update(`Bearer ${options.machineCredential}`).digest();
  return async (request) => {
    if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });
    const supplied = request.headers.get("authorization") ?? "";
    if (
      supplied.length > 8192 ||
      !timingSafeEqual(credential, createHash("sha256").update(supplied).digest())
    )
      return reply(401, { error: "authentication" });
    const began = Date.now();
    let invocation: ManagedInvocation;
    let invocationToken: string;
    try {
      invocationToken = token(request.headers.get("x-hue-invocation-token"));
      const body = await readBytes(request, MIB, AbortSignal.timeout(5_000));
      invocation = validateInvocation(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
      );
      if (Date.parse(invocation.deadline) <= Date.now())
        return reply(408, { error: "deadline_exceeded" });
    } catch {
      return reply(400, { error: "invalid_invocation" });
    }
    const executionEnd = Math.min(Date.parse(invocation.deadline), began + maxExecution);
    const finalEnd = Math.min(executionEnd + grace, began + maxExecution + grace);
    const signal = AbortSignal.timeout(Math.max(1, executionEnd - Date.now()));
    const api = new InvocationApi(baseUrl, invocationToken, invocation.executionId);
    const uncertain = () =>
      reply(503, { protocolVersion: 1, executionId: invocation.executionId, state: "uncertain" });
    let claim: Record<string, unknown>;
    try {
      claim = object(await api.json("POST", "/claim", {}, executionEnd));
      if (
        typeof claim.claimed !== "boolean" ||
        claim.executionId !== invocation.executionId ||
        !STATES.has(String(claim.state))
      )
        throw new Error();
    } catch {
      return uncertain();
    }
    if (!claim.claimed)
      return reply(409, {
        protocolVersion: 1,
        executionId: invocation.executionId,
        state: claim.state,
      });

    // The application's existing provider owns this span and every child. No global setup.
    const parent = propagator.extract(
      ROOT_CONTEXT,
      { traceparent: invocation.traceparent },
      {
        keys: (carrier) => Object.keys(carrier),
        get: (carrier, key) => carrier[key as "traceparent"],
      },
    );
    const span = (options.tracer ?? trace.getTracer("@hue-run/sdk/managed")).startSpan(
      "ai.managed_target",
      {
        attributes: {
          "hue.execution.id": invocation.executionId,
          "hue.execution.attempt": invocation.attempt,
        },
      },
      parent,
    );
    const spanContext = span.spanContext();
    if (!span.isRecording() || spanContext.traceId !== invocation.traceparent.split("-")[1]) {
      span.end();
      return uncertain();
    }
    let result: ManagedTargetResult;
    try {
      const inputFiles: ManagedTargetContext["inputFiles"] = [];
      for (const file of invocation.inputFiles) {
        const data = await api.bytes(`/inputs/${file.artifactId}`, file.byteSize, executionEnd);
        if (data.byteLength !== file.byteSize || sha256(data) !== file.sha256)
          throw new Error("input_integrity");
        inputFiles.push({ ...file, data });
      }
      // Synchronous input hashing or a busy event loop can exhaust the budget
      // before the abort timer runs. Do not start a paid callback in that gap.
      if (Date.now() >= executionEnd) throw new Error("deadline");
      signal.throwIfAborted();
      result = await within(
        context.with(trace.setSpan(parent, span), () =>
          options.target({
            executionId: invocation.executionId,
            attempt: invocation.attempt,
            input: invocation.input,
            config: invocation.config,
            inputFiles,
            signal,
            traceId: spanContext.traceId,
          }),
        ),
        signal,
      );
      validateResult(result);
    } catch {
      // A timed-out callback may still be running. Do not claim a terminal outcome for it.
      if (signal.aborted || Date.now() >= executionEnd) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        return uncertain();
      }
      result = {
        state: "error",
        error: { type: "target_error", message: "The target or input validation failed." },
      };
    }
    const artifactIds: string[] = [];
    let primaryArtifactId: string | undefined;
    let uploadFailed = false;
    for (const [index, file] of (result.files ?? []).entries()) {
      try {
        const hash = sha256(file.data);
        const reserved = object(
          await api.json(
            "POST",
            "/files",
            {
              idempotencyKey: `file:${index}:${hash}`,
              filename: file.filename,
              contentType: file.contentType,
              byteSize: file.data.byteLength,
              sha256: hash,
            },
            finalEnd,
            true,
          ),
        );
        const artifactId = uuid(reserved.artifactId as string);
        if (reserved.state !== "ready") {
          const uploadUrl = safeUploadUrl(reserved.uploadUrl);
          const headers = uploadHeaders(reserved.headers, file.contentType);
          // Never replay a signed write. Completion independently verifies the
          // stored hash, so it can settle a lost successful acknowledgement.
          try {
            await api.upload(uploadUrl, file.data, headers, finalEnd);
          } catch {
            /* Verify below. */
          }
          await api.json("POST", `/files/${artifactId}/complete`, {}, finalEnd, true);
        }
        artifactIds.push(artifactId);
        if (file.primary) primaryArtifactId = artifactId;
      } catch {
        uploadFailed = true;
      }
    }
    // Preserve every successfully uploaded secondary even when another file failed.
    if (uploadFailed)
      result = {
        ...result,
        state: "error",
        error: {
          type: "artifact_upload_failed",
          message: "One or more output files could not be stored.",
        },
      };
    const state = result.state ?? "succeeded";
    if (state !== "succeeded") span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
    const outcome = {
      protocolVersion: 1,
      executionId: invocation.executionId,
      state,
      ...(Object.hasOwn(result, "output") ? { output: result.output } : {}),
      ...(result.error ? { error: result.error } : {}),
      artifactIds,
      ...(primaryArtifactId ? { primaryArtifactId } : {}),
      traceId: spanContext.traceId,
      expectedSpanIds: [spanContext.spanId],
      ...(result.usage ? { usage: result.usage } : {}),
    };
    try {
      await api.json("POST", "/outcome", outcome, finalEnd, true);
    } catch {
      return uncertain();
    }
    const acknowledgement = {
      protocolVersion: 1,
      executionId: invocation.executionId,
      state: "checkpointed",
    };
    try {
      const remaining = finalEnd - Date.now();
      if (remaining <= 0) throw new Error();
      const flushed = await within(
        Promise.resolve().then(options.flushTelemetry),
        AbortSignal.timeout(remaining),
      );
      if (flushed === false) throw new Error("flush_failed");
      if (
        flushed &&
        typeof flushed === "object" &&
        ("pendingSpans" in flushed || "pendingLogs" in flushed)
      ) {
        // Hue's failure counters are cumulative; its flush throws for new failures.
        // Pending counters describe the current drain and must both be zero.
        const report = flushed as Record<string, unknown>;
        if (report.pendingSpans !== 0 || report.pendingLogs !== 0) throw new Error("flush_pending");
      }
      await api.json(
        "POST",
        "/telemetry",
        { expectedSpanIds: [spanContext.spanId], flushed: true },
        finalEnd,
        true,
      );
    } catch {
      return reply(200, { ...acknowledgement, telemetry: "pending" });
    }
    return reply(200, { ...acknowledgement, telemetry: "flushed" });
  };
}

class InvocationApi {
  constructor(
    private baseUrl: string,
    private invocationToken: string,
    private executionId: string,
  ) {}
  private url(path: string) {
    return `${this.baseUrl}/api/v1/managed-executions/${this.executionId}${path}`;
  }
  async json(
    method: string,
    path: string,
    value: unknown,
    deadline: number,
    retry = false,
  ): Promise<unknown> {
    const body = JSON.stringify(json(value, MIB));
    const bytes = await this.request(
      this.url(path),
      {
        method,
        headers: {
          authorization: `Bearer ${this.invocationToken}`,
          "content-type": "application/json",
        },
        body,
      },
      MIB,
      deadline,
      retry,
    );
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
  bytes(path: string, maximum: number, deadline: number) {
    return this.request(
      this.url(path),
      { headers: { authorization: `Bearer ${this.invocationToken}` } },
      maximum,
      deadline,
      false,
    );
  }
  async upload(url: string, data: Uint8Array, headers: Record<string, string>, deadline: number) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("deadline");
    const signal = AbortSignal.timeout(remaining);
    await new Promise<void>((resolve, reject) => {
      let activeResponse: import("node:http").IncomingMessage | undefined;
      const finish = (error?: Error) => {
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => {
        activeResponse?.destroy();
        request.destroy();
        finish(new Error("Hue managed upload failed"));
      };
      // Signed writes must not be replayed by fetch, redirect handling or a
      // reused-socket retry. A lost response is settled by Hue's verified read.
      const request = (new URL(url).protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: "PUT",
          agent: false,
          signal,
          maxHeaderSize: 16 * 1024,
          headers: { ...headers, "content-length": String(data.byteLength) },
        },
        (response) => {
          activeResponse = response;
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            response.destroy();
            finish(new Error("Hue managed upload failed"));
            return;
          }
          void (async () => {
            let length = 0;
            for await (const chunk of response) {
              signal.throwIfAborted();
              length += Buffer.byteLength(chunk);
              if (length > MIB) throw new Error("Upload response too large");
            }
            signal.throwIfAborted();
            finish();
          })().catch(() => {
            response.destroy();
            finish(new Error("Hue managed upload failed"));
          });
        },
      );
      request.once("error", () => finish(new Error("Hue managed upload failed")));
      signal.addEventListener("abort", abort, { once: true });
      request.end(Buffer.from(data));
    });
  }
  private async request(
    url: string,
    init: RequestInit,
    maximum: number,
    deadline: number,
    retry: boolean,
  ): Promise<Uint8Array> {
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("deadline");
      try {
        const signal = AbortSignal.timeout(remaining);
        const response = await fetch(url, { ...init, redirect: "error", signal });
        if (!response.ok) {
          await response.body?.cancel();
          if (![429, 500, 502, 503, 504].includes(response.status)) throw new PermanentError();
          throw new Error();
        }
        return await readBytes(response, maximum, signal);
      } catch (error) {
        if (
          !retry ||
          attempt >= 1 ||
          error instanceof PermanentError ||
          Date.now() + 100 >= deadline
        )
          throw new Error("Hue managed request failed");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}
class PermanentError extends Error {}
function reply(status: number, body: unknown) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
function sha256(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}
function token(value: unknown): string {
  // eslint-disable-next-line no-control-regex -- control characters are rejected deliberately
  if (typeof value !== "string" || !value || value.length > 8192 || /[\s\u0000]/u.test(value))
    throw new TypeError("Invalid credential");
  return value;
}
function bounded(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new TypeError("Invalid integer");
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Expected object");
  return value as Record<string, unknown>;
}
function filename(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 255 ||
    // eslint-disable-next-line no-control-regex -- control characters are rejected deliberately
    /[\x00-\x1f\x7f/\\]/u.test(value) ||
    value === "." ||
    value === ".."
  )
    throw new TypeError("Invalid filename");
  return value;
}
function shortString(value: unknown, maximum = 255): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maximum ||
    // eslint-disable-next-line no-control-regex -- control characters are rejected deliberately
    /[\x00-\x1f\x7f]/u.test(value)
  )
    throw new TypeError("Invalid string");
  return value;
}
function validateInvocation(value: unknown): ManagedInvocation {
  const v = object(json(value, MIB));
  if (
    Object.keys(v).some(
      (key) =>
        ![
          "protocolVersion",
          "executionId",
          "attempt",
          "input",
          "config",
          "inputFiles",
          "deadline",
          "traceparent",
        ].includes(key),
    )
  )
    throw new TypeError("Unknown invocation field");
  if (v.protocolVersion !== 1 || !Object.hasOwn(v, "input") || !Object.hasOwn(v, "config"))
    throw new TypeError("Invalid protocol");
  uuid(v.executionId as string);
  bounded(v.attempt, 1, Number.MAX_SAFE_INTEGER);
  if (
    typeof v.deadline !== "string" ||
    v.deadline.trim() !== v.deadline ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v.deadline) ||
    !Number.isFinite(Date.parse(v.deadline))
  )
    throw new TypeError("Invalid deadline");
  if (
    typeof v.traceparent !== "string" ||
    v.traceparent.length !== 55 ||
    !/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(v.traceparent) ||
    /^00-0{32}-/.test(v.traceparent) ||
    /-0{16}-01$/.test(v.traceparent)
  )
    throw new TypeError("A sampled W3C traceparent is required");
  if (!Array.isArray(v.inputFiles) || v.inputFiles.length > 16)
    throw new TypeError("Invalid files");
  let total = 0;
  const ids = new Set<string>();
  for (const raw of v.inputFiles) {
    const file = object(raw);
    const id = uuid(file.artifactId as string);
    if (
      Object.keys(file).some(
        (key) =>
          !["artifactId", "filename", "contentType", "byteSize", "sha256", "role"].includes(key),
      )
    )
      throw new TypeError("Unknown file field");
    if (ids.has(id)) throw new TypeError("Duplicate input file");
    ids.add(id);
    filename(file.filename);
    shortString(file.contentType);
    shortString(file.role, 64);
    total += bounded(file.byteSize, 0, MAX_FILE);
    if (
      typeof file.sha256 !== "string" ||
      file.sha256.length !== 64 ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    )
      throw new TypeError("Invalid hash");
  }
  if (total > MAX_TOTAL) throw new TypeError("Input files too large");
  return v as unknown as ManagedInvocation;
}
function validateResult(result: ManagedTargetResult) {
  object(result);
  if (result.state && !["succeeded", "error", "cancelled"].includes(result.state))
    throw new TypeError("Invalid outcome");
  if (Object.hasOwn(result, "output")) json(result.output);
  if (result.error) {
    shortString(result.error.type, 64);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(result.error.type))
      throw new TypeError("Invalid error type");
    if (result.error.message !== undefined) shortString(result.error.message, 1000);
  }
  if (result.usage)
    for (const count of Object.values(result.usage)) bounded(count, 0, Number.MAX_SAFE_INTEGER);
  if (result.files !== undefined && (!Array.isArray(result.files) || result.files.length > 16))
    throw new TypeError("Invalid files");
  let total = 0;
  let primary = 0;
  for (const file of result.files ?? []) {
    filename(file.filename);
    shortString(file.contentType);
    if (!(file.data instanceof Uint8Array)) throw new TypeError("File data must be bytes");
    total += bounded(file.data.byteLength, 0, MAX_FILE);
    if (file.primary !== undefined && typeof file.primary !== "boolean")
      throw new TypeError("Invalid primary");
    if (file.primary) primary++;
  }
  if (total > MAX_TOTAL || primary > 1) throw new TypeError("Invalid output files");
}
function safeUploadUrl(value: unknown): string {
  // eslint-disable-next-line no-control-regex -- control characters are rejected deliberately
  if (typeof value !== "string" || value.length > 8192 || /[\x00-\x20\x7f]/u.test(value))
    throw new TypeError("Invalid upload URL");
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new TypeError("Invalid upload URL");
  // Validate without rewriting the provider's signed capability.
  return value;
}
function uploadHeaders(value: unknown, contentType: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": contentType };
  if (value === undefined || value === null) return headers;
  for (const [name, raw] of Object.entries(object(value))) {
    const lower = name.toLowerCase();
    const value = shortString(raw);
    if (lower === "content-type" && value === contentType) headers[lower] = value;
    else if (lower === "x-vercel-blob-access" && value === "private") headers[lower] = value;
    else throw new TypeError("Unsupported upload header");
  }
  return headers;
}
async function within<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("Deadline exceeded"));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort!);
  }
}
async function readBytes(
  source: Request | Response,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = source.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum))
    throw new Error("Oversized body");
  if (!source.body) return new Uint8Array();
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await within(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new Error("Oversized body");
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    void reader.cancel().catch(() => {});
  }
}
