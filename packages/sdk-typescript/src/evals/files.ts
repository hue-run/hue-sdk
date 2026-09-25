import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ArtifactSizeError, HueApiError, type EvaluationClient } from "./client.js";
import type { ArtifactReservation, CaseFile, LocalFile, OutputFile, SubjectFile } from "./types.js";

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
/** The longest file name the runner writes, in UTF-8 bytes: room is left for the temporary
 * suffix of an atomic write and a copy counter within the usual 255-byte limit. */
const MAX_NAME_BYTES = 200;
/** The longest prefix of `name` that fits in `bytes` UTF-8 bytes, cut between code points. */
function truncateBytes(name: string, bytes: number): string {
  let kept = "";
  let size = 0;
  for (const character of name) {
    size += Buffer.byteLength(character);
    if (size > bytes) break;
    kept += character;
  }
  return kept;
}
/**
 * Whether `name` can be used unchanged as one file name: not empty, `.` or `..`; no `/`, `\`,
 * C0 or C1 control character, or character Windows reserves (`: < > " | ? *`); no Windows device
 * name (`CON`, `NUL`, `COM1`, … with any extension); no trailing dot or space, which Windows
 * drops; at most 200 UTF-8 bytes. An absolute path or a path with a parent step always contains
 * a separator, so it is refused too.
 */
