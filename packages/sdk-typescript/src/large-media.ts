import { randomBytes } from "node:crypto";
import {
  MAX_INLINE_FILE_TEXT,
  mediaIn,
  placedMediaText,
  readerParses,
  readingOf,
  type InlineFilePart,
  type MediaValue,
} from "./inline-files.js";

/**
 * Inline media in a value too long for the media inspection bounds (8 Mi UTF-16 code units for one
 * attribute, 16 Mi for a record), read without parsing the files out of it. A span's own attribute
 * held whole for upload is scanned once: every value string longer than {@link LONG_STRING_UNITS}
 * that is recorded without escapes as strict base64 or a base64 `data:` URL is replaced, in a
 * skeleton of the JSON text, by a short stand-in of the same kind, and the skeleton (within the
 * 8 Mi bound) is read as Hue's reader reads the value. A file whose content is such a string is
 * then decoded, hashed and uploaded a slice at a time from its place in the recorded text, never
 * copied out of it whole; its placement edits the skeleton, and the strings no file replaced are
 * written back from the recorded text. The scan reads at most {@link WINDOW_UNITS} of the text in
 * one synchronous step. Mirrors the Python SDK's `_large_media.py`, so both SDKs write the same
 * bytes.
 */

/** A value string longer than this, in UTF-16 code units, is read in place when it is base64 or a
 * base64 `data:` URL recorded without escapes. Longer than every label Hue's reader matches (256
 * units), so a stand-in decides every test of the walk as the string itself does. */
export const LONG_STRING_UNITS = 16 * 1024;

/** The most of a value read in one synchronous step: the scan yields to the event loop between
 * windows, and files are decoded and hashed a window at a time. */
export const WINDOW_UNITS = 1024 * 1024;

/** A source of bytes read a slice at a time: an upload body that is never held whole. `chunks` may
 * be called again for a retried upload, and starts fresh each time; a slice it yields may be
 * reused for the next one, so a reader is done with each slice before it asks for the next. */
