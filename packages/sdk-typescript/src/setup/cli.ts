#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { parseArgs } from "node:util";
import { FileSetupCheckpointAdapter, setupRunId } from "./checkpoint.js";
import { SetupBackendAdapter } from "./backend.js";
import { detectSetupProject } from "./detect.js";
import { loadCommand, MissingPeerError } from "./peers.js";
import {
  renderHumanEvent,
  renderJsonlEvent,
  renderPlainEvent,
  selectSetupOutputMode,
  type SetupOutputMode,
} from "./render.js";
import { runSetup } from "./runner.js";
import { SETUP_EVENT_CONTRACT_VERSION, type RunFailedEvent, type SetupEvent } from "./types.js";

const commands = new Set(["setup", "resume", "status", "claim"] as const);

// Additional commands live in ../cli and load lazily so the setup parser, its usage text and its
// JSONL error contract stay untouched for every other input. Add a command with one entry.
const extensions = new Map<string, () => Promise<number>>([
  [
    "eval",
    async () =>
      (await loadCommand("eval", () => import("../cli/eval.js"))).runEvalCommand(
        process.argv.slice(3),
      ),
  ],
  [
    "login",
    async () =>
      (await loadCommand("login", () => import("../cli/login.js"))).runLoginCommand(
        process.argv.slice(3),
      ),
  ],
  [
    "mcp",
    async () =>
      (await loadCommand("mcp", () => import("../cli/mcp.js"))).runMcpCommand(
        process.argv.slice(3),
      ),
  ],
]);

function writeEvent(event: SetupEvent, mode: SetupOutputMode, width: number): void {
  const line =
    mode === "jsonl"
      ? renderJsonlEvent(event)
      : mode === "plain"
        ? renderPlainEvent(event, width)
        : renderHumanEvent(event, width, true);
  if (line) process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  const extension = extensions.get(process.argv[2] ?? "");
  if (extension) {
    try {
      return await extension();
    } catch (error) {
      if (!(error instanceof MissingPeerError)) throw error;
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
  }
  const agentRequested = process.argv.slice(2).includes("--agent");
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: {
        agent: { type: "boolean", default: false },
        format: { type: "string" },
        project: { type: "string" },
        origin: { type: "string" },
        restart: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch {
    if (!agentRequested) {
      process.stderr.write(
        "Usage: hue <setup|resume|status|claim|login|eval|mcp> [--agent|--format human|plain|jsonl] [--project PATH] [--origin URL] [--restart]\n",
      );
      return 2;
    }
    const event: RunFailedEvent = {
      contractVersion: SETUP_EVENT_CONTRACT_VERSION,
      event: "run.failed",
      runId: "setup_invalid_command",
      sequence: 1,
      timestamp: new Date().toISOString(),
      code: "invalid_arguments",
      message: "Invalid command arguments.",
      resumable: false,
    };
    process.stdout.write(`${renderJsonlEvent(event)}\n`);
    return 2;
  }
  if (parsed.values.help) {
    if (parsed.values.agent) {
      const event: RunFailedEvent = {
        contractVersion: SETUP_EVENT_CONTRACT_VERSION,
        event: "run.failed",
        runId: "setup_help",
        sequence: 1,
        timestamp: new Date().toISOString(),
        code: "help_requested",
        message: "Use hue --help without --agent to read interactive help.",
        resumable: false,
      };
      process.stdout.write(`${renderJsonlEvent(event)}\n`);
      return 2;
    }
    process.stdout.write(
      "Usage: hue <setup|resume|status|claim|login|eval|mcp> [--agent|--format human|plain|jsonl] [--project PATH] [--origin URL] [--restart]\n",
    );
    return 0;
  }
  const command = parsed.positionals[0];
  const format = parsed.values.format;
  const validFormat =
    format === undefined || format === "human" || format === "plain" || format === "jsonl";
  if (
    !command ||
    !commands.has(command as "setup") ||
    parsed.positionals.length !== 1 ||
    !validFormat ||
    (parsed.values.agent && format !== undefined && format !== "jsonl") ||
    (parsed.values.restart &&
      (command !== "claim" ||
        parsed.values.agent ||
        format === "plain" ||
        format === "jsonl" ||
        !process.stdin.isTTY ||
        !process.stdout.isTTY))
  ) {
    if (parsed.values.agent) {
      const event: RunFailedEvent = {
        contractVersion: SETUP_EVENT_CONTRACT_VERSION,
        event: "run.failed",
        runId: "setup_invalid_command",
        sequence: 1,
        timestamp: new Date().toISOString(),
        code: "invalid_arguments",
        message: "Invalid command arguments.",
        resumable: false,
      };
      process.stdout.write(`${renderJsonlEvent(event)}\n`);
    } else
      process.stderr.write(
        "Usage: hue <setup|resume|status|claim|login|eval|mcp> [--agent|--format human|plain|jsonl] [--project PATH] [--origin URL] [--restart]\n",
      );
    return 2;
  }
  const mode = selectSetupOutputMode({
    agent: parsed.values.agent,
    explicit: format as SetupOutputMode | undefined,
    isTTY: process.stdout.isTTY,
    env: process.env,
  });
  const width = Math.max(24, process.stdout.columns ?? 80);
  const controller = new AbortController();
  let terminalEmitted = false;
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const root = await realpath(parsed.values.project ?? process.cwd());
    const backend = new SetupBackendAdapter({
      projectRoot: root,
      ...(parsed.values.origin ? { origin: parsed.values.origin } : {}),
    });
    await runSetup({
      command: command as "setup" | "resume" | "status" | "claim",
      mode,
      runId: setupRunId(root),
      projectRoot: root,
      project: { detect: detectSetupProject },
      checkpoints: new FileSetupCheckpointAdapter(),
      backend,
      claimRestart: parsed.values.restart,
      signal: controller.signal,
      emit: (event) => {
        if (event.event === "run.completed" || event.event === "run.failed") terminalEmitted = true;
        writeEvent(event, mode, width);
      },
    });
    return 0;
  } catch {
    if (mode === "jsonl" && !terminalEmitted) {
      const event: RunFailedEvent = {
        contractVersion: SETUP_EVENT_CONTRACT_VERSION,
        event: "run.failed",
        runId: "setup_preflight_failed",
        sequence: 1,
        timestamp: new Date().toISOString(),
        code: "setup_failed",
        message: "Setup session could not start. Check the project path and local state directory.",
        resumable: false,
      };
      process.stdout.write(`${renderJsonlEvent(event)}\n`);
    } else if (mode !== "jsonl" && !terminalEmitted) {
      process.stderr.write(
        "Setup session could not start. Check the project path and local state directory.\n",
      );
    }
    return controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

process.exitCode = await main();
