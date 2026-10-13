import { randomBytes } from "node:crypto";
import {
  MAX_INLINE_FILE_TEXT,
  mediaIn,
  readerParses,
  readingOf,
  type InlineFilePart,
  type MediaValue,
} from "./inline-files.js";

/**
 * Inline media in a value too long for the media inspection bounds (8 Mi UTF-16 code units for one
 * attribute, 16 Mi for a record), read without parsing the files out of it. A span's own attribute
 * held whole for upload is scanned once: every value string longer than {@link LONG_STRING_UNITS}
 * that is recorded without escapes as base64 or a `data:` URL is replaced, in a skeleton of the
 * JSON text, by a short stand-in of the same kind, and the skeleton (within the 8 Mi bound) is read
 * as Hue's reader reads the value. A file whose content is such a string is then decoded, hashed
 * and uploaded a slice at a time from its place in the recorded text, never copied out of it whole,
 * and placed with the same JSON edits as any file. Mirrors the Python SDK's `_large_media.py`, so
 * both SDKs write the same bytes.
 */

/** A value string longer than this, in UTF-16 code units, is read in place when it is base64 or a
 * `data:` URL recorded without escapes. Longer than every label Hue's reader matches (256 units),
 * so a stand-in decides every test of the walk as the string itself does. */
export const LONG_STRING_UNITS = 16 * 1024;

/** A source of bytes read a slice at a time: an upload body that is never held whole. `chunks` may
 * be called again for a retried upload. */
export interface ByteSource {
  readonly size: number;
  chunks(): Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
  /** Set once a read found the source no longer holds the bytes it was recorded with. */
  changed?: boolean;
}

/** Whether a value is a {@link ByteSource}. */
export function isByteSource(value: unknown): value is ByteSource {
  return (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Uint8Array) &&
    typeof (value as ByteSource).chunks === "function"
  );
}

/** How the bytes of a long string are read from its text. */
type LongKind = "base64" | "dataBase64" | "dataPercent";

/** A long value string in place in the recorded text: its content is `text` from `start` to
 * `end`, without escapes, and its data (after a `data:` URL's comma) starts at `data`. */
export interface LongText {
  text: string;
  start: number;
  end: number;
  data: number;
  kind: LongKind;
  /** A `data:` URL's header, between `data:` and its comma. */
  header?: string;
}

/** Strict base64: alphabet characters only, padded to a multiple of four. */
const base64 = /^[A-Za-z0-9+/]*={0,2}$/;
// eslint-disable-next-line no-control-regex -- a JSON string literal holds no raw control character
const controlCharacter = /[\u0000-\u001f]/;
const badEscape = /%(?![0-9A-Fa-f]{2})/;
/** Slices of base64 decoded at once: a multiple of four characters. */
const BASE64_SLICE = 1 << 20;
/** Slices of other text read at once, in code units. */
const TEXT_SLICE = 1 << 20;

/** Whether a `data:` URL header's parameters, after its media type, include `base64`. */
function base64Header(header: string): boolean {
  const semicolon = header.indexOf(";");
  return semicolon !== -1 && `${header.slice(semicolon)};`.includes(";base64;");
}

/** How the content from `start` to `end` of `text` (a string literal's, without escapes, or with
 * `raw` the whole text of a value that is no JSON) is read in place, if it is: strict base64, or a
 * `data:` URL whose data decodes by its own encoding. Undefined for any other text, which is parsed
 * with the rest of the value; a string literal holding a control character, which no JSON does, is
 * left for the parse to refuse. */
function classify(text: string, start: number, end: number, raw = false): LongText | undefined {
  if (text.startsWith("data:", start)) {
    const comma = text.indexOf(",", start + 5);
    if (comma === -1 || comma >= end) return undefined;
    const header = text.slice(start + 5, comma);
    if (!raw && controlCharacter.test(header)) return undefined;
    const data = text.slice(comma + 1, end);
    if (base64Header(header)) {
      if ((end - comma - 1) % 4 !== 0 || !base64.test(data)) return undefined;
      return { text, start, end, data: comma + 1, kind: "dataBase64", header };
    }
    if ((!raw && controlCharacter.test(data)) || badEscape.test(data)) return undefined;
    return { text, start, end, data: comma + 1, kind: "dataPercent", header };
  }
  if ((end - start) % 4 !== 0 || !base64.test(text.slice(start, end))) return undefined;
  return { text, start, end, data: start, kind: "base64" };
}

