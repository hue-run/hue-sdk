import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "./json.js";

/** One owner per directory. A crash leaves .lock for explicit operator recovery. */
export class CheckpointStore {
  private constructor(readonly directory: string) {}
  static async acquire(directory: string, identity: unknown): Promise<CheckpointStore> {
    const root = resolve(directory);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
      throw new Error("Use a private checkpoint directory (mode 0700, no symlink)");
    const store = new CheckpointStore(root);
    try {
      await mkdir(join(root, ".lock"), { mode: 0o700 });
    } catch {
      throw new Error(
        "Checkpoint directory is locked; confirm its owner stopped before explicitly removing .lock",
      );
    }
    try {
      await store.write(".lock/owner", { pid: process.pid });
      const expected = { format: 1, identity, digest: digest(identity) };
      const prior = await store.read<typeof expected>("manifest");
      if (prior && (prior.format !== 1 || prior.digest !== expected.digest))
        throw new Error(
          "Checkpoint identity differs from this project, run, pins or content policy",
        );
      if (!prior) await store.write("manifest", expected);
      return store;
    } catch (error) {
      await store.release();
      throw error;
    }
  }
  async read<T>(key: string): Promise<T | undefined> {
    let file;
    try {
      file = await open(
        join(this.directory, `${key}.json`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 8 * 1024 * 1024 || (info.mode & 0o077) !== 0)
        throw new Error("Unsafe or oversized checkpoint");
      const envelope = JSON.parse(await file.readFile("utf8")) as { value: T; digest: string };
      if (digest(envelope.value) !== envelope.digest)
        throw new Error("Checkpoint integrity check failed");
      return envelope.value;
    } finally {
      await file.close();
    }
  }
  async write(key: string, value: unknown): Promise<void> {
    const encoded = JSON.stringify({ value, digest: digest(value) });
    if (Buffer.byteLength(encoded) > 8 * 1024 * 1024)
      throw new RangeError("Checkpoint exceeds 8 MiB");
    const destination = join(this.directory, `${key}.json`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(encoded);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, destination);
    const directory = await open(this.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async release(): Promise<void> {
    await rm(join(this.directory, ".lock"), { recursive: true });
  }
}
