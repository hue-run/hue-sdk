import { randomInt, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
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
      /** JavaScript or TypeScript application using the shared TypeScript SDK. */
      language: "typescript";
      /** Package manager selected from the project's manifest and lockfile. */
      manager: "bun" | "npm";
      /** Recognized HTTP framework. */
      framework: "express";
      /** Runtime named by the recognized start script; defaults to Node when omitted. */
      runtime?: "node" | "bun";
      /** Whether the start script explicitly enables Node source maps. */
      sourceMaps?: boolean;
      /** Validated project-relative application entrypoint. */
      entrypoint: string;
      /** One literal loopback HTTP pathname selected for the application request. */
      requestPath: string;
      /** SHA-256 of the source inspected during planning. */
      entryDigest: string;
    }
  | {
      /** Python application using the Python SDK. */
      language: "python";
      /** Environment manager for the supported Python application. */
      manager: "uv";
      /** Recognized HTTP framework. */
      framework: "flask";
      /** Supported project-relative Flask entrypoint. */
      entrypoint: "app.py";
      /** One literal loopback HTTP pathname selected for the application request. */
      requestPath: string;
      /** SHA-256 of the source inspected during planning. */
      entryDigest: string;
    };

/** Stable reason an automatic application integration is not safe. */
export class SetupApplicationActionRequired extends Error {
  constructor(
    /** Stable reason the caller must resolve before automatic integration continues. */
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
  /** Fixed executable name or runtime path; never evaluated by a shell. */
  command: string;
  /** Explicit argument vector supplied to the executable. */
  args: string[];
  /** Selected application's working directory. */
  cwd: string;
  /** Optional child environment; values are never included in command output. */
  env?: NodeJS.ProcessEnv;
  /** Maximum elapsed execution time before termination. */
  timeoutMillis: number;
}

/** Executes a fixed argv without a shell and returns only its status. */
export type SetupCommandRunner = (command: SetupCommand) => Promise<void>;

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
}

async function safeDirectory(path: string): Promise<void> {
  const directories: string[] = [];
  let current = resolve(path);
  for (;;) {
    directories.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const directory of directories) {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new SetupApplicationActionRequired(
        "custom-instrumentation",
        "The application path contains an unsafe directory. Select a regular project directory without symlinks.",
      );
  }
  if ((await realpath(path)) !== resolve(path))
    throw new Error("Unsafe setup application directory");
}

async function safeRead(root: string, relativePath: string): Promise<string> {
  const path = resolve(root, relativePath);
  if (!inside(root, path)) throw new Error("Unsafe setup application path");
  await safeDirectory(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SOURCE_BYTES || (info.mode & 0o7000) !== 0)
      throw new Error("Unsafe setup application file");
    const source = await handle.readFile("utf8");
    const after = await handle.stat();
    await safeDirectory(dirname(path));
    const named = await lstat(path);
    if (
      info.dev !== named.dev ||
      info.ino !== named.ino ||
      !named.isFile() ||
      info.mode !== named.mode ||
      info.mtimeMs !== after.mtimeMs ||
      info.ctimeMs !== after.ctimeMs ||
      info.size !== after.size
    )
      throw new Error("The setup application file changed while reading");
    return source;
  } finally {
    await handle.close();
  }
}

async function rejectMonorepoRoot(root: string): Promise<void> {
  await safeDirectory(root);
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

async function rejectNodeWorkspaceAncestors(root: string): Promise<void> {
  // npm and Bun can discover an ancestor workspace and move installation/lockfile writes there.
  for (let parent = dirname(root); ; parent = dirname(parent)) {
    try {
      const source = await safeRead(parent, "package.json");
      const manifest = JSON.parse(source) as Record<string, unknown>;
      if (
        !manifest ||
        typeof manifest !== "object" ||
        Array.isArray(manifest) ||
        manifest.workspaces !== undefined
      )
        throw new SetupApplicationActionRequired(
          "ambiguous-project",
          "Automatic Express setup does not mutate workspace members. Select an independent npm or Bun application project.",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(parent) === parent) break;
  }
}

function typescriptRuntimeDeclared(manifest: Record<string, unknown>): boolean {
  const refuse = () =>
    new SetupApplicationActionRequired(
      "custom-instrumentation",
      `The project declares a custom or malformed @hue-run/sdk dependency. Select ${sdkVersion} explicitly, review compatibility, and rerun setup.`,
    );
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw refuse();
  const declared: unknown[] = [];
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = manifest[section];
    if (dependencies === undefined) continue;
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies))
      throw refuse();
    if (Object.hasOwn(dependencies, "@hue-run/sdk")) {
      if (section === "peerDependencies") throw refuse();
      declared.push((dependencies as Record<string, unknown>)["@hue-run/sdk"]);
    }
  }
  if (declared.length > 1 || (declared.length === 1 && declared[0] !== sdkVersion)) throw refuse();
  return declared.length === 1;
}

