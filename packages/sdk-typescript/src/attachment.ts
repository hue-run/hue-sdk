import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { types as utilTypes } from "node:util";
import { MAX_FILE_DATA_BYTES } from "./config.js";
import { inlineFileBytes, isMediaContentType, isMediaName } from "./inline-files.js";

/** How deep in a value an attachment's part may sit and still be uploaded: Hue reads media parts
 * within ten levels of the value's root. */
export const MAX_ATTACHMENT_DEPTH = 10;

/** Options for {@link Attachment}. Give exactly one of `data` and `path`. */
export interface AttachmentOptions {
  /** The file's bytes (a `Buffer`, typed array or `ArrayBuffer`), or a string holding them as
   * base64 or a `data:` URL. */
  data?: ArrayBufferView | ArrayBuffer | string;
  /** A file to read when the attachment is created (Node.js file system). */
  path?: string;
  /** The file's media type, such as `image/png` or `application/pdf`. */
  contentType: string;
  /** The file name, recorded when `captureContent` is true. */
  name?: string;
}

/** What an attachment holds, read by the client and transport only. */
export interface AttachmentState {
  /** The file's bytes; undefined for an attachment that could not be read or is invalid. */
  bytes?: Uint8Array;
  sha256?: string;
  contentType: string;
  /** The name, when it is a valid media name. */
  name?: string;
  /** A name was given and is not a valid media name: it is omitted and counted. */
  invalidName: boolean;
}

const states = new WeakMap<Attachment, AttachmentState>();
/** A strict base64 string: alphabet characters only, padded to a multiple of four. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The bytes of a string attachment: a `data:` URL by its own encoding, else strict base64. */
function stringBytes(text: string): Uint8Array | undefined {
  if (text.startsWith("data:")) {
    const decoded = inlineFileBytes(text);
    return decoded.decoded ? decoded.bytes : undefined;
  }
  if (text.length % 4 !== 0 || !BASE64.test(text)) return undefined;
  return Buffer.from(text, "base64");
}

/** A file's bytes, read through one descriptor and never past the limit. */
function fileBytes(path: string): Uint8Array | undefined {
  const descriptor = openSync(path, "r");
  try {
    if (fstatSync(descriptor).size > MAX_FILE_DATA_BYTES) return undefined;
    // Read to its end, which may lie past its size as stated (a file that grew, a pipe), but
    // never more than one byte past the limit.
    const parts: Buffer[] = [];
    let total = 0;
    for (;;) {
      const room = Math.min(1 << 20, MAX_FILE_DATA_BYTES + 1 - total);
      if (room <= 0) return undefined;
      const buffer = Buffer.alloc(room);
      const read = readSync(descriptor, buffer, 0, room, null);
      if (read === 0) break;
      parts.push(buffer.subarray(0, read));
      total += read;
    }
    return Buffer.concat(parts, total);
  } finally {
    closeSync(descriptor);
  }
}

function attachmentBytes(options: AttachmentOptions): Uint8Array | undefined {
  const { data, path } = options;
  if ((data === undefined) === (path === undefined)) return undefined;
  let bytes: Uint8Array | undefined;
  if (typeof path === "string") bytes = path ? fileBytes(path) : undefined;
  else if (typeof data === "string") {
    if (data.length > 4 * MAX_FILE_DATA_BYTES) return undefined;
    bytes = stringBytes(data);
  }
  // A copy, so a later change to the caller's buffer cannot change what the digest describes;
  // bytes over the limit are refused before anything is copied.
  else if (ArrayBuffer.isView(data)) {
    if (data.byteLength > MAX_FILE_DATA_BYTES) return undefined;
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  } else if (data instanceof ArrayBuffer) {
    if (data.byteLength > MAX_FILE_DATA_BYTES) return undefined;
    bytes = new Uint8Array(data.slice(0));
  }
  return bytes && bytes.byteLength <= MAX_FILE_DATA_BYTES ? bytes : undefined;
}

/**
 * A file placed in a recorded value, the equivalent of Langfuse's `LangfuseMedia` and
 * Braintrust's `Attachment`. Put it anywhere in a `withSpan()` input or output, in `model()`
 * messages, in a tool's arguments or result, in `recordMessages()` messages or in a span
 * attribute passed to `withSpan()`. Hue records it at that position as a GenAI `blob` part that
 * names the file by digest (`{ type: "blob", mime_type, modality, sha256, size, name }`) and
 * uploads its bytes during export, listed under the record's `hue.blobs`.
 *
 * The bytes are read and hashed when the attachment is created; `data` and `path` are limited to
 * 25 MiB. Creating one never throws: an attachment without exactly one of `data` and `path`, with
 * unreadable data, larger data or an invalid `contentType` records `null` where it is placed and
 * counts an instrumentation failure; an invalid `name` alone is omitted and counted.
 */
