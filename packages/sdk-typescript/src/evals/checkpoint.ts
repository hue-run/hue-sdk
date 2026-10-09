import { constants, rmSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { onForcedExit } from "./exit-cleanup.js";
import { digest } from "./json.js";

const CONTENT_POLICY = ["persistResultContent", "captureContent"] as const;

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A server- or user-provided identifier that is safe as a single checkpoint path component:
 * no separators, no `.`/`..`, and it stays directly inside the directory it is joined onto. */
export function checkpointSegment(value: string, label: string): string {
  if (typeof value !== "string" || !SEGMENT.test(value))
    throw new Error(`Refusing to use ${label} ${JSON.stringify(value)} in a checkpoint path`);
  return value;
}

/** `join(directory, ...segments)` after validating every segment. */
export function checkpointPath(directory: string, ...segments: [string, string][]): string {
  const root = resolve(directory);
  const path = resolve(root, ...segments.map(([value, label]) => checkpointSegment(value, label)));
  if (path !== root && !path.startsWith(root.endsWith(sep) ? root : root + sep))
    throw new Error("Checkpoint path escapes its directory");
  return path;
}

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

async function createLock(lock: string): Promise<boolean> {
  try {
    await mkdir(lock, { mode: 0o700 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Whether a process with this ID is running; one owned by another user still counts. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Takes over a lock whose owner ran on this machine and has exited. The lock is moved aside and
 * its owner compared again before it is removed, so a lock another process took meanwhile is put
 * back rather than deleted. A lock without a readable owner, from another machine or from an SDK
 * that did not record the machine is never reclaimed. */
async function reclaimLock(root: string, lock: string): Promise<boolean> {
  const owner = await readFile(join(lock, "owner.json"), "utf8").catch(() => undefined);
  if (owner === undefined) return false;
  let pid: unknown;
  let host: unknown;
  try {
    ({ pid, host } =
      (JSON.parse(owner) as { value?: { pid?: unknown; host?: unknown } }).value ?? {});
  } catch {
    return false;
  }
  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    pid === process.pid ||
    host !== hostname() ||
    running(pid)
  )
    return false;
  const aside = join(root, `.lock-stale-${randomUUID()}`);
  try {
    await rename(lock, aside);
  } catch {
    return false;
  }
  if ((await readFile(join(aside, "owner.json"), "utf8").catch(() => undefined)) !== owner) {
    await rename(aside, lock).catch(() => {});
    return false;
  }
  await rm(aside, { recursive: true, force: true });
  return createLock(lock);
}

/** One owner per directory. A forced exit of `hue eval`, which stops its agents first, releases
 * it; a crash leaves .lock, which the next owner reclaims once the process that held it on this
 * machine has exited. Any other lock is left for explicit operator recovery. */
export class CheckpointStore {
  private untrack = () => {};
  /** Whether this store took over the lock of a process that died here, so whatever that process
   * was running never finished. */
  reclaimed = false;
  private constructor(readonly directory: string) {}
  static async acquire(directory: string, identity: unknown): Promise<CheckpointStore> {
    const root = resolve(directory);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
      throw new Error("Use a private checkpoint directory (mode 0700, no symlink)");
    const store = new CheckpointStore(root);
    const lock = join(root, ".lock");
    const created = await createLock(lock);
    if (!created && !(await reclaimLock(root, lock)))
      throw new Error(
        "Checkpoint directory is locked by a process that may still be running; confirm it stopped before explicitly removing .lock",
      );
    store.reclaimed = !created;
    store.untrack = onForcedExit(() => rmSync(lock, { recursive: true, force: true }));
    try {
      await store.write(".lock/owner", { pid: process.pid, host: hostname() });
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
