import * as zlib from "node:zlib";
import { parseJsonText } from "../traces-import-convert.js";
import { isZipSignature } from "../traces-import-zip.js";

/**
 * What every format reads through: a file's compression (gzip, zstd) undone, its text decoded,
 * and its JSON read as one document or, failing that, as JSON Lines whose every line is read on
 * its own, a line that is not JSON named with its number instead of refusing the file.
 */

const GZIP = [0x1f, 0x8b];
const ZSTD = [0x28, 0xb5, 0x2f, 0xfd];
const startsWith = (bytes: Uint8Array, magic: readonly number[]) =>
  bytes.byteLength >= magic.length && magic.every((byte, index) => bytes[index] === byte);

const tooLarge = (error: unknown) =>
  error instanceof RangeError ||
  (error as NodeJS.ErrnoException | undefined)?.code === "ERR_BUFFER_TOO_LARGE";

/** The file's content with its compression undone, or why it cannot be read. `maxBytes` bounds
 * the decompressed size. */
export function decodeContainer(
  bytes: Uint8Array,
  maxBytes: number,
): { bytes: Uint8Array } | { unsupported: string } {
  if (!bytes.byteLength) return { unsupported: "the file is empty" };
  let decoded = bytes;
  const compression = startsWith(bytes, GZIP)
    ? "gzip"
    : startsWith(bytes, ZSTD)
      ? "zstd"
      : undefined;
  if (compression) {
    // zstd is in node:zlib from Node.js 22.15; earlier releases of the supported range lack it.
    const zstd: ((buffer: Uint8Array, options: { maxOutputLength: number }) => Buffer) | undefined =
      typeof zlib.zstdDecompressSync === "function" ? zlib.zstdDecompressSync : undefined;
    if (compression === "zstd" && !zstd)
      return {
        unsupported:
          "a zstd file, which this Node.js cannot decompress (Node.js 22.15 or later can); decompress it first",
      };
    try {
      decoded =
        compression === "gzip"
          ? zlib.gunzipSync(bytes, { maxOutputLength: maxBytes })
          : zstd!(bytes, { maxOutputLength: maxBytes });
    } catch (error) {
      return {
        unsupported: tooLarge(error)
          ? `a ${compression} file that decompresses to more than ${maxBytes} bytes`
          : `a damaged ${compression} file`,
      };
    }
    if (startsWith(decoded, GZIP) || startsWith(decoded, ZSTD))
      return { unsupported: "a file compressed twice; decompress it first" };
    if (!decoded.byteLength) return { unsupported: "the file is empty" };
  }
  // An archive is read where the walk finds it on disk; one inside another is not opened.
  if (isZipSignature(decoded))
    return { unsupported: "a ZIP archive inside the input; extract it first" };
  return { bytes: decoded };
}

/** One JSON value read from a file: the whole document, or one line of JSON Lines. */
export interface ParsedValue {
  value: unknown;
  /** The text it was parsed from. */
  text: string;
  unsafeIntegers: boolean;
  /** Its 1-based line, for JSON Lines. */
  line?: number;
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

/** The JSON values of decoded content, the lines that are not JSON, or why none can be read. */
export function parseValues(
  bytes: Uint8Array,
):
  | { values: ParsedValue[]; problems: { line: number; reason: string }[] }
  | { unsupported: string } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { unsupported: "not UTF-8 text" };
  }
  try {
    const parsed = parseJsonText(text);
    return {
      values: [{ value: parsed.value, text, unsafeIntegers: parsed.unsafeIntegers }],
      problems: [],
    };
  } catch {
    // Not one document: JSON Lines, read line by line.
  }
  const unreadable = { unsupported: truncated(text) ? "truncated JSON" : "not JSON" };
  const lines = text.split(/\r?\n/);
  if (lines.filter((line) => line.trim()).length < 2) return unreadable;
  const values: ParsedValue[] = [];
  const problems: { line: number; reason: string }[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = parseJsonText(line);
      values.push({
        value: parsed.value,
        text: line,
        unsafeIntegers: parsed.unsafeIntegers,
        line: index + 1,
      });
    } catch {
      problems.push({ line: index + 1, reason: truncated(line) ? "truncated JSON" : "not JSON" });
    }
  }
  return values.length ? { values, problems } : unreadable;
}
