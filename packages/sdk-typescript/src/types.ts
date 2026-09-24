import type {
  Attributes,
  Context,
  Span,
  SpanKind,
  Tracer,
  TracerProvider,
} from "@opentelemetry/api";
import type { LoggerProvider } from "@opentelemetry/api-logs";

/**
 * JSON-compatible data: the shape content has on the wire after the helpers encode it. Helpers
 * accept `unknown` and validate at runtime; values that are not plain JSON are omitted with an
 * instrumentation failure instead of being thrown into application code.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
/** Telemetry signal named by export reports, issues and processors. */
export type Signal = "traces" | "logs";

/** Options accepted by every Hue client and transport, whether enabled or disabled. */
export interface SharedHueOptions {
  /**
   * Whether helpers record prompts, responses, tool arguments and results. Required for an enabled
   * client, with no default; a disabled client (`enabled: false`) defaults it to `false`.
   */
  captureContent: boolean;
  /** Hue origin, `https://app.hue.run` by default. An origin only: no path, query, fragment or credentials. */
  baseUrl?: string;
  /** Recorded as the `service.version` resource attribute of an owned client. */
  serviceVersion?: string;
  /**
   * Additional resource attributes for an owned client, for example `deployment.environment.name`
   * or `service.namespace`. `service.name` and `service.version` from `serviceName` and
   * `serviceVersion` take precedence over same-named keys, as in the OpenTelemetry NodeSDK.
   * Ignored with a warning issue in attach mode, where the application owns the providers and
   * their resource.
   */
  resourceAttributes?: Attributes;
  /**
   * Permits `http://` for hosts other than loopback, for example a docker-compose or in-cluster
   * OpenTelemetry Collector. The project key then travels unencrypted; a one-time warning issue is
   * recorded. Off by default: HTTPS is required except for loopback development servers.
   */
  allowInsecureHttp?: boolean;
  /** Runs on string values before Hue export, including custom attribute values. */
  redact?: (value: string, path: string) => string;
  /** Receives sanitized export issues, at most one per second; never server response bodies or keys. */
  onExportIssue?: (issue: ExportIssue) => void | Promise<void>;
  /** Budget for each export request and connection check in milliseconds, 100–60000. Default 10000. */
  timeoutMillis?: number;
  /** Aggregate estimated retained telemetry bytes across both signals, including in-flight work. Default 8 MiB. */
  maxQueueBytes?: number;
  /**
   * Announces AI and Hue spans that are still running with in-progress placeholder spans, so Hue
   * shows a trace while it runs. Default `true`; always off for setup credentials (`hue_setup_…`),
   * and turned off for the client when its receiver does not accept placeholders.
   */
  liveSpans?: boolean;
}

/**
 * Options for a client that owns its OpenTelemetry providers. An enabled client needs a project
 * key, a service name and an explicit `captureContent` choice. The kill switch (`enabled: false`)
 * exports nothing while helpers keep running application code, so it needs no key and
 * `captureContent` defaults to `false`.
 */
export type HueOptions =
  | (SharedHueOptions & {
      /** Telemetry is on (the default). */
      enabled?: true;
      /** Project service key sent as a Bearer token; server side only. */
      apiKey: string;
      /** Recorded as the `service.name` resource attribute, 1–256 characters. */
      serviceName: string;
    })
  | (Omit<SharedHueOptions, "captureContent"> & {
      /** Local kill switch: no providers, exports or connection checks. */
      enabled: false;
      /** Ignored when disabled. */
      apiKey?: string;
      /** Ignored when disabled. */
      serviceName?: string;
      /** Optional when disabled; defaults to `false` because nothing is exported. */
      captureContent?: boolean;
    });

