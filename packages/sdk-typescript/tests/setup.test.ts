import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { Ajv2020 } from "ajv/dist/2020.js";
import protobuf from "protobufjs/light.js";
import { SetupBackendAdapter } from "../src/setup/backend.js";
import {
  installSetupRuntime,
  exerciseSetupApplication,
  planSetupApplication,
  SetupApplicationActionRequired,
  wireSetupApplication,
} from "../src/setup/application.js";
import { configureSetupProject } from "../src/setup/configure.js";
import { FileSetupInstallationStore } from "../src/setup/installation.js";
import { FileSetupCheckpointAdapter, setupRunId } from "../src/setup/checkpoint.js";
import { detectSetupProject } from "../src/setup/detect.js";
import {
  createInitialSetupState,
  transitionSetup,
  type SetupMachineState,
} from "../src/setup/machine.js";
import {
  renderHumanEvent,
  renderJsonlEvent,
  renderPlainEvent,
  selectSetupOutputMode,
} from "../src/setup/render.js";
import { runSetup, type SetupCheckpointAdapter } from "../src/setup/runner.js";
import {
  SETUP_EVENT_CONTRACT_VERSION,
  type SetupEvent,
  type SetupProjectDetection,
} from "../src/setup/types.js";
import otlpSchema from "./fixtures/otlp-schema.json" with { type: "json" };

const syntheticCredential = (version: 0 | 1 = 0) => ({
  apiKey: `hue_setup_test_setup-${String(version + 1).repeat(24)}_${"s".repeat(43)}`,
  keyId: `setup-${String(version + 1).repeat(24)}`,
  version,
  kind: "anonymous_trial" as const,
  capabilities: ["setup_telemetry_write"] as ["setup_telemetry_write"],
});

const instant = () => new Date("2026-09-19T12:00:00.000Z");
const detection = (root: string): SetupProjectDetection => ({
  root,
  fingerprint: "a".repeat(64),
  languages: ["typescript", "python"],
  packageManagers: ["bun", "uv"],
  frameworks: ["nextjs", "fastapi"],
  hue: "multiple",
  openTelemetry: "multiple",
});

async function writeExpressProject(root: string, runtime = false): Promise<void> {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      scripts: { start: "node src/server.mjs" },
      dependencies: { express: "5.1.0", "@hue-run/sdk": "0.4.0" },
      devDependencies: { typescript: "7.0.2" },
    }),
  );
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
  await writeFile(
    join(root, "src", "server.mjs"),
    `${runtime ? `import { appendFileSync } from "node:fs";\n` : ""}import express from "express";\nconst app = express();\napp.get("/", (_request, response) => {${runtime ? ` appendFileSync(${JSON.stringify(join(root, "handler-count.txt"))}, "1");` : ""} response.end("ok"); });\napp.listen(Number(process.env.PORT), "127.0.0.1");\n`,
  );
  if (!runtime) return;
  const express = join(root, "node_modules", "express");
  const hue = join(root, "node_modules", "@hue-run");
  await mkdir(express, { recursive: true });
  await mkdir(hue, { recursive: true });
  await writeFile(
    join(express, "package.json"),
    JSON.stringify({ name: "express", version: "5.1.0", type: "module", exports: "./index.js" }),
  );
  await writeFile(
    join(express, "index.js"),
    `import { createServer } from "node:http";\nexport default function express(){const middleware=[];const routes=new Map();const app=(request,response)=>{let index=0;const next=()=>{const item=middleware[index++];if(item)return item(request,response,next);const handler=routes.get(request.method+" "+new URL(request.url,"http://localhost").pathname);if(handler)return handler(request,response);response.statusCode=404;response.end();};next();};app.use=(value)=>middleware.push(value);app.get=(path,value)=>routes.set("GET "+path,value);app.listen=(port,host)=>createServer(app).listen(port,host);return app;}\n`,
  );
  await symlink(
    resolve(dirname(import.meta.dir)),
    join(hue, "sdk"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

class MemoryCheckpoints implements SetupCheckpointAdapter {
  state?: SetupMachineState;
  async load(): Promise<SetupMachineState | undefined> {
    return this.state;
  }
  async save(state: SetupMachineState): Promise<void> {
    this.state = structuredClone(state);
  }
}

describe("setup state machine", () => {
  test("is pure and produces a deterministic local plan", () => {
    const initial = createInitialSetupState("setup_test", "/project");
    const first = transitionSetup(initial, { type: "start" });
    expect(first).toEqual({
      state: { format: 1, phase: "detecting", runId: "setup_test", projectRoot: "/project" },
      events: [{ event: "step.started", step: "detect-project" }],
      effect: { type: "detect-project", root: "/project" },
    });
    const second = transitionSetup(first.state, {
      type: "project.detected",
      project: detection("/project"),
    });
    expect(second.state.phase).toBe("local-ready");
    expect(second.events.map((event) => event.event)).toEqual([
      "project.detected",
      "step.completed",
      "plan.ready",
    ]);
    expect(
      (second.state as Extract<SetupMachineState, { phase: "local-ready" }>).plan.mutatesProject,
    ).toBe(true);
    expect(
      (second.state as Extract<SetupMachineState, { phase: "local-ready" }>).plan.steps,
    ).toEqual([
      "detect-project",
      "install-runtime",
      "configure-telemetry",
      "verify-application-receipt",
      "claim-project",
    ]);
  });

  test("rejects out-of-order inputs", () => {
    expect(() =>
      transitionSetup(createInitialSetupState("setup_test", "/project"), {
        type: "project.detected",
        project: detection("/project"),
      }),
    ).toThrow("Invalid setup transition");
  });
});

describe("project detection", () => {
  test("reads manifests without executing package scripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "hue-setup-detect-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        scripts: { postinstall: "exit 99" },
        dependencies: {
          "@hue-run/sdk": "0.3.0",
          "@opentelemetry/api": "1.9.0",
          next: "16.0.0",
          ai: "7.0.0",
        },
        devDependencies: { typescript: "5.9.0" },
      }),
    );
    await writeFile(join(root, "bun.lock"), "synthetic lock");
    await writeFile(
      join(root, "pyproject.toml"),
      '[project]\ndependencies = ["hue-run", "opentelemetry-sdk", "fastapi"]\n',
    );
    await writeFile(join(root, "uv.lock"), "synthetic lock");
    const result = await detectSetupProject(root);
    expect(result).toMatchObject({
      languages: ["typescript", "python"],
      packageManagers: ["bun", "uv"],
      frameworks: ["nextjs", "fastapi", "vercel-ai-sdk"],
      hue: "multiple",
      openTelemetry: "multiple",
    });
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("does not infer AI SDK from descriptions or scripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "hue-setup-detect-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        description: "an AI application",
        scripts: { test: "echo @ai-sdk/openai" },
      }),
    );
    expect((await detectSetupProject(root)).frameworks).toEqual([]);
  });
});

