import * as zlib from "node:zlib";
import { parseJsonText } from "../traces-import-convert.js";
import { isZipSignature } from "../traces-import-zip.js";

/**
 * What every format reads through: a file's compression (gzip, zstd) undone, its text decoded,
 * and its JSON read as one document or, failing that, as JSON Lines whose every line is read on
 * its own, a line that is not JSON named with its number instead of refusing the file.
 *
 * Damage is contained the same way: a gzip or zstd file that breaks off, or carries bytes after
 * its last member or frame, is read up to the break and the rest named, while a member or frame
 * whose content fails its checksum or declared size leaves the file unread; a line that is not
 * UTF-8 is named and the other lines read; Python's bare `NaN` and `Infinity` are read as null
 * and named.
 */

const GZIP = [0x1f, 0x8b];
const ZSTD = [0x28, 0xb5, 0x2f, 0xfd];
const startsWith = (bytes: Uint8Array, magic: readonly number[], at = 0) =>
  bytes.byteLength >= at + magic.length && magic.every((byte, index) => bytes[at + index] === byte);
/** A zstd skippable frame (`0x184D2A50` to `0x184D2A5F`, little-endian): `pzstd` opens with one. */
const skippable = (bytes: Uint8Array, at = 0) =>
  bytes.byteLength >= at + 4 &&
  (bytes[at]! & 0xf0) === 0x50 &&
  bytes[at + 1] === 0x2a &&
  bytes[at + 2] === 0x4d &&
  bytes[at + 3] === 0x18;
const isZstd = (bytes: Uint8Array, at = 0) => startsWith(bytes, ZSTD, at) || skippable(bytes, at);

const tooLarge = (error: unknown) =>
  error instanceof RangeError ||
  (error as NodeJS.ErrnoException | undefined)?.code === "ERR_BUFFER_TOO_LARGE";

/** The file's content with its compression undone, and what of it could not be read; or why
 * none of it can be. `counted` is what decompressing it counts against the bounds when that is
 * more than the content: each zstd frame counts at least a minimum (see {@link readZstd}). `held`
 * is what a file that is not read decompressed to, when more than its size: past the bound for one
 * that decompresses to more. */
export type Decoded =
  | { bytes: Uint8Array; note?: string; counted?: number }
  | { unsupported: string; held?: number; counted?: number };

/** The file's content with its compression undone, or why it cannot be read. `maxBytes` bounds
 * the decompressed size. */
export function decodeContainer(bytes: Uint8Array, maxBytes: number): Decoded {
  if (!bytes.byteLength) return { unsupported: "the file is empty" };
  let decoded: Decoded = { bytes };
  if (startsWith(bytes, GZIP)) decoded = gunzip(bytes, maxBytes);
  else if (isZstd(bytes)) decoded = unzstd(bytes, maxBytes);
  if ("unsupported" in decoded) return decoded;
  const counts = {
    held: decoded.bytes.byteLength,
    ...(decoded.counted !== undefined ? { counted: decoded.counted } : {}),
  };
  if (decoded.bytes !== bytes) {
    if (startsWith(decoded.bytes, GZIP) || isZstd(decoded.bytes))
      return { unsupported: "a file compressed twice; decompress it first", ...counts };
    if (!decoded.bytes.byteLength) return { unsupported: "the file is empty", ...counts };
  }
  // An archive is read where the walk finds it on disk; one inside another is not opened.
  if (isZipSignature(decoded.bytes))
    return { unsupported: "a ZIP archive inside the input; extract it first", ...counts };
  return decoded;
}

/** What each zstd frame counts against the bound at least, whatever it decompresses to, and so
 * does each member of a gzip file read member by member: every one costs a decompression of its
 * own, so the bound also limits how many are read. 524,288 fill a file's 64 MiB; a frame of real
 * content counts what it holds. */
export const MIN_FRAME_BYTES = 128;
/** What a zstd frame that does not decompress counts against the bound at least. Decompressing it
 * up to its damage can cost as much as the bound, so repeated damage soon exhausts it. */
export const MIN_DAMAGED_BYTES = 1024 * 1024;

