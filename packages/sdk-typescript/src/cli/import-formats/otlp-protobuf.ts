import * as zlib from "node:zlib";
import {
  ConversionError,
  isObject,
  OTLP_SPANS,
  OtlpTraceCollector,
  parseJsonText,
  type OtlpAttribute,
  type OtlpValue,
} from "../traces-import-convert.js";
import type { ImportAdapter } from "./adapter.js";
import { MIN_DAMAGED_BYTES, MIN_FRAME_BYTES, readZstd, type ParsedValue } from "./containers.js";

/**
 * Binary OTLP trace files: one protobuf `ExportTraceServiceRequest` (an OTLP/HTTP request body,
 * a `.pb` or `.binpb` file), and the OpenTelemetry Collector file exporter's length-prefixed
 * output (`format: proto`, or `compression: zstd`, each message preceded by its size as a 4-byte
 * big-endian integer). A zstd-compressed message is decompressed first; a message that is JSON
 * inside (`format: json` with `compression: zstd`) is read as OTLP/JSON. A collector file written
 * as one zstd stream is undone by the containers before this reads it.
 *
 * The reader below decodes the OTLP trace messages the files hold (opentelemetry-proto v1) into
 * their OTLP/JSON form, ids as hex and 64-bit integers as decimal text, and the spans are then
 * kept as recorded, exactly as an OTLP/JSON export's are. It is strict: a span with a field of the
 * wrong wire type, a truncated field or text that is not UTF-8 refuses its trace (the other traces
 * of the message are read), and damage outside any span makes the message unreadable, that message
 * alone reported. It is written here because the package carries no protobuf runtime.
 *
 * The messages of a length-prefixed file are read one at a time, and their decompressed sizes
 * together, those of messages that then do not read included, are bounded as one file's are, a
 * zstd message's frames counted as {@link readZstd} counts them.
 */

/** Marks a value decoded from protobuf: no JSON document can carry a symbol key. */
const PROTOBUF = Symbol("otlp-protobuf");
/** A decoded request and the spans of it that could not be read, by the trace they name. */
interface DecodedTraces {
  request: Record<string, unknown>;
  refused: { traceId?: string; reason: string }[];
}
type Decoded = { [PROTOBUF]: DecodedTraces };

const MAX_DEPTH = 64;
const utf8 = new TextDecoder("utf-8", { fatal: true });

class Reader {
  pos: number;
  constructor(
    readonly bytes: Uint8Array,
    start = 0,
    readonly end = bytes.byteLength,
  ) {
    this.pos = start;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  varint(): bigint {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (this.pos >= this.end) throw new ConversionError("a truncated protobuf varint");
      const byte = this.bytes[this.pos++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result & 0xffffffffffffffffn;
    }
    throw new ConversionError("a protobuf varint over ten bytes");
  }

  /** A varint that must fit a length or a small number. */
  small(): number {
    const value = this.varint();
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new ConversionError("a protobuf length too large");
    return Number(value);
  }

  fixed(size: 4 | 8): DataView {
    if (this.pos + size > this.end) throw new ConversionError("a truncated protobuf field");
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, size);
    this.pos += size;
    return view;
  }

  /** A length-delimited field as its own reader. */
  sub(): Reader {
    const length = this.small();
    if (this.pos + length > this.end) throw new ConversionError("a truncated protobuf field");
    const reader = new Reader(this.bytes, this.pos, this.pos + length);
    this.pos += length;
    return reader;
  }

  bytesField(): Uint8Array {
    const sub = this.sub();
    return this.bytes.subarray(sub.pos, sub.end);
  }

  text(): string {
    try {
      return utf8.decode(this.bytesField());
    } catch (error) {
      if (error instanceof ConversionError) throw error;
      throw new ConversionError("protobuf text that is not UTF-8");
    }
  }

  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.fixed(8);
    else if (wire === 2) this.sub();
    else if (wire === 5) this.fixed(4);
    else throw new ConversionError(`a protobuf field of wire type ${wire}`);
  }

  /** Reads every field, handing known field numbers to `read` with the wire type they require. */
  fields(read: Record<number, [wire: number, read: (reader: Reader) => void]>): void {
    while (!this.done) {
      const tag = this.small();
      const field = Math.floor(tag / 8);
      const wire = tag % 8;
      if (field === 0) throw new ConversionError("a protobuf field numbered zero");
      const known = read[field];
      if (!known) this.skip(wire);
      else if (known[0] !== wire)
        throw new ConversionError(`protobuf field ${field} of the wrong wire type`);
      else known[1](this);
    }
  }
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const signed = (value: bigint) =>
  (value >= 0x8000000000000000n ? value - 0x10000000000000000n : value).toString();

