import { createTraceState, type SpanContext } from "@opentelemetry/api";
import { types as utilTypes } from "node:util";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import type { ReadableLogRecord, ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import {
  hashInlineFiles,
  INLINE_FILE_LIMIT,
  INLINE_FILE_TEXT_PER_RECORD,
  isMessageKey,
} from "./inline-files.js";
import { scrubsToolCredentials, scrubToolCredentials } from "./tool-definitions.js";
import { MAX_RECORD_NODES } from "./config.js";
import { truncatedMarker } from "./privacy.js";
import { MAX_BLOB_BYTES } from "./blobs.js";

// Intrinsic accessors are captured once and invoked with an explicit receiver so a
// hostile object cannot override them; the unbound reference is the point.
// eslint-disable-next-line @typescript-eslint/unbound-method
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)!.get!;
// eslint-disable-next-line @typescript-eslint/unbound-method
const typedArraySet = Uint8Array.prototype.set;

/** What a copied value is: attribute maps and the attributes of span events (an event's
 * `attributes`) get inline files hashed before they are charged. */
type Shape = "value" | "attributes" | "event";

/** `value` cut to at most `units` UTF-16 code units, never between the halves of a pair. */
function cutToUnits(value: string, units: number): string {
  if (value.length <= units) return value;
  const end = /[\uD800-\uDBFF]/.test(value[units - 1] ?? "") ? units - 1 : units;
  // A slice can keep the whole original string alive; the copy holds only what is kept.
  return Buffer.from(value.slice(0, end), "utf16le").toString("utf16le");
}

/** The record's byte or value budget ran out: a span's events and links past it are left out and
 * counted as dropped, where anything else loses the record. */
class BudgetExceeded extends RangeError {}

/**
 * How a span's own values over the receiver's value cap are held whole for export to upload:
 * the cap, the bytes the held-value budget has left, and whether nothing else is held (a single
 * value larger than the whole budget is held then). A string is charged two bytes a code unit,
 * bytes as themselves. The queue's byte budget is charged what the value would have cost cut
 * when queued, so a value whose upload fails is exported cut exactly as before.
 */
export interface HoldLimits {
  valueBytes: number;
  budget: number;
  first: boolean;
}

/** Where a copy stood before one event or link, to return to when the budget cannot hold it. */
interface Mark {
  bytes: number;
  nodes: number;
  copied: number;
}

/** Copies only exported data, with the same finite budget used for admission. */
class Snapshot {
  bytes = 512;
  unresolvedResource = false;
  /** The value strings this snapshot cut to `valueUnits`; export recognizes them, so the
   * redactor's answer for one loses the end the redactor saw without its continuation. */
  readonly cut = new Set<string>();
  private nodes = 0;
  private ancestors = new Set<object>();
  private copied = new Map<object, unknown>();
  private hashed = new Map<string, unknown>();
  private inspected = 0;
  /** Bytes of values held whole for upload, charged to the held-value budget. */
  held = 0;
  /** Set while the span's own attributes are copied: only they may be held for upload. */
  private own = false;
  /** The span's own messages whose large inline files shrank to their digest when queued, as
   * queued (cut or not), and how many files each lost. */
  digested = new Map<string, number>();
  /** How many files each message text {@link inlineFiles} hashed replaced by their digest. */
  private hashedFiles = new Map<string, number>();

  /**
   * In metadata-only mode the recorded messages, which export strips, are not copied at all. A
   * value string (an attribute's, an event's or link's attribute's, a log body or a status
   * message) longer than `valueUnits` is cut to that length: export cuts it to the value cap
   * anyway, and charging it whole could drop the record before that cut ever ran.
   */
  constructor(
    private limit: number,
    private captureContent = true,
    private valueUnits = Infinity,
    private hold?: HoldLimits,
  ) {}

  /** Whether the held-value budget takes `bytes` more, charging them when it does. */
  private holds(bytes: number): boolean {
    const hold = this.hold!;
    if (this.held + bytes > hold.budget && !(hold.first && this.held === 0)) return false;
    this.held += bytes;
    return true;
  }

