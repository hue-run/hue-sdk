import { INVALID_SPAN_CONTEXT, trace, type Span } from "@opentelemetry/api";
import { types as utilTypes } from "node:util";
import { MAX_CONTENT_BYTES } from "./config.js";

export function noopSpan(): Span {
  return trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
}

/** Isolate the public Span interface without changing its fluent method contract. */
class SafeSpan implements Span {
  constructor(
    private source: Span,
    private failed: () => void,
  ) {}

  private write(work: () => unknown): void {
    try {
      const result = work();
      // Broken/custom providers can return rejected promises from synchronous
      // OTel methods. Observe them without awaiting on application code paths.
      if (result && typeof (result as PromiseLike<unknown>).then === "function")
        void Promise.resolve(result).catch(this.failed);
    } catch {
      this.failed();
    }
  }

  spanContext(): ReturnType<Span["spanContext"]> {
    try {
      const ids = this.source.spanContext();
      if (!ids || typeof ids.traceId !== "string" || typeof ids.spanId !== "string")
        throw new TypeError("Invalid span context");
      return {
        traceId: ids.traceId,
        spanId: ids.spanId,
        traceFlags: ids.traceFlags,
        isRemote: ids.isRemote,
        traceState: ids.traceState,
      };
    } catch {
      this.failed();
      return INVALID_SPAN_CONTEXT;
    }
  }
  isRecording(): boolean {
    try {
      return this.source.isRecording() === true;
    } catch {
      this.failed();
      return false;
    }
  }
  setAttribute(...args: Parameters<Span["setAttribute"]>): this {
    this.write(() => this.source.setAttribute(...args));
    return this;
  }
  setAttributes(...args: Parameters<Span["setAttributes"]>): this {
    this.write(() => this.source.setAttributes(...args));
    return this;
  }
  addEvent(...args: Parameters<Span["addEvent"]>): this {
    this.write(() => this.source.addEvent(...args));
    return this;
  }
  addLink(...args: Parameters<Span["addLink"]>): this {
    this.write(() => this.source.addLink(...args));
    return this;
  }
  addLinks(...args: Parameters<Span["addLinks"]>): this {
    this.write(() => this.source.addLinks(...args));
    return this;
  }
  setStatus(...args: Parameters<Span["setStatus"]>): this {
    this.write(() => this.source.setStatus(...args));
    return this;
  }
  updateName(...args: Parameters<Span["updateName"]>): this {
    this.write(() => this.source.updateName(...args));
    return this;
  }
  end(...args: Parameters<Span["end"]>): void {
    this.write(() => this.source.end(...args));
  }
  recordException(...args: Parameters<Span["recordException"]>): void {
    this.write(() => this.source.recordException(...args));
  }
}

export function safeSpan(source: Span, failed: () => void): Span {
  return new SafeSpan(source, failed);
}

/** The bounds `encodeContent` enforces while it copies a value. */
export interface EncodeLimits {
  bytes: number;
  nodes: number;
  depth: number;
}
/** One content attribute's bounds. */
const contentLimits: EncodeLimits = { bytes: MAX_CONTENT_BYTES, nodes: 16384, depth: 32 };

/** Validate a bounded data tree without invoking toJSON or property getters. */
export function encodeContent(value: unknown, limits: EncodeLimits = contentLimits): string {
  const { text, truncated } = encodeBoundedContent(value, limits, false);
  if (truncated) throw new RangeError("Content limit exceeded");
  return text;
}

/**
 * The value as JSON text within `limits.bytes`, and whether it was cut to fit. A value over the
 * cap is cut to a UTF-8 prefix of its JSON text, as Hue's receiver cuts a value over its own cap,
 * so a span still carries the call, the recorded part of its result and the rest of its
 * evidence; the caller lists the key under `hue.truncated`. Text past the budget is cut as it is
 * copied and the keys past it are left out, so no more than the budget is ever held.
 */
