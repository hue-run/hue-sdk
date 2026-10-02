import { SpanStatusCode, type Attributes } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import type { HueOptions } from "./types.js";
import { MAX_CONTENT_BYTES } from "./config.js";
import { scrubToolCredentials, withToolCatalogSummary } from "./tool-definitions.js";
import { hashInlineFiles } from "./inline-files.js";
import { truncateUtf8 } from "./safety.js";

export { truncateUtf8 };

/** Attribute keys (and their dotted children) removed in metadata-only mode. */
export const contentPrefixes = [
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.system_instructions",
  "gen_ai.prompt",
  "gen_ai.completion",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
  "gen_ai.tool.definitions",
  "gen_ai.event.content",
  "llm.input_messages",
  "llm.output_messages",
  "llm.prompts",
  "llm.completions",
  "llm.invocation_parameters",
  "llm.prompt_template.template",
  "llm.prompt_template.variables",
  "llm.tools",
  "llm.function_call",
  "llm.choices",
  "input.value",
  "output.value",
  "input.images",
  "output.images",
  "retrieval.documents",
  "embedding.embeddings",
  "reranker.query",
  "reranker.input_documents",
  "reranker.output_documents",
  "ai.prompt",
  "ai.response.text",
  "ai.response.object",
  "ai.response.reasoning",
  "ai.response.files",
  "ai.response.toolCalls",
  "ai.response.body",
  "ai.toolCall.args",
  "ai.toolCall.result",
  "ai.value",
  "ai.values",
  "ai.embedding",
  "ai.embeddings",
  "traceloop.entity.input",
  "traceloop.entity.output",
  "tool.parameters",
  "exception.message",
  "exception.stacktrace",
];

