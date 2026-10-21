import { isObject, OTLP_SPANS, OtlpTraceCollector } from "../traces-import-convert.js";
import type { ImportAdapter } from "./adapter.js";

/** OTLP/JSON trace exports (`{"resourceSpans": […]}`, proto field names too): spans kept as
 * recorded, gathered by trace across files and lines, and with binary OTLP and Jaeger API v3. */
export const otlpJson: ImportAdapter = {
  id: "otlp_json",
  manifestFormat: "otlp_json",
  detect: (value) =>
    isObject(value) && (Array.isArray(value.resourceSpans) || Array.isArray(value.resource_spans)),
  convert(value, context) {
    if (!isObject(value)) return;
    const collector = context.collector(() => new OtlpTraceCollector(), OTLP_SPANS);
    for (const refusal of collector.add([value], context.source.digest, otlpJson.id))
      context.refuse(refusal.reason, refusal.traceId);
  },
};