export function encodeBoundedContent(
  value: unknown,
  limits: EncodeLimits = contentLimits,
  cut = true,
): { text: string; truncated: boolean } {
  let nodes = 0;
  let bytes = 0;
  let truncated = false;
  const ancestors = new Set<object>();
  const charge = (amount: number) => {
    bytes += amount;
    if (bytes > limits.bytes) {
      if (!cut) throw new RangeError("Content limit exceeded");
      truncated = true;
    }
  };
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > limits.nodes || depth > limits.depth)
      throw new RangeError("Content complexity limit exceeded");
    if (typeof item === "string") {
      let text = item;
      if (text.length > limits.bytes) {
        if (!cut) throw new RangeError("Content limit exceeded");
        // The copy itself is bounded: a longer string is cut before it is escaped.
        truncated = true;
        text = text.slice(0, limits.bytes);
      }
      charge(Buffer.byteLength(JSON.stringify(text)));
      return text;
    }
    if (item === null || typeof item === "boolean" || typeof item === "number") {
      if (typeof item === "number" && !Number.isFinite(item)) throw new TypeError("Invalid number");
      charge(JSON.stringify(item).length);
      return item;
    }
    if (!item || typeof item !== "object" || ancestors.has(item))
      throw new TypeError("Invalid JSON");
    // Even descriptor/prototype reads can execute application code on a Proxy.
    // The native check also handles revoked proxies without invoking their traps.
    if (utilTypes.isProxy(item)) throw new TypeError("JSON proxies are unsupported");
    const array = Array.isArray(item);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
      throw new TypeError("Expected JSON data");
    ancestors.add(item);
    charge(2);
    const result: unknown[] | Record<string, unknown> = array ? [] : Object.create(null);
    // Own descriptors avoid executing application accessors during capture.
    const keys = array
      ? Array.from({ length: Math.min(item.length, limits.nodes + 1) }, (_, i) => String(i))
      : Object.keys(item);
    if (keys.length > limits.nodes) throw new RangeError("Content complexity limit exceeded");
    for (const key of keys) {
      // Past the budget, the rest is cut anyway: nothing more is copied.
      if (truncated) break;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !("value" in descriptor))
        throw new TypeError("Expected JSON data property");
      charge(1 + (array ? 0 : Buffer.byteLength(JSON.stringify(key)) + 1));
      const child = visit(descriptor.value, depth + 1);
      if (array) (result as unknown[]).push(child);
      else (result as Record<string, unknown>)[key] = child;
    }
    ancestors.delete(item);
    return result;
  };
  const encoded = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(encoded) <= limits.bytes) return { text: encoded, truncated };
  if (!cut) throw new RangeError("Content limit exceeded");
  return { text: truncateUtf8(encoded, limits.bytes), truncated: true };
}

/** `value` cut to at most `max` UTF-8 bytes, ending on a character boundary. */
export function truncateUtf8(value: string, max: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= max) return value;
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.toString("utf8", 0, end);
}

/** Bounded conservative accounting for the record data retained by our queue, not total process RSS. */
export function estimateRecordBytes(value: unknown, limit: number): number {
  let bytes = 0;
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number) => {
    if (++nodes > 16384 || depth > 32) throw new RangeError("Telemetry complexity limit exceeded");
    bytes += 16;
    if (typeof item === "string") bytes += item.length * 2;
    else if (item instanceof Uint8Array) bytes += item.byteLength;
    else if (item && typeof item === "object" && !seen.has(item)) {
      seen.add(item);
      // Match admission (`Snapshot.copy`): array elements are nodes without retained index
      // keys. Charging indexes here would refuse array-heavy records the queue admitted.
      if (Array.isArray(item)) for (const child of item) visit(child, depth + 1);
      else
        for (const [key, child] of Object.entries(item)) {
          bytes += key.length * 2 + 16;
          visit(child, depth + 1);
        }
    }
    if (bytes > limit) throw new RangeError("Telemetry byte limit exceeded");
  };
  visit(value, 0);
  return bytes;
}
