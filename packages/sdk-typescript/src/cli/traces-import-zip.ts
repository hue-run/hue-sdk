import { open, type FileHandle } from "node:fs/promises";
import { crc32, inflateRawSync } from "node:zlib";

/**
 * A bounded reader of ZIP archives for `hue traces import prepare`: the central directory is
 * read from the end of the file, each member is read on demand at its own offset and inflated
 * in memory with `node:zlib`, never with an external command and never onto disk. Only stored
 * and deflated members are read; a member that is encrypted, uses another method, names an
 * unsafe path or exceeds a bound is reported, not read. ZIP64 sizes and offsets are understood,
 * so an archive over 4 GiB or with many members still lists.
 */

export const ZIP_LIMITS = {
  /** Members one archive may list. */
  members: 20_000,
  /** One member, decoded. */
  memberBytes: 64 * 1024 * 1024,
  /** Every member of the archive, decoded, together. */
  totalBytes: 1024 * 1024 * 1024,
  /** The central directory itself. */
  centralDirectoryBytes: 32 * 1024 * 1024,
  /** A member name or extra field. */
  fieldBytes: 65_535,
} as const;

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA = 0x0001;
const END_RECORD_BYTES = 22;
const MAX_COMMENT_BYTES = 65_535;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;

export interface ZipMember {
  /** The member's path as the archive names it. */
  path: string;
  /** Why the member cannot be read, when it cannot; a readable member has none. */
  refused?: string;
  size: number;
  compressedSize: number;
  method: number;
  crc32: number;
  localHeaderOffset: number;
}

export class ZipError extends Error {}

/** Whether a file starts like a ZIP archive: a local header, or the end record of an empty one. */
export function isZipSignature(head: Uint8Array): boolean {
  if (head.byteLength < 4) return false;
  const signature = head[0]! | (head[1]! << 8) | (head[2]! << 16) | (head[3]! << 24);
  return signature === LOCAL_HEADER || signature === END_OF_CENTRAL_DIRECTORY;
}

/**
 * Why a member path must not be read: an absolute path, a drive or network path, a `..`
 * segment, a backslash, a control character or an empty name. A directory entry (ending in
 * `/`) is not a file and is skipped by the caller.
 */
export function unsafeZipPath(path: string): string | undefined {
  if (!path) return "an empty member name";
  if (path.includes("\0") || /[\p{Cc}]/u.test(path)) return "a control character in the name";
  if (path.includes("\\")) return "a backslash in the name";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.startsWith("//"))
    return "an absolute path";
  if (path.split("/").some((segment) => segment === ".." || segment === "."))
    return "a relative path segment";
  if (!path.isWellFormed()) return "an invalid name";
  return undefined;
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new ZipError("The archive ends before a record it names");
    offset += bytesRead;
  }
  return buffer;
}

const readU64 = (buffer: Buffer, offset: number): number => {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError("A ZIP64 field is out of range");
  return Number(value);
};

/** The archive's central directory, listed once; members are read on demand. */
export class ZipArchive {
  private constructor(
    private readonly handle: FileHandle,
    readonly members: readonly ZipMember[],
  ) {}

