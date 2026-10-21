import {
  anyValue,
  ConversionError,
  isObject,
  unixNano,
  type JsonValue,
  type OtlpAttribute,
  type OtlpValue,
} from "../traces-import-convert.js";
import type { ConvertContext, ImportAdapter } from "./adapter.js";
import { otelTraceKey, OtelSpanCollector, unsigned, type OtelSpan } from "./otel-spans.js";
import { readRecords } from "./rows.js";

/**
 * Arize Phoenix's span exports (Phoenix REST API, `schemas/openapi.json`). Phoenix stores the
 * OpenInference attributes its instrumentations record, which Hue reads as they are, so each
 * span is converted to the OTLP span it was with its attributes kept. Phoenix keeps no resource,
 * scope or span kind, so the spans carry none beyond what the attributes hold, and every span is
 * an internal one.
 *
 * - `phoenix_otlp`: `GET /v1/projects/{project}/spans/otlpv1`, `{"data": [OtlpSpan],
 *   "next_cursor": …}`, OTLP spans in proto field names with hex or base64 ids; and one such span
 *   per line.
 * - `phoenix_spans`: `GET /v1/projects/{project}/spans` (and the body `POST` takes),
 *   `{"data": [{context: {trace_id, span_id}, parent_id, name, span_kind, start_time, end_time,
 *   status_code, status_message, attributes, events}], "next_cursor": …}`, attributes flattened
 *   to dotted keys and `openinference.span.kind` lifted out as `span_kind`, which is put back.
 */

type Json = Record<string, JsonValue>;
const object = (value: unknown): Json | undefined =>
  isObject(value) ? (value as Json) : undefined;
const text = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" && value ? value : undefined;

/** A page's records, or the value itself when it is one record. */
function recordsOf(value: unknown, isRecord: (value: unknown) => boolean): unknown[] | undefined {
  if (isRecord(value)) return [value];
  const page = object(value);
  return page && Array.isArray(page.data) && page.data.some(isRecord) ? page.data : undefined;
}

/** An OTLP id as hex: hex as recorded, or the base64 the OTLP JSON mapping allows; any other
 * text is kept and mapped by SHA-256. */
function hexId(value: string, bytes: 16 | 8): string {
  if (new RegExp(`^[0-9a-f]{${bytes * 2}}$`, "i").test(value)) return value.toLowerCase();
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    const decoded = Buffer.from(value, "base64");
    if (decoded.byteLength === bytes && decoded.toString("base64") === value)
      return decoded.toString("hex");
  }
  return value;
}

/** A nanosecond instant: absent when null, refused when malformed or zero. */
function nanos(value: JsonValue | undefined, what: string): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  const count = unsigned(value);
  if (!count) throw new ConversionError(`${what} is not a nanosecond instant`);
  return count;
}

const KINDS: Record<string, number> = {
  SPAN_KIND_UNSPECIFIED: 0,
  SPAN_KIND_INTERNAL: 1,
  SPAN_KIND_SERVER: 2,
  SPAN_KIND_CLIENT: 3,
  SPAN_KIND_PRODUCER: 4,
  SPAN_KIND_CONSUMER: 5,
};
const STATUS: Record<string, number> = { UNSET: 0, OK: 1, ERROR: 2 };

/** An `OtlpAnyValue` in proto field names as OTLP/JSON. A dictionary, which Phoenix writes as an
 * empty value, stays empty. */
