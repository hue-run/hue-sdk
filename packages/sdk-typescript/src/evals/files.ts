import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { HueApiError, type EvaluationClient } from "./client.js";
import type { CaseFile, LocalFile, OutputFile, SubjectFile } from "./types.js";

/** Roles the target receives. Organization templates stay with grading, as in the managed protocol. */
export const targetFileRoles: readonly CaseFile["role"][] = [
  "source",
  "attached_template",
  "attached_reference",
  "original",
];
/** Hue's artifact policy: the pilot file size and the accepted document types. */
export const outputFileLimits = {
  /** Maximum number of generated files per execution. */
  count: 32,
  /** Maximum size of one generated file in bytes (25 MiB). */
  bytes: 25 * 1024 * 1024,
} as const;
/** Content types Hue accepts for generated files. */
export const outputContentTypes: readonly string[] = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/json",
  "text/plain",
  "text/csv",
  "image/png",
  "image/jpeg",
  "image/webp",
];

/** A generated file the runner copied next to its checkpoint before uploading it. */
export interface StagedOutputFile {
  /** Sanitized file name, unique within the execution. */
  filename: string;
  /** Declared content type. */
  contentType: string;
  /** Size of the staged bytes. */
  byteSize: number;
  /** SHA-256 of the staged bytes, hex encoded. */
  sha256: string;
  /** Absolute path of the staged copy. */
  path: string;
  /** Whether the target declared this file as the primary document. */
  primary: boolean;
  /** Hue artifact identity once the upload was verified. */
  artifactId?: string;
}
/** Thrown when the target's declared files cannot be used; recorded as the target's error. */
export class OutputFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputFileError";
  }
}
/** Stable codes of a pinned file the runner refuses to hand over. */
export type CaseFileErrorCode = "case_file_mismatch" | "case_file_name_refused";
/**
 * Thrown when a pinned file cannot be used: its downloaded bytes differ from the manifest's size
 * or SHA-256 (`case_file_mismatch`), or a file meant for an agent working in a world is not
 * named by one safe file name (`case_file_name_refused`). Raised before the case's execution
 * starts, so no execution, world or target call is spent on it.
 */
export class CaseFileError extends Error {
  constructor(
    /** Stable diagnostic code. */
    readonly code: CaseFileErrorCode,
    /** Hue artifact identity of the refused file. */
    readonly artifactId: string,
    message: string,
  ) {
    super(`${message} (${code})`);
    this.name = "CaseFileError";
  }
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** A file name quoted for a message: at most 120 characters, controls escaped. */
const quoted = (name: string) => JSON.stringify([...name].slice(0, 120).join(""));
/** Names Windows reserves for devices, with or without an extension. */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/iu;
/**
 * Whether `name` can be used unchanged as one file name: not empty, `.` or `..`; no `/`, `\`
 * or control character; no Windows device name (`CON`, `NUL`, `COM1`, … with any extension); no
 * trailing dot or space, which Windows drops; at most 255 UTF-8 bytes. An absolute path or a
 * path with a parent step always contains a separator, so it is refused too.
 */
export function isSafeFileName(name: string): boolean {
  if (typeof name !== "string" || !name || name === "." || name === "..") return false;
  // eslint-disable-next-line no-control-regex -- control characters are refused
  if (/[/\\\x00-\x1f\x7f]/u.test(name)) return false;
  if (name.endsWith(".") || name.endsWith(" ")) return false;
  if (DEVICE_NAME.test(name.split(".")[0]!.trimEnd())) return false;
  return Buffer.byteLength(name) <= 255;
}
/** Refuse a pinned file whose name is not one safe file name; see {@link isSafeFileName}. */
export function assertSafeFileNames(files: readonly Pick<CaseFile, "artifactId" | "filename">[]) {
  for (const file of files)
    if (!isSafeFileName(file.filename))
      throw new CaseFileError(
        "case_file_name_refused",
        file.artifactId,
        `Pinned file ${quoted(String(file.filename))} is not a safe file name`,
      );
}
/** Reduce a declared file name to a single printable path segment, at most 200 characters. */
export function safeFilename(name: string): string {
  const cleaned = [...name]
    .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127 && c !== "/" && c !== "\\")
    .join("")
    .trim();
  return cleaned && cleaned !== "." && cleaned !== ".."
    ? [...cleaned].slice(0, 200).join("")
    : "file";
}
async function privateDirectory(path: string): Promise<string> {
  const root = resolve(path);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Use a private files directory (no symlink)");
  return root;
}
async function writePrivate(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}
async function verifiedBytes(path: string, expected: { byteSize: number; sha256: string }) {
  const bytes = await readFile(path);
  if (bytes.byteLength !== expected.byteSize || sha256(bytes) !== expected.sha256)
    throw new Error(`Saved file ${path} no longer matches its verified identity`);
  return bytes;
}

