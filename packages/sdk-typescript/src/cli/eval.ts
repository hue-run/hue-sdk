import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { createHue, type HueClient } from "../client.js";
import { createEnvironmentClient } from "../environment/client.js";
import type { EnvironmentTool } from "../environment/tools.js";
import {
  agentEnvironment,
  isHueControlPlaneCredential,
  stripHueControlPlaneCredentials,
  writeMcpConfig,
} from "../environment/world.js";
import { EvaluationClient, HueApiError } from "../evals/client.js";
import type {
  ExperimentCase,
  LocalAgentClaim,
  LocalAgentRegistration,
  LocalFile,
  OutputFile,
  RegisteredLocalAgent,
  Scorer,
  ScorerVersion,
} from "../evals/types.js";
import { TargetResult } from "../evals/types.js";
import { CheckpointIdentityError, CheckpointStore } from "../evals/checkpoint.js";
import { onForcedExit, runForcedExitCleanups } from "../evals/exit-cleanup.js";
import { digest } from "../evals/json.js";
import { runLocalAgent } from "../evals/local-worker.js";
import {
  describeTelemetryIssues,
  runExperiment,
  TargetCancelledError,
  TELEMETRY_NOT_ACCEPTED,
  telemetryIssueCounts,
  type RunnerReport,
  type TelemetryNotAccepted,
} from "../evals/runner.js";
import { HueExportError } from "../transport.js";
import {
  matchByName,
  parseScenarioSelector,
  resolveEvalSetPins,
  resolveScenarioPins,
  type ScenarioPins,
} from "../evals/scenarios.js";
import { collectDirectOutputs, stageDirectCase } from "./eval-direct.js";
import {
  runSimulation,
  type SimulationProgress,
  type SimulationTargetContext,
} from "../evals/simulation.js";
import {
  collectExperimentVerdicts,
  compareVerdicts,
  metricPassed,
  type CaseVerdict,
  type ExperimentVerdicts,
  type VerdictComparison,
} from "../evals/verdicts.js";
import type { JsonValue } from "../types.js";
import { envFileArgument, envFileOptions } from "./env-file.js";

/** Adapter contract: the module's `default` or `runMyAgent` export. */
export type EvalAdapter = (
  inputs: JsonValue,
  context: SimulationTargetContext,
) => JsonValue | TargetResult | undefined | Promise<JsonValue | TargetResult | undefined>;

/**
 * Context of a direct (file) case: pinned input files in, generated documents out. The same
 * adapter module serves both modes; `mode` tells it which context it received.
 */
export interface DirectTargetContext {
  mode: "direct";
  config: JsonValue;
  item: Pick<ExperimentCase, "id" | "externalKey">;
  executionId: string;
  /** Verified copies of the agent-visible pinned files (`source`, templates, originals). */
  files: LocalFile[];
  /** Private scratch directory for this case; generated files may be written here. */
  outputDirectory: string;
  signal?: AbortSignal;
}
export type DirectEvalAdapter = (
  inputs: JsonValue,
  context: DirectTargetContext,
) => JsonValue | TargetResult | undefined | Promise<JsonValue | TargetResult | undefined>;
/** What an adapter file exports: one function that receives whichever context the case kind needs. */
type LoadedAdapter = (
  inputs: JsonValue,
  context: SimulationTargetContext | DirectTargetContext,
) => JsonValue | TargetResult | undefined | Promise<JsonValue | TargetResult | undefined>;

const USAGE = `Usage: hue eval [adapter-file] [options]

Run a local agent against a published case or eval set, then print Hue's verdicts.

Selection (exactly one, not used with --worker):
  --case <name|id|url>            Published case to run
  --scenario <name|id|url>        Legacy alias for --case
  --set <name|id|url>             Saved eval set; requires --scorer or --scorer-version
  --set-version <n>               Saved version number of the eval set (default: latest saved)
  --dataset-version <id>          Frozen dataset version; requires --scorer or --scorer-version
  --scorer <slug|name|id>         Evaluator to pin at its latest published version (repeatable)
  --scorer-version <id>           Scorer version to pin (repeatable)
  --mode <auto|direct|simulation> Case kind; auto picks direct for sets whose cases pin no world

Agent (exactly one):
  <adapter-file>                  Module exporting default or runMyAgent(inputs, context)
  --command "<shell command>"     Simulation: spawned per case with the world's environment
                                  (HUE_WORLD_ID, HUE_WORLD_TOKEN, one HUE_SIM_<SURFACE>_URL per
                                  provider mirror, HUE_MCP_CONFIG, plus HUE_MCP_URL, HUE_MCP_TOKEN
                                  and HUE_MCP_EXPIRES_AT for the first MCP mirror), HUE_EXECUTION_ID,
                                  HUE_ENVIRONMENT_RUN_ID, HUE_CASE_ID and HUE_CASE_KEY set;
                                  {"inputs","config"} on stdin. HUE_API_KEY and other Hue
                                  control-plane credentials are removed from the child.
                                  HUE_CASE_DIR, HUE_CASE_INPUTS and HUE_CASE_OUTPUT_DIR name the
                                  case directory as for direct cases: the case's agent-visible
                                  files and output/, uploaded after the case
  --allow-hue-credentials         Keep HUE_API_KEY and other Hue control-plane credentials in
                                  the --command child (off by default)
                                  Direct: spawned in a private case directory with HUE_CASE_DIR,
                                  HUE_CASE_INPUTS, HUE_CASE_OUTPUT_DIR, HUE_CASE_ID, HUE_CASE_KEY
                                  and HUE_EXECUTION_ID set; files/<role>/ hold the pinned inputs
                                  and every file written to output/ is uploaded to Hue
                                  Stdout is the case's answer and is stored: print no secrets or
                                  debug logs there (credentials hue eval knows are redacted)

Modes:
  --worker                        Register the agent and poll for runs launched from Hue
  --max-runs <n>                  Stop the worker after n completed runs
  --agent-key <key>               Agent key (default: slug of the adapter filename)
  --agent-name <name>             Agent display name (default: the key)
  --revision <id>                 Agent revision (default: AGENT_REVISION, git HEAD or "dev")
  --capability <value>            Extra capability to register (repeatable), for example
                                  environment-files:v1 and input:pdf for world cases with files

Connection:
  --env-file <path>               Load a dotenv file (HUE_API_KEY, HUE_BASE_URL) first
  --env-path <path>               Same as --env-file
  --origin <url>                  Hue origin (default: HUE_BASE_URL or https://app.hue.run)

Output and limits:
  --name <run name>               Run name (default: <agent key> @ <revision>, hashes shortened)
  --baseline <experiment id|url>  Compare verdicts with a previous experiment
  --json                          Print one JSON document on stdout; progress goes to stderr
  --content                       Capture telemetry content (span inputs, outputs and messages)
  --no-output                     One-shot: do not store case outputs, error messages and
                                  explanations (stored by default; --worker always stores); with
                                  --content the case span still carries the output
  --save-version                  Freeze an unsaved eval-set version before running
  --checkpoint-dir <path>         Private checkpoint directory (default: .hue/eval/<agent-key>)
  --concurrency <n>               Cases in flight, 1-64 (default: 1)
  --timeout <seconds>             Per-case --command timeout (default: 600)
  --wait <seconds>                Verdict wait after the run finishes (default: 300)
  -h, --help                      Show this help

HUE_API_KEY must be a "Read and write" project key; it is never printed.
Code evaluators pinned to a direct run are graded by Hue's executor after the upload; the wait
covers them. Exit codes: 0 every case passed, 1 a case failed, errored or is incomplete,
2 usage error, 130 interrupted.
`;

