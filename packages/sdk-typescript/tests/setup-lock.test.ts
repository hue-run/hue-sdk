import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rmdir, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSetupCommandLock } from "../src/setup/lock.js";

const moduleUrl = new URL("../src/setup/lock.ts", import.meta.url).href;

function startChild(project: string, temporary: string, origin: string, exercise = true) {
  // Every child imports the real lock implementation. The output is a closed,
  // non-secret outcome; no inherited environment or process arguments are logged.
  const script = `
    import { acquireSetupCommandLock } from ${JSON.stringify(moduleUrl)};
    let release;
    try { release = await acquireSetupCommandLock(${JSON.stringify(project)}); }
    catch { process.stdout.write("blocked\\n"); process.exit(0); }
    if (${exercise}) await fetch(${JSON.stringify(origin)});
    process.stdout.write("owned\\n");
    process.stdin.once("data", async () => { await release(); process.exit(0); });
    process.stdin.resume();
  `;
  const child = spawn(process.execPath, ["--eval", script], {
    env: {
      ...process.env,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
      XDG_STATE_HOME: temporary,
    },
    stdio: "pipe",
  });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (errors += chunk));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  const ready = new Promise<"owned" | "blocked">((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Lock child did not report readiness")),
      5000,
    );
    child.stdout.on("data", () => {
      if (output === "owned\n" || output === "blocked\n") {
        clearTimeout(timeout);
        resolve(output.trim() as "owned" | "blocked");
      }
    });
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("Lock child could not start"));
    });
  });
  return { child, ready, exited, output: () => output, errors: () => errors };
}

async function stopChild(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await stopped;
}

async function lockPath(project: string) {
  return join(
    await realpath("/tmp"),
    `hue-setup-locks-${process.getuid!()}`,
    createHash("sha256")
      .update(await realpath(project))
      .digest("hex"),
  );
}

test("real processes with different environment-selected directories and aliases share one owner and request", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hue-lock-processes-"));
  const project = join(fixture, "project");
  const alias = join(fixture, "alias");
  const firstTemp = join(fixture, "first-temp");
  const secondTemp = join(fixture, "second-temp");
  await Promise.all([project, firstTemp, secondTemp].map((path) => mkdir(path)));
  await symlink(project, alias, "dir");
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback listener");
  const origin = `http://127.0.0.1:${address.port}/`;
  const owner = startChild(project, firstTemp, origin);
  const children = [owner];
  try {
    expect(await owner.ready).toBe("owned");
    const competitor = startChild(alias, secondTemp, origin);
    children.push(competitor);
    expect(await competitor.ready).toBe("blocked");
    expect(await competitor.exited).toBe(0);
    expect(requests).toBe(1);
    owner.child.stdin.write("release\n");
    expect(await owner.exited).toBe(0);

    // Resume obtains the same released lock but performs no business request.
    const resume = startChild(alias, secondTemp, origin, false);
    children.push(resume);
    expect(await resume.ready).toBe("owned");
    expect(requests).toBe(1);
    resume.child.stdin.write("release\n");
    expect(await resume.exited).toBe(0);
    for (const child of children) expect(child.errors()).toBe("");
  } finally {
    await Promise.all(children.map(({ child }) => stopChild(child)));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rmdir(await lockPath(project)).catch(() => undefined);
  }
}, 15000);

test("a forcible process exit leaves an explicit stale lock and does not replay work", async () => {
  const project = await mkdtemp(join(tmpdir(), "hue-lock-stale-"));
  const temporary = await mkdtemp(join(tmpdir(), "hue-lock-stale-env-"));
  const owner = startChild(project, temporary, "http://127.0.0.1:1/", false);
  try {
    expect(await owner.ready).toBe("owned");
    await stopChild(owner.child);
    await expect(acquireSetupCommandLock(project)).rejects.toThrow("stale local command lock");
    // Only the test operator, after observing child exit, removes this exact lock.
    await rmdir(await lockPath(project));
    await (
      await acquireSetupCommandLock(project)
    )();
  } finally {
    await stopChild(owner.child);
    await rmdir(await lockPath(project)).catch(() => undefined);
  }
});

test("an old owner never removes a replacement lock", async () => {
  const project = await mkdtemp(join(tmpdir(), "hue-lock-replaced-"));
  const release = await acquireSetupCommandLock(project);
  const current = await lockPath(project);
  const displaced = `${current}-displaced`;
  try {
    await rename(current, displaced);
    await mkdir(current, { mode: 0o700 });
    await expect(release()).rejects.toThrow("changed setup command lock");
    await expect(acquireSetupCommandLock(project)).rejects.toThrow("concurrent setup commands");
  } finally {
    await rmdir(current).catch(() => undefined);
    await rmdir(displaced).catch(() => undefined);
  }
});