function applicationRequestUrl(path: string, origin: string): URL {
  const url = new URL(path, origin);
  if (
    path.length > 200 ||
    !/^\/(?:[A-Za-z0-9_~.-]+\/?)*$/u.test(path) ||
    path.startsWith("//") ||
    url.origin !== origin ||
    url.pathname !== path ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  )
    throw new SetupApplicationActionRequired(
      "ambiguous-entrypoint",
      "The existing GET route must be one literal local pathname without redirects, dynamic segments or escaping.",
    );
  return url;
}

function literalGetPath(source: string, language: "typescript" | "python"): string {
  const pattern =
    language === "typescript"
      ? /\bapp\.get\(\s*(["'])([^"']*)\1\s*,/gu
      : /@app\.get\(\s*(["'])([^"']*)\1\s*\)/gu;
  const matches = [...source.matchAll(pattern)].map((match) => match[2]!);
  const calls = [
    ...source.matchAll(language === "typescript" ? /\bapp\.get\s*\(/gu : /@app\.get\s*\(/gu),
  ];
  if (matches.length !== 1 || calls.length !== 1)
    throw new SetupApplicationActionRequired(
      "ambiguous-entrypoint",
      "Hue could not identify one existing literal GET route to exercise. Review the application integration without guessing a route.",
    );
  applicationRequestUrl(matches[0]!, "http://127.0.0.1:1");
  return matches[0]!;
}

function pythonProject(source: string): { dependencies: string[]; hasHue: boolean } {
  const refuse = () =>
    new SetupApplicationActionRequired(
      "custom-instrumentation",
      "Automatic Flask setup requires static project dependencies without build hooks, workspaces, custom Hue requirements or source overrides.",
    );
  // Parse a bounded, deliberately small TOML subset without executing Python or a build backend.
  let clean = "";
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (char === "\n" || char === "\r") throw refuse();
      clean += char;
      if (char === "\\" && quote === '"') {
        clean += source[++index] ?? "";
      } else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      if (source.slice(index, index + 3) === char.repeat(3)) throw refuse();
      quote = char;
      clean += char;
    } else if (char === "#") {
      while (index < source.length && source[index] !== "\n") index += 1;
      clean += "\n";
    } else clean += char;
  }
  if (quote) throw refuse();
  const sections = [...clean.matchAll(/^\s*\[([^\n]+)\]\s*$/gmu)];
  if (sections.some((section) => !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(section[1]!)))
    throw refuse();
  if (
    sections.some((section) =>
      /^(?:build-system|tool\.uv\.(?:workspace|sources))(?:\.|$)/u.test(section[1]!),
    )
  )
    throw refuse();
  const projects = sections.filter((section) => section[1] === "project");
  if (projects.length !== 1 || /^\s*(?:dynamic|workspace|sources)\s*=/mu.test(clean))
    throw refuse();
  const project = projects[0]!;
  const end = sections.find((section) => section.index! > project.index!)?.index ?? clean.length;
  const body = clean.slice(project.index! + project[0].length, end);
  const declarations = [...body.matchAll(/^\s*dependencies\s*=\s*/gmu)];
  if (declarations.length !== 1) throw refuse();
  let cursor = declarations[0]!.index! + declarations[0]![0].length;
  if (body[cursor++] !== "[") throw refuse();
  const dependencies: string[] = [];
  for (;;) {
    while (/\s/u.test(body[cursor] ?? "x")) cursor += 1;
    if (body[cursor] === "]") {
      cursor += 1;
      break;
    }
    const delimiter = body[cursor++];
    if (delimiter !== '"' && delimiter !== "'") throw refuse();
    let dependency = "";
    while (body[cursor] !== delimiter) {
      const char = body[cursor++];
      if (char === undefined || char === "\\" || char === "\n" || char === "\r") throw refuse();
      dependency += char;
    }
    cursor += 1;
    dependencies.push(dependency);
    while (/\s/u.test(body[cursor] ?? "x")) cursor += 1;
    if (body[cursor] === ",") cursor += 1;
    else if (body[cursor] !== "]") throw refuse();
  }
  if (/^[^\n]*\S/u.test(body.slice(cursor))) throw refuse();
  const packageName = (requirement: string) =>
    /^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)/u
      .exec(requirement)?.[1]
      ?.toLowerCase()
      .replaceAll(/[_.-]+/gu, "-");
  const hue = dependencies.filter((dependency) => packageName(dependency) === "hue-run");
  if (
    hue.length > 1 ||
    (hue.length === 1 && !/^hue[-_.]run\s*==\s*0\.2\.2$/iu.test(hue[0]!.trim()))
  )
    throw refuse();
  const allHueStrings = [...clean.matchAll(/(["'])\s*hue[-_.]run\b[^"']*\1/giu)];
  if (
    allHueStrings.length !== hue.length ||
    !dependencies.some((dependency) => packageName(dependency) === "flask")
  )
    throw refuse();
  return { dependencies, hasHue: hue.length === 1 };
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
    typescriptRuntimeDeclared(manifest);
    await rejectNodeWorkspaceAncestors(project.root);
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
        ? /^(node(?: --enable-source-maps)?|bun) ([A-Za-z0-9_./-]+\.(?:ts|mts|js|mjs))$/u.exec(
            start,
          )
        : null;
    if (!match)
      throw new SetupApplicationActionRequired(
        "ambiguous-entrypoint",
        "Define a start script consisting only of node or bun plus one server entrypoint, or integrate Hue into an existing request.",
      );
    const entrypoint = match[2]!;
    const original = await safeRead(project.root, entrypoint);
    const plan: SetupApplicationPlan = {
      language: "typescript",
      manager: managers[0]!,
      framework: "express",
      runtime: match[1] === "bun" ? "bun" : "node",
      sourceMaps: match[1] === "node --enable-source-maps",
      entrypoint,
      requestPath: "/",
      entryDigest: setupManagedDigest(original),
    };
    const source = unmanagedApplicationSource(original, plan);
    if (source.startsWith("#!") || source.startsWith("\ufeff"))
      throw new SetupApplicationActionRequired(
        "ambiguous-entrypoint",
        "The Express entrypoint has a protected prologue. Add instrumentation without moving that prologue before rerunning setup.",
      );
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
    plan.requestPath = literalGetPath(source, "typescript");
    return plan;
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
  pythonProject(await safeRead(project.root, "pyproject.toml"));
  // uv searches parents for workspaces, even when the current package has its own manifest.
  for (let parent = dirname(project.root); ; parent = dirname(parent)) {
    try {
      const manifest = await safeRead(parent, "pyproject.toml");
      if (/^\s*\[\s*tool\s*\.\s*uv\s*\.\s*workspace\s*\]/mu.test(manifest))
        throw new SetupApplicationActionRequired(
          "ambiguous-project",
          "Automatic Flask setup does not mutate uv workspaces. Select an independent uv application project.",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(parent) === parent) break;
  }
  const original = await safeRead(project.root, "app.py");
  const plan: SetupApplicationPlan = {
    language: "python",
    manager: "uv",
    framework: "flask",
    entrypoint: "app.py",
    requestPath: "/",
    entryDigest: setupManagedDigest(original),
  };
  const source = unmanagedApplicationSource(original, plan);
  const withoutLeadingComments = source.replace(/^(?:[ \t]*(?:#[^\n]*)?\r?\n)*/u, "");
  if (
    source.startsWith("#!") ||
    source.startsWith("\ufeff") ||
    /^(?:[^\n]*\n)?[^\n]*coding\s*[:=]/u.test(source) ||
    /^\s*(?:[rubfRUBF]{0,2})?["']/u.test(withoutLeadingComments) ||
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
  plan.requestPath = literalGetPath(source, "python");
  return plan;
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
    const manifest = JSON.parse(await safeRead(project.root, "package.json")) as Record<
      string,
      unknown
    >;
    const pinned = typescriptRuntimeDeclared(manifest);
    await rejectNodeWorkspaceAncestors(project.root);
    const lockNames =
      plan.manager === "npm"
        ? ["package-lock.json", "npm-shrinkwrap.json"]
        : ["bun.lock", "bun.lockb"];
    let locked = false;
    for (const name of lockNames) {
      try {
        await safeRead(project.root, name);
        locked = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const args =
      plan.manager === "npm"
        ? pinned
          ? [locked ? "ci" : "install", "--ignore-scripts", "--no-audit", "--no-fund"]
          : ["install", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", spec]
        : pinned
          ? ["install", ...(locked ? ["--frozen-lockfile"] : []), "--ignore-scripts"]
          : ["add", "--exact", "--ignore-scripts", spec];
    await runner({ command: plan.manager, args, cwd: project.root, timeoutMillis: 120_000 });
    const updated = JSON.parse(await safeRead(project.root, "package.json")) as Record<
      string,
      unknown
    >;
    const dependencies = ["dependencies", "devDependencies", "optionalDependencies"].map(
      (name) => updated[name] as Record<string, unknown> | undefined,
    );
    if (!dependencies.some((section) => section?.["@hue-run/sdk"] === sdkVersion))
      throw new Error("The package manager did not record the exact Hue runtime version");
    return true;
  }
  const before = await safeRead(project.root, "pyproject.toml");
  const python = pythonProject(before);
  if (!python.hasHue)
    await runner({
      command: "uv",
      args: ["add", "--no-build", "--no-sync", `hue-run==${PYTHON_RUNTIME_VERSION}`],
      cwd: project.root,
      timeoutMillis: 120_000,
    });
  if (!pythonProject(await safeRead(project.root, "pyproject.toml")).hasHue)
    throw new Error("uv did not record the exact Hue runtime version");
  await runner({
    command: "uv",
    args: ["sync", "--locked", "--no-build", "--no-install-project", "--no-default-groups"],
    cwd: project.root,
    timeoutMillis: 120_000,
  });
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

function unmanagedApplicationSource(source: string, plan: SetupApplicationPlan): string {
  const first = markerBlock(plan);
  const second = callBlock(plan);
  const starts = source.split(START_MARKER).length - 1;
  const ends = source.split(END_MARKER).length - 1;
  if (!starts && !ends) {
    if (/\b(?:installHueExpress|install_hue_flask)\b/u.test(source))
      throw new SetupApplicationActionRequired(
        "custom-instrumentation",
        "Existing Hue application wiring requires explicit review.",
      );
    return source;
  }
  const anchor =
    plan.language === "typescript"
      ? /\b(?:const|let)\s+app\s*=\s*express\(\s*\)\s*;/u
      : /^app\s*=\s*Flask\(__name__\)[ \t]*$/mu;
  const stripped = source.slice(first.length);
  const match = anchor.exec(stripped);
  const offset = match ? match.index + match[0].length : -1;
  if (
    starts !== 2 ||
    ends !== 2 ||
    !source.startsWith(first) ||
    offset < 0 ||
    stripped.slice(offset, offset + second.length) !== second
  )
    throw new SetupApplicationActionRequired(
      "custom-instrumentation",
      "The existing Hue instrumentation markers were edited or moved. Review the application wiring before rerunning setup.",
    );
  return stripped.slice(0, offset) + stripped.slice(offset + second.length);
}

async function atomicSourceWrite(
  root: string,
  path: string,
  expectedSource: string,
  source: string,
): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    await safeDirectory(dirname(path));
    const directory = await lstat(dirname(path), { bigint: true });
    const original = await lstat(path, { bigint: true });
    if (!original.isFile() || original.isSymbolicLink() || (original.mode & 0o7000n) !== 0n)
      throw new Error("Unsafe setup application entrypoint");
    const originalMode = Number(original.mode & 0o777n);
    if ((await safeRead(root, relative(root, path))) !== expectedSource)
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
    await handle.chmod(originalMode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await safeDirectory(dirname(path));
    const existingDirectory = await lstat(dirname(path), { bigint: true });
    const existing = await lstat(path, { bigint: true });
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.dev !== original.dev ||
      existing.ino !== original.ino ||
      existing.mode !== original.mode ||
      existing.mtimeNs !== original.mtimeNs ||
      existing.ctimeNs !== original.ctimeNs ||
      existingDirectory.dev !== directory.dev ||
      existingDirectory.ino !== directory.ino ||
      (await safeRead(root, relative(root, path))) !== expectedSource
    )
      throw new SetupApplicationActionRequired(
        "custom-instrumentation",
        "The application entrypoint changed while Hue was preparing its edit; no replacement was made.",
      );
    await rename(temporary, path);
  } finally {
    await handle?.close();
    await safeDirectory(dirname(path));
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
  if (unmanagedApplicationSource(source, plan) !== source) return undefined;
  if (setupManagedDigest(source) !== plan.entryDigest)
    throw new SetupApplicationActionRequired(
      "custom-instrumentation",
      "The application entrypoint changed after detection; Hue refused to merge a concurrent edit.",
    );
  const anchor =
    plan.language === "typescript"
      ? /\b(?:const|let)\s+app\s*=\s*express\(\s*\)\s*;/u
      : /^app\s*=\s*Flask\(__name__\)[ \t]*$/mu;
  const match = anchor.exec(source);
  if (!match)
    throw new SetupApplicationActionRequired(
      "ambiguous-entrypoint",
      "The application entrypoint changed after detection; Hue made no wiring change.",
    );
  const offset = match.index + match[0].length;
  const next = `${first}${source.slice(0, offset)}${second}${source.slice(offset)}`;
  await atomicSourceWrite(store.projectRoot, path, source, next);
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
    if (signal?.aborted) throw new Error("Setup interrupted");
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
  applicationRequestUrl(plan.requestPath, "http://127.0.0.1:1");
  await safeRead(store.projectRoot, plan.entrypoint);
  if (record.applicationAttempt)
    throw new SetupApplicationActionRequired(
      "custom-instrumentation",
      "Hue already attempted this application request. It will not replay business work after missing telemetry evidence or account claim.",
    );
  record.applicationAttempt = {
    credentialVersion: record.credential.version,
    startedAt: new Date().toISOString(),
  };
  await store.save(record);
  await store.removeApplicationEvidence();
  const port = randomInt(20_000, 60_000);
  const command =
    plan.language === "typescript"
      ? plan.runtime === "bun"
        ? "bun"
        : process.versions.bun
          ? "node"
          : process.execPath
      : "uv";
  const args =
    plan.language === "typescript"
      ? [...(plan.sourceMaps ? ["--enable-source-maps"] : []), plan.entrypoint]
      : ["run", "--frozen", "--no-build", "--no-sync", "python", plan.entrypoint];
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
  let launchFailed = false;
  child.once("error", () => {
    launchFailed = true;
  });
  try {
    if (child.pid === undefined) throw new Error("The application runtime is unavailable");
    await waitForListener(port, child, signal, deadlines.readinessMillis);
    if (launchFailed) throw new Error("The application runtime is unavailable");
    const origin = `http://127.0.0.1:${port}`;
    const requestUrl = applicationRequestUrl(plan.requestPath, origin);
    const response = await fetch(requestUrl, {
      redirect: "manual",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(deadlines.requestMillis)])
        : AbortSignal.timeout(deadlines.requestMillis),
    });
    await response.body?.cancel();
    const deadline = Date.now() + deadlines.evidenceMillis;
    for (;;) {
      if (signal?.aborted) throw new Error("Setup interrupted");
      try {
        const info = await lstat(store.applicationEvidencePath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
          throw new Error("Unsafe application evidence file");
        if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
          throw new Error("Application evidence must use mode 0600");
        const evidence = validEvidence(
          JSON.parse(
            await safeRead(
              store.projectRoot,
              relative(store.projectRoot, store.applicationEvidencePath),
            ),
          ),
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
      if (child.exitCode !== null || child.pid === undefined || launchFailed) resolvePromise();
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
