import { randomUUID } from "node:crypto";
import type { HueClient } from "../client.js";
import type { EnvironmentClient } from "../environment/client.js";
import { bindEnvironmentTools, type EnvironmentTool } from "../environment/tools.js";
import type { EnvironmentRun } from "../environment/types.js";
import type { HueSpan } from "../types.js";
import {
  actualAgentManifestV2,
  attemptBaselineV2,
  projectMcpConnectionV2,
  requestedAttemptProvidersV2,
  validateAttemptConnectionBundleV2,
  type ActualAgentManifestInputV2,
  type AttemptBaselineV2,
  type AttemptConnectionBundleV2,
  type RequestedAttemptProviderV2,
  type SurfaceBindingV2,
} from "./attempt.js";
import type { EvaluationClient } from "./client.js";
import { TargetCancelledError, TargetOutcomeUncertainError } from "./runner.js";
import type { ExperimentCase, JsonValue, SimulationMcpCapability } from "./types.js";

export type McpSurfaceKeyV2 = Extract<SurfaceBindingV2["surfaceKey"], `${string}/mcp`>;

export type ActualAgentManifestResolverV2 =
  | ActualAgentManifestInputV2
  | ((context: {
      config: JsonValue;
      item: ExperimentCase;
      signal?: AbortSignal;
    }) => ActualAgentManifestInputV2 | Promise<ActualAgentManifestInputV2>);

export interface ProviderAttemptOptionsV2 {
  actualAgentManifest?: ActualAgentManifestResolverV2;
  requestedProviders?: RequestedAttemptProviderV2[];
  mcpSurface?: { providerInstanceKey: string; surfaceKey: McpSurfaceKeyV2 };
}

export type RequestedAttemptV2 = {
  actualAgentManifest: ActualAgentManifestResolverV2;
  requestedProviders: RequestedAttemptProviderV2[];
  mcpSurface: { providerInstanceKey: string; surfaceKey: McpSurfaceKeyV2 };
};

export type PinnedAttemptV2 = RequestedAttemptV2 & {
  expectedAgentManifestDigest: AttemptBaselineV2["expectedAgentManifestDigest"];
};

export function requestedAttemptV2(
  options: ProviderAttemptOptionsV2,
): RequestedAttemptV2 | undefined {
  const requested = options.requestedProviders !== undefined;
  const selected = options.mcpSurface !== undefined;
  if (!requested && !selected) {
    if (options.actualAgentManifest !== undefined)
      throw new TypeError("actualAgentManifest requires requestedProviders and mcpSurface");
    return undefined;
  }
  if (!requested || !selected)
    throw new TypeError("requestedProviders and mcpSurface must be supplied together");
  const requestedProviders = requestedAttemptProvidersV2.parse(options.requestedProviders);
  const mcpSurface = options.mcpSurface!;
  const provider = requestedProviders.find(
    (candidate) => candidate.providerInstanceKey === mcpSurface.providerInstanceKey,
  );
  if (!provider?.surfaceKeys.includes(mcpSurface.surfaceKey))
    throw new TypeError("mcpSurface must identify an exactly requested MCP surface");
  const actualAgentManifest =
    typeof options.actualAgentManifest === "function"
      ? options.actualAgentManifest
      : actualAgentManifestV2.parse(options.actualAgentManifest);
  return {
    actualAgentManifest,
    requestedProviders,
    mcpSurface: { ...mcpSurface },
  };
}

export function pinRequestedAttemptV2(
  requested: RequestedAttemptV2,
  config: JsonValue,
): PinnedAttemptV2 {
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new TypeError("Provider-profile simulations require an immutable V2 attempt baseline");
  const source = config as Record<string, JsonValue>;
  const baseline = attemptBaselineV2.safeParse(source.attemptBaselineV2);
  if (!baseline.success) {
    if (source.attemptBaselineV2 === undefined && source.attemptBaselineV1 !== undefined)
      throw new TypeError("Legacy V1 attempts require a fresh experiment with a V2 baseline");
    if (source.attemptBaselineV2 !== undefined)
      throw new TypeError("The immutable V2 attempt baseline is invalid");
    throw new TypeError("Provider-profile simulations require an immutable V2 attempt baseline");
  }
  return { ...requested, expectedAgentManifestDigest: baseline.data.expectedAgentManifestDigest };
}

export type EnvironmentTargetProgress =
  | { type: "world_created" | "target_started" | "world_sealed"; environmentRunId: string }
  | {
      type: "attempt_prepared";
      environmentRunId: string;
      bindingId: string;
      status: "ready" | "environment_incomplete";
      findingCodes: string[];
      executionManifestDigest?: AttemptConnectionBundleV2["parity"]["executionManifestDigest"];
    };

export interface EnvironmentTargetContext {
  config: JsonValue;
  item: ExperimentCase;
  executionId: string;
  environmentRunId: string;
  trace: { traceId: string; spanId: string };
  tools: Record<string, EnvironmentTool>;
  mcp: SimulationMcpCapability;
  connectionBundle?: AttemptConnectionBundleV2;
  signal?: AbortSignal;
}

interface RunnerTargetContext {
  config: JsonValue;
  item: ExperimentCase;
  executionId: string;
  span: HueSpan;
}

export interface RunEnvironmentTargetOptions {
  client: EvaluationClient;
  environmentClient: EnvironmentClient;
  hue: HueClient;
  inputs: JsonValue;
  context: RunnerTargetContext;
  requested?: PinnedAttemptV2;
  maxSteps?: number;
  ttlSeconds?: number;
  signal?: AbortSignal;
  onProgress?(event: EnvironmentTargetProgress): void | Promise<void>;
  target(
    inputs: JsonValue,
    context: EnvironmentTargetContext,
  ): JsonValue | undefined | Promise<JsonValue | undefined>;
}

