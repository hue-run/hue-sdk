import { constants, type Stats } from "node:fs";
import { type FileHandle, open, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";

/** macOS's open(2) flag (macOS 11 and later) that refuses a symbolic link in any component. */
const O_NOFOLLOW_ANY = 0x20000000;
/** Linux's open(2) flag (absent from Node's constants) for a descriptor that only names a file. */
const O_PATH = 0o10000000;
const darwin = process.platform === "darwin";
// O_NOFOLLOW guards only the last component; a FIFO or device never blocks the open.
const READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

const refused = (code: string, message: string) => Object.assign(new Error(message), { code });

/** Where Linux says an open descriptor's file is, however the path to it was resolved. */
function heldAt(handle: FileHandle): Promise<string> {
  return readlink(`/proc/self/fd/${handle.fd}`);
}

/**
 * The canonical path of the directory `path` names, refusing a symbolic link as its last
 * component. The answer is proven on the opened directory, so a link swapped in meanwhile is
 * caught rather than followed. Only Linux and macOS let Node prove where an opened file is, so a
 * tree is refused elsewhere.
 */
export async function canonicalDirectory(path: string): Promise<string> {
  if (process.platform !== "linux" && !darwin)
    throw refused(
      "ENOTSUP",
      "reading a directory tree without following links needs Linux or macOS",
    );
  const handle = await open(path, READ | constants.O_DIRECTORY).catch((error: unknown) => {
    // Linux answers a link opened with O_DIRECTORY and O_NOFOLLOW with ENOTDIR.
    if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
    throw refused("ELOOP", `${path} is a symbolic link or not a directory`);
  });
  try {
    if (!darwin) return await heldAt(handle);
    const canonical = await realpath(path);
    const again = await open(canonical, READ | constants.O_DIRECTORY | O_NOFOLLOW_ANY);
    try {
      const [first, second] = await Promise.all([handle.stat(), again.stat()]);
      if (first.dev !== second.dev || first.ino !== second.ino)
        throw refused("ELOOP", `${path} was replaced while it was opened`);
    } finally {
      await again.close().catch(() => undefined);
    }
    return canonical;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Opens the regular file `label` under `root` (a {@link canonicalDirectory}) for reading. A
 * symbolic link anywhere on the way, there before the lookup or swapped in during it, is refused
 * before the file is opened: macOS refuses it in the open itself; Linux binds the inode with
 * O_PATH (which opens nothing), checks where that inode is, and only then opens that same inode.
 */
export async function openInTree(root: string, label: string): Promise<FileHandle> {
  const path = join(root, label);
  if (darwin) {
    const handle = await open(path, READ | O_NOFOLLOW_ANY);
    try {
      requireOwnFile(await handle.stat(), label);
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }
  const bound = await open(path, O_PATH | constants.O_NOFOLLOW);
  try {
    if ((await heldAt(bound)) !== path) throw refused("ELOOP", `${label} is not inside ${root}`);
    requireOwnFile(await bound.stat(), label);
    // The descriptor's /proc entry reopens the bound inode itself; nothing is looked up again.
    return await open(`/proc/self/fd/${bound.fd}`, constants.O_RDONLY | constants.O_NONBLOCK);
  } finally {
    await bound.close().catch(() => undefined);
  }
}

function requireOwnFile(info: Stats, label: string): void {
  if (!info.isFile()) throw refused("EINVAL", `${label} is not a regular file`);
  // A hard link is a second name: one planted in the tree can name a file kept outside it.
  if (info.nlink !== 1) throw refused("EMLINK", `${label} has another name (a hard link)`);
}

/** Up to `size` bytes from the start of the file, never more however much it has grown. */
export async function readUpTo(handle: FileHandle, size: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  let filled = 0;
  while (filled < size) {
    const { bytesRead } = await handle.read(buffer, filled, size - filled, filled);
    if (!bytesRead) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}