describe("supported application matrix", () => {
  test("selects one Express package and fails closed at an ambiguous workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "hue-setup-express-plan-"));
    await writeExpressProject(root);
    const project = await detectSetupProject(root);
    expect(await planSetupApplication(project)).toMatchObject({
      language: "typescript",
      manager: "npm",
      framework: "express",
      entrypoint: "src/server.mjs",
      requestPath: "/",
    });
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    manifest.workspaces = ["packages/*"];
    await writeFile(join(root, "package.json"), JSON.stringify(manifest));
    await expect(planSetupApplication(await detectSetupProject(root))).rejects.toMatchObject({
      code: "ambiguous-project",
    });
    delete manifest.workspaces;
    await writeFile(join(root, "package.json"), JSON.stringify(manifest));
    await writeFile(join(root, "turbo.json"), "{}\n");
    await expect(planSetupApplication(await detectSetupProject(root))).rejects.toMatchObject({
      code: "ambiguous-project",
    });
  });

  test("uses exact manager argv and never replaces a custom runtime version", async () => {
    const root = await mkdtemp(join(tmpdir(), "hue-setup-install-"));
    await writeExpressProject(root);
    const manifestPath = join(root, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.dependencies["@hue-run/sdk"];
    await writeFile(manifestPath, JSON.stringify(manifest));
    const project = await detectSetupProject(root);
    const plan = await planSetupApplication(project);
    const commands: Array<{ command: string; args: string[] }> = [];
    expect(
      await installSetupRuntime(project, plan, async (command) => {
        commands.push(command);
        const updated = JSON.parse(await readFile(manifestPath, "utf8"));
        updated.dependencies["@hue-run/sdk"] = "0.4.0";
        await writeFile(manifestPath, JSON.stringify(updated));
      }),
    ).toBe(true);
    expect(commands).toEqual([
      expect.objectContaining({
        command: "npm",
        args: [
          "install",
          "--save-exact",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "@hue-run/sdk@0.4.0",
        ],
      }),
    ]);
    expect(await installSetupRuntime(project, plan, async () => {})).toBe(true);
    const custom = JSON.parse(await readFile(manifestPath, "utf8"));
    custom.dependencies["@hue-run/sdk"] = "0.3.2";
    await writeFile(manifestPath, JSON.stringify(custom));
    await expect(installSetupRuntime(project, plan, async () => {})).rejects.toBeInstanceOf(
      SetupApplicationActionRequired,
    );
  });

  test("uses Bun and uv directly with fixed argv for their supported fixtures", async () => {
    const bunRoot = await mkdtemp(join(tmpdir(), "hue-setup-bun-install-"));
    await writeExpressProject(bunRoot);
    await import("node:fs/promises").then(({ unlink }) =>
      unlink(join(bunRoot, "package-lock.json")),
    );
    await writeFile(join(bunRoot, "bun.lock"), "synthetic\n");
    const bunManifestPath = join(bunRoot, "package.json");
    const bunManifest = JSON.parse(await readFile(bunManifestPath, "utf8"));
    delete bunManifest.dependencies["@hue-run/sdk"];
    await writeFile(bunManifestPath, JSON.stringify(bunManifest));
    const bunProject = await detectSetupProject(bunRoot);
    const bunPlan = await planSetupApplication(bunProject);
    let bunCommand;
    await installSetupRuntime(bunProject, bunPlan, async (command) => {
      bunCommand = command;
      const updated = JSON.parse(await readFile(bunManifestPath, "utf8"));
      updated.dependencies["@hue-run/sdk"] = "0.4.0";
      await writeFile(bunManifestPath, JSON.stringify(updated));
    });
    expect(bunCommand).toMatchObject({
      command: "bun",
      args: ["add", "--exact", "--ignore-scripts", "@hue-run/sdk@0.4.0"],
    });

    const pythonRoot = await mkdtemp(join(tmpdir(), "hue-setup-uv-install-"));
    const pyproject = join(pythonRoot, "pyproject.toml");
    await writeFile(pyproject, '[project]\nname = "setup-test"\ndependencies = ["flask==3.1.2"]\n');
    await writeFile(join(pythonRoot, "uv.lock"), "version = 1\n");
    await writeFile(
      join(pythonRoot, "app.py"),
      'import os\nfrom flask import Flask\napp = Flask(__name__)\n@app.get("/")\ndef home(): return "ok"\napp.run(port=int(os.environ["PORT"]))\n',
    );
    const pythonProject = await detectSetupProject(pythonRoot);
    const pythonPlan = await planSetupApplication(pythonProject);
    let uvCommand;
    await installSetupRuntime(pythonProject, pythonPlan, async (command) => {
      uvCommand = command;
      await writeFile(
        pyproject,
        '[project]\nname = "setup-test"\ndependencies = ["flask==3.1.2", "hue-run==0.2.2"]\n',
      );
    });
    expect(uvCommand).toMatchObject({
      command: "uv",
      args: ["sync", "--locked", "--no-build", "--no-install-project", "--no-default-groups"],
    });
  });

  test("wires a supported Flask app idempotently without changing its business route", async () => {
    const root = await mkdtemp(join(tmpdir(), "hue-setup-flask-plan-"));
    const original = `import os\nfrom flask import Flask\n\napp = Flask(__name__)\n\n@app.get("/")\ndef home():\n    return "business-response"\n\nif __name__ == "__main__":\n    app.run(host="127.0.0.1", port=int(os.environ["PORT"]))\n`;
    await writeFile(
      join(root, "pyproject.toml"),
      '[project]\nname = "setup-test"\ndependencies = ["flask==3.1.2", "hue-run==0.2.2"]\n',
    );
    await writeFile(join(root, "uv.lock"), "version = 1\n");
    await writeFile(join(root, "app.py"), original);
    const project = await detectSetupProject(root);
    const plan = await planSetupApplication(project);
    expect(plan).toMatchObject({ language: "python", manager: "uv", framework: "flask" });
    expect(await installSetupRuntime(project, plan, async () => {})).toBe(true);
    const store = new FileSetupInstallationStore(root, "https://example.test");
    const record = await store.loadOrCreate();
    await chmod(join(root, "app.py"), 0o750);
    const first = await wireSetupApplication(store, record, plan);
    expect(first).toEqual({ path: "app.py", change: "updated" });
    const wired = await readFile(join(root, "app.py"), "utf8");
    expect(wired).toContain('return "business-response"');
    expect(wired.match(/Hue setup instrumentation \(managed; do not edit\)/gu)).toHaveLength(2);
    expect((await lstat(join(root, "app.py"))).mode & 0o777).toBe(0o750);
    expect(await wireSetupApplication(store, record, plan)).toBeUndefined();
  });

  test("fails closed on protected Python prologues and entrypoint changes after planning", async () => {
    for (const prologue of [
      "#!/usr/bin/env python3\n",
      "# -*- coding: utf-8 -*-\n",
      '"""module documentation"""\n',
      "from __future__ import annotations\n",
    ]) {
      const root = await mkdtemp(join(tmpdir(), "hue-setup-python-prologue-"));
      await writeFile(
        join(root, "pyproject.toml"),
        '[project]\nname = "setup-test"\ndependencies = ["flask==3.1.2"]\n',
      );
      await writeFile(join(root, "uv.lock"), "version = 1\n");
      await writeFile(
        join(root, "app.py"),
        `${prologue}import os\nfrom flask import Flask\napp = Flask(__name__)\n@app.get("/")\ndef home(): return "ok"\napp.run(port=int(os.environ["PORT"]))\n`,
      );
      await expect(planSetupApplication(await detectSetupProject(root))).rejects.toMatchObject({
        code: "ambiguous-entrypoint",
      });
    }

    const root = await mkdtemp(join(tmpdir(), "hue-setup-concurrent-edit-"));
    await writeExpressProject(root);
    const plan = await planSetupApplication(await detectSetupProject(root));
    const entry = join(root, "src", "server.mjs");
    const changed = `${await readFile(entry, "utf8")}\n// user concurrent edit\n`;
    await writeFile(entry, changed);
    const store = new FileSetupInstallationStore(root, "https://example.test");
    const record = await store.loadOrCreate();
    await expect(wireSetupApplication(store, record, plan)).rejects.toMatchObject({
      code: "custom-instrumentation",
    });
    expect(await readFile(entry, "utf8")).toBe(changed);
  });

  test("waits on TCP then invokes a failing business route exactly once without evidence replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "hue-setup-exact-once-"));
    const countPath = join(root, "count.txt");
    await writeFile(
      join(root, "server.mjs"),
      `import { appendFileSync } from "node:fs";\nimport { createServer } from "node:http";\nsetTimeout(() => createServer((_request, response) => { appendFileSync(${JSON.stringify(countPath)}, "1"); response.statusCode = 503; response.end("not ready"); }).listen(Number(process.env.PORT), "127.0.0.1"), 150);\n`,
    );
    const store = new FileSetupInstallationStore(root, "https://example.test");
    const record = await store.loadOrCreate();
    record.credential = syntheticCredential();
    await store.save(record);
    const plan = {
      language: "typescript" as const,
      manager: "npm" as const,
      framework: "express" as const,
      entrypoint: "server.mjs",
      requestPath: "/",
      entryDigest: "a".repeat(64),
    };
    await expect(
      exerciseSetupApplication(store, record, plan, undefined, {
        readinessMillis: 1000,
        requestMillis: 1000,
        evidenceMillis: 200,
      }),
    ).rejects.toThrow("evidence");
    expect(await readFile(countPath, "utf8")).toBe("1");
    await expect(
      exerciseSetupApplication(store, record, plan, undefined, {
        readinessMillis: 1000,
        requestMillis: 1000,
        evidenceMillis: 200,
      }),
    ).rejects.toMatchObject({ code: "custom-instrumentation" });
    expect(await readFile(countPath, "utf8")).toBe("1");
  });
});

