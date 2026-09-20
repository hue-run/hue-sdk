import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { Ajv2020 } from "ajv/dist/2020.js";
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
      "action.required",
    ]);
    expect(
      (second.state as Extract<SetupMachineState, { phase: "local-ready" }>).plan.mutatesProject,
    ).toBe(false);
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

  test("claim never invokes an injected backend in this slice", async () => {
    const events: SetupEvent[] = [];
    const called: string[] = [];
    await runSetup({
      command: "claim",
      mode: "plain",
      runId: "setup_test",
      projectRoot: "/project",
      checkpoints: new MemoryCheckpoints(),
      project: { detect: async () => detection("/project") },
      backend: {
        createTrial: async () => {
          called.push("create");
          throw new Error();
        },
        verifyReceipt: async () => {
          called.push("verify");
          return undefined;
        },
        getClaim: async () => {
          called.push("claim");
          throw new Error();
        },
      },
      now: instant,
      emit: (event) => {
        events.push(event);
      },
    });
    expect(called).toEqual([]);
    expect(events.map((event) => event.event)).toEqual([
      "run.started",
      "action.required",
      "run.completed",
    ]);
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

test("agent CLI is noninteractive JSONL with exactly one terminal event", async () => {
  const parent = await mkdtemp(join(tmpdir(), "hue-setup-cli-"));
  const project = join(parent, "project");
  await mkdir(project);
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ devDependencies: { typescript: "5.9.0" } }),
  );
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dir, "../src/setup/cli.ts"), "setup", "--agent", "--project", project],
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
  const claim = spawnSync(
    process.execPath,
    [join(import.meta.dir, "../src/setup/cli.ts"), "claim", "--agent", "--project", project],
    {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        XDG_STATE_HOME: join(parent, "claim-state-home"),
        BROWSER: "secret-canary-browser",
        HUE_API_KEY: "secret-canary-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const claimEvents = claim.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SetupEvent);
  expect(claim.status).toBe(0);
  expect(claim.stderr).toBe("");
  expect(claim.stdout).not.toContain("secret-canary");
  expect(claimEvents.map((event) => event.event)).toEqual([
    "run.started",
    "action.required",
    "run.completed",
  ]);
  expect(claimEvents[0]).toEqual(expect.objectContaining({ command: "claim", mode: "jsonl" }));
  expect(
    claimEvents.filter((event) => event.event === "run.completed" || event.event === "run.failed"),
  ).toHaveLength(1);
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