/** The stand-in for a long string in the skeleton: its kind kept (base64 and its first 16
 * characters, which name an audio container; a `data:` URL's header and whether its data decode),
 * longer than any label, and unique by `tag`. */
function standIn(long: LongText, tag: string): string {
  const fill = (character: string) => `${tag}${character.repeat(472)}`;
  if (long.kind === "base64") return `${long.text.slice(long.start, long.start + 16)}${fill("A")}`;
  return `data:${long.header},${fill(long.kind === "dataBase64" ? "A" : "x")}`;
}

/** The index past the whitespace JSON allows from `at`. */
function space(text: string, at: number): number {
  let index = at;
  for (;;) {
    const code = text.charCodeAt(index);
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) index++;
    else return index;
  }
}

/** A value read with its long strings in place: the skeleton's JSON text and its stand-ins. */
interface Skeleton {
  text: string;
  long: Map<string, LongText>;
}

/**
 * The skeleton of JSON `text`: each value string longer than `longUnits` and recorded without
 * escapes as base64 or a `data:` URL replaced by its stand-in. Undefined when the skeleton is still
 * longer than {@link MAX_INLINE_FILE_TEXT}. A string the scan finds unterminated (text that is no
 * JSON) ends the scan; the skeleton then holds the rest as recorded and fails to parse.
 */
function skeletonOf(text: string, longUnits: number): Skeleton | undefined {
  const nonce = randomBytes(16).toString("hex");
  const long = new Map<string, LongText>();
  const pieces: string[] = [];
  let copied = 0;
  let length = text.length;
  let at = 0;
  // The first backslash at or after where the scan stands, found once and passed: the scan is
  // linear however the escapes and the strings fall.
  let slash = text.indexOf("\\");
  for (;;) {
    const open = text.indexOf('"', at);
    if (open === -1) break;
    let close = text.indexOf('"', open + 1);
    let cursor = open + 1;
    let escaped = false;
    for (;;) {
      if (close === -1) break;
      if (slash !== -1 && slash < cursor) slash = text.indexOf("\\", cursor);
      if (slash === -1 || slash > close) break;
      escaped = true;
      cursor = slash + 2;
      if (close < cursor) close = text.indexOf('"', cursor);
    }
    if (close === -1) break;
    at = close + 1;
    // Only a value: a key stays as it is.
    if (escaped || close - open - 1 <= longUnits || text.charCodeAt(space(text, at)) === 0x3a)
      continue;
    const found = classify(text, open + 1, close);
    if (!found) continue;
    const stub = standIn(found, `${nonce}${long.size.toString(16).padStart(8, "0")}`);
    long.set(stub, found);
    pieces.push(text.slice(copied, open + 1), stub);
    copied = close;
    length += stub.length - (close - open - 1);
  }
  if (length > MAX_INLINE_FILE_TEXT) return undefined;
  pieces.push(text.slice(copied));
  return { text: pieces.join(""), long };
}

/** A media value read in place, with the long strings its stand-ins name. */
export interface LargeMediaValue extends MediaValue {
  long: Map<string, LongText>;
}

/**
 * An attribute's recorded text read for files as `readMediaText` reads it, its long base64 and
 * `data:` URL strings read in place (see {@link skeletonOf}); the edits of placed files apply to
 * the recorded text itself. Undefined for text whose JSON around those strings is over the 8 Mi
 * bound, or that reading finds nothing in. Throws for JSON that does not parse.
 */
