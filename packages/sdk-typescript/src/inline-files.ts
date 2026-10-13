import { createHash } from "node:crypto";
import { MAX_BODY_BYTES } from "./config.js";
import { applyJsonEdits, type JsonEdit } from "./json-edits.js";

/** Text media above this decoded byte limit is offloaded; binary media always uses a digest. */
export const INLINE_FILE_LIMIT = 64 * 1024;
/** The longest message text, in UTF-16 code units, inspected for inline files. */
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

/** Attributes whose value is JSON text by its convention, read for files anywhere in it: message
 * sources (GenAI, AI SDK, OpenInference `input.value`/`output.value`, OpenLLMetry entities,
 * Langfuse observations and traces) and tool arguments and results. */
const jsonMediaKeys = new Set([
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "ai.prompt.messages",
  "ai.prompt",
  "input.value",
  "output.value",
  "traceloop.entity.input",
  "traceloop.entity.output",
  "langfuse.observation.input",
  "langfuse.observation.output",
  "langfuse.trace.input",
  "langfuse.trace.output",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
  "ai.toolCall.args",
  "ai.toolCall.result",
  "tool.parameters",
  "tool_arguments",
  "tool_response",
]);
/** Recorded metadata: JSON text when it reads as an object or array, otherwise the text itself. */
const metadataKeys = new Set([
  "metadata",
  "langfuse.observation.metadata",
  "langfuse.trace.metadata",
]);
const metadataPrefixes = [
  "langfuse.observation.metadata.",
  "langfuse.trace.metadata.",
  "ai.telemetry.metadata.",
];
/** OpenLLMetry's indexed message content: the JSON text of a parts list. */
const indexedContentKey = /^gen_ai\.(?:prompt|completion)\.\d{1,9}\.content$/;
/** OpenInference's flattened image content: the image's URL. */
const openInferenceImageKey =
  /^llm\.(?:input|output)_messages\.\d{1,9}\.message\.contents\.\d{1,9}\.message_content\.image\.image\.url$/;

/** How an attribute's text is read for files: JSON by convention, metadata, an OpenLLMetry parts
 * list, or a URL that is the file. */
export type MediaReading = "json" | "metadata" | "parts" | "url";

/** How an attribute's text is read for files, when it is read at all. */
export function readingOf(key: string): MediaReading | undefined {
  if (jsonMediaKeys.has(key)) return "json";
  if (metadataKeys.has(key) || metadataPrefixes.some((prefix) => key.startsWith(prefix)))
    return "metadata";
  if (indexedContentKey.test(key)) return "parts";
  if (openInferenceImageKey.test(key)) return "url";
  return undefined;
}

/**
 * The attributes of a record that hold literal text: OpenInference's `input.value` and
 * `output.value` when the record declares `input.mime_type` / `output.mime_type` as `text/plain`.
 * Hue reads no JSON, and so no file, in them; neither does the SDK.
 */
export function literalKeys(attributes: unknown): ReadonlySet<string> {
  const keys = new Set<string>();
  if (attributes === null || typeof attributes !== "object") return keys;
  for (const side of ["input", "output"]) {
    const declared = Object.getOwnPropertyDescriptor(attributes, `${side}.mime_type`);
    if (declared && "value" in declared && declared.value === "text/plain")
      keys.add(`${side}.value`);
  }
  return keys;
}

/** Whether a span attribute is one whose value the SDK inspects for inline media: the attributes
 * Hue's reader reads files from. */
export function isMediaKey(key: string): boolean {
  return readingOf(key) !== undefined;
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
  /** The bytes were decoded from text that reads as base64 by its alphabet alone, not from a
   * `data:` URL or a field its convention declares base64. */
  bareBase64?: boolean;
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
    ...(decoded !== undefined && !url ? { bareBase64: true } : {}),
  };
}

/** JSON text a placed file sits in: its edits, at JSON pointers relative to `at`, the pointer of
 * the text in the recorded value ("" for the value itself). */
export interface MediaDocument {
  at: string;
  edits: JsonEdit[];
}

/** A string inside a recorded value whose JSON the walk read (a tool call's arguments, a tool
 * result): written again once a file inside it is placed, every byte the placement does not
 * change kept as recorded. */
export interface EncodedValue extends MediaDocument {
  owner: Record<string, unknown>;
  key: string;
  value: unknown;
  dirty: boolean;
  /** The string as recorded. */
  text: string;
  /** The JSON text the string sits in: an encoded string's, else the recorded value's. */
  parent: MediaDocument;
}

