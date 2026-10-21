import {
  ConversionError,
  isObject,
  type JsonValue,
  type OtlpAttribute,
} from "../traces-import-convert.js";
import type { ImportAdapter } from "./adapter.js";
import { otelTraceKey, OtelSpanCollector, unsigned, type OtelSpan } from "./otel-spans.js";
import { readRecords } from "./rows.js";

/**
 * Zipkin v2 JSON (`zipkin2-api.yaml`): a list of spans (a trace, the UI's JSON download, a
 * `/api/v2/spans` body), a list of such lists (`/api/v2/traces`), one span per line, or one
 * span. Each span is converted to the OTLP span it was, as the OpenTelemetry Collector converts
 * Zipkin spans:
 *
 * - `localEndpoint.serviceName` is the resource's `service.name`, and tags that name the
 *   resource (`service.*`, `telemetry.*`, `deployment.*`, `host.*`, …) move to the resource;
 *   the other tags stay span attributes, as text.
 * - `kind` is the span kind; `otel.status_code`/`otel.status_description` and an `error` tag
 *   the status, the `error` tag's text its message; `otel.scope.name`/`otel.library.name` the
 *   scope; endpoints become `net.host.*`, `net.peer.*` and `peer.service`; annotations become
 *   events.
 * - `timestamp` and `duration` are microseconds. Zipkin lets both be absent; such a span's
 *   instants are filled by the documented rules (`rows.ts`) and named in the report.
 * - A server span `shared` with its client (one id for both halves of an RPC, Zipkin's default)
 *   becomes the client's child under an id mapped from the shared id, as Zipkin's own UI nests
 *   it; the server's children nest under it when they ran on the same service. The id both
 *   halves recorded is kept as `hue.import.original_span_id`.
 */

type Json = Record<string, JsonValue>;
const object = (value: unknown): Json | undefined =>
  isObject(value) ? (value as Json) : undefined;
const text = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" && value ? value : undefined;

const KINDS: Record<string, number> = { SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 };

/** A record with a Zipkin v2 span's hex trace and span ids and none of the fields other formats
 * name a span with (`type`, `startTime`, `spanId`, `traceID`, `span_id`). */
function hasSpanIds(value: unknown): value is Json {
  if (!isObject(value)) return false;
  const { traceId, id } = value;
  if (typeof traceId !== "string" || typeof id !== "string") return false;
  if (!/^[0-9a-f]{16}(?:[0-9a-f]{16})?$/i.test(traceId) || !/^[0-9a-f]{16}$/i.test(id))
    return false;
  return !["type", "startTime", "spanId", "traceID", "span_id"].some((key) => key in value);
}

/** A Zipkin v2 span on its own: its ids and a field only a span records. */
const isSpan = (value: unknown): value is Json =>
  hasSpanIds(value) &&
  (typeof value.timestamp === "number" ||
    typeof value.duration === "number" ||
    isObject(value.localEndpoint) ||
    (typeof value.kind === "string" && value.kind in KINDS) ||
    Array.isArray(value.annotations) ||
    isObject(value.tags));

/** Tags that describe the process, which the Collector keeps on the resource. */
const RESOURCE_PREFIXES = [
  "service.",
  "telemetry.",
  "deployment.",
  "host.",
  "os.",
  "process.",
  "container.",
  "k8s.",
  "cloud.",
  "faas.",
  "device.",
];

const attribute = (key: string, value: string | number): OtlpAttribute => ({
  key,
  value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value },
});

/** An endpoint's address and port under `prefix` (`net.host`, `net.peer`). */
function endpointAttributes(endpoint: Json | undefined, prefix: string): OtlpAttribute[] {
  if (!endpoint) return [];
  const address = text(endpoint.ipv4) ?? text(endpoint.ipv6);
  const port = endpoint.port;
  return [
    ...(address ? [attribute(`${prefix}.ip`, address)] : []),
    ...(typeof port === "number" && Number.isSafeInteger(port) && port > 0
      ? [attribute(`${prefix}.port`, port)]
      : []),
  ];
}

function micros(value: JsonValue | undefined, what: string): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  const count = unsigned(value);
  if (count === undefined) throw new ConversionError(`${what} is not a count of microseconds`);
  return count * 1000n;
}

