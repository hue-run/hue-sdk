import { isObject } from "../traces-import-convert.js";
import type { ImportAdapter } from "./adapter.js";
import { atif } from "./atif.js";
import { braintrust } from "./braintrust.js";
import { langfuseObservations } from "./langfuse.js";
import { otelFamilyAdapters } from "./otel-family.js";
import { otlpJson } from "./otlp.js";

/**
 * The source formats `hue traces import prepare` reads, and how a new one is added.
 *
 * How a file is read (`reader.ts`):
 * 1. Containers (`containers.ts`): gzip or zstd is undone, the text decoded, and the JSON read as
 *    one document, or as JSON Lines whose every line is read on its own. A line that is not JSON
 *    is reported with its number and the rest of the file is read.
 * 2. Detection: each value (the document, or each line) is offered to the formats below in this
 *    order and the first whose `detect` claims it converts it. A JSON array no format claims
 *    whole is read record by record the same way. A value or record no format claims is
 *    reported with the reason {@link unrecognizedReason} gives, never guessed at.
 * 3. Conversion: the format's `convert` maps the value to canonical span rows (`rows.ts`), which
 *    one emitter turns into the OTLP spans Hue reads, or hands whole traces or a collector of its
 *    own to the context. A malformed record refuses its trace, never the file.
 * 4. Identity (`identity.ts`): each trace's user and session are read from the emitted spans the
 *    way Hue reads them, after `--user-key` and `--session-key` are applied.
 *
 * Adding a format:
 * - Write `import-formats/<id>.ts` exporting an {@link ImportAdapter}: `detect` by distinctive
 *   top-level keys (never a file name, never a shape another format claims), and `convert` that
 *   maps each record to a `SpanRow` (`rows.ts`) with `context.row` (inside `readRecords`, so a bad
 *   record refuses only its trace). Map the vendor's ids, parent, times (`nanosFrom`), kind,
 *   model, content, tool call, usage, error, and the user and conversation the record names
 *   (never from a tool's arguments or result); keep the whole record in `record`. Leave a field
 *   the source does not record unset: the emitter's documented rules fill in instants and say so.
 * - Add it to {@link importAdapters} below, and a fixture to the exclusivity test so no format
 *   claims another's records.
 * - `manifestFormat` stays `otlp_json` until Hue's import registration lists the new id.
 */
export const importAdapters: readonly ImportAdapter[] = [
  otlpJson,
  langfuseObservations,
  atif,
  braintrust,
  ...otelFamilyAdapters,
];

/** The format that claims a value, the first in registry order. */
export const adapterFor = (value: unknown): ImportAdapter | undefined =>
  importAdapters.find((adapter) => adapter.detect(value));

export const adapterById = (id: string): ImportAdapter | undefined =>
  importAdapters.find((adapter) => adapter.id === id);

/** Why no format claims a value. */
export function unrecognizedReason(value: unknown): string {
  if (Array.isArray(value))
    return value.length ? "a JSON array of no recognized format" : "an empty JSON array";
  if (!isObject(value)) return "not a JSON object";
  if (Array.isArray(value.resourceLogs) || Array.isArray(value.resource_logs))
    return "an OTLP logs export; only traces are imported";
  if (Array.isArray(value.resourceMetrics) || Array.isArray(value.resource_metrics))
    return "an OTLP metrics export; only traces are imported";
  for (const key of ["data", "events", "observations"])
    if (Array.isArray(value[key]) && !(value[key] as unknown[]).length)
      return "an export page with no records";
  return "a JSON document of no recognized format";
}
