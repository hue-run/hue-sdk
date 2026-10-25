/* eslint-disable @typescript-eslint/unbound-method -- Observers forward methods with Reflect.apply and the original receiver. */
import { AsyncLocalStorage, executionAsyncId } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import type { ClientRequest, IncomingMessage } from "node:http";
import { types as utilTypes } from "node:util";
import {
  context,
  trace,
  SpanKind,
  SpanStatusCode,
  type Context,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";
import { HUE_SCOPE } from "./config.js";
import { contentLimitsOf, encodeBoundedContent, safeSpan, spanSource } from "./safety.js";
import { TRUNCATED_KEY, truncatedMarker, withTruncatedKeys } from "./privacy.js";
import { scrubCredentialTextUnbounded } from "./tool-definitions.js";
import { scrubHttpUrl } from "./http-url.js";

type HttpContentKey = "input.value" | "output.value";
export interface ObservedHttpIdentity {
  method: string;
  url: string;
  attributeValueLengthLimit?: number;
  attributeCountLimit?: number;
  contentCuts: ReadonlyMap<HttpContentKey, number>;
}
interface HttpObservation extends ObservedHttpIdentity {
  contentCuts: Map<HttpContentKey, number>;
}

export interface HttpCaptureSource {
  tracer: Tracer;
  context: () => Context;
  active: () => boolean;
  scope?: object;
  model: () => boolean;
}

interface CaptureOptions {
  baseUrl: string;
  bodies: boolean;
  valueBytes: () => number;
  failed: () => void;
  source?: HttpCaptureSource;
}

const suppressed = new AsyncLocalStorage<"export" | "fetch">();
const startingHttpSpan = new AsyncLocalStorage<boolean>();
const scopes = new AsyncLocalStorage<object>();
/** Scope identity survives shutdown so a resumed callback cannot use another client's capture. */
export function runHttpCaptureScope<T>(scope: object, work: () => T): T {
  return scopes.run(scope, work);
}
/** Export suppression also works when the application has no global OTel context manager. */
export function suppressHttpCapture<T>(work: () => T): T {
  return suppressed.run("export", work);
}

const behaviorHeaders = new Set([
  "notion-version",
  "slack-api-version",
  "stripe-version",
  "linear-api-version",
  "x-github-api-version",
]);
type Headers = Map<string, string>;

/** HTTP payloads also contain business headers and pagination tokens, unlike tool credentials. */
function isHttpCredentialKey(key: string): boolean {
  const name = key.toLowerCase().replace(/[-_]/g, "");
  return (
    [
      "authorization",
      "authorizationtoken",
      "proxyauthorization",
      "cookie",
      "setcookie",
      "apikey",
      "xapikey",
      "accesstoken",
      "refreshtoken",
      "idtoken",
      "authtoken",
      "sessiontoken",
      "bearertoken",
      "token",
      "secret",
      "password",
      "credential",
      "credentials",
    ].includes(name) || /(?:apikey|secret|password|credential)$/.test(name)
  );
}

function parseHttpJson(text: string, depth = 0): unknown {
  return JSON.parse(text, (key, value: unknown) => {
    if (isHttpCredentialKey(key)) return "[redacted]";
    if (typeof value === "string") return scrubHttpText(value, depth + 1);
    if (
      value &&
      typeof value === "object" &&
      "name" in value &&
      typeof value.name === "string" &&
      isHttpCredentialKey(value.name) &&
      "value" in value
    )
      value.value = "[redacted]";
    return value;
  });
}

function scrubHttpText(text: string, depth = 0): string {
  if (depth < 16 && /^\s*[{[]/.test(text)) {
    try {
      return JSON.stringify(parseHttpJson(text, depth));
    } catch {
      /* Text can resemble JSON. */
    }
  }
  if (/^https?:\/\//i.test(text)) {
    try {
      return scrubHttpUrl(text).href;
    } catch {
      /* Other text keeps the free-text filter. */
    }
  }
  return scrubCredentialTextUnbounded(text);
}

function headersOf(value: unknown): Headers {
  const result = new Map<string, string>();
  const add = (key: unknown, item: unknown) => {
    if (typeof key !== "string" && !(key instanceof Uint8Array)) return;
    const name = String(key).toLowerCase();
    if (name !== "content-type" && name !== "content-encoding" && !behaviorHeaders.has(name))
      return;
    if (Array.isArray(item)) item = item.join(", ");
    if (typeof item === "string" || typeof item === "number" || item instanceof Uint8Array)
      result.set(name, String(item));
  };
  if (typeof value === "string") {
    for (const line of value.split("\r\n")) {
      const at = line.indexOf(":");
      if (at >= 0) add(line.slice(0, at), line.slice(at + 1).trim());
    }
  } else if (Array.isArray(value)) {
    if (value.every(Array.isArray)) {
      for (const pair of value) add(pair[0], pair[1]);
    } else for (let i = 0; i + 1 < value.length; i += 2) add(value[i], value[i + 1]);
  } else if (value && typeof value === "object") {
    if (value instanceof globalThis.Headers)
      globalThis.Headers.prototype.forEach.call(value, (item, key) => add(key, item));
    else for (const [key, item] of Object.entries(value)) add(key, item);
  }
  return result;
}

function textual(headers: Headers): boolean {
  if (headers.has("content-encoding") && headers.get("content-encoding") !== "identity")
    return false;
  const type = headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return (
    !!type &&
    (type.startsWith("text/") ||
      type === "application/json" ||
      type.endsWith("+json") ||
      type === "application/xml" ||
      type.endsWith("+xml") ||
      type === "application/x-www-form-urlencoded")
  );
}

/** Only bytes that already pass through the customer's request or response are retained. */
class Body {
  size = 0;
  private parts: Buffer[] = [];
  private retained = 0;
  constructor(readonly cap: number) {}
  add(chunk: unknown, encoding?: unknown): void {
    let bytes: Uint8Array;
    if (typeof chunk === "string") {
      // Count before allocating: a huge caller-owned string must not be copied whole.
      const codec = typeof encoding === "string" && Buffer.isEncoding(encoding) ? encoding : "utf8";
      const size = Buffer.byteLength(chunk, codec);
      this.size += size;
      if (this.size > this.cap) {
        this.parts = [];
        this.retained = 0;
        return;
      }
      bytes = Buffer.from(chunk, codec);
    } else if (chunk instanceof Uint8Array) {
      this.size += chunk.byteLength;
      if (this.size > this.cap) {
        this.parts = [];
        this.retained = 0;
        return;
      }
      bytes = chunk;
    } else return;
    // Coalesce tiny chunks so the number of retained allocations is bounded by bytes too.
    let offset = 0;
    while (offset < bytes.byteLength) {
      let last = this.parts.at(-1);
      const used = this.retained % 16384;
      if (!last || used === 0) {
        last = Buffer.allocUnsafe(Math.min(16384, this.cap - this.retained));
        this.parts.push(last);
      }
      const count = Math.min(bytes.byteLength - offset, last.byteLength - used);
      last.set(bytes.subarray(offset, offset + count), used);
      offset += count;
      this.retained += count;
    }
  }
  value(headers: Headers): unknown {
    if (this.size > this.cap) return truncatedMarker(this.size);
    const text = Buffer.concat(this.parts, this.retained).toString("utf8");
    const type = headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (!text) return undefined;
    if (type === "application/json" || type?.endsWith("+json")) {
      try {
        return parseHttpJson(text);
      } catch {
        return scrubHttpText(text);
      }
    }
    if (type === "application/x-www-form-urlencoded") return queryOf(new URLSearchParams(text));
    return scrubHttpText(text);
  }
  clear(): void {
    this.parts = [];
    this.retained = 0;
  }
}

function queryOf(query: URLSearchParams): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, value] of query) {
    const item = isHttpCredentialKey(key) ? "[redacted]" : scrubHttpText(value);
    const previous = result[key];
    if (Array.isArray(previous)) previous.push(item);
    else result[key] = previous === undefined ? item : [previous, item];
  }
  return result;
}