/** Download one pinned file and check its size and SHA-256 against the manifest. */
async function downloadVerified(
  client: EvaluationClient,
  file: Pick<SubjectFile, "artifactId" | "filename" | "byteSize" | "sha256">,
): Promise<Uint8Array> {
  const bytes = await client.downloadArtifact(file.artifactId);
  if (bytes.byteLength !== file.byteSize || sha256(bytes) !== file.sha256)
    throw new CaseFileError(
      "case_file_mismatch",
      file.artifactId,
      `Downloaded file ${quoted(file.filename)} does not match its pinned size and SHA-256`,
    );
  return bytes;
}

/** Check pinned files against the manifest without keeping them: nothing is written to disk. */
export async function verifyCaseFiles(
  client: EvaluationClient,
  files: readonly SubjectFile[],
): Promise<void> {
  for (const file of files) await downloadVerified(client, file);
}

/**
 * Save verified copies of a case's pinned input files under `directory`. A file already
 * present with the pinned identity is reused, so a resumed run does not download again.
 */
export async function downloadCaseFiles(
  client: EvaluationClient,
  files: SubjectFile[],
  directory: string,
  primaryArtifactId?: string | null,
): Promise<LocalFile[]> {
  const root = await privateDirectory(directory);
  const saved: LocalFile[] = [];
  for (const [index, file] of files.entries()) {
    const path = join(root, `${index + 1}-${safeFilename(file.filename)}`);
    let present = false;
    try {
      await verifiedBytes(path, file);
      present = true;
    } catch {
      present = false;
    }
    if (!present) await writePrivate(path, await downloadVerified(client, file));
    saved.push({
      artifactId: file.artifactId,
      role: file.role,
      filename: file.filename,
      contentType: file.contentType,
      byteSize: file.byteSize,
      sha256: file.sha256,
      path,
      ...(file.role === "output" && file.artifactId === primaryArtifactId ? { primary: true } : {}),
    });
  }
  return saved;
}

/**
 * Download a case's needed inputs under `caseDirectory`: the agent-visible roles into `inputs/`
 * and evaluator-only files into `evaluator-inputs/`, so the directory the target's files live in
 * never holds an evaluator's file. `all` keeps the manifest order for scorers; `target` is the
 * agent-visible subset.
 */
export async function downloadCaseInputs(
  client: EvaluationClient,
  files: CaseFile[],
  caseDirectory: string,
): Promise<{ all: LocalFile[]; target: LocalFile[] }> {
  const visible = (file: CaseFile) => targetFileRoles.includes(file.role);
  const agentFiles = files.filter(visible);
  const evaluatorFiles = files.filter((file) => !visible(file));
  const target = agentFiles.length
    ? await downloadCaseFiles(client, agentFiles, join(caseDirectory, "inputs"))
    : [];
  const evaluator = evaluatorFiles.length
    ? await downloadCaseFiles(client, evaluatorFiles, join(caseDirectory, "evaluator-inputs"))
    : [];
  const saved = [...target, ...evaluator];
  const all = files.map(
    (file) =>
      saved.find((entry) => entry.artifactId === file.artifactId && entry.role === file.role)!,
  );
  return { all, target };
}