  /**
   * One of the span's own attribute values held whole for export to upload, when it may be: text
   * longer than the queued value length or bytes over the cap, within the held-value budget, and
   * a recorded message that may inline a large file kept as it is (export uploads the file).
   * Undefined for a value copied as before; text over the length the budget cannot hold is then
   * cut and its large inline files shrink to their digest, as before uploads existed.
   */
  private heldValue(key: string, value: unknown): { value: unknown } | undefined {
    if (!this.hold || !this.own) return undefined;
    if (typeof value === "string") {
      if (value.length > this.valueUnits) {
        // The queue must take the cut the value falls back to, as it would have taken it before.
        const fallback = this.valueUnits * 2 + 16;
        if (this.bytes + fallback > this.limit || !this.holds(value.length * 2)) return undefined;
        this.charge(fallback);
        return { value };
      }
      // Within the queued length: a recorded message holding a large inline file is held whole
      // for export to upload the file, within the held-value budget, and the queue is charged
      // its copy with the files as their digest, as before. Past the budget, the files shrink to
      // their digest when queued, as before uploads existed.
      if (!isMessageKey(key)) return undefined;
      const digested = this.inlineFiles(key, value);
      if (digested === value || !this.holds(value.length * 2)) return undefined;
      this.copy(digested, 1, "value", true);
      return { value };
    }
    if (!utilTypes.isUint8Array(value)) return undefined;
    const length = typedArrayByteLength.call(value);
    // Bytes over Hue's upload limit could only be exported cut: not copied whole for that.
    if (length <= this.hold.valueBytes || length > MAX_BLOB_BYTES || !this.holds(length))
      return undefined;
    this.charge(16);
    // Copied, so a later change by the application cannot alter what was recorded; charged to
    // the held-value budget instead of the queue's.
    const copy = new Uint8Array(length);
    typedArraySet.call(copy, value);
    return { value: copy };
  }

  private charge(bytes: number): void {
    this.bytes += bytes;
    if (this.bytes > this.limit) throw new BudgetExceeded("Telemetry byte budget exceeded");
  }

  private mark(): Mark {
    return { bytes: this.bytes, nodes: this.nodes, copied: this.copied.size };
  }

  /** Back to `mark`, forgetting the values copied since: a later copy must not reuse a partial
   * copy of an item that was left out. */
  private restore(mark: Mark): void {
    this.bytes = mark.bytes;
    this.nodes = mark.nodes;
    this.ancestors.clear();
    let index = 0;
    for (const key of [...this.copied.keys()]) if (index++ >= mark.copied) this.copied.delete(key);
  }

  /**
   * As many of a span's newest `items` (its events or links) as the record's budget still holds,
   * each copied by `copyItem`, and how many older ones it could not hold, as OpenTelemetry keeps a
   * span's newest events and links past its own count limits. A span whose events or links
   * outgrow the budget keeps its name, timing, attributes and the rest of them, counting the ones
   * left out as dropped, instead of being lost whole.
   */
  newest<U>(items: unknown, copyItem: (item: unknown) => U): { kept: U[]; dropped: number } {
    if (!Array.isArray(items) || utilTypes.isProxy(items))
      throw new TypeError("Telemetry must contain data objects");
    const count = items.length;
    const kept: U[] = [];
    for (let index = count - 1; index >= 0; index--) {
      const descriptor = Object.getOwnPropertyDescriptor(items, index);
      if (descriptor && !("value" in descriptor))
        throw new TypeError("Telemetry accessors are unsupported");
      const mark = this.mark();
      try {
        kept.push(copyItem(descriptor?.value));
      } catch (error) {
        if (!(error instanceof BudgetExceeded)) throw error;
        this.restore(mark);
        break;
      }
    }
    kept.reverse();
    return { kept, dropped: count - kept.length };
  }

  /**
   * An attribute map. A large inline file in a message attribute shrinks to its digest before it
   * is charged: export replaces it anyway, and charging the file could drop the whole record.
   */
  attributes<T>(value: T): T {
    return this.copy(value, 1, "attributes");
  }

  /** The span's own attribute map, whose values over the cap may be held whole for upload. */
  ownAttributes<T>(value: T): T {
    this.own = true;
    try {
      return this.attributes(value);
    } finally {
      this.own = false;
    }
  }