/** A file over the bound, which is not read: one that decompresses to more (`content`), or whose
 * frames or members, each counted at least {@link MIN_FRAME_BYTES}, count for more though what
 * they hold is within it, so that the file reads once decompressed. It counts past the bound
 * against the input's, so such files are not decompressed one after another without end; `held`
 * is what it decompressed to, past the bound when that is why. */
function oversized(
  format: "gzip" | "zstd",
  maxBytes: number,
  content: boolean,
  held: number,
): Decoded {
  return {
    unsupported: content
      ? `a ${format} file that decompresses to more than ${maxBytes} bytes`
      : `a ${format} file whose ${format === "zstd" ? "frames" : "members"} count for more than ${maxBytes} bytes, each at least ${MIN_FRAME_BYTES}; decompress it first`,
    held: content ? maxBytes + 1 : held,
    counted: maxBytes + 1,
  };
}

/** Outputs gathered into one buffer that grows as it fills. Node.js returns a small output as a
 * view of its 16 KiB working chunk, and holding each output, or a copy of each, costs memory per
 * frame or member: each is copied in before the next is decompressed. The first is kept as it is,
 * so content of one frame or member is never copied. */
class Gathered {
  private buffer: Buffer = Buffer.alloc(0);
  length = 0;
  /** `limit` bounds the content, so the buffer never grows past it. */
  constructor(private readonly limit: number) {}
  add(output: Buffer): void {
    if (!this.length) this.buffer = output;
    else {
      if (this.length + output.byteLength > this.buffer.byteLength) {
        const grown = Buffer.alloc(
          Math.min(
            this.limit,
            Math.max(2 * this.buffer.byteLength, this.length + output.byteLength),
          ),
        );
        this.buffer.copy(grown, 0, 0, this.length);
        this.buffer = grown;
      }
      output.copy(this.buffer, this.length);
    }
    this.length += output.byteLength;
  }
  get bytes(): Buffer {
    return this.buffer.subarray(0, this.length);
  }
}

/** gzip, every member of it. A file that breaks off, or holds bytes after its last member, is
 * read member by member up to the break, the rest named, each member counted at least
 * {@link MIN_FRAME_BYTES}; a member that fails its checksum leaves the file unread. */
function gunzip(bytes: Uint8Array, maxBytes: number): Decoded {
  try {
    return { bytes: zlib.gunzipSync(bytes, { maxOutputLength: maxBytes }) };
  } catch (error) {
    if (tooLarge(error)) return oversized("gzip", maxBytes, true, 0);
  }
  const content = new Gathered(maxBytes);
  /** What the members read count against the bound. */
  let size = 0;
  let pos = 0;
  let note: string | undefined;
  while (pos < bytes.byteLength) {
    const start = startsWith(bytes, GZIP, pos) ? memberData(bytes, pos) : undefined;
    if (start === undefined) {
      // Zero padding after the last member is what a tape or block device writes.
      const rest = bytes.subarray(pos);
      if (!rest.every((byte) => byte === 0))
        note = `${rest.byteLength} bytes after the last gzip member are not gzip and were not read`;
      break;
    }
    // A member counts at least the minimum, and may decompress to what is left of the bound and to
    // no more than its count may still reach; only past what is left is its content known to be
    // over the bound.
    if (maxBytes - size < MIN_FRAME_BYTES)
      return oversized("gzip", maxBytes, false, content.length);
    const left = maxBytes - content.length;
    const cap = Math.max(1, Math.min(left, maxBytes - size));
    let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
    try {
      inflated = zlib.inflateRawSync(bytes.subarray(start), {
        info: true,
        finishFlush: zlib.constants.Z_SYNC_FLUSH,
        maxOutputLength: cap,
      }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    } catch (error) {
      if (tooLarge(error)) return oversized("gzip", maxBytes, cap >= left, content.length);
      note = "the gzip file is damaged; what follows the damage was not read";
      break;
    }
    const output = inflated.buffer;
    if (output.byteLength > left) return oversized("gzip", maxBytes, true, content.length);
    // A complete member ends with its 8-byte trailer (CRC-32 and size). A member whose data does
    // not match its trailer is damaged, and none of the file is trusted: the CRC-32 is checked
    // whenever the file holds it, also when the file breaks off before the size.
    const end = start + inflated.engine.bytesWritten + 8;
    const trailer = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
      (end - 4 <= bytes.byteLength && trailer.getUint32(end - 8, true) !== zlib.crc32(output)) ||
      (end <= bytes.byteLength && trailer.getUint32(end - 4, true) !== output.byteLength >>> 0)
    )
      return {
        unsupported: "a damaged gzip file",
        held: content.length + output.byteLength,
        counted: size + Math.max(output.byteLength, MIN_FRAME_BYTES),
      };
    size += Math.max(output.byteLength, MIN_FRAME_BYTES);
    content.add(output);
    if (end > bytes.byteLength) {
      note = "the gzip file breaks off; what follows the last complete line was not read";
      break;
    }
    pos = end;
  }
  // A file that reads whole, every member matching its trailer, yet failed to decompress is
  // damaged somewhere this cannot see: none of it is trusted.
  if (!note || !content.length)
    return {
      unsupported: note?.includes("breaks off") ? "a truncated gzip file" : "a damaged gzip file",
      ...(size ? { held: content.length, counted: size } : {}),
    };
  return { bytes: content.bytes, note, ...(size > content.length ? { counted: size } : {}) };
}