export interface ByteSource {
  readonly size: number;
  chunks(): Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
  /** Set when the latest read found the source no longer holds the bytes it was recorded with. */
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
type LongKind = "base64" | "dataBase64";

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

/** Base64 alphabet characters only, and the same padded to a multiple of four. */
const alphabet = /^[A-Za-z0-9+/]*$/;
const base64 = /^[A-Za-z0-9+/]*={0,2}$/;
// eslint-disable-next-line no-control-regex -- a JSON string literal holds no raw control character
const controlCharacter = /[\u0000-\u001f]/;
/** The longest `data:` URL header read in place, in code units: a string with a longer one is
 * parsed with the rest of the value. */
const MAX_HEADER_UNITS = 4096;

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Whether a `data:` URL header's parameters, after its media type, include `base64`. */
function base64Header(header: string): boolean {
  const semicolon = header.indexOf(";");
  return semicolon !== -1 && `${header.slice(semicolon)};`.includes(";base64;");
}

/** Whether `text` from `start` to `end` is strict base64 (padded to a multiple of four), checked a
 * window at a time between turns of the event loop. */
async function strictBase64(text: string, start: number, end: number): Promise<boolean> {
  if ((end - start) % 4 !== 0) return false;
  for (let at = start; at < end; at += WINDOW_UNITS) {
    const stop = Math.min(end, at + WINDOW_UNITS);
    // Padding only closes the whole string.
    if (!(stop === end ? base64 : alphabet).test(text.slice(at, stop))) return false;
    if (stop < end) await nextTurn();
  }
  return true;
}

/**
 * How the content from `start` to `end` of `text` (a string literal's, without escapes, or with
 * `raw` the whole text of a value that is no JSON) is read in place, if it is: strict base64, or a
 * `data:` URL declaring `;base64` whose data is strict base64. Undefined for any other text, which
 * is parsed with the rest of the value (a percent-escaped `data:` URL included); a string literal
 * whose header holds a control character, which no JSON does, is left for the parse to refuse.
 */
async function classify(
  text: string,
  start: number,
  end: number,
  raw = false,
): Promise<LongText | undefined> {
  if (text.startsWith("data:", start)) {
    // The comma is looked for within the string and the header's bound only.
    const found = text
      .slice(start + 5, Math.min(end, start + 5 + MAX_HEADER_UNITS + 1))
      .indexOf(",");
    if (found === -1) return undefined;
    const comma = start + 5 + found;
    const header = text.slice(start + 5, comma);
    if ((!raw && controlCharacter.test(header)) || !base64Header(header)) return undefined;
    if (!(await strictBase64(text, comma + 1, end))) return undefined;
    return { text, start, end, data: comma + 1, kind: "dataBase64", header };
  }
  if (!(await strictBase64(text, start, end))) return undefined;
  return { text, start, end, data: start, kind: "base64" };
}

/** The stand-in for a long string in the skeleton: its kind kept (base64 and its first 16
 * characters, which name an audio container; a `data:` URL's header), longer than any label, and
 * unique by `tag`. */
function standIn(long: LongText, tag: string): string {
  const fill = `${tag}${"A".repeat(472)}`;
  if (long.kind === "base64") return `${long.text.slice(long.start, long.start + 16)}${fill}`;
  return `data:${long.header},${fill}`;
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

/** Marks a search that reached the end of its window before its bound. */
const MORE = -2;

/** The first `character` of `text` from `from`, before `to`, within one window: its index, -1
 * when there is none before `to`, or {@link MORE} when the window ended first. */
function within(text: string, character: string, from: number, to: number): number {
  const stop = Math.min(to, from + WINDOW_UNITS);
  const found = text.slice(from, stop).indexOf(character);
  if (found !== -1) return from + found;
  return stop === to ? -1 : MORE;
}

/** {@link within} on from window to window, a turn of the event loop between them. */
async function find(text: string, character: string, from: number, to: number): Promise<number> {
  for (let at = from; ; at += WINDOW_UNITS) {
    const found = within(text, character, at, to);
    if (found !== MORE) return found;
    await nextTurn();
  }
}

/** A value read with its long strings in place: the skeleton's JSON text and its stand-ins. */
interface Skeleton {
  text: string;
  long: Map<string, LongText>;
  nonce: string;
  order: string[];
}

/**
 * The skeleton of JSON `text`: each value string longer than `longUnits` and recorded without
 * escapes as base64 or a base64 `data:` URL replaced by its stand-in. Undefined once the skeleton
 * is longer than {@link MAX_INLINE_FILE_TEXT}: the scan stops there, so the text it reads and the
 * skeleton it makes stay within that bound however long the value is. A string the scan finds
 * unterminated (text that is no JSON) ends the scan; the skeleton then holds the rest as recorded
 * and fails to parse. The scan reads at most a window of the text in one synchronous step.
 */
async function skeletonOf(text: string, longUnits: number): Promise<Skeleton | undefined> {
  const nonce = randomBytes(16).toString("hex");
  const long = new Map<string, LongText>();
  const replaced: { start: number; end: number; stub: string }[] = [];
  // The skeleton's length less the text's, up to where the scan stands.
  let shorter = 0;
  let at = 0;
  let turn = 0;
  // A search within one window, synchronous; past it, from window to window between turns.
  const quote = (from: number) => within(text, '"', from, text.length);
  for (;;) {
    if (at - turn >= WINDOW_UNITS) {
      turn = at;
      await nextTurn();
    }
    let open = quote(at);
    if (open === MORE) open = await find(text, '"', at + WINDOW_UNITS, text.length);
    if (open === -1) break;
    // The string's end: its first quote no backslash escapes. Each part of the string is read
    // once, however its escapes fall.
    let close = quote(open + 1);
    if (close === MORE) close = await find(text, '"', open + 1 + WINDOW_UNITS, text.length);
    let cursor = open + 1;
    let escaped = false;
    while (close !== -1) {
      let slash = within(text, "\\", cursor, close);
      if (slash === MORE) slash = await find(text, "\\", cursor + WINDOW_UNITS, close);
      if (slash === -1) break;
      escaped = true;
      cursor = slash + 2;
      if (close < cursor) {
        close = quote(cursor);
        if (close === MORE) close = await find(text, '"', cursor + WINDOW_UNITS, text.length);
      }
    }
    if (close === -1) break;
    at = close + 1;
    // Only a value: a key stays as it is.
    const found =
      escaped || close - open - 1 <= longUnits || text.charCodeAt(space(text, at)) === 0x3a
        ? undefined
        : await classify(text, open + 1, close);
    if (found) {
      const stub = standIn(found, `${nonce}${long.size.toString(16).padStart(8, "0")}`);
      long.set(stub, found);
      replaced.push({ start: open + 1, end: close, stub });
      shorter += close - open - 1 - stub.length;
    }
    if (at - shorter > MAX_INLINE_FILE_TEXT) return undefined;
  }
  if (text.length - shorter > MAX_INLINE_FILE_TEXT) return undefined;
  const pieces: string[] = [];
  let copied = 0;
  for (const { start, end, stub } of replaced) {
    pieces.push(text.slice(copied, start), stub);
    copied = end;
  }
  pieces.push(text.slice(copied));
  return { text: pieces.join(""), long, nonce, order: [...long.keys()] };
}

/** A media value read in place, with the long strings its stand-ins name. Its `source` is the
 * skeleton: placing its files edits the skeleton, and {@link placedLargeText} writes the long
 * strings back. */
export interface LargeMediaValue extends MediaValue {
  long: Map<string, LongText>;
  /** What every stand-in's tag starts with, followed by its index in {@link order} as eight hex
   * digits: one forward scan for it finds every stand-in left in a placed text. */
  nonce: string;
  order: string[];
}

/**
 * An attribute's recorded text read for files as `readMediaText` reads it, its long base64 and
 * base64 `data:` URL strings read in place (see {@link skeletonOf}). Undefined for text whose JSON
 * around those strings is over the 8 Mi bound, or that reading finds nothing in. Throws for JSON
 * that does not parse.
 */
export async function readLargeMediaText(
  key: string,
  text: string,
  longUnits = LONG_STRING_UNITS,
): Promise<LargeMediaValue | undefined> {
  const reading = readingOf(key);
  /** Text that is no JSON is the file itself when it is one long base64 `data:` URL; other text
   * is read as `readMediaText` reads it, within the 8 Mi bound. */
  const whole = async (): Promise<LargeMediaValue | undefined> => {
    const found =
      text.length > longUnits && text.startsWith("data:")
        ? await classify(text, 0, text.length, true)
        : undefined;
    if (!found)
      return text.length > MAX_INLINE_FILE_TEXT
        ? undefined
        : { ...mediaIn(text), long: new Map(), nonce: "", order: [] };
    const nonce = randomBytes(16).toString("hex");
    const stub = standIn(found, `${nonce}00000000`);
    return { ...mediaIn(stub), long: new Map([[stub, found]]), nonce, order: [stub] };
  };
  const json = async (
    check?: (parsed: unknown) => boolean,
  ): Promise<LargeMediaValue | undefined> => {
    const skeleton = await skeletonOf(text, longUnits);
    if (!skeleton) return undefined;
    const parsed: unknown = JSON.parse(skeleton.text);
    if (check && !check(parsed)) return undefined;
    return readerParses(parsed)
      ? {
          ...mediaIn(parsed, skeleton.text),
          long: skeleton.long,
          nonce: skeleton.nonce,
          order: skeleton.order,
        }
      : undefined;
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

/**
 * Text made of pieces of other strings, not yet joined into one: the recorded text with its files
 * placed, whose long strings no file replaced are still pieces of the recorded text. It is read a
 * window at a time, and made one string only when it is short enough to keep inline, so a long
 * remainder is never held in two copies.
 */
export class JoinedText {
  private readonly pieces: [string, number, number][];

  constructor(pieces: [string, number, number][]) {
    this.pieces = pieces.filter(([, start, end]) => end > start);
  }

  /** The text a window at a time, never between the halves of a surrogate pair. */
  *windows(): Generator<string> {
    for (const [text, start, end] of this.pieces)
      for (let at = start; at < end; ) {
        let stop = Math.min(end, at + WINDOW_UNITS);
        if (stop < end && /[\uD800-\uDBFF]/.test(text[stop - 1]!)) stop--;
        yield text.slice(at, stop);
        at = stop;
      }
  }

  /** The first `units` code units. */
  head(units: number): string {
    let out = "";
    for (const [text, start, end] of this.pieces) {
      if (out.length >= units) break;
      out += text.slice(start, Math.min(end, start + units - out.length));
    }
    return out;
  }

  /** The last `units` code units. */
  tail(units: number): string {
    let out = "";
    for (let index = this.pieces.length - 1; index >= 0 && out.length < units; index--) {
      const [text, start, end] = this.pieces[index]!;
      out = text.slice(Math.max(start, end - (units - out.length)), end) + out;
    }
    return out;
  }

  /** The text as one string. */
  text(): string {
    return this.pieces.map(([text, start, end]) => text.slice(start, end)).join("");
  }

  /** The text's UTF-8 size, counted a window at a time. */
  utf8Size(): number {
    let size = 0;
    for (const window of this.windows()) size += Buffer.byteLength(window, "utf8");
    return size;
  }

  /** The text's UTF-8, a window at a time, into one buffer each read reuses. */
  source(size: number): ByteSource {
    const windows = () => this.windows();
    return {
      size,
      *chunks() {
        const buffer = Buffer.allocUnsafe(WINDOW_UNITS * 3);
        for (const window of windows()) yield buffer.subarray(0, buffer.write(window, "utf8"));
      },
    };
  }
}

/**
 * The recorded text once the files of a value read in place are placed: the skeleton with the
 * placements' edits, and each stand-in no placement replaced written back as the string it stands
 * for. Every byte the placements do not change is the recorded text's. Text that keeps a long
 * string is returned as its pieces ({@link JoinedText}), not copied into one string.
 */
export async function placedLargeText(media: LargeMediaValue): Promise<string | JoinedText> {
  const edited = placedMediaText(media);
  if (!media.order.length) return edited;
  // One forward scan for the stand-ins' shared nonce finds each one left, in order, by the index
  // its tag carries: linear in the text however many there are, a window at a time.
  const pieces: [string, number, number][] = [];
  let from = 0;
  let turn = 0;
  for (let at = edited.indexOf(media.nonce); at !== -1; at = edited.indexOf(media.nonce, at + 1)) {
    if (at - turn >= WINDOW_UNITS) {
      turn = at;
      await nextTurn();
    }
    const stub = media.order[Number.parseInt(edited.slice(at + 32, at + 40), 16)];
    if (stub === undefined) continue;
    const start = at - stub.indexOf(media.nonce);
    if (start < from || !edited.startsWith(stub, start)) continue;
    const long = media.long.get(stub)!;
    pieces.push([edited, from, start], [long.text, long.start, long.end]);
    from = start + stub.length;
    at = from - 1;
  }
  if (!pieces.length) return edited;
  pieces.push([edited, from, edited.length]);
  return new JoinedText(pieces);
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

/** Base64 from `start` to `end` of `text` (strict, padded to a multiple of four), decoded a window
 * at a time into one buffer each read reuses. */
function base64Source(text: string, start: number, end: number): ByteSource {
  const length = end - start;
  const pad =
    (text.charCodeAt(end - 1) === 0x3d ? 1 : 0) + (text.charCodeAt(end - 2) === 0x3d ? 1 : 0);
  return {
    size: (length / 4) * 3 - pad,
    *chunks() {
      const buffer = Buffer.allocUnsafe((WINDOW_UNITS / 4) * 3);
      for (let at = start; at < end; at += WINDOW_UNITS) {
        const written = buffer.write(text.slice(at, Math.min(end, at + WINDOW_UNITS)), "base64");
        yield buffer.subarray(0, written);
      }
    },
  };
}

/** The bytes of a file whose content is a long string, as `mediaBytes` reads them: a field its
 * convention declares base64 decoded, base64 text decoded (`bareBase64`), a base64 `data:` URL. */
export function longFileBytes(file: InlineFilePart, long: LongText): LongFileBytes {
  const source = base64Source(long.text, long.data, long.end);
  if (long.kind === "base64")
    return {
      size: source.size,
      decoded: true,
      ...(file.base64 ? {} : { bareBase64: true }),
      source,
    };
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
