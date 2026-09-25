import { constants, rmSync } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { onForcedExit } from "./exit-cleanup.js";
import { digest } from "./json.js";

const CONTENT_POLICY = ["persistResultContent", "captureContent"] as const;

/** The checkpoint belongs to a run started with a different identity. When only its content
 * policy differs, `startedWith` holds the policy the unfinished run was started with. */
export class CheckpointIdentityError extends Error {
  constructor(readonly startedWith?: { persistResultContent?: unknown; captureContent?: unknown }) {
    super(
      startedWith
        ? "Checkpoint content policy differs from the one this unfinished run was started with"
        : "Checkpoint identity differs from this project, run, pins or content policy",
    );
    this.name = "CheckpointIdentityError";
  }
}

/** The prior policy when two identities differ only in their content policy. */
function contentPolicyOnly(prior: unknown, identity: unknown) {
  if (!prior || !identity || typeof prior !== "object" || typeof identity !== "object")
    return undefined;
  const before = prior as Record<string, unknown>;
  const after = identity as Record<string, unknown>;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys)
    if (
      !(CONTENT_POLICY as readonly string[]).includes(key) &&
      JSON.stringify(before[key]) !== JSON.stringify(after[key])
    )
      return undefined;
  return Object.fromEntries(CONTENT_POLICY.map((key) => [key, before[key]]));
}

/** One owner per directory. A crash leaves .lock for explicit operator recovery; a forced exit of
 * `hue eval`, which stops its agents first, releases it. */
export class CheckpointStore {
  private untrack = () => {};
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
      store.untrack = onForcedExit(() =>
        rmSync(join(root, ".lock"), { recursive: true, force: true }),
      );
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
        throw new CheckpointIdentityError(
          prior.format === 1 ? contentPolicyOnly(prior.identity, identity) : undefined,
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
    this.untrack();
  }
}
