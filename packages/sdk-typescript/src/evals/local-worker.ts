import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { HueClient } from "../client.js";
import type { EnvironmentClient } from "../environment/client.js";
import type { EnvironmentTool } from "../environment/tools.js";
import type { WorldHandoff } from "../environment/types.js";
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
  type RunExperimentTargetContext,
  type RunnerReport,
  type TelemetryNotAccepted,
} from "./runner.js";
import type {
  ExperimentCase,
  JsonValue,
  LocalAgentRegistration,
  LocalFile,
  LocalScorer,
  TargetResult,
} from "./types.js";

/** Capability strings a registration declares; Hue offers only matching cases. */
export const localAgentCapabilities = {
  /** Cases pinned to a hosted synthetic world. */
  environment: "environment:v1",
  /** Ordinary cases run directly on this machine: JSON inputs and pinned input files in,
   * JSON output and generated files out. */
  direct: "direct:v1",
  /** Cases pinned to a world that also carry agent-visible input files: `target` receives them
   * with the world and may return generated files. Declare it with `input:<extension>` for each
   * accepted file type; it requires `target`. */
  environmentFiles: "environment-files:v1",
} as const;

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
  /** The mirror URLs, world token, environment carriers and MCP configuration of a gateway
   * world; absent for a world created while the gateway was off. */
  world?: WorldHandoff;
  /** One MCP endpoint and bearer: the gateway world's first MCP mirror with the world token,
   * or the deprecated execution-scoped `hue_sim_` capability of a legacy world. */
  mcp?: {
    /** MCP endpoint. */
    url: string;
    /** Bearer for that endpoint, never the project service key. */
    token: string;
    /** Expiry as an ISO timestamp. */
    expiresAt: string;
  };
  /** Credential-bearing provider connections for this callback only. Hue never
   * checkpoints, logs or adds this response to parity digests. */
  connectionBundle?: AttemptConnectionBundleV2;
  /** Verified copies of the case's agent-visible input files; evaluator-only files are
   * withheld. Hue offers a world case with such files only to a registration declaring
   * `environment-files:v1`. Empty when the case has none. */
  files: LocalFile[];
  /** Private directory for this case, removed after it; return generated files with
   * `withFiles`. */
  outputDirectory: string;
}

/** Candidate-visible context for one queued ordinary case run directly on this machine. */
export interface LocalAgentDirectContext {
  /** Frozen candidate configuration, cloned before invocation. */
  config: JsonValue;
  /** Identity only. Expected outcomes and metadata are evaluator-private. */
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
  /** Verified copies of the case's input files meant for the agent. */
  files: LocalFile[];
  /** Private scratch directory for this case; return generated files with `withFiles`. */
  outputDirectory: string;
  /** Cooperative worker stop signal. */
  signal?: AbortSignal;
}

/** Allowlist the candidate surface for an ordinary case; frozen expectations stay with grading. */
export function localAgentDirectContext(
  context: RunExperimentTargetContext,
  signal?: AbortSignal,
): LocalAgentDirectContext {
  return {
    config: structuredClone(context.config),
    item: { id: context.item.id, externalKey: context.item.externalKey },
    executionId: context.executionId,
    trace: { traceId: context.span.traceId, spanId: context.span.spanId },
    files: structuredClone(context.files),
    outputDirectory: context.outputDirectory,
    ...(signal ? { signal } : {}),
  };
}

