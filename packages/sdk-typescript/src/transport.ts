import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import {
  CompressionAlgorithm,
  OTLPExporterBase,
  OTLPExporterError,
} from "@opentelemetry/otlp-exporter-base";
import {
  convertLegacyHttpOptions,
  createOtlpHttpExportDelegate,
} from "@opentelemetry/otlp-exporter-base/node-http";
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
  type SpanProcessor,
} from "@opentelemetry/sdk-trace";
import {
  BatchLogRecordProcessor,
  type LogRecordProcessor,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import { MAX_BODY_BYTES, validateOptions } from "./config.js";
import { estimateRecordBytes } from "./safety.js";
import { redactLog, redactSpan, type ResourceCache } from "./privacy.js";
import type { ExportIssue, ExportReport, HueOptions, Signal } from "./types.js";

type Response = {
  partialSuccess?: {
    rejectedSpans?: number | string;
    rejectedLogRecords?: number | string;
    errorMessage?: string;
  };
};
type RecordValue = ReadableSpan | ReadableLogRecord;

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

export class HueExportError extends Error {
  constructor(
    readonly issues: ExportIssue[],
    readonly report: ExportReport,
  ) {
    super("Hue could not accept all telemetry. Inspect issues and report for sanitized counts.");
    this.name = "HueExportError";
  }
}

/** Owned transport components; attach processors during provider construction. */
export class HueTransport {
  readonly options: ReturnType<typeof validateOptions>;
  readonly spanProcessor: SpanProcessor;
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
  private instrumentationFailures = 0;
  private diagnosticPending = false;
  private lastDiagnosticAt = -Infinity;
  private traceExporter: ReportingExporter<ReadableSpan>;
  private logExporter: ReportingExporter<ReadableLogRecord>;
  private closed = false;
  private shutdownPromise?: Promise<ExportReport>;
  private flushPromise?: Promise<ExportReport>;

  constructor(options: HueOptions) {
    this.options = validateOptions(options);
    Object.defineProperty(this, "options", { enumerable: false });
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
    const batching = {
      maxQueueSize: 2048,
      maxExportBatchSize: 128,
      scheduledDelayMillis: 1000,
      exportTimeoutMillis: this.options.timeoutMillis * 16 + 1000,
    };
    const spans = new BatchSpanProcessor({ exporter: this.traceExporter, ...batching });
    const logs = new BatchLogRecordProcessor({ exporter: this.logExporter, ...batching });
    this.spanProcessor = {
      onStart: (span, parent) => {
        try {
          spans.onStart(span, parent);
        } catch {
          this.instrumentationFailure();
        }
      },
      onEnd: (span) => {
        try {
          if (!(span.spanContext().traceFlags & 1)) return;
          if (!this.enqueue("traces", span)) return;
          spans.onEnd(span);
        } catch {
          this.finish("traces", [span]);
          this.issue("traces", "invalid", 1, "Telemetry processor could not accept a record");
        }
      },
      forceFlush: () => spans.forceFlush(),
      shutdown: () => spans.shutdown(),
    };
    this.logRecordProcessor = {
      onEmit: (log) => {
        try {
          if (!this.enqueue("logs", log)) return;
          logs.onEmit(log);
        } catch {
          this.finish("logs", [log]);
          this.issue("logs", "invalid", 1, "Telemetry processor could not accept a record");
        }
      },
      forceFlush: () => logs.forceFlush(),
      shutdown: () => logs.shutdown(),
    };
  }

  private enqueue(signal: Signal, record: RecordValue): boolean {
    const pending = signal === "traces" ? this.spans : this.logs;
    if (this.closed || pending.size >= 2048) {
      this.issue(
        signal,
        "dropped",
        1,
        this.closed
          ? "Telemetry emitted after transport shutdown"
          : "Telemetry queue reached 2048 records",
      );
      return false;
    }
    let bytes: number;
    try {
      // Charge record data, not the provider/exporter graph behind an OTel span.
      bytes =
        512 +
        estimateRecordBytes(
          recordData(record, signal),
          this.options.maxQueueBytes - this.pendingBytes,
        );
      if (this.pendingBytes + bytes > this.options.maxQueueBytes)
        throw new RangeError("Queue full");
    } catch {
      this.issue(signal, "dropped", 1, "Telemetry queue byte or record complexity budget exceeded");
      return false;
    }
    this.pendingBytes += bytes;
    if (signal === "traces") this.spans.set(record as ReadableSpan, bytes);
    else this.logs.set(record as ReadableLogRecord, bytes);
    return true;
  }

  finish(signal: Signal, records: RecordValue[]): void {
    for (const record of records) {
      const pending = signal === "traces" ? this.spans : this.logs;
      this.pendingBytes -= pending.get(record as ReadableSpan & ReadableLogRecord) ?? 0;
      pending.delete(record as ReadableSpan & ReadableLogRecord);
    }
  }

  acceptedRecords(signal: Signal, count: number): void {
    this.accepted[signal] += count;
  }

  issue(
    signal: Signal,
    kind: ExportIssue["kind"],
    count: number,
    message: string,
    status?: number,
  ): void {
    if (kind === "dropped") this.dropped[signal] += count;
    if (kind === "rejected") this.rejected[signal] += count;
    else if (kind !== "warning") this.failed[signal] += count;
    const issue: ExportIssue = {
      sequence: ++this.sequence,
      signal,
      kind,
      count,
      message,
      ...(status !== undefined ? { status } : {}),
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
      this.lastDiagnosticAt = Date.now();
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

  instrumentationFailure(signal: Signal = "traces"): void {
    this.instrumentationFailures++;
    this.issue(
      signal,
      "invalid",
      0,
      "Telemetry capture or instrumentation failed; application execution was preserved",
    );
  }

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

  getIssues(): ExportIssue[] {
    return this.issues.map((issue) => ({ ...issue }));
  }

  /** Monotonic failure marker, retained even when the bounded issue history rolls over. */
  getFailureSequence(): number {
    return this.failureSequence;
  }

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

class ReportingExporter<T extends RecordValue> {
  private pending = new Set<Promise<void>>();
  constructor(
    private transport: HueTransport,
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

  private async exportRecords(records: T[]): Promise<void> {
    const accepted: T[] = [];
    const cache: ResourceCache = new WeakMap();
    let failed = false;
    let redactedBytes = 0;
    const resourceDeadline = Date.now() + this.transport.options.timeoutMillis;
    for (const record of records) {
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
        const redacted = this.redact(record, cache);
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
      } catch {
        failed = true;
        this.transport.issue(
          this.signal,
          "invalid",
          1,
          "Telemetry record could not be redacted or exceeds supported content limits",
        );
      }
    }
    let batch: T[] = [];
    for (const record of accepted) {
      let recordBytes: number;
      try {
        recordBytes = this.serializer.serializeRequest([record])?.byteLength ?? Infinity;
      } catch {
        failed = true;
        this.transport.issue(this.signal, "invalid", 1, "Telemetry record could not be serialized");
        continue;
      }
      const candidate = [...batch, record];
      // Leave room for gzip headers/blocks when otherwise incompressible data is near the wire cap.
      if ((this.serializer.serializeRequest(candidate)?.byteLength ?? 0) <= MAX_BODY_BYTES - 1024) {
        batch = candidate;
        continue;
      }
      if (batch.length && !(await this.send(batch))) failed = true;
      batch = [];
      if (recordBytes > MAX_BODY_BYTES - 1024) {
        failed = true;
        this.transport.issue(
          this.signal,
          "invalid",
          1,
          "Telemetry record exceeds the 1 MiB request limit",
        );
      } else batch = [record];
    }
    if (batch.length && !(await this.send(batch))) failed = true;
    if (failed) throw new Error("Hue telemetry export failed");
  }

  private async send(records: T[]): Promise<boolean> {
    const options = this.transport.options;
    let rejected = 0;
    let validResponse = true;
    let receivedResponse = false;
    let expired = false;
    const agents = new Set<Agent>();
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
          rejected = count;
          if (count || partial?.errorMessage)
            this.transport.issue(
              this.signal,
              count ? "rejected" : "warning",
              count,
              count
                ? "Hue rejected telemetry records; inspect the project ingestion settings and supported limits"
                : "Hue returned an ingestion warning",
            );
          // Do not pass backend error text or raw response bytes into the global OTel diagnostic logger.
          return {};
        } catch {
          validResponse = false;
          this.transport.issue(
            this.signal,
            "failed",
            records.length,
            "Hue returned an invalid OTLP acknowledgement; acceptance is uncertain",
          );
          return {};
        }
      },
    };
    const endpoint = `${options.baseUrl}/api/v1/otlp/v1/${this.signal}`;
    const delegate = createOtlpHttpExportDelegate(
      convertLegacyHttpOptions(
        {
          url: endpoint,
          headers: { Authorization: `Bearer ${options.apiKey}` },
          timeoutMillis: options.timeoutMillis,
          concurrencyLimit: 1,
          compression: CompressionAlgorithm.GZIP,
          httpAgentOptions: async (protocol: string) => {
            if (expired || Date.now() >= deadline) throw new Error("Hue export deadline exceeded");
            const { Agent } = await import(protocol === "https:" ? "node:https" : "node:http");
            const agent = new Agent({ keepAlive: false });
            agents.add(agent);
            if (expired) agent.destroy();
            return agent;
          },
        },
        this.signal === "traces" ? "TRACES" : "LOGS",
        `v1/${this.signal}`,
        { "Content-Type": "application/x-protobuf" },
      ),
      serializer,
      this.signal === "traces" ? "otlp_http_span_exporter" : "otlp_http_log_exporter",
      this.metrics,
      undefined,
    );
    const exporter = new OTLPExporterBase(delegate);
    try {
      const result = await new Promise<ExportResult>((resolve) => {
        timer = setTimeout(
          () => {
            expired = true;
            for (const agent of agents) agent.destroy();
            resolve({ code: ExportResultCode.FAILED });
          },
          Math.max(1, deadline - Date.now()),
        );
        exporter.export(records, resolve);
      });
      if (result.code === ExportResultCode.SUCCESS) {
        if (!receivedResponse) {
          this.transport.issue(
            this.signal,
            "failed",
            records.length,
            "Hue response ended without a complete OTLP acknowledgement; acceptance is uncertain",
          );
          return false;
        }
        if (validResponse) this.transport.acceptedRecords(this.signal, records.length - rejected);
        return validResponse;
      } else {
        const status =
          result.error instanceof OTLPExporterError && Number.isInteger(result.error.code)
            ? result.error.code
            : undefined;
        this.transport.issue(
          this.signal,
          "failed",
          records.length,
          "Hue telemetry request failed",
          status,
        );
        return false;
      }
    } catch {
      this.transport.issue(this.signal, "failed", records.length, "Hue telemetry request failed");
      return false;
    } finally {
      clearTimeout(timer);
      for (const agent of agents) agent.destroy();
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

export function createHueTransport(options: HueOptions): HueTransport {
  return new HueTransport(options);
}
import type { Agent } from "node:http";