/** Copy the target's generated files next to the checkpoint and record their identities. */
export async function stageOutputFiles(
  files: OutputFile[],
  directory: string,
): Promise<StagedOutputFile[]> {
  if (!Array.isArray(files) || !files.length) throw new OutputFileError("No generated files");
  if (files.length > outputFileLimits.count)
    throw new OutputFileError(`At most ${outputFileLimits.count} generated files are supported`);
  if (files.filter((file) => file.primary).length > 1)
    throw new OutputFileError("Declare at most one primary generated file");
  const root = await privateDirectory(directory);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  const staged: StagedOutputFile[] = [];
  const names = new Set<string>();
  for (const file of files) {
    if (typeof file.filename !== "string" || !file.filename.trim())
      throw new OutputFileError("Generated files need a filename");
    const filename = safeFilename(file.filename);
    if (names.has(filename)) throw new OutputFileError(`Duplicate generated file ${filename}`);
    names.add(filename);
    if (!outputContentTypes.includes(file.contentType))
      throw new OutputFileError(`Unsupported generated file type ${String(file.contentType)}`);
    let bytes: Uint8Array;
    try {
      bytes = file.bytes ?? (await readFile(file.path));
    } catch {
      throw new OutputFileError(`Generated file ${filename} could not be read`);
    }
    if (!bytes.byteLength) throw new OutputFileError(`Generated file ${filename} is empty`);
    if (bytes.byteLength > outputFileLimits.bytes)
      throw new OutputFileError(`Generated file ${filename} exceeds 25 MiB`);
    const path = join(root, filename);
    if (file.bytes) await writePrivate(path, bytes);
    else {
      await copyFile(file.path, path);
      await verifiedBytes(path, { byteSize: bytes.byteLength, sha256: sha256(bytes) });
    }
    staged.push({
      filename,
      contentType: file.contentType,
      byteSize: bytes.byteLength,
      sha256: sha256(bytes),
      path,
      primary: file.primary === true,
    });
  }
  return staged;
}

/**
 * Publish staged files as verified artifacts. Reservations use stable keys derived from the
 * execution and the bytes, so a resumed upload settles on the same artifact.
 */
export async function uploadOutputFiles(
  client: EvaluationClient,
  executionId: string,
  files: StagedOutputFile[],
  save: () => Promise<void>,
): Promise<void> {
  for (const file of files) {
    if (file.artifactId) continue;
    const bytes = await verifiedBytes(file.path, file);
    const reserved = await client.reserveArtifact({
      idempotencyKey: `hue-sdk:${executionId}:${file.sha256}:${sha256(Buffer.from(file.filename)).slice(0, 16)}`,
      filename: file.filename,
      contentType: file.contentType,
      byteSize: file.byteSize,
      sha256: file.sha256,
    });
    let state = reserved.state;
    if (state !== "ready") {
      if (reserved.copyState !== "acknowledged") {
        const upload = await client.requestArtifactUpload(reserved.id);
        try {
          await client.uploadArtifactBytes(upload, bytes, file.contentType);
        } catch {
          // A lost staging acknowledgement or an immutable object already present can only be
          // settled by verified completion; never rewrite a final object here.
        }
      }
      let attempt = 0;
      for (;;) {
        try {
          state = (await client.completeArtifact(reserved.id)).state;
          break;
        } catch (error) {
          if (!(error instanceof HueApiError) || error.status !== 503 || attempt++ >= 2)
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
    }
    if (state !== "ready")
      throw new Error(`Generated file ${file.filename} was not verified by Hue (${state})`);
    file.artifactId = reserved.id;
    await save();
  }
}

/** Project uploaded staged files as the verified local files handed to scorers. */
export function localOutputFiles(files: StagedOutputFile[]): LocalFile[] {
  return files.map((file) => ({
    artifactId: file.artifactId!,
    role: "output" as const,
    filename: file.filename,
    contentType: file.contentType,
    byteSize: file.byteSize,
    sha256: file.sha256,
    path: file.path,
    ...(file.primary ? { primary: true } : {}),
  }));
}
