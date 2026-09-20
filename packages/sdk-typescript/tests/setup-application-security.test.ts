import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exerciseSetupApplication,
  installSetupRuntime,
  planSetupApplication,
  wireSetupApplication,
  type SetupCommand,
} from "../src/setup/application.js";
import { detectSetupProject } from "../src/setup/detect.js";
import { FileSetupInstallationStore } from "../src/setup/installation.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hue-application-security-"));
  directories.push(path);
  return path;
}

const expressSource = (route = "/") =>
  `import express from "express";\nconst app = express();\napp.get(${JSON.stringify(route)}, (_request, response) => response.end("business"));\napp.listen(Number(process.env.PORT), "127.0.0.1");\n`;
const flaskSource = (route = "/") =>
  `import os\nfrom flask import Flask\napp = Flask(__name__)\n@app.get(${JSON.stringify(route)})\ndef home():\n    return "business"\napp.run(host="127.0.0.1", port=int(os.environ["PORT"]))\n`;

async function expressProject(
  options: { bun?: boolean; pinned?: boolean; route?: string } = {},
): Promise<string> {
  const root = await directory();
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      packageManager: options.bun ? "bun@1.4.2" : "npm@11.0.0",
      scripts: { start: `${options.bun ? "bun" : "node"} src/server.mjs` },
      dependencies: { express: "5.1.0", ...(options.pinned ? { "@hue-run/sdk": "0.4.0" } : {}) },
    }),
  );
  await writeFile(join(root, options.bun ? "bun.lock" : "package-lock.json"), "{}\n");
  await writeFile(join(root, "src", "server.mjs"), expressSource(options.route));
  return root;
}

async function flaskProject(options: { manifest?: string; source?: string } = {}): Promise<string> {
  const root = await directory();
  await writeFile(
    join(root, "pyproject.toml"),
    options.manifest ??
      '[project]\nname = "fixture"\nversion = "0.1.0"\ndependencies = ["flask==3.1.2"]\n',
  );
  await writeFile(join(root, "uv.lock"), "version = 1\n");
  await writeFile(join(root, "app.py"), options.source ?? flaskSource());
  return root;
}

