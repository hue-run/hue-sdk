import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { Ajv2020 } from "ajv/dist/2020.js";
import protobuf from "protobufjs/light.js";
import { SetupBackendAdapter } from "../src/setup/backend.js";
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
    ).toEqual(["detect-project", "configure-telemetry", "verify-receipt", "claim-project"]);
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
    expect(detections).toBe(1);
    expect(events.map((event) => event.event)).toEqual([
      "run.started",
      "project.detected",
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
    installation.credential = { apiKey: "synthetic-key", keyId: "key_0", version: 0 };
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
            claimUrl: `${origin}/setup/claim#${"c".repeat(43)}`,
            endpoints: {
              otlp: "/api/v1/otlp/v1/traces",
              receipt: "/api/v1/traces/{traceId}/receipt",
            },
            credential: {
              apiKey: "same-recovered-key",
              keyId: "key_0",
              capabilities: ["telemetry_write"],
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
    expect(result.credential.apiKey).toBe("same-recovered-key");
    expect((await backend.localInstallation())?.credential?.apiKey).toBe("same-recovered-key");
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
            claimUrl: `${origin}/setup/claim#${"c".repeat(43)}`,
            endpoints: {
              otlp: "/api/v1/otlp/v1/traces",
              receipt: "/api/v1/traces/{traceId}/receipt",
            },
            unexpected: "field",
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }) as typeof fetch,
      requestTimeoutMillis: 1000,
    });
    await expect(backend.provision()).rejects.toMatchObject({ code: "invalid_response" });
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

  test("persists proof first, configures both languages, verifies exact probes, and reconciles claim", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hue-setup-http-"));
    const projectRoot = join(parent, "project");
    await mkdir(projectRoot);
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({ dependencies: { typescript: "7.0.2" } }),
    );
    await writeFile(join(projectRoot, "pyproject.toml"), '[project]\nname = "setup-test"\n');
    const traceType = protobuf.Root.fromJSON(otlpSchema).lookupType(
      "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
    );
    let installationId = "";
    let claimed = false;
    let traceId = "";
    let spanId = "";
    let oldKeyRejected = 0;
    const key0 = "synthetic-setup-key-v0";
    const key1 = "synthetic-setup-key-v1";
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
          project: { id: "project_test", organizationId: claimed ? "org_owner" : "org_trial" },
          credentialVersion: claimed ? 1 : 0,
          capturePolicy: "metadata-only-v1",
          expiresAt: claimed ? null : "2026-09-21T12:00:00.000Z",
          limits: { traces: 100, spans: 1000, bytes: 2097152 },
          usage: { traces: traceId ? 1 : 0, spans: traceId ? 1 : 0, bytes: traceId ? 100 : 0 },
          claimUrl: claimed ? null : `${url.origin}/setup/claim#${"c".repeat(43)}`,
          endpoints: {
            otlp: "/api/v1/otlp/v1/traces",
            receipt: "/api/v1/traces/{traceId}/receipt",
          },
        });
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
          if (url.pathname.endsWith("/credentials")) {
            const body = (await request.json()) as { credentialVersion: number };
            expect(body.credentialVersion).toBe(claimed ? 1 : 0);
            return Response.json(
              {
                ...status(),
                credential: {
                  apiKey: claimed ? key1 : key0,
                  keyId: claimed ? "key_v1" : "key_v0",
                  capabilities: ["telemetry_write"],
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
        const match = /^\/api\/v1\/traces\/([a-f0-9]{32})\/receipt$/u.exec(url.pathname);
        if (match) {
          const authorization = request.headers.get("authorization");
          if (claimed && authorization === `Bearer ${key0}`) {
            oldKeyRejected += 1;
            return new Response(null, { status: 401 });
          }
          expect(authorization).toBe(`Bearer ${claimed ? key1 : key0}`);
          expect(match[1]).toBe(traceId);
          expect(url.searchParams.getAll("expectedSpanId")).toEqual([spanId]);
          return Response.json({
            traceId,
            spanCount: 1,
            revision: 1,
            fields: { input: false, output: false, model: false, usage: false, session: false },
            matchedSpanIds: [spanId],
            missingSpanIds: [],
            traceUrl: `${url.origin}/traces/${traceId}`,
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
        receiptTimeoutMillis: 2000,
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
      expect(events.some((event) => event.event === "receipt.verified")).toBe(true);
      const installation = await backend.localInstallation();
      expect(installation?.credential?.version).toBe(0);
      expect((await lstat(backend.store.path)).mode & 0o777).toBe(0o600);
      expect(await readFile(join(projectRoot, ".gitignore"), "utf8")).toContain(
        ".hue/installation-*.json",
      );
      expect(await readFile(join(projectRoot, ".hue", ".gitignore"), "utf8")).toContain(
        "installation-*.json",
      );
      for (const name of ["hue.setup.mjs", "hue_setup.py"]) {
        const config = await readFile(join(projectRoot, name), "utf8");
        expect(config).not.toContain(key0);
        expect(config).toContain(
          name.endsWith("mjs") ? "captureContent: false" : "capture_content=False",
        );
      }
      claimed = true;
      events.length = 0;
      expect((await runSetup({ ...options, command: "claim" })).outcome).toBe("ready");
      expect((await backend.localInstallation())?.credential?.version).toBe(1);
      expect(oldKeyRejected).toBe(1);
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
    contractVersion: 1,
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
        action: "capture-approved-content",
        message:
          "After claiming, explicitly approve and perform a content capture or rerun; the prepared tester is the first golden path.",
      },
      {
        ...base,
        event: "action.required",
        action: "review-content-approved-trace",
        message:
          "Open the resulting content-approved trace in Hue for review and publication as a Scenario.",
      },
      {
        ...base,
        event: "trial.created",
        trialId: "trial_123",
        expiresAt: "2026-09-20T12:00:00.000Z",
      },
      { ...base, event: "receipt.verified", receiptId: "receipt_123", traceId: "a".repeat(32) },
      { ...base, event: "claim.required", claimId: "claim_123", url: "https://example.test/claim" },
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