/** Thrown for invalid arguments or configuration; exits with status 2. */
class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface Output {
  /** Human progress lines: stdout normally, stderr with --json. */
  log(line: string): void;
  /** Diagnostics; always stderr. */
  error(line: string): void;
}

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        case: { type: "string" },
        scenario: { type: "string" },
        set: { type: "string" },
        "set-version": { type: "string" },
        "dataset-version": { type: "string" },
        scorer: { type: "string", multiple: true },
        "scorer-version": { type: "string", multiple: true },
        mode: { type: "string" },
        command: { type: "string" },
        "allow-hue-credentials": { type: "boolean", default: false },
        worker: { type: "boolean", default: false },
        "max-runs": { type: "string" },
        "agent-key": { type: "string" },
        "agent-name": { type: "string" },
        capability: { type: "string", multiple: true },
        revision: { type: "string" },
        ...envFileOptions,
        origin: { type: "string" },
        name: { type: "string" },
        baseline: { type: "string" },
        json: { type: "boolean", default: false },
        content: { type: "boolean", default: false },
        "no-output": { type: "boolean", default: false },
        "save-version": { type: "boolean", default: false },
        "checkpoint-dir": { type: "string" },
        concurrency: { type: "string" },
        timeout: { type: "string" },
        wait: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "Invalid arguments");
  }
}

function integer(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new UsageError(`--${name} must be an integer between ${min} and ${max}`);
  return parsed;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

const INTERPRETERS = new Set([
  "node",
  "nodejs",
  "bun",
  "bunx",
  "deno",
  "npx",
  "pnpx",
  "yarn",
  "pnpm",
  "npm",
  "tsx",
  "ts-node",
  "python",
  "python3",
  "uv",
  "uvx",
  "sh",
  "bash",
  "zsh",
  "env",
]);

/** Agent key from the adapter filename, or the first script-like token of a command. */
function derivedAgentKey(adapterFile: string | undefined, command: string | undefined): string {
  if (adapterFile) return slug(basename(adapterFile, extname(adapterFile)));
  const tokens = (command ?? "").trim().split(/\s+/);
  const names = tokens.map((token) => token.split(/[\\/]/).pop() ?? "");
  const script =
    names.find((name) => name && !name.startsWith("-") && !INTERPRETERS.has(name.toLowerCase())) ??
    names[0] ??
    "";
  return slug(basename(script, extname(script)));
}

function defaultRunName(agent: { key: string; revision: string }): string {
  const revision = /^[0-9a-f]{12,64}$/i.test(agent.revision)
    ? agent.revision.slice(0, 7)
    : agent.revision;
  return `${agent.key} @ ${revision}`;
}

function gitRevision(): string | undefined {
  try {
    const value = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return /^[0-9a-f]{7,40}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function loadAdapter(file: string): Promise<LoadedAdapter> {
  const path = resolve(file);
  try {
    await access(path);
  } catch {
    throw new UsageError(`Adapter file not found: ${file}`);
  }
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const hint =
      code === "ERR_UNKNOWN_FILE_EXTENSION" ||
      code === "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING"
        ? " (this Node.js version needs --experimental-strip-types or --import tsx for TypeScript adapters; non-erasable syntax such as enums or parameter properties always needs a loader)"
        : "";
    throw new Error(
      `Unable to load the adapter ${file}: ${error instanceof Error ? error.message : String(error)}${hint}`,
    );
  }
  const candidate = loaded.default ?? loaded.runMyAgent;
  if (typeof candidate !== "function")
    throw new UsageError(`${file} must export a default function or runMyAgent(inputs, context)`);
  return candidate as LoadedAdapter;
}

/** Grace between the stop signal and SIGKILL for an agent command that ignores SIGTERM. */
const COMMAND_KILL_GRACE_MS = 5_000;
/** How long after SIGKILL a stopped command waits for its group to be gone before settling. A
 * killed process that nobody reaps stays in the group as a zombie, which can no longer run. */
const COMMAND_REAP_MS = 2_000;

/** An agent command that has not settled: a repeated interrupt kills it at once, and the CLI
 * keeps its signal handlers until every one has settled. */
interface RunningCommand {
  stop(): void;
  kill(): void;
  settled: Promise<void>;
}
const runningCommands = new Set<RunningCommand>();

/** Stops every agent command still running and resolves once each has settled. */
async function settleCommands(): Promise<void> {
  for (const command of runningCommands) command.stop();
  while (runningCommands.size) await Promise.all([...runningCommands].map((c) => c.settled));
}

function warn(message: string) {
  process.stderr.write(`Warning: ${message}\n`);
}

/**
 * Spawns the agent command once in its own process group and returns its trimmed stdout. A
 * timeout or Ctrl+C stops the agent the shell started, not only the shell: a survivor would still
 * hold a world token and could write after Hue recorded the case as failed. The group is signalled
 * even once the shell has exited, since a compound command's agent can outlive it, and a stopped
 * command settles only when nothing in the group is left. A command that exits normally but
 * leaves processes behind has them stopped the same way before it settles, so none can touch its
 * outputs while they are collected. Once the group is found empty it is never signalled again,
 * since its ID could be reused. Windows has no process group to signal, so the child alone is
 * stopped there.
 */
export function spawnAgentCommand(
  command: string,
  options: {
    cwd?: string;
    env: Record<string, string | undefined>;
    stdin?: string;
    timeoutSeconds: number;
    signal?: AbortSignal;
  },
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const group = process.platform !== "win32";
    const child = spawn(command, {
      shell: true,
      detached: group,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let oversized = false;
    let stopping = false;
    let stopped = false;
    let settled = false;
    let groupGone = false;
    let poll: NodeJS.Timeout | undefined;
    let watch: NodeJS.Timeout | undefined;
    let closed: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let warned = false;
    /** Records a vanished group; any other failure to signal it is reported, once. */
    const gone = (error: unknown, signal: NodeJS.Signals | 0) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") groupGone = true;
      else if (!warned) {
        warned = true;
        warn(`could not signal the agent command's process group (${signal}, ${code})`);
      }
    };
    /** Whether anything the command started is left: its whole group, or the child alone. */
    const running = () => {
      if (!group || child.pid === undefined)
        return child.exitCode === null && child.signalCode === null;
      if (groupGone) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        gone(error, 0);
        return !groupGone;
      }
    };
    const signalTree = (signal: NodeJS.Signals) => {
      if (group && child.pid !== undefined) {
        if (groupGone) return;
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          gone(error, signal);
        }
      } else if (running()) child.kill(signal);
    };
    /** SIGTERM, then SIGKILL for whatever is still running when the grace ends; the command
     * settles once the group is gone. */
    const stop = () => {
      if (stopping || settled) return;
      stopping = true;
      clearTimeout(timer);
      signalTree("SIGTERM");
      const killAt = Date.now() + COMMAND_KILL_GRACE_MS;
      let reapBy: number | undefined;
      poll = setInterval(() => {
        const left = running();
        if (left && reapBy === undefined && Date.now() >= killAt) {
          signalTree("SIGKILL");
          reapBy = Date.now() + COMMAND_REAP_MS;
        }
        if (left && (reapBy === undefined || Date.now() < reapBy)) return;
        clearInterval(poll);
        if (left) warn("the agent command's process group still has members after SIGKILL");
        stopped = true;
        settle();
      }, 50);
    };
    let markSettled = () => {};
    const handle: RunningCommand = {
      stop,
      kill: () => signalTree("SIGKILL"),
      settled: new Promise<void>((done) => (markSettled = done)),
    };
    runningCommands.add(handle);
    const release = () => {
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      clearInterval(watch);
      options.signal?.removeEventListener("abort", cancel);
      runningCommands.delete(handle);
      markSettled();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutSeconds * 1000);
    const cancel = () => stop();
    options.signal?.addEventListener("abort", cancel, { once: true });
    // An abort that landed before the listener existed still stops the command.
    if (options.signal?.aborted) stop();
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > 4 * 1024 * 1024) {
        oversized = true;
        stop();
        return;
      }
      chunks.push(chunk);
    });
    child.stdin.on("error", () => undefined);
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
    child.on("error", (error) => {
      if (settled) return;
      release();
      reject(new Error(`Unable to start the agent command: ${error.message}`));
    });
    // From the shell's exit, notice the moment its group empties, so a later stop never signals
    // an ID another process may have taken.
    child.on("exit", () => {
      if (!group || !running()) return;
      watch = setInterval(() => {
        if (!running()) clearInterval(watch);
      }, 50).unref();
    });
    /** Settles once the shell's output closed or, after a stop, once its group is gone. A stopped
     * command's output no longer matters, and a process that left the group may hold the pipe. */
    const settle = () => {
      if (settled || (stopping ? !stopped : !closed)) return;
      release();
      if (stopping) {
        child.stdout.destroy();
        child.stdin.destroy();
      }
      if (options.signal?.aborted) return reject(new TargetCancelledError());
      if (timedOut)
        return reject(
          new Error(`The agent command timed out after ${options.timeoutSeconds} seconds`),
        );
      if (oversized) return reject(new Error("The agent command printed more than 4 MiB"));
      const { code, signal } = closed!;
      if (code !== 0)
        return reject(
          new Error(
            signal
              ? `The agent command was stopped by ${signal}`
              : `The agent command exited with code ${code}`,
          ),
        );
      resolvePromise(Buffer.concat(chunks).toString("utf8").trim());
    };
    child.on("close", (code, signal) => {
      closed = { code, signal };
      // Whatever the command left running is stopped before its answer and files are read, so
      // nothing it started can still write, swap or link files while they are collected.
      if (group && !stopping && running()) return stop();
      settle();
    });
  });
}