/** A part and the exact leaf that contains its bytes. Nested provider metadata stays in place. */
export interface InlineFilePart {
  /** The part that carries the digest: the provider part, or for OpenAI assistant audio the
   * message. Unused for a whole string. */
  part: Record<string, unknown>;
  owner: Record<string, unknown> | unknown[];
  key: string | number;
  content: string;
  pointer: string;
  partPointer: string;
  contentType?: string;
  name?: string;
  base64?: boolean;
  /** A whole string that is a `data:` URL: replaced by a GenAI `blob` part in digest form. */
  whole?: boolean;
  /** The JSON-encoded strings the file sits in, outermost first: no `hue.blobs` key can address
   * inside a string, so such a file is placed by its digest. */
  encoded?: EncodedValue[];
  /** The JSON text the file sits in, which records its placement as edits. */
  document?: MediaDocument;
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
/** Cheap shared prefilter before bounded parsing of the attributes inspected for media. */
export function mayInlineFiles(key: string, value: unknown): boolean {
  return isMediaKey(key) && mayHoldMedia(value);
}

/** Whether text may hold inline media at all: cheap, before it is parsed or walked. */
export function mayHoldMedia(value: unknown): value is string {
  return (
    typeof value === "string" &&
    [
      "blob",
      "file",
      "image",
      "document",
      "media",
      "inlineData",
      "inline_data",
      "audio",
      "data:",
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
  } else if (part.type === "input_image" || part.type === "computer_screenshot") {
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

/** A media type as a `data:` URL declares one: `type/subtype`, no parameters. */
const declaredMediaType = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9!#$&^_.+-]+$/;

/** The media type a whole string that is a `data:` URL declares, when it declares one: such a
 * string is a file wherever it sits. A web URL, or any other text, is not. */
function dataUrlType(text: string): string | undefined {
  if (!text.startsWith("data:")) return undefined;
  const header = dataUrl.exec(text);
  if (!header) return undefined;
  const type = header[1]!.split(";")[0]!.trim();
  return declaredMediaType.test(type) && isMediaContentType(type) ? type : undefined;
}

/** The modality a media type implies, as Hue's reader names it. */
export function modalityOf(mediaType: string): "image" | "audio" | "video" | "document" | "file" {
  const type = mediaType.split(";")[0]!.trim().toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (
    type.startsWith("text/") ||
    type === "application/pdf" ||
    type === "application/rtf" ||
    type === "application/msword" ||
    type === "application/vnd.ms-excel" ||
    type === "application/vnd.ms-powerpoint" ||
    type.startsWith("application/vnd.openxmlformats-officedocument.")
  )
    return "document";
  return "file";
}

/** The media types OpenAI's audio `format` names; any other valid name is `audio/<name>`. */
const audioFormats: Record<string, string> = {
  mp3: "audio/mpeg",
  mpeg: "audio/mpeg",
  mpga: "audio/mpeg",
  wav: "audio/wav",
  wave: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  webm: "audio/webm",
  pcm16: "audio/pcm",
  pcm: "audio/pcm",
};

function audioFormatMediaType(format: string): string | undefined {
  const name = format.trim().toLowerCase();
  if (!/^[a-z0-9.+-]{1,32}$/.test(name)) return undefined;
  return Object.hasOwn(audioFormats, name) ? audioFormats[name] : `audio/${name}`;
}

/** The media type the first bytes of base64 audio name by their container's signature (WAV,
 * MP3, AAC, FLAC, Ogg): OpenAI's assistant audio keeps only the bytes, in the format the request
 * asked for. Raw PCM has no signature and no type. */
function audioSignatureMediaType(base64: string): string | undefined {
  const head = Buffer.from(base64.slice(0, 16), "base64");
  const text = (start: number, end: number) => head.subarray(start, end).toString("latin1");
  if (text(0, 4) === "RIFF" && text(8, 12) === "WAVE") return "audio/wav";
  if (text(0, 3) === "ID3") return "audio/mpeg";
  if (text(0, 4) === "fLaC") return "audio/flac";
  if (text(0, 4) === "OggS") return "audio/ogg";
  // An MPEG frame's sync word: layer bits 00 are an AAC ADTS frame, any other an MP3 frame.
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xf0) === 0xf0)
    return (head[1]! & 0x06) === 0 ? "audio/aac" : "audio/mpeg";
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) return "audio/mpeg";
  return undefined;
}

/** A label as Hue's reader takes one: nonempty once trimmed, at most 256 code units. */
function readerLabel(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  const text = value.trim();
  return text.length > 0 && text.length <= 256;
}

/**
 * The keys of a value Hue's reader reads as a file by its shape, where the SDK found no inline
 * bytes to upload in it (a remote URL, a provider file id, an empty or malformed field): nothing
 * inside them is read as another file, so nothing inside them is replaced either. Undefined for a
 * value that is no file. Mirrors the reader's shapes (`mediaPartOf`).
 */
function readerConsumed(part: Record<string, unknown>): readonly string[] | undefined {
  const type =
    typeof part.type === "string" ? part.type.toLowerCase().replaceAll("-", "_") : undefined;
  const size = part.size ?? part.byte_size;
  const digest =
    (typeof part.sha256 === "string" && /^[0-9a-f]{64}$/.test(part.sha256)) ||
    (typeof size === "number" && Number.isSafeInteger(size) && size >= 0);
  const identifies = (content: unknown, fileId?: unknown) =>
    (typeof content === "string" && content.length > 0) || readerLabel(fileId) || digest;
  const anthropic = () => {
    const source = object(part.source);
    return source && source.type !== "content"
      ? ["type", "source", "title", "name", "filename", "cache_control"]
      : undefined;
  };
  switch (type) {
    case "blob":
      return ["type", "content", "mime_type", "modality", "name", "filename", "transcript"];
    case "uri":
      return ["type", "uri", "mime_type", "modality", "name", "filename", "transcript"];
    case "file": {
      const file = object(part.file);
      if (file) return identifies(file.file_data, file.file_id) ? ["type", "file"] : undefined;
      if (typeof part.file_id === "string" || typeof part.modality === "string")
        return identifies(undefined, part.file_id)
          ? ["type", "file_id", "mime_type", "modality", "name", "filename"]
          : undefined;
      return identifies(part.data)
        ? ["type", "data", "mediaType", "mimeType", "filename", "name", "providerOptions"]
        : undefined;
    }
    case "image":
      if (object(part.source)) return anthropic();
      return typeof part.image === "string" || digest
        ? ["type", "image", "mediaType", "mimeType", "filename", "name", "providerOptions"]
        : undefined;
    case "document":
      return anthropic();
    case "image_url":
      return ["type", "image_url"];
    case "input_image":
      return ["type", "image_url", "file_id", "detail"];
    case "input_audio":
      return ["type", "input_audio", "data", "format", "transcript"];
    case "input_file":
      return ["type", "file_data", "file_url", "file_id", "filename", "name"];
    case "computer_screenshot":
      return ["type", "image_url", "file_id"];
    case "media":
      return ["type", "data", "mime_type", "file_uri", "fileUri", "name", "filename"];
    case undefined: {
      for (const key of ["inlineData", "inline_data", "fileData", "file_data"])
        if (object(part[key])) return [key];
      for (const key of ["image", "document"]) if (object(object(part[key])?.source)) return [key];
      const audio = object(part.audio);
      if (
        audio &&
        typeof audio.id === "string" &&
        (typeof audio.data === "string" ||
          typeof audio.transcript === "string" ||
          typeof audio.expires_at === "number")
      )
        return ["audio"];
      return undefined;
    }
    default:
      return undefined;
  }
}

/** The keys of a part whose string value is JSON by its convention, read as the value it encodes:
 * a tool call's `arguments`, a tool result, and a `tool` or `function` message's `content`. A
 * message's own text is never read as JSON. */
function encodedJsonKeys(item: Record<string, unknown>): readonly string[] {
  if (item.role === "tool" || item.role === "function") return ["content"];
  const type =
    typeof item.type === "string" ? item.type.toLowerCase().replaceAll("-", "_") : undefined;
  if (type === "tool_call" || type === "function_call") return ["arguments"];
  if (type === "tool_result" || type === "function_call_output" || type === "tool_call_response")
    return ["output", "result", "content", "response"];
  if (typeof item.name === "string" && Object.hasOwn(item, "arguments")) return ["arguments"];
  return [];
}

/** The object or array a JSON-encoded string holds; undefined for any other string. */
function encodedJsonValue(text: string): unknown {
  if (!/^\s*[[{]/.test(text)) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** How deep Hue's reader looks for files in a recorded value: a part more than ten levels below
 * the value's root (an encoded string's JSON counting as a level) is not read as a file, so it is
 * not inspected either. */
export const MAX_MEDIA_DEPTH = 10;

/**
 * Whether Hue's reader reads JSON text as the value it encodes, and so reads files in it: nested
 * at most 32 levels, with no number JavaScript cannot hold exactly (an integer past 2^53, or one
 * past the double range). Hue keeps any other text as it is, so the SDK leaves it as recorded.
 */
export function readerParses(value: unknown): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length) {
    const [item, depth] = stack.pop()!;
    if (depth > 32) return false;
    if (
      typeof item === "number" &&
      (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))
    )
      return false;
    if (item !== null && typeof item === "object")
      for (const child of Object.values(item)) stack.push([child, depth + 1]);
  }
  return true;
}

