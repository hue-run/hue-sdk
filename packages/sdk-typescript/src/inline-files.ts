import { createHash } from "node:crypto";
import { MAX_BODY_BYTES } from "./config.js";

/** Text media above this decoded byte limit is offloaded; binary media always uses a digest. */
export const INLINE_FILE_LIMIT = 64 * 1024;
/** The longest message text, in UTF-8 bytes, inspected for inline files. */
export const MAX_INLINE_FILE_TEXT = 8 * MAX_BODY_BYTES;
/** Message text one record inspects for inline files in all, in UTF-16 code units. */
export const INLINE_FILE_TEXT_PER_RECORD = 2 * MAX_INLINE_FILE_TEXT;

/** The span message attributes whose JSON may contain inline media. */
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

/** An inline file's bytes, whether they were decoded from the part's text (base64 or
 * percent-escapes) rather than taken as its UTF-8, and the media type its `data:` URL names. */
export interface InlineFileBytes {
  bytes: Buffer;
  decoded: boolean;
  urlMediaType?: string;
}

/**
 * The bytes an inline file part carries, the file's own bytes whatever its media type: a `data:`
 * URL decoded by its own encoding (base64 with `;base64`, percent-escapes otherwise), content in
 * the base64 alphabet decoded, and anything else, such as a text file's own text, as UTF-8. A
 * `data:` URL whose data does not decode is taken as UTF-8 too.
 */
export function inlineFileBytes(content: string): InlineFileBytes {
  const url = dataUrl.exec(content);
  const payload = url ? content.slice(url[0].length) : content;
  const decoded =
    url && !base64Header(url[1]!)
      ? percentDecoded(payload)
      : payload.length % 4 === 0 && base64.test(payload)
        ? Buffer.from(payload, "base64")
        : undefined;
  const header = url?.[1];
  const mediaType = header === undefined ? undefined : header.split(";")[0]!.trim();
  return {
    bytes: decoded ?? Buffer.from(content, "utf8"),
    decoded: decoded !== undefined,
    ...(mediaType ? { urlMediaType: mediaType } : {}),
  };
}

/** A part and the exact leaf that contains its bytes. Nested provider metadata stays in place. */
export interface InlineFilePart {
  part: Record<string, unknown>;
  owner: Record<string, unknown>;
  key: string;
  content: string;
  pointer: string;
  partPointer: string;
  contentType?: string;
  name?: string;
  base64?: boolean;
}

const audioTypes: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  ogg: "audio/ogg",
  opus: "audio/opus",
  aac: "audio/aac",
  m4a: "audio/mp4",
  webm: "audio/webm",
  pcm16: "audio/pcm",
};
const documentTypes: Record<string, string> = {
  pdf: "application/pdf",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  html: "text/html",
  txt: "text/plain",
  md: "text/markdown",
};
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
export function isMediaName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    value.isWellFormed() &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}
function pointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}
/** Whether the receiver can preview these bytes as text. */
export function isTextMediaType(contentType: string): boolean {
  const type = contentType.split(";", 1)[0]!.trim().toLowerCase();
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type.endsWith("+json") ||
    type === "application/xml" ||
    type.endsWith("+xml") ||
    type === "application/yaml" ||
    type === "application/x-yaml" ||
    type === "application/javascript" ||
    type === "application/x-javascript" ||
    type === "application/x-www-form-urlencoded"
  );
}
/** Cheap shared prefilter before bounded parsing of span message attributes. */
export function mayInlineFiles(key: string, value: unknown): boolean {
  return (
    isMessageKey(key) &&
    typeof value === "string" &&
    [
      "blob",
      "file",
      "image",
      "document",
      "media",
      "inlineData",
      "inline_data",
      "input_audio",
      "\\u",
    ].some((marker) => value.includes(marker))
  );
}

