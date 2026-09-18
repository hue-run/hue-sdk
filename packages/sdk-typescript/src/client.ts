import { AsyncLocalStorage } from "node:async_hooks";
import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type SpanOptions as OtelSpanOptions,
  type Tracer,
} from "@opentelemetry/api";
import { defaultTextMapGetter, defaultTextMapSetter } from "@opentelemetry/api";
import { SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { encodeContent, noopSpan, safeSpan } from "./safety.js";
import { createHueTransport, HueExportError, HueTransport } from "./transport.js";
import { verifyTrace } from "./receipt.js";
import { sdkVersion } from "./version.js";
import type {
  ExportReport,
  FlushableLoggerProvider,
  FlushableTracerProvider,
  HueOptions,
  HueSpan,
  JsonValue,
  ModelOptions,
  ProjectConnection,
  SpanOptions,
  TokenUsage,
  VerifyTraceOptions,
  TraceVerification,
  SafeLifecycleOptions,
  SafeLifecycleResult,
} from "./types.js";

interface LocalContext {
  context: Context;
  sessionId?: string;
  userId?: string;
}
export interface ExistingHueProviders {
  transport: HueTransport;
  tracerProvider: FlushableTracerProvider;
  loggerProvider: FlushableLoggerProvider;
}

export class HueConnectionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "HueConnectionError";
  }
}

function identifier(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4096 ||
    value.includes("\u0000") ||
    !value.isWellFormed()
  )
    throw new TypeError("Session/user identifiers must contain 1–4096 valid characters");
  return value;
}

/** Local async context preserves nesting without registering or replacing global OTel providers. */
class ContextualTracer implements Tracer {
  constructor(
    private source: Tracer,
    private storage: AsyncLocalStorage<LocalContext>,
    private enabled: () => boolean,
    private failed: () => void,
  ) {}
  startSpan(name: string, options: OtelSpanOptions = {}, parent?: Context): Span {
    if (!this.enabled()) return noopSpan();
    try {
      const active = this.storage.getStore();
      return safeSpan(
        this.source.startSpan(
          name,
          {
            ...options,
            attributes: {
              ...options.attributes,
              ...(active?.sessionId ? { "gen_ai.conversation.id": active.sessionId } : {}),
              ...(active?.userId ? { "user.id": active.userId } : {}),
            },
          },
          parent ?? active?.context ?? context.active(),
        ),
        this.failed,
      );
    } catch {
      this.failed();
      return noopSpan();
    }
  }
  startActiveSpan<F extends (span: Span) => unknown>(name: string, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: OtelSpanOptions,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: OtelSpanOptions,
    context: Context,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    optionsOrFn: OtelSpanOptions | F,
    contextOrFn?: Context | F,
    fn?: F,
  ): ReturnType<F> {
    const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
    const callback =
      typeof optionsOrFn === "function"
        ? optionsOrFn
        : typeof contextOrFn === "function"
          ? contextOrFn
          : fn;
    if (!callback) throw new TypeError("A span callback is required");
    let parent = ROOT_CONTEXT;
    try {
      parent =
        typeof contextOrFn === "object"
          ? contextOrFn
          : (this.storage.getStore()?.context ?? context.active());
    } catch {
      this.failed();
    }
    const span = this.startSpan(name, options, parent);
    let active = ROOT_CONTEXT;
    try {
      active = trace.setSpan(parent, span);
    } catch {
      this.failed();
      active = trace.setSpan(ROOT_CONTEXT, span);
    }
    return this.storage.run({ ...this.storage.getStore(), context: active }, () =>
      callback(span),
    ) as ReturnType<F>;
  }
}

const propagator = new W3CTraceContextPropagator();

export class HueClient {
  readonly transport: HueTransport;
  readonly tracer: Tracer;
  readonly captureContent: boolean;
  readonly enabled: boolean;
  private logger: Logger;
  private storage = new AsyncLocalStorage<LocalContext>();
  private tracerProvider: FlushableTracerProvider;
  private loggerProvider: FlushableLoggerProvider;
  private ownedProviders?: { tracer: TracerProvider; logger: LoggerProvider };
  private closed = false;
  private shutdownPromise?: Promise<ExportReport>;
  private flushPromise?: Promise<ExportReport>;
  private safeFlushPromise?: Promise<SafeLifecycleResult>;
  private safeShutdownPromise?: Promise<SafeLifecycleResult>;

