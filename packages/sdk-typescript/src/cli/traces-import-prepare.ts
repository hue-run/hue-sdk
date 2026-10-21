import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { sdkVersion } from "../version.js";
import type { IdentityKeys } from "./import-formats/identity.js";
import { ImportReader, type ReadResult } from "./import-formats/reader.js";
import { adapterById } from "./import-formats/registry.js";
import {
  batchEntries,
  ConversionError,
  manifestTotals,
  manifestTraceHasIdentity,
  traceImportFormats,
  traceImportLimits,
  validateManifest,
  type ManifestTrace,
  type TraceImportFormat,
  type TraceImportManifest,
  type TraceImportOrigin,
  type TraceImportTotals,
} from "./traces-import-convert.js";
import { isZipSignature, ZipArchive, ZipError } from "./traces-import-zip.js";

/**
 * `hue traces import prepare`: reads a file, a directory or a ZIP archive, converts every trace
 * the format registry (`import-formats/registry.ts`) recognizes and writes the bundle Hue's
 * import routes take: one gzip OTLP/JSON file per batch, one file per large value, and
 * `manifest.json`, whose digest and totals `prepare_trace_import` is called with. Nothing is sent
 * anywhere.
 */

/** Bounds on what one preparation reads. */
export const PREPARE_LIMITS = {
  /** One source file, or one archive member. */
  fileBytes: 64 * 1024 * 1024,
  /** Every source file together. */
  totalBytes: 1024 * 1024 * 1024,
  /** Files one directory tree or archive may hold. */
  files: 50_000,
  /** How deep a directory tree is walked. */
  depth: 32,
} as const;

export const MANIFEST_FILE = "manifest.json";
export const PROGRESS_FILE = "progress.json";
const BATCH_FILE = /^[0-9a-f]{32}\.[0-9a-f]{64}\.json\.gz$/;
const BLOB_FILE = /^[0-9a-f]{64}\.blob$/;

export interface PrepareReport {
  manifest_digest: string;
  totals: TraceImportTotals;
  source: TraceImportManifest["source"];
  output_directory: string;
  /** Traces prepared per format id, for the formats that held any. */
  formats: Record<string, number>;
  files: {
    supported: ReadResult["supported"];
    /** Files of which nothing could be read, and why. */
    unsupported: ReadResult["unsupported"];
    /** Records of a read file (a line of JSON Lines, a record of a JSON array) that were not. */
    skipped: ReadResult["skipped"];
  };
  traces: {
    without_identity: number;
    by_origin: Record<TraceImportOrigin, number>;
    /** Traces whose vendor ids were mapped to OpenTelemetry ids, and the spans so mapped. */
    remapped: { traces: number; spans: number };
    /** Traces a documented rule supplied instants for, per rule (`hue.import.timing`). */
    timing: Record<string, number>;
    /** Traces and records the sources held that could not be converted. */
    refused: ReadResult["refused"];
  };
  blobs: number;
}

export class PrepareError extends Error {}

/** One source file as the walk found it: its name for the report and its bytes on demand. */
interface SourceFile {
  name: string;
  size: number;
  read: () => Promise<Uint8Array>;
}

const posixPath = (path: string) => path.split(sep).join("/");

async function readHead(path: string, length: number): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * The source files under `input`: a file, every regular file of a directory tree (symbolic links
 * are listed and left unread), and every readable member of a ZIP archive found at either place.
 * The walk is bounded and its order does not matter: the manifest is sorted by trace id.
 */
