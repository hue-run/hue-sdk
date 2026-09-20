import { constants, type Stats } from "node:fs";
import { link, lstat, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
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

async function safeDirectory(path: string): Promise<void> {
  const paths: string[] = [];
  let current = resolve(path);
  for (;;) {
    paths.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const entry of paths) {
    const info = await lstat(entry);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("Refusing a setup configuration path with a symlink ancestor");
  }
  if ((await realpath(path)) !== resolve(path))
    throw new Error("Refusing a setup configuration path outside its actual directory");
}

interface ManagedSnapshot {
  contents: string;
  info: Stats;
}

async function readManaged(path: string): Promise<ManagedSnapshot | undefined> {
  await safeDirectory(dirname(path));
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Refusing unsafe setup configuration");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024 || (info.mode & 0o7000) !== 0)
      throw new Error("Refusing unsafe setup configuration");
    const contents = await handle.readFile("utf8");
    const after = await handle.stat();
    if (
      info.mtimeMs !== after.mtimeMs ||
      info.ctimeMs !== after.ctimeMs ||
      info.size !== after.size
    )
      throw new Error("Refusing setup configuration changed while reading");
    return { contents, info };
  } finally {
    await handle.close();
  }
}

function sameSnapshot(
  left: ManagedSnapshot | undefined,
  right: ManagedSnapshot | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.contents === right.contents &&
    left.info.dev === right.info.dev &&
    left.info.ino === right.info.ino &&
    left.info.mode === right.info.mode &&
    left.info.mtimeMs === right.info.mtimeMs &&
    left.info.ctimeMs === right.info.ctimeMs
  );
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
import { closeSync, constants, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHue } from "@hue-run/sdk";
import { context, createContextKey, ROOT_CONTEXT, SpanKind } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

// Generated application bootstrap owns this policy; the SDK core registers nothing.
const contextCheck = createContextKey("hue.setup.context-check");
async function hasWorkingContext() {
  try {
    return await context.with(ROOT_CONTEXT.setValue(contextCheck, true), async () => {
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      return context.active().getValue(contextCheck) === true;
    });
  } catch { return false; }
}
let ownedContext;
if (!(await hasWorkingContext())) {
  const candidate = new AsyncLocalStorageContextManager().enable();
  if (!context.setGlobalContextManager(candidate)) {
    candidate.disable();
    throw new Error("Existing OpenTelemetry context ownership is unsupported; review the application bootstrap");
  }
  ownedContext = candidate;
  if (!(await hasWorkingContext())) {
    ownedContext.disable();
    throw new Error("This runtime does not support the setup context integration");
  }
}
process.once("beforeExit", () => { ownedContext?.disable(); ownedContext = undefined; });

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

const evidencePath = fileURLToPath(new URL("./.hue/${basename(store.applicationEvidencePath)}", import.meta.url));
const expressInstalled = Symbol.for("hue.setup.express.installed");