function spanAttributes(span: Span | undefined): Record<string, unknown> | undefined {
  if (!span) return undefined;
  const raw = spanSource(span);
  if ("attributes" in raw && raw.attributes && typeof raw.attributes === "object")
    return raw.attributes as Record<string, unknown>;
  return undefined;
}

function modelSpan(span: Span | undefined): boolean {
  const attrs = spanAttributes(span);
  const operation = attrs?.["gen_ai.operation.name"];
  if (
    typeof operation === "string" &&
    [
      "chat",
      "generate_content",
      "text_completion",
      "embeddings",
      "embedding",
      "image_generation",
      "speech",
    ].includes(operation)
  )
    return true;
  const raw = span && spanSource(span);
  return (
    !!raw &&
    "name" in raw &&
    typeof raw.name === "string" &&
    /^ai\..*\.(doGenerate|doStream)$/.test(raw.name)
  );
}

function httpSpanIdentity(span: Span): { method: string; url: URL } | undefined {
  if (!span.isRecording() || !(span.spanContext().traceFlags & 1)) return;
  const raw = spanSource(span);
  if (!("kind" in raw) || raw.kind !== SpanKind.CLIENT) return;
  const attrs = spanAttributes(span);
  if (
    typeof attrs?.["gen_ai.tool.name"] === "string" ||
    attrs?.["gen_ai.operation.name"] === "execute_tool" ||
    typeof attrs?.["hue.tool.endpoint.source"] === "string"
  )
    return;
  const method = attrs?.["http.request.method"] ?? attrs?.["http.method"];
  const recorded = attrs?.["url.full"] ?? attrs?.["http.url"];
  if (typeof method !== "string" || typeof recorded !== "string") return;
  try {
    const url = new URL(recorded);
    if (url.protocol === "http:" || url.protocol === "https:") return { method, url };
  } catch {
    /* Non-HTTP client spans cannot match a network request. */
  }
}

function sameHttpSpan(span: Span | undefined, method: string, url: URL): span is Span {
  if (!span) return false;
  const identity = httpSpanIdentity(span);
  return identity?.method === method && identity.url.href === url.href;
}