export function isSafeFileName(name: string): boolean {
  if (typeof name !== "string" || !name || name === "." || name === "..") return false;
  // eslint-disable-next-line no-control-regex -- control characters are refused
  if (/[/\\:<>"|?*\x00-\x1f\x7f-\x9f]/u.test(name)) return false;
  if (name.endsWith(".") || name.endsWith(" ")) return false;
  if (DEVICE_NAME.test(name.split(".")[0]!.trimEnd())) return false;
  return Buffer.byteLength(name) <= MAX_NAME_BYTES;
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
/**
 * Reduce a declared file name to a single printable path segment, at most 200 UTF-8 bytes. A
 * longer name keeps its extension, so `.pdf` stays `.pdf`, and its stem is shortened and marked
 * with a short hash of the whole name, so two long names never shorten to the same one.
 */
export function safeFilename(name: string): string {
  const cleaned = [...name]
    .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127 && c !== "/" && c !== "\\")
    .join("")
    .trim();
  let kept = cleaned;
  if (Buffer.byteLength(cleaned) > MAX_NAME_BYTES) {
    const found = extname(cleaned);
    const extension = Buffer.byteLength(found) <= 32 ? found : "";
    const mark = `~${sha256(Buffer.from(cleaned)).slice(0, 8)}`;
    const room = MAX_NAME_BYTES - Buffer.byteLength(extension) - mark.length;
    kept = `${truncateBytes(cleaned.slice(0, cleaned.length - extension.length), room)}${mark}${extension}`;
  }
  return kept && kept !== "." && kept !== ".." ? kept : "file";
}
/** Create `path` if needed and require a directory this user owns that no one else can open. */
async function privateDirectory(path: string): Promise<string> {
  const root = resolve(path);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  const uid = process.getuid?.();
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (uid !== undefined && info.uid !== uid) ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    throw new Error("Use a private files directory (owned by this user, mode 0700, no symlink)");
  return root;
}
/** The device and inode a listing saw for a file, compared with the file actually opened. */
export interface FileIdentity {
  dev: number;
  ino: number;
}
// A symlink as the last path component fails to open, and a FIFO or device never blocks.
const AGENT_FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/**
 * Read a file an agent wrote without trusting its path: the last component must not be a
 * symlink and the open file must be a regular file of at most `maxBytes`, checked before any byte
 * is read, and, when `expected` is given, the very file a listing saw. The bytes come from that
 * open file. Returns undefined for a missing file only when nothing was expected there; every
 * other refusal is an `OutputFileError` naming `label`.
 */
export async function readAgentFile(
  path: string,
  label: string,
  maxBytes: number,
  expected?: FileIdentity,
): Promise<Uint8Array | undefined> {
  let file;
  try {
    file = await open(path, AGENT_FILE_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && !expected) return undefined;
    if (code === "ELOOP" || code === "EMLINK")
      throw new OutputFileError(`${label} is a symbolic link`);
    if (code === "ENOENT") throw new OutputFileError(`${label} changed while it was collected`);
    throw new OutputFileError(`${label} could not be read`);
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new OutputFileError(`${label} is not a regular file`);
    if (expected && (info.dev !== expected.dev || info.ino !== expected.ino))
      throw new OutputFileError(`${label} changed while it was collected`);
    if (info.size > maxBytes)
      throw new OutputFileError(`${label} exceeds ${Math.floor(maxBytes / 1024 / 1024)} MiB`);
    // One byte past the size seen: a file that is still growing is refused, not read whole.
    const bytes = Buffer.allocUnsafe(info.size + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== info.size) throw new OutputFileError(`${label} changed while it was collected`);
    return bytes.subarray(0, total);
  } finally {
    await file.close();
  }
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

/** Download one pinned file and check its size and SHA-256 against the manifest. The download
 * stops one byte past the pinned size. */
async function downloadVerified(
  client: EvaluationClient,
  file: Pick<SubjectFile, "artifactId" | "filename" | "byteSize" | "sha256">,
): Promise<Uint8Array> {
  const mismatch = () =>
    new CaseFileError(
      "case_file_mismatch",
      file.artifactId,
      `Downloaded file ${quoted(file.filename)} does not match its pinned size and SHA-256`,
    );
  let bytes: Uint8Array;
  try {
    bytes = await client.downloadArtifact(file.artifactId, { maxBytes: file.byteSize });
  } catch (error) {
    if (error instanceof ArtifactSizeError) throw mismatch();
    throw error;
  }
  if (bytes.byteLength !== file.byteSize || sha256(bytes) !== file.sha256) throw mismatch();
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
    // A path is read once, as a regular file within the limit, and staged from those bytes.
    const bytes =
      file.bytes ??
      (await readAgentFile(file.path, `Generated file ${filename}`, outputFileLimits.bytes));
    if (!bytes) throw new OutputFileError(`Generated file ${filename} could not be read`);
    if (!bytes.byteLength) throw new OutputFileError(`Generated file ${filename} is empty`);
    if (bytes.byteLength > outputFileLimits.bytes)
      throw new OutputFileError(`Generated file ${filename} exceeds 25 MiB`);
    const path = join(root, filename);
    await writePrivate(path, bytes);
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

/** How long an upload waits for Hue to verify one artifact, and how often it looks. Hue verifies
 * within a two-minute lease, which can outlast one request's timeout. */
export const artifactSettling = { settleMillis: 180_000, pollMillis: 1000, maxPollMillis: 10_000 };

/** A completion failure that can mean Hue is still verifying: a lost or timed-out response, a
 * verification already running (409), or a refusal to retry (429, 503). */
function mayStillVerify(error: unknown): boolean {
  return (
    error instanceof HueApiError &&
    (error.status === undefined ||
      error.status === 409 ||
      error.status === 429 ||
      error.status === 503)
  );
}

/**
 * Completes an artifact's verification and returns the state it settles in. When a completion
 * times out, finds verification already running or is refused for now, the artifact is read after
 * a pause: ready is returned; verifying is completed again, which Hue refuses while its lease
 * holds and restarts once it lapsed; an artifact a retryable refusal (a lost response, 429 or 503)
 * left unverified is completed again up to three times; any other state is returned for the
 * caller to refuse (a resume uploads a rejected artifact again). All within `timing.settleMillis`.
 */
async function settleArtifact(
  client: EvaluationClient,
  id: string,
  timing: typeof artifactSettling,
): Promise<ArtifactReservation["state"]> {
  const deadline = Date.now() + timing.settleMillis;
  let pause = timing.pollMillis;
  let retries = 0;
  for (;;) {
    let refusedForNow: boolean;
    let asked = 0;
    try {
      return (await client.completeArtifact(id)).state;
    } catch (error) {
      if (!mayStillVerify(error) || Date.now() >= deadline) throw error;
      refusedForNow = (error as HueApiError).status !== 409;
      // A refusal that says how long to wait is waited out, within the settling window.
      asked = ((error as HueApiError).retryAfterSeconds ?? 0) * 1000;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Math.min(Math.max(pause, asked), deadline - Date.now()))),
    );
    pause = Math.min(pause * 2, timing.maxPollMillis);
    let current: ArtifactReservation | undefined;
    try {
      current = await client.getArtifact(id);
    } catch (error) {
      if (!mayStillVerify(error)) throw error;
    }
    if (current?.state === "ready") return current.state;
    const unverified =
      current &&
      ["reserved", "rejected"].includes(current.state) &&
      current.failureCode !== "mismatch";
    if (current && current.state !== "verifying" && !(unverified && refusedForNow && retries++ < 3))
      return current.state;
    if (Date.now() >= deadline) {
      const seconds = Math.round(timing.settleMillis / 1000);
      throw new Error(
        current?.state === "verifying"
          ? `Hue was still verifying generated file ${id} after ${seconds} seconds`
          : `Hue had not verified generated file ${id} after ${seconds} seconds (${current ? `it was ${current.state}` : "its state could not be read"})`,
      );
    }
  }
}

/**
 * Publish staged files as verified artifacts. Reservations use stable keys derived from the
 * execution and the bytes, so a resumed upload settles on the same artifact, including one Hue
 * finished verifying after an earlier attempt stopped waiting.
 */
export async function uploadOutputFiles(
  client: EvaluationClient,
  executionId: string,
  files: StagedOutputFile[],
  save: () => Promise<void>,
  timing: typeof artifactSettling = artifactSettling,
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
      // A verification already running holds the uploaded bytes; Hue refuses another upload then.
      if (reserved.copyState !== "acknowledged" && state !== "verifying") {
        const upload = await client.requestArtifactUpload(reserved.id);
        try {
          await client.uploadArtifactBytes(upload, bytes, file.contentType);
        } catch {
          // A lost staging acknowledgement or an immutable object already present can only be
          // settled by verified completion; never rewrite a final object here.
        }
      }
      state = await settleArtifact(client, reserved.id, timing);
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
