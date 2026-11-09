import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod/v4";
import { EvaluationClient, HueApiError } from "../evals/client.js";
import { CheckpointStore, checkpointPath } from "../evals/checkpoint.js";
import { digest } from "../evals/json.js";
import {
  createEvalInvocationInput,
  evalCiContext,
  evalPolicy,
  type EvalInvocation,
  type EvalCiContext,
  type CreateEvalInvocationInput,
} from "../evals/invocations.js";
import { UncertainExecutionError, TargetOutcomeUncertainError } from "../evals/runner.js";
import { evalReport, trialReport, trialRun, writeEvalReports } from "./eval-reports.js";
import { DEFAULT_ENV_FILE, envFileArgument, envFileOptions } from "./env-file.js";

const seconds = z.number().int().positive().max(2_147_483);
export const evalConfig = z
  .strictObject({
    evalSetId: z.uuid().optional(),
    evalSetVersionId: z.uuid().optional(),
    command: z.string().trim().min(1),
    name: z.string().min(1).max(100).optional(),
    evaluatorIds: z.array(z.uuid()).optional(),
    evaluatorVersionIds: z.array(z.uuid()).optional(),
    config: z.json().default({}),
    captureContent: z.boolean().default(true),
    persistResultContent: z.boolean().default(true),
    policy: evalPolicy.default({ thresholds: [] }),
    concurrency: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(20),
    timeoutSeconds: seconds.default(600),
    scoringTimeoutSeconds: seconds.default(300),
    deadlineSeconds: seconds.default(900),
    baselineRunId: z.uuid().optional(),
    baselineCommand: z.string().trim().min(1).optional(),
    baselineDirectory: z.string().min(1).optional(),
    localScorers: z.array(z.string().min(1)).default([]),
    trials: z.number().int().min(1).max(10).default(1),
    minPassRate: z.number().min(0).max(1).default(1),
    /** Who drives a conversation case's scripted messages: Hue, one call per message, or the
     * command, one call with the case's inputs unchanged. */
    turns: z.enum(["hue", "runner"]).default("hue"),
  })
  .refine(
    (value) => Number(!!value.evalSetId) + Number(!!value.evalSetVersionId) === 1,
    "Choose exactly one eval set selector",
  )
  .refine(
    (value) => !!value.baselineCommand === !!value.baselineDirectory,
    "baselineCommand and baselineDirectory must be supplied together",
  );
export type EvalConfig = z.infer<typeof evalConfig>;
export type ExecuteCiRun = (options: {
  client: EvaluationClient;
  connection: { apiKey: string; baseUrl: string };
  invocation: EvalInvocation;
  config: EvalConfig;
  projectDirectory: string;
  checkpointDirectory: string;
  signal: AbortSignal;
}) => Promise<void>;

class ConfigurationError extends Error {}
class AuthenticationError extends Error {}

export function checkedOutRevision(directory?: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      ...(directory ? { cwd: directory } : {}),
    }).trim();
  } catch {
    return undefined;
  }
}

/** Checked-out HEAD is the tested revision; the event's PR head is separate metadata. */
export async function nativeCiContext(): Promise<EvalCiContext> {
  const commitSha = checkedOutRevision();
  if (process.env.GITHUB_ACTIONS !== "true")
    return { provider: "local", ...(commitSha ? { commitSha } : {}) };
  const event = z
    .object({
      pull_request: z
        .object({
          number: z.number().int().positive(),
          head: z.object({ sha: z.string() }),
          base: z.object({ sha: z.string() }),
        })
        .optional(),
      merge_group: z.object({ base_sha: z.string() }).optional(),
    })
    .safeParse(
      process.env.GITHUB_EVENT_PATH
        ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"))
        : {},
    );
  if (!event.success || !commitSha || !process.env.GITHUB_REPOSITORY || !process.env.GITHUB_RUN_ID)
    throw new ConfigurationError("Cannot read the checked-out GitHub revision or event context");
  const context = {
    provider: "github",
    commitSha,
    repository: process.env.GITHUB_REPOSITORY,
    workflowRunId: process.env.GITHUB_RUN_ID,
    workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT
      ? Number(process.env.GITHUB_RUN_ATTEMPT)
      : undefined,
    eventName: process.env.GITHUB_EVENT_NAME,
    baseSha: event.data.pull_request?.base.sha ?? event.data.merge_group?.base_sha,
    pullRequestHeadSha: event.data.pull_request?.head.sha,
    pullRequestNumber: event.data.pull_request?.number,
  };
  return evalCiContext.parse(
    Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined)),
  );
}

