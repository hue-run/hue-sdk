import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

const MAX_FILE_BYTES = 32 * 1024;
const IGNORE_RULES = [".hue/installation-*.json", ".hue/.installation-*.tmp"] as const;
const LOCAL_IGNORE_RULES = ["installation-*.json", ".installation-*.tmp"] as const;

export interface SetupStoredCredential {
  apiKey: string;
  keyId: string;
  version: 0 | 1;
}

export interface SetupStoredProbe {
  traceId: string;
  spanId: string;
  credentialVersion: 0 | 1;
  verified: boolean;
}

/** Secret local installation state. It must never be emitted or copied into diagnostics. */
export interface SetupInstallationRecord {
  format: 1;
  origin: string;
  installationId: string;
  installationSecret: string;
  credential?: SetupStoredCredential;
  probe?: SetupStoredProbe;
  provisionAttempts: string[];
  managedFiles: Record<string, string>;
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
}

async function rejectSymlink(path: string, missing = false): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Unsafe setup path symlink");
  } catch (error) {
    if (missing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function cleanupTemporary(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isFile()) await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function atomicWrite(path: string, contents: string, mode: number): Promise<void> {
  await rejectSymlink(path, true);
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, mode);
    await rejectSymlink(path, true);
    await rename(temporary, path);
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await handle?.close();
    await cleanupTemporary(temporary);
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function validCredential(value: unknown): value is SetupStoredCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    exactKeys(item, ["apiKey", "keyId", "version"]) &&
    typeof item.apiKey === "string" &&
    item.apiKey.length > 0 &&
    item.apiKey.length <= 4096 &&
    !/\s/u.test(item.apiKey) &&
    typeof item.keyId === "string" &&
    item.keyId.length > 0 &&
    item.keyId.length <= 256 &&
    (item.version === 0 || item.version === 1)
  );
}

function validProbe(value: unknown): value is SetupStoredProbe {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    exactKeys(item, ["traceId", "spanId", "credentialVersion", "verified"]) &&
    typeof item.traceId === "string" &&
    /^[a-f0-9]{32}$/u.test(item.traceId) &&
    !/^0+$/u.test(item.traceId) &&
    typeof item.spanId === "string" &&
    /^[a-f0-9]{16}$/u.test(item.spanId) &&
    !/^0+$/u.test(item.spanId) &&
    (item.credentialVersion === 0 || item.credentialVersion === 1) &&
    typeof item.verified === "boolean"
  );
}

function parseRecord(value: unknown, origin: string): SetupInstallationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid setup installation record");
  const item = value as Record<string, unknown>;
  const allowed = [
    "format",
    "origin",
    "installationId",
    "installationSecret",
    "provisionAttempts",
    "managedFiles",
    ...(item.credential === undefined ? [] : ["credential"]),
    ...(item.probe === undefined ? [] : ["probe"]),
  ];
  if (
    !exactKeys(item, allowed) ||
    item.format !== 1 ||
    item.origin !== origin ||
    typeof item.installationId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      item.installationId,
    ) ||
    typeof item.installationSecret !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(item.installationSecret) ||
    !Array.isArray(item.provisionAttempts) ||
    item.provisionAttempts.length > 5 ||
    item.provisionAttempts.some(
      (entry) =>
        typeof entry !== "string" || entry.length > 40 || !Number.isFinite(Date.parse(entry)),
    ) ||
    (item.credential !== undefined && !validCredential(item.credential)) ||
    (item.probe !== undefined && !validProbe(item.probe)) ||
    !item.managedFiles ||
    typeof item.managedFiles !== "object" ||
    Array.isArray(item.managedFiles) ||
    Object.entries(item.managedFiles).some(
      ([path, digest]) =>
        !path ||
        path.length > 4096 ||
        typeof digest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(digest),
    )
  )
    throw new Error("Invalid setup installation record");
  return item as unknown as SetupInstallationRecord;
}

/** Owner-only, project/origin-scoped storage for installation proof and telemetry credentials. */
export class FileSetupInstallationStore {
  readonly projectRoot: string;
  readonly origin: string;
  readonly directory: string;
  readonly path: string;

  constructor(projectRoot: string, origin: string) {
    this.projectRoot = resolve(projectRoot);
    this.origin = origin;
    this.directory = join(this.projectRoot, ".hue");
    const originHash = createHash("sha256").update(origin).digest("hex").slice(0, 20);
    this.path = join(this.directory, `installation-${originHash}.json`);
    if (!inside(this.projectRoot, this.path)) throw new Error("Unsafe setup installation path");
  }

  private async ensureIgnoreFile(ignorePath: string, rule: string): Promise<void> {
    await rejectSymlink(ignorePath, true);
    let source = "";
    let mode = 0o644;
    try {
      const info = await lstat(ignorePath);
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error("Unsafe project .gitignore");
      mode = info.mode & 0o777;
      source = await readFile(ignorePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (source.split(/\r?\n/u).includes(rule)) return;
    const separator = source.length === 0 || source.endsWith("\n") ? "" : "\n";
    await atomicWrite(ignorePath, `${source}${separator}${rule}\n`, mode);
  }

  private async ensureIgnored(): Promise<void> {
    for (const rule of IGNORE_RULES)
      await this.ensureIgnoreFile(join(this.projectRoot, ".gitignore"), rule);
  }

  async load(): Promise<SetupInstallationRecord | undefined> {
    await rejectSymlink(this.directory, true);
    await rejectSymlink(this.path, true);
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.size > MAX_FILE_BYTES)
        throw new Error("Unsafe setup installation record");
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
        throw new Error("Setup installation record must use mode 0600");
      return parseRecord(JSON.parse(await readFile(this.path, "utf8")), this.origin);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** Creates and durably saves the installation proof before any caller may perform network I/O. */
  async loadOrCreate(): Promise<SetupInstallationRecord> {
    const existing = await this.load();
    if (existing) return existing;
    await this.ensureIgnored();
    await rejectSymlink(this.directory, true);
    await mkdir(this.directory, { recursive: false, mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    await rejectSymlink(this.directory);
    if (process.platform !== "win32") await chmod(this.directory, 0o700);
    for (const rule of LOCAL_IGNORE_RULES)
      await this.ensureIgnoreFile(join(this.directory, ".gitignore"), rule);
    const record: SetupInstallationRecord = {
      format: 1,
      origin: this.origin,
      installationId: randomUUID().toLowerCase(),
      installationSecret: randomBytes(32).toString("base64url"),
      provisionAttempts: [],
      managedFiles: {},
    };
    try {
      const handle = await open(
        this.path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (process.platform !== "win32") await chmod(this.path, 0o600);
      if (process.platform !== "win32") {
        const directory = await open(this.directory, constants.O_RDONLY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const raced = await this.load();
        if (raced) return raced;
      }
      throw error;
    }
  }

  async save(record: SetupInstallationRecord): Promise<void> {
    parseRecord(record, this.origin);
    await rejectSymlink(this.directory);
    await atomicWrite(this.path, `${JSON.stringify(record)}\n`, 0o600);
  }
}

export function setupManagedDigest(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}