function parseAnswer(text: string): JsonValue | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

/**
 * Runs the shell command once per case. The world token and mirror URLs travel only through the
 * child's environment and an owner-only MCP configuration file that is removed after the run;
 * Hue control-plane credentials (`HUE_API_KEY`, `HUE_MCP_KEY`, any `hue_sk_` value) stay with
 * the CLI unless `--allow-hue-credentials` is passed. A world created while the gateway is off
 * still gets the `hue_sim_` capability under the same `HUE_MCP_*` names.
 */
/**
 * Credential values a case's answer must never carry into Hue or a checkpoint: the world token
 * and MCP headers handed to the case, its legacy MCP token and attempt bearers, and every Hue
 * control-plane credential in the CLI's environment, which an in-process adapter can read and
 * `--allow-hue-credentials` hands to a command. Longest first, so a header is replaced whole.
 */
interface CaseCredentials {
  world?: { token?: unknown; mcpConfig?: { mcpServers?: Record<string, { headers?: unknown }> } };
  mcp?: { token?: unknown };
  connectionBundle?: unknown;
}
const MIN_SECRET_LENGTH = 16;
function caseSecrets(context: CaseCredentials): string[] {
  const values = new Set<string>();
  // Hue issues long credentials; a short value would redact ordinary text around it.
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim().length >= MIN_SECRET_LENGTH)
      values.add(value).add(value.trim());
  };
  for (const [name, value] of Object.entries(process.env))
    if (isHueControlPlaneCredential(name, value)) add(value);
  add(context.world?.token);
  for (const server of Object.values(context.world?.mcpConfig?.mcpServers ?? {}))
    if (server.headers && typeof server.headers === "object")
      for (const header of Object.values(server.headers)) add(header);
  add(context.mcp?.token);
  const bearers = (value: unknown, depth: number): void => {
    if (depth > 16 || !value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value))
      if (key === "bearer" || key === "token") add(item);
      else bearers(item, depth + 1);
  };
  bearers(context.connectionBundle, 0);
  return [...values].sort((a, b) => b.length - a.length);
}

/** Each secret's exact value, as written and as JSON escapes it, replaced with `[redacted]`. */
function redactSecrets(text: string, secrets: string[]): string {
  for (const secret of secrets) {
    text = text.replaceAll(secret, "[redacted]");
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) text = text.replaceAll(escaped, "[redacted]");
  }
  return text;
}

const TEXT_CONTENT_TYPES = new Set(["text/plain", "text/csv", "application/json"]);

/** A text document held in memory, cleared of the case's credentials. Other documents, a file
 * declared by path and text that is not UTF-8 are uploaded as written. */
function redactFile(file: OutputFile, secrets: string[]): OutputFile {
  if (!file.bytes || !TEXT_CONTENT_TYPES.has(file.contentType)) return file;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes);
  } catch {
    return file;
  }
  const redacted = redactSecrets(text, secrets);
  return redacted === text ? file : { ...file, bytes: new TextEncoder().encode(redacted) };
}

/** An answer with its strings redacted, keys included. Deeper than any output the runner
 * accepts, a value is left for the runner to refuse. */
function redactAnswer(value: unknown, secrets: string[], depth = 0): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (depth > 64 || !value || typeof value !== "object") return value;
  if (value instanceof TargetResult)
    return new TargetResult(
      redactAnswer(value.output, secrets, depth + 1) as JsonValue | undefined,
      value.files.map((file) => redactFile(file, secrets)),
    );
  if (Array.isArray(value)) return value.map((item) => redactAnswer(item, secrets, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      redactSecrets(key, secrets),
      redactAnswer(item, secrets, depth + 1),
    ]),
  );
}

/** Runs an adapter with its answer and any error it throws cleared of the case's credentials,
 * before either reaches Hue, the case's error message or a checkpoint. */
function redacting<Context, Answer>(
  adapter: (inputs: JsonValue, context: Context) => Answer | Promise<Answer>,
): (inputs: JsonValue, context: Context) => Promise<Answer> {
  return async (inputs, context) => {
    // A direct case's context carries no world; its answer is still cleared of the CLI's own.
    const secrets = caseSecrets(context as CaseCredentials);
    try {
      return redactAnswer(await adapter(inputs, context), secrets) as Answer;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const message = redactSecrets(error.message, secrets);
      if (message === error.message) throw error;
      try {
        error.message = message;
      } catch {
        // A frozen error, or one whose message is a getter, keeps its text; replace it below.
      }
      if (error.message === message) throw error;
      const replacement = new Error(message);
      replacement.name = redactSecrets(String(error.name), secrets);
      throw replacement;
    }
  };
}

/** The parent environment an agent child starts from: without Hue control-plane credentials
 * unless `--allow-hue-credentials` was passed. */
function parentEnvironment(allowHueCredentials: boolean): Record<string, string> {
  return allowHueCredentials
    ? Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      )
    : stripHueControlPlaneCredentials(process.env);
}

