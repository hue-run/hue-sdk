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
import { collectExperimentVerdicts } from "../evals/verdicts.js";
import { UncertainExecutionError, TargetOutcomeUncertainError } from "../evals/runner.js";
import { evalReport, writeEvalReports } from "./eval-reports.js";
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
    policy: evalPolicy.default({ thresholds: [] }),
    concurrency: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(20),
    timeoutSeconds: seconds.default(600),
    scoringTimeoutSeconds: seconds.default(300),
    deadlineSeconds: seconds.default(900),
    baselineRunId: z.uuid().optional(),
    localScorers: z.array(z.string().min(1)).default([]),
  })
  .refine(
    (value) => Number(!!value.evalSetId) + Number(!!value.evalSetVersionId) === 1,
    "Choose exactly one eval set selector",
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

export function checkedOutRevision(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
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
  return evalCiContext.parse({
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
  });
}

const USAGE = `Usage: hue eval --ci --config hue.eval.json --report-dir .hue/reports
       hue eval status <run-id> [--report-dir .hue/reports] [--json]

--concurrency <n>  Positive integer (default: config or 20)
--deadline <sec>   Overall deadline (default: config or 900)
--timeout <sec>    Agent timeout per case (default: config or 600)
--wait <sec>       Scoring wait (default: config or 300)
--checkpoint-dir  Private recovery directory (default: .hue/ci/<identity>)
--origin <url>    Hue origin; otherwise HUE_BASE_URL
--env-path <path> Load a private dotenv file
--json            Print results.json on stdout
Exit codes: 0 pass, 1 failed/error/incomplete, 2 configuration, 130 interrupted.
`;

/** Saves creation bytes before sending; recovery replays them before any latest resolution. */
export async function runCiEvalCommand(argv: string[], execute: ExecuteCiRun): Promise<number> {
  // Locate the destination even if strict argument parsing fails, to report setup errors.
  const reportAt = argv.indexOf("--report-dir");
  let reportDirectory = resolve(
    reportAt >= 0 ? (argv[reportAt + 1] ?? ".hue/reports") : ".hue/reports",
  );
  let report = evalReport();
  let invocation: EvalInvocation | undefined;
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
      for (const [flag, key] of [
        ["concurrency", "concurrency"],
        ["deadline", "deadlineSeconds"],
        ["timeout", "timeoutSeconds"],
        ["wait", "scoringTimeoutSeconds"],
      ] as const) {
        const override = values[flag];
        if (override !== undefined) config[key] = Number(override);
      }
      if (!evalConfig.safeParse(config).success)
        throw new ConfigurationError("Invalid concurrency or timeout override");
      timer = setTimeout(
        () => {
          deadline = true;
          controller.abort(new Error("Deadline exceeded"));
        },
        Math.max(1, startedAt + config.deadlineSeconds * 1000 - Date.now()),
      );
      const ci = await nativeCiContext();
      const identity = {
        origin: baseUrl,
        config,
        ci,
        ...(ci.provider === "github" ? { job: process.env.GITHUB_JOB ?? "" } : {}),
      };
      const directory = resolve(values["checkpoint-dir"] ?? `.hue/ci/${digest(identity)}`);
      // Project identity is obtained before touching checkpoints to prevent cross-project reuse.
      const project = await client.checkConnection();
      const idempotencyKey =
        ci.provider === "github"
          ? `ci:${digest({ ...identity, projectId: project.id })}`
          : randomUUID();
      store = await CheckpointStore.acquire(directory, { ...identity, projectId: project.id });
      let request = await store.read<CreateEvalInvocationInput>("request");
      if (!request && ci.provider === "github") {
        try {
          invocation = await client.getEvalInvocationByKey(idempotencyKey);
        } catch (error) {
          if (!(error instanceof HueApiError) || error.status !== 404) throw error;
        }
      }
      if (!request && !invocation) {
        request = createEvalInvocationInput.parse(
          JSON.parse(
            JSON.stringify({
              idempotencyKey,
              name: config.name,
              evalSetId: config.evalSetId,
              evalSetVersionId: config.evalSetVersionId,
              evaluatorIds: config.evaluatorIds,
              evaluatorVersionIds: config.evaluatorVersionIds,
              config: config.config,
              policy: config.policy,
              ci,
              deadlineAt: new Date(startedAt + config.deadlineSeconds * 1000).toISOString(),
              baselineRunId: config.baselineRunId,
            }),
          ),
        );
        await store.write("request", request);
      }
      // Recover the invocation before starting the saved deadline, including terminal receipts.
      if (!invocation) {
        if (!request) throw new ConfigurationError("Missing invocation creation checkpoint");
        invocation = await client.createEvalInvocation(request);
      }
      const abortDeadline = () => {
        deadline = true;
        controller.abort(new Error("Deadline exceeded"));
      };
      const remaining = Date.parse(invocation.deadlineAt) - Date.now();
      clearTimeout(timer);
      if (invocation.state === "active" && !invocation.receipt) {
        if (remaining <= 0) abortDeadline();
        else timer = setTimeout(abortDeadline, remaining);
      }
      await store.write("invocation", { id: invocation.id, runId: invocation.runId });
      if (!invocation.receipt && invocation.state === "active") {
        await execute({
          client,
          connection: { apiKey, baseUrl },
          invocation,
          config,
          projectDirectory: dirname(path),
          checkpointDirectory: checkpointPath(directory, [invocation.runId, "run id"]),
          signal: controller.signal,
        });
        const scoringDeadline = Math.min(
          Date.parse(invocation.deadlineAt),
          Date.now() + config.scoringTimeoutSeconds * 1000,
        );
        while (!controller.signal.aborted) {
          invocation = await client.getEvalInvocation(invocation.id, controller.signal);
          if (invocation.receipt || invocation.state !== "active") break;
          const results = await collectExperimentVerdicts(client, {
            experimentId: invocation.runId,
            timeoutMillis: 0,
            signal: controller.signal,
          });
          if (
            (results.results.complete &&
              results.results.items.length === invocation.manifest.cases.length &&
              results.summary.totals.pending === 0) ||
            Date.now() >= scoringDeadline
          )
            break;
          await new Promise<void>((done) => {
            const finish = () => {
              clearTimeout(wait);
              controller.signal.removeEventListener("abort", finish);
              done();
            };
            const wait = setTimeout(finish, 1000);
            controller.signal.addEventListener("abort", finish, { once: true });
          });
        }
        controller.signal.throwIfAborted();
        if (!invocation.receipt)
          invocation = await client.finalizeEvalInvocation(
            invocation.id,
            { idempotencyKey: `${invocation.id}:finalize` },
            controller.signal,
          );
      }
      report = evalReport(invocation);
    }
  } catch (error) {
    if (invocation && client && controller.signal.aborted) {
      try {
        invocation = await new EvaluationClient({
          apiKey: process.env.HUE_API_KEY!.trim(),
          baseUrl: client.baseUrl,
          timeoutMillis: 5000,
          maxAttempts: 1,
        }).cancelEvalInvocation(invocation.id, {
          idempotencyKey: `${invocation.id}:cancel:${deadline ? "deadline" : "interrupted"}`,
          reason: deadline ? "deadline" : "interrupted",
        });
      } catch {
        /* The remote deadline remains durable if cancellation cannot be delivered. */
      }
    }
    report = evalReport(invocation);
    const auth =
      error instanceof AuthenticationError ||
      (error instanceof HueApiError && [401, 403].includes(error.status ?? 0));
    const configuration =
      error instanceof ConfigurationError ||
      error instanceof z.ZodError ||
      error instanceof TypeError ||
      error instanceof RangeError;
    const uncertain =
      error instanceof UncertainExecutionError || error instanceof TargetOutcomeUncertainError;
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
  const serialized = await writeEvalReports(reportDirectory, report);
  if (json) process.stdout.write(serialized);
  else
    process.stderr.write(
      `${report.verdict ?? report.category}${report.runUrl ? `: ${report.runUrl}` : ""}\n`,
    );
  return report.exitCode;
}
