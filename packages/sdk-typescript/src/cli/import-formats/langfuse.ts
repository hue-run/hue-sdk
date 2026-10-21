import {
  ConversionError,
  isObject,
  LangfuseTraceCollector,
  type JsonValue,
} from "../traces-import-convert.js";
import type { ImportAdapter } from "./adapter.js";

const isObservation = (value: unknown): value is Record<string, JsonValue> =>
  isObject(value) &&
  typeof value.id === "string" &&
  typeof value.traceId === "string" &&
  typeof value.type === "string" &&
  typeof value.startTime === "string";

const observations = (value: unknown): value is Record<string, JsonValue>[] =>
  Array.isArray(value) && value.length > 0 && value.every(isObservation);

/** Complete Langfuse observation exports: a list page (`data`) or the native `observations`
 * envelope, every record an observation. */
export const langfuseObservations: ImportAdapter = {
  id: "langfuse_observations",
  manifestFormat: "langfuse_observations",
  detect: (value) =>
    isObject(value) && (observations(value.data) || observations(value.observations)),
  convert(value, context) {
    if (!isObject(value)) return;
    if (value.data !== undefined && value.observations !== undefined)
      throw new ConversionError("two observation envelopes in one file");
    if (context.source.unsafeIntegers)
      throw new ConversionError("Source JSON contains an unsafe number");
    const key = observations(value.data) ? "data" : "observations";
    const records = value[key] as Record<string, JsonValue>[];
    const envelope = Object.fromEntries(
      Object.entries(value).filter(([name]) => name !== key),
    ) as Record<string, JsonValue>;
    context
      .collector(() => new LangfuseTraceCollector())
      .add(records, envelope, context.source.digest);
  },
};
