import { createHash } from "node:crypto";
import { MAX_BODY_BYTES } from "./config.js";

/** Inline file content larger than this many UTF-8 bytes is exported as its digest instead. */
export const INLINE_FILE_LIMIT = 64 * 1024;
const MAX_INLINE_FILE_TEXT = 8 * MAX_BODY_BYTES;

/** Message attributes whose JSON can inline files: GenAI blob parts and AI SDK 6 file parts. */
const messageKeys = new Set([
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "ai.prompt.messages",
]);

/** Strict base64: alphabet characters only, padded to a multiple of four. */
const base64 = /^[A-Za-z0-9+/]*={0,2}$/;
const base64DataUrl = /^data:[^,]*;base64,/;

function binaryMimeType(value: unknown): boolean {
  return (
    typeof value === "string" &&
    !/^text\//i.test(value) &&
    value.toLowerCase() !== "application/json"
  );
}

/**
 * The bytes an inline file part carries: base64 (plain or as a `data:` URL) is decoded, and
 * anything else, such as a text file's content, is taken as UTF-8.
 */
function fileBytes(content: string, mimeType: unknown): Buffer {
  const prefix = base64DataUrl.exec(content)?.[0].length ?? 0;
  const payload = content.slice(prefix);
  return (prefix > 0 || binaryMimeType(mimeType)) &&
    payload.length % 4 === 0 &&
    base64.test(payload)
    ? Buffer.from(payload, "base64")
    : Buffer.from(content, "utf8");
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
  const mimeType = part.mime_type ?? part.mediaType;
  if (
    key !== undefined &&
    typeof inline === "string" &&
    Buffer.byteLength(inline, "utf8") > INLINE_FILE_LIMIT
  ) {
    const bytes = fileBytes(inline, mimeType);
    const { [key]: _omitted, ...rest } = part;
    state.changed = true;
    return {
      ...rest,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
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