function anyValue(reader: Reader, depth: number): OtlpValue {
  if (depth > MAX_DEPTH) throw new ConversionError("protobuf values nested too deep");
  let value: OtlpValue = {};
  reader.fields({
    1: [2, (r) => (value = { stringValue: r.text() })],
    2: [0, (r) => (value = { boolValue: r.varint() !== 0n })],
    3: [0, (r) => (value = { intValue: signed(r.varint()) })],
    4: [
      1,
      (r) => {
        const double = r.fixed(8).getFloat64(0, true);
        // OTLP/JSON names NaN and the infinities, which JSON has no number for.
        value = { doubleValue: Number.isFinite(double) ? double : String(double) };
      },
    ],
    5: [
      2,
      (r) => {
        const values: OtlpValue[] = [];
        r.sub().fields({ 1: [2, (item) => values.push(anyValue(item.sub(), depth + 1))] });
        value = { arrayValue: { values } };
      },
    ],
    6: [
      2,
      (r) => {
        const values: OtlpAttribute[] = [];
        r.sub().fields({ 1: [2, (item) => values.push(keyValue(item.sub(), depth + 1))] });
        value = { kvlistValue: { values } };
      },
    ],
    7: [2, (r) => (value = { bytesValue: Buffer.from(r.bytesField()).toString("base64") })],
  });
  return value;
}

function keyValue(reader: Reader, depth = 0): OtlpAttribute {
  let key = "";
  let value: OtlpValue = {};
  reader.fields({
    1: [2, (r) => (key = r.text())],
    2: [2, (r) => (value = anyValue(r.sub(), depth + 1))],
  });
  return { key, value };
}

const attributeField = (into: OtlpAttribute[]): [number, (reader: Reader) => void] => [
  2,
  (r) => into.push(keyValue(r.sub())),
];

/** Reads fields into an object, leaving out fields the message did not hold, empty lists
 * included, as OTLP/JSON encoders do. */
function message(
  reader: Reader,
  read: (out: Record<string, unknown>) => Record<number, [number, (reader: Reader) => void]>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  reader.fields(read(out));
  for (const [key, value] of Object.entries(out))
    if (Array.isArray(value) && !value.length) delete out[key];
  return out;
}

const fixed64 = (r: Reader) => r.fixed(8).getBigUint64(0, true).toString();
const uint32 = (r: Reader) => Number(r.varint() & 0xffffffffn);

function attributesInto(out: Record<string, unknown>, field: string): OtlpAttribute[] {
  const list: OtlpAttribute[] = [];
  out[field] = list;
  return list;
}

function span(reader: Reader): Record<string, unknown> {
  return message(reader, (out) => {
    const attributes = attributesInto(out, "attributes");
    const events: unknown[] = [];
    const links: unknown[] = [];
    out.events = events;
    out.links = links;
    return {
      1: [2, (r) => (out.traceId = hex(r.bytesField()))],
      2: [2, (r) => (out.spanId = hex(r.bytesField()))],
      3: [2, (r) => (out.traceState = r.text())],
      4: [
        2,
        (r) => {
          const parent = hex(r.bytesField());
          if (parent) out.parentSpanId = parent;
        },
      ],
      5: [2, (r) => (out.name = r.text())],
      6: [0, (r) => (out.kind = uint32(r))],
      7: [1, (r) => (out.startTimeUnixNano = fixed64(r))],
      8: [1, (r) => (out.endTimeUnixNano = fixed64(r))],
      9: attributeField(attributes),
      10: [0, (r) => (out.droppedAttributesCount = uint32(r))],
      11: [
        2,
        (r) =>
          events.push(
            message(r.sub(), (event) => {
              const list = attributesInto(event, "attributes");
              return {
                1: [1, (item) => (event.timeUnixNano = fixed64(item))],
                2: [2, (item) => (event.name = item.text())],
                3: attributeField(list),
                4: [0, (item) => (event.droppedAttributesCount = uint32(item))],
              };
            }),
          ),
      ],
      12: [0, (r) => (out.droppedEventsCount = uint32(r))],
      13: [
        2,
        (r) =>
          links.push(
            message(r.sub(), (link) => {
              const list = attributesInto(link, "attributes");
              return {
                1: [2, (item) => (link.traceId = hex(item.bytesField()))],
                2: [2, (item) => (link.spanId = hex(item.bytesField()))],
                3: [2, (item) => (link.traceState = item.text())],
                4: attributeField(list),
                5: [0, (item) => (link.droppedAttributesCount = uint32(item))],
                6: [5, (item) => (link.flags = item.fixed(4).getUint32(0, true))],
              };
            }),
          ),
      ],
      14: [0, (r) => (out.droppedLinksCount = uint32(r))],
      15: [
        2,
        (r) =>
          (out.status = message(r.sub(), (status) => ({
            2: [2, (item) => (status.message = item.text())],
            3: [0, (item) => (status.code = uint32(item))],
          }))),
      ],
      16: [5, (r) => (out.flags = r.fixed(4).getUint32(0, true))],
    };
  });
}

