import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exerciseSetupApplication,
  installSetupRuntime,
  planSetupApplication,
  runSetupCommand,
  type SetupCommand,
  type SetupCommandRunner,
} from "../src/setup/application.js";
import { sdkVersion } from "../src/version.js";
import { detectSetupProject } from "../src/setup/detect.js";
import { FileSetupInstallationStore } from "../src/setup/installation.js";

const OTEL_API = "1.9.1";
const OTEL_CONTEXT = "2.11.0";
const EXPRESS = "5.1.0";
const FLASK = "3.1.2";
const HUE_PYTHON = "0.2.2";

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

interface Packed {
  name: string;
  version: string;
  filename: string;
  bytes: Buffer;
  integrity: string;
  shasum: string;
}

class Origin {
  readonly requests: string[] = [];
  readonly base: string;
  private readonly server: Server;
  private readonly files = new Map<string, Buffer | string>();
  private readonly packs = new Map<string, Packed>();

  private constructor(server: Server, base: string) {
    this.server = server;
    this.base = base;
  }

  static async listen(): Promise<Origin> {
    const origin = await new Promise<Origin>((resolve, reject) => {
      const server = createServer((request, response) => {
        const pathname = decodeURIComponent(
          new URL(request.url ?? "/", "http://127.0.0.1").pathname,
        );
        origin.requests.push(`${request.method} ${pathname}`);
        const exact = origin.files.get(pathname);
        const named = [...origin.files.entries()].find(
          ([key, body]) =>
            !key.startsWith("/") && Buffer.isBuffer(body) && pathname.endsWith(`/${key}`),
        );
        const file = exact ?? named?.[1];
        if (file !== undefined) {
          response.writeHead(200, {
            "content-type":
              typeof file === "string" ? "application/json" : "application/octet-stream",
          });
          response.end(file);
          return;
        }
        const pack = origin.packs.get(pathname.replace(/^\/|\/$/gu, ""));
        if (!pack) {
          response.writeHead(404);
          response.end("missing");
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            name: pack.name,
            "dist-tags": { latest: pack.version },
            versions: {
              [pack.version]: {
                name: pack.name,
                version: pack.version,
                dist: {
                  shasum: pack.shasum,
                  integrity: pack.integrity,
                  tarball: `${origin.base}${pack.name}/-/${pack.filename}`,
                },
              },
            },
          }),
        );
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("registry port"));
          return;
        }
        resolve(new Origin(server, `http://127.0.0.1:${address.port}/`));
      });
    });
    servers.push(origin.server);
    return origin;
  }

  add(pack: Packed): void {
    this.packs.set(pack.name, pack);
    this.files.set(pack.filename, pack.bytes);
  }

  addFile(path: string, bytes: Buffer): void {
    this.files.set(path, bytes);
  }
}

