import { AsyncLocalStorage } from "node:async_hooks";
import type { Agent, ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import { gzip } from "node:zlib";
import type { Attributes, Span as ApiSpan } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import {
  createOtlpNetworkExportDelegate,
  OTLPExporterBase,
  OTLPExporterError,
  type ExportResponse,
  type IExporterTransport,
} from "@opentelemetry/otlp-exporter-base";
import { createOtlpHttpExporterMetrics } from "@opentelemetry/otlp-exporter-base/node-http";
import {
  LogsExporterMetricsHelper,
  ProtobufLogsSerializer,
  ProtobufTraceSerializer,
  TraceExporterMetricsHelper,
  type IExporterMetricsHelper,
  type ISerializer,
} from "@opentelemetry/otlp-transformer";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace";
import {
  BatchLogRecordProcessor,
  type LogRecordProcessor,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import { isInsecureOrigin, REDACTION_CONTEXT_UNITS, validateOptions } from "./config.js";
import {
  BLOBS_KEY,
  MAX_BLOB_ENTRIES,
  blobEntry,
  countFallback,
  BlobUploader,
  FALLBACK_MESSAGES,
  fallbackAttributes,
  fallbackRecord,
  heldBytesOf,
  LATE_FALLBACK_MESSAGES,
  MAX_HELD_BLOB_BYTES,
  mergeWhenSettled,
  newTally,
  mediaKey,
  offloadAttributes,
  offloadRecord,
  sizeOf,
  uploadBudgetMillis,
  type LateUploads,
  type OffloadCollector,
  type MediaAttachment,
  type OffloadTally,
  type UploadContext,
} from "./blobs.js";
import { isByteSource } from "./large-media.js";
import {
  advertisedLimits,
  BATCH_TARGET_BYTES,
  DEFAULT_RECEIVER_LIMITS,
  fitsWithoutCompression,
  type ReceiverLimits,
} from "./limits.js";
import {
  announcesLiveSpan,
  LIVE_SPAN_INTERVAL_MILLIS,
  MAX_LIVE_SPANS,
  pendingPlaceholder,
  PLACEHOLDERS_HEADER,
  withoutPlaceholderMarkers,
} from "./live-spans.js";
import { estimateRecordBytes, spanSource } from "./safety.js";
import { MediaDigestMemo, isMediaName } from "./inline-files.js";
import { locateParts } from "./attachment.js";
import { snapshotLog, snapshotSpan, type DigestedMessage } from "./snapshot.js";
import {
  DROPPED_RECORDS_KEY,
  isContentKey,
  isTruncatedMarker,
  redactLog,
  redactSpan,
  TRUNCATED_KEY,
  truncatedMarker,
  withTruncatedKeys,
  type ResourceCache,
} from "./privacy.js";
import { sdkVersion } from "./version.js";
import type { ExportIssue, ExportReport, HueOptions, Signal } from "./types.js";

type Response = {
  partialSuccess?: {
    rejectedSpans?: number | string;
    rejectedLogRecords?: number | string;
    errorMessage?: string;
  };
};
/** A finished span or emitted log record as the OpenTelemetry SDK hands it to a processor. */
export type RecordValue = ReadableSpan | ReadableLogRecord;

/** The transport surface the exporters report through; kept narrow so nothing else depends on it. */
interface ExportSink {
  readonly options: ReturnType<typeof validateOptions>;
  finish(signal: Signal, records: RecordValue[]): void;
  acceptedRecords(signal: Signal, count: number): void;
  issue(
    signal: Signal,
    kind: ExportIssue["kind"],
    count: number,
    message: string,
    status?: number,
    traceIds?: string[],
  ): void;
  placeholderMarkers(record: RecordValue): Attributes | undefined;
  placeholderSettled(record: RecordValue): boolean;
  sendsPlaceholders(): boolean;
  withDroppedRecords(span: ReadableSpan): ReadableSpan;
  consumeDroppedRecords(counts: ReadonlyMap<string, number>): void;
  countUndelivered(records: readonly RecordValue[]): void;
  holdForRateLimit(millis: number): Promise<boolean>;
  rejectPlaceholders(count: number): void;
  receiverLimits(): ReceiverLimits;
  adoptLimits(headers: IncomingHttpHeaders): void;
  offloadsValues(): boolean;
  mediaAttachments(record: RecordValue): MediaAttachment[];
  offloadSpan<T extends RecordValue>(
    record: T,
    collector: OffloadCollector,
    upload: UploadContext,
    tally: OffloadTally,
    late: LateUploads,
    queued: RecordValue,
  ): Promise<T>;
  offloadLog(
    log: ReadableLogRecord,
    collector: OffloadCollector,
    upload: UploadContext,
    tally: OffloadTally,
    late: LateUploads,
    queued: RecordValue,
  ): Promise<ReadableLogRecord>;
  reportOffload(tally: OffloadTally, signal?: Signal, late?: boolean): void;
  awaitUploads(report: Promise<void>): void;
}

/** A record's trace: a span's context, a log record's span identifiers; "" when unreadable. */
function recordTraceId(record: RecordValue): string {
  try {
    return "spanContext" in record && typeof record.spanContext === "function"
      ? (record as ReadableSpan).spanContext().traceId
      : ((record as ReadableLogRecord).spanContext?.traceId ?? "");
  } catch {
    return "";
  }
}

/** The value of a record's attribute, or a log record's body, that holds placed attachments. */
function placedValue(record: RecordValue, attribute: string): unknown {
  if (
    attribute === "body" &&
    !("spanContext" in record && typeof record.spanContext === "function")
  )
    return (record as ReadableLogRecord).body;
  return record.attributes[attribute];
}

/**
 * The staged files a record still authorizes. Each surviving `hue.file` event authorizes one
 * staged request, including repeated digests. An attachment placed in a value is authorized by
 * its own part in the value as exported: after redaction (`before` absent) each part is found in
 * its value, and keyed at its pointer there, a part the redactor removed taking its upload with
 * it; after fitting (`before`, the record as it was fitted) a part survives while fitting left its
 * value as it was.
 */
function survivingMedia(
  files: readonly MediaAttachment[],
  record: RecordValue,
  tally: OffloadTally,
  before?: RecordValue,
): MediaAttachment[] {
  const consumed = new Set<number>();
  const traceId = recordTraceId(record);
  const events = "events" in record ? (record as ReadableSpan).events : [];
  const located = new Map<string, MediaAttachment[]>();
  const locate = (attribute: string): MediaAttachment[] => {
    let parts = located.get(attribute);
    if (parts) return [];
    let value = placedValue(record, attribute);
    try {
      if (typeof value === "string") value = JSON.parse(value);
    } catch {
      value = undefined;
    }
    parts = locateParts(
      value,
      files.filter((file) => file.attribute === attribute),
    ).map(({ file, pointer, name }) => {
      const { name: _staged, ...rest } = file;
      return { ...rest, key: `${attribute}#${pointer}`, ...(name ? { name } : {}) };
    });
    located.set(attribute, parts);
    return parts;
  };
  return files.flatMap((file): MediaAttachment[] => {
    if (file.attribute !== undefined) {
      if (!before) return locate(file.attribute);
      if (placedValue(record, file.attribute) === placedValue(before, file.attribute))
        return [file];
      countFallback(tally, "budget", traceId);
      return [];
    }
    const index = events.findIndex(
      (event, index) =>
        !consumed.has(index) &&
        event.name === "hue.file" &&
        (!file.eventTime ||
          (event.time[0] === file.eventTime[0] && event.time[1] === file.eventTime[1])) &&
        event.attributes?.["hue.file.sha256"] === file.digest.sha256 &&
        event.attributes?.["hue.file.size"] === file.digest.size &&
        event.attributes?.["hue.file.media_type"] === file.contentType,
    );
    if (index < 0) {
      countFallback(tally, "budget", traceId);
      return [];
    }
    consumed.add(index);
    const name = events[index]!.attributes?.["hue.file.name"];
    return [
      {
        bytes: file.bytes,
        digest: file.digest,
        contentType: file.contentType,
        ...(file.eventTime ? { eventTime: file.eventTime } : {}),
        ...(isMediaName(name) ? { name } : {}),
      },
    ];
  });
}

function mediaEntry(file: MediaAttachment): string {
  return blobEntry(
    mediaKey(file),
    file.digest.sha256,
    file.digest.size,
    file.contentType,
    file.name,
  );
}

/**
 * How long one export holds its records for a receiver that refused them for their rate (HTTP 429)
 * and asked to be retried later than a request's deadline allows: the records stay queued, counted
 * against the queue's bounds, and are sent again once `Retry-After` has passed. A longer wait loses
 * them, reported like any refused request.
 */
export const MAX_RATE_LIMIT_HOLD_MILLIS = 60_000;

/** How long one export may take with requests of `timeoutMillis` each: hashing its values over
 * the inline limit, its requests, and a hold for a rate-limited receiver on top. Processors and
 * providers wait this long for a drain. A drain also waits for the uploads its exports queued,
 * which run beside the requests and end within six timeouts and a minute of being queued, so they
 * fit within the same budget. */
export function exportBudgetMillis(timeoutMillis: number): number {
  return uploadBudgetMillis(timeoutMillis) + timeoutMillis * 16 + 1000 + MAX_RATE_LIMIT_HOLD_MILLIS;
}

/** Per-record allowance for protobuf length prefixes that grow when records are grouped. */
const RECORD_FRAMING_BYTES = 64;

function recordData(record: RecordValue, signal: Signal): unknown {
  if (signal === "traces") {
    const span = record as ReadableSpan;
    return {
      name: span.name,
      attributes: span.attributes,
      events: span.events,
      links: span.links,
      status: span.status,
      resource: span.resource.attributes,
      scope: span.instrumentationScope,
    };
  }
  const log = record as ReadableLogRecord;
  return {
    body: log.body,
    attributes: log.attributes,
    eventName: log.eventName,
    severityText: log.severityText,
    resource: log.resource.attributes,
    scope: log.instrumentationScope,
  };
}

/**
 * Rejection of {@link HueClient.flush} and {@link HueClient.shutdown}: telemetry was not fully
 * accepted. Carries sanitized counts only, never server response text or content.
 */
export class HueExportError extends Error {
  constructor(
    /** Non-warning issues observed since the failing drain began. */
    readonly issues: ExportIssue[],
    /** Cumulative counters and current gauges at the time of the failure. */
    readonly report: ExportReport,
  ) {
    super("Hue could not accept all telemetry. Inspect issues and report for sanitized counts.");
    this.name = "HueExportError";
  }
}

/**
 * Hue's export pipeline: OTLP/HTTP exporters behind bounded batch processors, with cumulative
 * counters and a sanitized issue history. A client owns one; in attach mode the application attaches
 * `spanProcessor` and `logRecordProcessor` to its own providers while constructing them.
 */
export class HueTransport {
  /** Validated options with defaults applied; `baseUrl` is the origin. Not enumerable, so it does not leak the key when logged. */
  readonly options: ReturnType<typeof validateOptions>;
  /** Span processor to attach to a tracer provider; a no-op when disabled. */
  readonly spanProcessor: SpanProcessor;
  /** Log record processor to attach to a logger provider; a no-op when disabled. */
  readonly logRecordProcessor: LogRecordProcessor;
  private sequence = 0;
  private observedSequence = 0;
  private failureSequence = 0;
  private issues: ExportIssue[] = [];
  private accepted = { traces: 0, logs: 0 };
  private rejected = { traces: 0, logs: 0 };
  private failed = { traces: 0, logs: 0 };
  private spans = new Map<ReadableSpan, number>();
  private logs = new Map<ReadableLogRecord, number>();
  private pendingBytes = 0;
  private dropped = { traces: 0, logs: 0 };
  /** Records of each trace the SDK never sent (dropped from the queue, refused as invalid or
   * over the request limit), reported on the trace's root span as `hue.sdk.dropped_records` when
   * the root is exported, so Hue reads the trace as incomplete by that many records. */
  private droppedByTrace = new Map<string, number>();
  /** Whether a trace's root carries `hue.sdk.dropped_records`; off for a replay of recorded
   * spans, which must send the same root on every run. */
  private marksDroppedRecords = true;
  private instrumentationFailures = 0;
  private diagnosticPending = false;
  private lastDiagnosticAt = -Infinity;
  private traceExporter: ReportingExporter<ReadableSpan>;
  private logExporter: ReportingExporter<ReadableLogRecord>;
  private closed = false;
  private shutdownPromise?: Promise<ExportReport>;
  /** The latest flush's send of its records; the next flush's send starts after it. */
  private sendPromise?: Promise<unknown>;
  /** Set while a flush sends its records: the processors leave the uploads to that flush, which
   * waits for them after its send, so no flush's send waits behind another's uploads. */
  private sendingRecords = new AsyncLocalStorage<true>();
  // Open spans not yet announced. Each is considered once, at the next tick after it starts.
  private live = new Set<ReadableSpan>();
  private liveTimer?: ReturnType<typeof setInterval>;
  private liveSpans: boolean;
  // Whether this client announces live spans at all; `liveSpans` also goes off at shutdown.
  private readonly announcesLiveSpans: boolean;
  private placeholdersRejected = false;
  // Admitted placeholder snapshots and the marker attributes added after redaction.
  private placeholders = new WeakMap<RecordValue, Attributes>();
  // The running span each admitted placeholder announces, so one it has outlived is not sent.
  private placeholderSources = new WeakMap<RecordValue, { readonly ended: boolean }>();
  private batchSpans?: BatchSpanProcessor;
  // What the receiver accepts, as it last advertised; the limits of this release until it does.
  private limits: ReceiverLimits = DEFAULT_RECEIVER_LIMITS;
  /** The rate-limit holds in progress, each ended early by calling it. */
  private holds = new Set<() => void>();
  private holdsReleased = false;
  // The value strings each admitted record's snapshot cut, for its redaction.
  private admissionCuts = new WeakMap<RecordValue, ReadonlySet<string>>();
  // The span's own messages whose large inline files each admitted span shrank to their digest.
  private admissionDigests = new WeakMap<RecordValue, ReadonlyMap<string, DigestedMessage>>();
  // The span's own messages each admitted span inspected, or left to export to inspect.
  private admissionInspected = new WeakMap<RecordValue, ReadonlySet<string>>();
  // The span's own values each admitted span held whole past the inspection bounds.
  private admissionLarge = new WeakMap<RecordValue, ReadonlySet<string>>();
  /** Uploads values over the inline limit apart from their spans; absent when disabled. */
  private uploader?: BlobUploader;
  /** Bytes of values over the inline limit queued spans hold whole for upload, and each span's. */
  private heldBytes = 0;
  private held = new WeakMap<RecordValue, number>();
  /** Bytes of each record's charge (its own held values and its staged files) that its queued
   * uploads took over before the record was finished: charged to the uploads alone until they
   * settle or the record is finished. */
  private heldByUploads = new WeakMap<RecordValue, number>();
  private mediaMemo = new MediaDigestMemo();
  // Context identity also matches safe API wrappers to the provider's ended span. Abandoned
  // spans retain no span objects, and share the 2048-span / 128 MiB holding bounds.
  private media = new Map<string, MediaAttachment[]>();
  // Attachments placed in a log record's body, from `emit` until the record is admitted, and
  // the admitted records' own.
  private logParts = new Map<object, { traceId: string; files: MediaAttachment[] }>();
  private logMedia = new WeakMap<RecordValue, MediaAttachment[]>();
  private mediaOwners = new Map<string, { source: WeakRef<ApiSpan>; token: object }>();
  private mediaTimer?: ReturnType<typeof setInterval>;
  private mediaFinalizer = new FinalizationRegistry<{ identity: string; token: object }>(
    ({ identity, token }) => {
      if (this.mediaOwners.get(identity)?.token === token) this.releaseMediaIdentity(identity);
    },
  );
  private uploaded = 0;
  private uploadFallbacks = 0;
  /** Each export's queued uploads, until they all settle and are reported. */
  private uploadReports = new Set<Promise<void>>();
  /** Settles once every upload report registered so far has: each drain awaits this one promise,
   * so a drain costs the same however many uploads are pending. */
  private uploadsSettled: Promise<void> = Promise.resolve();

  constructor(options: HueOptions) {
    this.options = validateOptions(options);
    Object.defineProperty(this, "options", { enumerable: false });
    this.liveSpans = this.options.enabled !== false && this.options.liveSpans;
    this.announcesLiveSpans = this.liveSpans;
    this.traceExporter = new ReportingExporter(
      this,
      "traces",
      ProtobufTraceSerializer,
      TraceExporterMetricsHelper,
      (span, cache, offload) => {
        // Export inspects only the messages admission inspected within the record's allowance,
        // and reads in place the values it held whole past the inspection bounds.
        if (offload) {
          offload.inspected = this.admissionInspected.get(span);
          offload.large = this.admissionLarge.get(span);
        }
        return redactSpan(span, this.options, cache, {
          valueBytes: this.limits.valueBytes,
          cut: this.admissionCuts.get(span),
          digested: this.admissionDigests.get(span),
          ...(offload ? { offload } : {}),
        });
      },
    );
    this.logExporter = new ReportingExporter(
      this,
      "logs",
      ProtobufLogsSerializer,
      LogsExporterMetricsHelper,
      (log, cache, offload) =>
        redactLog(log, this.options, cache, {
          valueBytes: this.limits.valueBytes,
          cut: this.admissionCuts.get(log),
          ...(offload ? { offload } : {}),
        }),
    );
    if (this.options.enabled !== false)
      this.uploader = new BlobUploader({
        baseUrl: this.options.baseUrl,
        apiKey: this.options.apiKey,
        timeoutMillis: this.options.timeoutMillis,
        allowInsecureHttp: this.options.allowInsecureHttp === true,
        userAgent: `hue-sdk-typescript/${sdkVersion}`,
      });
    if (this.options.enabled === false) {
      this.spanProcessor = { onStart() {}, onEnd() {}, async forceFlush() {}, async shutdown() {} };
      this.logRecordProcessor = { onEmit() {}, async forceFlush() {}, async shutdown() {} };
      return;
    }
    if (isInsecureOrigin(this.options.baseUrl))
      this.issue(
        "traces",
        "warning",
        0,
        "allowInsecureHttp is set: telemetry and the project key are sent over plain HTTP to a host that is not loopback",
      );
    const batching = {
      maxQueueSize: 2048,
      maxExportBatchSize: 128,
      scheduledDelayMillis: 1000,
      // An export may hold its records for a rate-limited receiver on top of its requests.
      exportTimeoutMillis: exportBudgetMillis(this.options.timeoutMillis),
    };
    const spans = new BatchSpanProcessor({ exporter: this.traceExporter, ...batching });
    const logs = new BatchLogRecordProcessor({ exporter: this.logExporter, ...batching });
    this.batchSpans = spans;
    this.spanProcessor = {
      onStart: (span, parent) => {
        try {
          spans.onStart(span, parent);
        } catch {
          this.instrumentationFailure();
        }
        this.track(span);
      },
      onEnd: (span) => {
        if (this.live.delete(span) && !this.live.size) this.stopLiveTimer();
        let admitted: ReadableSpan | undefined;
        try {
          if (!(span.spanContext().traceFlags & 1)) {
            this.releaseMedia(span);
            return;
          }
          const queued = this.enqueue("traces", span);
          if (!queued) {
            const tally = newTally();
            for (const file of this.mediaAttachments(span))
              if (sizeOf(file.bytes)) countFallback(tally, "budget", span.spanContext().traceId);
            this.reportOffload(tally);
            this.releaseMedia(span);
            return;
          }
          admitted = queued as ReadableSpan;
          this.protectMedia(admitted);
          this.countEnded(admitted);
          spans.onEnd(admitted);
        } catch {
          if (admitted) this.finish("traces", [admitted]);
          else this.releaseMedia(span);
          this.issue(
            "traces",
            "invalid",
            1,
            "Telemetry processor could not accept a record",
            undefined,
            traceIdsOf([span]),
          );
        }
      },
      // The spans are sent first, then the uploads queued so far are waited for, unless a
      // flush sends them: that flush waits for the uploads after its send.
      forceFlush: async () => {
        try {
          await spans.forceFlush();
        } finally {
          if (!this.sendingRecords.getStore()) await this.drainUploads();
        }
      },
      shutdown: async () => {
        this.stopLiveSpans();
        try {
          await spans.shutdown();
        } finally {
          await this.drainUploads();
        }
      },
    };
    this.logRecordProcessor = {
      onEmit: (log) => {
        let admitted: ReadableLogRecord | undefined;
        try {
          const queued = this.enqueue("logs", log);
          if (!queued) {
            const pending =
              log.body !== null && typeof log.body === "object"
                ? this.logParts.get(log.body as object)
                : undefined;
            if (pending) {
              const tally = newTally();
              for (const _file of pending.files) countFallback(tally, "budget", pending.traceId);
              this.reportOffload(tally, "logs");
              this.logParts.delete(log.body as object);
            }
            return;
          }
          admitted = queued as ReadableLogRecord;
          this.admitLogParts(log, queued);
          logs.onEmit(queued as Parameters<LogRecordProcessor["onEmit"]>[0]);
        } catch {
          if (admitted) this.finish("logs", [admitted]);
          this.issue(
            "logs",
            "invalid",
            1,
            "Telemetry processor could not accept a record",
            undefined,
            traceIdsOf([log]),
          );
        }
      },
      forceFlush: async () => {
        try {
          await logs.forceFlush();
        } finally {
          if (!this.sendingRecords.getStore()) await this.drainUploads();
        }
      },
      shutdown: async () => {
        try {
          await logs.shutdown();
        } finally {
          await this.drainUploads();
        }
      },
    };
  }

  /**
   * Advisory records (placeholders) are admitted only while the queue is under a quarter of its
   * record and byte budgets, so they never take more than a quarter from real records. They are
   * skipped silently.
   */
  private enqueue(signal: Signal, record: RecordValue, advisory = false): RecordValue | undefined {
    const pending = signal === "traces" ? this.spans : this.logs;
    if (advisory && (this.closed || pending.size >= 2048 / 4)) return undefined;
    // A record dropped here names its trace, so a runner with several traces in flight knows
    // whose telemetry is missing; a log record names the trace of the span it was emitted in.
    const traceIds = traceIdsOf([record]);
    if (this.closed || pending.size >= 2048) {
      this.issue(
        signal,
        "dropped",
        1,
        this.closed
          ? "Telemetry emitted after transport shutdown"
          : "Telemetry queue reached 2048 records",
        undefined,
        traceIds,
      );
      return undefined;
    }
    try {
      const remaining =
        (advisory ? this.options.maxQueueBytes / 4 : this.options.maxQueueBytes) -
        this.pendingBytes;
      // A value far over the receiver's value cap is cut when it is queued, to the cap and some
      // context for the redactor, rather than charged whole: export cuts it to the cap anyway,
      // and its full size could drop the record before that cut ever ran. A span's own value
      // that export may upload is held whole instead, within the held-value budget.
      const valueUnits = this.limits.valueBytes + REDACTION_CONTEXT_UNITS;
      const hold =
        !advisory && this.holdsValues()
          ? {
              valueBytes: this.limits.valueBytes,
              budget: this.heldRoom(),
              first: this.heldBytes === 0 && !this.uploader?.pendingBytes(),
            }
          : undefined;
      const snapshot =
        signal === "traces"
          ? snapshotSpan(
              record as ReadableSpan,
              remaining,
              this.options.captureContent,
              valueUnits,
              hold,
              this.mediaMemo,
            )
          : snapshotLog(
              record as ReadableLogRecord,
              remaining,
              this.options.captureContent,
              valueUnits,
              hold,
              this.mediaMemo,
            );
      if (snapshot.cut.size) this.admissionCuts.set(snapshot.record, snapshot.cut);
      if (snapshot.digested.size) this.admissionDigests.set(snapshot.record, snapshot.digested);
      if (signal === "traces") this.admissionInspected.set(snapshot.record, snapshot.inspected);
      if (snapshot.large.size) this.admissionLarge.set(snapshot.record, snapshot.large);
      if (snapshot.held) {
        this.heldBytes += snapshot.held;
        this.held.set(snapshot.record, snapshot.held);
      }
      this.pendingBytes += snapshot.bytes;
      if (signal === "traces") this.spans.set(snapshot.record as ReadableSpan, snapshot.bytes);
      else this.logs.set(snapshot.record as ReadableLogRecord, snapshot.bytes);
      if (snapshot.unresolvedResource && !advisory)
        this.issue(
          signal,
          "warning",
          0,
          "Unresolved resource attributes omitted from the telemetry snapshot",
        );
      return snapshot.record;
    } catch {
      if (advisory) return undefined;
      this.issue(
        signal,
        "dropped",
        1,
        "Telemetry snapshot exceeded its byte or complexity budget or contained unsupported data",
        undefined,
        traceIds,
      );
      return undefined;
    }
  }

  private track(span: Span): void {
    try {
      if (!this.liveSpans || this.live.size >= MAX_LIVE_SPANS) return;
      if (!(span.spanContext().traceFlags & 1) || !span.isRecording() || !announcesLiveSpan(span))
        return;
      this.live.add(span);
      if (!this.liveTimer) {
        const timer = setInterval(() => this.announceLiveSpans(), LIVE_SPAN_INTERVAL_MILLIS);
        timer.unref();
        this.liveTimer = timer;
      }
    } catch {
      // Live announcements are advisory. They never report failures or affect the span.
    }
  }

  /** Placeholders are built lazily, so input set right after a span starts is included. */
  private announceLiveSpans(): void {
    for (const span of this.live) {
      this.live.delete(span);
      try {
        // Ended without reaching onEnd: a wrapping processor filtered it, so no real span follows.
        if (span.ended) {
          this.releaseMedia(span);
          continue;
        }
        if (!this.liveSpans || !this.batchSpans) continue;
        const { record, markers } = pendingPlaceholder(span);
        const admitted = this.enqueue("traces", record, true) as ReadableSpan | undefined;
        if (!admitted) continue;
        this.placeholders.set(admitted, markers);
        this.placeholderSources.set(admitted, span);
        try {
          this.batchSpans.onEnd(admitted);
        } catch {
          this.finish("traces", [admitted]);
        }
      } catch {
        // Skipped silently, like any placeholder the queue has no room for.
      }
    }
    if (!this.live.size) this.stopLiveTimer();
  }

  private stopLiveTimer(): void {
    clearInterval(this.liveTimer);
    this.liveTimer = undefined;
  }

  private stopLiveSpans(): void {
    this.liveSpans = false;
    this.live.clear();
    this.stopLiveTimer();
  }

  /** @internal Exporter callback: marker attributes when `record` is an admitted placeholder. */
  placeholderMarkers(record: RecordValue): Attributes | undefined {
    return this.placeholders.get(record);
  }

  /** @internal Exporter callback: whether a placeholder's span has ended, so it announces nothing. */
  placeholderSettled(record: RecordValue): boolean {
    return this.placeholderSources.get(record)?.ended === true;
  }

  /** @internal Exporter callback: false once the receiver refused placeholders; queued ones are then dropped. */
  sendsPlaceholders(): boolean {
    return !this.placeholdersRejected;
  }

  /**
   * @internal Exporter callback: a trace acknowledgement lacked the placeholder-support header,
   * so the receiver predates placeholders and rejects each by its zero end time; `count` is how
   * many it rejected in that request, zero when the request carried none. Stops announcing for
   * this transport and records one warning.
   */
  rejectPlaceholders(count: number): void {
    // A client that never announces live spans (by option or setup credential) records no
    // warning about placeholders; one that does records it once, even when the acknowledgement
    // arrives during its final flush, after shutdown has already stopped announcing.
    if (!this.announcesLiveSpans || this.placeholdersRejected) return;
    this.stopLiveSpans();
    this.placeholdersRejected = true;
    this.issue(
      "traces",
      "warning",
      count,
      "This Hue server does not accept in-progress span placeholders; live spans are disabled",
    );
  }

  /** @internal Exporter callback: releases queued records after an export attempt settles. */
  finish(signal: Signal, records: RecordValue[]): void {
    for (const record of records) {
      this.releaseMedia(record);
      this.logMedia.delete(record);
      const pending = signal === "traces" ? this.spans : this.logs;
      this.pendingBytes -= pending.get(record as ReadableSpan & ReadableLogRecord) ?? 0;
      pending.delete(record as ReadableSpan & ReadableLogRecord);
      const held = this.held.get(record);
      if (held) {
        this.heldBytes -= held;
        this.held.delete(record);
      }
      // Released whole above: the part its uploads took over stays charged to them.
      const taken = this.heldByUploads.get(record);
      if (taken) {
        this.heldBytes += taken;
        this.heldByUploads.delete(record);
      }
    }
  }

  /** @internal The same bounded digest memo is used by explicit and inline media. */
  digestMedia(bytes: Uint8Array, traceId: string) {
    return this.mediaMemo.bytes(bytes, traceId);
  }

  /** @internal Retain a defensive copy within the existing held-value budget. */
  stageMedia(span: ApiSpan, file?: MediaAttachment): boolean {
    if (this.closed || !this.offloadsValues() || (file && sizeOf(file.bytes) === 0)) return true;
    if (!file) {
      const tally = newTally();
      countFallback(tally, "budget", span.spanContext().traceId);
      this.reportOffload(tally);
      return false;
    }
    if (!this.holdsValues()) {
      this.uploadFallbacks++;
      this.issue(
        "traces",
        "warning",
        1,
        "File bytes could not be uploaded while the upload service was unavailable; their hue.file metadata was recorded",
        undefined,
        [span.spanContext().traceId],
      );
      return false;
    }
    const identity = this.mediaIdentity(span)!;
    this.sweepMedia();
    const files = this.media.get(identity) ?? [];
    if (
      files.length >= 64 ||
      (!this.media.has(identity) && this.media.size >= 2048) ||
      heldBytesOf(file.bytes) > this.heldRoom()
    ) {
      this.uploadFallbacks++;
      this.issue(
        "traces",
        "warning",
        1,
        "File bytes did not fit the SDK's upload budget; their hue.file metadata was recorded",
        undefined,
        [span.spanContext().traceId],
      );
      return false;
    }
    // A file read from disk as it is uploaded holds no bytes; bytes are copied, so a later change
    // to the caller's buffer cannot alter what was recorded.
    const bytes = isByteSource(file.bytes) ? file.bytes : Uint8Array.from(file.bytes);
    files.push({ ...file, bytes });
    this.media.set(identity, files);
    this.ownMedia(span, identity);
    this.heldBytes += heldBytesOf(bytes);
    return true;
  }

  /**
   * @internal Stages the attachments placed in a span's `attribute`, replacing those an earlier
   * value of the attribute placed: each is uploaded at export when its part survives there. A
   * file that cannot be held is counted as not uploaded; it keeps its digest part.
   */
  stageParts(span: ApiSpan, attribute: string, files: MediaAttachment[]): void {
    if (this.closed || !this.offloadsValues()) return;
    const traceId = span.spanContext().traceId;
    const identity = this.mediaIdentity(span)!;
    const previous = this.media.get(identity);
    if (previous?.some((file) => file.attribute === attribute)) {
      const kept = previous.filter((file) => {
        if (file.attribute !== attribute) return true;
        this.heldBytes -= heldBytesOf(file.bytes);
        return false;
      });
      if (kept.length) this.media.set(identity, kept);
      else this.media.delete(identity);
    }
    const tally = newTally();
    for (const file of files) {
      if (!sizeOf(file.bytes)) continue;
      const refused = this.uploader?.refusal();
      if (!this.holdsValues() || refused) {
        countFallback(tally, refused ?? "unsupported", traceId);
        continue;
      }
      this.sweepMedia();
      const staged = this.media.get(identity) ?? [];
      if (
        staged.length >= MAX_BLOB_ENTRIES ||
        (!this.media.has(identity) && this.media.size >= 2048) ||
        heldBytesOf(file.bytes) > this.heldRoom()
      ) {
        countFallback(tally, "budget", traceId);
        continue;
      }
      // Attachment bytes are the attachment's own copy: held as they are.
      staged.push({ ...file, attribute });
      this.media.set(identity, staged);
      this.heldBytes += heldBytesOf(file.bytes);
      this.ownMedia(span, identity);
    }
    if (tally.fallbacks.size) this.reportOffload(tally);
  }

  /**
   * @internal Stages the attachments placed in a log record's body until the record is emitted
   * (`body` is the object passed to `emit`); {@link unstageLogParts} drops what no processor of
   * this transport admitted.
   */
  stageLogParts(body: object, traceId: string, files: MediaAttachment[]): void {
    if (this.closed || !this.offloadsValues()) return;
    const tally = newTally();
    const staged: MediaAttachment[] = [];
    for (const file of files) {
      if (!sizeOf(file.bytes)) continue;
      const refused = this.uploader?.refusal();
      if (!this.holdsValues() || refused) countFallback(tally, refused ?? "unsupported", traceId);
      else if (staged.length >= MAX_BLOB_ENTRIES) countFallback(tally, "budget", traceId);
      else staged.push({ ...file, attribute: "body" });
    }
    if (tally.fallbacks.size) this.reportOffload(tally, "logs");
    if (staged.length) this.logParts.set(body, { traceId, files: staged });
  }

  /** @internal Drops a log record's staged attachments once it was emitted. */
  unstageLogParts(body: object): void {
    this.logParts.delete(body);
  }

  /** Holds the staged attachments of a log record being admitted with the queued record, within
   * the held-value budget; those the budget refuses are counted as not uploaded. */
  private admitLogParts(log: ReadableLogRecord, queued: RecordValue): void {
    const body = log.body;
    const pending =
      body !== null && typeof body === "object" ? this.logParts.get(body as object) : undefined;
    if (!pending) return;
    this.logParts.delete(body as object);
    const size = pending.files.reduce((total, file) => total + heldBytesOf(file.bytes), 0);
    if (size > this.heldRoom()) {
      const tally = newTally();
      for (const _file of pending.files) countFallback(tally, "budget", pending.traceId);
      this.reportOffload(tally, "logs");
      return;
    }
    this.logMedia.set(queued, pending.files);
    this.heldBytes += size;
    this.held.set(queued, (this.held.get(queued) ?? 0) + size);
  }

  /** What the held-value budget has room for: values queued records hold and bytes unsettled
   * uploads hold share it. */
  private heldRoom(): number {
    return Math.max(0, MAX_HELD_BLOB_BYTES - this.heldBytes - (this.uploader?.pendingBytes() ?? 0));
  }

  /** An upload `record`'s export queued, as it is queued: flushes and the processors wait for it
   * from now on, and the `shared` bytes it holds of the record's own are charged to the upload
   * alone, so the held-value budget never counts them twice while the export goes on. An upload
   * that settles before the record is finished hands them back to the record, which still holds
   * them. */
  private uploadQueued(record: RecordValue, settled: Promise<void>, shared: number): void {
    this.awaitUploads(settled);
    const identity = this.mediaIdentity(record);
    const staged = identity
      ? (this.media.get(identity) ?? []).reduce((total, file) => total + heldBytesOf(file.bytes), 0)
      : 0;
    const taken = this.heldByUploads.get(record) ?? 0;
    const moved = Math.min(shared, (this.held.get(record) ?? 0) + staged - taken);
    if (moved <= 0) return;
    this.heldBytes -= moved;
    this.heldByUploads.set(record, taken + moved);
    // Held weakly: a pending upload never keeps its finished record alive.
    const queued = new WeakRef(record);
    const handBack = () => {
      const owner = queued.deref();
      const still = owner && this.heldByUploads.get(owner);
      if (!owner || !still) return;
      const back = Math.min(moved, still);
      this.heldBytes += back;
      if (still > back) this.heldByUploads.set(owner, still - back);
      else this.heldByUploads.delete(owner);
    };
    void settled.then(handBack, handBack);
  }

  /** Registers a span whose staged files are released if it is never exported. */
  private ownMedia(span: ApiSpan, identity: string): void {
    if (this.mediaOwners.has(identity)) return;
    const source = spanSource(span);
    const token = {};
    this.mediaOwners.set(identity, { source: new WeakRef(source), token });
    this.mediaFinalizer.register(source, { identity, token }, token);
    if (!this.mediaTimer) {
      this.mediaTimer = setInterval(() => this.sweepMedia(), LIVE_SPAN_INTERVAL_MILLIS);
      this.mediaTimer.unref();
    }
  }

  private mediaIdentity(record: object): string | undefined {
    if (!("spanContext" in record) || typeof record.spanContext !== "function") return undefined;
    const { traceId, spanId } = record.spanContext();
    return `${traceId}:${spanId}`;
  }

  private releaseMedia(record: object): void {
    const identity = this.mediaIdentity(record);
    if (!identity) return;
    this.releaseMediaIdentity(identity);
  }

  private protectMedia(record: object): void {
    const identity = this.mediaIdentity(record);
    if (!identity) return;
    const owner = this.mediaOwners.get(identity);
    if (owner) this.mediaFinalizer.unregister(owner.token);
    this.mediaOwners.delete(identity);
    if (!this.mediaOwners.size) {
      clearInterval(this.mediaTimer);
      this.mediaTimer = undefined;
    }
  }

  private releaseMediaIdentity(identity: string): void {
    const owner = this.mediaOwners.get(identity);
    if (owner) this.mediaFinalizer.unregister(owner.token);
    this.mediaOwners.delete(identity);
    if (!this.mediaOwners.size) {
      clearInterval(this.mediaTimer);
      this.mediaTimer = undefined;
    }
    const files = this.media.get(identity);
    if (!files) return;
    for (const file of files) this.heldBytes -= heldBytesOf(file.bytes);
    this.media.delete(identity);
  }

  private sweepMedia(): void {
    for (const [identity, owner] of this.mediaOwners) {
      try {
        const source = owner.source.deref();
        if (
          !source ||
          (source as ApiSpan & { ended?: boolean }).ended === true ||
          source.isRecording?.() === false
        )
          this.releaseMediaIdentity(identity);
      } catch {
        continue;
      }
    }
  }

  /** @internal Staged requests are matched against surviving events and parts before upload. */
  mediaAttachments(record: RecordValue): MediaAttachment[] {
    const logged = this.logMedia.get(record);
    if (logged) return logged;
    const identity = this.mediaIdentity(record);
    return identity ? (this.media.get(identity) ?? []) : [];
  }

  /** @internal Whether spans' content and media may be uploaded: content is captured and
   * the key is a project key (setup credentials send metadata only). A value that then cannot be
   * uploaded is cut, reported and counted. */
  offloadsValues(): boolean {
    return (
      this.uploader !== undefined &&
      this.options.captureContent &&
      !this.options.apiKey.startsWith("hue_setup_")
    );
  }

  /** @internal Whether content and media are worth holding whole for upload now: they
   * are uploaded, and the receiver has not shown it lacks the upload route. */
  holdsValues(): boolean {
    return this.offloadsValues() && this.uploader?.available() === true;
  }

  /** @internal Exporter callback: a redacted span with the values its redaction left to the
   * upload step placed: listed under `hue.blobs` with their uploads queued (each added to `late`
   * once it settles, and charged in place of the `queued` record it came from), or cut as before.
   * Never rejects. */
  async offloadSpan<T extends RecordValue>(
    span: T,
    collector: OffloadCollector,
    upload: UploadContext,
    tally: OffloadTally,
    late: LateUploads,
    queued: RecordValue,
  ): Promise<T> {
    // A record without a readable context cannot name its trace: its values are cut.
    const traceId = recordTraceId(span);
    const valueBytes = this.limits.valueBytes;
    // A record placed as a fallback counts its values there: its queued uploads are not added.
    const own: LateUploads = {
      tally: newTally(),
      settled: [],
      queued: (settled, shared) => this.uploadQueued(queued, settled, shared),
    };
    try {
      if (!this.uploader) throw new Error("Uploads are unavailable");
      const attributes = await offloadAttributes(span.attributes, collector, {
        uploader: this.uploader,
        traceId,
        valueBytes,
        upload,
        tally,
        memo: this.mediaMemo,
        background: own,
      });
      if (own.settled.length)
        late.settled.push(mergeWhenSettled(late.tally, own.tally, own.settled));
      return { ...span, attributes: attributes as Attributes };
    } catch {
      return {
        ...span,
        attributes: fallbackAttributes(
          span.attributes,
          collector,
          valueBytes,
          tally,
          traceId,
          this.mediaMemo,
        ) as Attributes,
      };
    }
  }

  /** @internal Exporter callback: a redacted log record with the media its redaction left to
   * the upload step placed: its attributes' and its body's files listed under its own `hue.blobs`
   * (keys `<attribute>#<pointer>`, `body#<pointer>`) with their uploads queued under the log
   * record's trace (charged in place of the `queued` record); a file refused keeps its bytes
   * inline, and the record is cut as before. Never rejects. */
  async offloadLog(
    log: ReadableLogRecord,
    collector: OffloadCollector,
    upload: UploadContext,
    tally: OffloadTally,
    late: LateUploads,
    queued: RecordValue,
  ): Promise<ReadableLogRecord> {
    const traceId = log.spanContext?.traceId ?? "";
    const valueBytes = this.limits.valueBytes;
    const placed = (result: { attributes: Record<string, unknown>; body?: unknown }) => ({
      ...log,
      attributes: result.attributes as ReadableLogRecord["attributes"],
      ...(collector.body ? { body: result.body as ReadableLogRecord["body"] } : {}),
    });
    const own: LateUploads = {
      tally: newTally(),
      settled: [],
      queued: (settled, shared) => this.uploadQueued(queued, settled, shared),
    };
    try {
      if (!this.uploader) throw new Error("Uploads are unavailable");
      const result = await offloadRecord(log.attributes, collector, {
        uploader: this.uploader,
        traceId,
        valueBytes,
        upload,
        tally,
        memo: this.mediaMemo,
        background: own,
      });
      if (own.settled.length)
        late.settled.push(mergeWhenSettled(late.tally, own.tally, own.settled));
      return placed(result);
    } catch {
      return placed(
        fallbackRecord(log.attributes, collector, valueBytes, tally, traceId, this.mediaMemo),
      );
    }
  }

  /** @internal Exporter callback: counts an export's uploads and reports each kind of fallback
   * once, as a warning naming its traces: the values were exported cut as before, or, `late`,
   * their uploads failed after their records listed them. */
  reportOffload(tally: OffloadTally, signal: Signal = "traces", late = false): void {
    this.uploaded += tally.uploaded;
    for (const [reason, { count, traceIds }] of tally.fallbacks) {
      this.uploadFallbacks += count;
      this.issue(
        signal,
        "warning",
        count,
        (late ? LATE_FALLBACK_MESSAGES : FALLBACK_MESSAGES)[reason],
        undefined,
        traceIds.size && traceIds.size <= MAX_ISSUE_TRACE_IDS ? [...traceIds] : undefined,
      );
    }
  }

  /** @internal Exporter callback: counts records the collector acknowledged. */
  acceptedRecords(signal: Signal, count: number): void {
    this.accepted[signal] += count;
  }

  /** @internal Exporter callback: a trace's root span carries the count of its records the SDK
   * never sent, read when the request carrying the root is made (a record lost after that is
   * not counted: the root has left). The count stays until that request is acknowledged
   * (`consumeDroppedRecords`): a root written again under retry says the same, and a root whose
   * request failed has not told Hue, so its count is not forgotten with it. */
  withDroppedRecords(span: ReadableSpan): ReadableSpan {
    if (span.parentSpanContext || !this.marksDroppedRecords) return span;
    const count = this.droppedByTrace.get(span.spanContext().traceId);
    if (!count) return span;
    return { ...span, attributes: { ...span.attributes, [DROPPED_RECORDS_KEY]: count } };
  }

  /** @internal For an import that replays recorded spans: roots never carry the count of
   * records this run did not deliver, so a later run that delivers them sends each root as it
   * was first sent, which Hue keeps as an exact replay. The losses are still counted and
   * reported. */
  omitDroppedRecords(): void {
    this.marksDroppedRecords = false;
  }

  /** @internal Exporter callback: these counts reached Hue on their traces' roots. Only what a
   * root carried is forgotten: a record lost while its request was in flight is still counted. */
  consumeDroppedRecords(counts: ReadonlyMap<string, number>): void {
    for (const [traceId, count] of counts) {
      const left = (this.droppedByTrace.get(traceId) ?? 0) - count;
      if (left > 0) this.droppedByTrace.set(traceId, left);
      else this.droppedByTrace.delete(traceId);
    }
  }

  /** @internal Exporter callback: records Hue refused for their rate for longer than an export
   * holds them. The receiver stored none of them, so each is counted on its trace's root, as a
   * record never sent is. */
  countUndelivered(records: readonly RecordValue[]): void {
    for (const record of records) {
      const traceId = traceIdsOf([record])?.[0];
      if (traceId) this.countDropped(traceId, 1);
    }
  }

  /** @internal Exporter callback: waits `millis` for a receiver that limited the rate, unless
   * the holds are released first; true when the wait ran its course. */
  holdForRateLimit(millis: number): Promise<boolean> {
    if (this.holdsReleased) return Promise.resolve(false);
    return new Promise((resolve) => {
      const release = () => {
        clearTimeout(timer);
        this.holds.delete(release);
        resolve(false);
      };
      const timer = setTimeout(() => {
        this.holds.delete(release);
        resolve(true);
      }, millis);
      this.holds.add(release);
    });
  }

  /** @internal Ends every rate-limit hold now and refuses new ones, once a shutdown's caller has
   * stopped waiting: the held records are reported lost to the rate limit, and no timer of theirs
   * keeps the process running for the receiver's `Retry-After`. Queued and in-flight uploads end
   * too, and no other starts: their records' entries stay and the uploads count as failed, and
   * values not yet exported are exported cut, as before uploads existed. */
  releaseRateLimitHolds(): void {
    this.holdsReleased = true;
    for (const release of [...this.holds]) release();
    this.uploader?.close();
  }

  /** @internal Exporter callback: what the receiver accepts, as it last advertised. */
  receiverLimits(): ReceiverLimits {
    return this.limits;
  }

  /** @internal Exporter callback: adopts the limits a response advertised, clamped to their
   * ranges; later requests, admissions and value cuts follow them. */
  adoptLimits(headers: IncomingHttpHeaders): void {
    this.limits = advertisedLimits(this.limits, headers);
  }

  /** Bounded: a trace whose root never arrives (an abandoned run) gives way to newer ones. */
  private countDropped(traceId: string, count: number): void {
    if (this.droppedByTrace.size >= 1024 && !this.droppedByTrace.has(traceId))
      this.droppedByTrace.delete(this.droppedByTrace.keys().next().value!);
    this.droppedByTrace.set(traceId, (this.droppedByTrace.get(traceId) ?? 0) + count);
  }

  /** @internal Records a sanitized issue, updates counters and rate-limits the diagnostic callback. */
  issue(
    signal: Signal,
    kind: ExportIssue["kind"],
    count: number,
    message: string,
    status?: number,
    traceIds?: string[],
  ): void {
    if (kind === "dropped") this.dropped[signal] += count;
    if (kind === "rejected") this.rejected[signal] += count;
    else if (kind !== "warning") this.failed[signal] += count;
    // A record lost before any request names its one trace; a failed batch is retried or
    // reported as delivery, not counted here.
    if ((kind === "dropped" || kind === "invalid") && count > 0 && traceIds?.length === 1)
      this.countDropped(traceIds[0]!, count);
    const issue: ExportIssue = {
      sequence: ++this.sequence,
      signal,
      kind,
      count,
      message,
      ...(status !== undefined ? { status } : {}),
      ...(traceIds !== undefined ? { traceIds } : {}),
    };
    if (kind !== "warning") this.failureSequence = issue.sequence;
    this.issues.push(issue);
    if (this.issues.length > 128) this.issues.shift();
    // One diagnostic task at a time, at most once a second. No unbounded promise
    // queue if a user callback never settles; all issues remain in counts/history.
    if (
      this.options.onExportIssue &&
      !this.diagnosticPending &&
      Date.now() - this.lastDiagnosticAt >= 1000
    ) {
      this.diagnosticPending = true;
      // Warnings (for example the allowInsecureHttp notice) do not consume the slot, so the first
      // real failure still reaches the callback promptly.
      if (kind !== "warning") this.lastDiagnosticAt = Date.now();
      void Promise.resolve()
        .then(() => this.options.onExportIssue?.({ ...issue }))
        .then(
          () => {
            this.diagnosticPending = false;
          },
          () => {
            this.diagnosticPending = false;
          },
        );
    }
  }

  /** @internal Counts a helper capture or instrumentation failure that preserved application execution. */
  /** Records a capture or instrumentation failure, named to the trace it happened in when the
   * caller knows it, so a runner with several traces in flight can tell whose it was. */
  instrumentationFailure(
    signal: Signal = "traces",
    message = "Telemetry capture or instrumentation failed; application execution was preserved",
    count = 1,
    traceId?: string,
  ): void {
    if (!Number.isSafeInteger(count) || count < 1) return;
    this.instrumentationFailures += count;
    this.issue(signal, "invalid", 0, message, undefined, traceId ? [traceId] : undefined);
  }

  /** Cumulative counters and current queue gauges. */
  getReport(): ExportReport {
    return {
      acceptedSpans: this.accepted.traces,
      acceptedLogs: this.accepted.logs,
      rejectedSpans: this.rejected.traces,
      rejectedLogs: this.rejected.logs,
      failedSpans: this.failed.traces,
      failedLogs: this.failed.logs,
      pendingSpans: this.spans.size,
      pendingLogs: this.logs.size,
      droppedSpans: this.dropped.traces,
      droppedLogs: this.dropped.logs,
      pendingBytes: this.pendingBytes,
      instrumentationFailures: this.instrumentationFailures,
      uploadedValues: this.uploaded,
      uploadFallbacks: this.uploadFallbacks,
    };
  }

  /** Copies of the latest 128 sanitized issues, oldest first. */
  getIssues(): ExportIssue[] {
    return this.issues.map((issue) => ({ ...issue }));
  }

  /** Monotonic failure marker, retained even when the bounded issue history rolls over. */
  getFailureSequence(): number {
    return this.failureSequence;
  }

  /** Spans of a trace this transport has handed to its exporter, by trace id, for the newest
   * traces only: a runner compares the count with the trace receipt's span count to know that
   * every span of a case landed, not only the root. Undefined for a trace it does not remember,
   * which is not the same as none: the caller must not take an unknown count for complete. */
  spansEnded(traceId: string): number | undefined {
    return this.endedSpans.get(traceId);
  }
  private endedSpans = new Map<string, number>();
  private countEnded(span: ReadableSpan): void {
    let traceId: string;
    try {
      traceId = span.spanContext().traceId;
    } catch {
      return;
    }
    this.endedSpans.set(traceId, (this.endedSpans.get(traceId) ?? 0) + 1);
    if (this.endedSpans.size > MAX_REMEMBERED_TRACES)
      this.endedSpans.delete(this.endedSpans.keys().next().value!);
  }

  /**
   * Waits for the processors' and exporters' in-flight work, then for the uploads their exports
   * queued; drain the providers first. Only the sends are serialized: a flush sends its records
   * once an earlier flush sent its own, never after that flush's uploads.
   *
   * @throws HueExportError when a new non-warning issue was recorded since the previous observation.
   */
  flush(): Promise<ExportReport> {
    return this.flushRecords().report;
  }

  /**
   * @internal A flush in two steps: its send settles `sent`, then it waits on its own for the
   * uploads queued so far and settles `report` as {@link flush} does. `providers` (the client's
   * provider flush) runs first, before the flush joins the transport's sends, so a hung borrowed
   * provider never holds up the transport's own flushes. `sent` waits for it, though, and the
   * client starts each flush once the previous one's `sent` settles: it holds up the client's
   * later flushes.
   */
  flushRecords(providers?: () => Promise<void>): {
    sent: Promise<unknown>;
    report: Promise<ExportReport>;
  } {
    const from = this.observedSequence;
    const join = () => this.sendRecords();
    const sent = providers ? this.sendingRecords.run(true, providers).then(join, join) : join();
    const report = sent.then(async (processors) => {
      // Exports the processors did not start (a timer's, still in flight) queued uploads too.
      await this.drainUploads();
      return this.flushReport(from, processors);
    });
    return { sent, report };
  }

  /** Sends what the processors and exporters hold, once the previous flush's send ended. */
  private sendRecords(): Promise<PromiseSettledResult<void>[]> {
    const send = () =>
      this.sendingRecords.run(true, async () => {
        const processors = await Promise.allSettled([
          this.spanProcessor.forceFlush(),
          this.logRecordProcessor.forceFlush(),
        ]);
        await Promise.all([this.traceExporter.forceFlush(), this.logExporter.forceFlush()]);
        return processors;
      });
    const sent = (this.sendPromise ?? Promise.resolve()).then(send, send);
    this.sendPromise = sent;
    const clear = () => {
      if (this.sendPromise === sent) this.sendPromise = undefined;
    };
    void sent.then(clear, clear);
    return sent;
  }

  /** @internal Exporter callback: an export's queued uploads, reported once they all settle. */
  awaitUploads(report: Promise<void>): void {
    // Never an unhandled rejection, whatever the report does.
    const tracked = report.catch(() => {});
    this.uploadReports.add(tracked);
    void tracked.then(() => this.uploadReports.delete(tracked));
    const earlier = this.uploadsSettled;
    this.uploadsSettled = tracked.then(() => earlier);
  }

  /** Waits for the uploads queued so far; each ends within its lifetime, so this is bounded. */
  private drainUploads(): Promise<void> {
    return this.uploadsSettled;
  }

  private flushReport(from: number, processors: PromiseSettledResult<void>[]): ExportReport {
    for (const [index, result] of processors.entries())
      if (result.status === "rejected") {
        const signal = index === 0 ? "traces" : "logs";
        if (!this.issues.some((issue) => issue.sequence > from && issue.signal === signal))
          this.issue(signal, "failed", 0, "Telemetry processor flush failed");
      }
    const issues = this.issues.filter((issue) => issue.sequence > from && issue.kind !== "warning");
    this.observedSequence = this.sequence;
    const report = this.getReport();
    if (this.failureSequence > from) throw new HueExportError(issues, report);
    return report;
  }

  /**
   * Flushes and stops the processors, waits for queued uploads, then ends the uploader; records
   * emitted afterwards are dropped and counted. In attach mode call it after shutting down the
   * application's providers.
   *
   * @throws HueExportError when the final flush observed new failures.
   */
  shutdown(): Promise<ExportReport> {
    this.shutdownPromise ??= (async () => {
      this.closed = true;
      try {
        return await this.flush();
      } finally {
        await Promise.allSettled([
          this.spanProcessor.shutdown(),
          this.logRecordProcessor.shutdown(),
        ]);
        await Promise.allSettled([this.traceExporter.forceFlush(), this.logExporter.forceFlush()]);
        await this.drainUploads();
        this.uploader?.close();
        // The reports of uploads the close ended land before shutdown resolves.
        await this.drainUploads();
        for (const identity of this.media.keys()) this.releaseMediaIdentity(identity);
        this.logParts.clear();
        this.mediaMemo.clear();
      }
    })();
    return this.shutdownPromise;
  }
}

/** The distinct trace ids of a batch, or undefined past 64 of them, when an issue would name too
 * many traces to tell one apart; a record whose context cannot be read is left out. */
const MAX_ISSUE_TRACE_IDS = 64;
/** How many traces' ended-span counts one transport remembers; the oldest is forgotten first. */
const MAX_REMEMBERED_TRACES = 10_000;
function traceIdsOf(records: readonly RecordValue[]): string[] | undefined {
  const ids = new Set<string>();
  for (const record of records) {
    try {
      // A span reports its context; a log record carries the span's identifiers.
      const traceId =
        "spanContext" in record && typeof record.spanContext === "function"
          ? (record as ReadableSpan).spanContext().traceId
          : (record as ReadableLogRecord).spanContext?.traceId;
      if (traceId) ids.add(traceId);
    } catch {
      // A record without a readable context names no trace.
    }
    if (ids.size > MAX_ISSUE_TRACE_IDS) return undefined;
  }
  // No readable trace names nobody, which is not the same as naming no one's: the issue may
  // concern any trace in flight.
  return ids.size ? [...ids] : undefined;
}

/** The serialized size of one attribute value, for choosing what to shed first. */
function valueBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (value instanceof Uint8Array) return value.byteLength;
  if (value !== null && typeof value === "object") {
    try {
      return Buffer.byteLength(JSON.stringify(value));
    } catch {
      return 0;
    }
  }
  return 8;
}

/** One content value a record may shed: a log's body, or a content attribute of the record, of
 * one of a span's events or of one of its links. */
interface Sheddable {
  where: "body" | "own" | "event" | "link";
  index: number;
  key: string;
  bytes: number;
}

/** A value smaller than this would grow its record if the receiver's marker replaced it. */
const MIN_SHED_BYTES = 64;

/**
 * The content values a record over the receiver's limits may shed, in the order it sheds them: a
 * log's body first, then the largest values first. Metadata is never shed: a record too large
 * without its content is lost whole.
 */
function sheddableContent(record: RecordValue, signal: Signal): Sheddable[] {
  const found: Sheddable[] = [];
  const consider = (where: Sheddable["where"], index: number, key: string, value: unknown) => {
    if (!isContentKey(key) || isTruncatedMarker(value)) return;
    const bytes = valueBytes(value);
    if (bytes >= MIN_SHED_BYTES) found.push({ where, index, key, bytes });
  };
  for (const [key, value] of Object.entries(record.attributes)) consider("own", 0, key, value);
  if (signal === "traces") {
    const span = record as ReadableSpan;
    span.events.forEach((event, index) => {
      for (const [key, value] of Object.entries(event.attributes ?? {}))
        consider("event", index, key, value);
    });
    span.links.forEach((link, index) => {
      for (const [key, value] of Object.entries(link.attributes ?? {}))
        consider("link", index, key, value);
    });
  }
  // Stable: of values of one size, the record's own come first, then its events' and links'.
  found.sort((a, b) => b.bytes - a.bytes);
  const log = record as ReadableLogRecord;
  if (signal === "logs" && log.body !== undefined && !isTruncatedMarker(log.body))
    found.unshift({ where: "body", index: 0, key: "body", bytes: valueBytes(log.body) });
  return found;
}

/**
 * The record with `shed` replaced by the receiver's marker, each listed under `hue.truncated` as
 * the receiver lists a cut of the same place: the key alone, `body`, `event:<name>:<key>` or
 * `link:<key>`.
 */
function shedContent(record: RecordValue, signal: Signal, shed: readonly Sheddable[]): RecordValue {
  const own: Record<string, unknown> = { ...record.attributes };
  const events = new Map<number, Record<string, unknown>>();
  const links = new Map<number, Record<string, unknown>>();
  const span = record as ReadableSpan;
  const listed: string[] = [];
  let body: unknown;
  for (const value of shed) {
    const marker = truncatedMarker(value.bytes);
    if (value.where === "body") {
      body = marker;
      listed.push("body");
    } else if (value.where === "own") {
      own[value.key] = marker;
      listed.push(value.key);
    } else {
      const target = value.where === "event" ? events : links;
      const markers = target.get(value.index) ?? {};
      markers[value.key] = marker;
      target.set(value.index, markers);
      listed.push(
        value.where === "event"
          ? `event:${span.events[value.index]!.name}:${value.key}`
          : `link:${value.key}`,
      );
    }
  }
  own[TRUNCATED_KEY] = withTruncatedKeys(record.attributes[TRUNCATED_KEY], listed);
  if (signal === "logs")
    return {
      ...record,
      ...(body === undefined ? {} : { body }),
      attributes: own,
    } as ReadableLogRecord;
  return {
    ...record,
    attributes: own,
    events: events.size
      ? span.events.map((event, index) => {
          const markers = events.get(index);
          return markers ? { ...event, attributes: { ...event.attributes, ...markers } } : event;
        })
      : span.events,
    links: links.size
      ? span.links.map((link, index) => {
          const markers = links.get(index);
          return markers ? { ...link, attributes: { ...link.attributes, ...markers } } : link;
        })
      : span.links,
  } as ReadableSpan;
}

/** Whether a trace id can name an upload's trace: 32 lowercase hex digits, not all zero. */
function isUploadTraceId(traceId: unknown): boolean {
  return typeof traceId === "string" && /^[0-9a-f]{32}$/.test(traceId) && !/^0+$/.test(traceId);
}

class ReportingExporter<T extends RecordValue> {
  private pending = new Set<Promise<void>>();
  constructor(
    private transport: ExportSink,
    private signal: Signal,
    private serializer: ISerializer<T[], Response>,
    private metrics: IExporterMetricsHelper<T[]>,
    private redact: (record: T, cache: ResourceCache, offload?: OffloadCollector) => T,
  ) {}

  export(records: T[], callback: (result: ExportResult) => void): void {
    const work = this.exportRecords(records)
      .then(
        () => callback({ code: ExportResultCode.SUCCESS }),
        () =>
          callback({
            code: ExportResultCode.FAILED,
            error: new Error("Hue telemetry export failed; inspect SDK export issues"),
          }),
      )
      .finally(() => {
        this.transport.finish(this.signal, records);
        this.pending.delete(work);
      })
      .catch(() => {});
    this.pending.add(work);
  }

  /** Real records first, then placeholders whose real span is not already in this batch. */
  private ordered(records: T[]): { record: T; markers?: Attributes }[] {
    if (this.signal !== "traces") return records.map((record) => ({ record }));
    const real: { record: T; markers?: Attributes }[] = [];
    const placeholders: { record: T; markers: Attributes }[] = [];
    for (const record of records) {
      const markers = this.transport.placeholderMarkers(record);
      if (markers) placeholders.push({ record, markers });
      else real.push({ record });
    }
    if (!placeholders.length || !this.transport.sendsPlaceholders()) return real;
    const ended = new Set(real.map(({ record }) => (record as ReadableSpan).spanContext().spanId));
    // A span that already ended, in this batch or not (even one a wrapping processor filtered),
    // is no longer running, so its placeholder is not sent.
    for (const placeholder of placeholders)
      if (
        !ended.has((placeholder.record as ReadableSpan).parentSpanContext?.spanId ?? "") &&
        !this.transport.placeholderSettled(placeholder.record)
      )
        real.push(placeholder);
    return real;
  }

  /** Places and sends the records; the uploads their placement queued are reported once they
   * settle, after the records were sent, never awaited here. */
  private async exportRecords(records: T[]): Promise<void> {
    const late: LateUploads = { tally: newTally(), settled: [] };
    try {
      await this.placeAndSend(records, late);
    } finally {
      if (late.settled.length) this.reportWhenSettled(late);
    }
  }

  /** Reports an export's uploads once they all settle. Built apart from the export, so a pending
   * upload never keeps the export's records alive. */
  private reportWhenSettled(late: LateUploads): void {
    this.transport.awaitUploads(
      Promise.all(late.settled).then(() =>
        this.transport.reportOffload(late.tally, this.signal, true),
      ),
    );
  }

  private async placeAndSend(records: T[], late: LateUploads): Promise<void> {
    // Completed records and placeholders travel in separate requests, completed records first,
    // so a rejection count is always one kind of record's. Placeholders are advisory: losing one
    // is a warning, never an export failure.
    const real: T[] = [];
    const pending: T[] = [];
    const cache: ResourceCache = new WeakMap();
    let failed = false;
    // A request of completed records the receiver refused or did not answer, as opposed to a
    // record this side could not redact or encode: placeholders are advisory, so such a receiver
    // gets no second request.
    let refused = false;
    let redactedBytes = 0;
    const invalid = (placeholder: boolean, message: string, record?: T) => {
      if (placeholder)
        this.transport.issue(
          this.signal,
          "warning",
          1,
          `${message} (in-progress span placeholder)`,
        );
      else {
        failed = true;
        this.transport.issue(
          this.signal,
          "invalid",
          1,
          message,
          undefined,
          record ? traceIdsOf([record]) : undefined,
        );
      }
    };
    const resourceDeadline = Date.now() + this.transport.options.timeoutMillis;
    // How long this export has held its records for a rate-limited receiver.
    const hold = { millis: 0 };
    // A span's values over the inline limit are hashed and placed before it is measured, within
    // the export's hashing deadline; their uploads are queued, never awaited, and a placeholder's
    // values never upload.
    const upload: UploadContext = {
      deadline: Date.now() + uploadBudgetMillis(this.transport.options.timeoutMillis),
      wait: async () => false,
    };
    const tally = newTally();
    // Each record's attachments to upload once it is fitted, with the queued record holding them.
    const helpers = new Map<T, { files: MediaAttachment[]; baseline: string[]; source: T }>();
    const placed: {
      record: T;
      markers?: Attributes;
      files: MediaAttachment[];
      redacted: T | Promise<T>;
    }[] = [];
    for (const { record, markers } of this.ordered(records)) {
      try {
        const ready = record.resource.waitForAsyncAttributes?.();
        if (ready) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              ready,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error("Resource deadline exceeded")),
                  Math.max(1, resourceDeadline - Date.now()),
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
        const uploads = !markers && this.transport.offloadsValues();
        // A log record's media upload under its own trace: one without a trace is not offered.
        const offload: OffloadCollector | undefined =
          uploads &&
          (this.signal === "traces" ||
            isUploadTraceId((record as ReadableLogRecord).spanContext?.traceId))
            ? this.signal === "traces"
              ? { candidates: [], cut: [] }
              : { candidates: [], cut: [], log: true }
            : undefined;
        const redacted = this.redact(record, cache, offload);
        let files = uploads
          ? survivingMedia(this.transport.mediaAttachments(record), redacted, tally)
          : [];
        if (this.signal === "logs" && files.length) {
          // A log record's attachments upload with the media its body holds, in the one step
          // that places a log record's files; a record without a trace uploads none.
          if (offload) offload.attachments = files;
          else
            for (let index = 0; index < files.length; index++)
              countFallback(tally, "budget", recordTraceId(record));
          files = [];
        }
        const offloaded =
          offload &&
          (offload.candidates.length ||
            offload.cut.length ||
            offload.body ||
            offload.attachments?.length)
            ? this.signal === "traces"
              ? (this.transport.offloadSpan(
                  redacted as ReadableSpan,
                  offload,
                  upload,
                  tally,
                  late,
                  record,
                ) as Promise<T>)
              : (this.transport.offloadLog(
                  redacted as ReadableLogRecord,
                  offload,
                  upload,
                  tally,
                  late,
                  record,
                ) as Promise<T>)
            : undefined;
        placed.push({
          record,
          files,
          ...(markers ? { markers } : {}),
          redacted: offloaded ?? redacted,
        });
      } catch {
        if (!markers && this.transport.offloadsValues()) {
          const files = this.transport.mediaAttachments(record);
          for (let index = 0; index < files.length; index++)
            countFallback(tally, "budget", recordTraceId(record));
        }
        invalid(
          markers !== undefined,
          "Telemetry record could not be redacted or exceeds supported content limits",
          record,
        );
      }
    }
    for (const { record, markers, files, redacted: placing } of placed) {
      let retained = files;
      try {
        let redacted = await placing;
        // Added after redaction, so a redactor cannot alter the markers or the parent identity.
        if (markers)
          redacted = {
            ...redacted,
            attributes: { ...(redacted as ReadableSpan).attributes, ...markers },
          };
        else if (this.signal === "traces") {
          const attributes = (redacted as ReadableSpan).attributes;
          const kept = withoutPlaceholderMarkers(attributes);
          if (kept !== attributes) redacted = { ...redacted, attributes: kept };
        }
        if (files.length) {
          const listed: unknown = redacted.attributes[BLOBS_KEY];
          const baseline = Array.isArray(listed)
            ? listed.filter((entry): entry is string => typeof entry === "string")
            : [];
          retained = files.slice(0, Math.max(0, MAX_BLOB_ENTRIES - baseline.length));
          for (let index = retained.length; index < files.length; index++)
            countFallback(tally, "budget", recordTraceId(redacted));
          if (retained.length) {
            // Fit the event or part and its reference together before sending customer bytes.
            redacted = {
              ...redacted,
              attributes: {
                ...redacted.attributes,
                [BLOBS_KEY]: [...baseline, ...retained.map(mediaEntry)],
              },
            };
            helpers.set(redacted, { files: retained, baseline, source: record });
          }
        }
        const bytes =
          512 +
          estimateRecordBytes(
            recordData(redacted, this.signal),
            this.transport.options.maxQueueBytes - redactedBytes,
          );
        if (redactedBytes + bytes > this.transport.options.maxQueueBytes)
          throw new RangeError("Redacted batch exceeds byte budget");
        redactedBytes += bytes;
        (markers ? pending : real).push(redacted);
      } catch {
        for (let index = 0; index < retained.length; index++)
          countFallback(tally, "budget", recordTraceId(record));
        invalid(
          markers !== undefined,
          "Telemetry record could not be redacted or exceeds supported content limits",
          record,
        );
      }
    }
    // Each record is encoded once to measure it, and compressed only when its encoding alone
    // could be over the wire limit; a request is encoded and compressed once more to be sent, and
    // that request is measured against the receiver's limits before it goes. Records sharing a
    // resource and scope are grouped on the wire, so the sum of the individual encodings plus a
    // fixed framing margin bounds a request's size before compression.
    const encode = (batch: T[]): Uint8Array => {
      const encoded = this.serializer.serializeRequest(batch);
      if (!encoded) throw new Error("Telemetry record could not be serialized");
      return encoded;
    };
    // A record measured alone, compressed: reused when it is sent alone.
    const measured = new Map<T, EncodedRequest>();
    type Fitted = { record: T; bytes: number; request?: EncodedRequest };
    /** The record as one request, when that request fits the receiver's limits: its encoding
     * after decompression, and after gzip on the wire, compressed only when it could be over. */
    const probe = async (record: T): Promise<Fitted | undefined> => {
      const data = encode([record]);
      const limits = this.transport.receiverLimits();
      if (data.byteLength > limits.decodedBytes) return undefined;
      if (fitsWithoutCompression(data.byteLength, limits.requestBytes))
        return { record, bytes: data.byteLength };
      const request = { data, compressed: await compress(data) };
      // Read again: the other signal's export may have adopted lower limits meanwhile.
      if (!fitsLimits(request, this.transport.receiverLimits())) return undefined;
      return { record, bytes: data.byteLength, request };
    };
    /** The record, shed until a request of it alone fits the receiver's limits, and its encoded
     * size; undefined when it cannot fit even with every content value shed. */
    const fit = async (record: T): Promise<{ record: T; bytes: number } | undefined> => {
      // A record over a limit sheds its content values, largest first, each replaced by the
      // receiver's marker and listed under `hue.truncated`: the span and what it still holds
      // reach Hue, and a reader sees what was shed. Only a record too large without any content
      // value is lost, and counted on its root.
      let fitted = await probe(record);
      if (!fitted) {
        const sheddable = sheddableContent(record, this.signal);
        const shedding = (count: number) =>
          probe(shedContent(record, this.signal, sheddable.slice(0, count)) as T);
        // The fewest values to shed are found by trying a doubling count of the largest, then
        // halving the range between the last count that did not fit and the first that did:
        // encodings and compressions logarithmic in the values shed, where shedding one value
        // per encoding took time quadratic in them.
        let failed = 0;
        let fits = 0;
        for (let step = 1; !fitted; step *= 2) {
          if (failed >= sheddable.length) return undefined;
          fits = Math.min(sheddable.length, failed + step);
          fitted = await shedding(fits);
          if (!fitted) failed = fits;
        }
        while (fits - failed > 1) {
          const gap = fits - failed;
          const middle = failed + Math.floor(gap / 2);
          const result = await shedding(middle);
          if (result) {
            fits = middle;
            fitted = result;
          } else failed = middle;
        }
      }
      if (fitted.request) measured.set(fitted.record, fitted.request);
      return { record: fitted.record, bytes: fitted.bytes };
    };
    /** A request of `batch`, encoded and compressed, when it fits the receiver's limits. */
    const request = async (batch: T[]): Promise<EncodedRequest | undefined> => {
      const known = batch.length === 1 ? measured.get(batch[0]!) : undefined;
      const data = known?.data ?? encode(batch);
      if (data.byteLength > this.transport.receiverLimits().decodedBytes) return undefined;
      const body = { data, compressed: known?.compressed ?? (await compress(data)) };
      // Measured against the limits as they stand once it is compressed: the other signal's
      // export may have adopted lower ones meanwhile, and each attempt checks them again.
      return fitsLimits(body, this.transport.receiverLimits()) ? body : undefined;
    };
    /** Sends one kind of record (completed records, or placeholders alone: `advisory`) in one
     * request, or in halves when it is over the receiver's limits. A trace's root among completed
     * records carries the trace's dropped-record count as it stands when its request is made, so
     * it includes losses earlier requests of this export met; the acknowledgement consumes
     * exactly the counts the request carried, and a failed request keeps them. */
    const deliver = async (records: T[], advisory: boolean, refitted = false): Promise<void> => {
      // A request of placeholders never fails the export, and none follows an acknowledgement
      // that turned live spans off.
      if (advisory && !this.transport.sendsPlaceholders()) return;
      const carried = new Map<string, number>();
      const batch =
        advisory || this.signal !== "traces"
          ? records
          : records.map((record) => {
              const counted = this.transport.withDroppedRecords(record as ReadableSpan);
              const count = counted.attributes[DROPPED_RECORDS_KEY];
              if (counted !== record && typeof count === "number")
                carried.set(counted.spanContext().traceId, count);
              return counted as T;
            });
      let body: EncodedRequest | undefined;
      try {
        body = await request(batch);
      } catch {
        for (const record of batch)
          invalid(advisory, "Telemetry record could not be serialized", record);
        return;
      }
      if (!body) {
        // Records that compress worse together than the batch target assumed travel in halves.
        if (batch.length > 1) {
          const half = Math.ceil(batch.length / 2);
          await deliver(batch.slice(0, half), advisory);
          await deliver(batch.slice(half), advisory);
          return;
        }
        // One record over limits the receiver lowered after it was measured: shed it again.
        const [record] = batch as [T];
        let fitted: { record: T } | undefined;
        try {
          fitted = refitted ? undefined : await fit(record);
        } catch {
          invalid(advisory, "Telemetry record could not be serialized", record);
          return;
        }
        if (!fitted) {
          invalid(advisory, OVER_REQUEST_LIMIT, record);
          return;
        }
        await deliver([fitted.record], advisory, true);
        return;
      }
      const sent = await this.send(batch, advisory ? batch.length : 0, body, hold);
      // The receiver lowered its limits below this request while it was sent or held: the
      // records go back to be split and shed under the new limits.
      if (sent === "refit") await deliver(batch, advisory);
      else if (sent) this.transport.consumeDroppedRecords(carried);
      else if (!advisory) {
        failed = true;
        refused = true;
      }
    };
    /** Sends one kind of record in requests: completed records, whose roots carry their traces'
     * dropped-record counts, or placeholders alone (`advisory`). Requests are batched to the
     * ordinary target size; a record larger than it travels alone, up to the receiver's limits. */
    const pack = async (accepted: T[], advisory: boolean) => {
      // Every record is measured, shed and, where it cannot be sent, counted lost before any root
      // is written, so a root carries the losses of children that ended after it.
      const admitted: {
        fitted: { record: T; bytes: number };
        attachments?: { record: T; files: MediaAttachment[]; source: T };
      }[] = [];
      for (const record of accepted) {
        let fitted: { record: T; bytes: number } | undefined;
        let attachments: { record: T; files: MediaAttachment[]; source: T } | undefined;
        const helper = helpers.get(record);
        let remaining = helper?.files ?? [];
        try {
          fitted = await fit(record);
          if (fitted && helper) {
            const fittedRecord = fitted.record;
            const traceId = recordTraceId(fittedRecord);
            const matched = survivingMedia(remaining, fittedRecord, tally, record);
            remaining = matched;
            const listed = fittedRecord.attributes[BLOBS_KEY];
            const entries = Array.isArray(listed) ? [...listed] : [];
            const files = matched.filter((file) => {
              const index = entries.indexOf(mediaEntry(file), helper.baseline.length);
              if (index < 0) {
                countFallback(tally, "budget", traceId);
                return false;
              }
              entries.splice(index, 1);
              return true;
            });
            remaining = files;
            // Drop provisional entries, retaining only the original references after fitting.
            const attributes = { ...fittedRecord.attributes };
            if (Array.isArray(listed)) {
              const baseline = listed.slice(0, helper.baseline.length);
              if (baseline.length) attributes[BLOBS_KEY] = baseline;
              else delete attributes[BLOBS_KEY];
            }
            attachments = {
              record: { ...fittedRecord, attributes } as T,
              files,
              source: helper.source,
            };
            remaining = [];
          }
        } catch {
          for (let index = 0; index < remaining.length; index++)
            countFallback(tally, "budget", recordTraceId(record));
          invalid(advisory, "Telemetry record could not be serialized", record);
          continue;
        }
        if (!fitted) {
          for (let index = 0; index < remaining.length; index++)
            countFallback(tally, "budget", recordTraceId(record));
          invalid(advisory, OVER_REQUEST_LIMIT, record);
          continue;
        }
        admitted.push({ fitted, attachments });
      }
      // Decide every event/reference admission before queueing helper uploads: a file fitting
      // removed is never uploaded. Their entries are written again as the fitted record listed
      // them, and the files upload after the records are sent.
      const placed = await Promise.all(
        admitted.map(async ({ fitted, attachments }) => {
          if (!attachments) return fitted;
          try {
            const uploaded = await this.transport.offloadSpan(
              attachments.record,
              { candidates: [], cut: [], attachments: attachments.files },
              upload,
              tally,
              late,
              attachments.source,
            );
            measured.delete(fitted.record);
            // The entries name each file's own type, as the fitted record's did; a file refused
            // when queued leaves its entry out, so the record is measured again, cheaply.
            const final = await probe(uploaded as T);
            if (final?.request) measured.set(final.record, final.request);
            if (!final) invalid(advisory, OVER_REQUEST_LIMIT, fitted.record);
            return final;
          } catch {
            invalid(advisory, "Telemetry record could not be serialized", fitted.record);
            return undefined;
          }
        }),
      );
      // Values refused when their records were placed are reported once, before delivery failures
      // can consume the diagnostic callback's rate-limit slot; queued uploads are reported once
      // they settle. Placeholders never upload.
      if (!advisory) this.transport.reportOffload(tally, this.signal);
      let batch: T[] = [];
      let batchBytes = 0;
      for (const fitted of placed) {
        if (!fitted) continue;
        const { record, bytes: recordBytes } = fitted;
        const framedBytes = recordBytes + RECORD_FRAMING_BYTES;
        const target = Math.min(this.transport.receiverLimits().decodedBytes, BATCH_TARGET_BYTES);
        if (batch.length && batchBytes + framedBytes > target) {
          const full = batch;
          batch = [];
          batchBytes = 0;
          await deliver(full, advisory);
        }
        batch.push(record);
        batchBytes += framedBytes;
      }
      if (batch.length) await deliver(batch, advisory);
    };
    await pack(real, false);
    // None is sent once a receiver answered without placeholder support, which the completed
    // records' acknowledgements may have just shown, nor after this export's completed records were
    // refused or unanswered: a receiver that just refused or timed out gets no second request with
    // its own retries. A record this side could not send keeps the placeholders going out.
    if (pending.length && !refused && this.transport.sendsPlaceholders()) await pack(pending, true);
    if (failed) throw new Error("Hue telemetry export failed");
  }

  /** Records a lost request: completed records count as failed; placeholders, advisory, as a
   * warning. True when the request held placeholders only, whose loss never fails an export. */
  private lost(records: T[], placeholders: number, message: string, status?: number): boolean {
    const real = records.length - placeholders;
    this.transport.issue(
      this.signal,
      real ? "failed" : "warning",
      real || placeholders,
      real ? message : `${message} (in-progress span placeholders only)`,
      status,
      traceIdsOf(records),
    );
    return !real;
  }

  /**
   * Sends one request, of completed records or of placeholders alone when `placeholders` is
   * `records.length`. A receiver that refuses completed records for their rate (HTTP 429) and
   * asks to be retried later than the request's deadline allows gets them again after its
   * `Retry-After`, while the export's hold stays within {@link MAX_RATE_LIMIT_HOLD_MILLIS}; the
   * records stay queued meanwhile. Placeholders are advisory: never held, never counted as lost.
   * `"refit"` when the receiver lowered its limits below the request before it was accepted.
   */
  private async send(
    records: T[],
    placeholders: number,
    body: EncodedRequest,
    hold: { millis: number },
  ): Promise<boolean | "refit"> {
    for (;;) {
      const outcome = await this.attempt(records, placeholders, body);
      if (typeof outcome === "boolean" || outcome === "refit") return outcome;
      const wait = Math.max(0, outcome.retryAfterMillis);
      if (placeholders || hold.millis + wait > MAX_RATE_LIMIT_HOLD_MILLIS) {
        // Hue stored none of them: each counts on its trace's root, as a record never sent does.
        if (!placeholders) this.transport.countUndelivered(records);
        return this.lost(
          records,
          placeholders,
          `Hue limited the telemetry rate for longer than an export holds its records (${MAX_RATE_LIMIT_HOLD_MILLIS / 1000} s)`,
          429,
        );
      }
      hold.millis += wait;
      if (!(await this.transport.holdForRateLimit(wait))) {
        this.transport.countUndelivered(records);
        return this.lost(
          records,
          0,
          "Hue limited the telemetry rate until after the client was shut down",
          429,
        );
      }
      // A receiver may lower its limits while it holds the records off: a request now over them
      // is not sent again as it is.
      if (!fitsLimits(body, this.transport.receiverLimits())) return "refit";
    }
  }

  /** One request with its own deadline and retries: whether it was accepted (or held placeholders
   * only), or how long a receiver that refused it for its rate asked to wait past the deadline. */
  private async attempt(
    records: T[],
    placeholders: number,
    body: EncodedRequest,
  ): Promise<boolean | { retryAfterMillis: number } | "refit"> {
    const options = this.transport.options;
    const real = records.length - placeholders;
    // The traces this batch carries, spans or the log records emitted in their spans, so a loss
    // or rejection names whose telemetry it was.
    const traceIds = traceIdsOf(records);
    // Losing a request of placeholders is a warning; losing one of completed records counts them.
    const lose = (message: string, status?: number): boolean =>
      this.lost(records, placeholders, message, status);
    let rejected = 0;
    let validResponse = true;
    let receivedResponse = false;
    let acceptsPlaceholders = false;
    let expired = false;
    const deadline = Date.now() + options.timeoutMillis;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const serializer: ISerializer<T[], Response> = {
      // The request was encoded, and measured against the receiver's limits, before it was sent.
      serializeRequest: (data) =>
        data === records ? body.data : this.serializer.serializeRequest(data),
      deserializeResponse: (bytes) => {
        if (expired) return {};
        receivedResponse = true;
        try {
          const response = this.serializer.deserializeResponse(bytes);
          const partial = response.partialSuccess;
          const count = Number(
            partial?.[this.signal === "traces" ? "rejectedSpans" : "rejectedLogRecords"] ?? 0,
          );
          if (!Number.isSafeInteger(count) || count < 0 || count > records.length)
            throw new Error("Invalid rejection count");
          // A trace acknowledgement without the header comes from a receiver that predates
          // placeholders, whatever the request carried: live spans stop, before any placeholder
          // reaches a receiver that acknowledged completed spans first.
          if (this.signal === "traces" && !acceptsPlaceholders)
            this.transport.rejectPlaceholders(placeholders ? count : 0);
          if (placeholders) {
            // Placeholders travel alone, so the count is theirs: a warning, never a loss. A
            // receiver with the header never rejects a placeholder for being one.
            if (acceptsPlaceholders && (count || partial?.errorMessage))
              this.transport.issue(
                this.signal,
                "warning",
                count,
                count
                  ? "Hue rejected in-progress span placeholders"
                  : "Hue returned an ingestion warning",
              );
            return {};
          }
          // Completed records travel alone too, so the count is theirs in full. Rejections are
          // not matched to records: a rejection of spans in a batch of one trace is that trace's;
          // in a batch of several it names none, since the innocent traces' spans may have been
          // accepted, and each case's receipt decides. A rejection of log records names every
          // trace in the batch: the receipt counts spans, not logs, so it could not tell whose
          // logs were lost.
          rejected = count;
          const rejectedTraceIds =
            this.signal === "logs" || (traceIds && traceIds.length === 1) ? traceIds : undefined;
          if (count || partial?.errorMessage)
            this.transport.issue(
              this.signal,
              count ? "rejected" : "warning",
              count,
              count
                ? "Hue rejected telemetry records; inspect the project ingestion settings and supported limits"
                : "Hue returned an ingestion warning",
              undefined,
              rejectedTraceIds,
            );
          // Do not pass backend error text or raw response bytes into the global OTel diagnostic logger.
          return {};
        } catch {
          validResponse = false;
          lose("Hue returned an invalid OTLP acknowledgement; acceptance is uncertain");
          return {};
        }
      },
    };
    const endpoint = `${options.baseUrl}/api/v1/otlp/v1/${this.signal}`;
    // Explicit configuration only. OTEL_EXPORTER_OTLP_* environment variables are meant
    // for generic exporters; merging them here could send another vendor's headers to Hue.
    const transport = new OtlpHttpTransport(
      endpoint,
      {
        "Content-Type": "application/x-protobuf",
        Authorization: `Bearer ${options.apiKey}`,
        "User-Agent": `hue-sdk-typescript/${sdkVersion} ${OTEL_USER_AGENT}`,
      },
      (headers) => {
        acceptsPlaceholders = headers[PLACEHOLDERS_HEADER] === "1";
      },
      // Every response, whatever its status, advertises the receiver's limits.
      (headers) => this.transport.adoptLimits(headers),
      body,
      () => fitsLimits(body, this.transport.receiverLimits()),
    );
    const delegate = createOtlpNetworkExportDelegate(
      { timeoutMillis: options.timeoutMillis, concurrencyLimit: 1, compression: "gzip" },
      serializer,
      createOtlpHttpExporterMetrics(
        this.signal === "traces" ? "otlp_http_span_exporter" : "otlp_http_log_exporter",
        this.metrics,
        endpoint,
        undefined,
      ),
      transport,
    );
    const exporter = new OTLPExporterBase(delegate);
    try {
      const result = await new Promise<ExportResult>((resolve) => {
        timer = setTimeout(
          () => {
            expired = true;
            transport.abort();
            resolve({ code: ExportResultCode.FAILED });
          },
          Math.max(1, deadline - Date.now()),
        );
        exporter.export(records, resolve);
      });
      if (result.code === ExportResultCode.SUCCESS) {
        if (!receivedResponse)
          return lose(
            "Hue response ended without a complete OTLP acknowledgement; acceptance is uncertain",
          );
        if (validResponse) this.transport.acceptedRecords(this.signal, real - rejected);
        return validResponse || !real;
      } else {
        // Not retried as it is: the receiver lowered its limits below this request.
        if (!expired && transport.overLimits) return "refit";
        // Refused for its rate, with a Retry-After past this request's deadline: the caller
        // decides whether to hold the records for it.
        if (!expired && transport.rateLimitedFor !== undefined)
          return { retryAfterMillis: transport.rateLimitedFor };
        const status =
          result.error instanceof OTLPExporterError && Number.isInteger(result.error.code)
            ? result.error.code
            : undefined;
        return lose("Hue telemetry request failed", status);
      }
    } catch {
      return lose("Hue telemetry request failed");
    } finally {
      clearTimeout(timer);
      transport.abort();
      // Delegate cleanup cannot extend the hard request wait. Sockets are closed
      // and the cleanup promise is always observed, even after a caller timeout.
      void exporter.shutdown().catch(() => {});
    }
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.pending);
  }
  async shutdown(): Promise<void> {
    await this.forceFlush();
  }
}

