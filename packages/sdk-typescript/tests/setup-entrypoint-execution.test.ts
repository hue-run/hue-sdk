import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exerciseSetupApplication,
  planSetupApplication,
  wireSetupApplication,
} from "../src/setup/application.js";
import { configureSetupProject } from "../src/setup/configure.js";
import { detectSetupProject } from "../src/setup/detect.js";
import { FileSetupInstallationStore } from "../src/setup/installation.js";
import { SetupApplicationActionRequired } from "../src/setup/application.js";

const CANARY = "placeholder-parent-env";
const ORIGIN = "https://example.test";
const roots: string[] = [];
const keyId = `setup-${"a".repeat(24)}`;
const placeholderCredential = {
  apiKey: `hue_setup_test_${keyId}_${"s".repeat(43)}`,
  keyId,
  version: 0 as const,
  kind: "anonymous_trial" as const,
  capabilities: ["setup_telemetry_write" as const],
};

afterEach(async () => {
  delete process.env.HUE_SETUP_MARKER_FILE;
  delete process.env.HUE_SETUP_PARENT_CANARY;
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readReport(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

function expressReport(kind: string): string {
  return `
const fs = process.getBuiltinModule("node:fs");
const childProcess = process.getBuiltinModule("node:child_process");
const names = fs.readdirSync(".hue").filter((name) => name.startsWith("installation-"));
const parsed = JSON.parse(fs.readFileSync(".hue/" + names[0], "utf8"));
const allowed = new Set(["PORT", "HUE_SETUP_EVIDENCE_FILE", "HUE_SETUP_SOCKET_PROOF", "HUE_SETUP_MARKER_FILE", "HUE_SETUP_PARENT_CANARY"]);
const childProcessRan = childProcess.execFileSync(process.execPath, ["-e", "process.exit(0)"]).length === 0;
fs.writeFileSync(process.env.HUE_SETUP_MARKER_FILE, JSON.stringify({
  kind: ${JSON.stringify(kind)},
  sawParentCanary: process.env.HUE_SETUP_PARENT_CANARY === ${JSON.stringify(CANARY)},
  readInstallationSecret: typeof parsed.installationSecret === "string" && parsed.installationSecret.length === 43,
  readApiKey: typeof parsed.credential?.apiKey === "string" && parsed.credential.apiKey.length > 0,
  extraEnvCount: Object.keys(process.env).filter((name) => !allowed.has(name)).length,
  childProcessRan,
}));
`;
}

function expressSource(body: string): string {
  return `import express from "express";\nconst app = express();\n${body}\napp.get("/", (request, response) => response.end("ok"));\napp.listen(Number(process.env.PORT), "127.0.0.1");\n`;
}

const expressCases: Array<[string, string]> = [
  ["builtin", expressSource(expressReport("builtin"))],
  ["function", expressSource(`Function("process", ${JSON.stringify(expressReport("function"))})(process);`)],
  [
    "fs-import",
    `import express from "express";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
const app = express();
{
  const names = readdirSync(".hue").filter((name) => name.startsWith("installation-"));
  const parsed = JSON.parse(readFileSync(".hue/" + names[0], "utf8"));
  const allowed = new Set(["PORT", "HUE_SETUP_EVIDENCE_FILE", "HUE_SETUP_SOCKET_PROOF", "HUE_SETUP_MARKER_FILE", "HUE_SETUP_PARENT_CANARY"]);
  writeFileSync(process.env.HUE_SETUP_MARKER_FILE, JSON.stringify({
    kind: "fs-import",
    sawParentCanary: process.env.HUE_SETUP_PARENT_CANARY === ${JSON.stringify(CANARY)},
    readInstallationSecret: typeof parsed.installationSecret === "string" && parsed.installationSecret.length === 43,
    readApiKey: typeof parsed.credential?.apiKey === "string" && parsed.credential.apiKey.length > 0,
    extraEnvCount: Object.keys(process.env).filter((name) => !allowed.has(name)).length,
  }));
}
app.get("/", (request, response) => response.end("ok"));
app.listen(Number(process.env.PORT), "127.0.0.1");
`,
  ],
  [
    "handler",
    `import express from "express";
const app = express();
app.get("/", (request, response) => {
  ${expressReport("handler")}
  response.end("ok");
});
app.listen(Number(process.env.PORT), "127.0.0.1");
`,
  ],
];

const flaskSource = `import os, json
from pathlib import Path
names = list(Path(".hue").glob("installation-*.json"))
parsed = json.loads(names[0].read_text())
allowed = {"PORT", "HUE_SETUP_EVIDENCE_FILE", "HUE_SETUP_SOCKET_PROOF", "HUE_SETUP_MARKER_FILE", "HUE_SETUP_PARENT_CANARY"}
Path(os.environ["HUE_SETUP_MARKER_FILE"]).write_text(json.dumps({
    "sawParentCanary": os.environ.get("HUE_SETUP_PARENT_CANARY") == ${JSON.stringify(CANARY)},
    "readInstallationSecret": isinstance(parsed.get("installationSecret"), str) and len(parsed["installationSecret"]) == 43,
    "readApiKey": isinstance((parsed.get("credential") or {}).get("apiKey"), str) and len(parsed["credential"]["apiKey"]) > 0,
    "extraEnvCount": len([name for name in os.environ if name not in allowed]),
    "systemRan": os.system("true") == 0,
    "importRan": __import__("pathlib").Path is Path,
}))
from flask import Flask
app = Flask(__name__)
@app.get("/")
def home():
    return "ok"
app.run(host="127.0.0.1", port=int(os.environ["PORT"]))
`;

async function expressProject(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hue-entrypoint-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules", "express"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      packageManager: "npm@11.0.0",
      scripts: { start: "node src/server.mjs" },
      dependencies: { express: "5.1.0" },
    }),
  );
  await writeFile(join(root, "package-lock.json"), "{}\n");
  await writeFile(
    join(root, "node_modules", "express", "package.json"),
    JSON.stringify({ name: "express", type: "module", exports: "./index.js" }),
  );
  await writeFile(
    join(root, "node_modules", "express", "index.js"),
    `import { createServer } from "node:net";
export default function express() {
  const app = {
    get() { return app; },
    listen(port, host) {
      const server = createServer((socket) => { socket.on("error", () => undefined); });
      server.listen(Number(port), host);
      return server;
    },
  };
  return app;
}
`,
  );
  await writeFile(join(root, "src", "server.mjs"), source);
  return root;
}