/** One sanitized delivery or instrumentation problem, kept in a bounded history of 128. */
export interface ExportIssue {
  /** Monotonic position in the transport's issue history. */
  sequence: number;
  /** Signal the issue belongs to. */
  signal: Signal;
  /** `rejected` by Hue, `failed` to deliver, `dropped` from the queue, `invalid` record or capture, or a non-failing `warning`. */
  kind: "rejected" | "failed" | "dropped" | "invalid" | "warning";
  /** Records affected; zero for capture failures and for warnings other than lost in-progress span placeholders. */
  count: number;
  /** HTTP status when the issue came from a response. */
  status?: number;
  /** Fixed, sanitized description; never server text or content. */
  message: string;
}

/** Cumulative delivery counters and current queue gauges for one transport. */
export interface ExportReport {
  /** Spans acknowledged by the collector. */
  acceptedSpans: number;
  /** Log records acknowledged by the collector. */
  acceptedLogs: number;
  /** Spans the collector rejected in a partial success. */
  rejectedSpans: number;
  /** Log records the collector rejected in a partial success. */
  rejectedLogs: number;
  /** Spans whose delivery failed or is uncertain. */
  failedSpans: number;
  /** Log records whose delivery failed or is uncertain. */
  failedLogs: number;
  /** Spans queued or in flight right now. */
  pendingSpans: number;
  /** Log records queued or in flight right now. */
  pendingLogs: number;
  /** Spans dropped before export because a queue or byte budget was full. */
  droppedSpans: number;
  /** Log records dropped before export because a queue or byte budget was full. */
  droppedLogs: number;
  /** Estimated bytes retained by the queue right now. */
  pendingBytes: number;
  /** Helper capture or instrumentation failures that omitted telemetry while preserving application results. */
  instrumentationFailures: number;
}

/** Caller budget for {@link HueClient.flushSafe} and {@link HueClient.shutdownSafe}. */
export interface SafeLifecycleOptions {
  /** Caller wait budget, 1–60000 ms. Default 1000. Does not cancel borrowed providers. */
  timeoutMillis?: number;
}

/** Non-throwing lifecycle outcome. */
export interface SafeLifecycleResult {
  /** Work finished within the budget with no new failures and nothing pending. */
  ok: boolean;
  /** The budget elapsed before the drain finished; work continues in the background. */
  timedOut: boolean;
  /** Counters at the time the result was produced. */
  report: ExportReport;
}

/** Options for {@link HueClient.withSpan} and the span-level part of {@link HueClient.model}. */
export interface SpanOptions {
  /** OpenTelemetry span kind; `INTERNAL` by default. */
  kind?: SpanKind;
  /** Attributes set when the span starts. */
  attributes?: Attributes;
  /** Recorded as `gen_ai.conversation.id` on this span and inherited by nested helper spans. */
  sessionId?: string;
  /** Recorded as `user.id` on this span and inherited by nested helper spans. */
  userId?: string;
  /**
   * The application workspace or tenant the work runs in, recorded as `hue.workspace.id` on this
   * span and inherited by nested helper spans.
   */
  workspaceId?: string;
  /** Recorded as `input.value` when `captureContent` is true; any JSON-encodable value. */
  input?: unknown;
  /** Explicit parent context, for example from {@link HueClient.extract}. */
  parentContext?: Context;
}

/**
 * MCP `initialize` `serverInfo` for {@link HueClient.tool}, plus the Hue provider and surface
 * when the tool came from one. Pass `client.getServerVersion()` after connect; any MCP server
 * works.
 */
export interface McpServerInfo {
  /** `serverInfo.name` from MCP initialize, recorded as `mcp.server.name`. */
  name?: string;
  /** `serverInfo.version` from MCP initialize, recorded as `mcp.server.version`. */
  version?: string;
  /** Hue provider id such as `google.gmail`, recorded as `hue.mcp.provider`. */
  provider?: string;
  /** Hue surface such as `google.gmail/mcp`, recorded as `hue.mcp.surface`. */
  surface?: string;
}

/**
 * Options for {@link HueClient.tool}. `callId` is the provider-issued tool-call
 * id; `mcp` is the MCP server that handled the call.
 */