function readSpan(span: Json, sequence: number): OtelSpan {
  const { traceId, id } = span;
  if (!hasSpanIds(span) || typeof traceId !== "string" || typeof id !== "string")
    throw new ConversionError("a record that is not a Zipkin span");
  const tagsValue = span.tags ?? {};
  const tags = object(tagsValue);
  if (!tags) throw new ConversionError("tags is not an object");
  const remaining = new Map<string, string>();
  for (const [key, value] of Object.entries(tags)) {
    if (typeof value !== "string") throw new ConversionError(`tag ${key} is not text`);
    remaining.set(key, value);
  }
  const take = (key: string) => {
    const value = remaining.get(key);
    remaining.delete(key);
    return value;
  };
  let kind = typeof span.kind === "string" ? (KINDS[span.kind] ?? 0) : 0;
  const kindTag = take("span.kind");
  if (!kind && kindTag === "internal") kind = 1;
  let status: OtelSpan["status"];
  const code = take("otel.status_code");
  const description = take("otel.status_description");
  if (code !== undefined)
    status = {
      code: code === "OK" ? 1 : code === "ERROR" ? 2 : 0,
      ...(description ? { message: description } : {}),
    };
  const error = take("error");
  if (error !== undefined) {
    const message = error && error !== "true" ? error : status?.message;
    status = { code: 2, ...(message ? { message } : {}) };
  }
  const scopeName = take("otel.scope.name") ?? take("otel.library.name");
  const scopeVersion = take("otel.scope.version") ?? take("otel.library.version");
  const traceState = take("w3c.tracestate");
  const local = object(span.localEndpoint);
  const remote = object(span.remoteEndpoint);
  const resource: OtlpAttribute[] = [];
  const service = text(local?.serviceName);
  if (service) resource.push(attribute("service.name", service));
  const attributes: OtlpAttribute[] = [];
  for (const [key, value] of remaining)
    (RESOURCE_PREFIXES.some((prefix) => key.startsWith(prefix)) ? resource : attributes).push(
      attribute(key, value),
    );
  attributes.push(...endpointAttributes(local, "net.host"));
  attributes.push(...endpointAttributes(remote, "net.peer"));
  const peer = text(remote?.serviceName);
  if (peer) attributes.push(attribute("peer.service", peer));
  const annotations = span.annotations ?? [];
  if (!Array.isArray(annotations)) throw new ConversionError("annotations is not a list");
  const start = micros(span.timestamp, "timestamp");
  if (start === 0n) throw new ConversionError("timestamp is zero");
  const duration = micros(span.duration, "duration");
  const parentId = text(span.parentId);
  if (parentId !== undefined && !/^[0-9a-f]{1,16}$/i.test(parentId))
    throw new ConversionError("parentId is not a span id");
  return {
    traceId,
    spanKey: id.toLowerCase(),
    ...(parentId ? { parentKey: parentId.toLowerCase() } : {}),
    name: text(span.name) ?? "",
    kind,
    ...(traceState ? { traceState } : {}),
    ...(start !== undefined ? { start } : {}),
    ...(start !== undefined && duration !== undefined ? { end: start + duration } : {}),
    attributes,
    events: annotations.map((item) => {
      const annotation = object(item);
      if (!annotation || typeof annotation.value !== "string")
        throw new ConversionError("an annotation without a value");
      const time = micros(annotation.timestamp, "an annotation timestamp");
      return { name: annotation.value, ...(time ? { time } : {}), attributes: [] };
    }),
    links: [],
    ...(status ? { status } : {}),
    resource,
    ...(scopeName
      ? { scope: { name: scopeName, ...(scopeVersion ? { version: scopeVersion } : {}) } }
      : {}),
    record: span,
    sequence,
  };
}

const serviceOf = (span: OtelSpan) => {
  const local = object(object(span.record)?.localEndpoint);
  return text(local?.serviceName) ?? "";
};
const isShared = (span: OtelSpan) => object(span.record)?.shared === true;

/** Nests each server span that shares its id with its client under the client, and the server's
 * children under the server when they ran on the same service, as Zipkin's UI builds its tree. */
function nestShared(spans: OtelSpan[]): OtelSpan[] {
  const unshared = new Set(spans.filter((span) => !isShared(span)).map((span) => span.spanKey));
  const sharedCount = new Map<string, number>();
  for (const span of spans)
    if (isShared(span)) sharedCount.set(span.spanKey, (sharedCount.get(span.spanKey) ?? 0) + 1);
  // A shared span is renamed when another span holds its id: its client, or another server.
  const renamed = new Map<string, string>();
  const keyed = spans.map((span) => {
    if (!isShared(span) || (!unshared.has(span.spanKey) && sharedCount.get(span.spanKey) === 1))
      return span;
    const spanKey = `${span.spanKey}#shared:${serviceOf(span)}`;
    renamed.set(`${span.spanKey}\u0000${serviceOf(span)}`, spanKey);
    return {
      ...span,
      spanKey,
      sourceSpanId: span.spanKey,
      ...(unshared.has(span.spanKey)
        ? { parentKey: span.spanKey }
        : span.parentKey !== undefined
          ? { parentKey: span.parentKey }
          : {}),
    };
  });
  return keyed.map((span) => {
    if (span.parentKey === undefined || span.sourceSpanId !== undefined) return span;
    const server = renamed.get(`${span.parentKey}\u0000${serviceOf(span)}`);
    return server ? { ...span, parentKey: server } : span;
  });
}

/** The spans a value holds: one span, or a list of spans. */
const spansOf = (value: unknown): unknown[] | undefined =>
  isSpan(value)
    ? [value]
    : Array.isArray(value) && value.length && value.every(isObject) && value.some(isSpan)
      ? value
      : undefined;

export const zipkin: ImportAdapter = {
  id: "zipkin",
  manifestFormat: "otlp_json",
  detect: (value) => spansOf(value) !== undefined,
  convert(value, context) {
    const collector = context.collector(() => new OtelSpanCollector("zipkin", nestShared));
    const records = spansOf(value) ?? [];
    // A span's position in its source orders a trace that records no instant at all.
    const base = context.source.line ?? context.source.index ?? 0;
    readRecords(
      context,
      records.map((record, index) => ({ record, sequence: base + index })),
      ({ record }) => {
        const traceId = object(record)?.traceId;
        return typeof traceId === "string" && traceId ? otelTraceKey(traceId) : undefined;
      },
      ({ record, sequence }) => {
        const span = object(record);
        if (!span) throw new ConversionError("a span that is not an object");
        collector.add(readSpan(span, sequence), context.source.digest);
      },
    );
  },
};