interface HttpCandidate {
  span: Span;
  method: string;
  url: URL;
  parent: Context;
  parentId: string;
  asyncId: number;
  source: HttpCaptureSource;
}
interface Owner {
  options: CaptureOptions;
  readonly source: HttpCaptureSource;
  sources: Set<HttpCaptureSource>;
  pending: Set<Exchange>;
  observers: Map<() => void, HttpCaptureSource>;
  candidates: Map<object, HttpCandidate>;
  spans: WeakSet<object>;
  candidatesOverflowed: boolean;
}
const owners = new Set<Owner>();
const claimedHttpSpans = new WeakSet<object>();
const observedHttpIdentities = new WeakMap<object, HttpObservation>();
const MAX_HTTP_CANDIDATES = 2048;

/** OTel exposes no Span API for limits; both supported SDK implementations store these values. */
function providerLimits(
  span: Span,
): Pick<ObservedHttpIdentity, "attributeValueLengthLimit" | "attributeCountLimit"> {
  const result: Pick<ObservedHttpIdentity, "attributeValueLengthLimit" | "attributeCountLimit"> =
    {};
  try {
    const raw = spanSource(span);
    if (utilTypes.isProxy(raw)) return result;
    const length = Object.getOwnPropertyDescriptor(raw, "_attributeValueLengthLimit")?.value;
    if (
      typeof length === "number" &&
      (length === Infinity || (Number.isSafeInteger(length) && length >= 0))
    )
      result.attributeValueLengthLimit = length === 0 ? Infinity : length;
    const limits = Object.getOwnPropertyDescriptor(raw, "_spanLimits")?.value;
    if (!limits || typeof limits !== "object" || utilTypes.isProxy(limits)) return result;
    const count = Object.getOwnPropertyDescriptor(limits, "attributeCountLimit")?.value;
    if (
      typeof count === "number" &&
      (count === Infinity || (Number.isSafeInteger(count) && count >= 0))
    )
      result.attributeCountLimit = count;
  } catch {
    /* Unknown provider implementations keep their own policy. */
  }
  return result;
}

function parentIdentity(parent: Context): string {
  const ids = trace.getSpanContext(parent);
  return ids ? `${ids.traceId}:${ids.spanId}` : "";
}
function claimHttpSpan(span: Span): boolean {
  const raw = spanSource(span);
  if (claimedHttpSpans.has(raw)) return false;
  claimedHttpSpans.add(raw);
  for (const owner of owners) owner.candidates.delete(raw);
  return true;
}
/** Only one span begun in this execution and parent may own this physical request. */
function reserveCandidate(
  owner: Owner,
  parent: Context,
  method?: string,
  url?: URL,
): Span | undefined {
  if (owner.candidatesOverflowed) return;
  const asyncId = executionAsyncId();
  const parentId = parentIdentity(parent);
  let selected: HttpCandidate | undefined;
  for (const candidate of owner.candidates.values()) {
    if (
      candidate.parent !== parent ||
      candidate.parentId !== parentId ||
      candidate.asyncId !== asyncId ||
      claimedHttpSpans.has(spanSource(candidate.span)) ||
      !candidate.span.isRecording() ||
      (method !== undefined && (candidate.method !== method || candidate.url.href !== url?.href))
    )
      continue;
    if (selected) return;
    selected = candidate;
  }
  if (selected && claimHttpSpan(selected.span)) return selected.span;
}

