import type { Agent, ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import { gzip } from "node:zlib";
import type { Attributes } from "@opentelemetry/api";
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
import { isInsecureOrigin, MAX_BODY_BYTES, validateOptions } from "./config.js";
import {
  announcesLiveSpan,
  LIVE_SPAN_INTERVAL_MILLIS,
  MAX_LIVE_SPANS,
  pendingPlaceholder,
  PLACEHOLDERS_HEADER,
  withoutPlaceholderMarkers,
} from "./live-spans.js";
import { estimateRecordBytes } from "./safety.js";
import { snapshotLog, snapshotSpan } from "./snapshot.js";
import {
  DROPPED_RECORDS_KEY,
  isContentKey,
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
  rejectPlaceholders(count: number): void;
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
  private instrumentationFailures = 0;
  private diagnosticPending = false;
  private lastDiagnosticAt = -Infinity;
  private traceExporter: ReportingExporter<ReadableSpan>;
  private logExporter: ReportingExporter<ReadableLogRecord>;
  private closed = false;
  private shutdownPromise?: Promise<ExportReport>;
  private flushPromise?: Promise<ExportReport>;
  // Open spans not yet announced. Each is considered once, at the next tick after it starts.
  private live = new Set<ReadableSpan>();
  private liveTimer?: ReturnType<typeof setInterval>;
  private liveSpans: boolean;
  private placeholdersRejected = false;
  // Admitted placeholder snapshots and the marker attributes added after redaction.
  private placeholders = new WeakMap<RecordValue, Attributes>();
  // The running span each admitted placeholder announces, so one it has outlived is not sent.
  private placeholderSources = new WeakMap<RecordValue, { readonly ended: boolean }>();
  private batchSpans?: BatchSpanProcessor;

  constructor(options: HueOptions) {
    this.options = validateOptions(options);
    Object.defineProperty(this, "options", { enumerable: false });
    this.liveSpans = this.options.enabled !== false && this.options.liveSpans;
    this.traceExporter = new ReportingExporter(
      this,
      "traces",
      ProtobufTraceSerializer,
      TraceExporterMetricsHelper,
      (span, cache) => redactSpan(span, this.options, cache),
    );
    this.logExporter = new ReportingExporter(
      this,
      "logs",
      ProtobufLogsSerializer,
      LogsExporterMetricsHelper,
      (log, cache) => redactLog(log, this.options, cache),
    );
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
      exportTimeoutMillis: this.options.timeoutMillis * 16 + 1000,
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
          if (!(span.spanContext().traceFlags & 1)) return;
          const queued = this.enqueue("traces", span);
          if (!queued) return;
          admitted = queued as ReadableSpan;
          this.countEnded(admitted);
          spans.onEnd(admitted);
        } catch {
          if (admitted) this.finish("traces", [admitted]);
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
      forceFlush: () => spans.forceFlush(),
      shutdown: () => {
        this.stopLiveSpans();
        return spans.shutdown();
      },
    };
    this.logRecordProcessor = {
      onEmit: (log) => {
        let admitted: ReadableLogRecord | undefined;
        try {
          const queued = this.enqueue("logs", log);
          if (!queued) return;
          admitted = queued as ReadableLogRecord;
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
      forceFlush: () => logs.forceFlush(),
      shutdown: () => logs.shutdown(),
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
      const snapshot =
        signal === "traces"
          ? snapshotSpan(record as ReadableSpan, remaining, this.options.captureContent)
          : snapshotLog(record as ReadableLogRecord, remaining, this.options.captureContent);
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
        if (!this.liveSpans || span.ended || !this.batchSpans) continue;
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
   * @internal Exporter callback: a receiver without placeholder support rejects each by its zero
   * end time. Stops announcing for this transport and records one warning.
   */
  rejectPlaceholders(count: number): void {
    this.stopLiveSpans();
    if (this.placeholdersRejected) return;
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
      const pending = signal === "traces" ? this.spans : this.logs;
      this.pendingBytes -= pending.get(record as ReadableSpan & ReadableLogRecord) ?? 0;
      pending.delete(record as ReadableSpan & ReadableLogRecord);
    }
  }

  /** @internal Exporter callback: counts records the collector acknowledged. */
  acceptedRecords(signal: Signal, count: number): void {
    this.accepted[signal] += count;
  }

  /** @internal Exporter callback: a trace's root span carries the count of its records the SDK
   * never sent, read when the root is exported (a record lost after that is not counted: the
   * root has left). The count is kept, so a root exported again under retry says the same. */
  withDroppedRecords(span: ReadableSpan): ReadableSpan {
    if (span.parentSpanContext) return span;
    const traceId = span.spanContext().traceId;
    const count = this.droppedByTrace.get(traceId);
    if (!count) return span;
    // Consumed: the root carries it, and the map holds nothing for a trace that has ended.
    this.droppedByTrace.delete(traceId);
    return { ...span, attributes: { ...span.attributes, [DROPPED_RECORDS_KEY]: count } };
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
    if ((kind === "dropped" || kind === "invalid") && count > 0 && traceIds?.length === 1) {
      const [traceId] = traceIds as [string];
      // Bounded: a trace whose root never arrives (an abandoned run) gives way to newer ones.
      if (this.droppedByTrace.size >= 1024 && !this.droppedByTrace.has(traceId))
        this.droppedByTrace.delete(this.droppedByTrace.keys().next().value!);
      this.droppedByTrace.set(traceId, (this.droppedByTrace.get(traceId) ?? 0) + count);
    }
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
   * Waits for the processors' and exporters' in-flight work; drain the providers first.
   *
   * @throws HueExportError when a new non-warning issue was recorded since the previous observation.
   */
  flush(): Promise<ExportReport> {
    const from = this.observedSequence;
    const next = (this.flushPromise ?? Promise.resolve()).then(
      () => this.flushOnce(from),
      () => this.flushOnce(from),
    );
    this.flushPromise = next;
    const clear = () => {
      if (this.flushPromise === next) this.flushPromise = undefined;
    };
    void next.then(clear, clear);
    return next;
  }

  private async flushOnce(from: number): Promise<ExportReport> {
    const processors = await Promise.allSettled([
      this.spanProcessor.forceFlush(),
      this.logRecordProcessor.forceFlush(),
    ]);
    await Promise.all([this.traceExporter.forceFlush(), this.logExporter.forceFlush()]);
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
   * Flushes and stops the processors; records emitted afterwards are dropped and counted. In attach
   * mode call it after shutting down the application's providers.
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

/** Whether a value is already the receiver's marker for a value that was shed. */
function isTruncatedMarker(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)[TRUNCATED_KEY] === true
  );
}

/**
 * The record with its largest content value (a log's body before its attributes) replaced by
 * the receiver's marker and listed under `hue.truncated`; undefined when no content value is
 * left to shed. Metadata is never shed: a record too large without its content is lost whole.
 */
function shedLargestContent(record: RecordValue, signal: Signal): RecordValue | undefined {
  if (signal === "logs") {
    const log = record as ReadableLogRecord;
    if (log.body !== undefined && !isTruncatedMarker(log.body)) {
      const bytes = valueBytes(log.body);
      const attributes: Record<string, unknown> = {
        ...log.attributes,
        [TRUNCATED_KEY]: withTruncatedKeys(log.attributes[TRUNCATED_KEY], ["body"]),
      };
      return { ...log, body: truncatedMarker(bytes), attributes } as ReadableLogRecord;
    }
  }
  const { attributes } = record;
  // The record's own content values, and a span's events' (listed as the receiver lists an
  // event's cut: `event:<name>:<key>`).
  const events = signal === "traces" ? (record as ReadableSpan).events : [];
  let largest: { event?: number; key: string; bytes: number } | undefined;
  const consider = (key: string, value: unknown, event?: number) => {
    if (!isContentKey(key) || isTruncatedMarker(value)) return;
    const bytes = valueBytes(value);
    if (!largest || bytes > largest.bytes)
      largest = { ...(event === undefined ? {} : { event }), key, bytes };
  };
  for (const [key, value] of Object.entries(attributes)) consider(key, value);
  events.forEach((event, index) => {
    for (const [key, value] of Object.entries(event.attributes ?? {})) consider(key, value, index);
  });
  if (!largest) return undefined;
  const found = largest as { event?: number; key: string; bytes: number };
  const listed =
    found.event === undefined ? found.key : `event:${events[found.event]!.name}:${found.key}`;
  const shed: Record<string, unknown> = {
    ...attributes,
    ...(found.event === undefined ? { [found.key]: truncatedMarker(found.bytes) } : {}),
    [TRUNCATED_KEY]: withTruncatedKeys(attributes[TRUNCATED_KEY], [listed]),
  };
  if (found.event === undefined) return { ...record, attributes: shed } as RecordValue;
  const shedEvents = events.map((event, index) =>
    index === found.event
      ? {
          ...event,
          attributes: { ...event.attributes, [found.key]: truncatedMarker(found.bytes) },
        }
      : event,
  );
  return { ...record, attributes: shed, events: shedEvents } as RecordValue;
}

class ReportingExporter<T extends RecordValue> {
  private pending = new Set<Promise<void>>();
  constructor(
    private transport: ExportSink,
    private signal: Signal,
    private serializer: ISerializer<T[], Response>,
    private metrics: IExporterMetricsHelper<T[]>,
    private redact: (record: T, cache: ResourceCache) => T,
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

  private async exportRecords(records: T[]): Promise<void> {
    const accepted: T[] = [];
    // Placeholders are advisory: losing one is a warning, never an export failure.
    const placeholders = new Set<T>();
    const cache: ResourceCache = new WeakMap();
    let failed = false;
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
    const send = async (batch: T[]) => {
      const count = batch.filter((record) => placeholders.has(record)).length;
      if (!(await this.send(batch, count))) failed = true;
    };
    const resourceDeadline = Date.now() + this.transport.options.timeoutMillis;
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
        let redacted = this.redact(record, cache);
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
        const bytes =
          512 +
          estimateRecordBytes(
            recordData(redacted, this.signal),
            this.transport.options.maxQueueBytes - redactedBytes,
          );
        if (redactedBytes + bytes > this.transport.options.maxQueueBytes)
          throw new RangeError("Redacted batch exceeds byte budget");
        redactedBytes += bytes;
        accepted.push(redacted);
        if (markers) placeholders.add(redacted);
      } catch {
        invalid(
          markers !== undefined,
          "Telemetry record could not be redacted or exceeds supported content limits",
          record,
        );
      }
    }
    // Each record is encoded once to measure it; a request is encoded once more when it is sent.
    // Records sharing a resource and scope are grouped on the wire, so the sum of the individual
    // encodings plus a fixed framing margin bounds the request size. Room is left for gzip
    // headers/blocks when otherwise incompressible data is near the wire cap.
    const limit = MAX_BODY_BYTES - 1024;
    let batch: T[] = [];
    let batchBytes = 0;
    const measure = (record: T) =>
      this.serializer.serializeRequest([record])?.byteLength ?? Infinity;
    for (let record of accepted) {
      const placeholder = placeholders.has(record);
      if (this.signal === "traces" && !placeholder)
        record = this.transport.withDroppedRecords(record as ReadableSpan) as T;
      let recordBytes: number;
      try {
        recordBytes = measure(record);
        // A record over the request limit sheds its content values, largest first, each
        // replaced by the receiver's marker and listed under `hue.truncated`, until it fits:
        // the span and what it still holds reach Hue, and a reader sees what was shed. Only a
        // record too large without any content value is lost, and counted on its root.
        while (recordBytes > limit) {
          const shed = shedLargestContent(record, this.signal);
          if (!shed) break;
          record = shed as T;
          recordBytes = measure(record);
        }
      } catch {
        invalid(placeholder, "Telemetry record could not be serialized", record);
        continue;
      }
      const framedBytes = recordBytes + RECORD_FRAMING_BYTES;
      if (batch.length && batchBytes + framedBytes > limit) {
        await send(batch);
        batch = [];
        batchBytes = 0;
      }
      if (recordBytes > limit) {
        invalid(placeholder, "Telemetry record exceeds the 1 MiB request limit", record);
        continue;
      }
      batch.push(record);
      batchBytes += framedBytes;
    }
    if (batch.length) await send(batch);
    if (failed) throw new Error("Hue telemetry export failed");
  }

  /** Sends one request; `placeholders` of `records` are advisory and never count as lost. */
  private async send(records: T[], placeholders = 0): Promise<boolean> {
    const options = this.transport.options;
    const real = records.length - placeholders;
    // The traces this batch carries, spans or the log records emitted in their spans, so a loss
    // or rejection names whose telemetry it was.
    const traceIds = traceIdsOf(records);
    // A loss involving only placeholders is a warning. Mixed losses count only real records.
    const lose = (message: string, status?: number): boolean => {
      this.transport.issue(
        this.signal,
        real ? "failed" : "warning",
        real || placeholders,
        real ? message : `${message} (in-progress span placeholders only)`,
        status,
        traceIds,
      );
      return !real;
    };
    let rejected = 0;
    let validResponse = true;
    let receivedResponse = false;
    let acceptsPlaceholders = false;
    let expired = false;
    const deadline = Date.now() + options.timeoutMillis;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const serializer: ISerializer<T[], Response> = {
      serializeRequest: (data) => this.serializer.serializeRequest(data),
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
          // A receiver that accepts placeholders never rejects them for being placeholders, so its
          // rejections count as before. One without the header predates them and rejects each.
          const downgrade = placeholders > 0 && !acceptsPlaceholders;
          const placeholderRejections = downgrade ? Math.min(count, placeholders) : 0;
          if (downgrade) this.transport.rejectPlaceholders(placeholderRejections);
          const remaining = count - placeholderRejections;
          // Rejections are not matched to records. Attribute them to real records first. A
          // rejection of spans in a batch of one trace is that trace's; in a batch of several it
          // names none, since the innocent traces' spans may have been accepted, and each case's
          // receipt decides. A rejection of log records names every trace in the batch: the
          // receipt counts spans, not logs, so it could not tell whose logs were lost.
          rejected = Math.min(remaining, real);
          const rejectedTraceIds =
            this.signal === "logs" || (traceIds && traceIds.length === 1) ? traceIds : undefined;
          if (remaining || (partial?.errorMessage && !downgrade))
            this.transport.issue(
              this.signal,
              rejected ? "rejected" : "warning",
              rejected || remaining,
              rejected
                ? "Hue rejected telemetry records; inspect the project ingestion settings and supported limits"
                : remaining
                  ? "Hue rejected in-progress span placeholders"
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
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
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

/**
 * Gzip-compressed OTLP/HTTP POSTs that never follow redirects, retried like OpenTelemetry's
 * exporter within the request budget. `onSuccess` receives the headers of the 2xx response whose
 * body becomes the acknowledgement, before that body is decoded. One instance serves a single
 * export request: its connections are never reused, and `abort()` closes them at the export
 * deadline.
 */
class OtlpHttpTransport implements IExporterTransport {
  // Requests in flight and how to settle each, so an abort never leaves an attempt pending.
  private requests = new Map<ClientRequest, (result: ExportResponse) => void>();
  private agent?: Agent;
  private aborted = false;

  constructor(
    private url: string,
    private headers: Record<string, string>,
    private onSuccess: (headers: IncomingHttpHeaders) => void,
  ) {}

  async send(data: Uint8Array, timeoutMillis: number): Promise<ExportResponse> {
    const deadline = Date.now() + timeoutMillis;
    let backoff = INITIAL_BACKOFF_MILLIS;
    let result = await this.attempt(data, timeoutMillis);
    for (let retries = MAX_RETRIES; result.status === "retryable" && retries > 0; retries--) {
      const jitter = Math.random() * 2 * JITTER - JITTER;
      const wait =
        result.retryInMillis ?? Math.max(Math.min(backoff * (1 + jitter), MAX_BACKOFF_MILLIS), 0);
      backoff *= BACKOFF_MULTIPLIER;
      // Return when the next attempt would start after the export deadline.
      if (this.aborted || wait > deadline - Date.now()) return result;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, wait)));
      result = await this.attempt(data, Math.max(1, deadline - Date.now()));
    }
    return result;
  }

  private async attempt(data: Uint8Array, timeoutMillis: number): Promise<ExportResponse> {
    try {
      if (this.aborted) throw new Error("Hue export deadline exceeded");
      const url = new URL(this.url);
      const protocol = url.protocol;
      // Loaded on first use, as OpenTelemetry's exporter does, so importing Hue never loads http
      // before the application's http instrumentation can patch it.
      const [{ Agent: ConnectionAgent, request }, body] = await Promise.all([
        import(protocol === "https:" ? "node:https" : "node:http"),
        compress(data),
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
