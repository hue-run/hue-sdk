import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SetupCheckpointAdapter } from "./runner.js";
import type { SetupMachineState } from "./machine.js";

const MAX_CHECKPOINT_BYTES = 256 * 1024;
const STEPS = ["detect-project", "configure-telemetry", "verify-receipt", "claim-project"] as const;

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function defaultSetupStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (platform() === "darwin")
    return join(homedir(), "Library", "Application Support", "Hue", "setup");
  if (platform() === "win32")
    return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Hue", "setup");
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "hue", "setup");
}

/** Stable installer-session identifier; it is not a Hue Run and reveals no path or file contents. */
export function setupRunId(projectRoot: string): string {
  return `setup_${createHash("sha256")
    .update(`hue-setup-v1\0${resolve(projectRoot)}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function validDetection(
  value: unknown,
  projectRoot: string,
): value is Extract<SetupMachineState, { phase: "local-ready" }>["project"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (
    !hasExactKeys(item, [
      "root",
      "fingerprint",
      "languages",
      "packageManagers",
      "frameworks",
      "hue",
      "openTelemetry",
    ])
  )
    return false;
  const allowed = (items: unknown, values: readonly string[], maximum: number) =>
    Array.isArray(items) &&
    items.length <= maximum &&
    new Set(items).size === items.length &&
    items.every((entry) => typeof entry === "string" && values.includes(entry));
  return (
    item.root === projectRoot &&
    typeof item.fingerprint === "string" &&
    /^[a-f0-9]{64}$/u.test(item.fingerprint) &&
    allowed(item.languages, ["typescript", "python"], 2) &&
    allowed(item.packageManagers, ["bun", "npm", "pnpm", "yarn", "uv", "poetry", "pip"], 7) &&
    allowed(
      item.frameworks,
      ["nextjs", "nestjs", "express", "fastapi", "django", "flask", "vercel-ai-sdk"],
      7,
    ) &&
    ["absent", "typescript", "python", "multiple"].includes(item.hue as string) &&
    ["absent", "typescript", "python", "multiple"].includes(item.openTelemetry as string)
  );
}

function validState(
  value: unknown,
  runId: string,
  projectRoot: string,
): value is SetupMachineState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (state.format !== 1 || state.runId !== runId || state.projectRoot !== projectRoot)
    return false;
  if (state.phase === "created" || state.phase === "detecting")
    return hasExactKeys(state, ["format", "phase", "runId", "projectRoot"]);
  if (
    state.phase !== "local-ready" ||
    !hasExactKeys(state, ["format", "phase", "runId", "projectRoot", "project", "plan"]) ||
    !validDetection(state.project, projectRoot)
  )
    return false;
  const plan = state.plan;
  return (
    !!plan &&
    typeof plan === "object" &&
    !Array.isArray(plan) &&
    hasExactKeys(plan as Record<string, unknown>, ["steps", "mutatesProject", "backendRequired"]) &&
    JSON.stringify((plan as Record<string, unknown>).steps) === JSON.stringify(STEPS) &&
    (plan as Record<string, unknown>).mutatesProject === false &&
    (plan as Record<string, unknown>).backendRequired === true
  );
}

export class FileSetupCheckpointAdapter implements SetupCheckpointAdapter {
  constructor(
    readonly directory = defaultSetupStateDirectory(),
    private readonly runtimePlatform: NodeJS.Platform = platform(),
  ) {}

  private get enforcesPosixPermissions(): boolean {
    return this.runtimePlatform !== "win32";
  }

  private async pathFor(runId: string, projectRoot: string): Promise<string> {
    if (!/^setup_[a-f0-9]{24}$/u.test(runId)) throw new Error("Invalid setup run identifier");
    const root = resolve(this.directory);
    const project = await realpath(projectRoot);
    if (isInside(project, root))
      throw new Error("Setup checkpoints must be outside the project repository");
    let info;
    try {
      info = await lstat(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(root, { recursive: true, mode: 0o700 });
      info = await lstat(root);
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Setup checkpoint directory must be private (mode 0700, no symlink)");
    if (this.enforcesPosixPermissions) {
      await chmod(root, 0o700);
      info = await lstat(root);
      if ((info.mode & 0o077) !== 0)
        throw new Error("Setup checkpoint directory must be private (mode 0700, no symlink)");
    }
    return join(root, `${runId}.json`);
  }

  async load(runId: string, projectRoot: string): Promise<SetupMachineState | undefined> {
    const path = await this.pathFor(runId, projectRoot);
    let handle;
    try {
      if (this.runtimePlatform === "win32") {
        const entry = await lstat(path);
        if (entry.isSymbolicLink()) throw new Error("Unsafe setup checkpoint symlink");
      }
      const noFollow = this.runtimePlatform === "win32" ? 0 : constants.O_NOFOLLOW;
      handle = await open(path, constants.O_RDONLY | noFollow);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.size > MAX_CHECKPOINT_BYTES ||
        (this.enforcesPosixPermissions && (info.mode & 0o077) !== 0)
      )
        throw new Error("Unsafe or oversized setup checkpoint");
      const envelope = JSON.parse(await handle.readFile("utf8")) as unknown;
      if (
        !envelope ||
        typeof envelope !== "object" ||
        Array.isArray(envelope) ||
        !hasExactKeys(envelope as Record<string, unknown>, ["state", "digest"])
      )
        throw new Error("Invalid setup checkpoint envelope");
      const { state, digest: expected } = envelope as { state: unknown; digest: unknown };
      if (typeof expected !== "string" || expected !== digest(state))
        throw new Error("Setup checkpoint integrity check failed");
      if (!validState(state, runId, await realpath(projectRoot)))
        throw new Error("Setup checkpoint identity or shape does not match this project");
      return state;
    } finally {
      await handle.close();
    }
  }

  async save(state: SetupMachineState): Promise<void> {
    const path = await this.pathFor(state.runId, state.projectRoot);
    const encoded = `${JSON.stringify({ state, digest: digest(state) })}\n`;
    if (Buffer.byteLength(encoded) > MAX_CHECKPOINT_BYTES)
      throw new Error("Setup checkpoint exceeds 256 KiB");
    const temporary = join(dirname(path), `.${state.runId}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    // Windows cannot open a directory as a file handle for fsync. The atomic rename and
    // per-user state directory still provide resumability there; POSIX additionally fsyncs
    // the containing directory so the rename survives a sudden interruption.
    if (this.runtimePlatform !== "win32") {
      await chmod(path, 0o600);
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  }
}