export function readLargeMediaText(
  key: string,
  text: string,
  longUnits = LONG_STRING_UNITS,
): LargeMediaValue | undefined {
  const reading = readingOf(key);
  /** Text that is no JSON is the file itself when it is one long `data:` URL. */
  const whole = (): LargeMediaValue | undefined => {
    if (text.length <= longUnits) {
      if (text.length > MAX_INLINE_FILE_TEXT) return undefined;
      return { ...mediaIn(text), long: new Map() };
    }
    const found = text.startsWith("data:") ? classify(text, 0, text.length, true) : undefined;
    if (!found) return undefined;
    const stub = standIn(found, randomBytes(16).toString("hex") + "00000000");
    return { ...mediaIn(stub), long: new Map([[stub, found]]) };
  };
  const json = (check?: (parsed: unknown) => boolean): LargeMediaValue | undefined => {
    const skeleton = skeletonOf(text, longUnits);
    if (!skeleton) return undefined;
    const parsed: unknown = JSON.parse(skeleton.text);
    if (check && !check(parsed)) return undefined;
    return readerParses(parsed) ? { ...mediaIn(parsed, text), long: skeleton.long } : undefined;
  };
  switch (reading) {
    case "json":
      return json();
    case "metadata":
      return /^\s*[[{]/.test(text) ? json() : whole();
    case "parts":
      return /^\s*\[/.test(text)
        ? json(
            (parsed) =>
              Array.isArray(parsed) &&
              parsed.length > 0 &&
              parsed.every(
                (part) =>
                  part !== null &&
                  typeof part === "object" &&
                  !Array.isArray(part) &&
                  typeof (part as { type?: unknown }).type === "string",
              ),
          )
        : undefined;
    case "url":
      return whole();
    default:
      return undefined;
  }
}

/** A long file's bytes as `mediaBytes` reads them, measured without being made: its size, whether
 * it was decoded, the media type its `data:` URL names, and a source of its bytes. */
export interface LongFileBytes {
  size: number;
  decoded: boolean;
  urlMediaType?: string;
  bareBase64?: boolean;
  source: ByteSource;
}

/** Base64 from `start` to `end` of `text` (strict, padded to a multiple of four), decoded a
 * slice at a time. */
function base64Source(text: string, start: number, end: number): ByteSource {
  const pad =
    (text.charCodeAt(end - 1) === 0x3d ? 1 : 0) + (text.charCodeAt(end - 2) === 0x3d ? 1 : 0);
  return {
    size: ((end - start) / 4) * 3 - pad,
    *chunks() {
      for (let at = start; at < end; at += BASE64_SLICE)
        yield Buffer.from(text.slice(at, Math.min(end, at + BASE64_SLICE)), "base64");
    },
  };
}

/** A `data:` URL's data without `;base64` from `start` to `end` of `text`: each `%XX` escape its
 * octet, any other character its UTF-8, a slice at a time, never splitting an escape or a
 * surrogate pair. Every `%` starts an escape (checked when the string was read). */
function percentSource(text: string, start: number, end: number): ByteSource {
  const data = text.slice(start, end);
  let escapes = 0;
  for (let at = data.indexOf("%"); at !== -1; at = data.indexOf("%", at + 3)) escapes++;
  return {
    size: Buffer.byteLength(data, "utf8") - 2 * escapes,
    *chunks() {
      for (let at = 0; at < data.length; ) {
        let stop = Math.min(data.length, at + TEXT_SLICE);
        while (
          stop < data.length &&
          (data.charCodeAt(stop - 1) === 0x25 ||
            data.charCodeAt(stop - 2) === 0x25 ||
            /[\uD800-\uDBFF]/.test(data[stop - 1]!))
        )
          stop--;
        const slice = data.slice(at, stop);
        const bytes = Buffer.alloc(Buffer.byteLength(slice, "utf8"));
        let length = 0;
        let from = 0;
        for (let index = slice.indexOf("%"); index !== -1; index = slice.indexOf("%", from)) {
          length += bytes.write(slice.slice(from, index), length, "utf8");
          bytes[length++] = Number.parseInt(slice.slice(index + 1, index + 3), 16);
          from = index + 3;
        }
        length += bytes.write(slice.slice(from), length, "utf8");
        yield bytes.subarray(0, length);
        at = stop;
      }
    },
  };
}

/** The bytes of a file whose content is a long string, as `mediaBytes` reads them: a field its
 * convention declares base64 decoded, base64 text decoded (`bareBase64`), a `data:` URL by its own
 * encoding. */
export function longFileBytes(file: InlineFilePart, long: LongText): LongFileBytes {
  if (long.kind === "base64") {
    const source = base64Source(long.text, long.start, long.end);
    return {
      size: source.size,
      decoded: true,
      ...(file.base64 ? {} : { bareBase64: true }),
      source,
    };
  }
  const source =
    long.kind === "dataBase64"
      ? base64Source(long.text, long.data, long.end)
      : percentSource(long.text, long.data, long.end);
  const mediaType = long.header!.split(";")[0]!.trim();
  return {
    size: source.size,
    decoded: true,
    ...(mediaType ? { urlMediaType: mediaType } : {}),
    source,
  };
}

/** The first `units` code units of a long string's content. */
export function longHead(long: LongText, units: number): string {
  return long.text.slice(long.start, Math.min(long.end, long.start + units));
}