  /** A message attribute with its large inline files hashed. The same text is hashed once per
   * record, and a record inspects at most {@link INLINE_FILE_TEXT_PER_RECORD} of it in all;
   * beyond that, messages are charged as recorded. */
  private inlineFiles(key: string, value: unknown): unknown {
    // A UTF-16 unit is at most three UTF-8 bytes, so shorter text cannot hold a file to hash.
    if (typeof value !== "string" || !isMessageKey(key) || value.length * 3 <= INLINE_FILE_LIMIT)
      return value;
    if (this.hashed.has(value)) return this.hashed.get(value);
    if (this.inspected + value.length > INLINE_FILE_TEXT_PER_RECORD) return value;
    this.inspected += value.length;
    const count = { files: 0 };
    const result = hashInlineFiles(key, value, count);
    this.hashed.set(value, result);
    if (count.files) this.hashedFiles.set(value, count.files);
    return result;
  }

  /**
   * An attribute whose value will be cut and whose credentials export removes (tool definitions
   * and recorded requests) has them removed first, from the whole value: a cut prefix no longer
   * parses, so export could not find them in it. A value longer than what the record's budget has
   * left is not parsed on the application's thread at all: the receiver's marker replaces it, as
   * in the Python SDK, rather than a cut that could hold credentials.
   */
  private scrubbedBeforeCut(key: string, value: unknown): unknown {
    if (this.valueUnits === Infinity || !scrubsToolCredentials(key)) return value;
    const scrubbed = (units: number, scrub: () => unknown, bytes: () => number) =>
      units * 2 > this.limit - this.bytes ? truncatedMarker(bytes()) : scrub();
    if (typeof value === "string")
      return value.length > this.valueUnits
        ? scrubbed(
            value.length,
            () => scrubToolCredentials(key, value),
            () => Buffer.byteLength(value),
          )
        : value;
    // A list of definitions (AI SDK 6 `ai.prompt.tools`), read through its own data properties;
    // anything else is left for the copy to accept or refuse.
    if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length > MAX_RECORD_NODES)
      return value;
    const items: unknown[] = [];
    let long = false;
    let units = 0;
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor && !("value" in descriptor)) return value;
      const item: unknown = descriptor?.value;
      if (typeof item === "string") {
        units += item.length;
        if (item.length > this.valueUnits) long = true;
      }
      items.push(item);
    }
    return long
      ? scrubbed(
          units,
          () => scrubToolCredentials(key, items),
          () =>
            items.reduce<number>(
              (total, item) => total + (typeof item === "string" ? Buffer.byteLength(item) : 0),
              0,
            ),
        )
      : value;
  }

  /** A value whose strings are cut to the queued value length: a log body or a status. */
  value<T>(value: T, depth = 1): T {
    return this.copy(value, depth, "value", true);
  }

  copy<T>(value: T, depth = 0, shape: Shape = "value", content = false): T {
    if (++this.nodes > MAX_RECORD_NODES)
      throw new BudgetExceeded("Telemetry complexity limit exceeded");
    if (depth > 32) throw new RangeError("Telemetry nesting limit exceeded");
    this.charge(16);
    if (typeof value === "string") {
      let text: string = value;
      if (content && text.length > this.valueUnits) {
        text = cutToUnits(text, this.valueUnits);
        this.cut.add(text);
      }
      this.charge(text.length * 2);
      return text as T;
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
      if (value.length > MAX_RECORD_NODES)
        throw new BudgetExceeded("Telemetry complexity limit exceeded");
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (descriptor && !("value" in descriptor))
          throw new TypeError("Telemetry accessors are unsupported");
        (copy as unknown[]).push(
          this.copy(descriptor?.value, depth + 1, "value", content || shape === "attributes"),
        );
      }
    } else {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor))
          throw new TypeError("Telemetry accessors are unsupported");
        if (shape === "attributes" && !this.captureContent && isMessageKey(key)) continue;
        this.charge(key.length * 2 + 16);
        const held = shape === "attributes" ? this.heldValue(key, descriptor.value) : undefined;
        if (held) {
          (copy as Record<string, unknown>)[key] = held.value;
          continue;
        }
        const source: unknown = descriptor.value;
        const copied = this.copy(
          shape === "attributes"
            ? this.scrubbedBeforeCut(key, this.inlineFiles(key, source))
            : source,
          depth + 1,
          shape === "event" && key === "attributes" ? "attributes" : "value",
          content || shape === "attributes",
        );
        (copy as Record<string, unknown>)[key] = copied;
        // A span's own message whose large inline files shrank to their digest is named as it
        // was queued, cut or not, so export reports each file as not uploaded.
        const files =
          this.own && shape === "attributes" && typeof source === "string"
            ? this.hashedFiles.get(source)
            : undefined;
        if (files && typeof copied === "string") this.digested.set(copied, files);
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
      attributes[key] = this.copy(
        this.scrubbedBeforeCut(key, value),
        0,
        "value",
        true,
      ) as Resource["attributes"][string];
    }
    return resourceFromAttributes(attributes, { schemaUrl: this.copy(source.schemaUrl) });
  }
}