/** A printable MIME type with optional parameters, accepted by the upload contract. */
export function isMediaContentType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9!#$&^_.+-]+(?: *;[ -~]*)?$/.test(value)
  );
}

/** Detect the content pointer, MIME, name, and encoding contract of a provider media part. */
export function contentPath(
  part: Record<string, unknown>,
  pointer = "",
): InlineFilePart | undefined {
  let owner = part;
  let key: string | undefined;
  let path = "";
  let contentType = string(part.mime_type ?? part.mimeType ?? part.mediaType ?? part.media_type);
  let name = string(part.name ?? part.filename);
  let encoded = false;
  let dataUrlOnly = false;
  const source = object(part.source);
  const inline = object(part.inlineData ?? part.inline_data);
  const audio = object(part.input_audio);
  const chatFile = object(part.file);
  const bedrock = object(part.image ?? part.document);
  if (inline) {
    owner = inline;
    key = "data";
    path = part.inlineData ? "/inlineData" : "/inline_data";
    contentType = string(inline.mimeType ?? inline.mime_type);
    encoded = true;
    name = undefined;
  } else if (audio && part.type === "input_audio") {
    owner = audio;
    key = "data";
    path = "/input_audio";
    contentType = audioTypes[string(audio.format) ?? ""];
    encoded = true;
    name = undefined;
  } else if (chatFile && part.type === "file") {
    owner = chatFile;
    key = "file_data";
    path = "/file";
    name = string(chatFile.filename);
    dataUrlOnly = true;
  } else if (bedrock && object(bedrock.source)) {
    const isImage = object(part.image) !== undefined;
    owner = object(bedrock.source)!;
    key = "bytes";
    path = isImage ? "/image/source" : "/document/source";
    const format = string(bedrock.format) ?? "";
    contentType =
      isImage && ["png", "jpeg", "gif", "webp"].includes(format)
        ? `image/${format}`
        : documentTypes[format];
    name = isImage ? undefined : string(bedrock.name);
    encoded = true;
  } else if (source && ["image", "document"].includes(string(part.type) ?? "")) {
    if (source.type !== "base64") return undefined;
    owner = source;
    key = "data";
    path = "/source";
    contentType = string(source.media_type);
    name = string(part.title);
    encoded = true;
  } else if (part.type === "image_url") {
    const image = object(part.image_url);
    owner = image ?? part;
    key = image ? "url" : "image_url";
    path = image ? "/image_url" : "";
    contentType = undefined;
    name = undefined;
    dataUrlOnly = true;
  } else if (part.type === "input_image") {
    key = "image_url";
    contentType = undefined;
    name = undefined;
    dataUrlOnly = true;
  } else if (part.type === "input_file") {
    key = "file_data";
    contentType = undefined;
    name = string(part.filename);
    dataUrlOnly = true;
  } else if (part.type === "image") {
    key = "image";
    name = undefined;
  } else if (part.type === "media") {
    key = "data";
    name = undefined;
  } else key = part.type === "blob" ? "content" : part.type === "file" ? "data" : undefined;
  if (!key) return undefined;
  const content = owner[key];
  if (typeof content !== "string" || /^(?:https?:|s3:|gs:|file:|blob:)/i.test(content))
    return undefined;
  if (dataUrlOnly && !content.startsWith("data:")) return undefined;
  // A declared base64 source must actually decode; malformed payloads stay as recorded.
  if (encoded && !(content.length % 4 === 0 && base64.test(content))) return undefined;
  return {
    part,
    owner,
    key,
    content,
    pointer: `${pointer}${path}/${key}`,
    partPointer: pointer,
    ...(contentType ? { contentType } : {}),
    ...(isMediaName(name) ? { name } : {}),
    ...(encoded ? { base64: true } : {}),
  };
}