class Exchange {
  readonly input: Body;
  readonly output: Body;
  responseHeaders: Headers = new Map();
  status?: number;
  requestComplete = true;
  responseComplete = true;
  private restorers: (() => void)[] = [];
  private ended = false;
  private readonly cuts = new Set<string>();
  constructor(
    readonly owner: Owner,
    readonly source: HttpCaptureSource,
    readonly span: Span,
    readonly ownsSpan: boolean,
    readonly url: URL,
    readonly requestHeaders: Headers,
    readonly bodies: boolean,
  ) {
    this.input = new Body(owner.options.valueBytes());
    this.output = new Body(owner.options.valueBytes());
    owner.pending.add(this);
    for (const [name, value] of requestHeaders)
      if (behaviorHeaders.has(name) || name === "content-type")
        span.setAttribute(`http.request.header.${name.replaceAll("-", "_")}`, value);
  }
  registerRestorer(restore: () => void): void {
    if (this.ended) this.safe(restore);
    else this.restorers.push(restore);
  }
  observe(body: Body, chunk: unknown, encoding?: unknown): void {
    if (!this.ended && this.bodies) this.safe(() => body.add(chunk, encoding));
  }
  private safe(work: () => void): void {
    safely(this.owner, work);
  }
  private content(key: HttpContentKey, value: unknown, cut: boolean, bytes: number): void {
    const encoded = encodeBoundedContent(value, contentLimitsOf(this.owner.options.valueBytes()));
    // A prefix may split a credential before the export redactor sees it. HTTP keeps no prefix.
    const intended = encoded.truncated ? JSON.stringify(truncatedMarker(bytes)) : encoded.text;
    this.span.setAttribute(key, intended);
    const stored = spanAttributes(this.span)?.[key];
    if (cut || encoded.truncated || stored !== intended) {
      this.cuts.add(key);
      observedHttpIdentities.get(spanSource(this.span))?.contentCuts.set(key, bytes);
      // Other exporters retain the provider's limit too, without a customer-content prefix.
      if (typeof stored === "string" && stored !== intended)
        this.span.setAttribute(key, JSON.stringify(truncatedMarker(bytes)));
    }
  }
  finish(complete: boolean, error?: unknown, stopped = false): void {
    if (this.ended) return;
    this.ended = true;
    this.owner.pending.delete(this);
    try {
      if (stopped && !this.ownsSpan) return;
      this.safe(() => {
        const requestType = this.requestHeaders.get("content-type");
        if (requestType) this.span.setAttribute("http.request.header.content_type", requestType);
        if (this.status !== undefined)
          this.span.setAttribute("http.response.status_code", this.status);
        for (const [name, value] of this.responseHeaders)
          if (behaviorHeaders.has(name) || name === "content-type")
            this.span.setAttribute(`http.response.header.${name.replaceAll("-", "_")}`, value);
        if (this.ownsSpan && (error !== undefined || !complete)) {
          this.span.setAttribute(
            "error.type",
            error instanceof Error ? error.name : "incomplete_response",
          );
          this.span.setStatus({ code: SpanStatusCode.ERROR });
        } else if (this.ownsSpan && this.status !== undefined && this.status >= 400)
          this.span.setStatus({ code: SpanStatusCode.ERROR });
        if (this.bodies) {
          if (this.requestComplete)
            this.span.setAttribute("http.request.body.size", this.input.size);
          if (this.responseComplete)
            this.span.setAttribute("http.response.body.size", this.output.size);
          const queryBytes = Buffer.byteLength(this.url.search);
          const query = queryBytes > this.input.cap ? undefined : queryOf(this.url.searchParams);
          if (this.requestComplete && (this.input.size === 0 || textual(this.requestHeaders))) {
            const body = this.input.value(this.requestHeaders);
            const cut = this.input.size > this.input.cap || !query;
            const input = !query
              ? truncatedMarker(queryBytes + this.input.size)
              : cut
                ? body
                : body === undefined
                  ? query
                  : body !== null && typeof body === "object" && !Array.isArray(body)
                    ? { ...query, ...body }
                    : { ...query, body };
            this.content("input.value", input, cut, queryBytes + this.input.size);
            this.span.setAttribute("input.mime_type", "application/json");
          }
          if (
            complete &&
            this.responseComplete &&
            (this.output.size === 0 || textual(this.responseHeaders))
          ) {
            const body = this.output.value(this.responseHeaders);
            const cut = this.output.size > this.output.cap;
            this.content("output.value", body ?? null, cut, this.output.size);
            this.span.setAttribute("output.mime_type", "application/json");
          }
          if (this.cuts.size)
            this.span.setAttribute(
              TRUNCATED_KEY,
              withTruncatedKeys(spanAttributes(this.span)?.[TRUNCATED_KEY], [...this.cuts]),
            );
        }
      });
    } finally {
      this.input.clear();
      this.output.clear();
      for (const restore of this.restorers) this.safe(restore);
      this.restorers = [];
      if (this.ownsSpan) this.safe(() => this.span.end());
    }
  }
}

/** Do not replace application changes made after Hue installed its observer. */
function observerRestorer(target: object, key: PropertyKey, observer: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return () => {
    if (Reflect.get(target, key) !== observer) return;
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  };
}

function selectOwner(): Owner | undefined {
  if (suppressed.getStore() || isTracingSuppressed(context.active())) return undefined;
  const available = [...owners];
  const scope = scopes.getStore();
  if (scope)
    return available.findLast((owner) =>
      [...owner.sources].some((source) => source.scope === scope),
    );
  return available.findLast((owner) => owner.source.active()) ?? available.at(-1);
}

function begin(
  owner: Owner,
  source: HttpCaptureSource,
  parent: Context,
  method: string,
  rawUrl: string,
  headers: unknown,
  reserved?: { span: Span | undefined; active: Span | undefined },
): Exchange | undefined {
  const url = new URL(rawUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    [...owners].some((entry) => entry.options.baseUrl === url.origin)
  )
    return;
  const local = trace.getSpan(parent);
  const global = reserved ? reserved.active : trace.getSpan(context.active());
  if (isTracingSuppressed(parent)) return;
  const bodies = owner.options.bodies && !source.model() && !modelSpan(local) && !modelSpan(global);
  const active =
    sameHttpSpan(global, method, url) &&
    owner.spans.has(spanSource(global)) &&
    claimHttpSpan(global)
      ? global
      : sameHttpSpan(local, method, url) &&
          owner.spans.has(spanSource(local)) &&
          claimHttpSpan(local)
        ? local
        : undefined;
  const candidate = reserved
    ? reserved.span
    : active
      ? undefined
      : reserveCandidate(owner, parent, method, url);
  const existing = active ?? (sameHttpSpan(candidate, method, url) ? candidate : undefined);
  const safeUrl = scrubHttpUrl(url);
  const span = safeSpan(
    existing ??
      startingHttpSpan.run(true, () =>
        source.tracer.startSpan(
          method,
          {
            kind: SpanKind.CLIENT,
            attributes: {
              "http.request.method": method,
              "url.full": safeUrl.href,
              "url.scheme": url.protocol.slice(0, -1),
              "server.address": url.hostname,
              "server.port": Number(url.port || (url.protocol === "https:" ? 443 : 80)),
            },
          },
          parent,
        ),
      ),
    owner.options.failed,
  );
  if (!span.isRecording()) return;
  observedHttpIdentities.set(spanSource(span), {
    method,
    url: safeUrl.href,
    ...providerLimits(span),
    contentCuts: new Map(),
  });
  return new Exchange(owner, source, span, !existing, url, headersOf(headers), bodies);
}

