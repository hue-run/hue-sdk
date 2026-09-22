import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { outputContentTypes } from "../evals/files.js";
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
  const used = new Set<string>();
  const files: DirectCaseLayout["files"] = [];
  for (const file of input.files) {
    const folder = join(caseDirectory, "files", file.role);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    // Two inputs may share a filename (two incident reports, say); keep both.
    const name = basename(file.filename);
    const extension = extname(name);
    const stem = name.slice(0, name.length - extension.length);
    let target = join(folder, name);
    for (let copy = 2; used.has(target); copy++)
      target = join(folder, `${stem} (${copy})${extension}`);
    used.add(target);
    await copyFile(file.path, target);
    files.push({ role: file.role, filename: basename(target), path: target });
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

async function readJsonFile(path: string): Promise<JsonValue | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as JsonValue;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${basename(path)} in the output directory is not valid JSON`);
  }
}

/**
 * Turns the output folder into the target's result. Every regular file becomes a generated
 * file; an unsupported extension is the agent's error rather than a silently dropped document.
 * `fallbackOutput` (for example the command's stdout) is used when no JSON output or summary
 * file was written.
 */
export async function collectDirectOutputs(
  outputDirectory: string,
  fallbackOutput?: JsonValue,
): Promise<TargetResult> {
  const manifest = await readJsonFile(join(outputDirectory, "manifest.json"));
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
    (await readJsonFile(join(outputDirectory, "result.json"))) ??
    (await readJsonFile(join(outputDirectory, "output.json")));
  if (output === undefined)
    for (const name of SUMMARY_FILES) {
      const text = await readFile(join(outputDirectory, name), "utf8").catch(() => undefined);
      if (text !== undefined) {
        output = { summary: text };
        break;
      }
    }
  if (output === undefined) output = fallbackOutput;
  const entries = (await readdir(outputDirectory, { withFileTypes: true }).catch(() => [])).filter(
    (entry) =>
      entry.isFile() &&
      !entry.name.startsWith(".") &&
      !entry.name.startsWith("~$") &&
      !HELPER_FILES.has(entry.name) &&
      !SUMMARY_FILES.includes(entry.name),
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
    const path = join(outputDirectory, entry.name);
    if ((await stat(path)).size === 0)
      throw new Error(`The agent wrote an empty file: ${entry.name}`);
    files.push({
      path,
      filename: entry.name,
      contentType: outputExtensions[extname(entry.name).toLowerCase()]!,
    });
  }
  if (typeof declaredPrimary === "string") {
    const primary = files.find((file) => file.filename === declaredPrimary);
    if (!primary)
      throw new Error(
        `manifest.json names a primary file that was not written: ${declaredPrimary}`,
      );
    primary.primary = true;
  } else if (files.length === 1) files[0]!.primary = true;
  return withFiles(output, files);
}