function anyValueOf(raw: JsonValue | undefined): OtlpValue {
  const value = object(raw);
  if (raw === undefined || raw === null) return {};
  if (!value) throw new ConversionError("an attribute value that is not an object");
  if (typeof value.string_value === "string") return { stringValue: value.string_value };
  if (typeof value.bool_value === "boolean") return { boolValue: value.bool_value };
  if (value.int_value !== undefined && value.int_value !== null) {
    const integer = value.int_value;
    if (typeof integer === "number" && Number.isSafeInteger(integer))
      return { intValue: String(integer) };
    if (typeof integer === "string" && /^-?\d+$/.test(integer)) return { intValue: integer };
    throw new ConversionError("an int_value that is not an integer");
  }
  if (typeof value.double_value === "number") return { doubleValue: value.double_value };
  if (typeof value.double_value === "string") {
    // An infinite or undefined double, which Phoenix writes as Python prints it, is kept as its
    // text: OTLP/JSON has no number for it.
    if (!/^-?(?:inf|infinity|nan)$/i.test(value.double_value))
      throw new ConversionError("a double_value that is not a number");
    return { stringValue: value.double_value };
  }
  if (typeof value.bytes_value === "string") return { bytesValue: value.bytes_value };
  const array = object(value.array_value);
  if (array) {
    const values = array.values ?? [];
    if (!Array.isArray(values)) throw new ConversionError("an array_value without values");
    return { arrayValue: { values: values.map(anyValueOf) } };
  }
  return {};
}

function keyValues(raw: JsonValue | undefined): OtlpAttribute[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ConversionError("attributes is not a list");
  return raw.map((item) => {
    const pair = object(item);
    if (!pair || typeof pair.key !== "string")
      throw new ConversionError("an attribute without a key");
    return { key: pair.key, value: anyValueOf(pair.value) };
  });
}

const isOtlpSpan = (value: unknown): value is Json =>
  isObject(value) &&
  typeof value.trace_id === "string" &&
  typeof value.span_id === "string" &&
  ("start_time_unix_nano" in value || "end_time_unix_nano" in value) &&
  !("context" in value) &&
  !("root_span_id" in value);

function readOtlpSpan(span: Json): OtelSpan {
  const { trace_id: rawTraceId, span_id: rawSpanId } = span;
  if (!isOtlpSpan(span) || typeof rawTraceId !== "string" || typeof rawSpanId !== "string")
    throw new ConversionError("a record that is not a Phoenix OTLP span");
  const traceId = hexId(rawTraceId, 16);
  const parent = text(span.parent_span_id);
  const kind = span.kind;
  const status = object(span.status);
  const code = status?.code;
  const message = text(status?.message);
  const start = nanos(span.start_time_unix_nano, "start_time_unix_nano");
  const end = nanos(span.end_time_unix_nano, "end_time_unix_nano");
  const events = span.events ?? [];
  if (!Array.isArray(events)) throw new ConversionError("events is not a list");
  const flags = unsigned(span.flags);
  const dropped = unsigned(span.dropped_attributes_count);
  return {
    traceId,
    spanKey: hexId(rawSpanId, 8),
    ...(parent ? { parentKey: hexId(parent, 8) } : {}),
    name: text(span.name) ?? "",
    kind:
      typeof kind === "number" && Number.isInteger(kind) && kind >= 0 && kind <= 5
        ? kind
        : typeof kind === "string"
          ? (KINDS[kind] ?? 1)
          : 1,
    ...(text(span.trace_state) ? { traceState: text(span.trace_state)! } : {}),
    ...(flags !== undefined && flags <= 0xffffffffn ? { flags: Number(flags) } : {}),
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
    attributes: keyValues(span.attributes),
    ...(dropped ? { droppedAttributesCount: Number(dropped) } : {}),
    events: events.map((item) => {
      const event = object(item);
      if (!event) throw new ConversionError("an event that is not an object");
      const time = nanos(event.time_unix_nano, "an event time");
      return {
        name: text(event.name) ?? "",
        ...(time ? { time } : {}),
        attributes: keyValues(event.attributes),
      };
    }),
    links: [],
    ...(typeof code === "number" && code >= 0 && code <= 2
      ? { status: { code, ...(message ? { message } : {}) } }
      : {}),
    resource: [],
    record: span,
  };
}

const isPhoenixSpan = (value: unknown): value is Json => {
  const spanContext = object(object(value)?.context);
  return (
    spanContext !== undefined &&
    typeof spanContext.trace_id === "string" &&
    typeof spanContext.span_id === "string" &&
    isObject(value) &&
    ("start_time" in value || "span_kind" in value)
  );
};

