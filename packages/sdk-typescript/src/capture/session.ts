import { randomUUID } from "node:crypto";
import { trace, context } from "@opentelemetry/api";
import { validateOptions } from "../config.js";
import { safeUploadUrl, uploadHeaders, uploadOnce } from "../uploads.js";
import { canonical, requestKey, sanitize, sha256 } from "./portable.js";
import { captureRecord, copyCaptureRecord } from "./protocol.js";
import type {
  Binding,
  Observation,
  Payload,
  Source,
  StateEvidence,
  Omission,
  JsonValue,
  Producer,
} from "./types.js";

/** Explicit capture policy, selected boundaries and bounded delivery settings. */
export interface CaptureOptions {
  /** Separate opt-in from Hue telemetry's captureContent. No traffic when false. */
  sourceContent: boolean;
  /** Server-side capture_write project key. */
  apiKey: string;
  /** Hue origin; defaults to https://app.hue.run. */
  baseUrl?: string;
  /** Explicit boundaries to record. */
  bindings: Binding[];
  /** Existing OpenTelemetry trace identity for correlation. */
  externalTraceId?: string;
  /** Application session identity. */
  sessionId?: string;
  /** Explicit task input to capture under the source-content policy. */
  input?: unknown;
  /** Stable producer identity; defaults to a fresh UUID. */
  producerId?: string;
  /** Stable key for recovering capture creation; defaults to a fresh UUID. */
  idempotencyKey?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMillis?: number;
  /** Local queue byte limit, 1024–8388608; defaults to 8 MiB. */
  maxQueueBytes?: number;
  /** Local queue record limit, 1–4000; defaults to 2048. */
  maxQueueRecords?: number;
  /** Must return portable JSON. Throws are recorded as omissions, never live errors. */
  redact?: (value: JsonValue) => unknown;
}
/** Sanitized delivery and completeness report; finalization alone does not prove completeness. */
export interface CaptureReport {
  /** Delivery state for this operation. */
  status: "disabled" | "flushed" | "finalized" | "failed";
  /** Queued records, open calls and uploads remaining. */
  pending: number;
  /** Cumulative omitted or dropped evidence count. */
  dropped: number;
  /** Capture identity once creation is acknowledged. */
  captureId?: string;
  /** Last acknowledged capture revision. */
  revision?: number;
  /** Finalized manifest digest when available. */
  digest?: string;
  /** Server-reported incomplete-evidence findings. */
  omissions?: Omission[];
}
type Queued =
  | { kind: "observations"; value: Observation }
  | { kind: "sources"; value: Source }
  | { kind: "stateEvidence"; value: StateEvidence };
type Finalization = {
  idempotencyKey: string;
  expectedCaptureRevision: number;
  producers: Producer[];
  endedAt: string;
};
class CaptureRequestError extends Error {
  constructor(readonly status: number) {
    super("Capture request failed");
  }
}
type Batch = {
  idempotencyKey: string;
  observations: Observation[];
  sources: Source[];
  stateEvidence: StateEvidence[];
};
const now = () => new Date().toISOString();
const byteSize = (value: unknown) => Buffer.byteLength(canonical(value));