/** Where a gzip member's compressed data starts, past its header; undefined when the header is
 * damaged or cut off. */
function memberData(bytes: Uint8Array, pos: number): number | undefined {
  if (bytes[pos + 2] !== 8) return undefined;
  const flags = bytes[pos + 3]!;
  let at = pos + 10;
  if (flags & 0x04) {
    if (at + 2 > bytes.byteLength) return undefined;
    at += 2 + (bytes[at]! | (bytes[at + 1]! << 8));
  }
  for (const flag of [0x08, 0x10]) {
    if (!(flags & flag)) continue;
    while (at < bytes.byteLength && bytes[at] !== 0) at++;
    at++;
  }
  if (flags & 0x02) at += 2;
  return at < bytes.byteLength ? at : undefined;
}

/** The end of the zstd frame (or skippable frame) at `pos`, or why there is none: `truncated`
 * when the frame runs past the content, `other` when no frame starts there. */
function frameEnd(bytes: Uint8Array, pos: number): number | "truncated" | "other" {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (skippable(bytes, pos)) {
    if (pos + 8 > bytes.byteLength) return "truncated";
    const end = pos + 8 + view.getUint32(pos + 4, true);
    return end > bytes.byteLength ? "truncated" : end;
  }
  if (!startsWith(bytes, ZSTD, pos)) return "other";
  if (pos + 5 > bytes.byteLength) return "truncated";
  const descriptor = bytes[pos + 4]!;
  const contentSize = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const checksum = (descriptor >> 2) & 1;
  const dictionary = descriptor & 3;
  let at =
    pos +
    5 +
    (singleSegment ? 0 : 1) +
    [0, 1, 2, 4][dictionary]! +
    [singleSegment ? 1 : 0, 2, 4, 8][contentSize]!;
  for (;;) {
    if (at + 3 > bytes.byteLength) return "truncated";
    const header = bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
    const type = (header >> 1) & 3;
    if (type === 3) return "other";
    at += 3 + (type === 1 ? 1 : header >>> 3);
    if (header & 1) break;
  }
  at += checksum ? 4 : 0;
  return at > bytes.byteLength ? "truncated" : at;
}

/** A complete zstd frame without the checks of its content, its checksum and declared size, so
 * that content can be read and measured. A single-segment frame's window is the size it declares,
 * which is not trusted here: it is read with a window of `window` bytes, at least the 128 KiB a
 * block may hold and at most the 128 MiB zstd reads by default. */