describe("runner and checkpoints", () => {
  test("emits one terminal event and resumes idempotently", async () => {
    const checkpoints = new MemoryCheckpoints();
    const events: SetupEvent[] = [];
    let detections = 0;
    const options = {
      mode: "jsonl" as const,
      runId: "setup_test",
      projectRoot: "/project",
      checkpoints,
      project: {
        detect: async () => {
          detections += 1;
          return detection("/project");
        },
      },
      now: instant,
      emit: (event: SetupEvent) => {
        events.push(event);
      },
    };
    await runSetup({ ...options, command: "setup" });
    expect(
      events.filter((event) => event.event === "run.completed" || event.event === "run.failed"),
    ).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ event: "run.completed", outcome: "action_required" });
    events.length = 0;
    await runSetup({ ...options, command: "resume" });
    expect(detections).toBe(2);
    expect(events.map((event) => event.event)).toEqual([
      "run.started",
      "step.started",
      "project.detected",
      "step.completed",
      "plan.ready",
      "action.required",
      "run.completed",
    ]);
  });

  test("interrupts with one terminal failure and resumes from the safe phase", async () => {
    const checkpoints = new MemoryCheckpoints();
    const controller = new AbortController();
    const interrupted: SetupEvent[] = [];
    await expect(
      runSetup({
        command: "setup",
        mode: "jsonl",
        runId: "setup_test",
        projectRoot: "/project",
        checkpoints,
        signal: controller.signal,
        now: instant,
        emit: (event) => {
          interrupted.push(event);
        },
        project: {
          detect: async () => {
            controller.abort();
            throw new Error("secret-canary-provider-error");
          },
        },
      }),
    ).rejects.toThrow();
    expect(interrupted.at(-1)).toEqual(
      expect.objectContaining({ event: "run.failed", code: "interrupted", resumable: true }),
    );
    expect(JSON.stringify(interrupted)).not.toContain("secret-canary");
    const resumed: SetupEvent[] = [];
    await runSetup({
      command: "resume",
      mode: "jsonl",
      runId: "setup_test",
      projectRoot: "/project",
      checkpoints,
      now: instant,
      emit: (event) => {
        resumed.push(event);
      },
      project: { detect: async () => detection("/project") },
    });
    expect(resumed.at(-1)).toEqual(expect.objectContaining({ event: "run.completed" }));
  });

  test("status is read-only and missing resume fails with one terminal event", async () => {
    const checkpoints = new MemoryCheckpoints();
    const status: SetupEvent[] = [];
    await runSetup({
      command: "status",
      mode: "jsonl",
      runId: "setup_test",
      projectRoot: "/project",
      checkpoints,
      project: { detect: async () => detection("/project") },
      now: instant,
      emit: (event) => {
        status.push(event);
      },
    });
    expect(status.map((event) => event.event)).toEqual([
      "run.started",
      "diagnostic",
      "run.completed",
    ]);
    expect(checkpoints.state).toBeUndefined();

    const projectRoot = await mkdtemp(join(tmpdir(), "hue-setup-empty-status-"));
    await writeFile(join(projectRoot, "package.json"), JSON.stringify({ private: true }));
    let statusNetworkCalls = 0;
    let statusDetections = 0;
    const realBackend = new SetupBackendAdapter({
      projectRoot,
      origin: "https://example.test",
      fetch: (async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
        statusNetworkCalls += 1;
        throw new Error("status must not use the network without a local installation");
      }) as unknown as typeof fetch,
    });
    const backendStatus: SetupEvent[] = [];
    await runSetup({
      command: "status",
      mode: "jsonl",
      runId: "setup_empty_status",
      projectRoot,
      checkpoints,
      backend: realBackend,
      project: {
        detect: async () => {
          statusDetections += 1;
          return detection(projectRoot);
        },
      },
      now: instant,
      emit: (event) => {
        backendStatus.push(event);
      },
    });
    expect(backendStatus.map((event) => event.event)).toEqual([
      "run.started",
      "diagnostic",
      "run.completed",
    ]);
    expect(statusNetworkCalls).toBe(0);
    expect(statusDetections).toBe(0);
    expect(checkpoints.state).toBeUndefined();
    expect(await lstat(join(projectRoot, ".hue")).catch(() => undefined)).toBeUndefined();

    const resume: SetupEvent[] = [];
    await expect(
      runSetup({
        command: "resume",
        mode: "jsonl",
        runId: "setup_test",
        projectRoot: "/project",
        checkpoints,
        project: { detect: async () => detection("/project") },
        now: instant,
        emit: (event) => {
          resume.push(event);
        },
      }),
    ).rejects.toThrow("No setup checkpoint");
    expect(
      resume.filter((event) => event.event === "run.completed" || event.event === "run.failed"),
    ).toHaveLength(1);
    expect(resume.at(-1)).toEqual(
      expect.objectContaining({ event: "run.failed", resumable: false }),
    );
  });

  test("writes secret-free 0600 checkpoints outside the project", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hue-setup-checkpoint-"));
    const project = join(parent, "project");
    const stateDirectory = join(parent, "state");
    await mkdir(project);
    const runId = setupRunId(project);
    const adapter = new FileSetupCheckpointAdapter(stateDirectory);
    await adapter.save(createInitialSetupState(runId, project));
    const path = join(stateDirectory, `${runId}.json`);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(stateDirectory)).mode & 0o777).toBe(0o700);
    const encoded = await readFile(path, "utf8");
    expect(encoded).not.toContain("HUE_API_KEY");
    expect(encoded).not.toContain("secret-canary");
    expect(await adapter.load(runId, project)).toEqual(createInitialSetupState(runId, project));
    const detecting = transitionSetup(createInitialSetupState(runId, project), {
      type: "start",
    }).state;
    const localReady = transitionSetup(detecting, {
      type: "project.detected",
      project: detection(project),
    }).state;
    await adapter.save(localReady);
    expect(await adapter.load(runId, project)).toEqual(localReady);
    await expect(
      new FileSetupCheckpointAdapter(join(project, ".state")).save(
        createInitialSetupState(runId, project),
      ),
    ).rejects.toThrow("outside");
  });

  test("uses Windows-compatible permission and durability checks", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hue-setup-checkpoint-win32-"));
    const project = join(parent, "project");
    const stateDirectory = join(parent, "state");
    await mkdir(project);
    const runId = setupRunId(project);
    const state = createInitialSetupState(runId, project);
    const adapter = new FileSetupCheckpointAdapter(stateDirectory, "win32");
    await adapter.save(state);
    expect(await adapter.load(runId, project)).toEqual(state);
  });
});