// OpenTelemetry's OTLP/HTTP transport rules (otlp-exporter-base 0.222), restated because that
// transport discards response headers, which Hue uses to announce features.
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MILLIS = 1000;
const MAX_BACKOFF_MILLIS = 5000;
const BACKOFF_MULTIPLIER = 1.5;
const JITTER = 0.2;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
// Hue also retries transient collector HTTP 500 responses within the same attempt/deadline budget.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_ERRORS = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);
/** OpenTelemetry's exporter token, which follows Hue's in the User-Agent as it always has. */
const OTEL_USER_AGENT = "OTel-OTLP-Exporter-JavaScript/0.222.0";

function retryAfterMillis(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (Number.isInteger(seconds)) return seconds > 0 ? seconds * 1000 : -1;
  const delay = new Date(value).getTime() - Date.now();
  return delay >= 0 ? delay : 0;
}

function networkFailure(error: Error): ExportResponse {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && RETRYABLE_NETWORK_ERRORS.has(code)
    ? { status: "retryable", error }
    : { status: "failure", error };
}

function compress(data: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    gzip(data, (error, result) => (error ? reject(error) : resolve(result))),
  );
}

/** A request's encoding, and that encoding gzip-compressed as it goes on the wire. */
interface EncodedRequest {
  data: Uint8Array;
  compressed: Buffer;
}