function withoutChecks(frame: Uint8Array, window: number): Buffer {
  const descriptor = frame[4]!;
  const singleSegment = (descriptor >> 5) & 1;
  const dictionaryAt = 5 + (singleSegment ? 0 : 1);
  const dictionaryEnd = dictionaryAt + [0, 1, 2, 4][descriptor & 3]!;
  const blocksAt = dictionaryEnd + [singleSegment, 2, 4, 8][descriptor >> 6]!;
  const log = Math.min(27, Math.max(17, Math.ceil(Math.log2(window))));
  return Buffer.concat([
    frame.subarray(0, 4),
    // No declared size, no single segment, no checksum; the reserved bit and dictionary kept.
    Uint8Array.of(descriptor & 0x0b),
    singleSegment ? Uint8Array.of((log - 10) << 3) : frame.subarray(5, 6),
    frame.subarray(dictionaryAt, dictionaryEnd),
    frame.subarray(blocksAt, (descriptor >> 2) & 1 ? -4 : frame.byteLength),
  ]);
}

/** zstd's errors for what a frame read without its checks ({@link withoutChecks}) leaves out: its
 * checksum, its declared size (reported as corruption, as a wrong source size, or as too small a
 * destination when the frame holds far more than it declares) and a single segment's window. */
const CHECK_ERRORS = new Set([
  "ZSTD_error_checksum_wrong",
  "ZSTD_error_corruption_detected",
  "ZSTD_error_srcSize_wrong",
  "ZSTD_error_dstSize_tooSmall",
  "ZSTD_error_frameParameter_windowTooLarge",
]);

/** Whether reading a frame without its checks can succeed where reading it whole failed: the frame
 * declares a size, a single segment or a checksum, and failed with an error one of them causes. */
const checkable = (frame: Uint8Array, error: unknown) =>
  (frame[4]! & 0xe4) !== 0 &&
  CHECK_ERRORS.has((error as NodeJS.ErrnoException | undefined)?.code ?? "");

/** zstd content read frame by frame, each decompressed on its own: Node.js decompresses only the
 * first frame of what it is given, Bun every one. */
export type ZstdRead =
  | {
      kind: "read";
      /** What the frames read decompressed to. */
      bytes: Buffer;
      /** What the frames read count against the bound: what each decompressed to, at least
       * {@link MIN_FRAME_BYTES}, and the frame read stopped at for its damage at least
       * {@link MIN_DAMAGED_BYTES}. */
      size: number;
      frames: number;
      /** Where the frames read end, and why reading stopped there when it stopped early: bytes
       * that are no frame, a frame that breaks off, or one whose blocks do not decompress. */
      end: number;
      stop?: "trailing" | "truncated" | "damaged";
    }
  /** The frames decompress to more than `room` (`content`), or, within it, count for more than
   * `budget`; `held` is what they decompressed to, past `room` when that is why. */
  | { kind: "oversized"; content: boolean; held: number }
  /** A frame's blocks decompress whole to content its checksum or declared size does not match;
   * `held` is that content with what the frames before it decompressed to, and `size` what they
   * count, the frame at least {@link MIN_DAMAGED_BYTES}. */
  | { kind: "mismatched"; held: number; size: number };

/** Every frame of zstd content, skippable frames passed over, together decompressing to at most
 * `room` and counting for at most `budget` (each at least {@link MIN_FRAME_BYTES}). A frame that
 * fails to decompress is read again without the checks of its content (see {@link withoutChecks})
 * when they could be why: content that then decompresses whole, and so does not match its checksum
 * or declared size, is `mismatched`, as a gzip member that fails its trailer is damaged; blocks
 * that do not decompress stop the read there. */
