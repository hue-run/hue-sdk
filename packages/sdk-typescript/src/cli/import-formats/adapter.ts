import type { ConvertedTrace, Refusal, TraceImportFormat } from "../traces-import-convert.js";
import type { IdentityKeys } from "./identity.js";
import type { EventRow, SpanRow } from "./rows.js";

/**
 * The contract every import format implements; see `registry.ts` for how the formats are tried
 * and how to add one.
 */

/** A source format `hue traces import prepare` reads. */
export interface ImportAdapter {
  /** The format's id: `hue.import.format` on every span it emits, the report's name for it and
   * the namespace of the ids it derives. Lowercase, `[a-z0-9_]`. */
  readonly id: string;
  /** The format Hue's import registration knows the traces under (`source.formats` of the
   * manifest). A format that emits canonical rows declares `otlp_json`, the encoding of the
   * batches it writes, until Hue lists its own id. */
  readonly manifestFormat: TraceImportFormat;
  /** Whether a parsed JSON value is this format's: a whole document, one record of a JSON array,
   * or one line of JSON Lines. Decided by distinctive top-level keys alone, never by a file name,
   * and never claiming another format's value. */
  detect(value: unknown): boolean;
  /** Reads one value `detect` claimed. Rows, events and traces go to the context; a record that
   * cannot be read is reported with `context.refuse` and the rest of the value is still read.
   * Throwing a `ConversionError` reports the whole value as unreadable, with its message. */
  convert(value: unknown, context: ConvertContext): void;
}

/** Where a record was read, for the report: never written to a span. */
export interface Location {
  file: string;
  /** 1-based line of JSON Lines. */
  line?: number;
  /** 1-based position in a JSON array. */
  record?: number;
}

/** Where a value was read, for the report: never written to a span. */
export interface ValueSource {
  /** The SHA-256 of the file's decoded content: the same for a renamed or recompressed copy. */
  readonly digest: string;
  /** The JSON text the value was parsed from: the document or the line (an array record has
   * its re-serialized text). */
  readonly text: string;
  /** The UTF-8 size of `text`. */
  readonly bytes: number;
  /** Whether the text held an integer JavaScript cannot represent exactly; such an integer is
   * kept as its decimal text in the parsed value. */
  readonly unsafeIntegers: boolean;
  /** The value's 1-based line, for JSON Lines. */
  readonly line?: number;
  /** The value's 0-based position, for a record of a JSON array. */
  readonly index?: number;
}

/** Run-wide state a format gathers across files and lines; `finish` runs once all are read. */
export interface TraceCollector {
  finish(): { traces: ConvertedTrace[]; refused: Refusal[] };
  /** Whether the traces it emits already carry `--user-key` and `--session-key`, as the shared
   * row emitter writes them; otherwise the reader applies the keys to its traces. */
  readonly appliesKeys?: boolean;
}

/** What a format's `convert` hands its results to. */
export interface ConvertContext {
  readonly source: ValueSource;
  /** `--user-key` and `--session-key`, for a collector that emits rows itself. */
  readonly keys: IdentityKeys;
  /** Adds one canonical span row; rows are grouped into traces by `traceKey` across every file
   * and line, and emitted as OTLP spans by the shared emitter (`rows.ts`). */
  row(row: SpanRow): void;
  /** Attaches an event (a log line, a message) to a span row by its trace and span keys. */
  event(event: EventRow): void;
  /** Adds a trace the format converted whole. */
  trace(trace: ConvertedTrace): void;
  /** Reports a record that could not be read. With the record's `traceKey`, that trace is
   * refused whole and named; without one, the record alone is reported. */
  refuse(reason: string, traceKey?: string): void;
  /** This format's run-wide collector, created on first use by `create`. Formats that name the
   * same `shared` key share one collector, so a trace whose spans they split between files is
   * gathered as one; a shared collector names each trace's format itself. */
  collector<T extends TraceCollector>(create: () => T, shared?: string): T;
}
