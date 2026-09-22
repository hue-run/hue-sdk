import { execFileSync, spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createHue, type HueClient } from "../client.js";
import { createEnvironmentClient } from "../environment/client.js";
import type { EnvironmentTool } from "../environment/tools.js";
import { EvaluationClient, HueApiError } from "../evals/client.js";
import type {
  LocalAgentClaim,
  LocalAgentRegistration,
  RegisteredLocalAgent,
} from "../evals/types.js";
import { runLocalAgent } from "../evals/local-worker.js";
import { TargetCancelledError } from "../evals/runner.js";
import {
  parseScenarioSelector,
  resolveEvalSetPins,
  resolveScenarioPins,
  type ScenarioPins,
} from "../evals/scenarios.js";
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

/** Adapter contract: the module's `default` or `runMyAgent` export. */
export type EvalAdapter = (
  inputs: JsonValue,
  context: SimulationTargetContext,
) => JsonValue | undefined | Promise<JsonValue | undefined>;

const USAGE = `Usage: hue eval [adapter-file] [options]

Run a local agent against a Hue Scenario or eval set, then print Hue's verdicts.

Selection (exactly one, not used with --worker):
  --scenario <name|id|url>        Published Scenario to run
  --set <name|id|url>             Saved eval set; requires --scorer-version
  --dataset-version <id>          Frozen dataset version; requires --scorer-version
  --scorer-version <id>           Scorer version to pin (repeatable)

Agent (exactly one):
  <adapter-file>                  Module exporting default or runMyAgent(inputs, context)
  --command "<shell command>"     Spawned per case with HUE_MCP_URL, HUE_MCP_TOKEN,
                                  HUE_MCP_EXPIRES_AT, HUE_EXECUTION_ID, HUE_ENVIRONMENT_RUN_ID,
                                  HUE_CASE_ID and HUE_CASE_KEY set; {"inputs","config"} on stdin

Modes:
  --worker                        Register the agent and poll for runs launched from Hue
  --max-runs <n>                  Stop the worker after n completed runs
  --agent-key <key>               Agent key (default: slug of the adapter filename)
  --agent-name <name>             Agent display name (default: the key)
  --revision <id>                 Agent revision (default: AGENT_REVISION, git HEAD or "dev")

Connection:
  --env-file <path>               Load a dotenv file (HUE_API_KEY, HUE_BASE_URL) first
  --origin <url>                  Hue origin (default: HUE_BASE_URL or https://app.hue.run)

Output and limits:
  --name <run name>               Experiment name (default: <scenario> · <agent key> · <revision>)
  --baseline <experiment id|url>  Compare verdicts with a previous experiment
  --json                          Print one JSON document on stdout; progress goes to stderr
  --content                       Capture telemetry content; one-shot also persists
                                  outputs/explanations (--worker always persists them)
  --save-version                  Freeze an unsaved eval-set version before running
  --checkpoint-dir <path>         Private checkpoint directory (default: .hue/eval/<agent-key>)
  --concurrency <n>               Cases in flight, 1-16 (default: 1)
  --timeout <seconds>             Per-case --command timeout (default: 600)
  --wait <seconds>                Verdict wait after the run finishes (default: 300)
  -h, --help                      Show this help

HUE_API_KEY must be a "Tracing and evaluations" project key; it is never printed.
Exit codes: 0 every case passed, 1 a case failed, errored or is incomplete, 2 usage error,
130 interrupted.
`;

/** Thrown for invalid arguments or configuration; exits with status 2. */
class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

