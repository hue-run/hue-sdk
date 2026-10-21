import type { ImportAdapter } from "./adapter.js";
import { datadogLlmObs } from "./datadog.js";
import { jaeger, jaegerApiV3 } from "./jaeger.js";
import { otlpProtobuf } from "./otlp-protobuf.js";
import { phoenixOtlp, phoenixSpans } from "./phoenix.js";
import { zipkin } from "./zipkin.js";

/** The OpenTelemetry family of exports: binary OTLP and collector files, Jaeger, Zipkin and
 * Arize Phoenix spans, kept as the OTLP spans they were; and Datadog LLM Observability spans,
 * read as canonical rows. */
export const otelFamilyAdapters: readonly ImportAdapter[] = [
  otlpProtobuf,
  jaegerApiV3,
  jaeger,
  zipkin,
  phoenixOtlp,
  phoenixSpans,
  datadogLlmObs,
];