/** Whether a request is within the receiver's limits after decompression and on the wire. */
function fitsLimits(body: EncodedRequest, limits: ReceiverLimits): boolean {
  return (
    body.data.byteLength <= limits.decodedBytes && body.compressed.byteLength <= limits.requestBytes
  );
}

/** Why a record no larger than any content value it could shed still cannot be sent. */
const OVER_REQUEST_LIMIT =
  "Telemetry record exceeds Hue's request limit without its content values";

/**
 * Gzip-compressed OTLP/HTTP POSTs that never follow redirects, retried like OpenTelemetry's
 * exporter within the request budget. `onSuccess` receives the headers of the 2xx response whose
 * body becomes the acknowledgement, before that body is decoded; `onResponse` the headers of every
 * response. One instance serves a single export request: its connections are never reused, and
 * `abort()` closes them at the export deadline.
 */
class OtlpHttpTransport implements IExporterTransport {
  // Requests in flight and how to settle each, so an abort never leaves an attempt pending.
  private requests = new Map<ClientRequest, (result: ExportResponse) => void>();
  private agent?: Agent;
  private aborted = false;
  /** The HTTP status of the latest response, undefined when the latest attempt had none. */
  private lastStatus?: number;
  /** Set when the receiver refused the request for its rate (HTTP 429) and asked to be retried
   * later than the request's deadline allows: how long it asked to wait, in milliseconds. */
  rateLimitedFor?: number;
  /** Set when a retryable response advertised limits the request no longer fits: it is not
   * retried as it is. */
  overLimits = false;