async function* sourceFiles(
  input: string,
  unsupported: PrepareReport["files"]["unsupported"],
): AsyncGenerator<SourceFile> {
  const root = resolve(input);
  const info = await stat(root);
  let count = 0;
  const seen = () => {
    if (++count > PREPARE_LIMITS.files)
      throw new PrepareError(`The input holds more than ${PREPARE_LIMITS.files} files`);
  };
  /** Why an entry the walk listed could not be opened: the system's code, when it gave one. */
  const unreadable = (what: string, error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    return `the ${what} could not be read${code ? ` (${code})` : ""}`;
  };
  async function* file(path: string, name: string): AsyncGenerator<SourceFile> {
    seen();
    let size: number;
    let head: Uint8Array;
    try {
      size = (await stat(path)).size;
      head = await readHead(path, 4);
    } catch (error) {
      // A file the walk can list but not open (permissions, a file removed meanwhile) is
      // reported; the rest of the input is still prepared.
      unsupported.push({ file: name, reason: unreadable("file", error) });
      return;
    }
    if (isZipSignature(head)) {
      yield* archive(path, name);
      return;
    }
    if (size > PREPARE_LIMITS.fileBytes) {
      unsupported.push({ file: name, reason: `larger than ${PREPARE_LIMITS.fileBytes} bytes` });
      return;
    }
    yield { name, size, read: () => readFile(path) };
  }
  async function* archive(path: string, name: string): AsyncGenerator<SourceFile> {
    let zip: ZipArchive;
    try {
      zip = await ZipArchive.open(path);
    } catch (error) {
      unsupported.push({
        file: name,
        reason: error instanceof ZipError ? error.message : "the archive could not be read",
      });
      return;
    }
    // Each member is read while its archive is open; the archive is closed as soon as its last
    // member was handed out (or the walk ended early), never held until the whole tree is read.
    try {
      for (const member of zip.members) {
        if (member.path.endsWith("/")) continue;
        const memberName = `${name}/${member.path}`;
        seen();
        if (member.refused) {
          unsupported.push({ file: memberName, reason: member.refused });
          continue;
        }
        yield { name: memberName, size: member.size, read: () => zip.read(member) };
      }
    } finally {
      await zip.close().catch(() => {});
    }
  }
  async function* directory(path: string, depth: number): AsyncGenerator<SourceFile> {
    if (depth > PREPARE_LIMITS.depth)
      throw new PrepareError(`The directory tree is deeper than ${PREPARE_LIMITS.depth} levels`);
    let entries: Dirent[];
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      // The input itself must be readable; a subdirectory that is not is reported and skipped.
      if (depth === 0) throw error;
      seen();
      unsupported.push({
        file: posixPath(relative(root, path)),
        reason: unreadable("directory", error),
      });
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const child = join(path, entry.name);
      const name = posixPath(relative(root, child));
      if (entry.isSymbolicLink()) {
        seen();
        unsupported.push({ file: name, reason: "a symbolic link" });
      } else if (entry.isDirectory()) yield* directory(child, depth + 1);
      else if (entry.isFile()) yield* file(child, name);
      else {
        seen();
        unsupported.push({ file: name, reason: "not a regular file" });
      }
    }
  }
  if (info.isDirectory()) yield* directory(root, 0);
  else if (info.isFile()) yield* file(root, basename(root));
  else throw new PrepareError("The input is neither a file nor a directory");
}

/** The default output directory: `<input>.hue-import` beside the input. */
export function defaultOutputDirectory(input: string): string {
  const path = resolve(input);
  return `${path.endsWith(sep) ? path.slice(0, -1) : path}.hue-import`;
}

/** Creates the output directory (mode 0700), or accepts one that holds only an earlier
 * preparation's files; a directory an upload has started in is refused. */
async function prepareOutputDirectory(directory: string): Promise<void> {
  let existing: string[];
  try {
    existing = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return;
  }
  if (existing.includes(PROGRESS_FILE))
    throw new PrepareError(
      `${directory} holds an upload in progress (${PROGRESS_FILE}); choose another --out`,
    );
  const own = (name: string) =>
    name === MANIFEST_FILE || BATCH_FILE.test(name) || BLOB_FILE.test(name);
  /** A temporary file this helper writes before its rename (`<file>.tmp`), left behind when a
   * preparation or an upload was interrupted between the two. */
  const ownTemporary = (name: string) =>
    name.endsWith(".tmp") && (own(name.slice(0, -4)) || name.slice(0, -4) === PROGRESS_FILE);
  const foreign = existing.filter((name) => !own(name) && !ownTemporary(name));
  if (foreign.length)
    throw new PrepareError(`${directory} is not empty (${foreign[0]}); choose another --out`);
  for (const name of existing.filter(ownTemporary)) {
    const path = join(directory, name);
    const regular = await stat(path)
      .then((info) => info.isFile())
      .catch(() => false);
    if (!regular)
      throw new PrepareError(`${directory} is not empty (${name}); choose another --out`);
    // The file it stood for is written again from scratch.
    await rm(path, { force: true });
  }
}

