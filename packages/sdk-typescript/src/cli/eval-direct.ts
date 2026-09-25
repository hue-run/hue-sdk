import { constants } from "node:fs";
import { copyFile, lstat, mkdir, opendir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
  outputContentTypes,
  outputFileLimits,
  readAgentFile,
  safeFilename,
  type FileIdentity,
} from "../evals/files.js";
import type { LocalFile, OutputFile, TargetResult } from "../evals/types.js";
import { withFiles } from "../evals/types.js";
import type { JsonValue } from "../types.js";

/**
 * Direct (file) cases for `hue eval`: a case is a task plus pinned input files, and the agent's
 * answer is one or more generated documents. The agent command receives a private case directory
 * instead of stdin/stdout JSON, the same layout Hue's document workers use:
 *
 *   <case dir>/inputs.json            the case inputs
 *   <case dir>/case.json              id, external key, run config and the staged file list
 *   <case dir>/files/<role>/<name>    verified copies of the agent-visible pinned files
 *   <case dir>/output/                where the command writes what it produced
 *
 * Everything under `output/` becomes the execution's generated files. Optional helpers there:
 * `manifest.json` (`{ "primary": "<filename>", "output": <json> }`), `result.json` (the JSON
 * output) and `summary.txt` / `summary.md` (recorded as `{ "summary": "…" }`).
 */
export const directCaseEnvironment = [
  "HUE_CASE_DIR",
  "HUE_CASE_INPUTS",
  "HUE_CASE_OUTPUT_DIR",
  "HUE_CASE_ID",
  "HUE_CASE_KEY",
  "HUE_EXECUTION_ID",
] as const;

/** Generated-file extensions Hue accepts and the content type recorded for each. */
export const outputExtensions: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".json": "application/json",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
for (const type of Object.values(outputExtensions))
  if (!outputContentTypes.includes(type))
    throw new Error(`outputExtensions maps to a content type Hue does not accept: ${type}`);

const HELPER_FILES = new Set(["manifest.json", "result.json", "output.json"]);
const SUMMARY_FILES = ["summary.txt", "summary.md", "final.txt", "resumen.txt"];
/** The most a helper (`manifest.json`, `result.json`, `summary.txt`, …) may hold: the same bound
 * as the command's stdout. */
const HELPER_BYTES = 4 * 1024 * 1024;
/** Entries a collection visits at most, hidden and skipped ones included. */
const MAX_ENTRIES = 1024;

export interface DirectCaseLayout {
  caseDirectory: string;
  inputsPath: string;
  outputDirectory: string;
  files: { role: string; filename: string; path: string }[];
}

