import { createTraceState, type SpanContext } from "@opentelemetry/api";
import { types as utilTypes } from "node:util";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import type { ReadableLogRecord, ReadWriteLogRecord } from "@opentelemetry/sdk-logs";

// Intrinsic accessors are captured once and invoked with an explicit receiver so a
// hostile object cannot override them; the unbound reference is the point.
// eslint-disable-next-line @typescript-eslint/unbound-method
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)!.get!;
// eslint-disable-next-line @typescript-eslint/unbound-method
const typedArraySet = Uint8Array.prototype.set;

/** Copies only exported data, with the same finite budget used for admission. */
class Snapshot {
  bytes = 512;
  unresolvedResource = false;
  private nodes = 0;
  private ancestors = new Set<object>();
  private copied = new Map<object, unknown>();

  constructor(private limit: number) {}

  private charge(bytes: number): void {
    this.bytes += bytes;
    if (this.bytes > this.limit) throw new RangeError("Telemetry byte budget exceeded");
  }

  copy<T>(value: T, depth = 0): T {
    if (++this.nodes > 16384 || depth > 32)
      throw new RangeError("Telemetry complexity limit exceeded");
    this.charge(16);
    if (typeof value === "string") {
      this.charge(value.length * 2);
      return value;
    }
    if (
      value === null ||
      value === undefined ||
      typeof value === "boolean" ||
      typeof value === "number"
    )
      return value;
    if (typeof value !== "object") throw new TypeError("Unsupported telemetry value");
    if (utilTypes.isProxy(value)) throw new TypeError("Telemetry proxies are unsupported");
    if (this.ancestors.has(value)) throw new TypeError("Cyclic telemetry value");
    if (this.copied.has(value)) return this.copied.get(value) as T;
    if (utilTypes.isUint8Array(value)) {
      // Own accessors/subclasses cannot disguise the retained byte count.
      // A length-tracking SharedArrayBuffer view can grow on another thread
      // after charging: keep the destination fixed and reject growth during
      // the intrinsic copy instead of retaining an uncharged larger array.
      const length = typedArrayByteLength.call(value);
      this.charge(length);
      const copy = new Uint8Array(length);
      typedArraySet.call(copy, value);
      this.copied.set(value, copy);
      return copy as T;
    }
    const array = Array.isArray(value);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      throw new TypeError("Telemetry must contain data objects");
    const copy: unknown[] | Record<string, unknown> = array ? [] : Object.create(null);
    this.copied.set(value, copy);
    this.ancestors.add(value);
    if (array) {
      if (value.length > 16384) throw new RangeError("Telemetry complexity limit exceeded");
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (descriptor && !("value" in descriptor))
          throw new TypeError("Telemetry accessors are unsupported");
        (copy as unknown[]).push(this.copy(descriptor?.value, depth + 1));
      }
    } else {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor))
          throw new TypeError("Telemetry accessors are unsupported");
        this.charge(key.length * 2 + 16);
        (copy as Record<string, unknown>)[key] = this.copy(descriptor.value, depth + 1);
      }
    }
    this.ancestors.delete(value);
    return copy as T;
  }

  context(source: SpanContext | undefined): SpanContext | undefined {
    if (!source) return undefined;
    const { traceState, ...context } = this.copy({
      traceId: source.traceId,
      spanId: source.spanId,
      traceFlags: source.traceFlags,
      isRemote: source.isRemote,
      traceState: source.traceState?.serialize(),
    });
    return {
      ...context,
      ...(traceState !== undefined ? { traceState: createTraceState(traceState) } : {}),
    };
  }

  resource(source: Resource): Resource {
    // Do not retain a detector promise or its mutable resource graph. Later
    // records can include metadata once detection completes. The caller is
    // informed if this record omits unresolved resource attributes.
    this.unresolvedResource ||= source.asyncAttributesPending === true;
    const attributes: Resource["attributes"] = Object.create(null);
    const raw = source.getRawAttributes();
    if (raw.length > 16384) throw new RangeError("Resource complexity limit exceeded");
    for (const [key, value] of raw) {
      if (value && typeof (value as PromiseLike<unknown>).then === "function") {
        this.unresolvedResource = true;
        continue;
      }
      if (value == null || Object.hasOwn(attributes, key)) continue;
      this.charge(key.length * 2 + 16);
      attributes[key] = this.copy(value) as Resource["attributes"][string];
    }
    return resourceFromAttributes(attributes, { schemaUrl: this.copy(source.schemaUrl) });
  }
}

function contextReader(context: SpanContext): () => SpanContext {
  return () => context;
}

export function snapshotSpan(
  source: ReadableSpan,
  limit: number,
): { record: ReadableSpan; bytes: number; unresolvedResource: boolean } {
  const snapshot = new Snapshot(limit);
  const context = snapshot.context(source.spanContext())!;
  if (source.links.length > 16384) throw new RangeError("Link complexity limit exceeded");
  const links = source.links.map((link) => ({
    context: snapshot.context(link.context)!,
    attributes: snapshot.copy(link.attributes),
    droppedAttributesCount: snapshot.copy(link.droppedAttributesCount),
  }));
  const record: ReadableSpan = {
    ...snapshot.copy({
      name: source.name,
      kind: source.kind,
      startTime: source.startTime,
      endTime: source.endTime,
      duration: source.duration,
      ended: source.ended,
      status: source.status,
      attributes: source.attributes,
      events: source.events,
      instrumentationScope: source.instrumentationScope,
      droppedAttributesCount: source.droppedAttributesCount,
      droppedEventsCount: source.droppedEventsCount,
      droppedLinksCount: source.droppedLinksCount,
    }),
    spanContext: contextReader(context),
    parentSpanContext: snapshot.context(source.parentSpanContext),
    links,
    resource: snapshot.resource(source.resource),
  };
  return { record, bytes: snapshot.bytes, unresolvedResource: snapshot.unresolvedResource };
}

export function snapshotLog(
  source: ReadableLogRecord,
  limit: number,
): { record: ReadWriteLogRecord; bytes: number; unresolvedResource: boolean } {
  const snapshot = new Snapshot(limit);
  // Only our batching processor sees this copy. Its writer methods deliberately
  // cannot mutate the admitted snapshot or invalidate its charged byte count.
  const record: ReadWriteLogRecord = {
    ...snapshot.copy({
      hrTime: source.hrTime,
      hrTimeObserved: source.hrTimeObserved,
      severityText: source.severityText,
      severityNumber: source.severityNumber,
      eventName: source.eventName,
      body: source.body,
      attributes: source.attributes,
      instrumentationScope: source.instrumentationScope,
      droppedAttributesCount: source.droppedAttributesCount,
    }),
    spanContext: snapshot.context(source.spanContext),
    resource: snapshot.resource(source.resource),
    setAttribute() {
      return this;
    },
    setAttributes() {
      return this;
    },
    setBody() {
      return this;
    },
    setEventName() {
      return this;
    },
    setSeverityNumber() {
      return this;
    },
    setSeverityText() {
      return this;
    },
  };
  return { record, bytes: snapshot.bytes, unresolvedResource: snapshot.unresolvedResource };
}