function contextReader(context: SpanContext): () => SpanContext {
  return () => context;
}

/** What admission keeps of a record: its copy, the bytes charged for it, whether resource
 * attributes were still unresolved, the value strings it cut, the bytes of the values it held
 * whole for upload, and the span's own messages whose large inline files it shrank to their
 * digest (with how many files each). */
export interface RecordSnapshot<T> {
  record: T;
  bytes: number;
  unresolvedResource: boolean;
  cut: ReadonlySet<string>;
  held: number;
  digested: ReadonlyMap<string, number>;
}

export function snapshotSpan(
  source: ReadableSpan,
  limit: number,
  captureContent = true,
  valueUnits = Infinity,
  hold?: HoldLimits,
): RecordSnapshot<ReadableSpan> {
  const snapshot = new Snapshot(limit, captureContent, valueUnits, hold);
  const context = snapshot.context(source.spanContext())!;
  const fields = snapshot.copy({
    name: source.name,
    kind: source.kind,
    startTime: source.startTime,
    endTime: source.endTime,
    duration: source.duration,
    ended: source.ended,
    instrumentationScope: source.instrumentationScope,
    droppedAttributesCount: source.droppedAttributesCount,
    droppedEventsCount: source.droppedEventsCount,
    droppedLinksCount: source.droppedLinksCount,
  });
  const status = snapshot.value(source.status);
  const attributes = snapshot.ownAttributes(source.attributes);
  const parentSpanContext = snapshot.context(source.parentSpanContext);
  const resource = snapshot.resource(source.resource);
  // Last, with what the budget has left: past it, events and links are counted as dropped.
  const events = snapshot.newest(source.events, (event) =>
    snapshot.copy(event as ReadableSpan["events"][number], 2, "event"),
  );
  const links = snapshot.newest(source.links, (item) => {
    const link = item as ReadableSpan["links"][number];
    return {
      context: snapshot.context(link.context)!,
      attributes: snapshot.attributes(link.attributes),
      droppedAttributesCount: snapshot.copy(link.droppedAttributesCount),
    };
  });
  const record: ReadableSpan = {
    ...fields,
    droppedEventsCount: (fields.droppedEventsCount ?? 0) + events.dropped,
    droppedLinksCount: (fields.droppedLinksCount ?? 0) + links.dropped,
    status,
    attributes,
    events: events.kept,
    spanContext: contextReader(context),
    parentSpanContext,
    links: links.kept,
    resource,
  };
  return {
    record,
    bytes: snapshot.bytes,
    unresolvedResource: snapshot.unresolvedResource,
    cut: snapshot.cut,
    held: snapshot.held,
    digested: snapshot.digested,
  };
}

export function snapshotLog(
  source: ReadableLogRecord,
  limit: number,
  captureContent = true,
  valueUnits = Infinity,
): RecordSnapshot<ReadWriteLogRecord> {
  const snapshot = new Snapshot(limit, captureContent, valueUnits);
  // Only our batching processor sees this copy. Its writer methods deliberately
  // cannot mutate the admitted snapshot or invalidate its charged byte count.
  const record: ReadWriteLogRecord = {
    ...snapshot.copy({
      hrTime: source.hrTime,
      hrTimeObserved: source.hrTimeObserved,
      severityText: source.severityText,
      severityNumber: source.severityNumber,
      eventName: source.eventName,
      instrumentationScope: source.instrumentationScope,
      droppedAttributesCount: source.droppedAttributesCount,
    }),
    body: snapshot.value(source.body),
    attributes: snapshot.attributes(source.attributes),
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
  return {
    record,
    bytes: snapshot.bytes,
    unresolvedResource: snapshot.unresolvedResource,
    cut: snapshot.cut,
    held: 0,
    digested: new Map(),
  };
}
