import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { HueClient } from "../client.js";
import type { EnvironmentClient } from "../environment/client.js";
import type { EnvironmentTool } from "../environment/tools.js";
import type {
  ActualAgentManifestInputV2,
  AttemptConnectionBundleV2,
  RequestedAttemptProviderV2,
} from "./attempt.js";
import type { EvaluationClient } from "./client.js";
import { CheckpointStore } from "./checkpoint.js";
import {
  pinRequestedAttemptV2,
  requestedAttemptV2,
  runEnvironmentTarget,
  type EnvironmentTargetContext,
} from "./environment-target.js";
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
  /** Stable world identity for adapter control operations such as coverage reporting. */
  environmentRunId: string;
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
  /** Credential-bearing provider connections for this callback only. Hue never
   * checkpoints, logs or adds this response to parity digests. */
  connectionBundle?: AttemptConnectionBundleV2;
}

/** Allowlist the candidate surface instead of forwarding the generic evaluation context. */
function localAgentTargetContext(context: EnvironmentTargetContext): LocalAgentTargetContext {
  return {
    config: structuredClone(context.config),
    item: { id: context.item.id, externalKey: context.item.externalKey },
    executionId: context.executionId,
    environmentRunId: context.environmentRunId,
    trace: { traceId: context.trace.traceId, spanId: context.trace.spanId },
    mcp: {
      url: context.mcp.url,
      token: context.mcp.token,
      expiresAt: context.mcp.expiresAt,
    },
    ...(context.connectionBundle
      ? { connectionBundle: structuredClone(context.connectionBundle) }
      : {}),
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
  /** Opt into the experiment's immutable V2 provider profile. These three values are
   * validated together before the worker polls; no endpoint or credential is supplied here. */
  actualAgentManifest?:
    | ActualAgentManifestInputV2
    | ((context: {
        /** Frozen experiment configuration. */
        config: JsonValue;
        /** Full frozen case for resolving actual nonsecret evidence before candidate projection. */
        item: ExperimentCase;
        /** Cooperative worker stop signal. */
        signal?: AbortSignal;
      }) => ActualAgentManifestInputV2 | Promise<ActualAgentManifestInputV2>);
  /** Exact provider instances and ordered surfaces asserted for strict preflight. */
  requestedProviders?: RequestedAttemptProviderV2[];
  /** Requested MCP surface projected to the backwards-compatible `context.mcp`. */
  mcpSurface?: {
    /** Provider instance selected from `requestedProviders`. */
    providerInstanceKey: string;
    /** Selected MCP surface. */
    surfaceKey: "google.gmail/mcp" | "slack/mcp";
  };
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

function needsAttention(error: unknown, seen = new Set<unknown>()): boolean {
  if (
    error instanceof TargetOutcomeUncertainError ||
    error instanceof UncertainExecutionError ||
    error instanceof OutcomeSerializationError
  )
    return true;
  if (!(error instanceof AggregateError) || seen.has(error)) return false;
  seen.add(error);
  return error.errors.some((nested: unknown) => needsAttention(nested, seen));
}

/**
 * Starts an outbound-only worker for one fixed local agent entry point. Hue chooses
 * only the registered key/revision; no command or source is received from the cloud.
 */
export async function runLocalAgent(options: RunLocalAgentOptions): Promise<void> {
  const requestedConfiguration = requestedAttemptV2(options);
  const interval = validInterval(options.pollIntervalMillis);
  const maxRuns = options.maxRuns ?? Number.POSITIVE_INFINITY;
  if (!(maxRuns === Number.POSITIVE_INFINITY || (Number.isInteger(maxRuns) && maxRuns > 0)))
    throw new RangeError("maxRuns must be a positive integer");
  if (options.environmentClient.baseUrl !== options.client.baseUrl)
    throw new Error("Environments and evaluations must use the same Hue origin");
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
        const requested = requestedConfiguration
          ? pinRequestedAttemptV2(
              requestedConfiguration,
              (await options.client.getExperiment(claim.experimentId)).config,
            )
          : undefined;
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
          target: (inputs, context) =>
            runEnvironmentTarget({
              client: options.client,
              environmentClient: options.environmentClient,
              hue: options.hue,
              inputs,
              context,
              requested,
              signal: options.signal,
              target: (targetInputs, targetContext) =>
                options.target(
                  structuredClone(targetInputs),
                  targetContext.tools,
                  localAgentTargetContext(targetContext),
                ),
            }),
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
        if (!experimentFinished && needsAttention(error))
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
