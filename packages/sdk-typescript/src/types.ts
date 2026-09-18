import type {
  Attributes,
  Context,
  Span,
  SpanKind,
  Tracer,
  TracerProvider,
} from "@opentelemetry/api";
import type { LoggerProvider } from "@opentelemetry/api-logs";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type Signal = "traces" | "logs";

export interface SharedHueOptions {
  captureContent: boolean;
  baseUrl?: string;
  serviceVersion?: string;
  /** Runs on string values before Hue export, including custom attribute values. */
  redact?: (value: string, path: string) => string;
  onExportIssue?: (issue: ExportIssue) => void | Promise<void>;
  timeoutMillis?: number;
  /** Aggregate estimated retained telemetry bytes across both signals, including in-flight work. Default 8 MiB. */
  maxQueueBytes?: number;
}

/**
 * An enabled client needs a project key, a service name and an explicit `captureContent` choice.
 * The kill switch (`enabled: false`) exports nothing, so it needs no key and `captureContent`
 * defaults to `false`.
 */
export type HueOptions =
  | (SharedHueOptions & { enabled?: true; apiKey: string; serviceName: string })
  | (Omit<SharedHueOptions, "captureContent"> & {
      enabled: false;
      apiKey?: string;
      serviceName?: string;
      captureContent?: boolean;
    });

export interface ExportIssue {
  sequence: number;
  signal: Signal;
  kind: "rejected" | "failed" | "dropped" | "invalid" | "warning";
  count: number;
  status?: number;
  message: string;
}

export interface ExportReport {
  acceptedSpans: number;
  acceptedLogs: number;
  rejectedSpans: number;
  rejectedLogs: number;
  failedSpans: number;
  failedLogs: number;
  pendingSpans: number;
  pendingLogs: number;
  droppedSpans: number;
  droppedLogs: number;
  pendingBytes: number;
  instrumentationFailures: number;
}

export interface SafeLifecycleOptions {
  /** Caller wait budget, 1–60000 ms. Default 1000. Does not cancel borrowed providers. */
  timeoutMillis?: number;
}

export interface SafeLifecycleResult {
  ok: boolean;
  timedOut: boolean;
  report: ExportReport;
}

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Attributes;
  sessionId?: string;
  userId?: string;
  input?: JsonValue;
  parentContext?: Context;
}

export interface TokenUsage {
  /** Provider-reported prompt tokens (`gen_ai.usage.input_tokens`). */
  inputTokens?: number;
  /** Provider-reported completion tokens (`gen_ai.usage.output_tokens`). */
  outputTokens?: number;
}

/**
 * Options for `hue.model()`: GenAI request metadata plus the `withSpan` options that apply to a
 * client span. `input` is recorded as `gen_ai.input.messages`.
 */
export interface ModelOptions
  extends Pick<SpanOptions, "sessionId" | "userId" | "input" | "parentContext"> {
  /** Provider identifier recorded as `gen_ai.provider.name`, for example "openai". */
  provider: string;
  /** Recorded as `gen_ai.operation.name`; defaults to "chat". */
  operation?: string;
  /** Span name; defaults to "{operation} {model}". */
  name?: string;
}

/** Value for AI SDK 6's `experimental_telemetry` option; AI SDK 7 uses `hueTelemetry` instead. */
export interface ExperimentalTelemetrySettings {
  isEnabled: boolean;
  recordInputs: boolean;
  recordOutputs: boolean;
  tracer: Tracer;
}

export interface HueSpan {
  span: Span;
  context: Context;
  traceId: string;
  spanId: string;
  setInput(value: JsonValue): void;
  setOutput(value: JsonValue): void;
  /** Records nonnegative integer token counts; invalid values are omitted and counted as instrumentation failures. */
  setUsage(usage: TokenUsage): void;
}

export type FlushableTracerProvider = TracerProvider & { forceFlush(): Promise<void> };
export type FlushableLoggerProvider = LoggerProvider & { forceFlush(): Promise<void> };

export interface ProjectConnection {
  id: string;
  name: string;
  organizationId: string;
  slug: string;
}

export type TraceReceiptField = "input" | "output" | "model" | "usage" | "session";
export interface TraceReceipt {
  traceId: string;
  spanCount: number;
  revision: number;
  /** Presence of stored normalized fields; not a judgment of content correctness. */
  fields: Record<TraceReceiptField, boolean>;
  matchedSpanIds: string[];
  missingSpanIds: string[];
  traceUrl: string;
}
export interface VerifyTraceOptions {
  expectedSpanIds?: string[];
  requiredFields?: TraceReceiptField[];
  /** Total request/retry budget, including response bodies. Default 10000; maximum 60000. */
  timeoutMillis?: number;
}
export interface TraceVerification {
  verified: boolean;
  receipt: TraceReceipt | null;
}
