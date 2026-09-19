import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { HueClient } from "../client.js";
import type { EnvironmentClient } from "../environment/client.js";
import { bindEnvironmentTools, type EnvironmentTool } from "../environment/tools.js";
import type { EvaluationClient } from "./client.js";
import { CheckpointStore } from "./checkpoint.js";
import {
  runExperiment,
  OutcomeSerializationError,
  TargetOutcomeUncertainError,
  UncertainExecutionError,
  type RunnerReport,
} from "./runner.js";
import type { ExperimentCase, JsonValue, LocalAgentRegistration, LocalScorer } from "./types.js";

/** Candidate-visible context for one queued local agent execution. */
export interface LocalAgentTargetContext {
  /** Frozen candidate configuration, cloned before invocation. */
  config: JsonValue;
  /** Identity only. Expected outcomes, metadata and world definitions are evaluator-private. */
  item: Pick<ExperimentCase, "id" | "externalKey">;
  /** Identity of this target execution. */
  executionId: string;
  /** Trace identities without mutable span or grading data. */
  trace: {
    /** OpenTelemetry trace identifier. */
    traceId: string;
    /** Root execution span identifier. */
    spanId: string;
  };
  /** Short-lived, execution-scoped hosted tools for model providers that execute MCP remotely. */
  mcp: {
    /** Execution-scoped MCP endpoint. */
    url: string;
    /** Short-lived bearer, never the project service key. */
    token: string;
    /** Capability expiry as an ISO timestamp. */
    expiresAt: string;
  };
}

/** Allowlist the candidate surface instead of forwarding the generic evaluation context. */
export function localAgentTargetContext(
  context: {
    config: JsonValue;
    item: ExperimentCase;
    executionId: string;
    span: { traceId: string; spanId: string };
  },
  mcp: LocalAgentTargetContext["mcp"],
): LocalAgentTargetContext {
  return {
    config: structuredClone(context.config),
    item: { id: context.item.id, externalKey: context.item.externalKey },
    executionId: context.executionId,
    trace: { traceId: context.span.traceId, spanId: context.span.spanId },
    mcp: { url: mcp.url, token: mcp.token, expiresAt: mcp.expiresAt },
  };
}

/** Fixed local callback, clients and durable queue-worker settings. */
export interface RunLocalAgentOptions {
  /** Evaluation client for the worker project. */
  client: EvaluationClient;
  /** Environment client for the same origin and project. */
  environmentClient: EnvironmentClient;
  /** Application telemetry client; required trace exports are acknowledged. */
  hue: HueClient;
  /** Private durable directory for worker identity and execution checkpoints. */
  checkpointDirectory: string;
  /** Fixed agent key and revision registered for queued runs. */
  agent: LocalAgentRegistration;
  /** Local scorer bindings matching the published source digests. */
  scorers?: LocalScorer[];
  /** Cases in flight, between 1 and 16; defaults to 1. */
  concurrency?: number;
  /** Polling interval in milliseconds, 250–60000; defaults to 2000. */
  pollIntervalMillis?: number;
  /** Stops polling cooperatively; does not cancel an active callback. */
  signal?: AbortSignal;
  /** Useful for one-shot jobs and deterministic acceptance. Omit to keep polling. */
  maxRuns?: number;
  /** Invokes the existing agent against isolated tools and candidate-safe context. */
  target(
    inputs: JsonValue,
    tools: Record<string, EnvironmentTool>,
    context: LocalAgentTargetContext,
  ): JsonValue | undefined | Promise<JsonValue | undefined>;
  /** Called after the experiment and queue completion are acknowledged. */
  onCompleted?(report: RunnerReport): void | Promise<void>;
}

function validInterval(value: number | undefined): number {
  const interval = value ?? 2_000;
  if (!Number.isInteger(interval) || interval < 250 || interval > 60_000)
    throw new RangeError("pollIntervalMillis must be 250–60000");
  return interval;
}

function stopReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("Local worker stopped", { cause: signal?.reason });
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(stopReason(signal));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    const aborted = () => {
      clearTimeout(timeout);
      reject(stopReason(signal));
    };
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

/** Confirm the authoritative seal after an uncertain acknowledgement without rerunning the agent. */
async function sealLocalRun(
  client: EnvironmentClient,
  runId: string,
  executionId: string,
  status: "completed" | "abandoned",
): Promise<void> {
  try {
    await client.finishRun(runId, {
      idempotencyKey: `execution:${executionId}:${status === "completed" ? "complete" : "abandon"}`,
      status,
    });
  } catch (error) {
    const recovered = await client.getRun(runId).catch(() => undefined);
    if (recovered?.status !== status)
      throw new TargetOutcomeUncertainError(executionId, { cause: error });
  }
}

/**
 * Starts an outbound-only worker for one fixed local agent entry point. Hue chooses
 * only the registered key/revision; no command or source is received from the cloud.
 */
