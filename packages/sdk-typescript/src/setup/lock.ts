import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Serializes all origins for one project: they share manifests and application files. */
export async function acquireSetupCommandLock(projectRoot: string): Promise<() => Promise<void>> {
  const root = await realpath(projectRoot);
  const parent = join(await realpath(tmpdir()), `hue-setup-locks-${process.getuid?.() ?? "user"}`);
  await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(parent);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
  )
    throw new Error("Refusing unsafe setup command lock directory");
  const path = join(parent, createHash("sha256").update(root).digest("hex"));
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "Refusing concurrent setup commands. Wait for the existing command to finish. If it was forcibly killed, the owner must inspect and remove its stale local command lock before resuming.",
      );
    throw error;
  }
  const acquired = await lstat(path);
  return async () => {
    const current = await lstat(path);
    if (current.ino !== acquired.ino || current.dev !== acquired.dev || !current.isDirectory())
      throw new Error("Refusing to release a changed setup command lock");
    await rmdir(path);
  };
}
