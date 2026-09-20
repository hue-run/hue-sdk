import { randomInt, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { sdkVersion } from "../version.js";
import type { SetupFileChange } from "./configure.js";
import {
  setupManagedDigest,
  type FileSetupInstallationStore,
  type SetupInstallationRecord,
  type SetupStoredApplicationEvidence,
} from "./installation.js";
import type { SetupProjectDetection } from "./types.js";

const PYTHON_RUNTIME_VERSION = "0.2.2";
const MAX_SOURCE_BYTES = 1024 * 1024;
const START_MARKER = "Hue setup instrumentation (managed; do not edit)";
const END_MARKER = "End Hue setup instrumentation";

/** Closed automatic application matrix; other projects require an explicit agent-owned integration. */
export type SetupApplicationPlan =
  | {
      language: "typescript";
      manager: "bun" | "npm";
      framework: "express";
      entrypoint: string;
      requestPath: string;
      entryDigest: string;
    }
  | {
      language: "python";
      manager: "uv";
      framework: "flask";
      entrypoint: "app.py";
      requestPath: string;
      entryDigest: string;
    };

/** Stable reason an automatic application integration is not safe. */
export class SetupApplicationActionRequired extends Error {
  constructor(
    readonly code:
      | "ambiguous-project"
      | "unsupported-manager"
      | "unsupported-framework"
      | "ambiguous-entrypoint"
      | "custom-instrumentation",
    message: string,
  ) {
    super(message);
    this.name = "SetupApplicationActionRequired";
  }
}

/** Fixed argv execution boundary used for package managers and application entrypoints. */
export interface SetupCommand {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMillis: number;
}

/** Executes a fixed argv without a shell and returns only its status. */
export type SetupCommandRunner = (command: SetupCommand) => Promise<void>;

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
}