describe("real setup HTTP adapter", () => {
  test("checks technical availability before runtime, project, or installation mutation", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "hue-setup-inactive-"));
    await writeExpressProject(projectRoot);
    const checkpoints = new MemoryCheckpoints();
    let network = 0;
    let commands = 0;
    const backend = new SetupBackendAdapter({
      projectRoot,
      origin: "https://example.test",
      fetch: (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        network += 1;
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        return Response.json(
          {
            protocolVersion: 1,
            state: "inactive",
            capturePolicy: "metadata-only-v1",
            limits: { traces: 100, spans: 1000, bytes: 2097152 },
            lifetime: { expiresAfterSeconds: 86400, purgeAfterSeconds: 691200 },
            privacyNotice: { url: "https://hue.run/privacy", effectiveDate: "2026-08-24" },
            securityUrl: "https://trust.hue.run/",
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }) as unknown as typeof fetch,
      commandRunner: async () => {
        commands += 1;
      },
    });
    const events: SetupEvent[] = [];
    const result = await runSetup({
      command: "setup",
      mode: "jsonl",
      runId: "setup_inactive",
      projectRoot,
      checkpoints,
      backend,
      project: { detect: detectSetupProject },
      emit: (event) => {
        events.push(event);
      },
    });
    expect(result.outcome).toBe("action_required");
    expect(network).toBe(1);
    expect(commands).toBe(0);
    expect(await lstat(join(projectRoot, ".hue")).catch(() => undefined)).toBeUndefined();
    expect(await readFile(join(projectRoot, "package.json"), "utf8")).not.toContain(
      "installationSecret",
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "action.required",
        action: "configure",
      }),
    );
  });

  test("refuses insecure origins, custom config conflicts, and symlink targets", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "hue-setup-security-"));
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({ devDependencies: { typescript: "7.0.2" } }),
    );
    expect(
      () =>
        new SetupBackendAdapter({ projectRoot, origin: "https://user:secret@example.test/path" }),
    ).toThrow("HTTPS origin");
    const store = new FileSetupInstallationStore(projectRoot, "https://example.test");
    const installation = await store.loadOrCreate();
    await writeFile(join(projectRoot, ".gitignore"), "");
    await writeFile(join(projectRoot, ".hue", ".gitignore"), "");
    await chmod(join(projectRoot, ".hue"), 0o755);
    await store.ensureIgnored();
    expect(await readFile(join(projectRoot, ".gitignore"), "utf8")).toContain(
      ".hue/installation-*.json",
    );
    expect(await readFile(join(projectRoot, ".gitignore"), "utf8")).toContain(
      ".hue/.installation-*.tmp",
    );
    expect((await lstat(join(projectRoot, ".hue"))).mode & 0o777).toBe(0o700);
    installation.credential = syntheticCredential();
    await store.save(installation);
    await writeFile(join(projectRoot, "hue.setup.mjs"), "// custom\n");
    await expect(
      configureSetupProject(store, installation, await detectSetupProject(projectRoot)),
    ).rejects.toThrow("Refusing to overwrite custom");
    const credentialRoot = await mkdtemp(join(tmpdir(), "hue-setup-credential-conflict-"));
    await writeFile(
      join(credentialRoot, "package.json"),
      JSON.stringify({ devDependencies: { typescript: "7.0.2" } }),
    );
    await writeFile(join(credentialRoot, ".env.local"), "HUE_API_KEY=secret-canary-value\n");
    const credentialStore = new FileSetupInstallationStore(credentialRoot, "https://example.test");
    const credentialInstallation = await credentialStore.loadOrCreate();
    await expect(
      configureSetupProject(
        credentialStore,
        credentialInstallation,
        await detectSetupProject(credentialRoot),
      ),
    ).rejects.toThrow("existing custom Hue credential");
    const pythonRoot = await mkdtemp(join(tmpdir(), "hue-setup-symlink-"));
    await writeFile(join(pythonRoot, "pyproject.toml"), '[project]\nname = "test"\n');
    await symlink(projectRoot, join(pythonRoot, ".hue"));
    const unsafe = new FileSetupInstallationStore(pythonRoot, "https://example.test");
    await expect(unsafe.loadOrCreate()).rejects.toThrow("symlink");

    const preflightRoot = await mkdtemp(join(tmpdir(), "hue-setup-preflight-conflict-"));
    await writeExpressProject(preflightRoot);
    await writeFile(join(preflightRoot, "hue.setup.mjs"), "// existing custom setup\n");
    const preflight = new SetupBackendAdapter({
      projectRoot: preflightRoot,
      origin: "https://example.test",
    });
    await expect(preflight.preflight(await detectSetupProject(preflightRoot))).rejects.toThrow(
      "Refusing to overwrite custom",
    );
    expect(await lstat(join(preflightRoot, ".hue")).catch(() => undefined)).toBeUndefined();
    expect(await lstat(join(preflightRoot, ".gitignore")).catch(() => undefined)).toBeUndefined();
  });

  test("claim refuses to create a replacement identity when local proof is missing", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "hue-setup-missing-claim-"));
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({ devDependencies: { typescript: "7.0.2" } }),
    );
    const checkpoints = new MemoryCheckpoints();
    await runSetup({
      command: "setup",
      mode: "jsonl",
      runId: "setup_missing_claim",
      projectRoot,
      checkpoints,
      project: { detect: detectSetupProject },
      emit: () => {},
    });
    let networkCalls = 0;
    const backend = new SetupBackendAdapter({
      projectRoot,
      origin: "https://example.test",
      fetch: (async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
        networkCalls += 1;
        throw new Error("claim must not use the network without the original proof");
      }) as unknown as typeof fetch,
    });
    const events: SetupEvent[] = [];
    await expect(
      runSetup({
        command: "claim",
        mode: "jsonl",
        runId: "setup_missing_claim",
        projectRoot,
        checkpoints,
        backend,
        project: { detect: detectSetupProject },
        emit: (event) => {
          events.push(event);
        },
      }),
    ).rejects.toThrow("No Hue setup installation");
    expect(networkCalls).toBe(0);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({ event: "run.failed", resumable: false }),
    );
    expect(await lstat(join(projectRoot, ".hue")).catch(() => undefined)).toBeUndefined();
  });

  test("recovers a lost credential response with the same generation and proof", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "hue-setup-response-loss-"));
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({ devDependencies: { typescript: "7.0.2" } }),
    );
    const origin = "https://example.test";
    let calls = 0;
    let authorization = "";
    let requestBody = "";
    const backend = new SetupBackendAdapter({
      projectRoot,
      origin,
      fetch: (async (_input, init) => {
        calls += 1;
        const headers = new Headers(init?.headers);
        const nextAuthorization = headers.get("authorization")!;
        const nextBody = String(init?.body);
        if (!authorization) {
          authorization = nextAuthorization;
          requestBody = nextBody;
        } else {
          expect(nextAuthorization).toBe(authorization);
          expect(nextBody).toBe(requestBody);
        }
        if (calls === 1) throw new TypeError("synthetic response loss with secret-canary");
        const installation = await backend.prepare();
        return Response.json(
          {
            protocolVersion: 1,
            installationId: installation.installationId,
            state: "active",
            project: { id: "project_test", organizationId: "org_trial" },
            credentialVersion: 0,
            capturePolicy: "metadata-only-v1",
            expiresAt: "2026-09-21T12:00:00.000Z",
            limits: { traces: 100, spans: 1000, bytes: 2097152 },
            usage: { traces: 0, spans: 0, bytes: 0 },
            claimHandoff: null,
            endpoints: {
              otlp: "/api/v1/otlp/v1/traces",
              receipt: "/api/v1/setup/traces/{traceId}/receipt",
            },
            credential: {
              kind: "anonymous_trial",
              apiKey: syntheticCredential().apiKey,
              keyId: syntheticCredential().keyId,
              capabilities: ["setup_telemetry_write"],
              version: 0,
            },
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }) as typeof fetch,
      requestTimeoutMillis: 1000,
    });
    const result = await backend.credentials(0);
    expect(calls).toBe(2);
    expect(result.credential.apiKey).toBe(syntheticCredential().apiKey);
    expect((await backend.localInstallation())?.credential?.apiKey).toBe(
      syntheticCredential().apiKey,
    );
  });

  test("treats a durable revoked lineage as terminal without minting or retrying", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "hue-setup-revoked-lineage-"));
    await writeExpressProject(projectRoot);
    const origin = "https://example.test";
    let credentialCalls = 0;
    const backend = new SetupBackendAdapter({
      projectRoot,
      origin,
      fetch: (async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const installation = await backend.localInstallation();
        expect(installation).toBeDefined();
        if (url.pathname.endsWith("/credentials")) {
          credentialCalls += 1;
          expect(init?.method).toBe("POST");
          return Response.json(
            { protocolVersion: 1, code: "SETUP_REVOKED" },
            { status: 409, headers: { "Cache-Control": "no-store" } },
          );
        }
        expect(init?.method).toBe("GET");
        return Response.json(
          {
            protocolVersion: 1,
            installationId: installation!.installationId,
            state: "claimed",
            project: { id: "project_test", organizationId: "org_owner" },
            credentialVersion: 1,
            capturePolicy: "metadata-only-v1",
            expiresAt: null,
            limits: { traces: 100, spans: 1000, bytes: 2097152 },
            usage: { traces: 1, spans: 1, bytes: 100 },
            claimHandoff: null,
            endpoints: {
              otlp: "/api/v1/otlp/v1/traces",
              receipt: "/api/v1/setup/traces/{traceId}/receipt",
            },
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }) as typeof fetch,
    });
    const installation = await backend.prepare();
    installation.credential = syntheticCredential();
    await backend.store.save(installation);
    const checkpoints = new MemoryCheckpoints();
    await runSetup({
      command: "setup",
      mode: "jsonl",
      runId: "setup_revoked",
      projectRoot,
      checkpoints,
      project: { detect: detectSetupProject },
      emit: () => {},
    });
    const events: SetupEvent[] = [];
    const result = await runSetup({
      command: "claim",
      mode: "jsonl",
      runId: "setup_revoked",
      projectRoot,
      checkpoints,
      backend,
      project: { detect: detectSetupProject },
      emit: (event) => {
        events.push(event);
      },
    });
    expect(result.outcome).toBe("action_required");
    expect(credentialCalls).toBe(1);
    expect((await backend.localInstallation())?.credential).toEqual(
      expect.objectContaining({ apiKey: syntheticCredential().apiKey, version: 0 }),
    );
    expect((await backend.localInstallation())?.revocationCredential).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "action.required",
        message: expect.stringContaining("explicitly rotate"),
      }),
    );
  });

  test("rejects response fields outside the frozen v1 shapes", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "hue-setup-exact-response-"));
    const origin = "https://example.test";
    const backend = new SetupBackendAdapter({
      projectRoot,
      origin,
      fetch: (async (_input, _init) => {
        const installation = await backend.prepare();
        return Response.json(
          {
            protocolVersion: 1,
            installationId: installation.installationId,
            state: "active",
            project: { id: "project_test", organizationId: "org_trial" },
            credentialVersion: 0,
            capturePolicy: "metadata-only-v1",
            expiresAt: "2026-09-21T12:00:00.000Z",
            limits: { traces: 100, spans: 1000, bytes: 2097152 },
            usage: { traces: 0, spans: 0, bytes: 0 },
            claimHandoff: null,
            endpoints: {
              otlp: "/api/v1/otlp/v1/traces",
              receipt: "/api/v1/setup/traces/{traceId}/receipt",
            },
            unexpected: "field",
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }) as typeof fetch,
      requestTimeoutMillis: 1000,
    });
    await expect(backend.provision()).rejects.toMatchObject({ code: "invalid_response" });

    const errorRoot = await mkdtemp(join(tmpdir(), "hue-setup-exact-error-"));
    const invalidError = new SetupBackendAdapter({
      projectRoot: errorRoot,
      origin,
      fetch: (async (_input, _init) =>
        Response.json(
          { protocolVersion: 1, code: "SETUP_UNAUTHORIZED" },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        )) as typeof fetch,
      requestTimeoutMillis: 1000,
    });
    await expect(invalidError.provision()).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("rejects truncated and cross-origin claim capabilities without echoing them", async () => {
    const origin = "https://example.test";
    const handoffId = "11111111-1111-4111-8111-111111111111";
    const cases = [
      `${origin}/setup/claim#${"t".repeat(42)}`,
      `https://attacker.invalid/setup/claim#${"x".repeat(43)}`,
    ];
    for (const claimUrl of cases) {
      const projectRoot = await mkdtemp(join(tmpdir(), "hue-setup-invalid-claim-"));
      const backend = new SetupBackendAdapter({
        projectRoot,
        origin,
        fetch: (async (input: Parameters<typeof fetch>[0]) => {
          const installation = await backend.prepare();
          const url = new URL(input instanceof Request ? input.url : input.toString());
          if (url.pathname.endsWith("/claim-handoff"))
            return Response.json(
              {
                protocolVersion: 1,
                installationId: installation.installationId,
                handoff: {
                  id: handoffId,
                  state: "pending",
                  expiresAt: "2026-09-20T12:10:00.000Z",
                  sessionExpiresAt: null,
                },
                claimUrl,
              },
              { headers: { "Cache-Control": "no-store" } },
            );
          return Response.json(
            {
              protocolVersion: 1,
              installationId: installation.installationId,
              state: "active",
              project: { id: "project_test", organizationId: "org_trial" },
              credentialVersion: 0,
              capturePolicy: "metadata-only-v1",
              expiresAt: "2026-09-21T12:00:00.000Z",
              limits: { traces: 100, spans: 1000, bytes: 2097152 },
              usage: { traces: 0, spans: 0, bytes: 0 },
              claimHandoff: {
                id: handoffId,
                state: "pending",
                expiresAt: "2026-09-20T12:10:00.000Z",
                sessionExpiresAt: null,
              },
              endpoints: {
                otlp: "/api/v1/otlp/v1/traces",
                receipt: "/api/v1/setup/traces/{traceId}/receipt",
              },
            },
            { headers: { "Cache-Control": "no-store" } },
          );
        }) as unknown as typeof fetch,
      });
      let failure: unknown;
      try {
        const status = await backend.provision();
        const installation = await backend.prepare();
        installation.claimHandoff = { id: handoffId, previousHandoffId: null };
        await backend.store.save(installation);
        await backend.prepareClaimHandoff(status, false);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "invalid_response" });
      expect(String(failure)).not.toContain(claimUrl);
      expect(await lstat(backend.store.claimHandoffPath).catch(() => undefined)).toBeUndefined();
    }
  });

  test("refuses redirects without forwarding installation proof", async () => {
    let destinationHits = 0;
    const destination = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        destinationHits += 1;
        expect(request.headers.get("authorization")).toBeNull();
        return Response.json({}, { headers: { "Cache-Control": "no-store" } });
      },
    });
    const redirect = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(null, {
          status: 307,
          headers: { Location: `http://127.0.0.1:${destination.port}/stolen` },
        });
      },
    });
    try {
      const projectRoot = await mkdtemp(join(tmpdir(), "hue-setup-redirect-"));
      const backend = new SetupBackendAdapter({
        projectRoot,
        origin: `http://127.0.0.1:${redirect.port}`,
        requestTimeoutMillis: 1000,
      });
      await expect(backend.provision()).rejects.toThrow("redirect");
      expect(destinationHits).toBe(0);
    } finally {
      redirect.stop(true);
      destination.stop(true);
    }
  });

  test("persists proof first, wires an existing app request, verifies exact receipts, and reconciles claim", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hue-setup-http-"));
    const projectRoot = join(parent, "project");
    await mkdir(projectRoot);
    await writeExpressProject(projectRoot, true);
    const traceType = protobuf.Root.fromJSON(otlpSchema).lookupType(
      "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
    );
    let installationId = "";
    let claimed = false;
    let traceId = "";
    let spanId = "";
    let oldKeyRejected = 0;
    let failRevocationOnce = true;
    let receiptMissing = true;
    let handoffIssued = false;
    const key0 = syntheticCredential(0).apiKey;
    const key1 = syntheticCredential(1).apiKey;
    const claimCapability = "c".repeat(43);
    let handoffId = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const noStore = { "Cache-Control": "no-store" };
        const status = () => ({
          protocolVersion: 1,
          installationId,
          state: claimed ? "claimed" : "active",
          project: {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            organizationId: claimed
              ? "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
              : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          },
          credentialVersion: claimed ? 1 : 0,
          capturePolicy: "metadata-only-v1",
          expiresAt: claimed ? null : "2026-09-21T12:00:00.000Z",
          limits: { traces: 100, spans: 1000, bytes: 2097152 },
          usage: { traces: traceId ? 1 : 0, spans: traceId ? 1 : 0, bytes: traceId ? 100 : 0 },
          claimHandoff:
            claimed || !handoffIssued
              ? null
              : {
                  id: handoffId,
                  state: "pending",
                  expiresAt: "2026-09-20T12:10:00.000Z",
                  sessionExpiresAt: null,
                },
          endpoints: {
            otlp: "/api/v1/otlp/v1/traces",
            receipt: "/api/v1/setup/traces/{traceId}/receipt",
          },
        });
        if (url.pathname === "/api/v1/setup/preflight") {
          expect(request.headers.get("authorization")).toBeNull();
          return Response.json(
            {
              protocolVersion: 1,
              state: "available",
              capturePolicy: "metadata-only-v1",
              limits: { traces: 100, spans: 1000, bytes: 2097152 },
              lifetime: { expiresAfterSeconds: 86400, purgeAfterSeconds: 691200 },
              privacyNotice: { url: "https://hue.run/privacy", effectiveDate: "2026-08-24" },
              securityUrl: "https://trust.hue.run/",
            },
            { headers: noStore },
          );
        }
        if (url.pathname.startsWith("/api/v1/setup/installations")) {
          expect(request.headers.get("authorization")).toMatch(
            /^Bearer hue_install_[A-Za-z0-9_-]{43}$/u,
          );
          if (request.method === "POST" && url.pathname === "/api/v1/setup/installations") {
            expect(request.headers.get("content-type")).toBe("application/json");
            const body = await request.json();
            expect(Object.keys(body as object).sort()).toEqual([
              "installationId",
              "protocolVersion",
            ]);
            installationId = (body as { installationId: string }).installationId;
            const files = await lstat(
              join(projectRoot, ".hue", `installation-${"placeholder"}.json`),
            ).catch(() => undefined);
            expect(files).toBeUndefined();
            const hueFiles = await import("node:fs/promises").then(({ readdir }) =>
              readdir(join(projectRoot, ".hue")),
            );
            expect(hueFiles.some((name) => name.startsWith("installation-"))).toBe(true);
            return Response.json(status(), { headers: noStore });
          }
          if (request.method === "GET") return Response.json(status(), { headers: noStore });
          if (url.pathname.endsWith("/claim-handoff")) {
            const body = (await request.json()) as {
              protocolVersion: number;
              handoffId: string;
              previousHandoffId: string | null;
            };
            expect(body.protocolVersion).toBe(1);
            expect(body.handoffId).toMatch(
              /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
            );
            expect(body.previousHandoffId).toBeNull();
            handoffId = body.handoffId;
            handoffIssued = true;
            return Response.json(
              {
                protocolVersion: 1,
                installationId,
                handoff: status().claimHandoff,
                claimUrl: `${url.origin}/setup/claim#${claimCapability}`,
              },
              { headers: noStore },
            );
          }
          if (url.pathname.endsWith("/credentials")) {
            const body = (await request.json()) as { credentialVersion: number };
            expect(body.credentialVersion).toBe(claimed ? 1 : 0);
            return Response.json(
              {
                ...status(),
                credential: {
                  kind: "anonymous_trial",
                  apiKey: claimed ? key1 : key0,
                  keyId: syntheticCredential(claimed ? 1 : 0).keyId,
                  capabilities: ["setup_telemetry_write"],
                  version: claimed ? 1 : 0,
                },
              },
              { headers: noStore },
            );
          }
        }
        if (url.pathname === "/api/v1/otlp/v1/traces") {
          expect(request.headers.get("authorization")).toBe(`Bearer ${claimed ? key1 : key0}`);
          let bytes = Buffer.from(await request.arrayBuffer());
          if (request.headers.get("content-encoding") === "gzip") bytes = gunzipSync(bytes);
          const decoded = traceType.toObject(traceType.decode(bytes), { bytes: String });
          const span = decoded.resourceSpans[0].scopeSpans[0].spans[0];
          traceId = Buffer.from(span.traceId, "base64").toString("hex");
          spanId = Buffer.from(span.spanId, "base64").toString("hex");
          expect(JSON.stringify(decoded)).not.toContain("input.value");
          expect(JSON.stringify(decoded)).not.toContain("output.value");
          return new Response(new Uint8Array(), {
            headers: { "Content-Type": "application/x-protobuf" },
          });
        }
        const match = /^\/api\/v1\/setup\/traces\/([a-f0-9]{32})\/receipt$/u.exec(url.pathname);
        if (match) {
          const authorization = request.headers.get("authorization");
          if (claimed && authorization === `Bearer ${key0}`) {
            oldKeyRejected += 1;
            if (failRevocationOnce) {
              failRevocationOnce = false;
              return new Response(null, { status: 503 });
            }
            return new Response(null, { status: 401 });
          }
          expect(authorization).toBe(`Bearer ${claimed ? key1 : key0}`);
          expect(match[1]).toBe(traceId);
          expect(url.searchParams.getAll("expectedSpanId")).toEqual([spanId]);
          if (receiptMissing)
            return Response.json(
              { code: "TRACE_NOT_FOUND" },
              { status: 404, headers: { "Cache-Control": "no-store" } },
            );
          return Response.json({
            traceId,
            spanCount: 1,
            revision: 1,
            fields: { input: false, output: false, model: false, usage: false, session: false },
            matchedSpanIds: [spanId],
            missingSpanIds: [],
            traceUrl: `${url.origin}/traces/dddddddd-dddd-4ddd-8ddd-dddddddddddd?projectId=${status().project.id}&organizationId=${status().project.organizationId}`,
          });
        }
        return new Response(null, { status: 404 });
      },
    });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const backend = new SetupBackendAdapter({
        projectRoot,
        origin,
        requestTimeoutMillis: 2000,
        receiptTimeoutMillis: 300,
        commandRunner: async () => {},
      });
      const checkpoints = new MemoryCheckpoints();
      const events: SetupEvent[] = [];
      const options = {
        mode: "jsonl" as const,
        runId: "setup_http",
        projectRoot,
        checkpoints,
        backend,
        project: { detect: detectSetupProject },
        emit: (event: SetupEvent) => {
          events.push(event);
        },
      };
      expect((await runSetup({ ...options, command: "setup" })).outcome).toBe("action_required");
      expect(events.some((event) => event.event === "receipt.verified")).toBe(false);
      expect(await readFile(join(projectRoot, "handler-count.txt"), "utf8")).toBe("1");
      receiptMissing = false;
      events.length = 0;
      expect((await runSetup({ ...options, command: "resume" })).outcome).toBe("action_required");
      expect(events.some((event) => event.event === "receipt.verified")).toBe(true);
      expect(await readFile(join(projectRoot, "handler-count.txt"), "utf8")).toBe("1");
      expect(JSON.stringify(events)).not.toContain(claimCapability);
      expect(events.find((event) => event.event === "claim.required")).toEqual(
        expect.not.objectContaining({ url: expect.anything() }),
      );
      const installation = await backend.localInstallation();
      expect(installation?.credential?.version).toBe(0);
      expect((await lstat(backend.store.path)).mode & 0o777).toBe(0o600);
      expect(await readFile(join(projectRoot, ".gitignore"), "utf8")).toContain(
        ".hue/installation-*.json",
      );
      expect(await readFile(join(projectRoot, ".hue", ".gitignore"), "utf8")).toContain(
        "installation-*.json",
      );
      expect(await readFile(join(projectRoot, ".gitignore"), "utf8")).toContain(
        ".hue/claim-handoff-*.html",
      );
      expect(await lstat(backend.store.claimHandoffPath).catch(() => undefined)).toBeUndefined();
      for (const name of ["hue.setup.mjs"]) {
        const config = await readFile(join(projectRoot, name), "utf8");
        expect(config).not.toContain(key0);
        expect(config).toContain(
          name.endsWith("mjs") ? "captureContent: false" : "capture_content=False",
        );
      }
      const opened: string[] = [];
      const ownerBackend = new SetupBackendAdapter({
        projectRoot,
        origin,
        requestTimeoutMillis: 2000,
        receiptTimeoutMillis: 2000,
        commandRunner: async () => {},
        openBrowser: async (localHandoffUrl) => {
          opened.push(localHandoffUrl);
        },
      });
      events.length = 0;
      expect(
        (
          await runSetup({
            ...options,
            backend: ownerBackend,
            mode: "human",
            command: "claim",
          })
        ).outcome,
      ).toBe("action_required");
      expect(opened).toHaveLength(1);
      expect(opened[0]).toStartWith("file:");
      expect(opened[0]).not.toContain(claimCapability);
      expect(opened[0]).not.toContain("/setup/claim");
      expect(JSON.stringify(events)).not.toContain(claimCapability);
      expect((await lstat(ownerBackend.store.claimHandoffPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(ownerBackend.store.claimHandoffPath, "utf8")).toContain(
        claimCapability,
      );
      claimed = true;
      events.length = 0;
      await expect(runSetup({ ...options, command: "claim" })).rejects.toThrow(
        "superseded anonymous key",
      );
      const interruptedClaim = await backend.localInstallation();
      expect(interruptedClaim?.credential?.version).toBe(1);
      expect(interruptedClaim?.revocationCredential?.version).toBe(0);
      events.length = 0;
      const resumedBackend = new SetupBackendAdapter({
        projectRoot,
        origin,
        requestTimeoutMillis: 2000,
        receiptTimeoutMillis: 2000,
        commandRunner: async () => {},
      });
      expect(
        (await runSetup({ ...options, backend: resumedBackend, command: "claim" })).outcome,
      ).toBe("ready");
      expect((await resumedBackend.localInstallation())?.credential?.version).toBe(1);
      expect((await resumedBackend.localInstallation())?.revocationCredential).toBeUndefined();
      expect(
        await lstat(resumedBackend.store.claimHandoffPath).catch(() => undefined),
      ).toBeUndefined();
      expect(oldKeyRejected).toBe(2);
      expect(await readFile(join(projectRoot, "handler-count.txt"), "utf8")).toBe("1");
      expect(events.at(-1)).toEqual(
        expect.objectContaining({ event: "run.completed", outcome: "ready" }),
      );
    } finally {
      server.stop(true);
    }
  });
});