/** Writes the case directory: inputs, descriptor, verified file copies and an empty output folder. */
export async function stageDirectCase(
  root: string,
  input: {
    inputs: JsonValue;
    config: JsonValue;
    item: { id: string; externalKey: string };
    executionId: string;
    files: LocalFile[];
  },
): Promise<DirectCaseLayout> {
  const caseDirectory = join(root, "case");
  const outputDirectory = join(caseDirectory, "output");
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const inputsPath = join(caseDirectory, "inputs.json");
  await writeFile(inputsPath, JSON.stringify(input.inputs, null, 2), { mode: 0o600 });
  // Names that differ only in case or Unicode normalization are the same file on macOS and
  // Windows filesystems; keep both inputs under distinct names, and never overwrite one.
  const used = new Set<string>();
  const key = (folder: string, name: string) => `${folder}/${name.normalize("NFC").toLowerCase()}`;
  const files: DirectCaseLayout["files"] = [];
  for (const file of input.files) {
    const folder = join(caseDirectory, "files", file.role);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    // Two inputs may share a filename (two incident reports, say); keep both.
    const name = safeFilename(basename(file.filename));
    const extension = extname(name);
    const stem = name.slice(0, name.length - extension.length);
    let target = name;
    for (let copy = 2; used.has(key(folder, target)); copy++)
      target = `${stem} (${copy})${extension}`;
    used.add(key(folder, target));
    const path = join(folder, target);
    await copyFile(file.path, path, constants.COPYFILE_EXCL);
    files.push({ role: file.role, filename: target, path });
  }
  await writeFile(
    join(caseDirectory, "case.json"),
    JSON.stringify(
      {
        id: input.item.id,
        externalKey: input.item.externalKey,
        executionId: input.executionId,
        config: input.config,
        files,
        outputDirectory,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return { caseDirectory, inputsPath, outputDirectory, files };
}

/** A regular file the listing found under the output directory, with the identity it saw. */
interface ListedFile {
  /** `/`-joined path relative to the output directory. */
  name: string;
  path: string;
  identity: FileIdentity;
}
const identityOf = (info: { dev: number; ino: number }): FileIdentity => ({
  dev: info.dev,
  ino: info.ino,
});
const sameIdentity = (a: FileIdentity, b: FileIdentity) => a.dev === b.dev && a.ino === b.ino;

/** A real directory (not a symlink) and its identity, or undefined when `path` is absent. */
async function directoryIdentity(path: string, label: string): Promise<FileIdentity | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`${label} is not a directory; a symbolic link or file is never collected`);
  return identityOf(info);
}

/**
 * Regular files anywhere under the output directory, named by their `/`-joined relative path,
 * with the device and inode each had when listed. Hidden and lock entries (dot names, `~$…`),
 * symlinks and anything that is neither a regular file nor a directory are skipped at every
 * level, except that a top-level helper name must be a regular file when present. The walk stops
 * past 32 documents or 1024 entries, and a directory that changed while it was listed is refused.
 */
async function listOutputFiles(root: string, rootIdentity: FileIdentity): Promise<ListedFile[]> {
  const found: ListedFile[] = [];
  const directories: { path: string; label: string; identity: FileIdentity }[] = [
    { path: root, label: "output/", identity: rootIdentity },
  ];
  let visited = 0;
  let documents = 0;
  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index]!;
    const prefix = index === 0 ? "" : `${directory.label.slice("output/".length)}`;
    for await (const entry of await opendir(directory.path)) {
      if (++visited > MAX_ENTRIES)
        throw new Error(`The output directory holds more than ${MAX_ENTRIES} entries`);
      const name = `${prefix}${entry.name}`;
      const helper = index === 0 && (HELPER_FILES.has(name) || SUMMARY_FILES.includes(name));
      if (!helper && (entry.name.startsWith(".") || entry.name.startsWith("~$"))) continue;
      const path = join(directory.path, entry.name);
      if (helper && !entry.isFile())
        throw new Error(`output/${name} is not a regular file; the agent must write it itself`);
      if (entry.isDirectory()) {
        const identity = await directoryIdentity(path, `output/${name}`);
        if (identity) directories.push({ path, label: `output/${name}/`, identity });
      } else if (entry.isFile()) {
        const info = await lstat(path);
        if (!info.isFile()) throw new Error(`output/${name} changed while it was collected`);
        found.push({ name, path, identity: identityOf(info) });
        if (!helper && ++documents > outputFileLimits.count)
          throw new Error(`The agent wrote more than ${outputFileLimits.count} files`);
      }
    }
  }
  // Every directory must still be the one listed: none was swapped for a link meanwhile.
  for (const directory of directories) {
    const now = await directoryIdentity(directory.path, directory.label);
    if (!now || !sameIdentity(now, directory.identity))
      throw new Error(`${directory.label} changed while it was collected`);
  }
  return found;
}

async function readHelper(listed: ListedFile | undefined): Promise<string | undefined> {
  if (!listed) return undefined;
  const bytes = await readAgentFile(
    listed.path,
    `output/${listed.name}`,
    HELPER_BYTES,
    listed.identity,
  );
  return Buffer.from(bytes!).toString("utf8");
}

function parseHelper(listed: ListedFile | undefined, text: string | undefined) {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new Error(`${listed!.name} in the output directory is not valid JSON`);
  }
}

/** Artifact filenames cannot contain path separators or controls. Encode only those forbidden
 * characters plus `%`, then represent `/` as `%2F`; distinct output paths stay distinct. */
