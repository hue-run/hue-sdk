import { isObject, OtlpTraceCollector } from "../traces-import-convert.js";
import type { ImportAdapter } from "./adapter.js";

/** OTLP/JSON trace exports (`{"resourceSpans": […]}`, proto field names too): spans kept as
 * recorded, gathered by trace across files and lines. */
export const otlpJson: ImportAdapter = {
  id: "otlp_json",
  manifestFormat: "otlp_json",
  detect: (value) =>
    isObject(value) && (Array.isArray(value.resourceSpans) || Array.isArray(value.resource_spans)),
  convert(value, context) {
    if (!isObject(value)) return;
    const collector = context.collector(() => new OtlpTraceCollector());
    for (const refusal of collector.add([value], context.source.digest))
      context.refuse(refusal.reason, refusal.traceId);
  },
};
