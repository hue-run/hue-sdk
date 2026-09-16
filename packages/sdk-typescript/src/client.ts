import { AsyncLocalStorage } from "node:async_hooks";
import {
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type SpanOptions as OtelSpanOptions,
  type Tracer,
} from "@opentelemetry/api";
import { SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MAX_CONTENT_BYTES } from "./config.js";
import { createHueTransport, HueExportError, HueTransport } from "./transport.js";
import { verifyTrace } from "./receipt.js";
import type {
  ExportReport,
  FlushableLoggerProvider,
  FlushableTracerProvider,
  HueOptions,
  HueSpan,
  JsonValue,
  ProjectConnection,
  SpanOptions,
  VerifyTraceOptions,
  TraceVerification,
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
  ) {}
  startSpan(name: string, options: OtelSpanOptions = {}, parent?: Context): Span {
    const active = this.storage.getStore();
    return this.source.startSpan(
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
    );
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
    const parent =
      typeof contextOrFn === "object"
        ? contextOrFn
        : (this.storage.getStore()?.context ?? context.active());
    const span = this.startSpan(name, options, parent);
    return this.storage.run(
      { ...this.storage.getStore(), context: trace.setSpan(parent, span) },
      () => callback(span),
    ) as ReturnType<F>;
  }
}

export class HueClient {
  readonly transport: HueTransport;
  readonly tracer: Tracer;
  readonly captureContent: boolean;
  private logger: Logger;
  private storage = new AsyncLocalStorage<LocalContext>();
  private tracerProvider: FlushableTracerProvider;
  private loggerProvider: FlushableLoggerProvider;
  private ownedProviders?: { tracer: TracerProvider; logger: LoggerProvider };
  private closed = false;
  private shutdownPromise?: Promise<ExportReport>;
  private flushPromise?: Promise<ExportReport>;

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
        spanProcessors: [this.transport.spanProcessor],
      });
      const logger = new LoggerProvider({
        resource,
        processors: [this.transport.logRecordProcessor],
      });
      this.ownedProviders = { tracer, logger };
      this.tracerProvider = tracer;
      this.loggerProvider = logger;
    }
    this.captureContent = this.transport.options.captureContent;
    this.tracer = new ContextualTracer(
      this.tracerProvider.getTracer("@hue-run/sdk", "0.1.4"),
      this.storage,
    );
    this.logger = this.loggerProvider.getLogger("@hue-run/sdk", "0.1.4");
  }

  verifyTrace(traceId: string, options: VerifyTraceOptions = {}): Promise<TraceVerification> {
    return verifyTrace(this.transport.options, traceId, options);
  }

  getContext(): Context {
    return this.storage.getStore()?.context ?? context.active();
  }

  async withSpan<T>(
    name: string,
    callback: (span: HueSpan) => Promise<T> | T,
    options: SpanOptions = {},
  ): Promise<T> {
    if (this.closed) throw new Error("Hue client is shut down");
    const inherited = this.storage.getStore();
    const sessionId = identifier(options.sessionId ?? inherited?.sessionId);
    const userId = identifier(options.userId ?? inherited?.userId);
    const parent = options.parentContext ?? inherited?.context ?? context.active();
    const active: LocalContext = { context: parent, sessionId, userId };
    return this.storage.run(active, async () => {
      const span = this.tracer.startSpan(
        name,
        { kind: options.kind ?? SpanKind.INTERNAL, attributes: options.attributes },
        parent,
      );
      const spanContext = trace.setSpan(parent, span);
      const handle: HueSpan = {
        span,
        context: spanContext,
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        setInput: (value) => this.setContent(span, "input.value", value),
        setOutput: (value) => this.setContent(span, "output.value", value),
      };
      return this.storage.run({ ...active, context: spanContext }, async () => {
        try {
          if (options.input !== undefined) handle.setInput(options.input);
          return await callback(handle);
        } catch (error) {
          this.recordError(span, error);
          throw error;
        } finally {
          span.end();
        }
      });
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

  recordError(span: Span, error: unknown): void {
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
  }

  recordMessages(
    messages: { input?: JsonValue; output?: JsonValue },
    explicitContext?: Context,
  ): void {
    if (this.closed) throw new Error("Hue client is shut down");
    if (!this.captureContent) return;
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
      body,
    });
  }

  private setContent(span: Span, key: string, value: JsonValue): void {
    if (!this.captureContent) return;
    const encoded = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "number" && !Number.isFinite(item))
        throw new TypeError("Captured JSON numbers must be finite");
      return item;
    });
    if (encoded === undefined || Buffer.byteLength(encoded) > MAX_CONTENT_BYTES)
      throw new RangeError("Captured content must be JSON and no more than 256 KiB");
    span.setAttribute(key, encoded);
  }

  async checkConnection(): Promise<ProjectConnection> {
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
      this.tracerProvider.forceFlush(),
      this.loggerProvider.forceFlush(),
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
