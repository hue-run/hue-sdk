import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

const MAX_FILE_BYTES = 32 * 1024;
const IGNORE_RULES = [
  ".hue/installation-*.json",
  ".hue/.installation-*.tmp",
  ".hue/claim-handoff-*.html",
  ".hue/.claim-handoff-*.tmp",
  ".hue/application-evidence-*.json",
  ".hue/.application-evidence-*.tmp",
] as const;
const LOCAL_IGNORE_RULES = [
  "installation-*.json",
  ".installation-*.tmp",
  "claim-handoff-*.html",
  ".claim-handoff-*.tmp",
  "application-evidence-*.json",
  ".application-evidence-*.tmp",
] as const;

/** Telemetry credential saved only in an ignored owner-only installation file. */
export interface SetupStoredCredential {
  /** Bearer credential used solely for telemetry export and receipt verification. */
  apiKey: string;
  /** Server identifier for the credential generation. */
  keyId: string;
  /** Anonymous or post-claim credential generation. */
  version: 0 | 1;
}

/** Exact metadata probe identifiers retained for resumable receipt verification. */
export interface SetupStoredProbe {
  /** Lowercase external trace identifier. */
  traceId: string;
  /** Lowercase external span identifier expected in the receipt. */
  spanId: string;
  /** Credential generation that exported the probe. */
  credentialVersion: 0 | 1;
  /** Whether an exact metadata-only receipt was observed. */
  verified: boolean;
}

/** Exact identifiers emitted by a request through the repository's existing application. */
export interface SetupStoredApplicationEvidence extends SetupStoredProbe {
  /** Closed source label that distinguishes app evidence from a synthetic setup probe. */
  source: "existing-application-request";
}

/** Durable no-replay marker written before starting an existing application request. */
export interface SetupStoredApplicationAttempt {
  /** Credential generation for which application work was attempted once. */
  credentialVersion: 0 | 1;
  /** Bounded ISO timestamp for diagnostics and explicit recovery. */
  startedAt: string;
}

/** Durable client identity for an idempotent one-time browser handoff request. */
export interface SetupStoredClaimHandoff {
  /** Lowercase UUIDv4 persisted before the handoff request is sent. */
  id: string;
  /** Compare-and-swap predecessor supplied when this handoff was created. */
  previousHandoffId: string | null;
  /** Last strictly validated server state, when a response was received. */
  state?: "pending" | "consumed" | "expired" | "revoked";
  /** Fixed server expiry, when a response was received. */
  expiresAt?: string;
  /** Fixed browser session expiry, when an exchange succeeded. */
  sessionExpiresAt?: string | null;
}

/** Secret local installation state. It must never be emitted or copied into diagnostics. */
export interface SetupInstallationRecord {
  /** Local file format version. */
  format: 1;
  /** Exact normalized Hue origin owning this installation. */
  origin: string;
  /** Lowercase UUIDv4 installation identity. */
  installationId: string;
  /** Unpadded base64url installation proof; never log or diagnose this value. */
  installationSecret: string;
  /** Latest locally managed telemetry credential. */
  credential?: SetupStoredCredential;
  /** Superseded anonymous credential retained only until its revocation is verified. */
  revocationCredential?: SetupStoredCredential;
  /** Latest probe awaiting or carrying exact receipt evidence. */
  probe?: SetupStoredProbe;
  /** Latest existing-application request awaiting or carrying exact receipt evidence. */
  applicationEvidence?: SetupStoredApplicationEvidence;
  /** Prevents automatic replay after startup, request, export or evidence loss. */
  applicationAttempt?: SetupStoredApplicationAttempt;
  /** Current proof-bound one-time browser handoff identity; never a bearer capability. */
  claimHandoff?: SetupStoredClaimHandoff;
  /** Provision request timestamps used to enforce the local hourly bound. */
  provisionAttempts: string[];
  /** Digests of files setup owns and may safely replace. */
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

function validApplicationEvidence(value: unknown): value is SetupStoredApplicationEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    exactKeys(item, ["traceId", "spanId", "credentialVersion", "verified", "source"]) &&
    item.source === "existing-application-request" &&
    validProbe({
      traceId: item.traceId,
      spanId: item.spanId,
      credentialVersion: item.credentialVersion,
      verified: item.verified,
    })
  );
}