/** Inline media in document order. The caller applies the decoded text threshold. */
export function largeInlineFileParts(value: unknown): InlineFilePart[] {
  const found: InlineFilePart[] = [];
  const visit = (node: unknown, pointer: string, depth: number): void => {
    if (depth > 256) throw new Error("Message exceeds the supported nesting limit");
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${pointer}/${index}`, depth + 1));
      return;
    }
    const part = object(node);
    if (!part) return;
    const file = contentPath(part, pointer);
    if (file) {
      found.push(file);
      return;
    }
    for (const [name, item] of Object.entries(part))
      visit(item, `${pointer}/${pointerSegment(name)}`, depth + 1);
  };
  visit(value, "", 0);
  return found;
}
export function mediaBytes(file: InlineFilePart): InlineFileBytes {
  if (file.base64) return { bytes: Buffer.from(file.content, "base64"), decoded: true };
  if (
    isMediaContentType(file.contentType) &&
    isTextMediaType(file.contentType) &&
    !file.content.startsWith("data:")
  )
    return { bytes: Buffer.from(file.content, "utf8"), decoded: false };
  return inlineFileBytes(file.content);
}
export function mediaContentType(file: InlineFilePart, decoded: InlineFileBytes): string {
  return (
    (isMediaContentType(file.contentType) ? file.contentType : undefined) ??
    (isMediaContentType(decoded.urlMediaType) ? decoded.urlMediaType : undefined) ??
    (decoded.decoded ? "application/octet-stream" : "text/plain; charset=utf-8")
  );
}
export interface FileDigest {
  sha256: string;
  size: number;
}
/** Bounded payload identity memo, shared by admission and export, cleared at shutdown. */
export class MediaDigestMemo {
  private entries = new Map<string, FileDigest>();
  private units = 0;
  clear(): void {
    this.entries.clear();
    this.units = 0;
  }
  digest(file: InlineFilePart, decoded?: InlineFileBytes, traceId = ""): FileDigest {
    return this.bytes((decoded ?? mediaBytes(file)).bytes, traceId);
  }
  bytes(bytes: Uint8Array, traceId: string): FileDigest {
    const digest = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
    const key = `${traceId}:${digest.sha256}`;
    const known = this.entries.get(key);
    if (known) return known;
    const limit = 32 * 1024 * 1024;
    if (key.length <= limit) {
      while (this.entries.size >= 4096 || this.units + key.length > limit) {
        const first = this.entries.keys().next().value!;
        this.units -= first.length;
        this.entries.delete(first);
      }
      this.entries.set(key, digest);
      this.units += key.length;
    }
    return digest;
  }
}

/** Digest placement removes only the leaf and adds identity to the provider part. */
export function digestPart(file: InlineFilePart, digest: FileDigest): void {
  delete file.owner[file.key];
  file.part.sha256 = digest.sha256;
  file.part.size = digest.size;
}
export function hashInlineFiles(
  key: string,
  value: unknown,
  count?: { files: number },
  memo?: MediaDigestMemo,
  traceId = "",
): unknown {
  if (
    typeof value !== "string" ||
    !mayInlineFiles(key, value) ||
    Buffer.byteLength(value, "utf8") > MAX_INLINE_FILE_TEXT
  )
    return value;
  try {
    const parsed: unknown = JSON.parse(value);
    const files = largeInlineFileParts(parsed);
    let changed = false;
    for (const file of files) {
      const decoded = mediaBytes(file);
      if (!decoded.bytes.byteLength) continue;
      if (
        isTextMediaType(mediaContentType(file, decoded)) &&
        decoded.bytes.byteLength <= INLINE_FILE_LIMIT
      )
        continue;
      const digest = memo
        ? memo.digest(file, decoded, traceId)
        : {
            sha256: createHash("sha256").update(decoded.bytes).digest("hex"),
            size: decoded.bytes.byteLength,
          };
      digestPart(file, digest);
      changed = true;
      if (count) count.files++;
    }
    return changed ? JSON.stringify(parsed) : value;
  } catch {
    return value;
  }
}