/** Why a manifest cannot be registered, or undefined: Hue reads at most 32 MiB decoded and takes
 * at most 4 MiB on the wire, gzip as the upload sends it. Checked here, before any upload. */
export function manifestTooLarge(bytes: Uint8Array): string | undefined {
  // No division by a name: the published package's import-boundary check reads one as a regex.
  const mebibytes = (value: number) => `${Math.ceil(value * 2 ** -20)} MiB`;
  if (bytes.byteLength > traceImportLimits.manifestBytes)
    return `The manifest is ${mebibytes(bytes.byteLength)}, over the ${mebibytes(traceImportLimits.manifestBytes)} Hue reads; prepare the input in smaller parts`;
  const wire = gzipSync(bytes, { level: 6 }).byteLength;
  if (wire > traceImportLimits.manifestWireBytes)
    return `The manifest is ${mebibytes(wire)} compressed, over the ${mebibytes(traceImportLimits.manifestWireBytes)} a registration takes; prepare the input in smaller parts`;
  return undefined;
}

async function writePrivate(path: string, bytes: Uint8Array | string): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600, flag: "w" });
  await rename(temporary, path);
}

export interface PrepareOptions {
  out?: string;
  /** `--user-key` and `--session-key` (`import-formats/identity.ts`). */
  keys?: IdentityKeys;
}

