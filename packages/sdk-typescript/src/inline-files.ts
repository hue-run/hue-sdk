import { createHash } from "node:crypto";
import { MAX_BODY_BYTES } from "./config.js";

/** Inline file content larger than this many UTF-8 bytes is exported as its digest instead. */
export const INLINE_FILE_LIMIT = 64 * 1024;
const MAX_INLINE_FILE_TEXT = 8 * MAX_BODY_BYTES;
/** Message text one record inspects for inline files in all, in UTF-16 code units. */
export const INLINE_FILE_TEXT_PER_RECORD = 2 * MAX_INLINE_FILE_TEXT;

/** Message attributes whose JSON can inline files: GenAI blob parts and AI SDK 6 file parts. */
const messageKeys = new Set([
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "ai.prompt.messages",
]);

/** Whether an attribute is one of the recorded message attributes that can inline files. */
export function isMessageKey(key: string): boolean {
  return messageKeys.has(key);
}

/** Strict base64: alphabet characters only, padded to a multiple of four. */
const base64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** An RFC 2397 `data:` URL's header, up to the comma before its data. Its `;` parameters are read
 * in code: a pattern repeated per parameter fails on a pathological count (Node's stack overflows,
 * Bun stops matching). */
const dataUrl = /^data:([^,]*),/;

/** Whether a `data:` URL header's parameters, after its media type, include `base64`. */
function base64Header(header: string): boolean {
  const semicolon = header.indexOf(";");
  // One `;`-separated parameter is exactly `base64`, without splitting them all.
  return semicolon !== -1 && `${header.slice(semicolon)};`.includes(";base64;");
}
const hexPair = /^[0-9A-Fa-f]{2}$/;

/** RFC 2397 data without `;base64`: percent-escaped octets, other characters as UTF-8. Undefined
 * when a `%` does not start an escape. */
function percentDecoded(payload: string): Buffer | undefined {
  // Escapes only shrink the text, so its UTF-8 length bounds the bytes.
  const bytes = Buffer.alloc(Buffer.byteLength(payload, "utf8"));
  let length = 0;
  let start = 0;
  for (let index = payload.indexOf("%"); index !== -1; index = payload.indexOf("%", start)) {
    const hex = payload.slice(index + 1, index + 3);
    if (!hexPair.test(hex)) return undefined;
    length += bytes.write(payload.slice(start, index), length, "utf8");
    bytes[length++] = Number.parseInt(hex, 16);
    start = index + 3;
  }
  length += bytes.write(payload.slice(start), length, "utf8");
  return bytes.subarray(0, length);
}

/**
 * The bytes an inline file part carries, the file's own bytes whatever its media type: a `data:`
 * URL decoded by its own encoding (base64 with `;base64`, percent-escapes otherwise), content in
 * the base64 alphabet decoded, and anything else, such as a text file's own text, as UTF-8. A
 * `data:` URL whose data does not decode is taken as UTF-8 too.
 */
function fileBytes(content: string): Buffer {
  const url = dataUrl.exec(content);
  const payload = url ? content.slice(url[0].length) : content;
  const decoded =
    url && !base64Header(url[1]!)
      ? percentDecoded(payload)
      : payload.length % 4 === 0 && base64.test(payload)
        ? Buffer.from(payload, "base64")
        : undefined;
  return decoded ?? Buffer.from(content, "utf8");
}

interface HashState {
  changed: boolean;
}

/** The key holding a part's inline content: GenAI `blob` parts and AI SDK 6 `file` parts. */
function contentKey(part: Record<string, unknown>): "content" | "data" | undefined {
  return part.type === "blob" ? "content" : part.type === "file" ? "data" : undefined;
}

function hashNode(value: unknown, state: HashState, depth: number): unknown {
  if (depth > 256) throw new Error("Message exceeds the supported nesting limit");
  if (Array.isArray(value)) return value.map((item) => hashNode(item, state, depth + 1));
  if (value === null || typeof value !== "object") return value;
  const part = value as Record<string, unknown>;
  const key = contentKey(part);
  const inline = key === undefined ? undefined : part[key];
  if (key !== undefined && typeof inline === "string") {
    const bytes = fileBytes(inline);
    if (bytes.byteLength > INLINE_FILE_LIMIT) {
      const { [key]: _omitted, ...rest } = part;
      state.changed = true;
      return {
        ...rest,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      };
    }
  }
  return Object.fromEntries(
    Object.entries(part).map(([name, item]) => [name, hashNode(item, state, depth + 1)]),
  );
}

/**
 * Replaces inline files longer than {@link INLINE_FILE_LIMIT} in a recorded message attribute
 * with their SHA-256 and byte size, so a span that inlines a large file exports the file's
 * identity instead of being rejected for its size. The part keeps its other fields (`type`,
 * `mime_type`, `modality`, `mediaType`, …). Other attributes, shorter messages and values that
 * are not JSON are returned unchanged.
 */
export function hashInlineFiles(key: string, value: unknown): unknown {
  if (
    !messageKeys.has(key) ||
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") <= INLINE_FILE_LIMIT ||
    Buffer.byteLength(value, "utf8") > MAX_INLINE_FILE_TEXT ||
    !(value.includes('"blob"') || value.includes('"file"'))
  )
    return value;
  try {
    const parsed: unknown = JSON.parse(value);
    const state = { changed: false };
    const hashed = hashNode(parsed, state, 0);
    return state.changed ? JSON.stringify(hashed) : value;
  } catch {
    // Not JSON, or nested too deeply to inspect: export decides the value's fate as before.
    return value;
  }
}