  constructor(options: HueOptions | ExistingHueProviders) {
    if ("transport" in options) {
      this.transport = options.transport;
      this.tracerProvider = options.tracerProvider;
      this.loggerProvider = options.loggerProvider;
    } else {
      this.transport = createHueTransport(options);
      const resource = resourceFromAttributes({
        "service.name": options.serviceName,
        ...(options.serviceVersion ? { "service.version": options.serviceVersion } : {}),
      });
      const tracer = new TracerProvider({
        resource,
        spanProcessors:
          this.transport.options.enabled === false ? [] : [this.transport.spanProcessor],
      });
      const logger = new LoggerProvider({
        resource,
        processors:
          this.transport.options.enabled === false ? [] : [this.transport.logRecordProcessor],
      });
      this.ownedProviders = { tracer, logger };
      this.tracerProvider = tracer;
      this.loggerProvider = logger;
    }
    this.captureContent = this.transport.options.captureContent;
    this.enabled = this.transport.options.enabled !== false;
    this.tracer = new ContextualTracer(
      this.tracerProvider.getTracer("@hue-run/sdk", sdkVersion),
      this.storage,
      () => this.enabled && !this.closed,
      () => this.transport.instrumentationFailure(),
    );
    this.logger = this.loggerProvider.getLogger("@hue-run/sdk", sdkVersion);
  }

  verifyTrace(traceId: string, options: VerifyTraceOptions = {}): Promise<TraceVerification> {
    if (!this.enabled) return Promise.reject(new HueConnectionError("Hue telemetry is disabled"));
    return verifyTrace(this.transport.options, traceId, options);
  }

  getContext(): Context {
    try {
      return this.storage.getStore()?.context ?? context.active();
    } catch {
      this.transport.instrumentationFailure();
      return ROOT_CONTEXT;
    }
  }