function artifactFilename(relativePath: string): string {
  return relativePath
    .split("/")
    .map((segment) =>
      segment
        .replaceAll("%", "%25")
        .replaceAll("\\", "%5C")
        // eslint-disable-next-line no-control-regex -- artifact filenames forbid controls
        .replace(/[\x00-\x1f\x7f]/gu, (character) => encodeURIComponent(character)),
    )
    .join("%2F");
}

/**
 * Turns the output folder into the target's result. Every regular file, in subdirectories too,
 * becomes a generated file; an unsupported extension is the agent's error rather than a silently
 * dropped document. `fallbackOutput` (for example the command's stdout) is used when no JSON
 * output or summary file was written.
 *
 * Nothing here trusts a path the agent could have changed: the output directory must be a real
 * directory, every file is opened without following a final symlink or blocking on a FIFO, must
 * be the regular file the listing saw and within its size limit, and the result carries the bytes
 * read from that open file. `afterListing` is a test seam that runs between listing and reading.
 */
export async function collectDirectOutputs(
  outputDirectory: string,
  fallbackOutput?: JsonValue,
  afterListing?: () => Promise<void>,
): Promise<TargetResult> {
  const rootIdentity = await directoryIdentity(outputDirectory, "The output directory");
  const listed = rootIdentity ? await listOutputFiles(outputDirectory, rootIdentity) : [];
  await afterListing?.();
  const top = (name: string) => listed.find((entry) => entry.name === name);
  const manifest = parseHelper(top("manifest.json"), await readHelper(top("manifest.json")));
  const declaredPrimary =
    manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? manifest.primary
      : undefined;
  const declaredOutput =
    manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? manifest.output
      : undefined;
  let output: JsonValue | undefined =
    declaredOutput ??
    parseHelper(top("result.json"), await readHelper(top("result.json"))) ??
    parseHelper(top("output.json"), await readHelper(top("output.json")));
  if (output === undefined)
    for (const name of SUMMARY_FILES) {
      const text = await readHelper(top(name));
      if (text !== undefined) {
        output = { summary: text };
        break;
      }
    }
  if (output === undefined) output = fallbackOutput;
  // Helper and summary names are reserved at the top level only; a nested one is a document.
  const entries = listed.filter(
    (entry) => !HELPER_FILES.has(entry.name) && !SUMMARY_FILES.includes(entry.name),
  );
  // Directory order differs between filesystems; keep uploads stable.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const unsupported = entries.filter(
    (entry) => !outputExtensions[extname(entry.name).toLowerCase()],
  );
  if (unsupported.length)
    throw new Error(
      `The agent wrote files Hue does not accept as generated documents: ${unsupported.map((entry) => entry.name).join(", ")} (accepted: ${Object.keys(outputExtensions).join(" ")})`,
    );
  const files: OutputFile[] = [];
  for (const entry of entries) {
    const bytes = (await readAgentFile(
      entry.path,
      `Generated file ${entry.name}`,
      outputFileLimits.bytes,
      entry.identity,
    ))!;
    if (!bytes.byteLength) throw new Error(`The agent wrote an empty file: ${entry.name}`);
    files.push({
      bytes,
      filename: artifactFilename(entry.name),
      contentType: outputExtensions[extname(entry.name).toLowerCase()]!,
    });
  }
  if (typeof declaredPrimary === "string") {
    const primaryIndex = entries.findIndex((entry) => entry.name === declaredPrimary);
    if (primaryIndex < 0)
      throw new Error(
        `manifest.json names a primary file that was not written: ${declaredPrimary}`,
      );
    files[primaryIndex]!.primary = true;
  } else if (files.length === 1) files[0]!.primary = true;
  // The directory must still be the one listed when every byte has been read.
  if (rootIdentity) {
    const now = await directoryIdentity(outputDirectory, "The output directory");
    if (!now || !sameIdentity(now, rootIdentity))
      throw new Error("The output directory changed while it was collected");
  }
  return withFiles(output, files);
}
