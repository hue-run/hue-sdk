import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore } from "../src/evals/checkpoint.js";
import { digest } from "../src/evals/json.js";

/** A checkpoint directory whose `.lock` a crashed process left behind with this owner record. */
async function leftLocked(owner: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hue-lock-"));
  await mkdir(join(root, ".lock"), { mode: 0o700 });
  await writeFile(
    join(root, ".lock", "owner.json"),
    JSON.stringify({ value: owner, digest: digest(owner) }),
  );
  return root;
}

/** The ID of a process that has exited and been reaped. */
function exitedPid(): number {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  if (!pid) throw new Error("No child pid");
  return pid;
}

describe("checkpoint lock recovery", () => {
  test("a lock whose owner exited on this machine is reclaimed", async () => {
    const root = await leftLocked({ pid: exitedPid(), host: hostname() });
    try {
      const store = await CheckpointStore.acquire(root, { kind: "test" });
      const owner = JSON.parse(await readFile(join(root, ".lock", "owner.json"), "utf8"));
      expect(owner.value).toEqual({ pid: process.pid, host: hostname() });
      expect(store.reclaimed).toBe(true);
      expect((await readdir(root)).filter((name) => name.startsWith(".lock-stale-"))).toEqual([]);
      await store.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a lock whose owner is still running refuses", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const root = await leftLocked({ pid: child.pid, host: hostname() });
    try {
      await expect(CheckpointStore.acquire(root, { kind: "test" })).rejects.toThrow(
        "may still be running",
      );
    } finally {
      child.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["another machine", () => ({ pid: exitedPid(), host: `${hostname()}-elsewhere` })],
    ["an SDK that recorded no machine", () => ({ pid: exitedPid() })],
    ["an unreadable owner", () => "not an owner"],
  ])("a lock from %s is left for the operator", async (_label, owner) => {
    const root = await leftLocked(owner());
    try {
      await expect(CheckpointStore.acquire(root, { kind: "test" })).rejects.toThrow("locked");
      expect(await readdir(join(root, ".lock"))).toEqual(["owner.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
