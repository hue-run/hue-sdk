import {
  ConversionError,
  isObject,
  OtlpTraceCollector,
  type JsonValue,
  type OtlpAttribute,
  type OtlpValue,
} from "../traces-import-convert.js";
import type { ConvertContext, ImportAdapter } from "./adapter.js";
import { otelTraceKey, OtelSpanCollector, unsigned, type OtelSpan } from "./otel-spans.js";
import { readRecords } from "./rows.js";

/**
 * Jaeger's two JSON exports.
 *
 * `jaeger_api_v3`: the API v3 HTTP answer, `{"result": {"resourceSpans": […]}}` (`GetTrace`,
 * `FindTraces`; `FindSpans` nests the spans under `result.spans`), and its NDJSON stream, one
 * such object per line ending with `{"end": true}`. The OTLP inside is kept as recorded, like an
 * OTLP/JSON export; an `{"error": …}` line is reported with its message.
 *
 * `jaeger`: the query service's `/api/traces` answer and the UI's trace download,
 * `{"data": [{traceID, spans, processes}]}`, one such trace alone, and a span with its process
 * embedded. Each span is converted to the OTLP span it was, as the OpenTelemetry Collector
 * converts Jaeger spans: the process is the resource (`serviceName` as `service.name`), `span.kind`,
 * `error`, `otel.status_code`, `otel.status_description`, `otel.scope.name`/`otel.library.name`
 * and `w3c.tracestate` tags become the span's kind, status, scope and trace state, the first
 * `CHILD_OF` reference within the trace (else the first `FOLLOWS_FROM`) is the parent and the
 * other references are links, logs are events named by their `event` field, and `startTime`
 * and `duration` are microseconds.
 */

type Json = Record<string, JsonValue>;
const object = (value: unknown): Json | undefined =>
  isObject(value) ? (value as Json) : undefined;

/** The OTLP traces of an API v3 answer or stream line, when it holds any. */
function v3Traces(value: unknown): Json | undefined {
  const result = object(object(value)?.result);
  if (!result) return undefined;
  if (Array.isArray(result.resourceSpans) || Array.isArray(result.resource_spans)) return result;
  const spans = object(result.spans);
  if (spans && (Array.isArray(spans.resourceSpans) || Array.isArray(spans.resource_spans)))
    return spans;
  return undefined;
}

const hasOnly = (value: Json, key: string) => Object.keys(value).length === 1 && key in value;
/** A stream's closing line, `{"end": true}`. */
const isEnd = (value: unknown) => {
  const line = object(value);
  return line !== undefined && hasOnly(line, "end") && line.end === true;
};
/** A gateway error, `{"error": {"httpCode": …, "message": …}}`. */
const gatewayError = (value: unknown) => {
  const line = object(value);
  const error = object(line?.error);
  return line && hasOnly(line, "error") && error && typeof error.httpCode === "number"
    ? error
    : undefined;
};

export const jaegerApiV3: ImportAdapter = {
  id: "jaeger_api_v3",
  manifestFormat: "otlp_json",
  detect: (value) =>
    v3Traces(value) !== undefined || isEnd(value) || gatewayError(value) !== undefined,
  convert(value, context) {
    const error = gatewayError(value);
    if (error)
      throw new ConversionError(
        `a Jaeger API error${typeof error.message === "string" ? `: ${error.message}` : ""}`,
      );
    const traces = v3Traces(value);
    if (!traces) return;
    const collector = context.collector(() => new OtlpTraceCollector());
    for (const refusal of collector.add([traces], context.source.digest))
      context.refuse(refusal.reason, refusal.traceId);
  },
};

const isSpan = (value: unknown): boolean =>
  isObject(value) &&
  typeof value.spanID === "string" &&
  typeof value.operationName === "string" &&
  "startTime" in value;
const isTrace = (value: unknown): boolean =>
  isObject(value) && Array.isArray(value.spans) && value.spans.some(isSpan);