function safely(owner: Owner | undefined, work: () => void): void {
  try {
    work();
  } catch {
    try {
      owner?.options.failed();
    } catch {
      /* Diagnostics cannot change application behavior. */
    }
  }
}

/** Validated at diagnostics-channel boundaries. These undici methods forward the exact arguments. */
function undiciCreated(message: unknown): void {
  if (!message || typeof message !== "object" || !("request" in message)) return;
  const request = message.request;
  if (
    !request ||
    typeof request !== "object" ||
    !("method" in request) ||
    typeof request.method !== "string" ||
    !("origin" in request) ||
    !("path" in request) ||
    typeof request.path !== "string"
  )
    return;
  const owner = selectOwner();
  if (!owner) return;
  safely(owner, () => {
    const exchange = begin(
      owner,
      owner.source,
      owner.source.context(),
      request.method as string,
      new URL(request.path as string, String(request.origin)).href,
      "headers" in request ? request.headers : undefined,
    );
    if (!exchange) return;
    try {
      undiciExchanges.set(request, exchange);
      exchange.registerRestorer(() => {
        undiciExchanges.delete(request);
      });
      if (!exchange.bodies) return;
      const responseMethod =
        "onData" in request && typeof request.onData === "function"
          ? { key: "onData", original: request.onData }
          : "onResponseData" in request && typeof request.onResponseData === "function"
            ? { key: "onResponseData", original: request.onResponseData }
            : undefined;
      if (!responseMethod) exchange.responseComplete = false;
      if (!("onBodySent" in request) || typeof request.onBodySent !== "function")
        exchange.requestComplete = false;
      if (responseMethod) {
        const original = responseMethod.original;
        const observer = function (this: unknown, ...args: unknown[]) {
          exchange.observe(exchange.output, args[0]);
          return Reflect.apply(original, this, args);
        };
        const restore = observerRestorer(request, responseMethod.key, observer);
        exchange.registerRestorer(restore);
        if (!Reflect.set(request, responseMethod.key, observer))
          throw new TypeError("HTTP response observer is unavailable");
      }
      if ("onBodySent" in request && typeof request.onBodySent === "function") {
        const original = request.onBodySent;
        const observer = function (this: unknown, ...args: unknown[]) {
          exchange.observe(exchange.input, args[0]);
          return Reflect.apply(original, this, args);
        };
        const restore = observerRestorer(request, "onBodySent", observer);
        exchange.registerRestorer(restore);
        request.onBodySent = observer;
      }
    } catch (error) {
      exchange.finish(false, undefined, true);
      throw error;
    }
  });
}
const undiciExchanges = new WeakMap<object, Exchange>();
function undiciEvent(message: unknown, kind: "headers" | "end" | "error"): void {
  if (
    !message ||
    typeof message !== "object" ||
    !("request" in message) ||
    !message.request ||
    typeof message.request !== "object"
  )
    return;
  const exchange = undiciExchanges.get(message.request);
  if (!exchange) return;
  safely(exchange.owner, () => {
    if (
      kind === "headers" &&
      "response" in message &&
      message.response &&
      typeof message.response === "object"
    ) {
      const response = message.response;
      if ("statusCode" in response && typeof response.statusCode === "number")
        exchange.status = response.statusCode;
      if ("headers" in response) exchange.responseHeaders = headersOf(response.headers);
    } else if (kind === "end") exchange.finish(true);
    else if (kind === "error")
      exchange.finish(false, "error" in message ? message.error : undefined);
  });
}