/** A flattened attribute dictionary as OTLP attributes, the dotted keys kept. */
function dictionary(raw: JsonValue | undefined, what: string): OtlpAttribute[] {
  if (raw === undefined || raw === null) return [];
  const values = object(raw);
  if (!values) throw new ConversionError(`${what} is not an object`);
  return Object.entries(values).map(([key, value]) => ({ key, value: anyValue(value) }));
}

const instant = (value: JsonValue | undefined, what: string): bigint | undefined => {
  if (value === undefined || value === null) return undefined;
  try {
    return BigInt(unixNano(value));
  } catch {
    throw new ConversionError(`${what} is not a timestamp with a zone`);
  }
};

function readPhoenixSpan(span: Json): OtelSpan {
  const spanContext = object(span.context);
  const rawTraceId = spanContext?.trace_id;
  const rawSpanId = spanContext?.span_id;
  if (!isPhoenixSpan(span) || typeof rawTraceId !== "string" || typeof rawSpanId !== "string")
    throw new ConversionError("a record that is not a Phoenix span");
  const traceId = hexId(rawTraceId, 16);
  const parent = text(span.parent_id);
  const attributes = dictionary(span.attributes, "attributes");
  const kind = text(span.span_kind);
  if (
    kind &&
    kind !== "UNKNOWN" &&
    !attributes.some((item) => item.key === "openinference.span.kind")
  )
    attributes.unshift({ key: "openinference.span.kind", value: { stringValue: kind } });
  const code = text(span.status_code);
  const message = text(span.status_message);
  const start = instant(span.start_time, "start_time");
  const end = instant(span.end_time, "end_time");
  const events = span.events ?? [];
  if (!Array.isArray(events)) throw new ConversionError("events is not a list");
  return {
    traceId,
    spanKey: hexId(rawSpanId, 8),
    ...(parent ? { parentKey: hexId(parent, 8) } : {}),
    name: text(span.name) ?? "",
    kind: 1,
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
    attributes,
    events: events.map((item) => {
      const event = object(item);
      if (!event) throw new ConversionError("an event that is not an object");
      const time = instant(event.timestamp, "an event timestamp");
      return {
        name: text(event.name) ?? "",
        ...(time !== undefined ? { time } : {}),
        attributes: dictionary(event.attributes, "event attributes"),
      };
    }),
    links: [],
    ...(code && code in STATUS
      ? { status: { code: STATUS[code]!, ...(message ? { message } : {}) } }
      : {}),
    resource: [],
    record: span,
  };
}

function convertWith(
  format: string,
  records: unknown[],
  isRecord: (value: unknown) => value is Json,
  traceIdOf: (record: Json) => JsonValue | undefined,
  read: (record: Json) => OtelSpan,
  context: ConvertContext,
): void {
  const collector = context.collector(() => new OtelSpanCollector(format));
  readRecords(
    context,
    records,
    (record) => {
      const fields = object(record);
      const traceId = fields ? traceIdOf(fields) : undefined;
      return typeof traceId === "string" && traceId ? otelTraceKey(hexId(traceId, 16)) : undefined;
    },
    (record) => {
      if (!isRecord(record)) throw new ConversionError(`a record that is not a ${format} span`);
      collector.add(read(record), context.source.digest);
    },
  );
}

export const phoenixOtlp: ImportAdapter = {
  id: "phoenix_otlp",
  manifestFormat: "otlp_json",
  detect: (value) => recordsOf(value, isOtlpSpan) !== undefined,
  convert(value, context) {
    convertWith(
      "phoenix_otlp",
      recordsOf(value, isOtlpSpan) ?? [],
      isOtlpSpan,
      (record) => record.trace_id,
      readOtlpSpan,
      context,
    );
  },
};

export const phoenixSpans: ImportAdapter = {
  id: "phoenix_spans",
  manifestFormat: "otlp_json",
  detect: (value) => recordsOf(value, isPhoenixSpan) !== undefined,
  convert(value, context) {
    convertWith(
      "phoenix_spans",
      recordsOf(value, isPhoenixSpan) ?? [],
      isPhoenixSpan,
      (record) => object(record.context)?.trace_id,
      readPhoenixSpan,
      context,
    );
  },
};