  async withSpan<T>(
    name: string,
    callback: (span: HueSpan) => Promise<T> | T,
    options: SpanOptions = {},
  ): Promise<T> {
    let span = noopSpan();
    let active: LocalContext = { context: this.getContext() };
    if (this.enabled && !this.closed) {
      try {
        const inherited = this.storage.getStore();
        active = {
          context: options.parentContext ?? inherited?.context ?? context.active(),
          sessionId: identifier(options.sessionId ?? inherited?.sessionId),
          userId: identifier(options.userId ?? inherited?.userId),
        };
        span = this.storage.run(active, () =>
          this.tracer.startSpan(
            name,
            { kind: options.kind ?? SpanKind.INTERNAL, attributes: options.attributes },
            active.context,
          ),
        );
      } catch {
        this.transport.instrumentationFailure();
      }
    }
    let spanContext: Context;
    try {
      spanContext = trace.setSpan(active.context, span);
    } catch {
      this.transport.instrumentationFailure();
      spanContext = trace.setSpan(ROOT_CONTEXT, span);
    }
    const handle: HueSpan = {
      span,
      context: spanContext,
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      setInput: (value) => this.setContent(span, "input.value", value),
      setOutput: (value) => this.setContent(span, "output.value", value),
      setUsage: (usage) => this.setUsage(span, usage),
    };
    return this.storage.run({ ...active, context: spanContext }, async () => {
      // Setup, capture and cleanup have separate failure boundaries from customer code.
      try {
        if (this.enabled && !this.closed && options.input !== undefined)
          handle.setInput(options.input);
      } catch {
        this.transport.instrumentationFailure();
      }
      try {
        return await callback(handle);
      } catch (error) {
        this.recordError(span, error);
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async tool<T extends JsonValue | undefined>(
    name: string,
    input: JsonValue,
    execute: () => Promise<T> | T,
  ): Promise<T> {
    return this.withSpan(
      name,
      async ({ span }) => {
        this.setContent(span, "gen_ai.tool.call.arguments", input);
        const result = await execute();
        if (result !== undefined) this.setContent(span, "gen_ai.tool.call.result", result);
        return result;
      },
      { attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name } },
    );
  }

  /** A GenAI client span for one model call. `setInput`/`setOutput` record message content. */
  async model<T>(
    model: string,
    options: ModelOptions,
    callback: (span: HueSpan) => Promise<T> | T,
    spanOptions: Omit<SpanOptions, "kind" | "attributes"> = {},
  ): Promise<T> {
    // A disabled or closed client creates no span, so invalid metadata is not an instrumentation
    // failure either; only an active client records it (matching the other helpers).
    const active = this.enabled && !this.closed;
    const label = (value: unknown, fallback: string): string => {
      if (typeof value === "string" && value.trim() && value.length <= 256) return value;
      if (active) this.transport.instrumentationFailure();
      return fallback;
    };
    const requestModel = label(model, "unknown");
    const operation = label(options?.operation ?? "chat", "chat");
    const provider = label(options?.provider, "unknown");
    const name =
      options?.name === undefined
        ? `${operation} ${requestModel}`
        : label(options.name, `${operation} ${requestModel}`);
    return this.withSpan(
      name,
      (span) =>
        callback({
          ...span,
          setInput: (value) => this.setContent(span.span, "gen_ai.input.messages", value),
          setOutput: (value) => this.setContent(span.span, "gen_ai.output.messages", value),
        }),
      {
        ...spanOptions,
        kind: SpanKind.CLIENT,
        attributes: {
          "gen_ai.operation.name": operation,
          "gen_ai.request.model": requestModel,
          "gen_ai.provider.name": provider,
        },
      },
    );
  }

  private setUsage(span: Span, usage: TokenUsage): void {
    if (!this.enabled || this.closed) return;
    for (const [key, value] of [
      ["gen_ai.usage.input_tokens", usage?.inputTokens],
      ["gen_ai.usage.output_tokens", usage?.outputTokens],
    ] as const) {
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 0) {
        this.transport.instrumentationFailure();
        continue;
      }
      try {
        span.setAttribute(key, value);
      } catch {
        this.transport.instrumentationFailure();
      }
    }
  }

  /** Writes W3C `traceparent` for the active Hue span into a carrier; never the API key or baggage. */
  inject(carrier: Record<string, string>, activeContext: Context = this.getContext()): void {
    if (!this.enabled || this.closed) return;
    try {
      propagator.inject(activeContext, carrier, defaultTextMapSetter);
    } catch {
      this.transport.instrumentationFailure();
    }
  }

  /** Reads W3C trace context from a carrier for use as `parentContext`. */
  extract(carrier: Record<string, string | string[] | undefined>): Context {
    try {
      return propagator.extract(ROOT_CONTEXT, carrier, defaultTextMapGetter);
    } catch {
      this.transport.instrumentationFailure();
      return ROOT_CONTEXT;
    }
  }

  recordError(span: Span, error: unknown): void {
    if (!this.enabled || this.closed) return;
    try {
      const type = error instanceof Error ? error.name : "Error";
      span.setStatus({
        code: SpanStatusCode.ERROR,
        ...(this.captureContent
          ? { message: error instanceof Error ? error.message : "Operation failed" }
          : {}),
      });
      span.addEvent("exception", {
        "exception.type": type,
        ...(this.captureContent && error instanceof Error
          ? {
              "exception.message": error.message,
              ...(error.stack ? { "exception.stacktrace": error.stack } : {}),
            }
          : {}),
      });
    } catch {
      this.transport.instrumentationFailure();
    }
  }

  recordMessages(
    messages: { input?: JsonValue; output?: JsonValue },
    explicitContext?: Context,
  ): void {
    if (!this.enabled || this.closed || !this.captureContent) return;
    try {
      const active = explicitContext ?? this.getContext();
      if (!trace.getSpanContext(active))
        throw new Error("Message records require an active span or explicit span context");
      const body: Record<string, JsonValue> = {};
      if (messages.input !== undefined) body["gen_ai.input.messages"] = messages.input;
      if (messages.output !== undefined) body["gen_ai.output.messages"] = messages.output;
      this.logger.emit({
        context: active,
        severityNumber: SeverityNumber.INFO,
        eventName: "gen_ai.client.inference.operation.details",
        body: JSON.parse(encodeContent(body)),
      });
    } catch {
      this.transport.instrumentationFailure("logs");
    }
  }

  private setContent(span: Span, key: string, value: JsonValue): void {
    if (!this.enabled || this.closed || !this.captureContent) return;
    try {
      span.setAttribute(key, encodeContent(value));
    } catch {
      this.transport.instrumentationFailure();
    }
  }

  async checkConnection(): Promise<ProjectConnection> {
    if (!this.enabled) throw new HueConnectionError("Hue telemetry is disabled");
    const options = this.transport.options;
    let response: globalThis.Response;
    try {
      response = await fetch(`${options.baseUrl}/api/v1/projects/current`, {
        headers: { Authorization: `Bearer ${options.apiKey}` },
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMillis),
      });
    } catch {
      throw new HueConnectionError("Unable to connect to Hue; check the endpoint and network");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HueConnectionError("Hue rejected the project connection", response.status);
    }
    try {
      if (Number(response.headers.get("content-length") ?? 0) > 65536)
        throw new Error("Oversized project response");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing project response");
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) throw new Error("Oversized project response");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const project: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!project || typeof project !== "object") throw new Error("Invalid project response");
      const fields = project as Record<string, unknown>;
      for (const key of ["id", "name", "organizationId", "slug"])
        if (typeof fields[key] !== "string") throw new Error("Invalid project response");
      return {
        id: fields.id as string,
        name: fields.name as string,
        organizationId: fields.organizationId as string,
        slug: fields.slug as string,
      };
    } catch {
      throw new HueConnectionError("Hue returned an invalid project response");
    }
  }

  /** Production lifecycle path: never rejects; timeouts do not cancel borrowed provider work. */
  flushSafe(options: SafeLifecycleOptions = {}): Promise<SafeLifecycleResult> {
    if (this.safeFlushPromise) return this.safeFlushPromise;
    const work = this.flushPromise ?? this.flush();
    const result = this.safeLifecycle(() => work, options);
    this.safeFlushPromise = result;
    const clear = () => {
      this.safeFlushPromise = undefined;
    };
    // Retain the timed-out result until its underlying drain settles. Repeated
    // timeouts must not accumulate promises against a hung borrowed provider.
    void work.then(clear, clear);
    return result;
  }

  /** Safe for finally blocks; preserves the application's result or original exception. */
  shutdownSafe(options: SafeLifecycleOptions = {}): Promise<SafeLifecycleResult> {
    if (this.safeShutdownPromise) return this.safeShutdownPromise;
    const work = this.shutdown();
    const result = this.safeLifecycle(() => work, options);
    this.safeShutdownPromise = result;
    const clear = () => {
      this.safeShutdownPromise = undefined;
    };
    void work.then(clear, clear);
    return result;
  }

  private async safeLifecycle(
    work: () => Promise<ExportReport>,
    options: SafeLifecycleOptions,
  ): Promise<SafeLifecycleResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = options.timeoutMillis ?? 1000;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000)
        throw new TypeError("Invalid lifecycle budget");
      const outcome = await Promise.race([
        work().then(() => "complete" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeout);
        }),
      ]);
      const report = this.transport.getReport();
      return {
        ok:
          outcome === "complete" &&
          this.transport.getFailureSequence() === 0 &&
          report.pendingSpans + report.pendingLogs === 0,
        timedOut: outcome === "timeout",
        report,
      };
    } catch {
      return { ok: false, timedOut: false, report: this.transport.getReport() };
    } finally {
      clearTimeout(timer);
    }
  }

  flush(): Promise<ExportReport> {
    // Each caller needs a drain after its own preceding span/log emissions.
    // Joining an earlier drain can acknowledge records that were not in its batch.
    const from = this.transport.getFailureSequence();
    const drain = async () => {
      const report = await this.flushOnce();
      if (this.transport.getFailureSequence() !== from)
        throw new HueExportError(
          this.transport
            .getIssues()
            .filter((issue) => issue.sequence > from && issue.kind !== "warning"),
          report,
        );
      return report;
    };
    const next = (this.flushPromise ?? Promise.resolve()).then(drain, drain);
    this.flushPromise = next;
    const clear = () => {
      if (this.flushPromise === next) this.flushPromise = undefined;
    };
    void next.then(clear, clear);
    return next;
  }

  private async flushOnce(): Promise<ExportReport> {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => this.tracerProvider.forceFlush()),
      Promise.resolve().then(() => this.loggerProvider.forceFlush()),
    ]);
    for (const [index, result] of results.entries())
      if (result.status === "rejected")
        this.transport.issue(
          index === 0 ? "traces" : "logs",
          "failed",
          0,
          "OpenTelemetry provider flush failed",
        );
    return this.transport.flush();
  }

  shutdown(): Promise<ExportReport> {
    this.shutdownPromise ??= (async () => {
      this.closed = true;
      try {
        return await this.flush();
      } finally {
        if (this.ownedProviders) {
          await Promise.allSettled([
            this.ownedProviders.tracer.shutdown(),
            this.ownedProviders.logger.shutdown(),
          ]);
          await this.transport.shutdown();
        }
      }
    })();
    return this.shutdownPromise;
  }
}

export function createHue(options: HueOptions | ExistingHueProviders): HueClient {
  return new HueClient(options);
}

/** Fail-open initialization for production; strict createHue remains available for setup/CI. */
export function createHueSafe(options: HueOptions | ExistingHueProviders): HueClient {
  try {
    return new HueClient(options);
  } catch {
    const disabled = new HueClient({ enabled: false, captureContent: false });
    disabled.transport.instrumentationFailure();
    return disabled;
  }
}