const nodeRequests = new WeakSet<object>();
function nodeCreated(message: unknown): void {
  if (!message || typeof message !== "object" || !("request" in message)) return;
  const candidate = message.request;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !("write" in candidate) ||
    !("end" in candidate) ||
    !("flushHeaders" in candidate) ||
    !("emit" in candidate) ||
    !("getHeaders" in candidate) ||
    typeof candidate.write !== "function" ||
    typeof candidate.end !== "function" ||
    typeof candidate.flushHeaders !== "function" ||
    typeof candidate.emit !== "function" ||
    typeof candidate.getHeaders !== "function"
  )
    return;
  if (nodeRequests.has(candidate)) return;
  nodeRequests.add(candidate);
  const owner = selectOwner();
  if (!owner) return;
  const request = candidate as ClientRequest;
  const source = owner.source;
  const parent = source.context();
  // A later writer can have a different model scope and metadata from the request's creator.
  const inCreationContext = AsyncLocalStorage.snapshot();
  const reserved = {
    span: reserveCandidate(owner, parent),
    active: trace.getSpan(context.active()),
  };
  let exchange: Exchange | undefined;
  let starting = false;
  let restoreRequest = () => {};
  const start = () => {
    if (exchange || starting) return;
    if (!owners.has(owner) || (source.scope && !owner.sources.has(source))) {
      restoreRequest();
      return;
    }
    starting = true;
    safely(owner, () =>
      inCreationContext(() => {
        const host = request.getHeader("host");
        if (typeof host !== "string" || !host || !request.path) return;
        const url = /^https?:\/\//.test(request.path)
          ? request.path
          : `${request.protocol ?? "http:"}//${host}${request.path}`;
        exchange = begin(
          owner,
          source,
          parent,
          request.method,
          url,
          request.getHeaders(),
          reserved,
        );
        if (exchange) exchange.registerRestorer(restoreRequest);
        else restoreRequest();
      }),
    );
    starting = false;
  };
  let writing = false;
  const originalWrite = request.write;
  const write = function (this: ClientRequest, ...args: unknown[]): boolean {
    start();
    if (!writing) exchange?.observe(exchange.input, args[0], args[1]);
    return Reflect.apply(originalWrite, this, args);
  };
  const originalEnd = request.end;
  const end = function (this: ClientRequest, ...args: unknown[]): ClientRequest {
    start();
    exchange?.observe(exchange.input, args[0], args[1]);
    writing = true;
    try {
      return Reflect.apply(originalEnd, this, args);
    } finally {
      writing = false;
    }
  };
  const originalFlushHeaders = request.flushHeaders;
  const flushHeaders = function (this: ClientRequest, ...args: unknown[]): void {
    start();
    return Reflect.apply(originalFlushHeaders, this, args);
  };
  const originalEmit = request.emit;
  // A response listener would disable Node's automatic drain for unconsumed responses.
  const emit = function (this: ClientRequest, event: string | symbol, ...args: unknown[]): boolean {
    safely(owner, () => {
      if (event === "response") {
        start();
        if (exchange) observeResponse(args[0] as IncomingMessage, exchange);
      } else if (event === "error" || event === "abort" || event === "close") {
        start();
        if (exchange) exchange.finish(false, event === "error" ? args[0] : undefined);
        else restoreRequest();
      }
    });
    return Reflect.apply(originalEmit, this, [event, ...args]);
  };
  const restorers = [
    observerRestorer(request, "write", write),
    observerRestorer(request, "end", end),
    observerRestorer(request, "flushHeaders", flushHeaders),
    observerRestorer(request, "emit", emit),
  ];
  restoreRequest = () => {
    owner.observers.delete(restoreRequest);
    for (const restore of restorers) safely(owner, restore);
  };
  owner.observers.set(restoreRequest, source);
  safely(owner, () => {
    try {
      request.write = write;
      request.end = end;
      request.flushHeaders = flushHeaders;
      request.emit = emit;
    } catch (error) {
      restoreRequest();
      throw error;
    }
  });
}

function observeResponse(response: IncomingMessage, exchange: Exchange): void {
  exchange.status = response.statusCode;
  exchange.responseHeaders = headersOf(response.headers);
  const originalPush = response.push;
  const push = function (
    this: IncomingMessage,
    chunk: unknown,
    encoding?: BufferEncoding,
  ): boolean {
    if (chunk === null) exchange.finish(true);
    else exchange.observe(exchange.output, chunk, encoding);
    return Reflect.apply(originalPush, this, [chunk, encoding]);
  };
  const originalEmit = response.emit;
  const emit = function (
    this: IncomingMessage,
    event: string | symbol,
    ...args: unknown[]
  ): boolean {
    if (event === "error" || event === "aborted" || event === "close")
      exchange.finish(false, event === "error" ? args[0] : undefined);
    return Reflect.apply(originalEmit, this, [event, ...args]);
  };
  const restorePush = observerRestorer(response, "push", push);
  const restoreEmit = observerRestorer(response, "emit", emit);
  exchange.registerRestorer(restorePush);
  exchange.registerRestorer(restoreEmit);
  safely(exchange.owner, () => {
    try {
      response.push = push;
      response.emit = emit;
    } catch (error) {
      exchange.finish(false, undefined, true);
      throw error;
    }
  });
}

const channelListeners: [string, (message: unknown) => void][] = [
  ["undici:request:create", undiciCreated],
  ["undici:request:headers", (message) => undiciEvent(message, "headers")],
  ["undici:request:trailers", (message) => undiciEvent(message, "end")],
  ["undici:request:error", (message) => undiciEvent(message, "error")],
  ["http.client.request.created", nodeCreated],
  ["http.client.request.start", nodeCreated],
];

// Keep native channel instances alive across subscribe/unsubscribe cycles on Bun.
const channels = channelListeners.map(
  ([name, listener]): [ReturnType<typeof channel>, (message: unknown) => void] => [
    channel(name),
    (message) => {
      try {
        listener(message);
      } catch {
        for (const owner of owners) safely(undefined, owner.options.failed);
      }
    },
  ],
);