export interface ToolOptions extends Pick<SpanOptions, "parentContext"> {
  /** Provider-issued identifier of this tool call, recorded as `gen_ai.tool.call.id`. */
  callId?: string;
  /**
   * MCP server that handled this call. Pass `client.getServerVersion()` or the
   * `initialize` `serverInfo` so a generic verb such as `get_thread` is attributed
   * to that server rather than inferred from the tool name.
   */
  mcp?: McpServerInfo;
}

/** Providers whose hosted tool calls {@link HueClient.recordProviderToolCalls} can read. */
export type HostedToolProvider = "openai" | "anthropic";

/** Identity of a hosted MCP server, keyed by the label the provider uses for it. */
export interface HostedServerInfo {
  /** Server name recorded as `mcp.server.name`; defaults to the provider's label. */
  name?: string;
  /** Server version recorded as `mcp.server.version`. */
  version?: string;
  /** Hue provider id such as `google.gmail`, recorded as `hue.mcp.provider`. */
  provider?: string;
  /** Hue surface such as `google.gmail/mcp`, recorded as `hue.mcp.surface`. */
  surface?: string;
}

/** Options for {@link HueClient.recordProviderToolCalls}. */
export interface ProviderToolCallOptions extends Pick<SpanOptions, "parentContext"> {
  /**
   * `openai` (Responses API) or `anthropic` (Messages API). Defaults to the enclosing `model()`
   * call's `provider` when it is one of these.
   */
  provider?: HostedToolProvider;
  /**
   * The request the response answers. Only hosted MCP server URLs are read from it (OpenAI
   * `tools[].server_url` by `server_label`, Anthropic `mcp_servers[].url` by `name`), to record
   * each server's host as `server.address`.
   */
  request?: unknown;
  /** Identity of each hosted MCP server, by the label the provider uses for it. */
  servers?: Record<string, HostedServerInfo>;
}

/**
 * A file the traced work read, received or produced, for {@link HueClient.recordFile}. Files are
 * linked by content hash; their bytes are never exported.
 */
export interface FileRecord {
  /**
   * `input` was given to the agent, `attachment` arrived from a tool or message, and `output` was
   * produced by the agent.
   */
  role: "input" | "attachment" | "output";
  /** Media type, for example `application/pdf`. */
  mediaType: string;
  /** Hex SHA-256 of the file's bytes; computed from `data` when omitted. */
  sha256?: string;
  /** The file's bytes, only hashed and measured, never exported; a string is hashed as UTF-8.
   * Data larger than 25 MiB is omitted and counted as an instrumentation failure. */
  data?: Uint8Array | string;
  /** Size in bytes; computed from `data` when omitted. */
  byteSize?: number;
  /** File name, recorded as `hue.file.name` only when `captureContent` is true. */
  name?: string;
}

/** Provider-reported token counts for {@link HueSpan.setUsage}. */
export interface TokenUsage {
  /** Provider-reported prompt tokens (`gen_ai.usage.input_tokens`). */
  inputTokens?: number;
  /** Provider-reported completion tokens (`gen_ai.usage.output_tokens`). */
  outputTokens?: number;
}

/**
 * Options for {@link HueClient.model}: GenAI request metadata plus the {@link SpanOptions} that
 * apply to a client span. `input` is recorded as `gen_ai.input.messages`.
 */
export interface ModelOptions
  extends Pick<SpanOptions, "sessionId" | "userId" | "workspaceId" | "input" | "parentContext"> {
  /** Provider identifier recorded as `gen_ai.provider.name`, for example "openai". */
  provider: string;
  /** Recorded as `gen_ai.operation.name`; defaults to "chat". */
  operation?: string;
  /** Span name; defaults to "{operation} {model}". */
  name?: string;
  /**
   * System instructions sent separately from the chat history, recorded as
   * `gen_ai.system_instructions` when `captureContent` is true. Any JSON-encodable value, ideally
   * GenAI semantic-convention parts such as `[{ type: "text", content: "..." }]`.
   */
  systemInstructions?: unknown;
  /**
   * Tool definitions offered to the model, recorded as `gen_ai.tool.definitions` when
   * `captureContent` is true. Any JSON-encodable value, ideally the GenAI shape
   * `[{ type: "function", name, description, parameters }]`.
   */
  tools?: unknown;
}