/** The traces a value holds: a `{data: […]}` answer, one trace, or one span with its process. */
function tracesOf(value: unknown): Json[] | undefined {
  const document = object(value);
  if (!document) return undefined;
  if (Array.isArray(document.data) && document.data.some(isTrace))
    return document.data.map((trace) => object(trace) ?? {});
  if (isTrace(document)) return [document];
  if (isSpan(document) && typeof document.traceID === "string" && object(document.process))
    return [{ traceID: document.traceID, spans: [document] }];
  return undefined;
}

/** A tag's typed value as OTLP: Jaeger writes an int64 past 2^53 as its decimal text and binary
 * as base64; the embedded-process form writes every value as text. */
function tagValue(tag: Json): OtlpValue {
  const value = tag.value;
  switch (tag.type) {
    case "string":
      return { stringValue: typeof value === "string" ? value : JSON.stringify(value) };
    case "bool":
      return { boolValue: value === true || value === "true" };
    case "int64":
      if (typeof value === "number" && Number.isSafeInteger(value))
        return { intValue: String(value) };
      if (typeof value === "string" && /^-?\d+$/.test(value)) return { intValue: value };
      break;
    case "float64":
      if (typeof value === "number") return { doubleValue: value };
      if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
        return { doubleValue: Number(value) };
      break;
    case "binary":
      if (typeof value === "string") return { bytesValue: value };
      break;
    case undefined:
      if (typeof value === "string") return { stringValue: value };
      if (typeof value === "boolean") return { boolValue: value };
      if (typeof value === "number")
        return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
      break;
  }
  throw new ConversionError(`tag ${String(tag.key)} has a value that is not its type`);
}

function tags(value: JsonValue | undefined, what: string): Map<string, OtlpValue> {
  if (value === undefined || value === null) return new Map();
  if (!Array.isArray(value)) throw new ConversionError(`${what} is not a list`);
  const map = new Map<string, OtlpValue>();
  for (const item of value) {
    const tag = object(item);
    if (!tag || typeof tag.key !== "string") throw new ConversionError(`${what} holds no key`);
    map.set(tag.key, tagValue(tag));
  }
  return map;
}

const attributesOf = (map: ReadonlyMap<string, OtlpValue>): OtlpAttribute[] =>
  [...map].map(([key, value]) => ({ key, value }));
const textOf = (value: OtlpValue | undefined) =>
  typeof value?.stringValue === "string" ? value.stringValue : undefined;
/** Removes a tag and returns its text. */
const take = (map: Map<string, OtlpValue>, key: string) => {
  const value = textOf(map.get(key));
  if (value !== undefined) map.delete(key);
  return value;
};

const KINDS: Record<string, number> = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
};

/** Microseconds as nanoseconds; undefined when absent, refused when malformed. */
function micros(value: JsonValue | undefined, what: string): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  const count = unsigned(value);
  if (count === undefined) throw new ConversionError(`${what} is not a count of microseconds`);
  return count * 1000n;
}

