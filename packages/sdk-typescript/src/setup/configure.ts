import { constants } from "node:fs";
import { lstat, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type { SetupProjectDetection } from "./types.js";
import {
  setupManagedDigest,
  type FileSetupInstallationStore,
  type SetupInstallationRecord,
} from "./installation.js";

/** A secret-free managed integration file created or replaced by setup. */
export interface SetupFileChange {
  /** Project-relative managed file path. */
  path: string;
  /** Safe write performed during this invocation. */
  change: "created" | "updated";
}

async function cleanupTemporary(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isFile()) await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
}

function serviceName(root: string): string {
  const normalized = basename(root).replace(/[^A-Za-z0-9_.-]+/gu, "-");
  let start = 0;
  let end = normalized.length;
  while (normalized[start] === "-") start += 1;
  while (end > start && normalized[end - 1] === "-") end -= 1;
  const value = normalized.slice(start, end).slice(0, 220);
  return value ? `hue-setup-${value}` : "hue-setup-project";
}

function typescriptConfig(store: FileSetupInstallationStore): string {
  return `// Managed by Hue setup. This file contains no credential.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHue } from "@hue-run/sdk";

const installation = JSON.parse(
  readFileSync(fileURLToPath(new URL("./.hue/${basename(store.path)}", import.meta.url)), "utf8"),
);
if (!installation.credential?.apiKey) throw new Error("Run hue resume to recover Hue credentials");

export const hue = createHue({
  apiKey: installation.credential.apiKey,
  baseUrl: installation.origin,
  serviceName: ${JSON.stringify(serviceName(store.projectRoot))},
  captureContent: false,
});
`;
}

function pythonConfig(store: FileSetupInstallationStore): string {
  return `# Managed by Hue setup. This file contains no credential.
import json
from pathlib import Path

from hue_sdk import Hue

_installation = json.loads(
    (Path(__file__).parent / ".hue" / ${JSON.stringify(basename(store.path))}).read_text(encoding="utf-8")
)
if not _installation.get("credential", {}).get("apiKey"):
    raise RuntimeError("Run hue resume to recover Hue credentials")

hue = Hue(
    api_key=_installation["credential"]["apiKey"],
    base_url=_installation["origin"],
    service_name=${JSON.stringify(serviceName(store.projectRoot))},
    capture_content=False,
)
`;
}

async function atomicManagedWrite(path: string, contents: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    );
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      const existing = await lstat(path);
      if (existing.isSymbolicLink() || !existing.isFile())
        throw new Error(`Refusing unsafe setup configuration at ${basename(path)}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(temporary, path);
  } finally {
    await handle?.close();
    await cleanupTemporary(temporary);
  }
}

async function writeManaged(
  store: FileSetupInstallationStore,
  record: SetupInstallationRecord,
  relativePath: string,
  contents: string,
): Promise<SetupFileChange | undefined> {
  const path = join(store.projectRoot, relativePath);
  if (!inside(store.projectRoot, path)) throw new Error("Unsafe setup configuration path");
  const expected = setupManagedDigest(contents);
  let previous: string | undefined;
  let exists = false;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024)
      throw new Error(`Refusing unsafe setup configuration at ${relativePath}`);
    previous = await readFile(path, "utf8");
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (previous !== undefined && setupManagedDigest(previous) === expected) {
    if (record.managedFiles[relativePath] !== expected) {
      record.managedFiles[relativePath] = expected;
      await store.save(record);
    }
    return undefined;
  }
  const savedDigest = record.managedFiles[relativePath];
  if (exists && (!savedDigest || setupManagedDigest(previous!) !== savedDigest))
    throw new Error(
      `Refusing to overwrite custom or unexpectedly edited configuration at ${relativePath}`,
    );
  await atomicManagedWrite(path, contents);
  record.managedFiles[relativePath] = expected;
  await store.save(record);
  return { path: relativePath, change: exists ? "updated" : "created" };
}

async function rejectCustomEnvironment(projectRoot: string): Promise<void> {
  if (process.env.HUE_API_KEY)
    throw new Error("Refusing to replace an existing custom Hue credential from HUE_API_KEY");
  const entries = await readdir(projectRoot, { withFileTypes: true });
  if (entries.length > 10_000) throw new Error("Refusing to scan an oversized project directory");
  for (const entry of entries) {
    if (!(entry.name === ".env" || entry.name.startsWith(".env."))) continue;
    if (entry.isSymbolicLink()) throw new Error(`Refusing unsafe credential file at ${entry.name}`);
    if (!entry.isFile()) continue;
    const path = join(projectRoot, entry.name);
    const info = await lstat(path);
    if (info.size > 1024 * 1024)
      throw new Error(`Refusing oversized credential file at ${entry.name}`);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let source: string;
    try {
      source = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    if (/^\s*(?:export\s+)?HUE_API_KEY\s*=/mu.test(source))
      throw new Error(`Refusing to replace an existing custom Hue credential in ${entry.name}`);
  }
}

/** Refuses credential/config conflicts before setup makes a provisioning request. */
export async function validateSetupConfiguration(
  store: FileSetupInstallationStore,
  record: SetupInstallationRecord,
  project: SetupProjectDetection,
): Promise<void> {
  await rejectCustomEnvironment(store.projectRoot);
  const candidates: Array<[string, string]> = [];
  if (project.languages.includes("typescript"))
    candidates.push(["hue.setup.mjs", typescriptConfig(store)]);
  if (project.languages.includes("python")) candidates.push(["hue_setup.py", pythonConfig(store)]);
  for (const [relativePath, expected] of candidates) {
    const path = join(store.projectRoot, relativePath);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024)
        throw new Error(`Refusing unsafe setup configuration at ${relativePath}`);
      const source = await readFile(path, "utf8");
      const digest = setupManagedDigest(source);
      if (digest !== setupManagedDigest(expected) && digest !== record.managedFiles[relativePath])
        throw new Error(
          `Refusing to overwrite custom or unexpectedly edited configuration at ${relativePath}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Writes only secret-free, metadata-only integration modules and never executes project code. */
export async function configureSetupProject(
  store: FileSetupInstallationStore,
  record: SetupInstallationRecord,
  project: SetupProjectDetection,
): Promise<SetupFileChange[]> {
  if (project.root !== store.projectRoot) throw new Error("Setup project identity changed");
  if (project.languages.length === 0)
    throw new Error("No supported TypeScript or Python project was detected");
  await validateSetupConfiguration(store, record, project);
  const changes: SetupFileChange[] = [];
  if (project.languages.includes("typescript")) {
    const change = await writeManaged(store, record, "hue.setup.mjs", typescriptConfig(store));
    if (change) changes.push(change);
  }
  if (project.languages.includes("python")) {
    const change = await writeManaged(store, record, "hue_setup.py", pythonConfig(store));
    if (change) changes.push(change);
  }
  return changes;
}