async function expectNoSetupFiles(root: string): Promise<void> {
  await expect(lstat(join(root, ".hue"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(join(root, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
}

describe("application request containment", () => {
  test("rejects network paths, escaping, normalized paths and dynamic segments before mutation", async () => {
    for (const route of [
      "//127.0.0.1:1/",
      "/\\host/path",
      "/../outside",
      "/a/./b",
      "/%2f%2fhost",
      "/users/:id",
      "/users/<id>",
      "/path?query=1",
      "/path#fragment",
    ]) {
      for (const language of ["typescript", "python"]) {
        const root =
          language === "typescript"
            ? await expressProject({ route })
            : await flaskProject({ source: flaskSource(route) });
        await expect(planSetupApplication(await detectSetupProject(root))).rejects.toMatchObject({
          code: "ambiguous-entrypoint",
        });
        await expectNoSetupFiles(root);
      }
    }
  });

  test("accepts one unchanged literal pathname and refuses concatenation or multiple routes", async () => {
    const root = await expressProject({ route: "/health-check/v1" });
    expect((await planSetupApplication(await detectSetupProject(root))).requestPath).toBe(
      "/health-check/v1",
    );
    for (const source of [
      expressSource().replace('app.get("/",', 'app.get("/" + process.env.ROUTE,'),
      expressSource() + 'app.get("/other", (_request, response) => response.end());\n',
    ]) {
      await writeFile(join(root, "src", "server.mjs"), source);
      await expect(planSetupApplication(await detectSetupProject(root))).rejects.toMatchObject({
        code: "ambiguous-entrypoint",
      });
    }
  });

  test("rejects a tampered plan before saving an attempt or launching any process", async () => {
    const root = await expressProject();
    const plan = await planSetupApplication(await detectSetupProject(root));
    const store = new FileSetupInstallationStore(root, "https://example.test");
    const record = await store.loadOrCreate();
    record.credential = {
      apiKey: `hue_setup_test_setup-${"a".repeat(24)}_${"s".repeat(43)}`,
      keyId: `setup-${"a".repeat(24)}`,
      version: 0,
      kind: "anonymous_trial",
      capabilities: ["setup_telemetry_write"],
    };
    const original = await readFile(store.path, "utf8");
    await expect(
      exerciseSetupApplication(store, record, { ...plan, requestPath: "//127.0.0.1:1/" }),
    ).rejects.toMatchObject({ code: "ambiguous-entrypoint" });
    expect(await readFile(store.path, "utf8")).toBe(original);
    expect(record.applicationAttempt).toBeUndefined();
  });
});

describe("application source preservation", () => {
  test("refuses symlink ancestors both while planning and after a directory swap", async () => {
    const root = await expressProject();
    const outside = await directory();
    await writeFile(join(outside, "server.mjs"), expressSource());
    const plan = await planSetupApplication(await detectSetupProject(root));
    await rename(join(root, "src"), join(root, "original-src"));
    await symlink(outside, join(root, "src"));
    await expect(planSetupApplication(await detectSetupProject(root))).rejects.toMatchObject({
      code: "custom-instrumentation",
    });
    const store = new FileSetupInstallationStore(root, "https://example.test");
    const record = await store.loadOrCreate();
    await expect(wireSetupApplication(store, record, plan)).rejects.toMatchObject({
      code: "custom-instrumentation",
    });
    expect(await readFile(join(outside, "server.mjs"), "utf8")).toBe(expressSource());
    expect(await readFile(join(root, "original-src", "server.mjs"), "utf8")).toBe(expressSource());
  });

  test("refuses JS shebang and commented Python string prologues without changing sources", async () => {
    const root = await expressProject();
    const entrypoint = join(root, "src", "server.mjs");
    const shebang = "#!/usr/bin/env node\n" + expressSource();
    await writeFile(entrypoint, shebang);
    await expect(planSetupApplication(await detectSetupProject(root))).rejects.toMatchObject({
      code: "ambiguous-entrypoint",
    });
    expect(await readFile(entrypoint, "utf8")).toBe(shebang);
    for (const prologue of [
      "# comment\n'module docs'\n",
      '# comment\n"module docs"\n',
      '# comment\n\n"""module docs"""\n',
      "# comment\n'''module docs'''\n",
      "# comment\nfrom __future__ import annotations\n",
      "# comment\n# coding: latin-1\n",
    ]) {
      const source = prologue + flaskSource();
      const python = await flaskProject({ source });
      await expect(planSetupApplication(await detectSetupProject(python))).rejects.toMatchObject({
        code: "ambiguous-entrypoint",
      });
      expect(await readFile(join(python, "app.py"), "utf8")).toBe(source);
      await expectNoSetupFiles(python);
    }
  });

  test("validates managed block content and placement in read-only planning", async () => {
    const root = await expressProject();
    const plan = await planSetupApplication(await detectSetupProject(root));
    const store = new FileSetupInstallationStore(root, "https://example.test");
    const record = await store.loadOrCreate();
    const entrypoint = join(root, "src", "server.mjs");
    await chmod(entrypoint, 0o750);
    await wireSetupApplication(store, record, plan);
    expect((await lstat(entrypoint)).mode & 0o777).toBe(0o750);
    const wired = await readFile(entrypoint, "utf8");
    expect((await planSetupApplication(await detectSetupProject(root))).requestPath).toBe("/");
    for (const changed of [
      wired.replace("installHueExpress(app);", "installHueExpress(otherApp);"),
      wired.replace(
        "installHueExpress(app);",
        "installHueExpress(app);\napp.disable('x-powered-by');",
      ),
      "// moved header\n" + wired,
    ]) {
      await writeFile(entrypoint, changed);
      await expect(planSetupApplication(await detectSetupProject(root))).rejects.toMatchObject({
        code: "custom-instrumentation",
      });
      expect(await readFile(entrypoint, "utf8")).toBe(changed);
    }
  });
});

describe("runtime installation and invocation", () => {
  test("npm and Bun workspace members refuse before the manager can rewrite an ancestor lock", async () => {
    for (const bun of [false, true]) {
      const workspace = await directory();
      const independent = await expressProject({ bun });
      await mkdir(join(workspace, "packages"));
      await writeFile(
        join(workspace, "package.json"),
        JSON.stringify({ private: true, workspaces: ["packages/*"] }),
      );
      const lock = join(workspace, bun ? "bun.lock" : "package-lock.json");
      await writeFile(lock, "preserve-parent-lock\n");
      const root = join(workspace, "packages", "app");
      await rename(independent, root);
      await expect(planSetupApplication(await detectSetupProject(root))).rejects.toMatchObject({
        code: "ambiguous-project",
      });
      expect(await readFile(lock, "utf8")).toBe("preserve-parent-lock\n");
      await expectNoSetupFiles(root);
      await expectNoSetupFiles(workspace);
    }
  });

  test("malformed and custom Hue declarations are rejected by read-only preflight", async () => {
    const root = await expressProject();
    const manifestPath = join(root, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const dependency of [null, false, 4, {}, ["0.4.0"], "^0.4.0", "0.3.2"]) {
      manifest.dependencies["@hue-run/sdk"] = dependency;
      await writeFile(manifestPath, JSON.stringify(manifest));
      await expect(planSetupApplication(await detectSetupProject(root))).rejects.toMatchObject({
        code: "custom-instrumentation",
      });
      await expectNoSetupFiles(root);
      expect(JSON.parse(await readFile(manifestPath, "utf8")).dependencies["@hue-run/sdk"]).toEqual(
        dependency,
      );
    }
  });

  test("detects pure JavaScript and preserves the explicit Bun start runtime", async () => {
    const root = await expressProject({ bun: true });
    const detected = await detectSetupProject(root);
    expect(detected.languages).toEqual(["typescript"]);
    expect(await planSetupApplication(detected)).toMatchObject({ runtime: "bun", manager: "bun" });
  });

  test("already pinned npm and Bun dependencies still run their frozen installer", async () => {
    for (const bun of [false, true]) {
      const root = await expressProject({ bun, pinned: true });
      const project = await detectSetupProject(root);
      const calls: SetupCommand[] = [];
      expect(
        await installSetupRuntime(project, await planSetupApplication(project), async (command) => {
          calls.push(command);
        }),
      ).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.command).toBe(bun ? "bun" : "npm");
      expect(calls[0]!.args).toEqual(
        bun
          ? ["install", "--frozen-lockfile", "--ignore-scripts"]
          : ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      );
      await expect(lstat(join(root, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test("comments cannot masquerade as installed Hue and uv operations never build", async () => {
    const root = await flaskProject({
      manifest:
        '# hue-run==0.2.2 is not a dependency\n[project]\nname = "fixture"\nversion = "0.1.0"\ndependencies = [\n "flask==3.1.2", # preserved project comment\n]\n',
    });
    const project = await detectSetupProject(root);
    const calls: SetupCommand[] = [];
    await installSetupRuntime(project, await planSetupApplication(project), async (command) => {
      calls.push(command);
      if (command.args[0] === "add")
        await writeFile(
          join(root, "pyproject.toml"),
          '[project]\nname = "fixture"\nversion = "0.1.0"\ndependencies = ["flask==3.1.2", "hue-run==0.2.2"]\n',
        );
    });
    expect(calls.map((command) => command.args)).toEqual([
      ["add", "--no-build", "--no-sync", "hue-run==0.2.2"],
      ["sync", "--locked", "--no-build", "--no-install-project", "--no-default-groups"],
    ]);
    calls.length = 0;
    await installSetupRuntime(project, await planSetupApplication(project), async (command) => {
      calls.push(command);
    });
    expect(calls.map((command) => command.args[0])).toEqual(["sync"]);
  });

  test("Python ranges, extras, sources, build hooks and workspaces refuse before manager or state", async () => {
    const manifests = [
      ...[
        "hue-run>=0.2.2",
        "hue_run~=0.2.2",
        "hue-run @ https://example.test/runtime.whl",
        "hue-run[evals]==0.2.2",
        "hue-run==0.2.2; python_version > '3.10'",
      ].map(
        (dependency) =>
          `[project]\nname = "fixture"\ndependencies = ["flask==3.1.2", ${JSON.stringify(dependency)}]\n`,
      ),
      '[project]\nname = "fixture"\ndependencies = ["flask==3.1.2"]\n[build-system]\nrequires = []\nbuild-backend = "dangerous.backend"\n',
      '[project]\nname = "fixture"\ndependencies = ["flask==3.1.2"]\n[tool.uv.workspace]\nmembers = ["packages/*"]\n',
      '[project]\nname = "fixture"\ndependencies = ["flask==3.1.2", "hue-run==0.2.2"]\n[tool.uv.sources]\nhue-run = {path = "../custom"}\n',
    ];
    for (const manifest of manifests) {
      const root = await flaskProject({ manifest });
      await expect(planSetupApplication(await detectSetupProject(root))).rejects.toMatchObject({
        code: "custom-instrumentation",
      });
      await expectNoSetupFiles(root);
      expect(await readFile(join(root, "pyproject.toml"), "utf8")).toBe(manifest);
    }
  });

  test("executes the Bun runtime and never replays the business route after evidence failure", async () => {
    const root = await expressProject({ bun: true });
    const plan = await planSetupApplication(await detectSetupProject(root));
    await writeFile(
      join(root, "src", "server.mjs"),
      'import { appendFileSync } from "node:fs";\nimport { createServer } from "node:http";\ncreateServer((_request, response) => { appendFileSync("handler-count.txt", process.versions.bun ? "B" : "N"); response.statusCode = 503; response.end(); }).listen(Number(process.env.PORT), "127.0.0.1");\n',
    );
    const store = new FileSetupInstallationStore(root, "https://example.test");
    const record = await store.loadOrCreate();
    record.credential = {
      apiKey: `hue_setup_test_setup-${"a".repeat(24)}_${"s".repeat(43)}`,
      keyId: `setup-${"a".repeat(24)}`,
      version: 0,
      kind: "anonymous_trial",
      capabilities: ["setup_telemetry_write"],
    };
    const deadlines = { readinessMillis: 3000, requestMillis: 1000, evidenceMillis: 20 };
    await expect(
      exerciseSetupApplication(store, record, plan, undefined, deadlines),
    ).rejects.toThrow("did not produce");
    expect(await readFile(join(root, "handler-count.txt"), "utf8")).toBe("B");
    record.credential!.version = 1;
    await expect(
      exerciseSetupApplication(store, record, plan, undefined, deadlines),
    ).rejects.toMatchObject({ code: "custom-instrumentation" });
    expect(await readFile(join(root, "handler-count.txt"), "utf8")).toBe("B");
  });
});
