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

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Reduce a declared file name to a single printable path segment, at most 200 characters. */
export function safeFilename(name: string): string {
  const cleaned = [...name]
    .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127 && c !== "/" && c !== "\\")
    .join("")
    .trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned.slice(0, 200) : "file";
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
    if (!present) {
      const bytes = await client.downloadArtifact(file.artifactId);
      if (bytes.byteLength !== file.byteSize || sha256(bytes) !== file.sha256)
        throw new Error(`Downloaded input ${file.filename} does not match its pinned identity`);
      await writePrivate(path, bytes);
    }
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
      if (reserved.copyState === "none") {
        const upload = await client.requestArtifactUpload(reserved.id);
        try {
          await client.uploadArtifactBytes(upload, bytes);
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
