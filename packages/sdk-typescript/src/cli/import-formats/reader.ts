import { ConversionError, sha256Hex, type ConvertedTrace } from "../traces-import-convert.js";
import type { ConvertContext, ImportAdapter, TraceCollector, ValueSource } from "./adapter.js";
import { decodeContainer, parseValues } from "./containers.js";
import { applyIdentityKeys, traceIdentity, type IdentityKeys } from "./identity.js";
import { adapterFor, importAdapters, unrecognizedReason } from "./registry.js";
import { RowTraceCollector, rowTraceId } from "./rows.js";

/**
 * Reads source files through the containers and the format registry (`registry.ts`) and gathers
 * every trace they hold, with what could not be read: files, records (lines of JSON Lines,
 * records of a JSON array) and traces, each named with where it was found.
 */

/** Records of one file reported as not read; past this many the rest are counted. */
const MAX_SKIPPED_PER_FILE = 100;

export interface Location {
  file: string;
  /** 1-based line of JSON Lines. */
  line?: number;
  /** 1-based position in a JSON array. */
  record?: number;
}

export interface ReadResult {
  /** Every trace read, in trace id order, its identity read as Hue reads it. */
  traces: ConvertedTrace[];
  supported: { file: string; format: string; traces: number }[];
  unsupported: { file: string; reason: string }[];
  skipped: (Location & { reason: string })[];
  refused: (Partial<Location> & { trace_id?: string; reason: string })[];
}

export class ImportReader {
  private readonly collectors = new Map<string, TraceCollector>();
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
    this.result = { unsupported: options.unsupported ?? [], skipped: [], refused: [] };
  }

  /** Reads one file's bytes; returns the size of its decoded content. */
  read(file: string, raw: Uint8Array): number {
    const decoded = decodeContainer(raw, this.options.maxFileBytes);
    if ("unsupported" in decoded) {
      this.result.unsupported.push({ file, reason: decoded.unsupported });
      return raw.byteLength;
    }
    const parsed = parseValues(decoded.bytes);
    if ("unsupported" in parsed) {
      this.result.unsupported.push({ file, reason: parsed.unsupported });
      return decoded.bytes.byteLength;
    }
    const digest = sha256Hex(decoded.bytes);
    const skipped: ReadResult["skipped"] = parsed.problems.map((problem) => ({ file, ...problem }));
    const failures: string[] = [];
    let claimed = false;
    /** Converts a value with the format that claims it; the reason it was not read otherwise. */
    const offer = (value: unknown, source: ValueSource): string | undefined => {
      const adapter = adapterFor(value);
      if (!adapter) return unrecognizedReason(value);
      try {
        this.convert(adapter, value, file, source);
      } catch (error) {
        if (!(error instanceof ConversionError)) throw error;
        failures.push(error.message);
        return error.message;
      }
      claimed = true;
      const key = `${file}\u0000${adapter.id}`;
      if (!this.supported.has(key))
        this.supported.set(key, { file, format: adapter.id, traces: 0 });
      return undefined;
    };
    for (const item of parsed.values) {
      const line = item.line !== undefined ? { line: item.line } : {};
      const source: ValueSource = {
        digest,
        text: item.text,
        bytes: Buffer.byteLength(item.text),
        unsafeIntegers: item.unsafeIntegers,
        ...line,
      };
      const reason = offer(item.value, source);
      if (reason === undefined) continue;
      if (Array.isArray(item.value) && item.value.length && adapterFor(item.value) === undefined) {
        for (const [index, element] of item.value.entries()) {
          const text = JSON.stringify(element);
          const problem = offer(element, {
            ...source,
            text,
            bytes: Buffer.byteLength(text),
            index,
          });
          if (problem !== undefined)
            skipped.push({ file, ...line, record: index + 1, reason: problem });
        }
        continue;
      }
      skipped.push({ file, ...line, reason });
    }
    if (!claimed) {
      // Nothing in the file was read: the file is reported, not each of its records.
      this.result.unsupported.push({
        file,
        reason: failures[0] ?? unrecognizedReason(parsed.values[0]!.value),
      });
      return decoded.bytes.byteLength;
    }
    const names = this.fileNames.get(digest) ?? new Set<string>();
    this.fileNames.set(digest, names.add(file));
    this.result.skipped.push(...skipped.slice(0, MAX_SKIPPED_PER_FILE));
    if (skipped.length > MAX_SKIPPED_PER_FILE)
      this.result.skipped.push({
        file,
        reason: `${skipped.length - MAX_SKIPPED_PER_FILE} more records were not read`,
      });
    return decoded.bytes.byteLength;
  }

  private rows(format: string): RowTraceCollector {
    let collector = this.rowCollectors.get(format);
    if (!collector) {
      collector = new RowTraceCollector(format, this.options.keys);
      this.rowCollectors.set(format, collector);
    }
    return collector;
  }

  private convert(adapter: ImportAdapter, value: unknown, file: string, source: ValueSource): void {
    const at: Location = {
      file,
      ...(source.line !== undefined ? { line: source.line } : {}),
      ...(source.index !== undefined ? { record: source.index + 1 } : {}),
    };
    const context: ConvertContext = {
      source,
      row: (row) => this.rows(adapter.id).add(row, source.digest),
      event: (event) => this.rows(adapter.id).addEvent(event, source.digest),
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
      collector: <T extends TraceCollector>(create: () => T): T => {
        // A format always creates the same kind of collector, so the one it created is a T.
        const held = this.collectors.get(adapter.id) as T | undefined;
        if (held) return held;
        const created = create();
        this.collectors.set(adapter.id, created);
        return created;
      },
    };
    adapter.convert(value, context);
  }

  /** Every trace read, merged across files: the same trace from two sources is one trace when
   * its spans agree, and refused when they differ. */
  finish(): ReadResult {
    const traces = new Map<string, ConvertedTrace>();
    const conflicts = new Map<string, string>();
    const kept = new Set<ConvertedTrace>();
    const refuse = (traceId: string | undefined, reason: string) => {
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
    for (const adapter of importAdapters)
      for (const [collector, rowFormat] of [
        [this.collectors.get(adapter.id), false],
        [this.rowCollectors.get(adapter.id), true],
      ] as const) {
        if (!collector) continue;
        const finished = collector.finish();
        for (const problem of finished.refused) refuse(problem.traceId, problem.reason);
        for (const trace of finished.traces) {
          trace.format = adapter.id;
          // Spans the shared emitter wrote already carry the identity keys' user and session.
          if (!rowFormat) kept.add(trace);
          merge(trace);
        }
      }
    for (const trace of this.whole) {
      kept.add(trace);
      merge(trace);
    }
    for (const [traceId, reason] of conflicts) {
      traces.delete(traceId);
      refuse(traceId, reason);
    }
    const ordered = [...traces.values()].sort((a, b) => (a.traceId < b.traceId ? -1 : 1));
    for (const trace of ordered) {
      if (kept.has(trace)) applyIdentityKeys(trace, this.options.keys ?? {});
      const identity = traceIdentity(trace.entries);
      if (identity) trace.identity = identity;
      else delete trace.identity;
      for (const digest of trace.sourceDigests)
        for (const name of this.fileNames.get(digest) ?? []) {
          const entry = this.supported.get(`${name}\u0000${trace.format}`);
          if (entry) entry.traces++;
        }
    }
    return { traces: ordered, supported: [...this.supported.values()], ...this.result };
  }
}