/** A span the message holds, or why it cannot be read and the trace it names when its trace id
 * was read before the damage. */
function readSpan(
  reader: Reader,
  index: number,
  refused: DecodedTraces["refused"],
): Record<string, unknown> | undefined {
  const start = reader.pos;
  try {
    return span(reader);
  } catch (error) {
    if (!(error instanceof ConversionError)) throw error;
    let traceId: string | undefined;
    try {
      new Reader(reader.bytes, start, reader.end).fields({
        1: [2, (field) => (traceId ??= hex(field.bytesField()))],
      });
    } catch {
      // The trace id came before the damage, or the span names none.
    }
    refused.push({
      ...(traceId ? { traceId } : {}),
      reason: `span ${index} is not an OTLP span: ${error.message}`,
    });
    return undefined;
  }
}

/** A `TracesData` or `ExportTraceServiceRequest` (the same fields) as OTLP/JSON, with the spans
 * that could not be read. */
export function decodeTraces(bytes: Uint8Array): DecodedTraces {
  const resourceSpans: unknown[] = [];
  const refused: DecodedTraces["refused"] = [];
  let spanCount = 0;
  new Reader(bytes).fields({
    1: [
      2,
      (r) =>
        resourceSpans.push(
          message(r.sub(), (group) => {
            const scopeSpans: unknown[] = [];
            group.scopeSpans = scopeSpans;
            return {
              1: [
                2,
                (item) =>
                  (group.resource = message(item.sub(), (resource) => {
                    const list = attributesInto(resource, "attributes");
                    return {
                      1: attributeField(list),
                      2: [0, (value) => (resource.droppedAttributesCount = uint32(value))],
                    };
                  })),
              ],
              2: [
                2,
                (item) =>
                  scopeSpans.push(
                    message(item.sub(), (scopeGroup) => {
                      const spans: unknown[] = [];
                      scopeGroup.spans = spans;
                      return {
                        1: [
                          2,
                          (value) =>
                            (scopeGroup.scope = message(value.sub(), (scope) => {
                              const list = attributesInto(scope, "attributes");
                              return {
                                1: [2, (field) => (scope.name = field.text())],
                                2: [2, (field) => (scope.version = field.text())],
                                3: attributeField(list),
                                4: [0, (field) => (scope.droppedAttributesCount = uint32(field))],
                              };
                            })),
                        ],
                        2: [
                          2,
                          (value) => {
                            const read = readSpan(value.sub(), ++spanCount, refused);
                            if (read) spans.push(read);
                          },
                        ],
                        3: [2, (value) => (scopeGroup.schemaUrl = value.text())],
                      };
                    }),
                  ),
              ],
              3: [2, (item) => (group.schemaUrl = item.text())],
            };
          }),
        ),
    ],
  });
  return { request: { resourceSpans }, refused };
}

const ZSTD = [0x28, 0xb5, 0x2f, 0xfd];
const isZstd = (bytes: Uint8Array) => ZSTD.every((byte, index) => bytes[index] === byte);