export async function runLocalAgent(options: RunLocalAgentOptions): Promise<void> {
  const interval = validInterval(options.pollIntervalMillis);
  const maxRuns = options.maxRuns ?? Number.POSITIVE_INFINITY;
  if (!(maxRuns === Number.POSITIVE_INFINITY || (Number.isInteger(maxRuns) && maxRuns > 0)))
    throw new RangeError("maxRuns must be a positive integer");
  const directory = resolve(options.checkpointDirectory);
  const project = await options.client.checkConnection();
  const store = await CheckpointStore.acquire(directory, {
    kind: "local-agent-worker",
    projectId: project.id,
    baseUrl: options.client.baseUrl,
    agent: { key: options.agent.key, revision: options.agent.revision },
  });
  try {
    let workerId = await store.read<string>("worker-id");
    if (
      workerId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(workerId)
    )
      throw new Error("Invalid local worker identity");
    if (workerId === undefined) {
      workerId = randomUUID();
      await store.write("worker-id", workerId);
    }
    let completed = 0;
    while (completed < maxRuns && !options.signal?.aborted) {
      const agent = await options.client.registerLocalAgent({
        ...options.agent,
        capabilities: options.agent.capabilities ?? ["environment:v1"],
        scorerDigests:
          options.agent.scorerDigests ??
          options.scorers?.map((item) => item.definition.sourceDigest) ??
          [],
      });
      const claim = await options.client.claimLocalAgentRun({ agentId: agent.id, workerId });
      if (!claim) {
        await wait(interval, options.signal);
        continue;
      }
      const heartbeat = setInterval(
        () => {
          void options.client
            .heartbeatLocalAgentRun({ runId: claim.runId, workerId })
            .catch(() => undefined);
        },
        Math.min(15_000, Math.max(1_000, interval)),
      );
      let experimentFinished = false;
      try {
        const report = await runExperiment({
          client: options.client,
          hue: options.hue,
          experimentId: claim.experimentId,
          checkpointDirectory: join(directory, `experiment-${claim.experimentId}`),
          persistResultContent: true,
          environmentEvidence: "required",
          traceEvidence: { mode: "required" },
          scorers: options.scorers,
          concurrency: options.concurrency,
          target: async (inputs, context) => {
            const environmentVersionId = context.item.environmentVersionId;
            if (!environmentVersionId)
              throw new Error("The experiment case has no pinned environment version");
            const run = await options.environmentClient.createRun({
              idempotencyKey: `execution:${context.executionId}`,
              environmentVersionId,
              executionId: context.executionId,
            });
            const tools = bindEnvironmentTools({
              hue: options.hue,
              client: options.environmentClient,
              run,
              parentContext: context.span.context,
            });
            // Every failure after the world exists must still seal it. Completion refuses an
            // open linked world, and nothing else ever seals one, so an unsealed failure here
            // would leave the execution impossible to complete without operator intervention.
            try {
              const mcp = await options.client.createSimulationMcpCapability({
                runId: run.id,
                executionId: context.executionId,
              });
              const output = await options.target(
                structuredClone(inputs),
                tools,
                localAgentTargetContext(context, mcp),
              );
              await sealLocalRun(
                options.environmentClient,
                run.id,
                context.executionId,
                "completed",
              );
              return output;
            } catch (error) {
              // An unconfirmed completion keeps the execution uncertain; attempting an
              // abandonment here could misclassify a successfully completed candidate.
              if (error instanceof TargetOutcomeUncertainError) throw error;
              await sealLocalRun(
                options.environmentClient,
                run.id,
                context.executionId,
                "abandoned",
              );
              throw error;
            }
          },
        });
        // From this point onward the experiment outcome is authoritative. If reporting the
        // queue completion fails, leave the claim intact for checkpointed recovery instead of
        // rewriting a successful experiment as an agent failure.
        experimentFinished = true;
        await options.client.completeLocalAgentRun({
          runId: claim.runId,
          workerId,
          state: "completed",
        });
        await options.onCompleted?.(report);
        completed++;
      } catch (error) {
        // A durable outcome can still need completion/result uploads. Leave operational
        // failures claimed so the same worker can resume them through its checkpoints.
        // Attention is terminal in the queue and is reserved for explicit unsafe-to-resume
        // outcomes that require operator intervention.
        if (
          !experimentFinished &&
          (error instanceof TargetOutcomeUncertainError ||
            error instanceof UncertainExecutionError ||
            error instanceof OutcomeSerializationError)
        )
          await options.client
            .completeLocalAgentRun({
              runId: claim.runId,
              workerId,
              state: "attention",
              failureType: error instanceof Error ? error.name.slice(0, 200) : "WorkerError",
            })
            .catch(() => undefined);
        throw error;
      } finally {
        clearInterval(heartbeat);
      }
    }
  } finally {
    await store.release();
  }
}