function saveEvidence(value) {
  if (process.env.HUE_SETUP_EVIDENCE_FILE !== evidencePath) return;
  const temporary = evidencePath + "." + process.pid + ".tmp";
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, JSON.stringify(value) + "\\n", "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, evidencePath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

export function installHueExpress(app, requestPath) {
  if (app[expressInstalled]) throw new Error("Duplicate Hue setup middleware requires explicit review");
  app[expressInstalled] = true;
  app.use((request, response, next) => {
    void (async () => {
      const ids = await hue.withSpan("hue.metadata", async (span) => {
        const finished = new Promise((resolve) => {
          response.once("finish", resolve);
          response.once("close", resolve);
        });
        next();
        await finished;
        return { traceId: span.traceId, spanId: span.spanId };
      }, { kind: SpanKind.SERVER });
      await hue.flush();
      if (request.method === "GET" && request.route?.path === requestPath && request.path === requestPath && response.statusCode >= 200 && response.statusCode < 300 && response.writableFinished)
        saveEvidence({ ...ids, credentialVersion: installation.credential.version, source: "existing-application-request" });
    })().catch(() => undefined);
  });
}
`;
}

function pythonConfig(store: FileSetupInstallationStore): string {
  return `# Managed by Hue setup. This file contains no credential.
import json
import os
from pathlib import Path

from flask import g, request
from hue_sdk import Hue
from opentelemetry.trace import SpanKind, use_span

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

_evidence_path = Path(__file__).parent / ".hue" / ${JSON.stringify(basename(store.applicationEvidencePath))}


def _save_evidence(value):
    if os.environ.get("HUE_SETUP_EVIDENCE_FILE") != str(_evidence_path):
        return
    temporary = _evidence_path.with_name(f".{_evidence_path.name}.{os.getpid()}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(temporary, flags, 0o600)
    try:
        os.write(descriptor, (json.dumps(value) + "\\n").encode("utf-8"))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, _evidence_path)


def install_hue_flask(app, request_path):
    if app.extensions.get("hue_setup_installed"):
        raise RuntimeError("Duplicate Hue setup middleware requires explicit review")
    app.extensions["hue_setup_installed"] = True

    @app.before_request
    def _hue_setup_before_request():
        try:
            span = hue.tracer.start_span("hue.metadata", kind=SpanKind.SERVER)
            context = use_span(span, end_on_exit=False, record_exception=False, set_status_on_exception=False)
            context.__enter__()
            g._hue_setup_context = context
            g._hue_setup_span = span
        except Exception:
            pass

    @app.after_request
    def _hue_setup_after_request(response):
        try:
            context = getattr(g, "_hue_setup_context", None)
            span = getattr(g, "_hue_setup_span", None)
            g._hue_setup_context = None
            g._hue_setup_span = None
            if context is not None:
                context.__exit__(None, None, None)
            if span is None:
                return response
            matched = request.method == "GET" and request.url_rule is not None and request.url_rule.rule == request_path and 200 <= response.status_code < 300
            ended = False
            def finish(complete):
                nonlocal ended
                if ended:
                    return
                ended = True
                try:
                    ids = span.get_span_context()
                    span.end()
                    if complete and matched and os.environ.get("HUE_SETUP_EVIDENCE_FILE") == str(_evidence_path) and hue.force_flush():
                        _save_evidence({"traceId": format(ids.trace_id, "032x"), "spanId": format(ids.span_id, "016x"), "credentialVersion": _installation["credential"]["version"], "source": "existing-application-request"})
                except Exception:
                    pass
            if response.is_streamed:
                original = response.response
                def streamed():
                    complete = False
                    try:
                        with use_span(span, end_on_exit=False, record_exception=False, set_status_on_exception=False):
                            yield from original
                        complete = True
                    finally:
                        finish(complete)
                response.response = streamed()
                response.call_on_close(lambda: finish(False))
            else:
                finish(True)
        except Exception:
            pass
        return response
`;
}

async function atomicManagedWrite(
  path: string,
  contents: string,
  previous: ManagedSnapshot | undefined,
): Promise<void> {
  await safeDirectory(dirname(path));
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      previous ? previous.info.mode & 0o777 : 0o644,
    );
    await handle.chmod(previous ? previous.info.mode & 0o777 : 0o644);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (!sameSnapshot(previous, await readManaged(path)))
      throw new Error("Refusing setup configuration changed before replacement");
    if (previous) await rename(temporary, path);
    else {
      // link is an atomic create-if-absent: never replace a file created after validation.
      await link(temporary, path);
      await unlink(temporary);
    }
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
  const previous = await readManaged(path);
  if (previous !== undefined && setupManagedDigest(previous.contents) === expected) {
    if (record.managedFiles[relativePath] !== expected) {
      record.managedFiles[relativePath] = expected;
      await store.save(record);
    }
    return undefined;
  }
  const savedDigest = record.managedFiles[relativePath];
  if (previous && (!savedDigest || setupManagedDigest(previous.contents) !== savedDigest))
    throw new Error(
      `Refusing to overwrite custom or unexpectedly edited configuration at ${relativePath}`,
    );
  await atomicManagedWrite(path, contents, previous);
  record.managedFiles[relativePath] = expected;
  await store.save(record);
  return { path: relativePath, change: previous ? "updated" : "created" };
}

async function rejectCustomEnvironment(projectRoot: string): Promise<void> {
  await safeDirectory(projectRoot);
  if (process.env.HUE_API_KEY)
    throw new Error("Refusing to replace an existing custom Hue credential from HUE_API_KEY");
  const entries = await readdir(projectRoot, { withFileTypes: true });
  if (entries.length > 10_000) throw new Error("Refusing to scan an oversized project directory");
  for (const entry of entries) {
    if (!(entry.name === ".env" || entry.name.startsWith(".env."))) continue;
    if (entry.isSymbolicLink()) throw new Error(`Refusing unsafe credential file at ${entry.name}`);
    if (!entry.isFile()) continue;
    const path = join(projectRoot, entry.name);
    const source = (await readManaged(path))?.contents;
    if (source === undefined) throw new Error("Refusing credential file changed during inspection");
    if (/^\s*(?:export\s+)?HUE_API_KEY\s*=/mu.test(source))
      throw new Error(`Refusing to replace an existing custom Hue credential in ${entry.name}`);
  }
}

/** Refuses credential/config conflicts before setup makes a provisioning request. */
export async function validateSetupConfiguration(
  store: FileSetupInstallationStore,
  record: Pick<SetupInstallationRecord, "managedFiles"> | undefined,
  project: SetupProjectDetection,
): Promise<void> {
  if (project.root !== store.projectRoot) throw new Error("Setup project identity changed");
  if (project.languages.length === 0)
    throw new Error("No supported TypeScript or Python project was detected");
  await rejectCustomEnvironment(store.projectRoot);
  const candidates: Array<[string, string]> = [];
  if (project.languages.includes("typescript"))
    candidates.push(["hue.setup.mjs", typescriptConfig(store)]);
  if (project.languages.includes("python")) candidates.push(["hue_setup.py", pythonConfig(store)]);
  for (const [relativePath, expected] of candidates) {
    const path = join(store.projectRoot, relativePath);
    const previous = await readManaged(path);
    if (previous) {
      const digest = setupManagedDigest(previous.contents);
      if (digest !== setupManagedDigest(expected) && digest !== record?.managedFiles[relativePath])
        throw new Error(
          `Refusing to overwrite custom or unexpectedly edited configuration at ${relativePath}`,
        );
    }
  }
}

/** Writes only secret-free, metadata-only integration modules and never executes project code. */
export async function configureSetupProject(
  store: FileSetupInstallationStore,
  record: SetupInstallationRecord,
  project: SetupProjectDetection,
): Promise<SetupFileChange[]> {
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