export function readZstd(bytes: Uint8Array, room: number, budget = room): ZstdRead {
  const content = new Gathered(room);
  let size = 0;
  let pos = 0;
  let frames = 0;
  const read = (end: number, stop?: "trailing" | "truncated" | "damaged"): ZstdRead => ({
    kind: "read",
    bytes: content.bytes,
    size: stop === "damaged" ? size + MIN_DAMAGED_BYTES : size,
    frames,
    end,
    ...(stop ? { stop } : {}),
  });
  const over = (past: boolean, held: number): ZstdRead => ({
    kind: "oversized",
    content: past,
    held: past ? room + 1 : held,
  });
  while (pos < bytes.byteLength) {
    const end = frameEnd(bytes, pos);
    if (end === "other" || end === "truncated")
      return read(pos, end === "other" ? "trailing" : "truncated");
    if (!skippable(bytes, pos)) {
      const frame = bytes.subarray(pos, end);
      // A frame counts at least the minimum, damaged or not, so none is decompressed past the
      // budget. It may decompress to what is left of the room and to no more than its count may
      // still reach, so what decompressing it costs is bounded either way; only past what is left
      // of the room is its content known to be over it.
      if (budget - size < MIN_FRAME_BYTES) return over(false, content.length);
      const left = room - content.length;
      const cap = Math.max(1, Math.min(left, budget - size));
      let output: Buffer;
      try {
        output = zlib.zstdDecompressSync(frame, { maxOutputLength: cap });
      } catch (error) {
        if (tooLarge(error)) return over(cap >= left, content.length);
        if (!checkable(frame, error)) return read(pos, "damaged");
        try {
          output = zlib.zstdDecompressSync(withoutChecks(frame, cap), { maxOutputLength: cap });
        } catch (unchecked) {
          return tooLarge(unchecked) ? over(cap >= left, content.length) : read(pos, "damaged");
        }
        if (output.byteLength > left) return over(true, content.length);
        return {
          kind: "mismatched",
          held: content.length + output.byteLength,
          size: size + Math.max(output.byteLength, MIN_DAMAGED_BYTES),
        };
      }
      if (output.byteLength > left) return over(true, content.length);
      size += Math.max(output.byteLength, MIN_FRAME_BYTES);
      content.add(output);
      frames++;
    }
    pos = end;
  }
  return read(pos);
}

/** zstd, every frame of it. Bytes after the last frame, a frame that breaks off and one whose
 * blocks do not decompress are named, and what precedes them is read; a frame whose content does
 * not match its checksum or declared size leaves the file unread, as a gzip member does. */
function unzstd(bytes: Uint8Array, maxBytes: number): Decoded {
  // zstd is in node:zlib from Node.js 22.15; earlier releases of the supported range lack it.
  if (typeof zlib.zstdDecompressSync !== "function")
    return {
      unsupported:
        "a zstd file, which this Node.js cannot decompress (Node.js 22.15 or later can); decompress it first",
    };
  const read = readZstd(bytes, maxBytes);
  if (read.kind === "oversized") return oversized("zstd", maxBytes, read.content, read.held);
  if (read.kind === "mismatched")
    return { unsupported: "a damaged zstd file", held: read.held, counted: read.size };
  const { frames, stop, end: pos, size: counted } = read;
  if (!frames)
    return {
      unsupported:
        stop === "truncated"
          ? "a truncated zstd file"
          : stop
            ? "a damaged zstd file"
            : "a zstd file without data",
      ...(counted ? { counted } : {}),
    };
  const note =
    stop === "trailing"
      ? `${bytes.byteLength - pos} bytes after the last zstd frame are not zstd and were not read`
      : stop === "truncated"
        ? "the zstd file breaks off; what follows the last complete frame was not read"
        : stop === "damaged"
          ? "the zstd file is damaged; what follows the damage was not read"
          : undefined;
  return {
    bytes: read.bytes,
    ...(note ? { note } : {}),
    ...(counted > read.bytes.byteLength ? { counted } : {}),
  };
}

/** One JSON value read from a file: the whole document, or one line of JSON Lines. */
export interface ParsedValue {
  value: unknown;
  /** The text it was parsed from. */
  text: string;
  unsafeIntegers: boolean;
  /** Its 1-based line, for JSON Lines. */
  line?: number;
  /** A repair the value was read with, for the report. */
  note?: string;
}

/** Whether text that failed to parse breaks off inside a string or an open object or list. */
function truncated(text: string): boolean {
  if (!/^\s*[{[]/.test(text)) return false;
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
  }
  return inString || depth > 0;
}

/** Text with every bare `NaN`, `Infinity` and `-Infinity` outside a string (which Python's
 * `json.dumps` writes by default) as `null`; undefined when it holds none. */
function withoutNonFinite(text: string): string | undefined {
  if (!/NaN|Infinity/.test(text)) return undefined;
  let out = "";
  let from = 0;
  let replaced = false;
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char !== "N" && char !== "I" && char !== "-") continue;
    const token = /^(?:-?Infinity|NaN)/.exec(text.slice(index, index + 9))?.[0];
    if (
      !token ||
      /[\w$]/.test(text[index - 1] ?? "") ||
      /[\w$]/.test(text[index + token.length] ?? "")
    )
      continue;
    out += `${text.slice(from, index)}null`;
    from = index + token.length;
    index = from - 1;
    replaced = true;
  }
  return replaced ? out + text.slice(from) : undefined;
}