function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function pack(root: string, name: string, version: string, source: string): Promise<Packed> {
  const dir = join(root, "pack", name.replaceAll("/", "-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, version, main: "index.js" }));
  await writeFile(join(dir, "index.js"), source);
  const packed = await run("npm", ["pack", "--pack-destination", root], dir);
  if (packed.code !== 0) throw new Error(packed.stderr);
  const filename = packed.stdout.trim().split("\n").at(-1);
  if (!filename) throw new Error("npm pack produced no tarball");
  const bytes = await readFile(join(root, filename));
  return {
    name,
    version,
    filename,
    bytes,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    shasum: createHash("sha1").update(bytes).digest("hex"),
  };
}

function expressSource(marker: string): string {
  return `const fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ ran: true, saw: Object.hasOwn(process.env, "HUE_PARENT_SENTINEL") }));\nfunction express() {\n  return { get() { return () => undefined; }, listen() {} };\n}\nmodule.exports = express;\nmodule.exports.default = express;\n`;
}

async function javascriptPackages(root: string, origin: Origin, marker: string): Promise<Packed[]> {
  const items = [
    await pack(root, "express", EXPRESS, expressSource(marker)),
    await pack(root, "@hue-run/sdk", sdkVersion, "export {};\n"),
    await pack(root, "@opentelemetry/api", OTEL_API, "export {};\n"),
    await pack(root, "@opentelemetry/context-async-hooks", OTEL_CONTEXT, "export {};\n"),
  ];
  for (const item of items) origin.add(item);
  return items;
}

function npmLock(items: Packed[], resolved: (item: Packed) => string): string {
  const dependencies: Record<string, string> = {};
  const packages: Record<string, unknown> = { "": { dependencies } };
  for (const item of items) {
    dependencies[item.name] = item.version;
    packages[`node_modules/${item.name}`] = {
      version: item.version,
      resolved: resolved(item),
      integrity: item.integrity,
    };
  }
  return JSON.stringify({ name: "app", lockfileVersion: 3, requires: true, packages }, null, 2);
}

function bunLock(items: Packed[], base: string): string {
  const dependencies = items
    .map((item) => `        ${JSON.stringify(item.name)}: ${JSON.stringify(item.version)},`)
    .join("\n");
  const packages = items
    .map(
      (item) =>
        `    ${JSON.stringify(item.name)}: [${JSON.stringify(`${item.name}@${item.version}`)}, ${JSON.stringify(`${base}${item.name}/-/${item.filename}`)}, {}, ${JSON.stringify(item.integrity)}],`,
    )
    .join("\n");
  return `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "dependencies": {
${dependencies}
      },
    },
  },
  "packages": {
${packages}
  }
}
`;
}

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hue-untrusted-install-"));
  directories.push(root);
  return root;
}

async function expressTree(options: {
  manager: "npm" | "bun";
  runtime: "node" | "bun";
  pinned: boolean;
}): Promise<{ root: string; marker: string }> {
  const root = await scratch();
  const marker = join(root, "attacker-ran.txt");
  await mkdir(join(root, "src"));
  const dependencies: Record<string, string> = { express: EXPRESS };
  if (options.pinned) {
    dependencies["@hue-run/sdk"] = sdkVersion;
    dependencies["@opentelemetry/api"] = OTEL_API;
    dependencies["@opentelemetry/context-async-hooks"] = OTEL_CONTEXT;
  }
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      packageManager: options.manager === "bun" ? "bun@1.4.2" : "npm@10.9.9",
      scripts: { start: `${options.runtime} src/server.mjs` },
      dependencies,
    }),
  );
  await writeFile(
    join(root, "src", "server.mjs"),
    'import express from "express";\nconst app = express();\napp.get("/", (_request, response) => response.end("business"));\napp.listen(Number(process.env.PORT), "127.0.0.1");\n',
  );
  return { root, marker };
}

function crc32(bytes: Buffer): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function u16(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

/** Minimal zip wheel. uv 0.12.5 accepts this layout and installs the recorded URL. */
function wheel(name: string, version: string, folder: string, payload: string): Buffer {
  const dist = `${name.replaceAll("-", "_")}-${version}.dist-info`;
  const entries: Array<[string, Buffer]> = [
    [`${folder}/__init__.py`, Buffer.from(payload)],
    [
      `${dist}/METADATA`,
      Buffer.from(`Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`),
    ],
    [
      `${dist}/WHEEL`,
      Buffer.from(
        "Wheel-Version: 1.0\nGenerator: hue-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
      ),
    ],
  ];
  const record = entries.map(
    ([path, body]) =>
      `${path},sha256=${createHash("sha256").update(body).digest("base64url")},${body.length}`,
  );
  record.push(`${dist}/RECORD,,`);
  entries.push([`${dist}/RECORD`, Buffer.from(`${record.join("\n")}\n`)]);
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, body] of entries) {
    const name = Buffer.from(path);
    const crc = crc32(body);
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      u32(crc),
      u32(body.length),
      u32(body.length),
      u16(name.length),
      u16(0),
      name,
      body,
    ]);
    chunks.push(local);
    central.push(
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x01, 0x02, 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        u32(crc),
        u32(body.length),
        u32(body.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    );
    offset += local.length;
  }
  const centralBytes = Buffer.concat(central);
  return Buffer.concat([
    ...chunks,
    centralBytes,
    Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]),
      u16(entries.length),
      u16(entries.length),
      u32(centralBytes.length),
      u32(offset),
      u16(0),
    ]),
  ]);
}