/** The files a recorded value holds, the box holding the value (so a whole-string file at its
 * root can be replaced), the JSON-encoded strings the walk read, innermost first, to write again
 * once a file inside one is placed, and the value's own JSON text when it was read from text. */
export interface MediaValue {
  box: { value: unknown };
  files: InlineFilePart[];
  encoded: EncodedValue[];
  /** The value's JSON text as recorded, edited in place when its files are placed. */
  source?: string;
  document: MediaDocument;
}

/**
 * Every file a recorded value carries for upload, in reading order, as Hue's reader finds them
 * (`forEachMediaPart`): a provider part with inline bytes, an OpenAI assistant message's audio,
 * a whole string that is a typed `data:` URL, and the files inside a tool call's or tool result's
 * JSON-encoded string. A part whose bytes are not inline (a remote URL, a file id) is left whole.
 * The caller applies the decoded text threshold.
 */
export function mediaIn(value: unknown, source?: string): MediaValue {
  const box = { value };
  const files: InlineFilePart[] = [];
  const encoded: EncodedValue[] = [];
  const document: MediaDocument = { at: "", edits: [] };
  const visit = (
    node: unknown,
    pointer: string,
    depth: number,
    owner: Record<string, unknown> | unknown[],
    key: string | number,
    within: EncodedValue[],
  ): void => {
    if (depth > MAX_MEDIA_DEPTH) return;
    const add = (file: InlineFilePart) =>
      files.push({
        ...file,
        ...(within.length ? { encoded: within } : {}),
        document: within.at(-1) ?? document,
      });
    if (typeof node === "string") {
      const type = dataUrlType(node);
      if (type !== undefined)
        add({
          part: {},
          owner,
          key,
          content: node,
          pointer,
          partPointer: pointer,
          contentType: type,
          whole: true,
        });
      return;
    }
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index++)
        visit(node[index], `${pointer}/${index}`, depth + 1, node, index, within);
      return;
    }
    const part = object(node);
    if (!part) return;
    const file = contentPath(part, pointer);
    if (file) {
      add(file);
      return;
    }
    const consumed = readerConsumed(part);
    // An OpenAI Chat assistant message's spoken reply: the message is the part.
    const audio =
      consumed?.length === 1 && consumed[0] === "audio" ? object(part.audio)! : undefined;
    if (
      audio &&
      typeof audio.data === "string" &&
      audio.data.length % 4 === 0 &&
      base64.test(audio.data)
    ) {
      const format = typeof audio.format === "string" && audio.format ? audio.format : undefined;
      const contentType = format
        ? audioFormatMediaType(format)
        : audioSignatureMediaType(audio.data);
      add({
        part,
        owner: audio,
        key: "data",
        content: audio.data,
        pointer: `${pointer}/audio/data`,
        partPointer: pointer,
        ...(contentType ? { contentType } : {}),
        base64: true,
      });
    }
    const encodedKeys = encodedJsonKeys(part);
    for (const [name, item] of Object.entries(part)) {
      if (consumed?.includes(name)) continue;
      const at = `${pointer}/${pointerSegment(name)}`;
      const inner =
        typeof item === "string" && encodedKeys.includes(name) ? encodedJsonValue(item) : undefined;
      if (inner !== undefined) {
        const holder: EncodedValue = {
          owner: part,
          key: name,
          value: inner,
          dirty: false,
          text: item as string,
          at,
          edits: [],
          parent: within.at(-1) ?? document,
        };
        const before = files.length;
        visit(inner, at, depth + 1, holder as unknown as Record<string, unknown>, "value", [
          ...within,
          holder,
        ]);
        if (files.length > before) encoded.push(holder);
        continue;
      }
      visit(item, at, depth + 1, part, name, within);
    }
  };
  visit(value, "", 0, box, "value", []);
  return { box, files, encoded, document, ...(source !== undefined ? { source } : {}) };
}