describe("renderers and event contract", () => {
  const action: SetupEvent = {
    contractVersion: SETUP_EVENT_CONTRACT_VERSION,
    event: "action.required",
    runId: "setup_test",
    sequence: 3,
    timestamp: "2026-09-19T12:00:00.000Z",
    action: "claim-project",
    message:
      "Anonymous instrumentation receipt verified. Preserve this project and its trace history.",
    command: "hue claim",
  };

  test("human snapshots are append-only at useful widths", () => {
    expect(renderHumanEvent(action, 44, false)).toMatchInlineSnapshot(`
      "◆ Anonymous instrumentation receipt
      ◆ verified. Preserve this project and its
      ◆ trace history. Next: hue claim."
    `);
    expect(renderHumanEvent(action, 80, false)).toMatchInlineSnapshot(`
      "◆ Anonymous instrumentation receipt verified. Preserve this project and its
      ◆ trace history. Next: hue claim."
    `);
  });

  test("plain and JSONL never contain ANSI", () => {
    expect(renderPlainEvent(action, 60)).not.toContain("\u001b");
    expect(renderJsonlEvent(action)).not.toContain("\u001b");
    expect(JSON.parse(renderJsonlEvent(action))).toEqual(action);
    expect(selectSetupOutputMode({ isTTY: true, env: { NO_COLOR: "1" } })).toBe("plain");
    expect(selectSetupOutputMode({ isTTY: true, env: { TERM: "dumb" } })).toBe("plain");
    expect(selectSetupOutputMode({ isTTY: true, env: { CI: "1" } })).toBe("plain");
    expect(selectSetupOutputMode({ agent: true, explicit: "human", isTTY: true, env: {} })).toBe(
      "jsonl",
    );
  });

  test("all renderers drop and redact adversarial claim capabilities", () => {
    const capability = "z".repeat(43);
    const claimUrl = `https://example.test/setup/claim#${capability}`;
    const adversarial = {
      ...action,
      message: `Open ${claimUrl} claim_token=${capability}`,
      command: `browser ${claimUrl}`,
      url: claimUrl,
      unexpected: { claimUrl },
    } as unknown as SetupEvent;
    for (const rendered of [
      renderJsonlEvent(adversarial),
      renderPlainEvent(adversarial, 80),
      renderHumanEvent(adversarial, 80, false),
    ]) {
      expect(rendered).not.toContain(capability);
      expect(rendered).not.toContain("/setup/claim#");
    }
    const json = JSON.parse(renderJsonlEvent(adversarial)) as Record<string, unknown>;
    expect(json).not.toHaveProperty("url");
    expect(json).not.toHaveProperty("unexpected");
  });

  test("all event variants satisfy the published bounded schema", async () => {
    const schema = JSON.parse(
      await readFile(join(dirname(import.meta.dir), "setup-events.schema.json"), "utf8"),
    );
    const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(schema);
    const base = {
      contractVersion: SETUP_EVENT_CONTRACT_VERSION,
      runId: "setup_test",
      sequence: 1,
      timestamp: "2026-09-19T12:00:00.000Z",
    };
    const samples: SetupEvent[] = [
      { ...base, event: "run.started", command: "setup", mode: "jsonl", resumed: false },
      { ...base, event: "project.detected", project: detection("/project") },
      {
        ...base,
        event: "plan.ready",
        plan: { steps: ["detect-project"], mutatesProject: false, backendRequired: true },
      },
      { ...base, event: "step.started", step: "detect-project" },
      { ...base, event: "step.completed", step: "detect-project", outcome: "unchanged" },
      { ...base, event: "file.changed", path: "instrumentation.ts", change: "created" },
      { ...base, event: "diagnostic", level: "info", code: "local.ready", message: "Ready." },
      action,
      {
        ...base,
        event: "action.required",
        action: "restart-claim-handoff",
        message: "The project owner must explicitly replace the expired browser handoff.",
        command: "hue claim --restart",
      },
      {
        ...base,
        event: "trial.created",
        trialId: "trial_123",
        expiresAt: "2026-09-20T12:00:00.000Z",
      },
      {
        ...base,
        event: "receipt.verified",
        receiptId: "receipt_123",
        traceId: "a".repeat(32),
        source: "repository-http-boundary",
      },
      { ...base, event: "claim.required", claimId: "claim_123" },
      { ...base, event: "claim.completed", claimId: "claim_123" },
      { ...base, event: "run.completed", outcome: "action_required", checkpointed: true },
      {
        ...base,
        event: "run.failed",
        code: "interrupted",
        message: "Interrupted.",
        resumable: true,
      },
    ];
    for (const event of samples)
      expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validate({
        ...base,
        event: "run.started",
        command: "connect",
        mode: "jsonl",
        resumed: false,
      }),
    ).toBe(false);
    expect(validate({ ...action, unexpected: "unbounded" })).toBe(false);
    expect(
      validate({ ...base, event: "claim.required", claimId: "claim_123", url: "redacted" }),
    ).toBe(false);
    expect(validate({ ...action, message: "x".repeat(1001) })).toBe(false);
  });
});