async function safeRead(root: string, relativePath: string): Promise<string> {
  const path = resolve(root, relativePath);
  if (!inside(root, path)) throw new Error("Unsafe setup application path");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SOURCE_BYTES)
      throw new Error(`Unsafe setup application file at ${relativePath}`);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function rejectMonorepoRoot(root: string): Promise<void> {
  for (const marker of ["pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json"]) {
    try {
      const handle = await open(join(root, marker), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if ((await handle.stat()).isFile())
          throw new SetupApplicationActionRequired(
            "ambiguous-project",
            "Run setup from one selected workspace package with --project; the repository root is ambiguous.",
          );
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function literalGetPath(source: string, receiver: "app"): string {
  const matches = [
    ...source.matchAll(new RegExp(`${receiver}\\.get\\(\\s*(["'])(/[^"']*)\\1\\s*,`, "gu")),
  ].map((match) => match[2]!);
  const unique = [...new Set(matches)];
  if (unique.includes("/")) return "/";
  if (unique.length === 1 && unique[0]!.length <= 200) return unique[0]!;
  throw new SetupApplicationActionRequired(
    "ambiguous-entrypoint",
    "Hue could not identify one existing literal GET route to exercise. Instrument an application request and rerun hue resume.",
  );
}

/** Statically recognizes the deliberately narrow automatic matrix without executing project code. */
export async function planSetupApplication(
  project: SetupProjectDetection,
): Promise<SetupApplicationPlan> {
  await rejectMonorepoRoot(project.root);
  if (project.languages.length !== 1)
    throw new SetupApplicationActionRequired(
      "ambiguous-project",
      "Select one TypeScript or Python package root with --project; Hue will not choose a monorepo package or language automatically.",
    );
  if (project.languages[0] === "typescript") {
    const managers = project.packageManagers.filter(
      (manager): manager is "bun" | "npm" => manager === "bun" || manager === "npm",
    );
    if (managers.length !== 1 || project.packageManagers.length !== 1)
      throw new SetupApplicationActionRequired(
        "unsupported-manager",
        "Select a single npm or Bun package root and rerun setup; Hue will not choose or rewrite an ambiguous lockfile.",
      );
    if (!project.frameworks.includes("express"))
      throw new SetupApplicationActionRequired(
        "unsupported-framework",
        "Automatic setup currently supports single-package Express servers only. Add Hue to one existing request path, then rerun hue resume.",
      );
    const manifest = JSON.parse(await safeRead(project.root, "package.json")) as Record<
      string,
      unknown
    >;
    if (manifest.workspaces !== undefined)
      throw new SetupApplicationActionRequired(
        "ambiguous-project",
        "Run setup from one selected workspace package with --project; the repository root is ambiguous.",
      );
    const start =
      manifest.scripts && typeof manifest.scripts === "object" && !Array.isArray(manifest.scripts)
        ? (manifest.scripts as Record<string, unknown>).start
        : undefined;
    const match =
      typeof start === "string"
        ? /^node(?: --enable-source-maps)? ([A-Za-z0-9_./-]+\.(?:ts|mts|js|mjs))$/u.exec(start)
        : null;
    if (!match)
      throw new SetupApplicationActionRequired(
        "ambiguous-entrypoint",
        "Define a start script consisting only of node plus one server entrypoint, or integrate Hue into an existing request and rerun hue resume.",
      );
    const entrypoint = match[1]!;
    const source = await safeRead(project.root, entrypoint);
    if (!/\b(?:const|let)\s+app\s*=\s*express\(\s*\)\s*;/u.test(source))
      throw new SetupApplicationActionRequired(
        "ambiguous-entrypoint",
        "Hue could not identify the Express app construction without guessing about business logic.",
      );
    if (!/\bapp\.listen\([^;]*process\.env\.PORT/su.test(source))
      throw new SetupApplicationActionRequired(
        "ambiguous-entrypoint",
        "The supported Express entrypoint must honor process.env.PORT so setup can exercise it without taking over a fixed port.",
      );
    return {
      language: "typescript",
      manager: managers[0]!,
      framework: "express",
      entrypoint,
      requestPath: literalGetPath(source, "app"),
      entryDigest: setupManagedDigest(source),
    };
  }
  if (project.packageManagers.length !== 1 || project.packageManagers[0] !== "uv")
    throw new SetupApplicationActionRequired(
      "unsupported-manager",
      "Automatic Python setup currently supports one uv package only; Hue will not choose or rewrite another environment manager.",
    );
  if (!project.frameworks.includes("flask"))
    throw new SetupApplicationActionRequired(
      "unsupported-framework",
      "Automatic setup currently supports single-package Flask servers only. Add Hue to one existing request path, then rerun hue resume.",
    );
  const source = await safeRead(project.root, "app.py");
  if (
    source.startsWith("#!") ||
    /^(?:[^\n]*\n)?[^\n]*coding\s*[:=]/u.test(source) ||
    /^\s*(?:[rubfRUBF]{0,2})?(?:'''|""")/u.test(source) ||
    /^\s*from\s+__future__\s+import\s+/mu.test(source)
  )
    throw new SetupApplicationActionRequired(
      "ambiguous-entrypoint",
      "The Flask entrypoint has a protected Python prologue. Integrate Hue after its prologue and rerun hue resume.",
    );
  if (!/^app\s*=\s*Flask\(__name__\)\s*$/mu.test(source))
    throw new SetupApplicationActionRequired(
      "ambiguous-entrypoint",
      "Hue could not identify the Flask app construction without guessing about business logic.",
    );
  if (!/app\.run\([^)]*os\.environ\[(["'])PORT\1\]/su.test(source))
    throw new SetupApplicationActionRequired(
      "ambiguous-entrypoint",
      "The supported Flask entrypoint must honor os.environ['PORT'] so setup can exercise it without taking over a fixed port.",
    );
  const matches = [...source.matchAll(/@app\.get\(\s*(["'])(\/[^"']*)\1\s*\)/gu)].map(
    (match) => match[2]!,
  );
  const requestPath = matches.includes("/") ? "/" : [...new Set(matches)][0];
  if (!requestPath || [...new Set(matches)].length !== 1)
    throw new SetupApplicationActionRequired(
      "ambiguous-entrypoint",
      "Hue could not identify one existing literal Flask GET route to exercise.",
    );
  return {
    language: "python",
    manager: "uv",
    framework: "flask",
    entrypoint: "app.py",
    requestPath,
    entryDigest: setupManagedDigest(source),
  };
}

/** Default command runner: fixed argv, no shell, bounded output and deadline. */
export async function runSetupCommand(input: SetupCommand): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outputBytes = 0;
    const count = (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 64 * 1024) child.kill("SIGKILL");
    };
    child.stdout.on("data", count);
    child.stderr.on("data", count);
    const timer = setTimeout(() => child.kill("SIGKILL"), input.timeoutMillis);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && outputBytes <= 64 * 1024) resolvePromise();
      else rejectPromise(new Error("The bounded setup command did not complete successfully"));
    });
  });
}

/** Installs the exact runtime with the detected owner of the project's manifest and lockfile. */
export async function installSetupRuntime(
  project: SetupProjectDetection,
  plan: SetupApplicationPlan,
  runner: SetupCommandRunner = runSetupCommand,
): Promise<boolean> {
  if (plan.language === "typescript") {
    const spec = `@hue-run/sdk@${sdkVersion}`;
    const manifestPath = join(project.root, "package.json");
    const manifest = JSON.parse(await safeRead(project.root, "package.json")) as Record<
      string,
      unknown
    >;
    const declared = ["dependencies", "devDependencies", "optionalDependencies"]
      .map((name) => manifest[name])
      .filter(
        (value): value is Record<string, unknown> =>
          !!value && typeof value === "object" && !Array.isArray(value),
      )
      .map((value) => value["@hue-run/sdk"])
      .filter((value): value is string => typeof value === "string");
    if (declared.length > 1 || (declared.length === 1 && declared[0] !== sdkVersion))
      throw new SetupApplicationActionRequired(
        "custom-instrumentation",
        `The project declares a custom @hue-run/sdk version. Select ${sdkVersion} explicitly, review its compatibility, and rerun setup.`,
      );
    if (declared[0] === sdkVersion) return false;
    const args =
      plan.manager === "npm"
        ? ["install", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", spec]
        : ["add", "--exact", "--ignore-scripts", spec];
    await runner({ command: plan.manager, args, cwd: project.root, timeoutMillis: 120_000 });
    const updated = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const dependencies = updated.dependencies as Record<string, unknown> | undefined;
    if (dependencies?.["@hue-run/sdk"] !== sdkVersion)
      throw new Error("The package manager did not record the exact Hue runtime version");
    return true;
  }
  const before = await safeRead(project.root, "pyproject.toml");
  const hueDeclarations = [
    ...before.matchAll(/\bhue-run\s*(?:==|===)\s*([0-9]+\.[0-9]+\.[0-9]+)/gu),
  ].map((match) => match[1]!);
  if (
    hueDeclarations.length > 1 ||
    (hueDeclarations.length === 1 && hueDeclarations[0] !== PYTHON_RUNTIME_VERSION)
  )
    throw new SetupApplicationActionRequired(
      "custom-instrumentation",
      `The project declares a custom hue-run version. Select ${PYTHON_RUNTIME_VERSION} explicitly, review its compatibility, and rerun setup.`,
    );
  if (hueDeclarations[0] === PYTHON_RUNTIME_VERSION) return false;
  await runner({
    command: "uv",
    args: ["add", `hue-run==${PYTHON_RUNTIME_VERSION}`],
    cwd: project.root,
    timeoutMillis: 120_000,
  });
  if (
    !(await safeRead(project.root, "pyproject.toml")).match(/\bhue-run\s*(?:==|===)\s*0\.2\.2\b/u)
  )
    throw new Error("uv did not record the exact Hue runtime version");
  return true;
}

function relativeImport(from: string, to: string): string {
  let value = relative(dirname(from), to).replaceAll("\\", "/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

function markerBlock(plan: SetupApplicationPlan): string {
  if (plan.language === "typescript") {
    const modulePath = relativeImport(plan.entrypoint, "hue.setup.mjs");
    return `// ${START_MARKER}\nimport { installHueExpress } from ${JSON.stringify(modulePath)};\n// ${END_MARKER}\n`;
  }
  return `# ${START_MARKER}\nfrom hue_setup import install_hue_flask\n# ${END_MARKER}\n`;
}

function callBlock(plan: SetupApplicationPlan): string {
  return plan.language === "typescript"
    ? `\n// ${START_MARKER}\ninstallHueExpress(app);\n// ${END_MARKER}\n`
    : `\n# ${START_MARKER}\ninstall_hue_flask(app)\n# ${END_MARKER}\n`;
}

async function atomicSourceWrite(
  path: string,
  expectedSource: string,
  source: string,
): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    const original = await lstat(path, { bigint: true });
    if (!original.isFile() || original.isSymbolicLink())
      throw new Error("Unsafe setup application entrypoint");
    const originalMode = Number(original.mode & 0o777n);
    if ((await readFile(path, "utf8")) !== expectedSource)
      throw new SetupApplicationActionRequired(
        "custom-instrumentation",
        "The application entrypoint changed after planning; Hue refused the concurrent edit.",
      );
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      originalMode,
    );
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, originalMode);
    const existing = await lstat(path, { bigint: true });
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.dev !== original.dev ||
      existing.ino !== original.ino ||
      existing.mode !== original.mode ||
      (await readFile(path, "utf8")) !== expectedSource
    )
      throw new SetupApplicationActionRequired(
        "custom-instrumentation",
        "The application entrypoint changed while Hue was preparing its edit; no replacement was made.",
      );
    await rename(temporary, path);
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Adds only two owned wiring blocks around an existing app object; business logic is untouched. */
export async function wireSetupApplication(
  store: FileSetupInstallationStore,
  record: SetupInstallationRecord,
  plan: SetupApplicationPlan,
): Promise<SetupFileChange | undefined> {
  const path = resolve(store.projectRoot, plan.entrypoint);
  if (!inside(store.projectRoot, path)) throw new Error("Unsafe setup application path");
  const source = await safeRead(store.projectRoot, plan.entrypoint);
  const first = markerBlock(plan);
  const second = callBlock(plan);
  const starts = source.split(START_MARKER).length - 1;
  const ends = source.split(END_MARKER).length - 1;
  if (starts || ends) {
    if (starts !== 2 || ends !== 2 || !source.includes(first.trimEnd()) || !source.includes(second))
      throw new SetupApplicationActionRequired(
        "custom-instrumentation",
        "The existing Hue instrumentation markers were edited. Review the application wiring and rerun setup.",
      );
    return undefined;
  }
  if (setupManagedDigest(source) !== plan.entryDigest)
    throw new SetupApplicationActionRequired(
      "custom-instrumentation",
      "The application entrypoint changed after detection; Hue refused to merge a concurrent edit.",
    );
  const anchor =
    plan.language === "typescript"
      ? /\b(?:const|let)\s+app\s*=\s*express\(\s*\)\s*;/u
      : /^app\s*=\s*Flask\(__name__\)\s*$/mu;
  const match = anchor.exec(source);
  if (!match)
    throw new SetupApplicationActionRequired(
      "ambiguous-entrypoint",
      "The application entrypoint changed after detection; Hue made no wiring change.",
    );
  const offset = match.index + match[0].length;
  const next = `${first}${source.slice(0, offset)}${second}${source.slice(offset)}`;
  await atomicSourceWrite(path, source, next);
  record.managedFiles[`application:${plan.entrypoint}`] = setupManagedDigest(first + second);
  await store.save(record);
  return { path: plan.entrypoint, change: "updated" };
}

function validEvidence(value: unknown, version: 0 | 1): SetupStoredApplicationEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Application instrumentation did not produce evidence");
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).sort().join("\0") !==
      ["credentialVersion", "source", "spanId", "traceId"].sort().join("\0") ||
    item.source !== "existing-application-request" ||
    item.credentialVersion !== version ||
    typeof item.traceId !== "string" ||
    !/^[a-f0-9]{32}$/u.test(item.traceId) ||
    /^0+$/u.test(item.traceId) ||
    typeof item.spanId !== "string" ||
    !/^[a-f0-9]{16}$/u.test(item.spanId) ||
    /^0+$/u.test(item.spanId)
  )
    throw new Error("Application instrumentation produced invalid evidence");
  return {
    source: "existing-application-request",
    traceId: item.traceId,
    spanId: item.spanId,
    credentialVersion: version,
    verified: false,
  };
}

async function waitForListener(
  port: number,
  child: ReturnType<typeof spawn>,
  signal: AbortSignal | undefined,
  timeoutMillis: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMillis;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason;
    if (child.exitCode !== null) throw new Error("The application exited before verification");
    const ready = await new Promise<boolean>((resolvePromise) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      const finish = (value: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolvePromise(value);
      };
      socket.setTimeout(500, () => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
    if (ready) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("The application did not become ready within the setup deadline");
}

/** Starts the existing entrypoint without a shell and exercises one existing HTTP GET route. */
export async function exerciseSetupApplication(
  store: FileSetupInstallationStore,
  record: SetupInstallationRecord,
  plan: SetupApplicationPlan,
  signal?: AbortSignal,
  deadlines: {
    readinessMillis: number;
    requestMillis: number;
    evidenceMillis: number;
  } = { readinessMillis: 10_000, requestMillis: 10_000, evidenceMillis: 10_000 },
): Promise<SetupStoredApplicationEvidence> {
  if (!record.credential) throw new Error("Setup credential is not available");
  if (record.applicationAttempt?.credentialVersion === record.credential.version)
    throw new SetupApplicationActionRequired(
      "custom-instrumentation",
      "Hue already exercised this credential generation. It will not replay application work after missing telemetry evidence.",
    );
  record.applicationAttempt = {
    credentialVersion: record.credential.version,
    startedAt: new Date().toISOString(),
  };
  await store.save(record);
  await store.removeApplicationEvidence();
  const port = randomInt(20_000, 60_000);
  const command = plan.language === "typescript" ? process.execPath : "uv";
  const args =
    plan.language === "typescript"
      ? [plan.entrypoint]
      : ["run", "--frozen", "python", plan.entrypoint];
  const child = spawn(command, args, {
    cwd: store.projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HUE_SETUP_EVIDENCE_FILE: store.applicationEvidencePath,
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let outputBytes = 0;
  const count = (chunk: Buffer) => {
    outputBytes += chunk.byteLength;
    if (outputBytes > 64 * 1024) child.kill("SIGKILL");
  };
  child.stdout.on("data", count);
  child.stderr.on("data", count);
  try {
    await waitForListener(port, child, signal, deadlines.readinessMillis);
    const response = await fetch(new URL(plan.requestPath, `http://127.0.0.1:${port}`), {
      redirect: "manual",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(deadlines.requestMillis)])
        : AbortSignal.timeout(deadlines.requestMillis),
    });
    await response.body?.cancel();
    const deadline = Date.now() + deadlines.evidenceMillis;
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      try {
        const info = await lstat(store.applicationEvidencePath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
          throw new Error("Unsafe application evidence file");
        if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
          throw new Error("Application evidence must use mode 0600");
        const evidence = validEvidence(
          JSON.parse(await readFile(store.applicationEvidencePath, "utf8")),
          record.credential.version,
        );
        record.applicationEvidence = evidence;
        await store.save(record);
        await store.removeApplicationEvidence();
        return evidence;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (Date.now() >= deadline)
        throw new Error("The application request did not produce bounded Hue evidence");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => {
      if (child.exitCode !== null) resolvePromise();
      else {
        const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
        child.once("close", () => {
          clearTimeout(timer);
          resolvePromise();
        });
      }
    });
    await store.removeApplicationEvidence().catch(() => undefined);
  }
}