  static async open(path: string): Promise<ZipArchive> {
    const handle = await open(path, "r");
    try {
      const members = await ZipArchive.list(handle);
      return new ZipArchive(handle, members);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private static async list(handle: FileHandle): Promise<ZipMember[]> {
    const size = (await handle.stat()).size;
    if (size < END_RECORD_BYTES) throw new ZipError("The archive has no end record");
    const tailLength = Math.min(size, END_RECORD_BYTES + MAX_COMMENT_BYTES);
    const tail = await readAt(handle, size - tailLength, tailLength);
    let endOffset = -1;
    for (let at = tailLength - END_RECORD_BYTES; at >= 0; at--) {
      if (tail.readUInt32LE(at) !== END_OF_CENTRAL_DIRECTORY) continue;
      // The record's comment length must reach the end of the file for it to be the end record.
      if (at + END_RECORD_BYTES + tail.readUInt16LE(at + 20) === tailLength) {
        endOffset = at;
        break;
      }
    }
    if (endOffset < 0) throw new ZipError("The archive has no end record");
    const end = tail.subarray(endOffset);
    if (end.readUInt16LE(4) !== 0 || end.readUInt16LE(6) !== 0)
      throw new ZipError("Multi-disk archives are not supported");
    let count = end.readUInt16LE(10);
    let directoryBytes = end.readUInt32LE(12);
    let directoryOffset = end.readUInt32LE(16);
    const endPosition = size - tailLength + endOffset;
    if (count === 0xffff || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff) {
      if (endPosition < 20) throw new ZipError("The ZIP64 locator is missing");
      const locator = await readAt(handle, endPosition - 20, 20);
      if (locator.readUInt32LE(0) !== ZIP64_LOCATOR)
        throw new ZipError("The ZIP64 locator is missing");
      const recordOffset = readU64(locator, 8);
      if (recordOffset + 56 > size) throw new ZipError("The ZIP64 end record is out of range");
      const record = await readAt(handle, recordOffset, 56);
      if (record.readUInt32LE(0) !== ZIP64_END_OF_CENTRAL_DIRECTORY)
        throw new ZipError("The ZIP64 end record is missing");
      if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0)
        throw new ZipError("Multi-disk archives are not supported");
      count = readU64(record, 32);
      directoryBytes = readU64(record, 40);
      directoryOffset = readU64(record, 48);
    }
    if (count > ZIP_LIMITS.members)
      throw new ZipError(`The archive lists more than ${ZIP_LIMITS.members} members`);
    if (directoryBytes > ZIP_LIMITS.centralDirectoryBytes)
      throw new ZipError("The archive's central directory is too large");
    if (directoryOffset + directoryBytes > size)
      throw new ZipError("The archive's central directory is out of range");
    const directory = await readAt(handle, directoryOffset, directoryBytes);
    const members: ZipMember[] = [];
    let at = 0;
    const utf8 = new TextDecoder("utf-8");
    for (let index = 0; index < count; index++) {
      if (at + 46 > directory.byteLength)
        throw new ZipError("The archive's central directory is truncated");
      if (directory.readUInt32LE(at) !== CENTRAL_HEADER)
        throw new ZipError("The archive's central directory is malformed");
      const flags = directory.readUInt16LE(at + 8);
      const method = directory.readUInt16LE(at + 10);
      const crc = directory.readUInt32LE(at + 16);
      let compressedSize = directory.readUInt32LE(at + 20);
      let uncompressedSize = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const disk = directory.readUInt16LE(at + 34);
      let localHeaderOffset = directory.readUInt32LE(at + 42);
      const nameStart = at + 46;
      const extraStart = nameStart + nameLength;
      const next = extraStart + extraLength + commentLength;
      if (next > directory.byteLength)
        throw new ZipError("The archive's central directory is truncated");
      const nameBytes = directory.subarray(nameStart, extraStart);
      const extra = directory.subarray(extraStart, extraStart + extraLength);
      // ZIP64 fields replace, in order, only the header fields that are at their maximum.
      if (
        compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff ||
        localHeaderOffset === 0xffffffff
      ) {
        let field = 0;
        let found = false;
        while (field + 4 <= extra.byteLength) {
          const id = extra.readUInt16LE(field);
          const length = extra.readUInt16LE(field + 2);
          if (id === ZIP64_EXTRA) {
            let cursor = field + 4;
            const take = () => {
              if (cursor + 8 > field + 4 + length)
                throw new ZipError("A ZIP64 extra field is truncated");
              const value = readU64(extra, cursor);
              cursor += 8;
              return value;
            };
            if (uncompressedSize === 0xffffffff) uncompressedSize = take();
            if (compressedSize === 0xffffffff) compressedSize = take();
            if (localHeaderOffset === 0xffffffff) localHeaderOffset = take();
            found = true;
            break;
          }
          field += 4 + length;
        }
        if (!found) throw new ZipError("A member needs a ZIP64 extra field it lacks");
      }
      const path = utf8.decode(nameBytes);
      const member: ZipMember = {
        path,
        size: uncompressedSize,
        compressedSize,
        method,
        crc32: crc,
        localHeaderOffset,
      };
      const unsafe = unsafeZipPath(path);
      if (!(flags & FLAG_UTF8) && nameBytes.some((byte) => byte >= 0x80))
        member.refused = "a member name that is not UTF-8";
      else if (unsafe) member.refused = unsafe;
      else if (disk !== 0) member.refused = "a member on another disk";
      else if (flags & FLAG_ENCRYPTED) member.refused = "an encrypted member";
      else if (method !== METHOD_STORED && method !== METHOD_DEFLATE)
        member.refused = `compression method ${method} (only stored and deflate are read)`;
      else if (uncompressedSize > ZIP_LIMITS.memberBytes)
        member.refused = `a member over ${ZIP_LIMITS.memberBytes} bytes`;
      else if (localHeaderOffset + 30 > size || compressedSize > size)
        member.refused = "a member outside the archive";
      members.push(member);
      at = next;
    }
    return members;
  }

  /** The member's bytes, decoded and checked against its recorded size and CRC-32. */
  async read(member: ZipMember): Promise<Uint8Array> {
    if (member.refused) throw new ZipError(`The member cannot be read: ${member.refused}`);
    const header = await readAt(this.handle, member.localHeaderOffset, 30);
    if (header.readUInt32LE(0) !== LOCAL_HEADER)
      throw new ZipError("A member's local header is malformed");
    const dataOffset =
      member.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const compressed = await readAt(this.handle, dataOffset, member.compressedSize);
    let bytes: Buffer;
    if (member.method === METHOD_STORED) bytes = compressed;
    else {
      try {
        bytes = inflateRawSync(compressed, { maxOutputLength: Math.max(1, member.size) });
      } catch {
        throw new ZipError("A member's compressed data is invalid");
      }
    }
    if (bytes.byteLength !== member.size)
      throw new ZipError("A member's size differs from its recorded size");
    if (crc32(bytes) !== member.crc32) throw new ZipError("A member's CRC-32 does not match");
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}