const NON_FINITE = "NaN or Infinity, which JSON cannot hold, read as null";

/** JSON text parsed, with Python's bare `NaN` and `Infinity` read as null when nothing else
 * stands in the way; throws when it is not JSON even so. */
function parseRepairing(text: string): { value: unknown; unsafeIntegers: boolean; note?: string } {
  try {
    return parseJsonText(text);
  } catch (error) {
    const repaired = withoutNonFinite(text);
    if (repaired === undefined) throw error;
    return { ...parseJsonText(repaired), note: NON_FINITE };
  }
}

/** Text decoded from bytes: UTF-8, or UTF-16 after its byte order mark. A UTF-8 file with lines
 * that are not UTF-8 keeps its other lines, the bad ones blanked and named. */
function decodeText(
  bytes: Uint8Array,
): { text: string; badLines: number[] } | { unsupported: string } {
  const utf16 =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "be"
        : undefined;
  if (utf16) {
    // UTF-16 as Windows PowerShell's `>` writes it; big-endian is swapped to little first.
    const body = Buffer.from(bytes.subarray(2));
    if (body.byteLength % 2) return { unsupported: "not UTF-16 text" };
    if (utf16 === "be") body.swap16();
    try {
      return { text: new TextDecoder("utf-16le", { fatal: true }).decode(body), badLines: [] };
    } catch {
      return { unsupported: "not UTF-16 text" };
    }
  }
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  try {
    return { text: decoder.decode(bytes), badLines: [] };
  } catch {
    // Some line is not UTF-8: each line is decoded on its own.
  }
  const lines: string[] = [];
  const badLines: number[] = [];
  let start = 0;
  while (start <= bytes.byteLength) {
    let end = bytes.indexOf(0x0a, start);
    if (end < 0) end = bytes.byteLength;
    try {
      lines.push(decoder.decode(bytes.subarray(start, end)));
    } catch {
      lines.push("");
      badLines.push(lines.length);
    }
    start = end + 1;
  }
  return { text: lines.join("\n"), badLines };
}

/** The JSON values of decoded content, the lines that are not JSON, or why none can be read. */
export function parseValues(
  bytes: Uint8Array,
):
  | { values: ParsedValue[]; problems: { line: number; reason: string }[] }
  | { unsupported: string } {
  const decoded = decodeText(bytes);
  if ("unsupported" in decoded) return decoded;
  const { text, badLines } = decoded;
  const problems: { line: number; reason: string }[] = badLines.map((line) => ({
    line,
    reason: "not UTF-8 text",
  }));
  if (!badLines.length)
    try {
      const parsed = parseRepairing(text);
      return { values: [{ ...parsed, text }], problems: [] };
    } catch {
      // Not one document: JSON Lines, read line by line.
    }
  const lines = text.split(/\r?\n/);
  const filled = lines.filter((line) => line.trim()).length + badLines.length;
  if (filled < 2)
    return {
      unsupported: badLines.length
        ? `not UTF-8 text (line ${badLines[0]})`
        : truncated(text)
          ? "truncated JSON"
          : "not JSON",
    };
  const values: ParsedValue[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      values.push({ ...parseRepairing(line), text: line, line: index + 1 });
    } catch {
      problems.push({ line: index + 1, reason: truncated(line) ? "truncated JSON" : "not JSON" });
    }
  }
  problems.sort((a, b) => a.line - b.line);
  if (values.length) return { values, problems };
  return {
    unsupported: badLines.length
      ? `not UTF-8 text (line ${badLines[0]})`
      : truncated(text)
        ? "truncated JSON"
        : "not JSON",
  };
}