// Kept as a function so metadata-only filtering is applied consistently to every exporter location.
export function isContentKey(key: string): boolean {
  return contentPrefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}.`));
}

/** The record attribute listing the keys whose values were cut to fit Hue's 256 KiB value cap:
 * Hue's receiver writes it for the values it cuts, and the SDK writes it for the values it cuts
 * before export, under the same name, so a reader learns of a cut value from one place. */
export const TRUNCATED_KEY = "hue.truncated";
/** The size of a structured value the marker replaced. */
export const TRUNCATED_BYTES_KEY = "hue.truncated_bytes";
/** The root span attribute counting this trace's records the SDK could not export at all (a
 * record over the request limit even with every content value shed, or one its queue had no
 * room for): what Hue stores of the trace is incomplete by that many records. */
export const DROPPED_RECORDS_KEY = "hue.sdk.dropped_records";

/** The serialized size of a structured value as recorded, 0 for one JSON cannot serialize. */
function structuredBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "");
  } catch {
    return 0;
  }
}

/** Hue's receiver's own marker for a structured value it replaced: nothing of the value, its
 * size, and the flag a reader tests. */
export function truncatedMarker(bytes: number): Record<string, unknown> {
  return { [TRUNCATED_KEY]: true, [TRUNCATED_BYTES_KEY]: bytes };
}

/** `listed` with `keys` added, each once, in order. */
export function withTruncatedKeys(listed: unknown, keys: readonly string[]): string[] {
  const result = Array.isArray(listed)
    ? listed.filter((item): item is string => typeof item === "string")
    : [];
  for (const key of keys) if (!result.includes(key)) result.push(key);
  return result;
}

interface RedactionBudget {
  bytes: number;
  nodes: number;
  /** The keys whose values were cut or replaced, as `hue.truncated` lists them. */
  truncated: string[];
}

/**
 * One value through the redactor and Hue's value cap. Text over 256 KiB is cut to a UTF-8 prefix
 * and bytes over it are replaced by the receiver's marker, as the receiver itself does to a
 * value over its cap, and the value's key (`listAs`) is listed under `hue.truncated`: the span
 * is exported whole with the rest of its evidence, and a reader knows the one value is partial.
 * Dropping the record for a large value lost every call, result and reply it recorded.
 */
function redactValue(
  value: unknown,
  path: string,
  options: HueOptions,
  budget: RedactionBudget,
  depth = 0,
  listAs = path,
): unknown {
  if (++budget.nodes > 16384 || depth > 32)
    throw new Error("Telemetry value exceeds the supported nesting limit");
  if (typeof value === "string") {
    const result = options.redact ? options.redact(value, path) : value;
    // JavaScript can supply an async redactor despite the synchronous contract.
    // Observe its rejection before dropping the invalid record.
    if (result && typeof result === "object") void Promise.resolve(result).catch(() => {});
    if (typeof result !== "string" || !result.isWellFormed() || result.includes("\u0000"))
      throw new Error("Redaction produced unsupported text");
    const bytes = Buffer.byteLength(result);
    if (bytes <= MAX_CONTENT_BYTES) {
      budget.bytes += bytes;
      return result;
    }
    if (!budget.truncated.includes(listAs)) budget.truncated.push(listAs);
    budget.bytes += MAX_CONTENT_BYTES;
    return truncateUtf8(result, MAX_CONTENT_BYTES);
  }
  if (Array.isArray(value)) {
    if (value.length > 16384) throw new Error("Telemetry array exceeds the complexity limit");
    return value.map((item, index) =>
      redactValue(item, `${path}.${index}`, options, budget, depth + 1, listAs),
    );
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength <= MAX_CONTENT_BYTES) {
      budget.bytes += value.byteLength;
      return value;
    }
    // Bytes are never cut: a shortened encoding is a different value.
    if (!budget.truncated.includes(listAs)) budget.truncated.push(listAs);
    return truncatedMarker(value.byteLength);
  }
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactValue(item, `${path}.${key}`, options, budget, depth + 1, listAs),
      ]),
    );
  return value;
}

/**
 * A record's attributes through the redactor. `listPrefix` is how a cut value of these
 * attributes is listed under the record's `hue.truncated`: the key alone for the record's own
 * attributes, `event:<name>:<key>` for an event's, as Hue's receiver lists the values it cuts.
 */
function attributes<T extends Record<string, unknown>>(
  source: T,
  options: HueOptions,
  path: string,
  budget: RedactionBudget,
  listPrefix = "",
): T {
  // Metadata-only export summarizes the tool definitions it removes by name and digest.
  const summarized = options.captureContent ? source : withToolCatalogSummary(source);
  return Object.fromEntries(
    Object.entries(summarized).flatMap(([key, value]) =>
      !options.captureContent && isContentKey(key)
        ? []
        : [
            [
              key,
              redactValue(
                scrubToolCredentials(key, hashInlineFiles(key, value)),
                `${path}.${key}`,
                options,
                budget,
                0,
                `${listPrefix}${key}`,
              ),
            ],
          ],
    ),
  ) as T;
}

/** The record's attributes with the keys the redaction cut listed under `hue.truncated`, merged
 * with any the application listed itself; unchanged when nothing was cut. */
function withTruncated<T extends Record<string, unknown>>(source: T, budget: RedactionBudget): T {
  if (!budget.truncated.length) return source;
  return { ...source, [TRUNCATED_KEY]: withTruncatedKeys(source[TRUNCATED_KEY], budget.truncated) };
}

export type ResourceCache = WeakMap<Resource, Resource>;

function redactResource(
  resource: Resource,
  options: HueOptions,
  cache: ResourceCache,
  budget: RedactionBudget,
): Resource {
  let result = cache.get(resource);
  if (!result) {
    const cutsBefore = budget.truncated.length;
    result = resourceFromAttributes(
      attributes(resource.attributes, options, "resource.attributes", budget, "resource."),
      { schemaUrl: resource.schemaUrl },
    );
    // A resource whose value was cut is redacted for every record, so each lists the cut.
    if (budget.truncated.length === cutsBefore) cache.set(resource, result);
  }
  return result;
}

/**
 * Server identity and failure of an AI SDK 7 provider-executed (`extension`) tool span, read from
 * its recorded result before content is stripped. OpenAI hosted MCP results carry
 * `{ type: "call", serverLabel, name, arguments, output?, error? }`; nothing else names the server.
 */
function hostedMcpCall(attributes: Attributes): { serverName?: string; failed: boolean } {
  const result = attributes["gen_ai.tool.call.result"];
  if (attributes["gen_ai.tool.type"] !== "extension" || typeof result !== "string")
    return { failed: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return { failed: false };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return { failed: false };
  const { type, serverLabel, error } = parsed as {
    type?: unknown;
    serverLabel?: unknown;
    error?: unknown;
  };
  if (type !== "call") return { failed: false };
  const valid =
    typeof serverLabel === "string" &&
    serverLabel.trim() !== "" &&
    serverLabel.length <= 256 &&
    !serverLabel.includes("\u0000") &&
    serverLabel.isWellFormed();
  return { ...(valid ? { serverName: serverLabel } : {}), failed: error != null };
}

export function redactSpan(
  span: ReadableSpan,
  options: HueOptions,
  cache: ResourceCache,
): ReadableSpan {
  const budget: RedactionBudget = { bytes: 0, nodes: 0, truncated: [] };
  // Derived before metadata-only stripping so the identity survives without the result itself.
  const hosted = hostedMcpCall(span.attributes);
  const source: Attributes = {
    ...(hosted.serverName === undefined ? {} : { "mcp.server.name": hosted.serverName }),
    ...(hosted.failed ? { "error.type": "mcp_error" } : {}),
    ...span.attributes,
  };
  const status = {
    code:
      hosted.failed && span.status.code === SpanStatusCode.UNSET
        ? SpanStatusCode.ERROR
        : span.status.code,
    ...(options.captureContent &&
    span.status.message !== undefined &&
    !(hosted.failed && span.status.code === SpanStatusCode.UNSET)
      ? { message: String(redactValue(span.status.message, "status.message", options, budget)) }
      : {}),
  };
  const events = span.events
    .filter(
      (event) =>
        options.captureContent ||
        !/^gen_ai\.(?:system|user|assistant|tool|choice)/.test(event.name),
    )
    .map((event) => ({
      ...event,
      attributes: attributes(
        event.attributes ?? {},
        options,
        `events.${event.name}`,
        budget,
        `event:${event.name}:`,
      ),
    }));
  const links = span.links.map((link) => ({
    ...link,
    attributes: attributes(link.attributes ?? {}, options, "links.attributes", budget, "link:"),
  }));
  const resource = redactResource(span.resource, options, cache, budget);
  // Last, so every cut of the record, its events', links' and resource's included, is listed.
  const redactedAttributes = withTruncated(
    attributes(source, options, "attributes", budget),
    budget,
  );
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    ended: span.ended,
    status,
    attributes: redactedAttributes,
    events,
    links,
    resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

export function redactLog(
  log: ReadableLogRecord,
  options: HueOptions,
  cache: ResourceCache,
): ReadableLogRecord {
  const budget: RedactionBudget = { bytes: 0, nodes: 0, truncated: [] };
  let body = options.captureContent ? redactValue(log.body, "body", options, budget) : undefined;
  if (body !== undefined && typeof body !== "string") {
    // A structured body over the cap is replaced by the receiver's marker, as the receiver would
    // replace it; the marker names the body's size as recorded, before any text part was cut.
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_CONTENT_BYTES) {
      body = truncatedMarker(structuredBytes(log.body));
      if (!budget.truncated.includes("body")) budget.truncated.push("body");
    }
  }
  const redactedAttributes = attributes(log.attributes, options, "attributes", budget);
  const resource = redactResource(log.resource, options, cache, budget);
  const scopeAttributes = log.instrumentationScope.attributes
    ? attributes(log.instrumentationScope.attributes, options, "scope.attributes", budget, "scope.")
    : undefined;
  return {
    hrTime: log.hrTime,
    hrTimeObserved: log.hrTimeObserved,
    spanContext: log.spanContext,
    severityText: log.severityText,
    severityNumber: log.severityNumber,
    eventName: log.eventName,
    body: body as ReadableLogRecord["body"],
    attributes: withTruncated(redactedAttributes, budget),
    resource,
    instrumentationScope: {
      ...log.instrumentationScope,
      ...(scopeAttributes ? { attributes: scopeAttributes } : {}),
    },
    droppedAttributesCount: log.droppedAttributesCount,
  };
}
