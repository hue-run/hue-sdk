import {
  conversionFailure,
  MAX_SOURCE_NESTING,
  nestedTooDeep,
  sha256Hex,
  type ConvertedTrace,
} from "../traces-import-convert.js";
import type {
  ConvertContext,
  ImportAdapter,
  Location,
  TraceCollector,
  ValueSource,
} from "./adapter.js";
import { decodeContainer, parseValues, type ParsedValue } from "./containers.js";
import { applyIdentityKeys, traceIdentity, type IdentityKeys } from "./identity.js";
import { binaryValues } from "./otlp-protobuf.js";
import { adapterFor, importAdapters, unrecognizedReason } from "./registry.js";
import { RowTraceCollector, rowTraceId } from "./rows.js";

export type { Location } from "./adapter.js";

/**
 * Reads source files through the containers and the format registry (`registry.ts`) and gathers
 * every trace they hold, with what could not be read: files, records (lines of JSON Lines,
 * records of a JSON array) and traces, each named with where it was found.
 */

/** Records of one file reported as not read, or notes on one file; past this many the rest are
 * counted. */
const MAX_REPORTED_PER_FILE = 100;
/** Records of a JSON array no format reads, in a row from its start, after which the rest of the
 * array is not looked at: it is not an export of any format. */
const MAX_UNCLAIMED_RUN = 1000;

export interface ReadResult {
  /** Every trace read, in trace id order, its identity read as Hue reads it. */
  traces: ConvertedTrace[];
  supported: { file: string; format: string; traces: number }[];
  unsupported: { file: string; reason: string }[];
  skipped: (Location & { reason: string })[];
  /** What was read with a repair, or read once though the input held it more than once. */
  notes: (Location & { reason: string })[];
  refused: (Partial<Location> & { trace_id?: string; reason: string })[];
}

/** One file's reported records: the first `MAX_REPORTED_PER_FILE` kept, the rest counted. */
class Reported {
  readonly items: (Location & { reason: string })[] = [];
  private more = 0;
  constructor(private readonly file: string) {}
  add(item: Omit<Location, "file"> & { reason: string }): void {
    if (this.items.length < MAX_REPORTED_PER_FILE) this.items.push({ file: this.file, ...item });
    else this.more++;
  }
  /** The kept items in the order of the file, and one counting the rest. */
  finish(what: string): (Location & { reason: string })[] {
    const items = this.items.sort(
      (a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.record ?? 0) - (b.record ?? 0),
    );
    return this.more ? [...items, { file: this.file, reason: `${this.more} more ${what}` }] : items;
  }
}

/** Where a duplicate was first read, as the report names it from `file`. */
function where(earlier: Location, file: string): string {
  const position =
    earlier.line !== undefined
      ? `line ${earlier.line}`
      : earlier.record !== undefined
        ? `record ${earlier.record}`
        : "";
  if (earlier.file === file) return position || "earlier in the file";
  return position ? `${earlier.file} ${position}` : earlier.file;
}

export class ImportReader {
  /** Run-wide collectors, by format id or by the key formats that share one name. */
  private readonly collectors = new Map<string, TraceCollector>();
  /** The shared collector key of each format that named one. */
  private readonly sharedKeys = new Map<string, string>();
  private readonly rowCollectors = new Map<string, RowTraceCollector>();
  private readonly whole: ConvertedTrace[] = [];
  /** Traces already refused and named; a collector's own refusal of one is not repeated. */
  private readonly refusedTraces = new Set<string>();
  /** The file names each content digest was read under. */
  private readonly fileNames = new Map<string, Set<string>>();
  private readonly supported = new Map<string, ReadResult["supported"][number]>();
  private readonly result: Omit<ReadResult, "traces" | "supported">;

  /** `unsupported` is where files that cannot be read are listed, in the order they are read. */
  constructor(
    private readonly options: {
      maxFileBytes: number;
      keys?: IdentityKeys;
      unsupported?: ReadResult["unsupported"];
    },
  ) {
    this.result = {
      unsupported: options.unsupported ?? [],
      skipped: [],
      notes: [],
      refused: [],
    };
  }