/** Capture does not call models, replace tools, replay calls, or infer a complete world. */
export class CaptureSession {
  /** Stable identity attached to every emitted observation. */
  readonly producerId: string;
  private readonly options: CaptureOptions;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly maxBytes: number;
  private readonly maxRecords: number;
  private readonly bindings: Binding[];
  private readonly createBody: Record<string, unknown>;
  private readonly queue: Queued[] = [];
  private queuedBytes = 0;
  private sequence = 0;
  private dropped = 0;
  private openCalls = 0;
  private uploads = 0;
  private id?: string;
  private revision = 0;
  private batch?: { body: Batch; count: number; bytes: number };
  private creation?: Promise<void>;
  private tail = Promise.resolve();
  private finalization?: Finalization;
  constructor(options: CaptureOptions) {
    if (typeof options.sourceContent !== "boolean")
      throw new TypeError("Choose sourceContent explicitly");
    this.options = { ...options };
    const validated = validateOptions({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      timeoutMillis: options.timeoutMillis,
      maxQueueBytes: options.maxQueueBytes,
      enabled: options.sourceContent,
      captureContent: false,
      serviceName: "hue-capture",
    });
    this.baseUrl = validated.baseUrl;
    this.apiKey = validated.apiKey;
    this.timeout = validated.timeoutMillis;
    this.maxBytes = options.maxQueueBytes ?? 8 * 1024 * 1024;
    this.maxRecords = options.maxQueueRecords ?? 2048;
    if (!Number.isInteger(this.maxRecords) || this.maxRecords < 1 || this.maxRecords > 4000)
      throw new TypeError("maxQueueRecords must be 1–4000");
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1024 || this.maxBytes > 8 * 1024 * 1024)
      throw new TypeError("maxQueueBytes must be 1024–8388608");
    this.producerId = options.producerId ?? randomUUID();
    this.bindings = options.sourceContent
      ? options.bindings.map((value) => captureRecord<Binding>("binding", value))
      : [];
    this.createBody = {
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
      producerId: this.producerId,
      bindings: this.bindings,
      capturePolicy: { sourceContent: true, redactionVersion: "1" },
      startedAt: now(),
      ...(options.externalTraceId ? { externalTraceId: options.externalTraceId } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    };
    if (options.sourceContent && options.input !== undefined) {
      try {
        const value = this.payload(options.input);
        this.createBody.input = value.payload;
        if (value.redacted) this.dropped++;
      } catch {
        this.dropped++;
      }
    }
  }
  private payload(value: unknown): { payload: Payload; redacted: boolean } {
    if (value === undefined) return { payload: { kind: "absent" }, redacted: false };
    const sanitized = sanitize(value);
    const beforeRedaction = canonical(sanitized.value);
    const safe = this.options.redact ? sanitize(this.options.redact(sanitized.value)) : sanitized;
    const payload: Payload = { kind: "json", value: safe.value };
    if (byteSize(payload) > 256 * 1024)
      throw new RangeError("Capture payload exceeds inline limit");
    return {
      payload,
      redacted: sanitized.changed || safe.changed || canonical(safe.value) !== beforeRedaction,
    };
  }
  private enqueue(record: Queued) {
    if (!this.options.sourceContent) return;
    try {
      const clone = copyCaptureRecord(record),
        bytes = byteSize(clone);
      if (
        bytes > 300 * 1024 ||
        this.queue.length >= this.maxRecords ||
        this.queuedBytes + bytes > this.maxBytes
      ) {
        this.dropped++;
        return;
      }
      this.queue.push(clone);
      this.queuedBytes += bytes;
    } catch {
      this.dropped++;
    }
  }
  /** Supply explicit pre-execution snapshots; never call this with a post-write world. */
  stateEvidence(value: StateEvidence): void {
    if (!this.options.sourceContent) return;
    try {
      const sanitized = sanitize(value),
        beforeRedaction = canonical(sanitized.value),
        custom = this.options.redact ? sanitize(this.options.redact(sanitized.value)) : sanitized,
        safe = captureRecord<StateEvidence>("stateEvidence", custom.value);
      if (sanitized.changed || custom.changed || canonical(custom.value) !== beforeRedaction)
        safe.boundary.omissions.push("credential_redaction");
      this.enqueue({ kind: "stateEvidence", value: safe });
    } catch {
      this.dropped++;
    }
  }
  /** Record an explicit artifact/source descriptor after redaction. */
  source(value: Source): void {
    if (!this.options.sourceContent) return;
    try {
      const sanitized = sanitize(value),
        before = canonical(sanitized.value);
      const custom = this.options.redact
        ? sanitize(this.options.redact(sanitized.value))
        : sanitized;
      const source = captureRecord<Source>("source", custom.value);
      if (sanitized.changed || custom.changed || canonical(custom.value) !== before)
        source.content = "partial";
      this.enqueue({ kind: "sources", value: source });
    } catch {
      this.dropped++;
    }
  }
  /** Works with any asynchronous function. The live result/error object retains identity. */
  async observe<T>(
    bindingId: string,
    operation: string,
    args: unknown,
    live: () => Promise<T>,
  ): Promise<T> {
    if (!this.options.sourceContent) return live();
    let handle: Omit<Observation, "id" | "sequence" | "phase" | "at"> | undefined;
    this.openCalls++;
    try {
      try {
        const binding = this.bindings.find((value) => value.id === bindingId);
        if (!binding) throw new Error("Unselected binding");
        const value = this.payload(args),
          callId = randomUUID();
        const span = trace.getSpanContext(context.active());
        handle = {
          callId,
          producerId: this.producerId,
          bindingId,
          operation,
          contractVersion: binding.contractVersion,
          requestKey: requestKey(
            binding,
            operation,
            value.payload.kind === "json" ? value.payload.value : null,
          ),
          replayable: !value.redacted,
          ...(value.redacted ? { omissionReason: "redacted_arguments" } : {}),
          ...(span ? { externalSpanId: span.spanId } : {}),
        };
        this.enqueue({
          kind: "observations",
          value: {
            ...handle,
            id: randomUUID(),
            sequence: ++this.sequence,
            phase: "start",
            at: now(),
            arguments: value.payload,
          },
        });
      } catch {
        this.dropped++;
      }
      try {
        const result = await live();
        if (handle) {
          try {
            const value = this.payload(result);
            this.enqueue({
              kind: "observations",
              value: {
                ...handle,
                id: randomUUID(),
                sequence: ++this.sequence,
                phase: "finish",
                at: now(),
                outcome: "success",
                result: value.payload,
                replayable: handle.replayable && !value.redacted,
                ...(value.redacted ? { omissionReason: "redacted_result" } : {}),
              },
            });
          } catch {
            this.enqueue({
              kind: "observations",
              value: {
                ...handle,
                id: randomUUID(),
                sequence: ++this.sequence,
                phase: "finish",
                at: now(),
                outcome: "incomplete",
                replayable: false,
                omissionReason: "unsupported_result",
              },
            });
          }
        }
        return result;
      } catch (error) {
        if (handle)
          this.enqueue({
            kind: "observations",
            value: {
              ...handle,
              id: randomUUID(),
              sequence: ++this.sequence,
              phase: "finish",
              at: now(),
              outcome: "error",
              error: { type: "Error" },
            },
          });
        throw error;
      }
    } finally {
      this.openCalls--;
    }
  }
  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    deadline: number,
  ): Promise<T> {
    const remaining = Math.min(this.timeout, deadline - Date.now());
    if (remaining <= 0) throw new Error("Capture deadline elapsed");
    const response = await fetch(`${this.baseUrl}/api/v1/captures${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: canonical(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(Math.ceil(remaining)),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new CaptureRequestError(response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Capture response missing");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 1024 * 1024) throw new Error("Capture response exceeds limit");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  }
  private async ensureCreated(deadline: number) {
    if (this.id) return;
    if (!this.creation) {
      this.creation = (async () => {
        const value = await this.request<{ id: string; captureRevision: number }>(
          "POST",
          "",
          this.createBody,
          deadline,
        );
        if (!/^[a-f0-9-]{36}$/.test(value.id) || !Number.isInteger(value.captureRevision))
          throw new Error("Invalid capture response");
        this.id = value.id;
        this.revision = value.captureRevision;
      })().finally(() => {
        this.creation = undefined;
      });
    }
    await this.creation;
  }
  private report(status: CaptureReport["status"]): CaptureReport {
    return {
      status,
      pending: this.queue.length + this.openCalls + this.uploads,
      dropped: this.dropped,
      ...(this.id ? { captureId: this.id, revision: this.revision } : {}),
    };
  }
  private async drain(deadline: number): Promise<CaptureReport> {
    if (!this.options.sourceContent) return this.report("disabled");
    try {
      await this.ensureCreated(deadline);
      while (this.queue.length) {
        if (!this.batch) {
          const body: Batch = {
            idempotencyKey: randomUUID(),
            observations: [],
            sources: [],
            stateEvidence: [],
          };
          let count = 0,
            bytes = 0;
          for (const record of this.queue.slice(0, 20)) {
            const size = byteSize(record);
            if (bytes + size > 850 * 1024) break;
            (body[record.kind] as unknown[]).push(record.value);
            bytes += size;
            count++;
          }
          this.batch = { body, count, bytes };
        }
        const result = await this.request<{ captureRevision: number }>(
          "POST",
          `/${this.id}/append`,
          this.batch.body,
          deadline,
        );
        if (!Number.isInteger(result.captureRevision)) throw new Error("Invalid capture response");
        this.revision = result.captureRevision;
        this.queue.splice(0, this.batch.count);
        this.queuedBytes -= this.batch.bytes;
        this.batch = undefined;
      }
      return this.report("flushed");
    } catch {
      return this.report("failed");
    }
  }
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  /** Drain acknowledged batches within the caller deadline; retain failed batches for retry. */
  flush(
    options: {
      /** Total caller deadline in milliseconds, capped at 30000. */
      deadlineMillis?: number;
    } = {},
  ): Promise<CaptureReport> {
    const deadline = Date.now() + Math.min(30000, Math.max(1, options.deadlineMillis ?? 30000));
    return this.serialized(() => this.drain(deadline));
  }
  /** Pin a revision and report gaps, preserving uncertain request identity for recovery. */
  finalize(
    options: {
      /** Total caller deadline in milliseconds, capped at 30000. */
      deadlineMillis?: number;
    } = {},
  ): Promise<CaptureReport> {
    const deadline = Date.now() + Math.min(30000, Math.max(1, options.deadlineMillis ?? 30000));
    return this.serialized(async () => {
      if (!this.options.sourceContent) return this.report("disabled");
      try {
        // One recovery attempt handles a decided stale revision without an unbounded retry loop.
        for (let attempt = 0; attempt < 2; attempt++) {
          const recovering = !!this.finalization;
          if (!this.finalization) {
            await this.drain(deadline);
            await this.ensureCreated(deadline);
            const barrier = await this.request<{ captureRevision: number }>(
              "POST",
              `/${this.id}/append`,
              { idempotencyKey: randomUUID(), observations: [], sources: [], stateEvidence: [] },
              deadline,
            );
            this.revision = barrier.captureRevision;
            this.finalization = {
              idempotencyKey: randomUUID(),
              expectedCaptureRevision: this.revision,
              producers: [
                {
                  producerId: this.producerId,
                  lastSequence: this.sequence,
                  pending: this.queue.length + this.openCalls + this.uploads,
                  dropped: this.dropped,
                },
              ],
              endedAt: now(),
            };
          }
          const pending = this.finalization;
          let result: { revision: number; digest: string; omissions: Omission[] };
          try {
            result = await this.request("POST", `/${this.id}/finalize`, pending, deadline);
          } catch (error) {
            // A lost response retains the exact request. A 409 is a decided refusal:
            // the server checks immutable prior revisions before checking current state.
            if (error instanceof CaptureRequestError && error.status === 409) {
              this.finalization = undefined;
              if (attempt === 0) continue;
            }
            throw error;
          }
          this.finalization = undefined;
          const producer = pending.producers[0]!;
          const changed =
            this.revision > result.revision ||
            this.sequence > producer.lastSequence ||
            this.dropped !== producer.dropped ||
            this.queue.length + this.openCalls + this.uploads !== producer.pending;
          if (recovering && changed && attempt === 0) continue;
          return {
            ...this.report("finalized"),
            revision: result.revision,
            digest: result.digest,
            omissions: result.omissions,
          };
        }
        return this.report("failed");
      } catch {
        return this.report("failed");
      }
    });
  }
  /** Explicit source upload, separate from tool interception. At most two uploads run at once. */
  async uploadSource(input: { filename: string; contentType: string; bytes: Uint8Array }): Promise<{
    /** Ready immutable artifact identity. */
    artifactId: string;
    /** SHA-256 digest of the uploaded bytes. */
    sha256: string;
    /** Exact byte length. */
    byteSize: number;
    /** Declared media type. */
    mimeType: string;
  } | null> {
    if (!this.options.sourceContent) return null;
    if (
      this.uploads >= 2 ||
      input.bytes.byteLength < 1 ||
      input.bytes.byteLength > 25 * 1024 * 1024
    ) {
      this.dropped++;
      return null;
    }
    this.uploads++;
    const deadline = Date.now() + 30000;
    try {
      const bytes = Buffer.from(input.bytes),
        digest = sha256(bytes);
      await this.ensureCreated(deadline);
      const artifact = await this.request<{ id: string }>(
        "POST",
        `/${this.id}/artifacts`,
        {
          idempotencyKey: randomUUID(),
          filename: input.filename,
          contentType: input.contentType,
          byteSize: bytes.byteLength,
          sha256: digest,
        },
        deadline,
      );
      const upload = await this.request<{
        uploadUrl: string;
        headers?: Record<string, string> | null;
        method: string;
      }>("POST", `/${this.id}/artifacts/${artifact.id}/upload`, {}, deadline);
      const url = safeUploadUrl(upload.uploadUrl);
      if (upload.method !== "PUT") throw new Error("Invalid upload capability");
      const headers = uploadHeaders(upload.headers, input.contentType);
      // Signed writes run once. Authoritative completion verifies stored bytes even
      // when the provider accepted the PUT but its acknowledgement was lost.
      try {
        await uploadOnce(url, bytes, headers, deadline);
      } catch {
        /* Verify below without replaying the signed write. */
      }
      await this.request("POST", `/${this.id}/artifacts/${artifact.id}/complete`, {}, deadline);
      return {
        artifactId: artifact.id,
        sha256: digest,
        byteSize: bytes.byteLength,
        mimeType: input.contentType,
      };
    } catch {
      this.dropped++;
      return null;
    } finally {
      this.uploads--;
    }
  }
}