function readSpan(
  span: Json,
  trace: Json,
  context: ConvertContext,
  collector: OtelSpanCollector,
): void {
  const traceId = typeof span.traceID === "string" ? span.traceID : trace.traceID;
  if (typeof traceId !== "string" || !traceId)
    throw new ConversionError("a span without a traceID");
  const { spanID, operationName } = span;
  if (!isSpan(span) || typeof spanID !== "string" || typeof operationName !== "string")
    throw new ConversionError("a record that is not a Jaeger span");
  const key = otelTraceKey(traceId);
  const references = span.references ?? [];
  if (!Array.isArray(references)) throw new ConversionError("references is not a list");
  const refs = references.map((item) => {
    const ref = object(item);
    if (!ref || typeof ref.spanID !== "string" || !ref.spanID)
      throw new ConversionError("a reference without a spanID");
    const refTrace = typeof ref.traceID === "string" && ref.traceID ? ref.traceID : traceId;
    return {
      type: ref.refType,
      traceId: refTrace,
      spanId: ref.spanID,
      same: otelTraceKey(refTrace) === key,
    };
  });
  const parent =
    refs.find((ref) => ref.same && ref.type === "CHILD_OF") ??
    refs.find((ref) => ref.same && ref.type === "FOLLOWS_FROM");
  const legacyParent =
    typeof span.parentSpanID === "string" && !/^0*$/.test(span.parentSpanID)
      ? span.parentSpanID
      : undefined;
  const attributes = tags(span.tags, "tags");
  const kind = take(attributes, "span.kind");
  let status: OtelSpan["status"];
  const error = attributes.get("error");
  if (error?.boolValue === true) {
    attributes.delete("error");
    const message = take(attributes, "otel.status_description");
    status = { code: 2, ...(message ? { message } : {}) };
  }
  const code = take(attributes, "otel.status_code");
  if (code !== undefined && !status) {
    const message = take(attributes, "otel.status_description");
    const upper = code.toUpperCase();
    status = {
      code: upper === "OK" ? 1 : upper === "ERROR" ? 2 : 0,
      ...(message ? { message } : {}),
    };
  }
  const scopeName = take(attributes, "otel.scope.name") ?? take(attributes, "otel.library.name");
  const scopeVersion =
    take(attributes, "otel.scope.version") ?? take(attributes, "otel.library.version");
  const traceState = take(attributes, "w3c.tracestate");
  const processes = object(trace.processes);
  const process =
    object(span.process) ??
    (typeof span.processID === "string" && processes
      ? object(processes[span.processID])
      : undefined);
  const resource = tags(process?.tags, "process tags");
  if (typeof process?.serviceName === "string" && process.serviceName)
    resource.set("service.name", { stringValue: process.serviceName });
  const logs = span.logs ?? [];
  if (!Array.isArray(logs)) throw new ConversionError("logs is not a list");
  const start = micros(span.startTime, "startTime");
  if (start === 0n) throw new ConversionError("startTime is zero");
  const duration = micros(span.duration, "duration");
  const flags = unsigned(span.flags);
  const otelSpan: OtelSpan = {
    traceId,
    spanKey: spanID,
    ...(parent ? { parentKey: parent.spanId } : legacyParent ? { parentKey: legacyParent } : {}),
    name: operationName,
    kind: kind !== undefined ? (KINDS[kind] ?? 0) : 0,
    ...(traceState ? { traceState } : {}),
    ...(flags !== undefined && flags <= 0xffffffffn ? { flags: Number(flags) } : {}),
    ...(start !== undefined ? { start } : {}),
    ...(start !== undefined && duration !== undefined ? { end: start + duration } : {}),
    attributes: attributesOf(attributes),
    events: logs.map((item) => {
      const log = object(item);
      if (!log) throw new ConversionError("a log that is not an object");
      const fields = tags(log.fields, "log fields");
      const name = take(fields, "event") ?? "";
      const time = micros(log.timestamp, "a log timestamp");
      return { name, ...(time ? { time } : {}), attributes: attributesOf(fields) };
    }),
    links: refs
      .filter((ref) => ref !== parent)
      .map((ref) => ({
        traceId: ref.traceId,
        spanKey: ref.spanId,
        attributes: [
          {
            key: "opentracing.ref_type",
            value: { stringValue: ref.type === "FOLLOWS_FROM" ? "follows_from" : "child_of" },
          },
        ],
      })),
    ...(status ? { status } : {}),
    resource: attributesOf(resource),
    ...(scopeName
      ? { scope: { name: scopeName, ...(scopeVersion ? { version: scopeVersion } : {}) } }
      : {}),
    record: span,
  };
  collector.add(otelSpan, context.source.digest);
}

export const jaeger: ImportAdapter = {
  id: "jaeger",
  manifestFormat: "otlp_json",
  detect: (value) => tracesOf(value) !== undefined,
  convert(value, context) {
    const collector = context.collector(() => new OtelSpanCollector("jaeger"));
    const records = (tracesOf(value) ?? []).flatMap((trace) => {
      const spans = Array.isArray(trace.spans) ? trace.spans : [trace];
      return spans.map((span) => ({ span, trace }));
    });
    readRecords(
      context,
      records,
      ({ span, trace }) => {
        const traceId = object(span)?.traceID ?? trace.traceID;
        return typeof traceId === "string" && traceId ? otelTraceKey(traceId) : undefined;
      },
      ({ span, trace }) => {
        const record = object(span);
        if (!record) throw new ConversionError("a span that is not an object");
        readSpan(record, trace, context, collector);
      },
    );
  },
};
