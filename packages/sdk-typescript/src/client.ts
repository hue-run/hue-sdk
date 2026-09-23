import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  context,
  isSpanContextValid,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
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
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { HUE_SCOPE } from "./config.js";
import { encodeContent, noopSpan, safeSpan } from "./safety.js";
import { createHueTransport, HueExportError, HueTransport } from "./transport.js";
import { verifyTrace } from "./receipt.js";
import { sdkVersion } from "./version.js";
import type {
  ExportReport,
  FileRecord,
  FlushableLoggerProvider,
  FlushableTracerProvider,
  HueOptions,
  HueSpan,
  ModelOptions,
  ProjectConnection,
  SpanOptions,
  TokenUsage,
  ToolOptions,
  VerifyTraceOptions,
  TraceVerification,
  SafeLifecycleOptions,
  SafeLifecycleResult,
} from "./types.js";

interface LocalContext {
  context: Context;
  sessionId?: string;
  userId?: string;
  /** Request metadata of the enclosing `model()` call, copied onto message records. */
  model?: { operation: string; provider: string; requestModel: string };
}
/**
 * Attach mode: the application owns its OpenTelemetry providers and passes the transport whose
 * processors it attached to them. The client flushes these providers but never shuts them down.
 */
export interface ExistingHueProviders {
  /** Transport from {@link createHueTransport} whose processors are attached to the providers below. */
  transport: HueTransport;
  /** Application-owned tracer provider; must support `forceFlush()`. */
  tracerProvider: FlushableTracerProvider;
  /** Application-owned logger provider; must support `forceFlush()`. */
  loggerProvider: FlushableLoggerProvider;
}

/**
 * Thrown by {@link HueClient.checkConnection} and {@link HueClient.verifyTrace} when Hue cannot be
 * reached, rejects the project key or answers unexpectedly. The message is fixed and safe to log;
 * the underlying network, timeout or parsing error, when there is one, is available as `cause`.
 */
export class HueConnectionError extends Error {
  constructor(
    message: string,
    /** HTTP status when Hue answered; absent for network, timeout and parsing failures. */
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
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

/** A usable metadata label: a non-blank string of at most 256 characters. */
function isLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= 256;
}

/** A source label uses the stricter wire-safe validation without changing existing labels. */
function isSourceLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= 256 &&
    !value.includes("\u0000") &&
    value.isWellFormed()
  );
/** A label that is also free of NUL and unpaired surrogates, which export would reject. */
function isTextLabel(value: unknown): value is string {
  return isLabel(value) && !value.includes("\u0000") && value.isWellFormed();
}

type Outcome<T> = { value: T } | { error: unknown };

/**
 * Runs `work` exactly once with `active` as OpenTelemetry's current context, so instrumentations
 * that use the global API parent under the Hue span. Without a registered context manager
 * `context.with` only calls `work`; a failing manager is counted and cannot skip or rerun `work`.
 */
function runInContext<T>(active: Context, work: () => T, failed: () => void): T {
  const slot: { outcome?: Outcome<T> } = {};
  const invoke = (): Outcome<T> => {
    try {
      return { value: work() };
    } catch (error) {
      return { error };
    }
  };
  try {
    context.with(active, () => {
      slot.outcome = invoke();
    });
  } catch {
    failed();
  }
  const settled = slot.outcome ?? invoke();
  if ("error" in settled) throw settled.error;
  return settled.value;
}

/** Error class name for `error.type` and `exception.type`; never the message or stack. */
function errorType(error: unknown): string {
  return error instanceof Error && error.name ? String(error.name) : "Error";
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
    // A disabled client creates no span and leaves the application's active context untouched.
    const created = isSpanContextValid(span.spanContext());
    let active = parent;
    if (created)
      try {
        active = trace.setSpan(parent, span);
      } catch {
        this.failed();
        active = trace.setSpan(ROOT_CONTEXT, span);
      }
    return this.storage.run({ ...this.storage.getStore(), context: active }, () =>
      created
        ? runInContext(active, () => callback(span) as ReturnType<F>, this.failed)
        : (callback(span) as ReturnType<F>),
    );
  }
}

const propagator = new W3CTraceContextPropagator();

/**
 * Hue tracing client. Helpers create spans through a private tracer and local async context, never
 * through global OpenTelemetry registration, and they fail open: capture problems are counted in
 * the export report while application code runs and returns unchanged.
 */