const USAGE = `Usage: hue eval --ci --config hue.eval.json --report-dir .hue/reports
       hue eval status <run-id> [--report-dir .hue/reports] [--json]

--concurrency <n>  Positive integer (default: config or 20)
--deadline <sec>   Overall deadline (default: config or 900)
--timeout <sec>    Agent timeout per case (default: config or 600)
--wait <sec>       Scoring wait (default: config or 300)
--trials <n>       Runs of the same selection, 1 to 10 (default: config or 1)
--min-pass-rate <r> Share of scored trials each case must pass, 0 to 1 (default: config or 1)
--turns <mode>     Conversation cases: hue sends each scripted message as its own call,
                   runner makes one call with the whole case (default: config or hue)
--content          Capture trace content (default: config or enabled)
--no-content       Export trace metadata only
--no-output        Omit stored case outputs, error messages and scorer explanations
--checkpoint-dir  Private recovery directory (default: .hue/ci/<identity>)
--origin <url>    Hue origin; otherwise HUE_BASE_URL
--env-path <path> Load a private dotenv file
--json            Print results.json on stdout
Exit codes: 0 pass, 1 failed/error/incomplete, 2 configuration, 130 interrupted.
`;

async function settleInvocation(
  client: EvaluationClient,
  saved: EvalInvocation,
  timeoutSeconds: number,
  signal: AbortSignal,
): Promise<EvalInvocation> {
  let invocation = saved;
  const deadline = Math.min(Date.parse(saved.deadlineAt), Date.now() + timeoutSeconds * 1000);
  while (!signal.aborted) {
    invocation = await client.getEvalInvocation(invocation.id, signal);
    if (invocation.receipt || invocation.state !== "active") return invocation;
    const scoring = await client.getEvaluationRun(invocation.manifest.scoringRunId, signal);
    if (
      (scoring.itemCount === invocation.manifest.cases.length &&
        scoring.scores.pending === 0 &&
        !scoring.managedScoringActive) ||
      Date.now() >= deadline
    )
      break;
    await new Promise<void>((done) => {
      const finish = () => {
        clearTimeout(wait);
        signal.removeEventListener("abort", finish);
        done();
      };
      const wait = setTimeout(finish, 1000);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
  signal.throwIfAborted();
  return client.finalizeEvalInvocation(
    invocation.id,
    { idempotencyKey: `${invocation.id}:finalize` },
    signal,
  );
}

function uncertainOutcome(error: unknown): boolean {
  return (
    error instanceof UncertainExecutionError ||
    error instanceof TargetOutcomeUncertainError ||
    (error instanceof AggregateError && error.errors.some(uncertainOutcome))
  );
}

/** Saves creation bytes before sending; recovery replays them before any latest resolution. */
export async function runCiEvalCommand(argv: string[], execute: ExecuteCiRun): Promise<number> {
  // Locate the destination even if strict argument parsing fails, to report setup errors.
  const reportAt = argv.indexOf("--report-dir");
  let reportDirectory = resolve(
    reportAt >= 0 ? (argv[reportAt + 1] ?? ".hue/reports") : ".hue/reports",
  );
  let report = evalReport();
  let invocation: EvalInvocation | undefined;
  let baseline: EvalInvocation | undefined;
  /** Finished trials when more than one runs, so error reports keep them. */
  let finished: EvalInvocation[] | undefined;
  let client: EvaluationClient | undefined;
  let store: CheckpointStore | undefined;
  const controller = new AbortController();
  const startedAt = Date.now();
  let deadline = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let json = argv.includes("--json");
  const interrupt = () => controller.abort(new Error("Interrupted"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
          ci: { type: "boolean" },
          config: { type: "string" },
          "report-dir": { type: "string" },
          concurrency: { type: "string" },
          deadline: { type: "string" },
          timeout: { type: "string" },
          wait: { type: "string" },
          trials: { type: "string" },
          "min-pass-rate": { type: "string" },
          turns: { type: "string" },
          content: { type: "boolean" },
          "no-content": { type: "boolean" },
          "no-output": { type: "boolean" },
          "checkpoint-dir": { type: "string" },
          origin: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
          ...envFileOptions,
        },
      });
    } catch {
      throw new ConfigurationError("Invalid CI evaluation arguments");
    }
    const { values, positionals } = parsed;
    json = values.json ?? false;
    reportDirectory = resolve(values["report-dir"] ?? ".hue/reports");
    if (values.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    if (values.content && values["no-content"])
      throw new ConfigurationError("Choose either --content or --no-content");
    const status = positionals[0] === "status";
    if (
      (status && (positionals.length !== 2 || values.ci || values.config)) ||
      (!status && positionals.length !== 0)
    )
      throw new ConfigurationError(USAGE);
    const envFile =
      envFileArgument(values, process.cwd()) ??
      (!process.env.HUE_API_KEY && existsSync(DEFAULT_ENV_FILE) ? DEFAULT_ENV_FILE : undefined);
    if (envFile) {
      try {
        process.loadEnvFile(resolve(envFile));
      } catch {
        throw new ConfigurationError("Cannot load the configured environment file");
      }
    }
    const apiKey = process.env.HUE_API_KEY?.trim();
    if (!apiKey) throw new AuthenticationError("HUE_API_KEY is required");
    const baseUrl = values.origin ?? process.env.HUE_BASE_URL?.trim() ?? "https://app.hue.run";
    client = new EvaluationClient({ apiKey, baseUrl, signal: controller.signal });
    if (status) {
      invocation = await client.getEvalInvocation(z.uuid().parse(positionals[1]));
      report = evalReport(invocation);
    } else {
      const path = resolve(values.config ?? "hue.eval.json");
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(path, "utf8"));
      } catch {
        throw new ConfigurationError("Cannot read valid JSON from the eval config");
      }
      const result = evalConfig.safeParse(raw);
      if (!result.success)
        throw new ConfigurationError(
          "Invalid eval config: " +
            result.error.issues
              .map((issue) => `${issue.path.join(".") || "selection"}: ${issue.message}`)
              .join("; "),
        );
      const config = result.data;
      if (values.content) config.captureContent = true;
      if (values["no-content"]) config.captureContent = false;
      if (values["no-output"]) config.persistResultContent = false;
      if (values.turns !== undefined) {
        if (values.turns !== "hue" && values.turns !== "runner")
          throw new ConfigurationError("--turns must be hue or runner");
        config.turns = values.turns;
      }
      for (const [flag, key] of [
        ["concurrency", "concurrency"],
        ["deadline", "deadlineSeconds"],
        ["timeout", "timeoutSeconds"],
        ["wait", "scoringTimeoutSeconds"],
        ["trials", "trials"],
        ["min-pass-rate", "minPassRate"],
      ] as const) {
        const override = values[flag];
        // A blank value (an unset shell variable) must not read as a pass rate of 0.
        if (override !== undefined) config[key] = override.trim() ? Number(override) : Number.NaN;
      }
      if (!evalConfig.safeParse(config).success)
        throw new ConfigurationError("Invalid concurrency, timeout or trial override");
      timer = setTimeout(
        () => {
          deadline = true;
          controller.abort(new Error("Deadline exceeded"));
        },
        Math.max(1, startedAt + config.deadlineSeconds * 1000 - Date.now()),
      );
      const ci = await nativeCiContext();
      const baselineDirectory = config.baselineDirectory
        ? resolve(dirname(path), config.baselineDirectory)
        : undefined;
      const baseRevision = baselineDirectory ? checkedOutRevision(baselineDirectory) : undefined;
      if (baselineDirectory) {
        if (!baseRevision || (ci.baseSha && ci.baseSha !== baseRevision))
          throw new ConfigurationError("baselineDirectory must contain the intended base commit");
        ci.baseSha = baseRevision;
      }
      if (config.policy.baselineComparisons?.length && !ci.baseSha)
        throw new ConfigurationError("Baseline comparisons require an intended base commit");
      // The pass rate only gates saved receipts, so changing it re-gates without running agents.
      const {
        captureContent,
        persistResultContent,
        trials,
        minPassRate,
        turns,
        ...recoveryConfig
      } = config;
      const identity = {
        origin: baseUrl,
        // Default policies retain identities written before explicit privacy controls existed.
        config: {
          ...recoveryConfig,
          ...(!captureContent ? { captureContent } : {}),
          ...(!persistResultContent ? { persistResultContent } : {}),
          ...(trials > 1 ? { trials } : {}),
          ...(turns !== "hue" ? { turns } : {}),
        },
        ci,
        ...(ci.provider === "github" ? { job: process.env.GITHUB_JOB ?? "" } : {}),
      };
      const directory = resolve(values["checkpoint-dir"] ?? `.hue/ci/${digest(identity)}`);
      // Project identity is obtained before touching checkpoints to prevent cross-project reuse.
      const project = await client.checkConnection();
      store = await CheckpointStore.acquire(directory, { ...identity, projectId: project.id });
      const abortDeadline = () => {
        deadline = true;
        controller.abort(new Error("Deadline exceeded"));
      };
      const localScorers = config.localScorers.map((entry) => resolve(dirname(path), entry));
      const done: EvalInvocation[] = [];
      if (trials > 1) finished = done;
      for (let trial = 1; trial <= trials; trial++) {
        // A single trial keeps the checkpoint keys, idempotency key and name it always had.
        const key = trials > 1 ? `-${trial}` : "";
        const idempotencyKey =
          ci.provider === "github"
            ? `ci:${digest({ ...identity, projectId: project.id, ...(trials > 1 ? { trial } : {}) })}`
            : randomUUID();
        invocation = undefined;
        baseline = undefined;
        let request = await store.read<CreateEvalInvocationInput>(`request${key}`);
        if (!request && ci.provider === "github") {
          try {
            invocation = await client.getEvalInvocationByKey(idempotencyKey);
          } catch (error) {
            if (!(error instanceof HueApiError) || error.status !== 404) throw error;
          }
        }
        if (!request && !invocation) {
          // Later trials pin the eval set and evaluator versions the first trial froze.
          const first = done[0]?.manifest;
          const suffix = ` · trial ${trial}/${trials}`;
          request = createEvalInvocationInput.parse(
            JSON.parse(
              JSON.stringify({
                idempotencyKey,
                name:
                  trials === 1
                    ? config.name
                    : config.name
                      ? config.name.slice(0, 100 - suffix.length) + suffix
                      : `Trial ${trial}/${trials}`,
                evalSetId: first ? undefined : config.evalSetId,
                evalSetVersionId: first?.evalSetVersionId ?? config.evalSetVersionId,
                evaluatorIds: first ? undefined : config.evaluatorIds,
                evaluatorVersionIds:
                  first && config.evaluatorIds
                    ? first.evaluators.map((evaluator) => evaluator.id)
                    : config.evaluatorVersionIds,
                config: config.config,
                policy: config.policy,
                ci,
                // Every trial shares the first trial's saved deadline, also after recovery.
                deadlineAt:
                  done[0]?.deadlineAt ??
                  new Date(startedAt + config.deadlineSeconds * 1000).toISOString(),
                baselineRunId: config.baselineRunId,
              }),
            ),
          );
          await store.write(`request${key}`, request);
        }
        // Recover the invocation before starting the saved deadline, including terminal receipts.
        if (!invocation) {
          if (!request) throw new ConfigurationError("Missing invocation creation checkpoint");
          invocation = await client.createEvalInvocation(request);
        }
        const remaining = Date.parse(invocation.deadlineAt) - Date.now();
        clearTimeout(timer);
        if (invocation.state === "active" && !invocation.receipt) {
          if (remaining <= 0) abortDeadline();
          else timer = setTimeout(abortDeadline, remaining);
        }
        await store.write(`invocation${key}`, { id: invocation.id, runId: invocation.runId });
        if (!invocation.receipt && invocation.state === "active") {
          if (config.baselineCommand && baselineDirectory && !invocation.manifest.baselineRunId) {
            baseline = await client.createEvalBaseline(
              invocation.id,
              {
                idempotencyKey: `${invocation.id}:baseline`,
                ci: { ...ci, commitSha: baseRevision },
              },
              controller.signal,
            );
            if (baseline.state === "active" && !baseline.receipt) {
              await execute({
                client,
                connection: { apiKey, baseUrl },
                invocation: baseline,
                config: { ...config, command: config.baselineCommand, localScorers },
                projectDirectory: baselineDirectory,
                checkpointDirectory: checkpointPath(directory, [baseline.runId, "baseline run id"]),
                signal: controller.signal,
              });
              baseline = await settleInvocation(
                client,
                baseline,
                config.scoringTimeoutSeconds,
                controller.signal,
              );
            }
          }
          await execute({
            client,
            connection: { apiKey, baseUrl },
            invocation,
            config: { ...config, localScorers },
            projectDirectory: dirname(path),
            checkpointDirectory: checkpointPath(directory, [invocation.runId, "run id"]),
            signal: controller.signal,
          });
          invocation = await settleInvocation(
            client,
            invocation,
            config.scoringTimeoutSeconds,
            controller.signal,
          );
        }
        done.push(invocation);
      }
      report = trials > 1 ? trialReport(done, minPassRate) : evalReport(invocation);
    }
  } catch (error) {
    if (invocation && client && controller.signal.aborted) {
      try {
        const cancelling = new EvaluationClient({
          apiKey: process.env.HUE_API_KEY!.trim(),
          baseUrl: client.baseUrl,
          timeoutMillis: 5000,
          maxAttempts: 1,
        });
        if (baseline && baseline.state === "active" && !baseline.receipt)
          await cancelling.cancelEvalInvocation(baseline.id, {
            idempotencyKey: `${baseline.id}:cancel:${deadline ? "deadline" : "interrupted"}`,
            reason: deadline ? "deadline" : "interrupted",
          });
        invocation = await cancelling.cancelEvalInvocation(invocation.id, {
          idempotencyKey: `${invocation.id}:cancel:${deadline ? "deadline" : "interrupted"}`,
          reason: deadline ? "deadline" : "interrupted",
        });
      } catch {
        /* The remote deadline remains durable if cancellation cannot be delivered. */
      }
    }
    report = evalReport(invocation);
    if (finished)
      report.trials = [
        ...finished,
        ...(invocation && !finished.includes(invocation) ? [invocation] : []),
      ].map(trialRun);
    const auth =
      error instanceof AuthenticationError ||
      (error instanceof HueApiError && [401, 403].includes(error.status ?? 0));
    const configuration =
      error instanceof ConfigurationError ||
      error instanceof z.ZodError ||
      error instanceof TypeError ||
      error instanceof RangeError;
    const uncertain = uncertainOutcome(error);
    report.category = controller.signal.aborted
      ? deadline
        ? "incomplete"
        : "cancelled"
      : auth
        ? "authentication_error"
        : configuration
          ? "configuration_error"
          : uncertain
            ? "incomplete"
            : "hue_error";
    report.exitCode = controller.signal.aborted
      ? deadline
        ? 1
        : 130
      : auth || configuration
        ? 2
        : 1;
    // Customer command output and server response bodies never become setup diagnostics.
    const message =
      error instanceof ConfigurationError || error instanceof AuthenticationError
        ? error.message
        : uncertain
          ? "Agent outcome is uncertain; recovery will not execute it again"
          : controller.signal.aborted
            ? deadline
              ? "Overall deadline exceeded"
              : "Interrupted"
            : auth
              ? "Hue authentication failed"
              : configuration
                ? "Invalid evaluation configuration"
                : "Hue evaluation could not complete; recover with hue eval status";
    report.errors.push({ code: report.category, message });
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await store?.release();
  }
  const { json: serialized, summary } = await writeEvalReports(reportDirectory, report);
  if (json) process.stdout.write(serialized);
  else if (report.trials) process.stderr.write(summary);
  else
    process.stderr.write(
      `${report.verdict ?? report.category}${report.runUrl ? `: ${report.runUrl}` : ""}\n`,
    );
  return report.exitCode;
}