  /** Reads one file's bytes; returns what its content decompressed to (`held`) and what that
   * counts against the bounds (`counted`, at least `held`): each zstd frame at least a minimum, and
   * damage more (see {@link decodeContainer}). */
  read(file: string, raw: Uint8Array): { held: number; counted: number } {
    const decoded = decodeContainer(raw, this.options.maxFileBytes);
    const sized = (held: number, counted = 0) => ({ held, counted: Math.max(held, counted) });
    if ("unsupported" in decoded) {
      this.result.unsupported.push({ file, reason: decoded.unsupported });
      return sized(Math.max(raw.byteLength, decoded.held ?? 0), decoded.counted);
    }
    const binary = binaryValues(decoded.bytes, this.options.maxFileBytes);
    const parsed = binary ?? parseValues(decoded.bytes);
    if ("unsupported" in parsed) {
      this.result.unsupported.push({ file, reason: parsed.unsupported });
      return sized(decoded.bytes.byteLength, decoded.counted);
    }
    // A length-prefixed file counts what its messages count, or what undoing its own compression
    // counted when that is more.
    const size = () =>
      "counted" in parsed
        ? sized(parsed.bytes(), Math.max(parsed.counted(), decoded.counted ?? 0))
        : sized(decoded.bytes.byteLength, decoded.counted);
    const digest = sha256Hex(decoded.bytes);
    const skipped = new Reported(file);
    const notes = new Reported(file);
    if (decoded.note) notes.add({ reason: decoded.note });
    const failures: string[] = [];
    let claimed = false;
    let firstReason: string | undefined;
    /** Converts a value with the format that claims it; the reason it was not read otherwise. */
    const offer = (value: unknown, source: ValueSource): string | undefined => {
      const adapter = adapterFor(value);
      if (!adapter) return unrecognizedReason(value);
      try {
        this.convert(adapter, value, file, source, notes);
      } catch (error) {
        const failure = conversionFailure(error);
        if (!failure) throw error;
        failures.push(failure.message);
        return failure.message;
      }
      claimed = true;
      const key = `${file}\u0000${adapter.id}`;
      if (!this.supported.has(key))
        this.supported.set(key, { file, format: adapter.id, traces: 0 });
      return undefined;
    };
    const tooDeep = `JSON nested more than ${MAX_SOURCE_NESTING} levels deep`;
    /** The records of an array no format reads whole, each offered on its own. */
    const offerRecords = (records: unknown[], source: ValueSource, line: { line?: number }) => {
      let run = 0;
      let claimedAny = false;
      for (const [index, element] of records.entries()) {
        if (!claimedAny && run >= MAX_UNCLAIMED_RUN) {
          skipped.add({
            ...line,
            reason: `${records.length - index} more records not read: no format reads the first ${MAX_UNCLAIMED_RUN}`,
          });
          return;
        }
        let problem: string | undefined;
        if (nestedTooDeep(element)) problem = tooDeep;
        else {
          let text: string | undefined;
          // A record's text is made only when a format asks for it.
          problem = offer(element, {
            digest,
            unsafeIntegers: source.unsafeIntegers,
            get text() {
              return (text ??= JSON.stringify(element));
            },
            get bytes() {
              return Buffer.byteLength(this.text);
            },
            ...line,
            index,
          });
        }
        if (problem === undefined) claimedAny = true;
        else {
          run++;
          skipped.add({ ...line, record: index + 1, reason: problem });
        }
      }
    };
    for (const item of parsed.values as Iterable<ParsedValue>) {
      const line = item.line !== undefined ? { line: item.line } : {};
      const source: ValueSource = {
        digest,
        get text() {
          return item.text;
        },
        get bytes() {
          return Buffer.byteLength(item.text);
        },
        unsafeIntegers: item.unsafeIntegers,
        ...line,
      };
      if (item.note) notes.add({ ...line, reason: item.note });
      const deep = nestedTooDeep(item.value);
      const reason = deep ? tooDeep : offer(item.value, source);
      firstReason ??= reason;
      if (reason === undefined) continue;
      // An array no format reads whole (or too deep to read whole) is read record by record.
      if (
        Array.isArray(item.value) &&
        item.value.length &&
        (deep || adapterFor(item.value) === undefined)
      ) {
        offerRecords(item.value, source, line);
        continue;
      }
      skipped.add({ ...line, reason });
    }
    for (const problem of parsed.problems) skipped.add(problem);
    if (!claimed) {
      // Nothing in the file was read: the file is reported, not each of its records.
      this.result.unsupported.push({
        file,
        reason: failures[0] ?? firstReason ?? parsed.problems[0]?.reason ?? "no value was read",
      });
      return size();
    }
    const names = this.fileNames.get(digest) ?? new Set<string>();
    this.fileNames.set(digest, names.add(file));
    this.result.skipped.push(...skipped.finish("records were not read"));
    this.result.notes.push(...notes.finish("notes"));
    return size();
  }

  private rows(format: string): RowTraceCollector {
    let collector = this.rowCollectors.get(format);
    if (!collector) {
      collector = new RowTraceCollector(format, this.options.keys);
      this.rowCollectors.set(format, collector);
    }
    return collector;
  }