async function exercisePlanned(root: string, wire: boolean): Promise<unknown> {
  const marker = join(root, "leak-report.json");
  process.env.HUE_SETUP_MARKER_FILE = marker;
  process.env.HUE_SETUP_PARENT_CANARY = CANARY;
  const project = await detectSetupProject(root);
  try {
    const plan = await planSetupApplication(project);
    expect(await readReport(marker)).toBeUndefined();
    const store = new FileSetupInstallationStore(root, ORIGIN);
    const record = await store.loadOrCreate();
    record.credential = placeholderCredential;
    if (wire) {
      await configureSetupProject(store, record, project);
      await wireSetupApplication(store, record, plan);
    }
    await exerciseSetupApplication(store, record, plan, undefined, {
      readinessMillis: 1200,
      requestMillis: 400,
      evidenceMillis: 200,
    }).catch((error: unknown) => {
      if (error instanceof SetupApplicationActionRequired) throw error;
    });
  } catch (error) {
    if (!(error instanceof SetupApplicationActionRequired)) throw error;
  }
  return readReport(marker);
}

test("setup does not run express code outside the constructor, literal response, and loopback listen", async () => {
  const reports = [];
  for (const [name, source] of expressCases) {
    if (name === "handler") continue;
    reports.push({ name, report: await exercisePlanned(await expressProject(source), false) });
  }
  expect(reports).toEqual(reports.map((item) => ({ name: item.name, report: undefined })));
}, 60_000);

test("setup does not run flask code outside the constructor, literal response, and loopback run", async () => {
  const root = await mkdtemp(join(tmpdir(), "hue-entrypoint-py-"));
  roots.push(root);
  await writeFile(
    join(root, "pyproject.toml"),
    '[project]\nname = "fixture"\nversion = "0.1.0"\ndependencies = ["flask==3.1.2"]\n',
  );
  await writeFile(join(root, "uv.lock"), "version = 1\n");
  await writeFile(join(root, "app.py"), flaskSource);
  const created = spawnSync("uv", ["venv", "--python", "3.12"], { cwd: root, encoding: "utf8" });
  expect(created.status).toBe(0);
  const site = spawnSync(
    "uv",
    ["run", "--no-sync", "python", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
    { cwd: root, encoding: "utf8" },
  );
  expect(site.status).toBe(0);
  const sitePath = site.stdout.trim();
  await mkdir(join(sitePath, "flask"), { recursive: true });
  await mkdir(join(sitePath, "hue_sdk"), { recursive: true });
  await mkdir(join(sitePath, "opentelemetry"), { recursive: true });
  await mkdir(join(sitePath, "werkzeug"), { recursive: true });
  await writeFile(join(sitePath, "flask/__init__.py"), "g = None\nrequest = None\nclass Flask:\n    def __init__(self, name):\n        self.extensions = {}\n");
  await writeFile(
    join(sitePath, "hue_sdk/__init__.py"),
    "class Hue:\n    def __init__(self, api_key, base_url, service_name, capture_content):\n        if not isinstance(api_key, str) or not api_key or any(ch.isspace() for ch in api_key):\n            raise ValueError('api_key')\n",
  );
  await writeFile(join(sitePath, "opentelemetry/__init__.py"), "");
  await writeFile(
    join(sitePath, "opentelemetry/trace.py"),
    "class SpanKind:\n    SERVER = 1\ndef use_span(*args, **kwargs):\n    return None\n",
  );
  await writeFile(join(sitePath, "werkzeug/__init__.py"), "");
  await writeFile(join(sitePath, "werkzeug/serving.py"), "class WSGIRequestHandler:\n    pass\n");
  const report = await exercisePlanned(root, true);
  expect(report).toBeUndefined();
}, 60_000);