/** Prepares the bundle; resolves to the report, or throws a {@link PrepareError}. */
export async function prepareTraceBundle(
  input: string,
  options: PrepareOptions = {},
): Promise<PrepareReport> {
  const outputDirectory = resolve(options.out ?? defaultOutputDirectory(input));
  const unsupported: PrepareReport["files"]["unsupported"] = [];
  const reader = new ImportReader({
    maxFileBytes: PREPARE_LIMITS.fileBytes,
    unsupported,
    ...(options.keys ? { keys: options.keys } : {}),
  });
  let totalBytes = 0;
  const countBytes = (bytes: number) => {
    totalBytes += bytes;
    if (totalBytes > PREPARE_LIMITS.totalBytes)
      throw new PrepareError(`The input holds more than ${PREPARE_LIMITS.totalBytes} bytes`);
  };
  for await (const source of sourceFiles(input, unsupported)) {
    countBytes(source.size);
    let bytes: Uint8Array;
    try {
      bytes = await source.read();
    } catch (error) {
      unsupported.push({
        file: source.name,
        reason: error instanceof ZipError ? error.message : "the file could not be read",
      });
      continue;
    }
    // Decompressed content counts toward the bound too.
    countBytes(Math.max(0, reader.read(source.name, bytes) - bytes.byteLength));
  }
  const read = reader.finish();
  const refused = read.refused;
  const traces = read.traces;
  if (!traces.length) {
    const problems = [...unsupported, ...read.skipped, ...refused]
      .slice(0, 3)
      .map((item) => item.reason);
    throw new PrepareError(
      `No trace was recognized in ${input}${problems.length ? ` (${problems.join("; ")})` : ""}`,
    );
  }
  if (traces.length > traceImportLimits.traces)
    throw new PrepareError(
      `The input holds ${traces.length} traces; one import takes at most ${traceImportLimits.traces}`,
    );
  await prepareOutputDirectory(outputDirectory);

  const manifestTraces: ManifestTrace[] = [];
  const formats = new Set<TraceImportFormat>();
  const formatCounts: Record<string, number> = {};
  const timing: Record<string, number> = {};
  const byOrigin: Record<TraceImportOrigin, number> = {
    production: 0,
    evaluation: 0,
    simulation: 0,
    unknown: 0,
  };
  const written = new Set<string>();
  let withoutIdentity = 0;
  let remappedTraces = 0;
  let remappedSpans = 0;
  let blobCount = 0;
  for (const trace of traces) {
    const problem =
      trace.entries.length > traceImportLimits.spansPerTrace
        ? `more than ${traceImportLimits.spansPerTrace} spans`
        : trace.blobs.length > traceImportLimits.blobsPerTrace
          ? `more than ${traceImportLimits.blobsPerTrace} large values`
          : undefined;
    if (problem) {
      refused.push({ trace_id: trace.traceId, reason: problem });
      continue;
    }
    let batches: ReturnType<typeof batchEntries>;
    try {
      batches = batchEntries(trace.entries);
    } catch (error) {
      if (!(error instanceof ConversionError)) throw error;
      refused.push({ trace_id: trace.traceId, reason: error.message });
      continue;
    }
    if (batches.length > traceImportLimits.batchesPerTrace) {
      refused.push({
        trace_id: trace.traceId,
        reason: `more than ${traceImportLimits.batchesPerTrace} batches`,
      });
      continue;
    }
    for (const batch of batches) {
      const name = `${trace.traceId}.${batch.sha256}.json.gz`;
      if (!written.has(name)) await writePrivate(join(outputDirectory, name), batch.body);
      written.add(name);
    }
    for (const blob of trace.blobs) {
      const name = `${blob.sha256}.blob`;
      if (!written.has(name)) await writePrivate(join(outputDirectory, name), blob.bytes);
      written.add(name);
    }
    const sourceDigest = trace.sourceDigests.size === 1 ? [...trace.sourceDigests][0] : undefined;
    const declared: ManifestTrace = {
      trace_id: trace.traceId,
      span_count: trace.entries.length,
      batches: batches.map((batch) => ({
        sha256: batch.sha256,
        bytes: batch.body.byteLength,
        span_count: batch.spanIds.length,
      })),
      blobs: trace.blobs.map((blob) => ({
        sha256: blob.sha256,
        byte_size: blob.byteSize,
        content_type: blob.contentType,
      })),
      ...(trace.identity ? { identity: trace.identity } : {}),
      origin: trace.origin,
      ...(sourceDigest ? { source_digest: sourceDigest } : {}),
    };
    manifestTraces.push(declared);
    formats.add(adapterById(trace.format)!.manifestFormat);
    formatCounts[trace.format] = (formatCounts[trace.format] ?? 0) + 1;
    for (const rule of trace.inferredTiming ?? []) timing[rule] = (timing[rule] ?? 0) + 1;
    byOrigin[trace.origin]++;
    if (!manifestTraceHasIdentity(declared)) withoutIdentity++;
    if (trace.remappedTraceId || trace.remappedSpans) remappedTraces++;
    remappedSpans += trace.remappedSpans;
    blobCount += trace.blobs.length;
  }
  if (!manifestTraces.length)
    throw new PrepareError(`No trace of ${input} could be prepared: ${refused[0]?.reason ?? ""}`);
  const manifest: TraceImportManifest = {
    version: 1,
    source: {
      formats: traceImportFormats.filter((format) => formats.has(format)),
      helper: "hue-sdk",
      helper_version: sdkVersion,
    },
    traces: manifestTraces,
  };
  const invalid = validateManifest(manifest);
  if (invalid) throw new PrepareError(`The prepared manifest is not valid: ${invalid}`);
  const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const tooLarge = manifestTooLarge(bytes);
  if (tooLarge) throw new PrepareError(tooLarge);
  await writePrivate(join(outputDirectory, MANIFEST_FILE), bytes);
  return {
    manifest_digest: createHash("sha256").update(bytes).digest("hex"),
    totals: manifestTotals(manifest),
    source: manifest.source,
    output_directory: outputDirectory,
    formats: formatCounts,
    files: { supported: read.supported, unsupported, skipped: read.skipped },
    traces: {
      without_identity: withoutIdentity,
      by_origin: byOrigin,
      remapped: { traces: remappedTraces, spans: remappedSpans },
      timing,
      refused,
    },
    blobs: blobCount,
  };
}