function decorateResponse(
  response: Response,
  metadata: Pick<Response, "url" | "redirected" | "type">,
  failed: () => void,
): Response {
  const clone = response.clone;
  Object.defineProperties(response, {
    url: { value: metadata.url, configurable: true },
    redirected: { value: metadata.redirected, configurable: true },
    type: { value: metadata.type, configurable: true },
    clone: {
      configurable: true,
      writable: true,
      value: function (this: Response): Response {
        const cloned: Response = Reflect.apply(clone, this, []);
        try {
          return decorateResponse(cloned, this, failed);
        } catch {
          failed();
          return cloned;
        }
      },
    },
  });
  return response;
}

let originalFetch: typeof fetch | undefined;
let wrappedFetch: typeof fetch | undefined;
function fetchMethod(method: string): string {
  const normalized = method.toUpperCase();
  return ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"].includes(normalized)
    ? normalized
    : method;
}
/** Observing a Fetch dictionary must not evaluate its getters a second time. */
function fetchOptions(
  init: Parameters<typeof fetch>[1],
): { method?: string; headers?: unknown; body?: unknown } | undefined {
  if (init === undefined) return {};
  if (!init || typeof init !== "object" || utilTypes.isProxy(init)) return undefined;
  const prototype = Object.getPrototypeOf(init);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const result: { method?: string; headers?: unknown; body?: unknown } = {};
  for (const key of ["method", "headers", "body"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(init, key);
    if (!descriptor) {
      if (prototype && Object.getOwnPropertyDescriptor(prototype, key)) return undefined;
      continue;
    }
    if (!("value" in descriptor)) return undefined;
    if (key === "method") {
      if (descriptor.value !== undefined && typeof descriptor.value !== "string") return undefined;
      result.method = descriptor.value;
    } else result[key] = descriptor.value;
  }
  return result;
}
function observableFetchHeaders(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== "object" || utilTypes.isProxy(value)) return false;
  if (value instanceof globalThis.Headers) return true;
  if (Array.isArray(value)) {
    return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => {
      if (!("value" in descriptor)) return false;
      if (typeof descriptor.value === "number") return true;
      const pair: unknown = descriptor.value;
      if (!Array.isArray(pair) || utilTypes.isProxy(pair) || pair.length !== 2) return false;
      return ["0", "1"].every((key) => {
        const field = Object.getOwnPropertyDescriptor(pair, key);
        return !!field && "value" in field && typeof field.value === "string";
      });
    });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) =>
      "value" in descriptor &&
      (typeof descriptor.value === "string" || typeof descriptor.value === "number"),
  );
}

function observableFetchInput(input: Parameters<typeof fetch>[0]): boolean {
  if (typeof input === "string") return true;
  if (!input || typeof input !== "object" || utilTypes.isProxy(input)) return false;
  if (input instanceof URL)
    return (
      Object.getPrototypeOf(input) === URL.prototype &&
      !Object.hasOwn(input, "toString") &&
      !Object.hasOwn(input, Symbol.toPrimitive)
    );
  return (
    input instanceof Request &&
    Object.getPrototypeOf(input) === Request.prototype &&
    ["url", "method", "headers", "body"].every((key) => !Object.hasOwn(input, key))
  );
}

function installFetch(): void {
  // Bun publishes node:http diagnostics, but its native fetch has no undici request objects.
  if (!("Bun" in globalThis) || originalFetch) return;
  originalFetch = globalThis.fetch;
  const fetcher = originalFetch;
  const observedFetch = function (
    this: unknown,
    ...args: Parameters<typeof fetch>
  ): Promise<Response> {
    const [input, init] = args;
    const send = () =>
      suppressed.run(suppressed.getStore() ?? "fetch", () => Reflect.apply(fetcher, this, args));
    const owner = selectOwner();
    if (!owner) return send();
    let observed:
      | { method: string; url: string; headers: unknown; body: unknown; requestBody: boolean }
      | undefined;
    safely(owner, () => {
      const observedOptions = fetchOptions(init);
      if (!observedOptions) return;
      if (!observableFetchHeaders(observedOptions.headers) || !observableFetchInput(input)) return;
      const request = input instanceof Request ? input : undefined;
      observed = {
        method: fetchMethod(observedOptions.method ?? request?.method ?? "GET"),
        url: request?.url ?? String(input),
        headers: observedOptions.headers ?? request?.headers,
        body: observedOptions.body,
        requestBody: !!request?.body,
      };
    });
    // A delegating wrapper may start the existing HTTP span during this synchronous call.
    const result = send();
    let exchange: Exchange | undefined;
    safely(owner, () => {
      if (!observed || selectOwner() !== owner) return;
      exchange = begin(
        owner,
        owner.source,
        owner.source.context(),
        observed.method,
        observed.url,
        observed.headers,
      );
      if (!exchange) return;
      const body = observed.body;
      if (typeof body === "string" || body instanceof Uint8Array) {
        if (typeof body === "string" && !exchange.requestHeaders.has("content-type"))
          exchange.requestHeaders.set("content-type", "text/plain;charset=UTF-8");
        exchange.observe(exchange.input, body);
      } else if (body instanceof ArrayBuffer)
        exchange.observe(exchange.input, new Uint8Array(body));
      else if (body instanceof URLSearchParams) {
        if (!exchange.requestHeaders.has("content-type"))
          exchange.requestHeaders.set("content-type", "application/x-www-form-urlencoded");
        exchange.observe(exchange.input, body.toString());
      } else if (body != null || observed.requestBody) exchange.requestComplete = false;
    });
    const captured = exchange;
    if (!captured) return result;
    return result.then(
      (response) => {
        try {
          const init = {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          };
          const metadata = {
            url: response.url,
            redirected: response.redirected,
            type: response.type,
          };
          captured.status = init.status;
          captured.responseHeaders = headersOf(init.headers);
          // Bun exposes only the logical fetch, so a followed redirect's body has no proven hop.
          if (response.redirected) captured.responseComplete = false;
          const body = response.body;
          if (!captured.bodies || !body) {
            captured.finish(true);
            return response;
          }
          // One reader, pulled only by the returned response. No clone branch can accumulate bytes.
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          const stream = new ReadableStream<Uint8Array>(
            {
              async pull(controller) {
                try {
                  reader ??= body.getReader();
                  const { done, value } = await reader.read();
                  if (done) {
                    captured.finish(true);
                    controller.close();
                  } else {
                    captured.observe(captured.output, value);
                    controller.enqueue(value);
                  }
                } catch (error) {
                  captured.finish(false, error);
                  controller.error(error);
                }
              },
              cancel(reason) {
                captured.finish(false);
                return reader ? reader.cancel(reason) : body.cancel(reason);
              },
            },
            { highWaterMark: 0 },
          );
          return decorateResponse(new Response(stream, init), metadata, owner.options.failed);
        } catch {
          owner.options.failed();
          captured.finish(false);
          return response;
        }
      },
      (error: unknown) => {
        captured.finish(false, error);
        throw error;
      },
    );
  };
  wrappedFetch = Object.assign(observedFetch, fetcher);
  globalThis.fetch = wrappedFetch;
}