interface Output {
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
        scenario: { type: "string" },
        set: { type: "string" },
        "dataset-version": { type: "string" },
        "scorer-version": { type: "string", multiple: true },
        command: { type: "string" },
        worker: { type: "boolean", default: false },
        "max-runs": { type: "string" },
        "agent-key": { type: "string" },
        "agent-name": { type: "string" },
        revision: { type: "string" },
        "env-file": { type: "string" },
        origin: { type: "string" },
        name: { type: "string" },
        baseline: { type: "string" },
        json: { type: "boolean", default: false },
        content: { type: "boolean", default: false },
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

async function loadAdapter(file: string): Promise<EvalAdapter> {
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
  return candidate as EvalAdapter;
}

/** Grace between the stop signal and SIGKILL for an agent command that ignores SIGTERM. */
const COMMAND_KILL_GRACE_MS = 5_000;

/** Runs the shell command once per case; the MCP token travels only through the child's environment. */
function commandAdapter(command: string, timeoutSeconds: number): EvalAdapter {
  return (inputs, context) =>
    new Promise((resolvePromise, reject) => {
      // Own process group so a timeout or Ctrl+C stops the agent the shell started, not only the
      // shell: a survivor would still hold the world token and could write after Hue recorded the
      // case as failed. Windows has no process group to signal, so the child alone is stopped.
      const group = process.platform !== "win32";
      const child = spawn(command, {
        shell: true,
        detached: group,
        env: {
          ...process.env,
          HUE_MCP_URL: context.mcp.url,
          HUE_MCP_TOKEN: context.mcp.token,
          HUE_MCP_EXPIRES_AT: context.mcp.expiresAt,
          HUE_EXECUTION_ID: context.executionId,
          HUE_ENVIRONMENT_RUN_ID: context.environmentRunId,
          HUE_CASE_ID: context.item.id,
          HUE_CASE_KEY: context.item.externalKey,
        },
        stdio: ["pipe", "pipe", "inherit"],
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let timedOut = false;
      let oversized = false;
      let escalation: NodeJS.Timeout | undefined;
      const signalTree = (signal: NodeJS.Signals) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          if (group && child.pid !== undefined) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          // The group is already gone; nothing is left to stop.
        }
      };
      const stop = (signal: NodeJS.Signals) => {
        signalTree(signal);
        escalation ??= setTimeout(() => signalTree("SIGKILL"), COMMAND_KILL_GRACE_MS).unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop("SIGTERM");
      }, timeoutSeconds * 1000);
      const cancel = () => stop("SIGTERM");
      context.signal?.addEventListener("abort", cancel, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > 4 * 1024 * 1024) {
          oversized = true;
          stop("SIGTERM");
          return;
        }
        chunks.push(chunk);
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(JSON.stringify({ inputs, config: context.config }));
      child.on("error", (error) => {
        clearTimeout(timer);
        clearTimeout(escalation);
        context.signal?.removeEventListener("abort", cancel);
        reject(new Error(`Unable to start the agent command: ${error.message}`));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        clearTimeout(escalation);
        context.signal?.removeEventListener("abort", cancel);
        if (context.signal?.aborted) return reject(new TargetCancelledError());
        if (timedOut)
          return reject(new Error(`The agent command timed out after ${timeoutSeconds} seconds`));
        if (oversized) return reject(new Error("The agent command printed more than 4 MiB"));
        if (code !== 0)
          return reject(
            new Error(
              signal
                ? `The agent command was stopped by ${signal}`
                : `The agent command exited with code ${code}`,
            ),
          );
        const text = Buffer.concat(chunks).toString("utf8").trim();
        if (!text) return resolvePromise(undefined);
        try {
          resolvePromise(JSON.parse(text) as JsonValue);
        } catch {
          resolvePromise(text);
        }
      });
    });
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

function renderTable(verdicts: ExperimentVerdicts, output: Output): void {
  const names: string[] = [];
  for (const item of verdicts.summary.cases)
    for (const metric of item.metrics) if (!names.includes(metric.name)) names.push(metric.name);
  const header = ["Case", ...names, "Result"];
  const rows = verdicts.summary.cases.map((item) => [
    item.externalKey,
    ...names.map((name) => {
      const metric = item.metrics.find((candidate) => candidate.name === name);
      return metric ? metricText(metric) : "-";
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

function explain(error: unknown): string {
  if (error instanceof HueApiError && (error.status === 401 || error.status === 403))
    return `${error.message}. Check that HUE_API_KEY is a "Tracing and evaluations" project key for this origin.`;
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

async function resolveSelection(
  client: EvaluationClient,
  values: ReturnType<typeof parse>["values"],
): Promise<ScenarioPins> {
  const extra = values["scorer-version"] ?? [];
  if (values.scenario) {
    const pins = await resolveScenarioPins(client, values.scenario);
    pins.scorerVersionIds = [...new Set([...pins.scorerVersionIds, ...extra])];
    return pins;
  }
  if (!extra.length)
    throw new UsageError(
      `${values.set ? "--set" : "--dataset-version"} needs at least one --scorer-version; use --scenario for published pins`,
    );
  if (values.set) return resolveEvalSetPins(client, values.set, { scorerVersionIds: extra });
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

function toJson(
  verdicts: ExperimentVerdicts,
  runUrl: string,
  baseline?: { experimentId: string; comparison: VerdictComparison },
) {
  return {
    experimentId: verdicts.experimentId,
    runId: verdicts.runId,
    runUrl,
    complete: verdicts.results.complete,
    cases: verdicts.summary.cases,
    totals: verdicts.summary.totals,
    ...(baseline
      ? { baseline: { experimentId: baseline.experimentId, ...baseline.comparison } }
      : {}),
  };
}

async function runOnce(
  values: ReturnType<typeof parse>["values"],
  connection: Connection,
  adapter: EvalAdapter,
  agent: { key: string; revision: string },
  hue: HueClient,
  output: Output,
  signal: AbortSignal,
): Promise<number> {
  const client = new EvaluationClient(connection);
  const environmentClient = createEnvironmentClient(connection);
  const wait = integer("wait", values.wait, 300, 0, 86_400);
  const concurrency = integer("concurrency", values.concurrency, 1, 1, 16);
  let baselineId: string | undefined;
  if (values.baseline) {
    const parsed = parseScenarioSelector(values.baseline, ["experiments"]);
    if (parsed.kind !== "id")
      throw new UsageError("--baseline must be an experiment ID or its Hue URL");
    baselineId = parsed.id;
  }
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
  const runName = values.name ?? `${pins.name} · ${agent.key} · ${agent.revision}`;
  const project = await client.checkConnection();
  const checkpointDirectory = await prepareCheckpointDirectory(
    values["checkpoint-dir"],
    agent.key,
    project.id,
    "simulation",
  );
  const caseKeys = new Map<string, string>();
  let runUrl = "";
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
    persistResultContent: values.content,
    traceEvidence: { mode: "required" },
    concurrency,
    signal,
    target: adapter,
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
  output.log("Waiting for Hue checks...");
  const verdicts = await collectExperimentVerdicts(client, {
    experimentId: report.experimentId,
    subjectIds: report.subjectIds,
    timeoutMillis: wait * 1000,
    signal,
  });
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
      `${JSON.stringify(toJson(verdicts, runUrl || report.runUrl, baseline))}\n`,
    );
  } else {
    renderTable(verdicts, output);
    if (baseline) renderComparison(baseline.experimentId, baseline.comparison, output);
    output.log(`Run: ${runUrl || report.runUrl}`);
  }
  const totals = verdicts.summary.totals;
  return verdicts.results.complete && totals.cases > 0 && totals.passed === totals.cases ? 0 : 1;
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
  const concurrency = integer("concurrency", values.concurrency, 1, 1, 16);
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
  await runLocalAgent({
    client,
    environmentClient,
    hue,
    checkpointDirectory,
    agent: {
      key: agent.key,
      name: agent.name,
      revision: agent.revision,
      capabilities: ["environment:v1"],
    },
    scorers: [],
    concurrency,
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
        mcp: context.mcp,
        ...(context.connectionBundle ? { connectionBundle: context.connectionBundle } : {}),
        signal,
      });
    },
    async onCompleted(report) {
      output.log(
        `Run ${report.runId} completed: ${report.subjectIds.length} case${report.subjectIds.length === 1 ? "" : "s"}`,
      );
      if (!current) return;
      output.log("Waiting for Hue checks...");
      try {
        const verdicts = await collectExperimentVerdicts(client, {
          experimentId: current.experimentId,
          subjectIds: report.subjectIds,
          timeoutMillis: wait * 1000,
          signal,
        });
        if (signal.aborted) return;
        if (values.json)
          process.stdout.write(
            `${JSON.stringify(toJson(verdicts, new URL(`/experiments/${current.experimentId}`, connection.baseUrl).toString()))}\n`,
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
  const interrupt = () => controller.abort(new Error("Interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
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
    const selections = [values.scenario, values.set, values["dataset-version"]].filter(
      (value) => value !== undefined,
    ).length;
    if (values.worker && selections)
      throw new UsageError("--worker takes no selection; Hue chooses the run to execute");
    if (!values.worker && selections !== 1)
      throw new UsageError("Pass exactly one of --scenario, --set or --dataset-version");
    if (values["env-file"]) {
      try {
        process.loadEnvFile(resolve(values["env-file"]));
      } catch (error) {
        throw new UsageError(
          `Unable to load ${values["env-file"]}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const apiKey = process.env.HUE_API_KEY?.trim();
    if (!apiKey)
      throw new UsageError(
        'HUE_API_KEY is required: a "Tracing and evaluations" project key, set in the environment or an ignored --env-file',
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
    const adapter = adapterFile
      ? await loadAdapter(adapterFile)
      : commandAdapter(values.command!, timeout);
    hue = createHue({ apiKey, baseUrl, serviceName: key, captureContent: values.content });
    return values.worker
      ? await runWorker(values, connection, adapter, agent, hue, output, controller.signal)
      : await runOnce(values, connection, adapter, agent, hue, output, controller.signal);
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
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    if (hue) await hue.shutdownSafe({ timeoutMillis: 5000 });
  }
}
