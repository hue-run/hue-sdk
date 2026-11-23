import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "hue-unc-setup-")));
  directories.push(path);
  return path;
}

const expressSource = `import express from "express";
const app = express();
app.get("/", (_request, response) => response.end("business"));
app.listen(Number(process.env.PORT), "127.0.0.1");
`;

const uncEntry = "//evil.example/share/app.js";
// Node's win32 relative() returns this absolute UNC path unchanged. It does not
// start with ".." or "/", so the setup containment check treats it as inside.
const uncRelative = "\\\\evil.example\\share\\app.js";

async function project(start: string, manager: "npm" | "bun"): Promise<string> {
  const root = await scratch();
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      packageManager: manager === "bun" ? "bun@1.4.2" : "npm@11.0.0",
      scripts: { start },
      dependencies: { express: "5.1.0" },
    }),
  );
  await writeFile(join(root, manager === "bun" ? "bun.lock" : "package-lock.json"), "{}\n");
  await writeFile(join(root, "src", "server.mjs"), expressSource);
  return root;
}

interface OutsideOperation {
  op: string;
  path: string;
}

interface ScenarioResult {
  refused: boolean;
  error?: string;
  entrypoint?: string;
  probe: string;
  outside: OutsideOperation[];
  mirrorChanged: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResult(stdout: string): ScenarioResult {
  const value: unknown = JSON.parse(stdout);
  if (!isRecord(value) || typeof value.probe !== "string" || typeof value.refused !== "boolean")
    throw new Error(`Runner returned an unexpected result: ${stdout.slice(0, 500)}`);
  if (!Array.isArray(value.outside)) throw new Error("Runner omitted filesystem operations");
  const outside: OutsideOperation[] = [];
  for (const item of value.outside) {
    if (!isRecord(item) || typeof item.op !== "string" || typeof item.path !== "string")
      throw new Error("Runner returned a malformed filesystem operation");
    outside.push({ op: item.op, path: item.path });
  }
  return {
    refused: value.refused,
    error: typeof value.error === "string" ? value.error : undefined,
    entrypoint: typeof value.entrypoint === "string" ? value.entrypoint : undefined,
    probe: value.probe,
    outside,
    mirrorChanged: value.mirrorChanged === true,
  };
}

async function run(
  scenario: "local" | "plan" | "wire" | "exercise",
  root: string,
  present: boolean,
  runtime: "node" | "bun" = "node",
): Promise<ScenarioResult> {
  const dir = await scratch();
  const mirror = join(dir, "share");
  await mkdir(mirror);
  if (present) {
    await mkdir(join(mirror, "evil.example", "share"), { recursive: true });
    await writeFile(join(mirror, "evil.example", "share", "app.js"), expressSource);
  }
  const packageRoot = join(import.meta.dir, "..");
  await writeFile(join(dir, "entry.ts"), entrySource(packageRoot));
  await writeFile(join(dir, "map.mjs"), mapSource);
  await writeFile(join(dir, "fs-adapter.mjs"), fsAdapterSource);
  await writeFile(join(dir, "child-adapter.mjs"), childAdapterSource);
  await writeFile(join(dir, "shim.mjs"), shimSource);
  await writeFile(join(dir, "hook.mjs"), hookSource);
  await writeFile(join(dir, "register.mjs"), registerSource);
  await writeFile(join(dir, "runner.mjs"), runnerSource);
  const build = await Bun.build({
    entrypoints: [join(dir, "entry.ts")],
    outdir: dir,
    target: "node",
    format: "esm",
    packages: "external",
    naming: "subject.js",
  });
  if (!build.success || build.outputs.length !== 1)
    throw new Error(
      build.logs.map((log) => log.message).join("\n") || "Subject bundle did not build",
    );
  const output = build.outputs[0]?.path;
  if (!output) throw new Error("Subject bundle did not build");
  if (output !== join(dir, "subject.js")) await rename(output, join(dir, "subject.js"));
  await symlink(join(packageRoot, "node_modules"), join(dir, "node_modules"), "dir");
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.BUN_OPTIONS;
  env.HUE_SCENARIO = scenario;
  env.HUE_RUNTIME = runtime;
  env.HUE_PROJECT = root;
  env.HUE_MIRROR = mirror;
  env.HUE_SUBJECT = pathToFileURL(join(dir, "subject.js")).href;
  const result = spawnSync(
    "node",
    ["--import", join(dir, "register.mjs"), join(dir, "runner.mjs")],
    {
      cwd: dir,
      env,
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  if (result.error) throw result.error;
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  if (!line.startsWith("{"))
    throw new Error(
      `Runner failed (${result.status ?? "signal"}): ${result.stderr.slice(0, 2000)}`,
    );
  return parseResult(line);
}

function expectContained(result: ScenarioResult, probe: string): void {
  expect(result.probe).toBe(probe);
  expect({
    outside: result.outside,
    mirrorChanged: result.mirrorChanged,
    error: result.error,
  }).toEqual({
    outside: [],
    mirrorChanged: false,
    error: result.error,
  });
}

describe("Windows UNC start-script containment", () => {
  test("plans a local entrypoint without leaving the project", async () => {
    const root = await project("node src/server.mjs", "npm");
    const result = await run("local", root, false);
    expect(result.probe).toBe("src\\server.mjs");
    expect(result.refused).toBe(false);
    expect(result.entrypoint).toBe("src/server.mjs");
    expect(result.outside).toEqual([]);
    expect(result.mirrorChanged).toBe(false);
  }, 20_000);

  test("refuses a UNC node or bun start script before stat or open", async () => {
    for (const manager of ["npm", "bun"] as const) {
      const command = manager === "bun" ? "bun" : "node";
      for (const start of [
        `${command} ${uncEntry}`,
        ...(manager === "npm" ? [`node --enable-source-maps ${uncEntry}`] : []),
      ]) {
        const root = await project(start, manager);
        const missing = await run("plan", root, false);
        expectContained(missing, uncRelative);
        expect(missing.refused).toBe(true);
        const present = await run("plan", root, true);
        expectContained(present, uncRelative);
        expect(present.refused).toBe(true);
      }
    }
  }, 30_000);

  test("refuses to read or overwrite a UNC entrypoint named by a plan", async () => {
    const root = await project("node src/server.mjs", "npm");
    const result = await run("wire", root, true);
    expectContained(result, uncRelative);
    expect(result.refused).toBe(true);
  }, 20_000);

  test("refuses to spawn a UNC entrypoint named by a plan", async () => {
    for (const runtime of ["node", "bun"] as const) {
      const root = await project("node src/server.mjs", "npm");
      const result = await run("exercise", root, true, runtime);
      expectContained(result, uncRelative);
      expect(result.refused).toBe(true);
    }
  }, 20_000);
});

function entrySource(packageRoot: string): string {
  const setup = join(packageRoot, "src", "setup").replaceAll("\\", "/");
  return `import { relative, resolve } from "node:path";
export {
  exerciseSetupApplication,
  planSetupApplication,
  wireSetupApplication,
} from ${JSON.stringify(`${setup}/application.ts`)};
export { detectSetupProject } from ${JSON.stringify(`${setup}/detect.ts`)};
export { FileSetupInstallationStore, setupManagedDigest } from ${JSON.stringify(`${setup}/installation.ts`)};
export function win32PathProbe(project, entry) {
  const child = resolve(project, entry);
  return relative(resolve(project), child);
}
`;
}

const mapSource = `import { win32 } from "node:path";
import { join } from "node:path";
export const outside = [];
function project() {
  return win32.resolve(process.env.HUE_PROJECT);
}
const ancestorMeta = new Set([
  ".git",
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "pyproject.toml",
]);
function contained(parent, child) {
  const rel = win32.relative(win32.resolve(parent), win32.resolve(child));
  if (rel === "" || win32.isAbsolute(rel)) return rel === "";
  return !rel.split("\\\\").includes("..");
}
export function allowed(candidate) {
  const root = project();
  const target = win32.resolve(candidate);
  if (contained(root, target) || contained(target, root)) return true;
  // Setup reads fixed manifest names on ancestors to reject workspaces. Those
  // reads are not the entrypoint. A UNC child is not an ancestor.
  return contained(win32.dirname(target), root) && ancestorMeta.has(win32.basename(target));
}
export function note(op, value) {
  if (typeof value === "string" && !allowed(value)) outside.push({ op, path: value });
}
export function toLocal(candidate) {
  const target = win32.resolve(candidate);
  if (target.startsWith("\\\\\\\\")) {
    const parts = target.split("\\\\").filter(Boolean);
    return join(process.env.HUE_MIRROR, ...parts);
  }
  if (target.startsWith("\\\\")) return target.replaceAll("\\\\", "/");
  return target;
}
`;

const fsAdapterSource = `import * as fs from "node:fs/promises";
import { win32 } from "node:path";
import { note, outside, toLocal } from "./map.mjs";
const indexes = {
  chmod: [0],
  lstat: [0],
  mkdir: [0],
  open: [0],
  readdir: [0],
  readFile: [0],
  rename: [0, 1],
  unlink: [0],
  link: [0, 1],
  rmdir: [0],
};
function wrap(name) {
  return async function (...args) {
    for (const index of indexes[name]) note(name, args[index]);
    const next = args.slice();
    for (const index of indexes[name]) {
      if (typeof next[index] === "string") next[index] = toLocal(next[index]);
    }
    return fs[name](...next);
  };
}
export const chmod = wrap("chmod");
export const lstat = wrap("lstat");
export const mkdir = wrap("mkdir");
export const open = wrap("open");
export const readdir = wrap("readdir");
export const readFile = wrap("readFile");
export const rename = wrap("rename");
export const unlink = wrap("unlink");
export const link = wrap("link");
export const rmdir = wrap("rmdir");
export async function realpath(target) {
  note("realpath", target);
  const actual = await fs.realpath(toLocal(target));
  const resolved = win32.resolve(target);
  const expected = await fs.realpath(toLocal(resolved));
  if (actual !== expected) {
    outside.push({ op: "realpath-escape", path: actual });
    return actual;
  }
  return resolved;
}
`;

const childAdapterSource = `import { execFile as realExecFile, spawn as realSpawn, spawnSync as realSpawnSync } from "node:child_process";
import { win32 } from "node:path";
import { allowed, note, toLocal } from "./map.mjs";
function noteArgs(op, args, cwd) {
  if (!Array.isArray(args)) return;
  for (const arg of args) {
    if (typeof arg !== "string" || (!arg.includes("/") && !arg.includes("\\\\"))) continue;
    const base = typeof cwd === "string" ? cwd : process.cwd();
    if (!allowed(win32.resolve(base, arg))) note(op, arg);
  }
}
function optionsWithLocalCwd(options) {
  if (!options || typeof options.cwd !== "string") return options;
  return { ...options, cwd: toLocal(options.cwd) };
}
export function spawn(command, args, options) {
  noteArgs("spawn", args, options && options.cwd);
  return realSpawn(command, args, optionsWithLocalCwd(options));
}
export function spawnSync(command, args, options) {
  noteArgs("spawnSync", args, options && options.cwd);
  return realSpawnSync(command, args, optionsWithLocalCwd(options));
}
export function execFile(file, args, options, callback) {
  const argv = Array.isArray(args) ? args : [];
  const opts = Array.isArray(args) ? options : args;
  noteArgs("execFile", argv, opts && opts.cwd);
  return realExecFile(file, args, options, callback);
}
`;

const hookSource = `export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL ?? "";
  if (parent === process.env.HUE_SUBJECT) {
    const file =
      specifier === "node:path"
        ? "./shim.mjs"
        : specifier === "node:fs/promises"
          ? "./fs-adapter.mjs"
          : specifier === "node:child_process"
            ? "./child-adapter.mjs"
            : undefined;
    if (file) return { shortCircuit: true, url: new URL(file, import.meta.url).href };
  }
  return nextResolve(specifier, context);
}
`;

const registerSource = `import { register } from "node:module";
register("./hook.mjs", import.meta.url);
`;

const shimSource = `import { posix, win32 } from "node:path";
export const {
  basename,
  delimiter,
  dirname,
  extname,
  format,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep,
  toNamespacedPath,
} = win32;
export { posix, win32 };
export default win32;
`;

const runnerSource = `import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { outside } from "./map.mjs";
import {
  detectSetupProject,
  exerciseSetupApplication,
  FileSetupInstallationStore,
  planSetupApplication,
  setupManagedDigest,
  win32PathProbe,
  wireSetupApplication,
} from "./subject.js";

const project = process.env.HUE_PROJECT;
const mirror = process.env.HUE_MIRROR;
const scenario = process.env.HUE_SCENARIO;
const unc = "//evil.example/share/app.js";

async function snapshot(directory) {
  const found = [];
  async function walk(current) {
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(path + "\\0" + (await readFile(path)));
    }
  }
  await walk(directory);
  return found.sort().join("\\n");
}

function visibleError(error) {
  const message = error instanceof Error ? error.name + ": " + error.message : "non-error";
  return message.replace(/hue_setup_[A-Za-z0-9_-]+/g, "hue_setup_test_placeholder").slice(0, 500);
}

const before = await snapshot(mirror);
let refused = false;
let error;
let entrypoint;
try {
  const probeTarget = scenario === "local" ? "src/server.mjs" : unc;
  var probe = win32PathProbe(project, probeTarget);
  if (scenario === "local" || scenario === "plan") {
    const detected = await detectSetupProject(project);
    const plan = await planSetupApplication(detected);
    entrypoint = plan.entrypoint;
  } else if (scenario === "wire" || scenario === "exercise") {
    const source = await readFile(join(mirror, "evil.example", "share", "app.js"), "utf8");
    const plan = {
      language: "typescript",
      manager: "npm",
      framework: "express",
      runtime: scenario === "exercise" && process.env.HUE_RUNTIME === "bun" ? "bun" : "node",
      entrypoint: unc,
      requestPath: "/",
      entryDigest: setupManagedDigest(source),
    };
    const store = new FileSetupInstallationStore(project, "https://example.invalid");
    const record = await store.loadOrCreate();
    if (scenario === "wire") {
      const change = await wireSetupApplication(store, record, plan);
      entrypoint = change && change.path;
    } else {
      const suffix = randomBytes(12).toString("hex");
      record.credential = {
        kind: "anonymous_trial",
        capabilities: ["setup_telemetry_write"],
        apiKey: "hue_setup_test_setup-" + suffix + "_" + randomBytes(32).toString("base64url"),
        keyId: "setup-" + suffix,
        version: 0,
      };
      await exerciseSetupApplication(store, record, plan, undefined, {
        readinessMillis: 200,
        requestMillis: 200,
        evidenceMillis: 200,
        port: 9,
      });
    }
  } else throw new Error("Unknown scenario");
} catch (caught) {
  refused = true;
  error = visibleError(caught);
}
const after = await snapshot(mirror);
process.stdout.write(
  JSON.stringify({
    refused,
    error,
    entrypoint,
    probe,
    outside,
    mirrorChanged: before !== after,
  }) + "\\n",
);
`;