function validApplicationAttempt(value: unknown): value is SetupStoredApplicationAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    exactKeys(item, ["credentialVersion", "startedAt"]) &&
    (item.credentialVersion === 0 || item.credentialVersion === 1) &&
    typeof item.startedAt === "string" &&
    item.startedAt.length <= 40 &&
    Number.isFinite(Date.parse(item.startedAt))
  );
}

function validClaimHandoff(value: unknown): value is SetupStoredClaimHandoff {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const allowed = [
    "id",
    "previousHandoffId",
    ...(item.state === undefined ? [] : ["state"]),
    ...(item.expiresAt === undefined ? [] : ["expiresAt"]),
    ...(item.sessionExpiresAt === undefined ? [] : ["sessionExpiresAt"]),
  ];
  return (
    exactKeys(item, allowed) &&
    typeof item.id === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(item.id) &&
    (item.previousHandoffId === null ||
      (typeof item.previousHandoffId === "string" &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
          item.previousHandoffId,
        ))) &&
    (item.state === undefined ||
      ["pending", "consumed", "expired", "revoked"].includes(item.state as string)) &&
    (item.expiresAt === undefined ||
      (typeof item.expiresAt === "string" &&
        item.expiresAt.length <= 40 &&
        Number.isFinite(Date.parse(item.expiresAt)))) &&
    (item.sessionExpiresAt === undefined ||
      item.sessionExpiresAt === null ||
      (typeof item.sessionExpiresAt === "string" &&
        item.sessionExpiresAt.length <= 40 &&
        Number.isFinite(Date.parse(item.sessionExpiresAt)))) &&
    ((item.state === undefined &&
      item.expiresAt === undefined &&
      item.sessionExpiresAt === undefined) ||
      (item.state !== undefined && item.expiresAt !== undefined))
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
    ...(item.revocationCredential === undefined ? [] : ["revocationCredential"]),
    ...(item.probe === undefined ? [] : ["probe"]),
    ...(item.applicationEvidence === undefined ? [] : ["applicationEvidence"]),
    ...(item.applicationAttempt === undefined ? [] : ["applicationAttempt"]),
    ...(item.claimHandoff === undefined ? [] : ["claimHandoff"]),
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
    (item.revocationCredential !== undefined &&
      (!validCredential(item.revocationCredential) ||
        item.revocationCredential.version !== 0 ||
        !validCredential(item.credential) ||
        item.credential.version !== 1)) ||
    (item.probe !== undefined && !validProbe(item.probe)) ||
    (item.applicationEvidence !== undefined &&
      !validApplicationEvidence(item.applicationEvidence)) ||
    (item.applicationAttempt !== undefined && !validApplicationAttempt(item.applicationAttempt)) ||
    (item.claimHandoff !== undefined && !validClaimHandoff(item.claimHandoff)) ||
    (item.applicationEvidence !== undefined &&
      (!validApplicationAttempt(item.applicationAttempt) ||
        (item.applicationEvidence as SetupStoredApplicationEvidence).credentialVersion !==
          item.applicationAttempt.credentialVersion)) ||
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
  /** Resolved project directory containing the installation state. */
  readonly projectRoot: string;
  /** Exact normalized Hue origin scoped to this store. */
  readonly origin: string;
  /** Owner-only `.hue` directory. */
  readonly directory: string;
  /** Origin-scoped ignored installation record path. */
  readonly path: string;
  /** Origin-scoped owner-only browser handoff; its contents are never emitted. */
  readonly claimHandoffPath: string;
  /** Origin-scoped private application evidence transfer path. */
  readonly applicationEvidencePath: string;

  constructor(projectRoot: string, origin: string) {
    this.projectRoot = resolve(projectRoot);
    this.origin = origin;
    this.directory = join(this.projectRoot, ".hue");
    const originHash = createHash("sha256").update(origin).digest("hex").slice(0, 20);
    this.path = join(this.directory, `installation-${originHash}.json`);
    this.claimHandoffPath = join(this.directory, `claim-handoff-${originHash}.html`);
    this.applicationEvidencePath = join(this.directory, `application-evidence-${originHash}.json`);
    if (!inside(this.projectRoot, this.path)) throw new Error("Unsafe setup installation path");
    if (!inside(this.projectRoot, this.claimHandoffPath))
      throw new Error("Unsafe setup claim handoff path");
    if (!inside(this.projectRoot, this.applicationEvidencePath))
      throw new Error("Unsafe setup application evidence path");
  }

  private async rejectUnsafeProjectRoot(): Promise<void> {
    const info = await lstat(this.projectRoot);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Unsafe setup project root symlink");
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

  private async ensureRootIgnored(): Promise<void> {
    for (const rule of IGNORE_RULES)
      await this.ensureIgnoreFile(join(this.projectRoot, ".gitignore"), rule);
  }

  /** Revalidates owner-only storage and ignore rules before an existing proof is used for I/O. */
  async ensureIgnored(): Promise<void> {
    await this.rejectUnsafeProjectRoot();
    await this.ensureRootIgnored();
    await rejectSymlink(this.directory);
    const info = await lstat(this.directory);
    if (!info.isDirectory()) throw new Error("Unsafe setup installation directory");
    if (process.platform !== "win32") await chmod(this.directory, 0o700);
    for (const rule of LOCAL_IGNORE_RULES)
      await this.ensureIgnoreFile(join(this.directory, ".gitignore"), rule);
  }

  /** Loads a valid owner-only record without creating one. */
  async load(): Promise<SetupInstallationRecord | undefined> {
    await this.rejectUnsafeProjectRoot();
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
    if (existing) {
      await this.ensureIgnored();
      return existing;
    }
    await this.ensureRootIgnored();
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

  /** Atomically replaces this store's validated owner-only record. */
  async save(record: SetupInstallationRecord): Promise<void> {
    parseRecord(record, this.origin);
    await rejectSymlink(this.directory);
    await atomicWrite(this.path, `${JSON.stringify(record)}\n`, 0o600);
  }

  /** Saves a private browser redirect without putting its capability in a process argument. */
  async saveClaimHandoff(claimUrl: string): Promise<string> {
    await this.ensureIgnored();
    const encoded = JSON.stringify(claimUrl).replaceAll("<", "\\u003c");
    const html = `<!doctype html>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta http-equiv="cache-control" content="no-store">
<title>Continue Hue setup</title>
<script>location.replace(${encoded})</script>
<p>This private Hue setup handoff is opened locally. Close this page if it does not continue.</p>
`;
    await atomicWrite(this.claimHandoffPath, html, 0o600);
    return this.claimHandoffPath;
  }

  /** Removes a consumed or terminal claim handoff without following symlinks. */
  async removeClaimHandoff(): Promise<void> {
    await rejectSymlink(this.claimHandoffPath, true);
    try {
      const info = await lstat(this.claimHandoffPath);
      if (!info.isFile()) throw new Error("Unsafe setup claim handoff path");
      await unlink(this.claimHandoffPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  /** Removes the private child-to-parent evidence transfer file without following symlinks. */
  async removeApplicationEvidence(): Promise<void> {
    await rejectSymlink(this.applicationEvidencePath, true);
    try {
      const info = await lstat(this.applicationEvidencePath);
      if (!info.isFile()) throw new Error("Unsafe setup application evidence path");
      await unlink(this.applicationEvidencePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Computes the digest used to detect unexpected edits to managed files. */
export function setupManagedDigest(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}