  constructor(
    private url: string,
    private headers: Record<string, string>,
    private onSuccess: (headers: IncomingHttpHeaders) => void,
    private onResponse: (headers: IncomingHttpHeaders) => void = () => {},
    private body?: EncodedRequest,
    private fits: () => boolean = () => true,
  ) {}

  async send(data: Uint8Array, timeoutMillis: number): Promise<ExportResponse> {
    const deadline = Date.now() + timeoutMillis;
    let backoff = INITIAL_BACKOFF_MILLIS;
    // Limits another export adopted since the request was measured are honoured from the first
    // attempt: the request goes back to be split or shed instead.
    if (!this.fits()) {
      this.overLimits = true;
      return { status: "failure", error: new Error("Request exceeds the receiver's limits") };
    }
    let result = await this.attempt(data, timeoutMillis);
    for (let retries = MAX_RETRIES; result.status === "retryable" && retries > 0; retries--) {
      const jitter = Math.random() * 2 * JITTER - JITTER;
      const wait =
        result.retryInMillis ?? Math.max(Math.min(backoff * (1 + jitter), MAX_BACKOFF_MILLIS), 0);
      backoff *= BACKOFF_MULTIPLIER;
      if (this.aborted) return result;
      // Return when the next attempt would start after the export deadline; a rate limit says
      // when it may be retried, which the exporter can wait for with the records still queued.
      if (wait > deadline - Date.now()) {
        if (this.lastStatus === 429 && result.retryInMillis !== undefined)
          this.rateLimitedFor = wait;
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, wait)));
      // A response that lowered the limits below this request: it is split or shed, not retried
      // as it is.
      if (!this.fits()) {
        this.overLimits = true;
        return result;
      }
      result = await this.attempt(data, Math.max(1, deadline - Date.now()));
    }
    return result;
  }

  private async attempt(data: Uint8Array, timeoutMillis: number): Promise<ExportResponse> {
    this.lastStatus = undefined;
    try {
      if (this.aborted) throw new Error("Hue export deadline exceeded");
      const url = new URL(this.url);
      const protocol = url.protocol;
      // Loaded on first use, as OpenTelemetry's exporter does, so importing Hue never loads http
      // before the application's http instrumentation can patch it. A request measured before it
      // was sent is not compressed again.
      const [{ Agent: ConnectionAgent, request }, body] = await Promise.all([
        import(protocol === "https:" ? "node:https" : "node:http"),
        this.body && data === this.body.data ? this.body.compressed : compress(data),
      ]);
      if (this.aborted) throw new Error("Hue export deadline exceeded");
      // Never kept alive: each attempt's socket closes with its response or at the deadline.
      this.agent ??= new ConnectionAgent({ keepAlive: false }) as Agent;
      return await new Promise<ExportResponse>((resolve) => {
        const req: ClientRequest = request(
          url,
          {
            method: "POST",
            agent: this.agent,
            headers: {
              ...this.headers,
              "Content-Encoding": "gzip",
              "Content-Length": body.byteLength,
            },
          },
          (res: IncomingMessage) => {
            const chunks: Buffer[] = [];
            let size = 0;
            const status = res.statusCode ?? 0;
            const success = status >= 200 && status <= 299;
            this.lastStatus = status;
            try {
              this.onResponse(res.headers);
            } catch {
              // Reading advertised limits never fails the request.
            }
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > MAX_RESPONSE_BYTES) {
                // Oversized responses fail regardless of status; resolve before tearing down.
                resolve({ status: "failure", error: new Error("OTLP response exceeded 4 MiB") });
                res.destroy();
                return;
              }
              chunks.push(chunk);
            });
            res.on("end", () => {
              if (success) {
                this.onSuccess(res.headers);
                resolve({ status: "success", data: Buffer.concat(chunks) });
              } else if (RETRYABLE_STATUS.has(status))
                resolve({
                  status: "retryable",
                  retryInMillis: retryAfterMillis(res.headers["retry-after"]),
                });
              else
                resolve({
                  status: "failure",
                  error: new OTLPExporterError(
                    res.statusMessage,
                    status,
                    Buffer.concat(chunks).toString(),
                  ),
                });
            });
            res.on("error", (error: Error) => {
              // Sent, but the acknowledgement was not read: success without a body to decode.
              if (success) resolve({ status: "success" });
              else if (RETRYABLE_STATUS.has(status))
                resolve({
                  status: "retryable",
                  error,
                  retryInMillis: retryAfterMillis(res.headers["retry-after"]),
                });
              else resolve({ status: "failure", error });
            });
          },
        );
        this.requests.set(req, resolve);
        req.on("close", () => this.requests.delete(req));
        req.setTimeout(timeoutMillis, () => {
          req.destroy();
          resolve({ status: "retryable", error: new Error("Request timed out") });
        });
        req.on("error", (error: Error) => resolve(networkFailure(error)));
        req.end(body);
      });
    } catch (error) {
      return {
        status: "failure",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /** Fails and destroys requests in flight and their sockets, and every later attempt. */
  abort(): void {
    this.aborted = true;
    for (const [req, settle] of this.requests) {
      settle({ status: "failure", error: new Error("Hue export deadline exceeded") });
      req.destroy();
    }
    this.requests.clear();
    this.agent?.destroy();
  }

  shutdown(): void {
    this.abort();
  }
}

/**
 * Creates the export pipeline for attach mode; pass it with the application's providers to
 * {@link createHue}. Validates options like an owned client.
 *
 * @throws TypeError for invalid options; see {@link createHue}.
 */
export function createHueTransport(options: HueOptions): HueTransport {
  return new HueTransport(options);
}