/**
 * An attribute's recorded text read for files as Hue's reader reads that attribute: JSON by its
 * convention; metadata as JSON when it reads as an object or array, otherwise as the text itself;
 * an OpenLLMetry content as the parts list it encodes (any other content stays text); an
 * OpenInference image URL as the text itself. Undefined for text that reading finds nothing in.
 * Throws for JSON that does not parse or nests too deep.
 */
export function readMediaText(key: string, text: string): MediaValue | undefined {
  /** JSON text read as Hue's reader reads it: text it keeps as text holds no file. */
  const json = (parsed: unknown) => (readerParses(parsed) ? mediaIn(parsed, text) : undefined);
  switch (readingOf(key)) {
    case "json":
      return json(JSON.parse(text));
    case "metadata":
      return /^\s*[[{]/.test(text) ? json(JSON.parse(text)) : mediaIn(text);
    case "parts": {
      if (!/^\s*\[/.test(text)) return undefined;
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((part) => typeof object(part)?.type === "string")
        ? json(parsed)
        : undefined;
    }
    case "url":
      return mediaIn(text);
    default:
      return undefined;
  }
}

/** The recorded value's text once its files are placed: its JSON text as recorded with only the
 * placed files' values (or their parts' members) replaced, each JSON-encoded string a placed file
 * sits in written again the same way, innermost first. */
export function placedMediaText(media: MediaValue): string {
  reencodeMedia(media);
  return media.source !== undefined
    ? applyJsonEdits(media.source, media.document.edits)
    : JSON.stringify(media.box.value);
}

/** Each JSON-encoded string a placed file sits in, written again, innermost first: the string as
 * recorded with only its placed files changed. */
export function reencodeMedia(media: MediaValue): void {
  for (const holder of media.encoded) {
    if (!holder.dirty) continue;
    const text = applyJsonEdits(holder.text, holder.edits);
    holder.owner[holder.key] = text;
    holder.dirty = false;
    holder.parent.edits.push({
      pointer: holder.at.slice(holder.parent.at.length),
      value: JSON.stringify(text),
    });
  }
}

/** Whether a found file has bytes to place: nonempty, and a whole string's `data:` URL decodes. */
export function placeable(file: InlineFilePart, decoded: InlineFileBytes): boolean {
  return decoded.bytes.byteLength > 0 && (!file.whole || decoded.decoded);
}

/** Whether an uploaded file keeps a 16 KiB prefix of its content in place (text media in a
 * provider part, whose entry names the content) rather than its digest. A whole string, a file
 * inside a JSON-encoded string, and a text file a part holds as bare base64 (a GenAI `blob`,
 * Vertex `media` or AI SDK part, whose content is not the text itself) take the digest form. */
export function keepsPrefix(
  file: InlineFilePart,
  textual: boolean,
  decoded: InlineFileBytes,
): boolean {
  return textual && !file.whole && !file.encoded?.length && !decoded.bareBase64;
}

/** A file's bytes: a field its convention declares base64 decoded, any other content read as
 * Hue's reader reads it, whatever the part's media type (`inlineFileBytes`): a `data:` URL by its
 * own encoding, text that reads as base64 decoded (what the GenAI conventions, and
 * `client.media.resolve`, write in a `blob` or `media` part for every media type), anything else
 * as its UTF-8. */
export function mediaBytes(file: InlineFilePart): InlineFileBytes {
  if (file.base64) return { bytes: Buffer.from(file.content, "base64"), decoded: true };
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

/** The GenAI `blob` part in digest form a whole-string file is replaced by. */
function blobPart(contentType: string, digest: FileDigest): Record<string, unknown> {
  return {
    type: "blob",
    mime_type: contentType,
    modality: modalityOf(contentType),
    sha256: digest.sha256,
    size: digest.size,
  };
}

/** Digest placement removes only the leaf and adds identity to the provider part (the message,
 * for OpenAI assistant audio); a whole string becomes a GenAI `blob` part in digest form. */
export function digestPart(file: InlineFilePart, digest: FileDigest): void {
  const owner = file.owner as Record<string | number, unknown>;
  const document = file.document;
  const at = (pointer: string) => pointer.slice(document!.at.length);
  if (file.whole) {
    const part = blobPart(file.contentType!, digest);
    owner[file.key] = part;
    document?.edits.push({ pointer: at(file.pointer), value: JSON.stringify(part) });
  } else {
    delete owner[file.key];
    file.part.sha256 = digest.sha256;
    file.part.size = digest.size;
    if (document) {
      const set: [string, string][] = [
        ["sha256", JSON.stringify(digest.sha256)],
        ["size", String(digest.size)],
      ];
      const ownerPointer = file.pointer.slice(0, file.pointer.lastIndexOf("/"));
      if (ownerPointer === file.partPointer)
        document.edits.push({ pointer: at(ownerPointer), remove: String(file.key), set });
      else {
        document.edits.push({ pointer: at(ownerPointer), remove: String(file.key) });
        document.edits.push({ pointer: at(file.partPointer), set });
      }
    }
  }
  for (const holder of file.encoded ?? []) holder.dirty = true;
}

/** Prefix placement keeps the first 16 KiB of a text file's content in place. */
export function prefixPart(file: InlineFilePart, prefix: string): void {
  (file.owner as Record<string | number, unknown>)[file.key] = prefix;
  file.document?.edits.push({
    pointer: file.pointer.slice(file.document.at.length),
    value: JSON.stringify(prefix),
  });
  for (const holder of file.encoded ?? []) holder.dirty = true;
}

/**
 * A span's own attribute with its inline media replaced by their digest, as export places media
 * it does not upload. Only the recorded message attributes (`isMessageKey`) shrink without an
 * upload; every other inspected attribute keeps its bytes inline unless they upload, so `anyKey`
 * asks for the digest form of any inspected attribute (what the queue is charged for a value it
 * holds whole for upload).
 */
export function hashInlineFiles(
  key: string,
  value: unknown,
  count?: { files: number },
  memo?: MediaDigestMemo,
  traceId = "",
  anyKey = false,
): unknown {
  return anyKey || isMessageKey(key) ? hashFiles(key, value, false, count, memo, traceId) : value;
}

/** Nested message attributes retain small media and digest larger media without upload state. */
export function hashNestedInlineFiles(
  key: string,
  value: unknown,
  count?: { files: number },
): unknown {
  return isMessageKey(key) ? hashFiles(key, value, true, count) : value;
}

/**
 * Each file a recorded value holds replaced by its digest, as export places a file it does not
 * upload: binary media of any size (`nested`: over the inline limit) and text media over the
 * inline limit. Whether any was replaced; `count` counts them.
 */
export function digestMedia(
  media: MediaValue,
  nested: boolean,
  count?: { files: number },
  memo?: MediaDigestMemo,
  traceId = "",
): boolean {
  let changed = false;
  for (const file of media.files) {
    const decoded = mediaBytes(file);
    if (!placeable(file, decoded)) continue;
    if (
      (nested || isTextMediaType(mediaContentType(file, decoded))) &&
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
  if (changed) reencodeMedia(media);
  return changed;
}

/**
 * The UTF-8 size of a structured value's JSON once each file the SDK may upload from it, within
 * the inspection limits, is placed in its digest form: whether a log body over the value cap fits
 * it once its media upload. Mutates `value`, a copy the caller owns.
 */
export function digestFormBytes(value: unknown): number {
  const media = mediaIn(value);
  let inspected = 0;
  for (const file of media.files) {
    const units = file.content.length;
    if (units > MAX_INLINE_FILE_TEXT || inspected + units > INLINE_FILE_TEXT_PER_RECORD) continue;
    inspected += units;
    const decoded = mediaBytes(file);
    if (!placeable(file, decoded)) continue;
    if (
      isTextMediaType(mediaContentType(file, decoded)) &&
      decoded.bytes.byteLength <= INLINE_FILE_LIMIT
    )
      continue;
    digestPart(file, { sha256: "0".repeat(64), size: decoded.bytes.byteLength });
  }
  reencodeMedia(media);
  return Buffer.byteLength(JSON.stringify(media.box.value));
}

function hashFiles(
  key: string,
  value: unknown,
  nested: boolean,
  count?: { files: number },
  memo?: MediaDigestMemo,
  traceId = "",
): unknown {
  if (
    typeof value !== "string" ||
    !mayInlineFiles(key, value) ||
    value.length > MAX_INLINE_FILE_TEXT
  )
    return value;
  try {
    const media = readMediaText(key, value);
    if (!media || !digestMedia(media, nested, count, memo, traceId)) return value;
    return placedMediaText(media);
  } catch {
    return value;
  }
}