export function startHttpCapture(options: CaptureOptions): {
  use(source: HttpCaptureSource): () => void;
  stop(): void;
  spanStarted(span: Span, parent: Context): void;
  identity(span: object): ObservedHttpIdentity | undefined;
  spanEnded(span: object): ObservedHttpIdentity | undefined;
} {
  const fallback: HttpCaptureSource = {
    tracer: trace.getTracer(HUE_SCOPE),
    context: () => context.active(),
    active: () => false,
    model: () => false,
  };
  const owner: Owner = {
    options,
    sources: new Set(options.source ? [options.source] : []),
    get source() {
      const sources = [...this.sources];
      const scope = scopes.getStore();
      return (
        (scope
          ? sources.findLast((source) => source.scope === scope)
          : (sources.findLast((source) => source.active()) ?? sources.at(-1))) ?? fallback
      );
    },
    pending: new Set(),
    observers: new Map(),
    candidates: new Map(),
    spans: new WeakSet(),
    candidatesOverflowed: false,
  };
  if (!owners.size) {
    for (const [captureChannel, listener] of channels) captureChannel.subscribe(listener);
    safely(owner, installFetch);
  }
  owners.add(owner);
  const finish = (source?: HttpCaptureSource) => {
    for (const exchange of owner.pending)
      if (!source || exchange.source === source) exchange.finish(false, undefined, true);
    for (const [restore, registered] of owner.observers)
      if (!source || registered === source) safely(owner, restore);
    for (const [span, candidate] of owner.candidates)
      if (!source || candidate.source === source) owner.candidates.delete(span);
  };
  return {
    spanStarted(span, parent) {
      safely(owner, () => {
        if (owners.has(owner)) owner.spans.add(spanSource(span));
        if (
          !owners.has(owner) ||
          startingHttpSpan.getStore() ||
          suppressed.getStore() === "export" ||
          isTracingSuppressed(parent) ||
          owner.candidatesOverflowed
        )
          return;
        const identity = httpSpanIdentity(span);
        if (!identity || claimedHttpSpans.has(spanSource(span))) return;
        if (owner.candidates.size >= MAX_HTTP_CANDIDATES) {
          owner.candidates.clear();
          owner.candidatesOverflowed = true;
          queueMicrotask(() => {
            owner.candidatesOverflowed = false;
          });
          return;
        }
        const raw = spanSource(span);
        const candidate: HttpCandidate = {
          span,
          ...identity,
          parent,
          parentId: parentIdentity(parent),
          asyncId: executionAsyncId(),
          source: owner.source,
        };
        owner.candidates.set(raw, candidate);
        queueMicrotask(() => {
          if (owner.candidates.get(raw) === candidate) owner.candidates.delete(raw);
        });
      });
    },
    identity(span) {
      return observedHttpIdentities.get(span);
    },
    spanEnded(span) {
      owner.candidates.delete(span);
      return observedHttpIdentities.get(span);
    },
    use(source) {
      if (!owners.has(owner)) return () => {};
      owner.sources.add(source);
      return () => {
        finish(source);
        owner.sources.delete(source);
      };
    },
    stop() {
      owners.delete(owner);
      finish();
      owner.sources.clear();
      if (!owners.size) {
        for (const [captureChannel, listener] of channels) captureChannel.unsubscribe(listener);
        safely(owner, () => {
          if (originalFetch && globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
          originalFetch = undefined;
          wrappedFetch = undefined;
        });
      }
    },
  };
}