test("agent status CLI is noninteractive JSONL with exactly one terminal event", async () => {
  const parent = await mkdtemp(join(tmpdir(), "hue-setup-cli-"));
  const project = join(parent, "project");
  await mkdir(project);
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ devDependencies: { typescript: "5.9.0" } }),
  );
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dir, "../src/setup/cli.ts"), "status", "--agent", "--project", project],
    {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        XDG_STATE_HOME: join(parent, "state-home"),
        BROWSER: "secret-canary-browser",
        HUE_API_KEY: "secret-canary-key",
        NO_COLOR: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain("\u001b");
  expect(result.stdout).not.toContain("secret-canary");
  const events = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SetupEvent);
  expect(
    events.filter((event) => event.event === "run.completed" || event.event === "run.failed"),
  ).toHaveLength(1);
  expect(events.at(-1)?.event).toBe("run.completed");
  const help = spawnSync(
    process.execPath,
    [join(import.meta.dir, "../src/setup/cli.ts"), "--agent", "--help"],
    { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
  );
  const helpEvents = help.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SetupEvent);
  expect(helpEvents).toHaveLength(1);
  expect(helpEvents[0]?.event).toBe("run.failed");
  const removedConnect = spawnSync(
    process.execPath,
    [join(import.meta.dir, "../src/setup/cli.ts"), "connect", "--agent"],
    { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
  );
  const removedConnectEvents = removedConnect.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SetupEvent);
  expect(removedConnect.status).toBe(2);
  expect(removedConnect.stderr).toBe("");
  expect(removedConnectEvents).toHaveLength(1);
  expect(removedConnectEvents[0]?.event).toBe("run.failed");
});
