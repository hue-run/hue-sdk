#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { parseArgs } from "node:util";
import { FileSetupCheckpointAdapter, setupRunId } from "./checkpoint.js";
import { detectSetupProject } from "./detect.js";
import {
  renderHumanEvent,
  renderJsonlEvent,
  renderPlainEvent,
  selectSetupOutputMode,
  type SetupOutputMode,
} from "./render.js";
import { runSetup } from "./runner.js";
import { SETUP_EVENT_CONTRACT_VERSION, type RunFailedEvent, type SetupEvent } from "./types.js";

const commands = new Set(["setup", "resume", "status", "connect"] as const);

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
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch {
    if (!agentRequested) {
      process.stderr.write(
        "Usage: hue <setup|resume|status|connect> [--agent|--format plain|jsonl] [--project PATH]\n",
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
      "Usage: hue <setup|resume|status|connect> [--agent|--format plain|jsonl] [--project PATH]\n",
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
    (parsed.values.agent && format !== undefined && format !== "jsonl")
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
        "Usage: hue <setup|resume|status|connect> [--agent|--format plain|jsonl] [--project PATH]\n",
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
    await runSetup({
      command: command as "setup" | "resume" | "status" | "connect",
      mode,
      runId: setupRunId(root),
      projectRoot: root,
      project: { detect: detectSetupProject },
      checkpoints: new FileSetupCheckpointAdapter(),
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