  private convert(
    adapter: ImportAdapter,
    value: unknown,
    file: string,
    source: ValueSource,
    notes: Reported,
  ): void {
    const at: Location = {
      file,
      ...(source.line !== undefined ? { line: source.line } : {}),
      ...(source.index !== undefined ? { record: source.index + 1 } : {}),
    };
    // Rows the value gave and those an identical copy of which was already read elsewhere: a
    // value that gave nothing new is noted, so a collapsed duplicate is never silent. When every
    // copy read here is the one kept (an MLflow trace whose info sorts first), the note says so.
    let rows = 0;
    let duplicates = 0;
    let replaced = 0;
    let earlier: Location | undefined;
    const repeats = new Map<string, number>();
    const context: ConvertContext = {
      source,
      keys: this.options.keys ?? {},
      row: (row) => {
        rows++;
        const copy = this.rows(adapter.id).add(row, source.digest, at);
        if (copy) {
          duplicates++;
          if (copy.replaced) replaced++;
          earlier ??= copy.earlier;
        }
      },
      event: (event) => this.rows(adapter.id).addEvent(event, source.digest, repeats),
      trace: (trace) => {
        trace.format = adapter.id;
        trace.sourceDigests.add(source.digest);
        this.whole.push(trace);
      },
      refuse: (reason, traceKey) => {
        const traceId = traceKey === undefined ? undefined : rowTraceId(adapter.id, traceKey);
        if (traceId) this.refusedTraces.add(traceId);
        this.result.refused.push({ ...at, ...(traceId ? { trace_id: traceId } : {}), reason });
      },
      collector: <T extends TraceCollector>(create: () => T, shared?: string): T => {
        if (shared !== undefined) this.sharedKeys.set(adapter.id, shared);
        const key = shared ?? adapter.id;
        // A format always creates the same kind of collector, and formats that share one create
        // the same kind, so the one held is a T.
        const held = this.collectors.get(key) as T | undefined;
        if (held) return held;
        const created = create();
        this.collectors.set(key, created);
        return created;
      },
    };
    adapter.convert(value, context);
    if (rows && duplicates === rows && earlier)
      notes.add({
        ...(at.line !== undefined ? { line: at.line } : {}),
        ...(at.record !== undefined ? { record: at.record } : {}),
        reason: `the same ${rows === 1 ? "record" : "records"} as ${where(earlier, file)}, read once${replaced === rows ? " from this copy" : ""}`,
      });
  }

  /** Every trace read, merged across files: the same trace from two sources is one trace when
   * its spans agree, and refused when they differ. */
  finish(): ReadResult {
    const traces = new Map<string, ConvertedTrace>();
    const conflicts = new Map<string, string>();
    const kept = new Set<ConvertedTrace>();
    // A trace refused after another format's copy of it was merged is left out with it.
    const refuse = (traceId: string | undefined, reason: string) => {
      if (traceId !== undefined) traces.delete(traceId);
      if (traceId !== undefined && this.refusedTraces.has(traceId)) return;
      if (traceId !== undefined) this.refusedTraces.add(traceId);
      this.result.refused.push({ ...(traceId !== undefined ? { trace_id: traceId } : {}), reason });
    };
    const merge = (trace: ConvertedTrace) => {
      if (this.refusedTraces.has(trace.traceId)) return;
      const held = traces.get(trace.traceId);
      if (!held) traces.set(trace.traceId, trace);
      else if (JSON.stringify(held.entries) !== JSON.stringify(trace.entries))
        conflicts.set(trace.traceId, "the trace appears in two sources with different content");
      else for (const digest of trace.sourceDigests) held.sourceDigests.add(digest);
    };
    const finishedShared = new Set<string>();
    for (const adapter of importAdapters) {
      const shared = this.sharedKeys.get(adapter.id);
      // A shared collector is finished once, under the first of its formats.
      const done = shared !== undefined && finishedShared.has(shared);
      if (shared !== undefined) finishedShared.add(shared);
      for (const [collector, rowFormat] of [
        [done ? undefined : this.collectors.get(shared ?? adapter.id), false],
        [this.rowCollectors.get(adapter.id), true],
      ] as const) {
        if (!collector) continue;
        const finished = collector.finish();
        for (const problem of finished.refused) refuse(problem.traceId, problem.reason);
        for (const trace of finished.traces) {
          if (rowFormat || shared === undefined) trace.format = adapter.id;
          // Spans the shared emitter wrote already carry the identity keys' user and session.
          if (!rowFormat && !collector.appliesKeys) kept.add(trace);
          merge(trace);
        }
      }
    }
    for (const trace of this.whole) {
      kept.add(trace);
      merge(trace);
    }
    for (const [traceId, reason] of conflicts) refuse(traceId, reason);
    // A trace a shared collector gathered from files of several formats counts for each file
    // under the format it was read with.
    const group = (format: string) => this.sharedKeys.get(format) ?? format;
    const byGroup = new Map<string, ReadResult["supported"][number]>();
    for (const entry of this.supported.values()) {
      const key = `${entry.file}\u0000${group(entry.format)}`;
      if (!byGroup.has(key)) byGroup.set(key, entry);
    }
    const ordered: ConvertedTrace[] = [];
    for (const trace of [...traces.values()].sort((a, b) => (a.traceId < b.traceId ? -1 : 1))) {
      try {
        if (kept.has(trace)) applyIdentityKeys(trace, this.options.keys ?? {});
        const identity = traceIdentity(trace.entries);
        if (identity) trace.identity = identity;
        else delete trace.identity;
      } catch (error) {
        const failure = conversionFailure(error);
        if (!failure) throw error;
        refuse(trace.traceId, failure.message);
        continue;
      }
      ordered.push(trace);
      for (const digest of trace.sourceDigests)
        for (const name of this.fileNames.get(digest) ?? []) {
          const entry =
            this.supported.get(`${name}\u0000${trace.format}`) ??
            byGroup.get(`${name}\u0000${group(trace.format)}`);
          if (entry) entry.traces++;
        }
    }
    return { traces: ordered, supported: [...this.supported.values()], ...this.result };
  }
}