/** Allowlist the candidate surface instead of forwarding the generic evaluation context. */
function localAgentTargetContext(context: EnvironmentTargetContext): LocalAgentTargetContext {
  return {
    config: structuredClone(context.config),
    item: { id: context.item.id, externalKey: context.item.externalKey },
    executionId: context.executionId,
    environmentRunId: context.environmentRunId,
    trace: { traceId: context.trace.traceId, spanId: context.trace.spanId },
    ...(context.world ? { world: structuredClone(context.world) } : {}),
    ...(context.mcp
      ? {
          mcp: {
            url: context.mcp.url,
            token: context.mcp.token,
            expiresAt: context.mcp.expiresAt,
          },
        }
      : {}),
    ...(context.connectionBundle
      ? { connectionBundle: structuredClone(context.connectionBundle) }
      : {}),
    files: structuredClone(context.files),
    outputDirectory: context.outputDirectory,
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
  /** What a case does when its telemetry is not accepted; see
   * `traceNotAccepted` of {@link runExperiment}. Defaults to `"stop"`. */
  traceNotAccepted?: "stop" | "fail_case";
  /** Called as each case is failed for its telemetry; see `onTelemetryNotAccepted` of
   * {@link runExperiment}. */
  onTelemetryNotAccepted?(entry: TelemetryNotAccepted): void | Promise<void>;
  /** Polling interval in milliseconds, 250–60000; defaults to 2000. */
  pollIntervalMillis?: number;
  /** Stops polling cooperatively; does not cancel an active callback. */
  signal?: AbortSignal;
  /** Useful for one-shot jobs and deterministic acceptance. Omit to keep polling. */
  maxRuns?: number;
  /** Emit a one-time `DeprecationWarning` when the deployment serves a legacy world; on by default. */
  deprecationWarnings?: boolean;
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
  /** Runs cases pinned to a hosted world (`environment:v1`): invokes the existing agent against
   * isolated tools and candidate-safe context. Return the output, or `withFiles(output, files)`
   * when it generated files. */
  target?(
    inputs: JsonValue,
    tools: Record<string, EnvironmentTool>,
    context: LocalAgentTargetContext,
  ): JsonValue | TargetResult | undefined | Promise<JsonValue | TargetResult | undefined>;
  /** Runs ordinary cases without a world (`direct:v1`): the agent receives the case inputs
   * and verified input files and returns JSON output and/or generated files. */
  directTarget?(
    inputs: JsonValue,
    context: LocalAgentDirectContext,
  ): JsonValue | TargetResult | undefined | Promise<JsonValue | TargetResult | undefined>;
  /** Called after the experiment and queue completion are acknowledged. */
  onCompleted?(report: RunnerReport): void | Promise<void>;
}

/** The registration's capabilities: explicit values plus one per supplied callback. */
export function registeredCapabilities(options: {
  /** Fixed agent key, revision and declared capabilities. */
  agent: LocalAgentRegistration;
  /** The environment-case callback, when supplied. */
  target?: unknown;
  /** The ordinary-case callback, when supplied. */
  directTarget?: unknown;
}): string[] {
  if (!options.target && !options.directTarget)
    throw new TypeError(
      "Supply target for environment cases, directTarget for ordinary cases, or both",
    );
  const declared = options.agent.capabilities ?? [];
  if (declared.includes(localAgentCapabilities.direct) && !options.directTarget)
    throw new TypeError("direct:v1 requires a directTarget callback");
  if (declared.includes(localAgentCapabilities.environment) && !options.target)
    throw new TypeError("environment:v1 requires a target callback");
  if (declared.includes(localAgentCapabilities.environmentFiles) && !options.target)
    throw new TypeError("environment-files:v1 requires a target callback");
  return [
    ...new Set([
      ...declared,
      ...(options.target ? [localAgentCapabilities.environment] : []),
      ...(options.directTarget ? [localAgentCapabilities.direct] : []),
    ]),
  ];
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
  const capabilities = registeredCapabilities(options);
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
        capabilities,
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
          // Worker dispatch uses the case pin: directTarget never receives a world.
          environmentEvidence: options.directTarget ? "when_pinned" : "required",
          traceEvidence: { mode: "required" },
          ...(options.traceNotAccepted ? { traceNotAccepted: options.traceNotAccepted } : {}),
          ...(options.onTelemetryNotAccepted
            ? {
                onTelemetryNotAccepted: (entry: TelemetryNotAccepted) =>
                  options.onTelemetryNotAccepted!(entry),
              }
            : {}),
          scorers: options.scorers,
          concurrency: options.concurrency,
          target: (inputs, context) => {
            if (!context.item.environmentVersionId) {
              // Hue offers ordinary cases only to registrations that declared direct:v1.
              if (!options.directTarget)
                throw new Error("This worker runs only cases pinned to a Hue environment");
              return options.directTarget(
                structuredClone(inputs),
                localAgentDirectContext(context, options.signal),
              );
            }
            if (!options.target)
              throw new Error("This worker runs only cases without a Hue environment");
            // Bound to the options object, as the previous direct `options.target(...)` call was.
            const target = options.target.bind(options);
            return runEnvironmentTarget({
              client: options.client,
              environmentClient: options.environmentClient,
              hue: options.hue,
              inputs,
              context,
              requested,
              // The registered revision is the agent revision under test.
              agentRevision: options.agent.revision,
              deprecationWarnings: options.deprecationWarnings,
              signal: options.signal,
              target: (targetInputs, targetContext) =>
                target(
                  structuredClone(targetInputs),
                  targetContext.tools,
                  localAgentTargetContext(targetContext),
                ),
            });
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
