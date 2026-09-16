import type { Attributes, Context, Span, SpanKind, TracerProvider } from "@opentelemetry/api";
import type { LoggerProvider } from "@opentelemetry/api-logs";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type Signal = "traces" | "logs";

export interface HueOptions {
  apiKey: string;
  serviceName: string;
  captureContent: boolean;
  baseUrl?: string;
  serviceVersion?: string;
  /** Runs on string values before Hue export, including custom attribute values. */
  redact?: (value: string, path: string) => string;
  onExportIssue?: (issue: ExportIssue) => void;
  timeoutMillis?: number;
}

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
}

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Attributes;
  sessionId?: string;
  userId?: string;
  input?: JsonValue;
  parentContext?: Context;
}

export interface HueSpan {
  span: Span;
  context: Context;
  traceId: string;
  spanId: string;
  setInput(value: JsonValue): void;
  setOutput(value: JsonValue): void;
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