/** Confirm a seal from the authoritative run after a lost acknowledgement. */
async function seal(
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

/** One authoritative environment/provider lifecycle shared by direct simulations and
 * outbound local workers. Credential-bearing connections stay in this call frame and
 * are never returned to either runner's checkpoint state.
 */
export async function runEnvironmentTarget(
  options: RunEnvironmentTargetOptions,
): Promise<JsonValue | undefined> {
  const { context } = options;
  const environmentVersionId = context.item.environmentVersionId;
  if (!environmentVersionId)
    throw new Error("The simulation case has no pinned environment version");
  const run: EnvironmentRun = await options.environmentClient.createRun({
    idempotencyKey: `execution:${context.executionId}`,
    environmentVersionId,
    executionId: context.executionId,
    maxSteps: options.maxSteps,
    ttlSeconds: options.ttlSeconds,
  });
  const progress = (event: EnvironmentTargetProgress) => options.onProgress?.(event);
  let finalized = false;
  try {
    await progress({ type: "world_created", environmentRunId: run.id });
    if (options.signal?.aborted) throw new TargetCancelledError();
    const tools = bindEnvironmentTools({
      hue: options.hue,
      client: options.environmentClient,
      run,
      parentContext: context.span.context,
    });
    let connectionBundle: AttemptConnectionBundleV2 | undefined;
    let mcp: SimulationMcpCapability;
    if (options.requested) {
      const actualManifest = actualAgentManifestV2.parse(
        typeof options.requested.actualAgentManifest === "function"
          ? await options.requested.actualAgentManifest({
              config: context.config,
              item: structuredClone(context.item),
              signal: options.signal,
            })
          : options.requested.actualAgentManifest,
      );
      let prepared;
      try {
        prepared = await options.client.prepareAttempt({
          schemaVersion: 2,
          idempotencyKey: randomUUID(),
          executionId: context.executionId,
          environmentRunId: run.id,
          expectedAgentManifestDigest: options.requested.expectedAgentManifestDigest,
          actualManifest,
          requestedProviders: options.requested.requestedProviders,
        });
      } catch (error) {
        // A transport failure or malformed credential-bearing response may follow a
        // committed decision. The runner's running checkpoint prevents reacquisition
        // and target replay on resume.
        throw new TargetOutcomeUncertainError(context.executionId, { cause: error });
      }
      await progress({
        type: "attempt_prepared",
        environmentRunId: run.id,
        bindingId: prepared.status === "ready" ? prepared.bundle.bindingId : prepared.bindingId,
        status: prepared.status,
        findingCodes: prepared.preflightReport.findings.map((finding) => finding.code),
        ...(prepared.status === "ready"
          ? { executionManifestDigest: prepared.bundle.parity.executionManifestDigest }
          : {}),
      });
      if (prepared.status === "environment_incomplete") {
        await seal(options.environmentClient, run.id, context.executionId, "completed");
        finalized = true;
        await Promise.resolve(progress({ type: "world_sealed", environmentRunId: run.id })).catch(
          () => undefined,
        );
        return undefined;
      }
      connectionBundle = validateAttemptConnectionBundleV2(prepared.bundle, {
        requireFresh: true,
      });
      const projected = projectMcpConnectionV2(
        connectionBundle,
        options.requested.mcpSurface.providerInstanceKey,
      );
      if (!projected) throw new TypeError("The prepared attempt has no selected MCP surface");
      mcp = projected;
    } else {
      mcp = await options.client.createSimulationMcpCapability({
        runId: run.id,
        executionId: context.executionId,
      });
    }
    if (options.signal?.aborted) throw new TargetCancelledError();
    await progress({ type: "target_started", environmentRunId: run.id });
    const output = await options.target(options.inputs, {
      config: context.config,
      item: context.item,
      executionId: context.executionId,
      environmentRunId: run.id,
      trace: { traceId: context.span.traceId, spanId: context.span.spanId },
      tools,
      mcp,
      ...(connectionBundle ? { connectionBundle } : {}),
      signal: options.signal,
    });
    await seal(options.environmentClient, run.id, context.executionId, "completed");
    finalized = true;
    await Promise.resolve(progress({ type: "world_sealed", environmentRunId: run.id })).catch(
      () => undefined,
    );
    return output;
  } catch (error) {
    if (error instanceof TargetOutcomeUncertainError || finalized) throw error;
    let environmentIncomplete: boolean;
    try {
      environmentIncomplete =
        (await options.environmentClient.getRun(run.id)).validity === "environment_incomplete";
    } catch (inspectionError) {
      throw new TargetOutcomeUncertainError(context.executionId, {
        cause: new AggregateError([error, inspectionError]),
      });
    }
    if (environmentIncomplete) {
      try {
        await seal(options.environmentClient, run.id, context.executionId, "completed");
      } catch (finalizationError) {
        throw new TargetOutcomeUncertainError(context.executionId, {
          cause: new AggregateError([error, finalizationError]),
        });
      }
      finalized = true;
      await Promise.resolve(progress({ type: "world_sealed", environmentRunId: run.id })).catch(
        () => undefined,
      );
      return undefined;
    }
    try {
      await seal(options.environmentClient, run.id, context.executionId, "abandoned");
    } catch (finalizationError) {
      throw new TargetOutcomeUncertainError(context.executionId, {
        cause: new AggregateError([error, finalizationError]),
      });
    }
    await Promise.resolve(progress({ type: "world_sealed", environmentRunId: run.id })).catch(
      () => undefined,
    );
    if (options.signal?.aborted && !(error instanceof TargetCancelledError))
      throw new TargetCancelledError();
    throw error;
  }
}