/** Value for AI SDK 6's `experimental_telemetry` option; AI SDK 7 uses `hueTelemetry` instead. */
export interface ExperimentalTelemetrySettings {
  /** Mirrors the client's `enabled` flag. */
  isEnabled: boolean;
  /** Mirrors `captureContent`. */
  recordInputs: boolean;
  /** Mirrors `captureContent`. */
  recordOutputs: boolean;
  /** Hue's tracer, so AI SDK spans parent under `withSpan` and inherit identifiers. */
  tracer: Tracer;
}

/** Handle passed to helper callbacks; content methods respect `captureContent` and never throw. */
export interface HueSpan {
  /** The underlying OpenTelemetry span, isolated so provider faults cannot reach the callback. */
  span: Span;
  /** Context with this span active, for APIs that take an explicit context. */
  context: Context;
  /** Lowercase hex trace ID, or all zeros when the client is disabled. */
  traceId: string;
  /** Lowercase hex span ID, or all zeros when the client is disabled. */
  spanId: string;
  /** Records `input.value` (or `gen_ai.input.messages` inside `model()`); any JSON-encodable value. */
  setInput(value: unknown): void;
  /** Records `output.value` (or `gen_ai.output.messages` inside `model()`); any JSON-encodable value. */
  setOutput(value: unknown): void;
  /** Records nonnegative integer token counts; invalid values are omitted and counted as instrumentation failures. */
  setUsage(usage: TokenUsage): void;
}

/** A tracer provider the client can drain; the OpenTelemetry SDK providers qualify. */
export type FlushableTracerProvider = TracerProvider & {
  /** Exports every finished span the provider still holds. */
  forceFlush(): Promise<void>;
};
/** A logger provider the client can drain; the OpenTelemetry SDK providers qualify. */
export type FlushableLoggerProvider = LoggerProvider & {
  /** Exports every emitted log record the provider still holds. */
  forceFlush(): Promise<void>;
};

/** Project identity returned by {@link HueClient.checkConnection}. */
export interface ProjectConnection {
  /** Project ID. */
  id: string;
  /** Display name. */
  name: string;
  /** Owning organization ID. */
  organizationId: string;
  /** URL slug. */
  slug: string;
}

/** Normalized fields a stored trace receipt can report as present. */
export type TraceReceiptField = "input" | "output" | "model" | "usage" | "session";
/** Evidence that Hue stored a trace, returned by {@link HueClient.verifyTrace}. */
export interface TraceReceipt {
  /** The verified trace ID. */
  traceId: string;
  /** Spans stored for the trace so far. */
  spanCount: number;
  /** Storage revision; increases as more spans arrive. */
  revision: number;
  /** Presence of stored normalized fields; not a judgment of content correctness. */
  fields: Record<TraceReceiptField, boolean>;
  /** Expected span IDs that are stored. */
  matchedSpanIds: string[];
  /** Expected span IDs that are not stored yet. */
  missingSpanIds: string[];
  /** Link to the trace in Hue, on the configured origin. */
  traceUrl: string;
}
/** Options for {@link HueClient.verifyTrace}. */
export interface VerifyTraceOptions {
  /** Up to 100 span IDs that must be stored before the trace counts as verified. */
  expectedSpanIds?: string[];
  /** Normalized fields that must be present before the trace counts as verified. */
  requiredFields?: TraceReceiptField[];
  /** Total request/retry budget, including response bodies. Default 10000; maximum 60000. */
  timeoutMillis?: number;
}
/** Outcome of {@link HueClient.verifyTrace}. */
export interface TraceVerification {
  /** Every expected span and required field was stored within the budget. */
  verified: boolean;
  /** Latest receipt observed, or `null` when the trace was never found. */
  receipt: TraceReceipt | null;
}
