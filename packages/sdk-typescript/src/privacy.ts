import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import type { HueOptions } from "./types.js";
import { MAX_BODY_BYTES, MAX_CONTENT_BYTES } from "./config.js";

const contentPrefixes = [
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
  "input.value",
  "output.value",
  "ai.prompt",
  "ai.response.text",
  "ai.response.object",
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
function isContentKey(key: string): boolean {
  return contentPrefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}.`));
}

interface RedactionBudget {
  bytes: number;
  nodes: number;
}

function redactValue(
  value: unknown,
  path: string,
  options: HueOptions,
  budget: RedactionBudget,
  depth = 0,
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
    if (Buffer.byteLength(result) > MAX_CONTENT_BYTES)
      throw new Error("Telemetry text exceeds 256 KiB");
    budget.bytes += Buffer.byteLength(result);
    if (budget.bytes > MAX_BODY_BYTES)
      throw new Error("Redacted record exceeds the content budget");
    return result;
  }
  if (Array.isArray(value)) {
    if (value.length > 16384) throw new Error("Telemetry array exceeds the complexity limit");
    return value.map((item, index) =>
      redactValue(item, `${path}.${index}`, options, budget, depth + 1),
    );
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_CONTENT_BYTES) throw new Error("Telemetry bytes exceed 256 KiB");
    budget.bytes += value.byteLength;
    if (budget.bytes > MAX_BODY_BYTES)
      throw new Error("Redacted record exceeds the content budget");
    return value;
  }
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactValue(item, `${path}.${key}`, options, budget, depth + 1),
      ]),
    );
  return value;
}

function attributes<T extends Record<string, unknown>>(
  source: T,
  options: HueOptions,
  path: string,
  budget: RedactionBudget,
): T {
  return Object.fromEntries(
    Object.entries(source).flatMap(([key, value]) =>
      !options.captureContent && isContentKey(key)
        ? []
        : [[key, redactValue(value, `${path}.${key}`, options, budget)]],
    ),
  ) as T;
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
    result = resourceFromAttributes(
      attributes(resource.attributes, options, "resource.attributes", budget),
      { schemaUrl: resource.schemaUrl },
    );
    cache.set(resource, result);
  }
  return result;
}

export function redactSpan(
  span: ReadableSpan,
  options: HueOptions,
  cache: ResourceCache,
): ReadableSpan {
  const budget = { bytes: 0, nodes: 0 };
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    ended: span.ended,
    status: {
      code: span.status.code,
      ...(options.captureContent && span.status.message !== undefined
        ? { message: String(redactValue(span.status.message, "status.message", options, budget)) }
        : {}),
    },
    attributes: attributes(span.attributes, options, "attributes", budget),
    events: span.events
      .filter(
        (event) =>
          options.captureContent ||
          !/^gen_ai\.(?:system|user|assistant|tool|choice)/.test(event.name),
      )
      .map((event) => ({
        ...event,
        attributes: attributes(event.attributes ?? {}, options, `events.${event.name}`, budget),
      })),
    links: span.links.map((link) => ({
      ...link,
      attributes: attributes(link.attributes ?? {}, options, "links.attributes", budget),
    })),
    resource: redactResource(span.resource, options, cache, budget),
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
  const budget = { bytes: 0, nodes: 0 };
  const body = options.captureContent ? redactValue(log.body, "body", options, budget) : undefined;
  if (body !== undefined && Buffer.byteLength(JSON.stringify(body)) > MAX_CONTENT_BYTES)
    throw new Error("Telemetry log body exceeds 256 KiB");
  return {
    hrTime: log.hrTime,
    hrTimeObserved: log.hrTimeObserved,
    spanContext: log.spanContext,
    severityText: log.severityText,
    severityNumber: log.severityNumber,
    eventName: log.eventName,
    body: body as ReadableLogRecord["body"],
    attributes: attributes(log.attributes, options, "attributes", budget),
    resource: redactResource(log.resource, options, cache, budget),
    instrumentationScope: {
      ...log.instrumentationScope,
      ...(log.instrumentationScope.attributes
        ? {
            attributes: attributes(
              log.instrumentationScope.attributes,
              options,
              "scope.attributes",
              budget,
            ),
          }
        : {}),
    },
    droppedAttributesCount: log.droppedAttributesCount,
  };
}