/** Whether bytes cannot be JSON text: JSON holds no raw control character but tab, line feed
 * and carriage return, while protobuf ids, timestamps and length prefixes are full of them. */
function binary(bytes: Uint8Array): boolean {
  for (const byte of bytes)
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return true;
  return false;
}

/** A decoded request as a value; its JSON text is made only when a format asks for it. */
function decoded(traces: DecodedTraces, line?: number, note?: string): ParsedValue {
  let text: string | undefined;
  return {
    value: { [PROTOBUF]: traces } satisfies Decoded,
    get text() {
      return (text ??= JSON.stringify(traces.request));
    },
    unsafeIntegers: false,
    ...(line !== undefined ? { line } : {}),
    ...(note ? { note } : {}),
  };
}

/** One length-prefixed message's bytes, a zstd message decompressed frame by frame (see
 * {@link readZstd}), with what it counts against the bound and a note on bytes after its frames.
 * `room` is what the file's messages may still decompress to, and `budget` what they may still
 * count. */
function frameBytes(
  frame: Uint8Array,
  room: number,
  budget: number,
): { bytes: Uint8Array; counted: number; note?: string } {
  if (!isZstd(frame)) {
    if (frame.byteLength > Math.min(room, budget)) throw new Oversized(frame.byteLength > room);
    return { bytes: frame, counted: frame.byteLength };
  }
  if (typeof zlib.zstdDecompressSync !== "function")
    throw new ConversionError(
      "a zstd message, which this Node.js cannot decompress (Node.js 22.15 or later can)",
    );
  const read = readZstd(frame, Math.max(0, room), Math.max(0, budget));
  if (read.kind === "oversized") throw new Oversized(read.content);
  // Bytes after a message's frames (zero padding) are named and its frames read, as a zstd file's
  // are; a frame that breaks off or does not decompress whole damages the message, which counts
  // what its frames did.
  if (read.kind === "mismatched") throw new DamagedZstd(read.held, read.size);
  if (read.stop && (read.stop !== "trailing" || !read.frames))
    throw new DamagedZstd(read.bytes.byteLength, read.size);
  return {
    bytes: read.bytes,
    counted: read.size,
    ...(read.stop
      ? {
          note: `${frame.byteLength - read.end} bytes after the message's last zstd frame are not zstd and were not read`,
        }
      : {}),
  };
}