export class Attachment {
  /** The media type given. */
  readonly contentType: string;
  /** The name given, when it is a valid media name. */
  readonly name: string | undefined;
  /** Lowercase hex SHA-256 of the bytes; undefined for an invalid attachment. */
  readonly sha256: string | undefined;
  /** Size of the bytes; undefined for an invalid attachment. */
  readonly size: number | undefined;

  constructor(options: AttachmentOptions) {
    const contentType = options?.contentType;
    const name = options?.name;
    let bytes: Uint8Array | undefined;
    try {
      bytes = isMediaContentType(contentType) ? attachmentBytes(options) : undefined;
    } catch {
      // An unreadable path, or data that is not bytes: the attachment is invalid.
      bytes = undefined;
    }
    const sha256 = bytes ? createHash("sha256").update(bytes).digest("hex") : undefined;
    this.contentType = typeof contentType === "string" ? contentType : "";
    this.name = isMediaName(name) ? name : undefined;
    this.sha256 = sha256;
    this.size = bytes?.byteLength;
    states.set(this, {
      ...(bytes ? { bytes, sha256 } : {}),
      contentType: this.contentType,
      ...(this.name === undefined ? {} : { name: this.name }),
      invalidName: name !== undefined && name !== null && this.name === undefined,
    });
  }
}

/** @internal The attachment's bytes and validated fields; undefined for anything else. */
export function attachmentState(value: unknown): AttachmentState | undefined {
  return value instanceof Attachment ? states.get(value) : undefined;
}

/** The modality a media type implies, as Hue reads a part's media type. */
export function modalityOf(contentType: string): string {
  const type = contentType.split(";", 1)[0]!.trim().toLowerCase();
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

/** An attachment's digest-form GenAI part, the name only with content capture; undefined for an
 * invalid attachment. */
export function attachmentPart(
  state: AttachmentState,
  captureContent: boolean,
): Record<string, unknown> | undefined {
  if (!state.bytes || !state.sha256) return undefined;
  return {
    type: "blob",
    mime_type: state.contentType,
    modality: modalityOf(state.contentType),
    sha256: state.sha256,
    size: state.bytes.byteLength,
    ...(captureContent && state.name !== undefined ? { name: state.name } : {}),
  };
}

/** One attachment as a value is encoded: its state, its part (undefined when invalid), and the
 * JSON pointer and depth of its position. */
export interface PlacedAttachment {
  state: AttachmentState;
  part?: Record<string, unknown>;
  pointer: string;
  depth: number;
}

/** Whether a value holds an attachment anywhere, within the encoder's bounds. */
export function holdsAttachment(value: unknown): boolean {
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    // Proxies and accessors are never touched: reading them could run application code.
    if (item === null || typeof item !== "object" || utilTypes.isProxy(item)) return false;
    if (item instanceof Attachment) return true;
    if (depth > 32 || ++nodes > 65_536) return false;
    const prototype: unknown = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) return false;
    return Object.keys(item).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      return (
        descriptor !== undefined && "value" in descriptor && visit(descriptor.value, depth + 1)
      );
    });
  };
  try {
    return visit(value, 0);
  } catch {
    return false;
  }
}

/** A JSON pointer's reference token. */
export function pointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** The digest parts in `value` (within {@link MAX_ATTACHMENT_DEPTH}) that are the `files`' own
 * parts: an object with `type` `blob`, no `content`, and the file's `sha256`, `size` and
 * `mime_type`. Each found part takes one file of that digest, in the value's order; a part's
 * `name`, when valid, is the one it carries. */
export function locateParts<
  T extends { digest: { sha256: string; size: number }; contentType: string },
>(value: unknown, files: readonly T[]): { file: T; pointer: string; name?: string }[] {
  const pending = [...files];
  const found: { file: T; pointer: string; name?: string }[] = [];
  let nodes = 0;
  const visit = (node: unknown, pointer: string, depth: number): void => {
    if (!pending.length || depth > MAX_ATTACHMENT_DEPTH || ++nodes > 1_048_576) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${pointer}/${index}`, depth + 1));
      return;
    }
    if (node === null || typeof node !== "object") return;
    const part = node as Record<string, unknown>;
    if (part.type === "blob" && !Object.hasOwn(part, "content")) {
      const index = pending.findIndex(
        (file) =>
          part.sha256 === file.digest.sha256 &&
          part.size === file.digest.size &&
          part.mime_type === file.contentType,
      );
      if (index !== -1) {
        const [file] = pending.splice(index, 1);
        found.push({
          file: file!,
          pointer,
          ...(isMediaName(part.name) ? { name: part.name } : {}),
        });
        return;
      }
    }
    for (const [key, item] of Object.entries(part))
      visit(item, `${pointer}/${pointerSegment(key)}`, depth + 1);
  };
  visit(value, "", 0);
  return found;
}