async function withCaches(root: string, body: () => Promise<void>): Promise<void> {
  const keys = {
    HUE_PARENT_SENTINEL: "placeholder",
    npm_config_cache: join(root, "npm-cache"),
    npm_config_fetch_retries: "0",
    npm_config_update_notifier: "false",
    BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"),
    UV_CACHE_DIR: join(root, "uv-cache"),
  };
  const previous = new Map(Object.keys(keys).map((key) => [key, process.env[key]]));
  Object.assign(process.env, keys);
  try {
    await body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function expectNoProjectCode(options: {
  root: string;
  marker: string;
  origin: Origin;
  /** Runs after installSetupRuntime has chosen its command and before that command starts. */
  beforeCommand?: (command: SetupCommand) => Promise<void>;
}): Promise<void> {
  const runner: SetupCommandRunner | undefined = options.beforeCommand
    ? async (command) => {
        await options.beforeCommand?.(command);
        await runSetupCommand(command);
      }
    : undefined;
  const started = options.origin.requests.length;
  try {
    const project = await detectSetupProject(options.root);
    const plan = await planSetupApplication(project);
    await installSetupRuntime(project, plan, runner);
    const store = new FileSetupInstallationStore(options.root, "https://example.test");
    const record = await store.loadOrCreate();
    record.credential = {
      apiKey: `hue_setup_test_setup-${"a".repeat(24)}_${"s".repeat(43)}`,
      keyId: `setup-${"a".repeat(24)}`,
      version: 0,
      kind: "anonymous_trial",
      capabilities: ["setup_telemetry_write"],
    };
    await exerciseSetupApplication(store, record, plan, undefined, {
      readinessMillis: 500,
      requestMillis: 200,
      evidenceMillis: 200,
    });
  } catch {
    /* Refusal, or an exercise that exits after importing the dependency, both land here. */
  }
  const marker = await readFile(options.marker, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  expect({ requests: options.origin.requests.slice(started), marker }).toEqual({
    requests: [],
    marker: "",
  });
}

describe("setup does not install or launch project-selected packages", () => {
  test("npm ci does not fetch a package-lock tarball outside the public registry", async () => {
    const tree = await expressTree({ manager: "npm", runtime: "node", pinned: true });
    const origin = await Origin.listen();
    const items = await javascriptPackages(tree.root, origin, tree.marker);
    await writeFile(
      join(tree.root, "package-lock.json"),
      npmLock(items, (item) => `${origin.base}${item.name}/-/${item.filename}`),
    );
    await withCaches(tree.root, () => expectNoProjectCode({ ...tree, origin }));
  }, 15000);

  test("npm ci does not fetch an npm-shrinkwrap tarball outside the public registry", async () => {
    const tree = await expressTree({ manager: "npm", runtime: "node", pinned: true });
    const origin = await Origin.listen();
    const items = await javascriptPackages(tree.root, origin, tree.marker);
    await writeFile(
      join(tree.root, "npm-shrinkwrap.json"),
      npmLock(items, (item) => `${origin.base}${item.name}/-/${item.filename}`),
    );
    await withCaches(tree.root, () => expectNoProjectCode({ ...tree, origin }));
  }, 15000);

  test("npm ci does not let a project npmrc rewrite public lockfile URLs", async () => {
    const tree = await expressTree({ manager: "npm", runtime: "node", pinned: true });
    const origin = await Origin.listen();
    const items = await javascriptPackages(tree.root, origin, tree.marker);
    await writeFile(
      join(tree.root, "package-lock.json"),
      npmLock(items, (item) => `https://registry.npmjs.org/${item.name}/-/${item.filename}`),
    );
    await writeFile(join(tree.root, ".npmrc"), `registry=${origin.base}\n`);
    await withCaches(tree.root, () => expectNoProjectCode({ ...tree, origin }));
  }, 15000);

  test("npm install does not resolve dependencies through a project npmrc", async () => {
    const tree = await expressTree({ manager: "npm", runtime: "node", pinned: false });
    const origin = await Origin.listen();
    await javascriptPackages(tree.root, origin, tree.marker);
    await writeFile(join(tree.root, ".npmrc"), `registry=${origin.base}\n`);
    await withCaches(tree.root, () => expectNoProjectCode({ ...tree, origin }));
  }, 15000);

  test("npm still ignores a lockfile and npmrc swapped after setup reads them", async () => {
    const tree = await expressTree({ manager: "npm", runtime: "node", pinned: true });
    const origin = await Origin.listen();
    const items = await javascriptPackages(tree.root, origin, tree.marker);
    const lockPath = join(tree.root, "package-lock.json");
    await writeFile(
      lockPath,
      npmLock(items, (item) => `https://registry.npmjs.org/${item.name}/-/${item.filename}`),
    );
    await withCaches(tree.root, () =>
      expectNoProjectCode({
        ...tree,
        origin,
        beforeCommand: async () => {
          await writeFile(
            lockPath,
            npmLock(items, (item) => `${origin.base}${item.name}/-/${item.filename}`),
          );
          await writeFile(join(tree.root, ".npmrc"), `registry=${origin.base}\n`);
        },
      }),
    );
  }, 15000);

  test("bun add does not install through a project bunfig registry", async () => {
    const tree = await expressTree({ manager: "bun", runtime: "node", pinned: false });
    const origin = await Origin.listen();
    await javascriptPackages(tree.root, origin, tree.marker);
    await writeFile(join(tree.root, "bunfig.toml"), `[install]\nregistry = "${origin.base}"\n`);
    await withCaches(tree.root, () => expectNoProjectCode({ ...tree, origin }));
  }, 15000);

  test("bun install --frozen-lockfile does not fetch lockfile tarball URLs", async () => {
    const tree = await expressTree({ manager: "bun", runtime: "bun", pinned: true });
    const origin = await Origin.listen();
    const items = await javascriptPackages(tree.root, origin, tree.marker);
    await writeFile(join(tree.root, "bun.lock"), bunLock(items, origin.base));
    await withCaches(tree.root, () => expectNoProjectCode({ ...tree, origin }));
  }, 15000);

  test("bun still ignores a bunfig swapped after the registry check", async () => {
    const tree = await expressTree({ manager: "bun", runtime: "node", pinned: false });
    const origin = await Origin.listen();
    await javascriptPackages(tree.root, origin, tree.marker);
    const config = join(tree.root, "bunfig.toml");
    await writeFile(config, '[install]\nregistry = "https://registry.npmjs.org/"\n');
    await withCaches(tree.root, () =>
      expectNoProjectCode({
        ...tree,
        origin,
        beforeCommand: () => writeFile(config, `[install]\nregistry = "${origin.base}"\n`),
      }),
    );
  }, 15000);

  test("uv sync --locked does not download a wheel URL outside the official index", async () => {
    const root = await scratch();
    const marker = join(root, "attacker-ran.txt");
    const origin = await Origin.listen();
    const flask = wheel(
      "flask",
      FLASK,
      "flask",
      `import json, os\nfrom pathlib import Path\nPath(${JSON.stringify(marker)}).write_text(json.dumps({"ran": True, "saw": "HUE_PARENT_SENTINEL" in os.environ}))\nclass Flask:\n    def __init__(self, *args, **kwargs):\n        pass\n    def get(self, *args, **kwargs):\n        return lambda fn: fn\n    def run(self, *args, **kwargs):\n        pass\n`,
    );
    const hue = wheel("hue-run", HUE_PYTHON, "hue_run", "");
    origin.addFile("/wheels/flask-3.1.2-py3-none-any.whl", flask);
    origin.addFile("/wheels/hue_run-0.2.2-py3-none-any.whl", hue);
    await writeFile(
      join(root, "pyproject.toml"),
      `[project]\nname = "fixture"\nversion = "0.1.0"\nrequires-python = ">=3.10"\ndependencies = ["flask==${FLASK}", "hue-run==${HUE_PYTHON}"]\n`,
    );
    await writeFile(
      join(root, "app.py"),
      'import os\nfrom flask import Flask\napp = Flask(__name__)\n@app.get("/")\ndef home():\n    return "business"\napp.run(host="127.0.0.1", port=int(os.environ["PORT"]))\n',
    );
    const flaskHash = createHash("sha256").update(flask).digest("hex");
    const hueHash = createHash("sha256").update(hue).digest("hex");
    await writeFile(
      join(root, "uv.lock"),
      `version = 1
revision = 3
requires-python = ">=3.10"

[[package]]
name = "fixture"
version = "0.1.0"
source = { virtual = "." }
dependencies = [
    { name = "flask" },
    { name = "hue-run" },
]

[package.metadata]
requires-dist = [
    { name = "flask", specifier = "==${FLASK}" },
    { name = "hue-run", specifier = "==${HUE_PYTHON}" },
]

[[package]]
name = "flask"
version = "${FLASK}"
source = { registry = "https://pypi.org/simple" }
wheels = [
    { url = "${origin.base}wheels/flask-3.1.2-py3-none-any.whl", hash = "sha256:${flaskHash}" },
]

[[package]]
name = "hue-run"
version = "${HUE_PYTHON}"
source = { registry = "https://pypi.org/simple" }
wheels = [
    { url = "${origin.base}wheels/hue_run-0.2.2-py3-none-any.whl", hash = "sha256:${hueHash}" },
]
`,
    );
    await withCaches(root, () => expectNoProjectCode({ root, marker, origin }));
  }, 15000);
});