/** One message read: protobuf, or OTLP/JSON that a zstd message held. */
function messageValue(bytes: Uint8Array, zstd: boolean, line: number, note?: string): ParsedValue {
  if (
    zstd &&
    !binary(bytes) &&
    /^\s*\{/.test(Buffer.from(bytes.subarray(0, 64)).toString("utf8"))
  ) {
    let text: string;
    try {
      text = utf8.decode(bytes);
    } catch {
      throw new ConversionError("a JSON message that is not UTF-8");
    }
    try {
      const parsed = parseJsonText(text.trim());
      return {
        value: parsed.value,
        text,
        unsafeIntegers: parsed.unsafeIntegers,
        line,
        ...(note ? { note } : {}),
      };
    } catch {
      throw new ConversionError("a message that is not JSON");
    }
  }
  return decoded(decodeTraces(bytes), line, note);
}

/** The file's messages together decompress past the bound of one file (`content`), or count past
 * it though they decompress to less. */
class Oversized extends Error {
  constructor(readonly content: boolean) {
    super();
  }
}

/** A damaged zstd message: what its frames decompressed to, and what they count against the bound,
 * the damaged one included (see {@link readZstd}). */
class DamagedZstd extends ConversionError {
  constructor(
    readonly held: number,
    readonly counted: number,
  ) {
    super("a damaged zstd message");
  }
}

/** The values of a binary OTLP file, read one at a time; the messages that could not be read are
 * added to `problems` as they are met. `bytes` grows to what the file decompressed to, and
 * `counted` to what that counts against the bound, each zstd frame at least {@link MIN_FRAME_BYTES}
 * and a damaged one at least {@link MIN_DAMAGED_BYTES}. */
export interface BinaryValues {
  values: Iterable<ParsedValue>;
  problems: { line: number; reason: string }[];
  bytes: () => number;
  counted: () => number;
}

/**
 * The values of a binary OTLP file; undefined when the content is not binary or holds neither
 * form, so that it is read as text; or why a binary OTLP request cannot be read. In a
 * length-prefixed file each message is one value, its 1-based position given as its line; a
 * message that cannot be read is reported with that position and the rest are read, until the
 * messages together decompress to more than `maxBytes`.
 */
export function binaryValues(
  bytes: Uint8Array,
  maxBytes: number,
): BinaryValues | { unsupported: string } | undefined {
  if (!binary(bytes)) return undefined;
  let requestError: string | undefined;
  if (bytes[0] === 0x0a)
    try {
      const value = decoded(decodeTraces(bytes));
      const size = () => bytes.byteLength;
      return { values: [value], problems: [], bytes: size, counted: size };
    } catch (error) {
      if (!(error instanceof ConversionError)) throw error;
      // Not one message: perhaps length-prefixed messages.
      requestError = error.message;
    }
  const frames: Uint8Array[] = [];
  let pos = 0;
  let truncated = false;
  while (pos < bytes.byteLength) {
    if (pos + 4 > bytes.byteLength) {
      truncated = true;
      break;
    }
    const length = new DataView(bytes.buffer, bytes.byteOffset + pos, 4).getUint32(0, false);
    if (pos + 4 + length > bytes.byteLength) {
      truncated = true;
      break;
    }
    frames.push(bytes.subarray(pos + 4, pos + 4 + length));
    pos += 4 + length;
  }
  if (!frames.length)
    return requestError === undefined
      ? undefined
      : { unsupported: `not an OTLP trace request: ${requestError}` };
  const problems: BinaryValues["problems"] = [];
  /** What the messages read decompressed to, and what that counts against the bound. */
  let held = 0;
  let total = 0;
  function* values(): Generator<ParsedValue> {
    for (const [index, frame] of frames.entries()) {
      // A message counts what it decompressed to, whether or not it then reads.
      let kept = frame.byteLength;
      let size = frame.byteLength;
      try {
        const read = frameBytes(frame, maxBytes - held, maxBytes - total);
        kept = read.bytes.byteLength;
        size = read.counted;
        const value = messageValue(read.bytes, isZstd(frame), index + 1, read.note);
        held += kept;
        total += size;
        yield value;
      } catch (error) {
        if (error instanceof Oversized) {
          // The file counts past the bound, as one that is not read does (see decodeContainer).
          if (error.content) held = maxBytes + 1;
          total = maxBytes + 1;
          const rest = `this message and the ${frames.length - index - 1} after it were not read`;
          problems.push({
            line: index + 1,
            reason: error.content
              ? `the messages decompress to more than ${maxBytes} bytes; ${rest}`
              : `the messages count for more than ${maxBytes} bytes, each zstd frame at least ${MIN_FRAME_BYTES} and a damaged one at least ${MIN_DAMAGED_BYTES}; ${rest}`,
          });
          return;
        }
        if (!(error instanceof ConversionError)) throw error;
        if (error instanceof DamagedZstd) {
          kept = Math.max(kept, error.held);
          size = Math.max(size, error.counted);
        }
        held += kept;
        total += size;
        problems.push({ line: index + 1, reason: `not an OTLP trace message: ${error.message}` });
      }
    }
    if (truncated)
      problems.push({ line: frames.length + 1, reason: "a truncated length-prefixed message" });
  }
  return {
    values: values(),
    problems,
    bytes: () => Math.max(held, bytes.byteLength),
    counted: () => Math.max(total, held, bytes.byteLength),
  };
}

export const otlpProtobuf: ImportAdapter = {
  id: "otlp_protobuf",
  manifestFormat: "otlp_json",
  detect: (value) => isObject(value) && PROTOBUF in value,
  convert(value, context) {
    const traces = isObject(value) && PROTOBUF in value ? (value as Decoded)[PROTOBUF] : undefined;
    if (!traces) return;
    const collector = context.collector(() => new OtlpTraceCollector(), OTLP_SPANS);
    // A span that could not be decoded refuses its trace, as a malformed OTLP/JSON span does.
    for (const problem of traces.refused) {
      const refusal = collector.refuse(problem.traceId, problem.reason);
      context.refuse(refusal.reason, refusal.traceId);
    }
    for (const refusal of collector.add([traces.request], context.source.digest, otlpProtobuf.id))
      context.refuse(refusal.reason, refusal.traceId);
  },
};