export class HueClient {
  /** Export pipeline: counters, issue history and the processors that feed Hue. */
  readonly transport: HueTransport;
  /** Hue's tracer for other instrumentations; spans parent under `withSpan` and inherit identifiers. */
  readonly tracer: Tracer;
  /** Whether helpers record content, as configured. */
  readonly captureContent: boolean;
  /** False for `enabled: false` clients and for `createHueSafe` fallbacks; helpers then only run callbacks. */
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
      if (this.transport.options.resourceAttributes !== undefined)
        this.transport.issue(
          "traces",
          "warning",
          0,
          "resourceAttributes are ignored in attach mode; configure the resource on the application's providers",
        );
    } else {
      this.transport = createHueTransport(options);
      // The OpenTelemetry default resource supplies the required telemetry.sdk.* attributes and
      // Hue's service identity is merged on top of any caller-supplied resourceAttributes, so
      // serviceName and serviceVersion take precedence over same-named keys. Nothing here reads
      // environment variables.
      const resource = defaultResource().merge(
        resourceFromAttributes({
          ...options.resourceAttributes,
          "service.name": this.transport.options.serviceName,
          ...(options.serviceVersion ? { "service.version": options.serviceVersion } : {}),
        }),
      );
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
      this.tracerProvider.getTracer(HUE_SCOPE, sdkVersion),
      this.storage,
      () => this.enabled && !this.closed,
      () => this.transport.instrumentationFailure(),
    );
    this.logger = this.loggerProvider.getLogger(HUE_SCOPE, sdkVersion);
  }

  /**
   * Verifies that Hue stored a trace by ID, optionally waiting for expected span IDs and normalized
   * fields within the budget. Read-only; it does not flush or inspect content.
   *
   * @throws HueConnectionError when the client is disabled.
   * @throws HueTraceVerificationError for authentication, unsupported endpoint, transport or invalid response failures.
   * @throws TypeError for an invalid trace ID or options.
   */
  verifyTrace(traceId: string, options: VerifyTraceOptions = {}): Promise<TraceVerification> {
    if (!this.enabled) return Promise.reject(new HueConnectionError("Hue telemetry is disabled"));
    return verifyTrace(this.transport.options, traceId, options);
  }

  /** The helper's current context: the innermost active Hue span, else the OpenTelemetry active context. */
  getContext(): Context {
    try {
      return this.storage.getStore()?.context ?? context.active();
    } catch {
      this.transport.instrumentationFailure();
      return ROOT_CONTEXT;
    }
  }

  /**
   * Runs `callback` inside a new span that nests under the active Hue span. Application errors are
   * recorded on the span and rethrown unchanged; the span always ends when the callback settles.
   */
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
          model: inherited?.model,
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
    // A disabled or failed client creates no span; the application's own active span then stays
    // visible through getContext(), inject() and HueSpan.context instead of an invalid one.
    const created = isSpanContextValid(span.spanContext());
    let spanContext = active.context;
    if (created)
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
    const execute = async (): Promise<T> => {
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
    };
    // The span is also OpenTelemetry's active span while the callback runs, so spans from other
    // instrumentations (HTTP clients, provider SDKs) join this trace when the application has
    // registered a context manager. Hue still registers none itself.
    return this.storage.run({ ...active, context: spanContext }, () =>
      created
        ? runInContext(spanContext, execute, () => this.transport.instrumentationFailure())
        : execute(),
    );
  }

  /**
   * Runs `execute` inside an `execute_tool` span named after the tool. `input` and a defined result
   * are recorded as `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` when `captureContent`
   * is true; values that are not JSON-encodable are omitted with an instrumentation failure.
   * `options.callId` is recorded as `gen_ai.tool.call.id`, like the Python `call_id=` keyword.
   * `options.mcp` records the MCP `initialize` `serverInfo` as `mcp.server.name` /
   * `mcp.server.version` so a generic tool name can be attributed to the server that
   * handled it. Pass `client.getServerVersion()`. `mcp.provider` / `mcp.surface` record the Hue
   * provider and surface as `hue.mcp.provider` / `hue.mcp.surface`.
   */
  async tool<T>(
    name: string,
    input: unknown,
    execute: () => Promise<T> | T,
    options: ToolOptions = {},
  ): Promise<T> {
    const attributes: Attributes = {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": name,
    };
    const stamp = (
      key: string,
      value: unknown,
      valid: (value: unknown) => value is string = isLabel,
    ) => {
      if (value === undefined) return;
      // A blank or non-string label is omitted and counted; the tool call itself still runs.
      if (valid(value)) attributes[key] = value;
      else if (this.enabled && !this.closed) this.transport.instrumentationFailure();
    };
    stamp("gen_ai.tool.call.id", options.callId);
    stamp("mcp.server.name", options.mcp?.name);
    stamp("mcp.server.version", options.mcp?.version);
    stamp("hue.mcp.provider", options.mcp?.provider, isSourceLabel);
    stamp("hue.mcp.surface", options.mcp?.surface, isSourceLabel);
    return this.withSpan(
      `execute_tool ${name}`,
      async ({ span }) => {
        this.setContent(span, "gen_ai.tool.call.arguments", input);
        const result = await execute();
        if (result !== undefined) this.setContent(span, "gen_ai.tool.call.result", result);
        return result;
      },
      {
        attributes,
        ...(options.parentContext ? { parentContext: options.parentContext } : {}),
      },
    );
  }

  /**
   * Runs `callback` inside a GenAI client span for one direct provider call, named
   * `{operation} {model}` unless `options.name` is given and carrying `gen_ai.operation.name`,
   * `gen_ai.request.model` and `gen_ai.provider.name`. The argument order matches `withSpan`. The
   * handle's `setInput`/`setOutput` record `gen_ai.input.messages` / `gen_ai.output.messages`,
   * which should use the GenAI semantic-convention message shape; `recordMessages` inside the
   * callback inherits the request metadata. `options.systemInstructions` and `options.tools` are
   * recorded as `gen_ai.system_instructions` and `gen_ai.tool.definitions`, content like `input`.
   */
  async model<T>(
    model: string,
    callback: (span: HueSpan) => Promise<T> | T,
    options: ModelOptions,
  ): Promise<T> {
    // A disabled or closed client creates no span, so invalid metadata is not an instrumentation
    // failure either; only an active client records it (matching the other helpers).
    const active = this.enabled && !this.closed;
    const label = (value: unknown, fallback: string): string => {
      if (isLabel(value)) return value;
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
    const metadata = { operation, provider, requestModel };
    const {
      sessionId,
      userId,
      parentContext,
      input,
      systemInstructions,
      tools,
    }: Partial<ModelOptions> = options ?? {};
    return this.withSpan(
      name,
      (span) => {
        const handle: HueSpan = {
          ...span,
          setInput: (value) => this.setContent(span.span, "gen_ai.input.messages", value),
          setOutput: (value) => this.setContent(span.span, "gen_ai.output.messages", value),
        };
        if (input !== undefined) handle.setInput(input);
        if (systemInstructions !== undefined)
          this.setContent(span.span, "gen_ai.system_instructions", systemInstructions);
        if (tools !== undefined) this.setContent(span.span, "gen_ai.tool.definitions", tools);
        // recordMessages inside the callback copies this request metadata onto its log record.
        const store = this.storage.getStore() ?? { context: span.context };
        return this.storage.run({ ...store, model: metadata }, () => callback(handle));
      },
      {
        sessionId,
        userId,
        parentContext,
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

  /**
   * Writes W3C `traceparent` for the active span into a carrier; never the API key or baggage.
   * Propagation also runs for a disabled or closed client so downstream tracing stays connected.
   */
  inject(carrier: Record<string, string>, activeContext: Context = this.getContext()): void {
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

  /**
   * Marks a span failed the same way in every helper: `error.type`, an ERROR status without a
   * description and an `exception` event carrying only the type. Exception messages and stack
   * traces are never recorded, whatever `captureContent` is, matching the Python SDK.
   */
  recordError(span: Span, error: unknown): void {
    if (!this.enabled || this.closed) return;
    try {
      const type = errorType(error);
      span.setAttribute("error.type", type);
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.addEvent("exception", { "exception.type": type });
    } catch {
      this.transport.instrumentationFailure();
    }
  }

  /**
   * Emits a `gen_ai.client.inference.operation.details` log record correlated with the active (or
   * given) span, carrying the messages in its body. `gen_ai.operation.name`, `gen_ai.provider.name`
   * and `gen_ai.request.model` are set as record attributes from the caller's values or the
   * enclosing {@link model} span, and `gen_ai.conversation.id` from the active session. Nothing is
   * emitted when `captureContent` is false; capture failures are counted, never thrown.
   */
  recordMessages(
    messages: {
      /** Input messages, ideally in the GenAI semantic-convention shape; any JSON-encodable value. */
      input?: unknown;
      /** Output messages, ideally in the GenAI semantic-convention shape; any JSON-encodable value. */
      output?: unknown;
      /** System instructions sent separately from the messages, as `gen_ai.system_instructions`. */
      systemInstructions?: unknown;
      /** `gen_ai.operation.name` for the record; defaults to the enclosing `model()` span's value. */
      operation?: string;
      /** `gen_ai.provider.name` for the record; defaults to the enclosing `model()` span's value. */
      provider?: string;
      /** `gen_ai.request.model` for the record; defaults to the enclosing `model()` span's value. */
      model?: string;
    },
    explicitContext?: Context,
  ): void {
    if (!this.enabled || this.closed || !this.captureContent) return;
    try {
      const store = this.storage.getStore();
      const active = explicitContext ?? store?.context ?? context.active();
      if (!trace.getSpanContext(active))
        throw new Error("Message records require an active span or explicit span context");
      const body: Record<string, unknown> = {};
      if (messages.input !== undefined) body["gen_ai.input.messages"] = messages.input;
      if (messages.output !== undefined) body["gen_ai.output.messages"] = messages.output;
      if (messages.systemInstructions !== undefined)
        body["gen_ai.system_instructions"] = messages.systemInstructions;
      // Request metadata is inherited only when the record correlates with the enclosing helper
      // scope; an unrelated explicit context carries caller-supplied values alone.
      const enclosing =
        explicitContext === undefined || explicitContext === store?.context ? store : undefined;
      const attributes: Record<string, string> = {};
      const stamp = (key: string, explicit: unknown, inherited: string | undefined) => {
        if (explicit === undefined) {
          if (inherited !== undefined) attributes[key] = inherited;
        } else if (typeof explicit === "string" && explicit.trim() && explicit.length <= 256)
          attributes[key] = explicit;
        else this.transport.instrumentationFailure("logs");
      };
      stamp("gen_ai.operation.name", messages.operation, enclosing?.model?.operation);
      stamp("gen_ai.provider.name", messages.provider, enclosing?.model?.provider);
      stamp("gen_ai.request.model", messages.model, enclosing?.model?.requestModel);
      stamp("gen_ai.conversation.id", undefined, enclosing?.sessionId);
      this.logger.emit({
        context: active,
        severityNumber: SeverityNumber.INFO,
        eventName: "gen_ai.client.inference.operation.details",
        attributes,
        body: JSON.parse(encodeContent(body)),
      });
    } catch {
      this.transport.instrumentationFailure("logs");
    }
  }

  /**
   * Adds a `hue.file` event to the active (or given) span for a file the work read, received or
   * produced: `hue.file.sha256`, `hue.file.role`, `hue.file.media_type`, `hue.file.size` when known
   * and, when `captureContent` is true, `hue.file.name`. `data` is hashed and measured locally and
   * never exported. The event is metadata, so it is recorded in both capture modes. An invalid
   * record, or one without an active span, is omitted and counted, never thrown; an invalid name
   * alone is omitted and counted while the rest is recorded.
   */
  recordFile(file: FileRecord, explicitContext?: Context): void {
    if (!this.enabled || this.closed) return;
    try {
      const span = trace.getSpan(
        explicitContext ?? this.storage.getStore()?.context ?? context.active(),
      );
      if (!span?.isRecording()) throw new Error("File records require an active span");
      const { role, mediaType, data, name } = file;
      if (role !== "input" && role !== "attachment" && role !== "output")
        throw new TypeError("Invalid file role");
      if (!isTextLabel(mediaType)) throw new TypeError("Invalid media type");
      let sha256 = typeof file.sha256 === "string" ? file.sha256.toLowerCase() : file.sha256;
      let byteSize = file.byteSize;
      if (data !== undefined) {
        const bytes =
          typeof data === "string"
            ? Buffer.from(data, "utf8")
            : data instanceof Uint8Array
              ? data
              : undefined;
        if (!bytes) throw new TypeError("File data must be bytes or a string");
        const digest = createHash("sha256").update(bytes).digest("hex");
        // A caller-supplied digest or size must describe the same bytes.
        if (
          (sha256 !== undefined && sha256 !== digest) ||
          (byteSize !== undefined && byteSize !== bytes.byteLength)
        )
          throw new TypeError("File digest or size does not match its data");
        sha256 = digest;
        byteSize = bytes.byteLength;
      }
      if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256))
        throw new TypeError("A file needs a SHA-256 digest or its data");
      if (byteSize !== undefined && (!Number.isSafeInteger(byteSize) || byteSize < 0))
        throw new TypeError("Invalid file size");
      const attributes: Attributes = {
        "hue.file.sha256": sha256,
        "hue.file.role": role,
        "hue.file.media_type": mediaType,
      };
      if (byteSize !== undefined) attributes["hue.file.size"] = byteSize;
      if (this.captureContent && name !== undefined) {
        if (isTextLabel(name)) attributes["hue.file.name"] = name;
        else this.transport.instrumentationFailure();
      }
      span.addEvent("hue.file", attributes);
    } catch {
      this.transport.instrumentationFailure();
    }
  }

  private setContent(span: Span, key: string, value: unknown): void {
    if (!this.enabled || this.closed || !this.captureContent) return;
    try {
      span.setAttribute(key, encodeContent(value));
    } catch {
      this.transport.instrumentationFailure();
    }
  }

  /**
   * Confirms the key and origin by reading the current project; a setup and CI diagnostic, not a
   * readiness gate. Redirects are refused and the response is bounded.
   *
   * @throws HueConnectionError when the client is disabled, Hue is unreachable (the network or
   * timeout error is the `cause`), the key is rejected (`status` is set) or the response is invalid.
   */
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
    } catch (error) {
      throw new HueConnectionError(
        "Unable to connect to Hue; check the endpoint and network",
        undefined,
        { cause: error },
      );
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
    } catch (error) {
      throw new HueConnectionError("Hue returned an invalid project response", undefined, {
        cause: error,
      });
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

  /**
   * Drains the trace and log providers and waits for Hue's acknowledgements. Each caller gets a
   * fresh serialized drain that includes records emitted before its call.
   *
   * @throws HueExportError when this drain observed a new rejection, delivery failure, drop or
   * invalid record; its `issues` and `report` are sanitized counts, never server text.
   */
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

  /**
   * Flushes, then shuts down the providers this client owns; borrowed providers are left running.
   * Idempotent: later calls return the same promise, and later helper calls only run their callbacks.
   *
   * @throws HueExportError when the final flush observed new failures; owned providers are still released.
   */
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

/**
 * Creates a client that owns its providers ({@link HueOptions}) or attaches to the application's
 * ({@link ExistingHueProviders}). Strict: use it for setup and CI, `createHueSafe` in serving code.
 *
 * @throws TypeError for invalid options, including a missing `captureContent` choice, an invalid
 * key or `serviceName`, a non-origin or insecure `baseUrl`, or out-of-range budgets.
 */
export function createHue(options: HueOptions | ExistingHueProviders): HueClient {
  return new HueClient(options);
}

/**
 * Fail-open initialization for production: invalid options return a disabled client with one
 * instrumentation failure recorded instead of throwing. Strict {@link createHue} remains for setup/CI.
 */
export function createHueSafe(options: HueOptions | ExistingHueProviders): HueClient {
  try {
    return new HueClient(options);
  } catch (error) {
    // The caller's diagnostics hook stays attached and hears why telemetry is off.
    const disabled = new HueClient({ enabled: false, onExportIssue: issueCallback(options) });
    const reason = error instanceof Error && error.message ? error.message : "unknown error";
    disabled.transport.instrumentationFailure("traces", `Hue is disabled: ${reason.slice(0, 256)}`);
    return disabled;
  }
}

function issueCallback(options: unknown): HueOptions["onExportIssue"] {
  try {
    const source =
      options && typeof options === "object" && "transport" in options
        ? (options as Partial<ExistingHueProviders>).transport?.options
        : options;
    const callback = (source as { onExportIssue?: unknown } | undefined)?.onExportIssue;
    return typeof callback === "function" ? (callback as HueOptions["onExportIssue"]) : undefined;
  } catch {
    return undefined;
  }
}