function commandAdapter(
  command: string,
  timeoutSeconds: number,
  options: { allowHueCredentials: boolean },
): EvalAdapter {
  return async (inputs, context) => {
    const parent = parentEnvironment(options.allowHueCredentials);
    // The case directory direct cases get: inputs, the verified agent-visible files and
    // output/. It holds no world credential and the runner removes it after the case.
    const layout = await stageDirectCase(context.outputDirectory, {
      inputs,
      config: context.config,
      item: context.item,
      executionId: context.executionId,
      files: context.files,
    });
    const identity = {
      HUE_EXECUTION_ID: context.executionId,
      HUE_ENVIRONMENT_RUN_ID: context.environmentRunId,
      HUE_CASE_ID: context.item.id,
      HUE_CASE_KEY: context.item.externalKey,
      HUE_CASE_DIR: layout.caseDirectory,
      HUE_CASE_INPUTS: layout.inputsPath,
      HUE_CASE_OUTPUT_DIR: layout.outputDirectory,
    };
    // The token-bearing file is written inside a private directory registered before any of it
    // exists, so a forced exit at any point removes it.
    const configDirectory = context.world
      ? mkdtempSync(join(tmpdir(), "hue-mcp-config-"))
      : undefined;
    const untrack = configDirectory
      ? onForcedExit(() => rmSync(configDirectory, { recursive: true, force: true }))
      : undefined;
    try {
      const configFile = context.world
        ? await writeMcpConfig(context.world, { directory: configDirectory })
        : undefined;
      const env = context.world
        ? {
            ...agentEnvironment(context.world, { parent, includeHueCredentials: true }),
            ...identity,
            HUE_MCP_CONFIG: configFile!.path,
          }
        : {
            ...parent,
            ...(context.mcp
              ? {
                  HUE_MCP_URL: context.mcp.url,
                  HUE_MCP_TOKEN: context.mcp.token,
                  HUE_MCP_EXPIRES_AT: context.mcp.expiresAt,
                }
              : {}),
            ...identity,
          };
      const stdout = await spawnAgentCommand(command, {
        env,
        stdin: JSON.stringify({ inputs, config: context.config }),
        timeoutSeconds,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      return collectDirectOutputs(layout.outputDirectory, parseAnswer(stdout));
    } finally {
      if (configDirectory) await rm(configDirectory, { recursive: true, force: true });
      untrack?.();
    }
  };
}

/**
 * Direct cases: the command works in a private case directory and writes its documents to
 * `output/`. Its stdout is only used as the JSON output when it wrote no result or summary file.
 */
function directCommandAdapter(
  command: string,
  timeoutSeconds: number,
  options: { allowHueCredentials: boolean },
): DirectEvalAdapter {
  return async (inputs, context) => {
    const layout = await stageDirectCase(context.outputDirectory, {
      inputs,
      config: context.config,
      item: context.item,
      executionId: context.executionId,
      files: context.files,
    });
    const stdout = await spawnAgentCommand(command, {
      cwd: layout.caseDirectory,
      env: {
        ...parentEnvironment(options.allowHueCredentials),
        HUE_CASE_DIR: layout.caseDirectory,
        HUE_CASE_INPUTS: layout.inputsPath,
        HUE_CASE_OUTPUT_DIR: layout.outputDirectory,
        HUE_CASE_ID: context.item.id,
        HUE_CASE_KEY: context.item.externalKey,
        HUE_EXECUTION_ID: context.executionId,
      },
      stdin: JSON.stringify({ inputs, config: context.config }),
      timeoutSeconds,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return collectDirectOutputs(layout.outputDirectory, parseAnswer(stdout));
  };
}

function metricText(metric: CaseVerdict["metrics"][number]): string {
  if (typeof metric.value === "boolean") return metricPassed(metric) ? "PASS" : "FAIL";
  if (typeof metric.value === "number")
    return Number.isInteger(metric.value) ? String(metric.value) : metric.value.toFixed(3);
  const text = metric.value.replace(/\s+/g, " ");
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

const STATE_LABEL: Record<CaseVerdict["state"], string> = {
  passed: "PASSED",
  failed: "FAILED",
  error: "ERROR",
  skipped: "SKIPPED",
  pending: "PENDING",
};

export function renderTable(verdicts: ExperimentVerdicts, output: Output): void {
  const names: string[] = [];
  // The evaluators that report each metric: a case none of them applies to shows n/a there, and
  // one an evaluator applies to without reporting the metric shows "-".
  const reportedBy = new Map<string, Set<string>>();
  for (const item of verdicts.summary.cases)
    for (const metric of item.metrics) {
      if (!names.includes(metric.name)) names.push(metric.name);
      reportedBy.set(
        metric.name,
        (reportedBy.get(metric.name) ?? new Set()).add(metric.scorerVersionId),
      );
    }
  const header = ["Case", ...names, "Result"];
  const rows = verdicts.summary.cases.map((item) => [
    item.externalKey,
    ...names.map((name) => {
      const metric = item.metrics.find((candidate) => candidate.name === name);
      if (metric) return metricText(metric);
      const notApplicable = new Set(item.notApplicable);
      return [...reportedBy.get(name)!].every((version) => notApplicable.has(version))
        ? "n/a"
        : "-";
    }),
    STATE_LABEL[item.state],
  ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index]!.length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index]!))
      .join("  ")
      .trimEnd();
  output.log(line(header));
  output.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) output.log(line(row));
  for (const item of verdicts.summary.cases) {
    if (item.state === "passed") continue;
    const details = [...item.errors.map((type) => `scorer error ${type}`), ...item.explanations];
    for (const detail of details.length ? details : [STATE_LABEL[item.state].toLowerCase()])
      output.log(`  ${item.externalKey}: ${detail}`);
  }
  const totals = verdicts.summary.totals;
  const extra = [
    totals.error ? `${totals.error} error` : "",
    totals.skipped ? `${totals.skipped} skipped` : "",
    totals.pending ? `${totals.pending} pending` : "",
    totals.notApplicable
      ? `${totals.notApplicable} evaluator result${totals.notApplicable === 1 ? "" : "s"} not applicable`
      : "",
  ].filter(Boolean);
  output.log(
    `${totals.passed} of ${totals.cases} case${totals.cases === 1 ? "" : "s"} passed${extra.length ? ` (${extra.join(", ")})` : ""}`,
  );
  if (!verdicts.results.complete)
    output.log("Hue checks are still running; rerun with a longer --wait or open the run URL.");
}

function renderComparison(baselineId: string, comparison: VerdictComparison, output: Output): void {
  output.log(
    `Baseline ${baselineId}: ${comparison.improvements} improved, ${comparison.regressions} regressed, ${comparison.unchanged} unchanged`,
  );
  for (const item of comparison.cases)
    if (item.change !== "unchanged")
      output.log(`  ${item.externalKey}: ${item.before} -> ${item.after} (${item.change})`);
}

function redact(message: string, secrets: string[]): string {
  let text = message;
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[redacted]");
  return text;
}

export function explain(error: unknown): string {
  if (error instanceof HueApiError && (error.status === 401 || error.status === 403))
    return `${error.message}. Check that HUE_API_KEY is a "Read and write" project key for this origin.`;
  // An unfinished run keeps the content policy it started with; name the flags that resume it.
  if (error instanceof CheckpointIdentityError && error.startedWith) {
    const flags = [
      error.startedWith.persistResultContent === false ? "--no-output" : "",
      error.startedWith.captureContent === true ? "--content" : "",
    ].filter(Boolean);
    return `This unfinished run was started ${flags.length ? `with ${flags.join(" and ")}` : "without --no-output or --content"}; rerun with the same flags to resume it, or remove its checkpoint directory to start over`;
  }
  // The error's own message points at an in-memory report the user cannot reach.
  if (error instanceof HueExportError)
    return `Hue could not accept all telemetry (${describeTelemetryIssues(telemetryIssueCounts(error))})`;
  if (error instanceof Error) {
    const causes: string[] = [];
    let cause: unknown = error.cause;
    while (cause instanceof Error && causes.length < 3) {
      causes.push(cause.message);
      cause = cause.cause;
    }
    return causes.length ? `${error.message} (${causes.join("; ")})` : error.message;
  }
  return String(error);
}

/** `.hue/eval/<agent-key>/<project>/<leaf>` unless overridden; the SDK binds each store to one
 * project and origin, so switching keys or deployments must not collide. */
async function prepareCheckpointDirectory(
  explicit: string | undefined,
  agentKey: string,
  projectId: string,
  leaf: string,
): Promise<string> {
  if (explicit) return join(resolve(explicit), projectId, leaf);
  const root = resolve(".hue", "eval");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const ignore = join(root, ".gitignore");
  try {
    await access(ignore);
  } catch {
    await writeFile(ignore, "*\n", { flag: "wx", mode: 0o600 }).catch(() => undefined);
  }
  return join(root, agentKey, projectId, leaf);
}

/** Worker-side client that reports registration and claims without changing the worker. */
class ObservedClient extends EvaluationClient {
  registered = false;
  onRegistered?: (agent: RegisteredLocalAgent) => void;
  onClaimed?: (claim: LocalAgentClaim) => void;
  override async registerLocalAgent(input: LocalAgentRegistration) {
    const agent = await super.registerLocalAgent(input);
    if (!this.registered) {
      this.registered = true;
      this.onRegistered?.(agent);
    }
    return agent;
  }
  override async claimLocalAgentRun(input: { agentId: string; workerId: string }) {
    const claim = await super.claimLocalAgentRun(input);
    if (claim) this.onClaimed?.(claim);
    return claim;
  }
}

interface Connection {
  apiKey: string;
  baseUrl: string;
}

const MAX_LISTED_SCORERS = 1000;

/** Newest published version of an evaluator named by ID, slug or display name. */
async function resolveScorerVersion(client: EvaluationClient, selector: string): Promise<string> {
  const parsed = parseScenarioSelector(selector, ["scorers", "evaluators"]);
  let scorer: Scorer;
  if (parsed.kind === "id") scorer = await client.getScorer(parsed.id);
  else {
    const candidates: Scorer[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await client.listScorers({ after, limit: 100 });
      candidates.push(...page.items.filter((item) => !item.archivedAt));
      if (!page.nextCursor || candidates.length >= MAX_LISTED_SCORERS) break;
      after = page.nextCursor;
    }
    const wanted = parsed.name.trim().toLowerCase();
    const bySlug = candidates.filter((item) => item.slug.toLowerCase() === wanted);
    const { matches } = bySlug.length ? { matches: bySlug } : matchByName(candidates, parsed.name);
    if (matches.length > 1)
      throw new UsageError(
        `Several evaluators match "${parsed.name}"; pass a slug or ID: ${matches.map((item) => item.slug).join(", ")}`,
      );
    if (!matches.length)
      throw new UsageError(
        candidates.length
          ? `No evaluator matches "${parsed.name}". Evaluators: ${candidates.map((item) => item.slug).join(", ")}`
          : `No evaluator matches "${parsed.name}"`,
      );
    scorer = await client.getScorer(matches[0]!.id);
  }
  const versions = scorer.versions ?? [];
  if (!versions.length)
    throw new UsageError(`Evaluator "${scorer.slug}" has no published version to pin`);
  // Servers list versions newest first; prefer the version number when the response carries it.
  const latest = versions.reduce<ScorerVersion & { version?: number }>(
    (best, item) => {
      const candidate = item as ScorerVersion & { version?: number };
      return best.version !== undefined && candidate.version !== undefined
        ? candidate.version > best.version
          ? candidate
          : best
        : best;
    },
    versions[0] as ScorerVersion & { version?: number },
  );
  return latest.id;
}

async function resolveSelection(
  client: EvaluationClient,
  values: ReturnType<typeof parse>["values"],
): Promise<ScenarioPins> {
  const extra = [...(values["scorer-version"] ?? [])];
  for (const selector of values.scorer ?? [])
    extra.push(await resolveScorerVersion(client, selector));
  const caseSelector = values.case ?? values.scenario;
  if (caseSelector) {
    if (values["set-version"]) throw new UsageError("--set-version applies to --set only");
    const pins = await resolveScenarioPins(client, caseSelector);
    pins.scorerVersionIds = [...new Set([...pins.scorerVersionIds, ...extra])];
    return pins;
  }
  if (!extra.length)
    throw new UsageError(
      `${values.set ? "--set" : "--dataset-version"} needs at least one --scorer or --scorer-version; use --case for published pins`,
    );
  if (values.set) {
    const pins = await resolveEvalSetPins(client, values.set, { scorerVersionIds: extra });
    if (values["set-version"] === undefined) return pins;
    const wanted = integer("set-version", values["set-version"], 1, 1, 1_000_000);
    const dataset = await client.getDataset(pins.datasetId);
    const version = dataset.versions.find((item) => item.version === wanted);
    if (!version)
      throw new UsageError(
        `Eval set "${dataset.name}" has no version ${wanted}; versions: ${dataset.versions.map((item) => item.version).join(", ")}`,
      );
    return {
      ...pins,
      datasetVersionId: version.id,
      saved: version.frozenAt !== null,
      revision: version.revision,
    };
  }
  if (values["set-version"]) throw new UsageError("--set-version applies to --set only");
  const version = await client.getDatasetVersion(values["dataset-version"]!);
  const dataset = await client.getDataset(version.datasetId);
  return {
    scenarioId: null,
    name: dataset.name,
    datasetId: dataset.id,
    datasetVersionId: version.id,
    scorerVersionIds: [...new Set(extra)],
    environmentVersionId: null,
    saved: version.frozenAt !== null,
    revision: version.revision,
  };
}

type RunMode = "auto" | "direct" | "simulation";

function parseMode(value: string | undefined): RunMode {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "direct" || value === "simulation") return value;
  throw new UsageError("--mode must be auto, direct or simulation");
}

/** Direct when nothing pins a simulated world: not a Scenario, and no case of the version does. */
async function detectDirect(
  client: EvaluationClient,
  pins: ScenarioPins,
  mode: RunMode,
): Promise<boolean> {
  if (mode !== "auto") return mode === "direct";
  if (pins.scenarioId || pins.environmentVersionId) return false;
  let after: string | undefined;
  do {
    const page = await client.listCases(pins.datasetVersionId, { after });
    if (page.items.some((item) => item.environmentVersionId)) return false;
    after = page.nextCursor ?? undefined;
  } while (after);
  return true;
}

function toJson(
  verdicts: ExperimentVerdicts,
  runUrl: string,
  baseline?: { experimentId: string; comparison: VerdictComparison },
  extra: Record<string, JsonValue> = {},
  telemetry: TelemetryNotAccepted[] = [],
) {
  const notAccepted = new Map(telemetry.map((entry) => [entry.caseId, entry.issues]));
  return {
    experimentId: verdicts.experimentId,
    runId: verdicts.runId,
    runUrl,
    complete: verdicts.results.complete,
    cases: verdicts.summary.cases.map((item) =>
      notAccepted.has(item.caseId)
        ? {
            ...item,
            telemetry: { code: TELEMETRY_NOT_ACCEPTED, issues: notAccepted.get(item.caseId)! },
          }
        : item,
    ),
    totals: verdicts.summary.totals,
    ...extra,
    ...(baseline
      ? { baseline: { experimentId: baseline.experimentId, ...baseline.comparison } }
      : {}),
  };
}

/** Says, once per execution, that a case failed because Hue did not accept its telemetry, with
 * sanitized counts: as the case completes, or from the report for a case an earlier, interrupted
 * run completed. */
function telemetryReporter(output: Output) {
  const reported = new Set<string>();
  const report = (entry: TelemetryNotAccepted) => {
    if (reported.has(entry.executionId)) return;
    reported.add(entry.executionId);
    output.error(
      `[${entry.caseKey}] telemetry not accepted, case failed: ${describeTelemetryIssues(entry.issues)}`,
    );
  };
  return {
    report,
    rest: (entries: TelemetryNotAccepted[] | undefined) => entries?.forEach(report),
  };
}

/** A case without trace evidence fails whatever its scores say: a scorer that grades only the
 * world or ignores the execution state could still pass it. */
function withTelemetryFailures(
  verdicts: ExperimentVerdicts,
  telemetry: TelemetryNotAccepted[] = [],
): ExperimentVerdicts {
  if (!telemetry.length) return verdicts;
  const failed = new Set(telemetry.map((entry) => entry.caseId));
  const cases = verdicts.summary.cases.map((item) =>
    failed.has(item.caseId) ? { ...item, state: "error" as const, passed: false } : item,
  );
  const totals = {
    cases: cases.length,
    passed: 0,
    failed: 0,
    error: 0,
    skipped: 0,
    pending: 0,
    notApplicable: verdicts.summary.totals.notApplicable,
  };
  for (const item of cases) totals[item.state]++;
  return { ...verdicts, summary: { cases, totals } };
}

/** Waits for Hue's verdicts, prints them (table or JSON, with the optional baseline) and returns the exit code. */
async function reportVerdicts(
  client: EvaluationClient,
  values: ReturnType<typeof parse>["values"],
  run: {
    experimentId: string;
    subjectIds: string[];
    runUrl: string;
    extra?: Record<string, JsonValue>;
    telemetryNotAccepted?: TelemetryNotAccepted[];
  },
  baselineId: string | undefined,
  output: Output,
  signal: AbortSignal,
): Promise<number> {
  const wait = integer("wait", values.wait, 300, 0, 86_400);
  output.log("Waiting for Hue checks...");
  const verdicts = withTelemetryFailures(
    await collectExperimentVerdicts(client, {
      experimentId: run.experimentId,
      subjectIds: run.subjectIds,
      timeoutMillis: wait * 1000,
      signal,
    }),
    run.telemetryNotAccepted,
  );
  // The wait returns its partial state on abort rather than throwing, so Ctrl+C here must not
  // fall through to a baseline read and a verdict table that nobody asked to finish.
  if (signal.aborted) {
    process.stderr.write("Interrupted.\n");
    return 130;
  }
  let baseline: { experimentId: string; comparison: VerdictComparison } | undefined;
  if (baselineId) {
    const previous = await collectExperimentVerdicts(client, {
      experimentId: baselineId,
      timeoutMillis: 0,
    });
    baseline = {
      experimentId: baselineId,
      comparison: compareVerdicts(verdicts.summary, previous.summary),
    };
  }
  if (values.json) {
    process.stdout.write(
      `${JSON.stringify(toJson(verdicts, run.runUrl, baseline, run.extra, run.telemetryNotAccepted))}\n`,
    );
  } else {
    renderTable(verdicts, output);
    if (baseline) renderComparison(baseline.experimentId, baseline.comparison, output);
    output.log(`Run: ${run.runUrl}`);
  }
  const totals = verdicts.summary.totals;
  if (run.telemetryNotAccepted?.length) return 1;
  return verdicts.results.complete && totals.cases > 0 && totals.passed === totals.cases ? 0 : 1;
}

function parseBaseline(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = parseScenarioSelector(value, ["experiments"]);
  if (parsed.kind !== "id")
    throw new UsageError("--baseline must be an experiment ID or its Hue URL");
  return parsed.id;
}

interface Agents {
  simulation: EvalAdapter;
  direct: DirectEvalAdapter;
}

async function runOnce(
  values: ReturnType<typeof parse>["values"],
  connection: Connection,
  agents: Agents,
  agent: { key: string; revision: string },
  hue: HueClient,
  output: Output,
  signal: AbortSignal,
): Promise<number> {
  const client = new EvaluationClient(connection);
  const concurrency = integer("concurrency", values.concurrency, 1, 1, 64);
  const baselineId = parseBaseline(values.baseline);
  const mode = parseMode(values.mode);
  const pins = await resolveSelection(client, values);
  if (!pins.saved) {
    if (!values["save-version"]) {
      output.error(
        `The ${pins.scenarioId ? "Scenario" : "eval set"} "${pins.name}" points at an unsaved version. Choose "Save eval-set version" in Hue, or pass --save-version to freeze it now, then rerun.`,
      );
      return 1;
    }
    const frozen = await client.freezeDatasetVersion(pins.datasetVersionId, pins.revision);
    output.log(`Saved "${pins.name}" version ${frozen.version}.`);
  }
  const runName = values.name ?? defaultRunName(agent);
  const project = await client.checkConnection();
  if (await detectDirect(client, pins, mode))
    return runDirect(
      {
        client,
        values,
        pins,
        runName,
        projectId: project.id,
        agent,
        agents,
        hue,
        output,
        signal,
        concurrency,
        baselineId,
      },
      connection,
    );
  const environmentClient = createEnvironmentClient(connection);
  const checkpointDirectory = await prepareCheckpointDirectory(
    values["checkpoint-dir"],
    agent.key,
    project.id,
    "simulation",
  );
  const caseKeys = new Map<string, string>();
  let runUrl = "";
  const telemetry = telemetryReporter(output);
  const report = await runSimulation({
    client,
    environmentClient,
    hue,
    checkpointDirectory,
    definition: {
      kind: "pins",
      datasetVersionId: pins.datasetVersionId,
      scorerVersionIds: pins.scorerVersionIds,
    },
    runName,
    // Outputs, error messages and explanations are stored unless opted out; --content governs
    // only the telemetry.
    persistResultContent: !values["no-output"],
    traceEvidence: { mode: "required" },
    // A case whose telemetry Hue did not accept fails instead of staying started.
    traceNotAccepted: "fail_case",
    onTelemetryNotAccepted: telemetry.report,
    concurrency,
    agentRevision: agent.revision,
    // The CLI adapts to whatever the deployment serves; the library warning is for code that
    // still reads the legacy capability itself.
    deprecationWarnings: false,
    signal,
    target: agents.simulation,
    async onProgress(event: SimulationProgress) {
      if (event.type === "run_created") {
        runUrl = event.runUrl;
        output.log(`Run: ${event.runUrl}`);
        output.log(`Experiment: ${event.experimentId}`);
        try {
          let after: string | undefined;
          do {
            const page = await client.listExperimentItems(event.experimentId, { after });
            for (const item of page.items) caseKeys.set(item.id, item.externalKey);
            after = page.nextCursor ?? undefined;
          } while (after);
        } catch {
          // Progress labels fall back to case IDs; the run itself is unaffected.
        }
        return;
      }
      const label = caseKeys.get(event.caseId) ?? event.caseId;
      if (event.type === "world_created") output.log(`[${label}] world created`);
      else if (event.type === "target_started") output.log(`[${label}] agent started`);
      else if (event.type === "world_sealed") output.log(`[${label}] world sealed`);
      else if (event.type === "attempt_prepared")
        output.log(`[${label}] attempt prepared: ${event.status}`);
    },
  });
  telemetry.rest(report.telemetryNotAccepted);
  return reportVerdicts(
    client,
    values,
    {
      experimentId: report.experimentId,
      subjectIds: report.subjectIds,
      runUrl: runUrl || report.runUrl,
      telemetryNotAccepted: report.telemetryNotAccepted,
    },
    baselineId,
    output,
    signal,
  );
}

/** Resumable direct-run attempt: the created experiment is finished before a new one starts. */
interface DirectAttempt {
  /** Digest of the selection: dataset version, scorer pins and experiment configuration. */
  selectionDigest: string;
  /** Stable experiment-creation key; a resumed attempt never creates a second experiment. */
  idempotencyKey: string;
  stage: "preparing" | "running" | "completed";
  experimentId?: string;
}

/**
 * Direct cases: one ordinary experiment through `runExperiment`. The agent receives the case's
 * pinned files and returns generated documents; code evaluators pinned to the run stay deferred
 * for Hue's executor (`deferUnboundLocalScorers`), so no evaluator source runs on this machine.
 * The attempt is checkpointed as in simulation mode: rerunning the same selection resumes the
 * saved experiment without invoking the agent again for its finished cases.
 */
async function runDirect(
  run: {
    client: EvaluationClient;
    values: ReturnType<typeof parse>["values"];
    pins: ScenarioPins;
    runName: string;
    projectId: string;
    agent: { key: string; revision: string };
    agents: Agents;
    hue: HueClient;
    output: Output;
    signal: AbortSignal;
    concurrency: number;
    baselineId: string | undefined;
  },
  connection: Connection,
): Promise<number> {
  const { client, values, pins, output, signal } = run;
  const config = { agentKey: run.agent.key, agentRevision: run.agent.revision };
  const checkpointDirectory = await prepareCheckpointDirectory(
    values["checkpoint-dir"],
    run.agent.key,
    run.projectId,
    "direct",
  );
  const store = await CheckpointStore.acquire(checkpointDirectory, {
    kind: "direct",
    projectId: run.projectId,
    baseUrl: connection.baseUrl,
  });
  let experimentId = "";
  let runUrl = "";
  let report: RunnerReport;
  const telemetry = telemetryReporter(output);
  try {
    const selectionDigest = digest({
      datasetVersionId: pins.datasetVersionId,
      scorerVersionIds: [...pins.scorerVersionIds].sort(),
      config,
    });
    let attempt = await store.read<DirectAttempt>("active-attempt");
    if (attempt && attempt.stage !== "completed" && attempt.selectionDigest !== selectionDigest)
      throw new Error("Recover the unfinished direct run before running a changed selection");
    if (!attempt || attempt.stage === "completed") {
      attempt = { selectionDigest, idempotencyKey: randomUUID(), stage: "preparing" };
      await store.write("active-attempt", attempt);
    }
    if (!attempt.experimentId) {
      const experiment = await client.createExperiment({
        idempotencyKey: attempt.idempotencyKey,
        name: run.runName.slice(0, 100),
        datasetVersionId: pins.datasetVersionId,
        scorerVersionIds: pins.scorerVersionIds,
        config,
      });
      attempt.experimentId = experiment.id;
      attempt.stage = "running";
      await store.write("active-attempt", attempt);
    }
    experimentId = attempt.experimentId;
    runUrl = new URL(`/experiments/${experimentId}`, connection.baseUrl).toString();
    output.log(`Run: ${runUrl}`);
    output.log(`Experiment: ${experimentId}`);
    report = await runExperiment({
      client,
      hue: run.hue,
      experimentId,
      checkpointDirectory: join(store.directory, experimentId),
      // Outputs, error messages and explanations are stored unless opted out; --content governs
      // only the telemetry.
      persistResultContent: !values["no-output"],
      traceEvidence: { mode: "required" },
      traceNotAccepted: "fail_case",
      onTelemetryNotAccepted: telemetry.report,
      concurrency: run.concurrency,
      scorers: [],
      deferUnboundLocalScorers: true,
      environmentEvidence: "when_pinned",
      async target(inputs, context) {
        if (signal.aborted) throw new TargetCancelledError();
        output.log(`[${context.item.externalKey}] agent started`);
        const result = await run.agents.direct(inputs, {
          mode: "direct",
          config: structuredClone(context.config),
          item: {
            id: context.item.id,
            externalKey: context.item.externalKey,
          },
          executionId: context.executionId,
          files: structuredClone(context.files),
          outputDirectory: context.outputDirectory,
          signal,
        });
        const count =
          result instanceof TargetResult ? result.files.length : result === undefined ? 0 : null;
        output.log(
          `[${context.item.externalKey}] ${count === null ? "answer returned" : `${count} file${count === 1 ? "" : "s"} produced`}`,
        );
        return result;
      },
    });
    attempt.stage = "completed";
    await store.write("active-attempt", attempt);
  } finally {
    await store.release();
  }
  if (report.deferredScorerVersionIds.length)
    output.log(
      `${report.deferredScorerVersionIds.length} evaluator version${report.deferredScorerVersionIds.length === 1 ? "" : "s"} left to Hue's executor`,
    );
  telemetry.rest(report.telemetryNotAccepted);
  return reportVerdicts(
    client,
    values,
    {
      experimentId,
      subjectIds: report.subjectIds,
      runUrl,
      extra: { mode: "direct", deferredScorerVersionIds: report.deferredScorerVersionIds },
      telemetryNotAccepted: report.telemetryNotAccepted,
    },
    run.baselineId,
    output,
    signal,
  );
}

async function runWorker(
  values: ReturnType<typeof parse>["values"],
  connection: Connection,
  adapter: EvalAdapter,
  agent: { key: string; name: string; revision: string },
  hue: HueClient,
  output: Output,
  signal: AbortSignal,
): Promise<number> {
  const client = new ObservedClient(connection);
  const environmentClient = createEnvironmentClient(connection);
  const wait = integer("wait", values.wait, 300, 0, 86_400);
  const concurrency = integer("concurrency", values.concurrency, 1, 1, 64);
  const maxRuns =
    values["max-runs"] === undefined
      ? undefined
      : integer("max-runs", values["max-runs"], 1, 1, 1_000_000);
  const project = await client.checkConnection();
  const checkpointDirectory = await prepareCheckpointDirectory(
    values["checkpoint-dir"],
    agent.key,
    project.id,
    join("worker", slug(agent.revision) || "dev"),
  );
  let current: LocalAgentClaim | undefined;
  client.onRegistered = (registered) => {
    output.log(
      `Registered agent ${registered.key} (revision ${registered.revision}) with ${connection.baseUrl}; waiting for runs launched from Hue${maxRuns ? ` (stops after ${maxRuns})` : " (Ctrl+C to stop)"}`,
    );
  };
  client.onClaimed = (claim) => {
    current = claim;
    output.log(
      `Claimed run ${claim.runId}: ${new URL(`/experiments/${claim.experimentId}`, connection.baseUrl).toString()}`,
    );
  };
  const telemetry = telemetryReporter(output);
  await runLocalAgent({
    client,
    environmentClient,
    hue,
    checkpointDirectory,
    agent: {
      key: agent.key,
      name: agent.name,
      revision: agent.revision,
      capabilities: ["environment:v1", ...(values.capability ?? [])],
    },
    scorers: [],
    concurrency,
    traceNotAccepted: "fail_case",
    onTelemetryNotAccepted: telemetry.report,
    deprecationWarnings: false,
    signal,
    ...(maxRuns === undefined ? {} : { maxRuns }),
    target(inputs, tools: Record<string, EnvironmentTool>, context) {
      output.log(`[${context.item.externalKey}] agent started`);
      return adapter(inputs, {
        config: context.config,
        item: context.item,
        executionId: context.executionId,
        environmentRunId: context.environmentRunId,
        tools,
        ...(context.world ? { world: context.world } : {}),
        ...(context.mcp ? { mcp: context.mcp } : {}),
        ...(context.connectionBundle ? { connectionBundle: context.connectionBundle } : {}),
        files: context.files,
        outputDirectory: context.outputDirectory,
        signal,
      });
    },
    async onCompleted(report) {
      output.log(
        `Run ${report.runId} completed: ${report.subjectIds.length} case${report.subjectIds.length === 1 ? "" : "s"}`,
      );
      telemetry.rest(report.telemetryNotAccepted);
      if (!current) return;
      output.log("Waiting for Hue checks...");
      try {
        const verdicts = withTelemetryFailures(
          await collectExperimentVerdicts(client, {
            experimentId: current.experimentId,
            subjectIds: report.subjectIds,
            timeoutMillis: wait * 1000,
            signal,
          }),
          report.telemetryNotAccepted,
        );
        if (signal.aborted) return;
        if (values.json)
          process.stdout.write(
            `${JSON.stringify(toJson(verdicts, new URL(`/experiments/${current.experimentId}`, connection.baseUrl).toString(), undefined, {}, report.telemetryNotAccepted))}\n`,
          );
        else renderTable(verdicts, output);
      } catch (error) {
        output.error(`Unable to read verdicts: ${explain(error)}`);
      }
    },
  });
  if (signal.aborted) {
    process.stderr.write("Interrupted.\n");
    return 130;
  }
  return 0;
}

/**
 * `hue eval`: runs a local adapter or command against a Scenario or eval set through
 * `runSimulation`, or registers it as an outbound worker through `runLocalAgent`.
 * Returns the process exit code.
 */
export async function runEvalCommand(argv: string[]): Promise<number> {
  const secrets: string[] = [];
  const controller = new AbortController();
  let firstInterrupt = 0;
  // The first interrupt stops the agents within their grace; a repeated one kills their process
  // groups at once and exits, so no agent is left running with its world token. `npm run` and
  // `npx` forward the terminal's SIGINT a moment after the terminal delivers it, so a repeat
  // within 50 ms is the same Ctrl+C.
  const interrupt = () => {
    if (!controller.signal.aborted) {
      firstInterrupt = performance.now();
      if (runningCommands.size)
        process.stderr.write("Stopping the agent; press Ctrl+C again to force.\n");
      controller.abort(new Error("Interrupted"));
      return;
    }
    if (performance.now() - firstInterrupt < 50) return;
    for (const command of runningCommands) command.kill();
    // The exit cannot wait for the normal cleanup: remove the world cases' files, the MCP
    // configurations holding world tokens and the checkpoint locks now.
    runForcedExitCleanups();
    process.stderr.write("Interrupted.\n");
    process.exit(130);
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  let hue: HueClient | undefined;
  let json = false;
  try {
    const { values, positionals } = parse(argv);
    json = values.json;
    const output: Output = {
      log: (line) => (json ? process.stderr : process.stdout).write(`${line}\n`),
      error: (line) => process.stderr.write(`${line}\n`),
    };
    if (values.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    if (positionals.length > 1) throw new UsageError("Pass at most one adapter file");
    const adapterFile = positionals[0];
    if ((adapterFile ? 1 : 0) + (values.command ? 1 : 0) !== 1)
      throw new UsageError("Pass exactly one agent: an adapter file or --command");
    const selections = [values.case, values.scenario, values.set, values["dataset-version"]].filter(
      (value) => value !== undefined,
    ).length;
    if (values.worker && selections)
      throw new UsageError("--worker takes no selection; Hue chooses the run to execute");
    if (!values.worker && selections !== 1)
      throw new UsageError("Pass exactly one of --case, --set or --dataset-version");
    let envFile: string | undefined;
    try {
      envFile = envFileArgument(values, process.cwd());
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
    if (envFile) {
      try {
        process.loadEnvFile(resolve(envFile));
      } catch (error) {
        throw new UsageError(
          `Unable to load ${envFile}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const apiKey = process.env.HUE_API_KEY?.trim();
    if (!apiKey)
      throw new UsageError(
        'HUE_API_KEY is required: a "Read and write" project key, set in the environment or an ignored --env-file',
      );
    secrets.push(apiKey);
    const baseUrl = values.origin ?? process.env.HUE_BASE_URL?.trim() ?? "https://app.hue.run";
    const connection: Connection = { apiKey, baseUrl };
    const timeout = integer("timeout", values.timeout, 600, 1, 86_400);
    const key = values["agent-key"] ?? (derivedAgentKey(adapterFile, values.command) || "agent");
    const agent = {
      key,
      name: values["agent-name"] ?? key,
      revision: values.revision ?? process.env.AGENT_REVISION?.trim() ?? gitRevision() ?? "dev",
    };
    if (values.worker && (values.mode || values["set-version"] || values.scorer?.length))
      throw new UsageError("--worker takes no selection; Hue chooses the run to execute");
    if (values.worker && values["no-output"])
      throw new UsageError(
        "--no-output applies to one-shot runs; a run launched from Hue always stores its outputs",
      );
    if (!values.worker && values.capability?.length)
      throw new UsageError("--capability applies to --worker only");
    const loaded = adapterFile ? await loadAdapter(adapterFile) : undefined;
    // One adapter module serves both case kinds; the direct context announces itself with `mode`.
    // Outputs are stored by default, so every answer and error message is cleared of the
    // credentials the case handed the agent before it leaves the CLI.
    const agents: Agents = {
      simulation: redacting(
        loaded ??
          commandAdapter(values.command!, timeout, {
            allowHueCredentials: values["allow-hue-credentials"],
          }),
      ),
      direct: redacting(
        loaded ??
          directCommandAdapter(values.command!, timeout, {
            allowHueCredentials: values["allow-hue-credentials"],
          }),
      ),
    };
    hue = createHue({ apiKey, baseUrl, serviceName: key, captureContent: values.content });
    return values.worker
      ? await runWorker(
          values,
          connection,
          agents.simulation,
          agent,
          hue,
          output,
          controller.signal,
        )
      : await runOnce(values, connection, agents, agent, hue, output, controller.signal);
  } catch (error) {
    if (controller.signal.aborted || error instanceof TargetCancelledError) {
      process.stderr.write("Interrupted.\n");
      return 130;
    }
    if (error instanceof UsageError) {
      process.stderr.write(`${redact(error.message, secrets)}\n${json ? "" : USAGE}`);
      return 2;
    }
    process.stderr.write(`Error: ${redact(explain(error), secrets)}\n`);
    return 1;
  } finally {
    // The handlers stay until every agent command has settled, so an interrupt during a stop's
    // grace still reaches it.
    await settleCommands();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    if (hue) await hue.shutdownSafe({ timeoutMillis: 5000 });
  }
}
