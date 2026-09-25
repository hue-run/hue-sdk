import { randomUUID } from "node:crypto";
import type { HueClient } from "../client.js";
import {
  HueEnvironmentError,
  isTransientEnvironmentError,
  type EnvironmentClient,
} from "../environment/client.js";
import { bindEnvironmentTools, type EnvironmentTool } from "../environment/tools.js";
import type { EnvironmentRun, WorldHandoff } from "../environment/types.js";
import { legacyMcpCapability, worldHandoff } from "../environment/world.js";
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
import type {
  ExperimentCase,
  JsonValue,
  LocalFile,
  SimulationMcpCapability,
  TargetResult,
} from "./types.js";

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
  /** Hue-native tools of a world created while the gateway was off; empty for a gateway
   * world, whose calls go to the provider mirrors in `world`. */
  tools: Record<string, EnvironmentTool>;
  /** The mirror URLs, world token, environment carriers and MCP configuration of a gateway
   * world. Absent for a world created while the gateway was off. */
  world?: WorldHandoff;
  /** One MCP endpoint and bearer: for a gateway world, its first MCP mirror with the world
   * token; otherwise the deprecated execution-scoped `hue_sim_` capability. Absent when a
   * gateway world has no MCP surface. */
  mcp?: SimulationMcpCapability;
  connectionBundle?: AttemptConnectionBundleV2;
  /** Verified copies of the case's agent-visible input files; evaluator-only files are never
   * among them. Empty when the case has none. */
  files: LocalFile[];
  /** Private directory for this case; return generated files with `withFiles`. */
  outputDirectory: string;
  signal?: AbortSignal;
}

interface RunnerTargetContext {
  config: JsonValue;
  item: ExperimentCase;
  executionId: string;
  span: HueSpan;
  files: LocalFile[];
  outputDirectory: string;
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
  /** The agent revision under test, sent on create for the world's fingerprint. */
  agentRevision?: string;
  /** Emit a one-time `DeprecationWarning` when a legacy path (Hue-native tools, the `hue_sim_`
   * capability, the provider facade) is used; on by default. A harness that adapts to whatever
   * the deployment serves, such as `hue eval`, turns it off. */
  deprecationWarnings?: boolean;
  signal?: AbortSignal;
  /** Test-only: shortens the seal wait. */
  sealTiming?: Partial<SealTiming>;
  onProgress?(event: EnvironmentTargetProgress): void | Promise<void>;
  target(
    inputs: JsonValue,
    context: EnvironmentTargetContext,
  ): JsonValue | TargetResult | undefined | Promise<JsonValue | TargetResult | undefined>;
}

/** The completion grace is five seconds; cap an unexpectedly distant timestamp and let reads
 * force the seal after the grace. */
export const MAX_GRACE_WAIT_MS = 10_000;
export const SEAL_POLL_MS = 250;
export const SEAL_WAIT_MS = 30_000;

/** The seal wait's bounds. Only tests shorten them; the helpers always use the defaults. */
export interface SealTiming {
  maxGraceWaitMs: number;
  pollMs: number;
  waitMs: number;
}
const SEAL_TIMING: SealTiming = {
  maxGraceWaitMs: MAX_GRACE_WAIT_MS,
  pollMs: SEAL_POLL_MS,
  waitMs: SEAL_WAIT_MS,
};

/** Finish, then wait for the authoritative run to leave open. */
async function seal(
  client: EnvironmentClient,
  runId: string,
  executionId: string,
  status: "completed" | "abandoned",
  timing: SealTiming,
): Promise<void> {
  let completingUntil: string | null | undefined;
  try {
    const finished = await client.finishRun(runId, {
      idempotencyKey: `execution:${executionId}:${status}`,
      status,
    });
    if (finished.lifecycle === "completing") completingUntil = finished.completingUntil ?? null;
  } catch (error) {
    // A gateway world answers 409 once it is completing, sealed or expired.
    const recovered = await client.getRun(runId).catch(() => undefined);
    if (
      recovered?.status !== status &&
      recovered?.status !== "expired" &&
      !(recovered?.status === "open" && recovered.lifecycle === "completing")
    )
      throw new TargetOutcomeUncertainError(executionId, { cause: error });
    if (recovered?.status === "open") completingUntil = recovered.completingUntil ?? null;
  }
  if (completingUntil !== undefined) {
    try {
      await awaitSeal(client, runId, completingUntil, timing);
    } catch (error) {
      throw new TargetOutcomeUncertainError(executionId, { cause: error });
    }
  }
}

/** Wait out a completing world's grace, then read until the server seals it. */
async function awaitSeal(
  client: EnvironmentClient,
  runId: string,
  completingUntil: string | null,
  timing: SealTiming,
): Promise<void> {
  const graceEnd = Date.parse(completingUntil ?? "");
  let wait = Number.isFinite(graceEnd)
    ? Math.min(Math.max(0, graceEnd - Date.now()), timing.maxGraceWaitMs)
    : 0;
  const deadline = performance.now() + wait + timing.waitMs;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error(`World ${runId} was not sealed after its completion grace`);
    // The deadline ends the read and the client's retries inside it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    wait = timing.pollMs;
    try {
      if ((await client.getRun(runId, { signal: controller.signal })).status !== "open") return;
    } catch (error) {
      if (!isTransientEnvironmentError(error)) throw error;
      if (performance.now() >= deadline)
        throw new Error(`World ${runId} was not sealed after its completion grace`, {
          cause: error,
        });
      // A 429 or 503 that outlasted the client's retries still says how long to wait.
      wait = Math.max(wait, (error as HueEnvironmentError).retryAfterMs ?? 0);
    } finally {
      clearTimeout(timer);
    }
    if (performance.now() >= deadline)
      throw new Error(`World ${runId} was not sealed after its completion grace`);
    wait = Math.min(wait, deadline - performance.now());
  }
}

const deprecations = new Set<string>();
/** One warning per process per legacy path. */
function warnDeprecated(code: string, message: string) {
  if (deprecations.has(code)) return;
  deprecations.add(code);
  process.emitWarning(message, { type: "DeprecationWarning", code });
}

/** The W3C context of the case span, sent on create so the world span parents on it. The
 * flags are the span's own: an unsampled case span is not exported, and the World API must not
 * be told otherwise. */
export function caseTraceparent(span: {
  traceId: string;
  spanId: string;
  span?: { spanContext?(): { traceFlags?: number } };
}): string {
  let flags = 1;
  try {
    const context = span.span?.spanContext?.();
    if (context && typeof context.traceFlags === "number") flags = context.traceFlags;
  } catch {
    // A span that cannot report its context is treated as sampled, as before.
  }
  return `00-${span.traceId}-${span.spanId}-${(flags & 0xff).toString(16).padStart(2, "0")}`;
}

/** What a deployment's credential-free gateway health said: `on` (200 with
 * `gateway: "simulation"`), `off` (the empty 404 the disabled handler answers, with no
 * `x-hue-diagnostic`), or `unknown` for anything else. */
export type GatewayState = "on" | "off" | "unknown";

const gatewayStates = new Map<string, Promise<GatewayState>>();
/**
 * Whether the deployment serves the simulation gateway, from its credential-free health
 * endpoint: 200 with `gateway: "simulation"` is on, the disabled handler's empty 404 (no
 * `x-hue-diagnostic`) is off, and anything else (a network failure, a timeout, a redirect, a
 * refusal carrying a diagnostic, another status or body) is unknown. Probed only after a create
 * was refused; on and off are remembered per origin, unknown is probed again next time.
 */
export function gatewayState(
  baseUrl: string,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<GatewayState> {
  const origin = new URL(baseUrl).origin;
  const remembered = gatewayStates.get(origin);
  if (remembered) return remembered;
  const probe: Promise<GatewayState> = fetchImpl(
    `${origin}/api/sim/gmailmcp.googleapis.com/_hue/health`,
    { redirect: "error", signal: AbortSignal.timeout(5_000) },
  )
    .then(async (response): Promise<GatewayState> => {
      if (response.status === 404)
        return response.headers.has("x-hue-diagnostic") ? "unknown" : "off";
      if (!response.ok) return "unknown";
      const body = (await response.json()) as { gateway?: unknown };
      return body.gateway === "simulation" ? "on" : "unknown";
    })
    .catch((): GatewayState => "unknown");
  gatewayStates.set(origin, probe);
  void probe.then((state) => {
    if (state === "unknown" && gatewayStates.get(origin) === probe) gatewayStates.delete(origin);
  });
  return probe;
}

/**
 * Creates the world with the World API fields. An older deployment whose simulation gateway is
 * off refuses them on the legacy create (400); when the deployment's health says the gateway is
 * off, the create is repeated once without them and the world is the legacy kind. A 400 from a
 * deployment with the gateway on is a real refusal (a trace context that does not match the
 * execution, for one) and is raised as it is, and so is a 400 whose deployment's health is
 * unknown (unreachable, a timeout): the fields are never dropped on a guess. The stable
 * idempotency key makes a repeat a replay, never a second world.
 */
export async function createWorldForExecution(
  client: Pick<EnvironmentClient, "createRun" | "baseUrl">,
  input: Parameters<EnvironmentClient["createRun"]>[0],
  options: { gatewayState?: (baseUrl: string) => Promise<GatewayState> } = {},
): Promise<EnvironmentRun> {
  try {
    return await client.createRun(input);
  } catch (error) {
    const { traceparent, agentRevision, ...legacy } = input;
    if (
      !(error instanceof HueEnvironmentError) ||
      error.status !== 400 ||
      (traceparent === undefined && agentRevision === undefined) ||
      (await (options.gatewayState ?? gatewayState)(client.baseUrl)) !== "off"
    )
      throw error;
    return client.createRun(legacy);
  }
}

/** One authoritative environment/provider lifecycle shared by direct simulations and
 * outbound local workers. Credential-bearing connections stay in this call frame and
 * are never returned to either runner's checkpoint state.
 */
export async function runEnvironmentTarget(
  options: RunEnvironmentTargetOptions,
): Promise<JsonValue | TargetResult | undefined> {
  const { context } = options;
  const environmentVersionId = context.item.environmentVersionId;
  if (!environmentVersionId)
    throw new Error("The simulation case has no pinned environment version");
  // One stable idempotency key per case attempt: a replay after a lost acknowledgement gets
  // the same world and the same token.
  const run: EnvironmentRun = await createWorldForExecution(options.environmentClient, {
    idempotencyKey: `execution:${context.executionId}`,
    environmentVersionId,
    executionId: context.executionId,
    maxSteps: options.maxSteps,
    ttlSeconds: options.ttlSeconds,
    traceparent: caseTraceparent(context.span),
    agentRevision: options.agentRevision,
  });
  const world = worldHandoff(run);
  const timing = { ...SEAL_TIMING, ...options.sealTiming };
  const progress = (event: EnvironmentTargetProgress) => options.onProgress?.(event);
  let finalized = false;
  try {
    await progress({ type: "world_created", environmentRunId: run.id });
    if (options.signal?.aborted) throw new TargetCancelledError();
    // A gateway world refuses Hue-native actions (409 simulation_world); its agent reaches
    // the provider mirrors in `world` instead.
    const tools = world
      ? {}
      : bindEnvironmentTools({
          hue: options.hue,
          client: options.environmentClient,
          run,
          parentContext: context.span.context,
        });
    const warn = options.deprecationWarnings ?? true;
    if (!world && warn)
      warnDeprecated(
        "HUE_NATIVE_SIMULATION_TOOLS",
        "Hue-native simulation tools and the hue_sim_ MCP capability are deprecated; worlds created through the simulation gateway hand the agent provider mirrors and a world token (context.world).",
      );
    let connectionBundle: AttemptConnectionBundleV2 | undefined;
    let mcp: SimulationMcpCapability | undefined;
    if (options.requested && !world) {
      if (warn)
        warnDeprecated(
          "HUE_PROVIDER_FACADE",
          "The provider facade (prepareAttempt) is deprecated; worlds created through the simulation gateway hand the agent provider mirrors and a world token (context.world).",
        );
      const actualManifest = actualAgentManifestV2.parse(
        typeof options.requested.actualAgentManifest === "function"
          ? await options.requested.actualAgentManifest({
              config: structuredClone(context.config),
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
        await seal(options.environmentClient, run.id, context.executionId, "completed", timing);
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
    } else if (world) {
      // A gateway world is served by the provider mirrors; the facade's attempt preflight
      // belongs to the legacy transport and is not run for it.
      if (options.requested && warn)
        warnDeprecated(
          "HUE_PROVIDER_FACADE_IGNORED",
          "Provider-profile options (requestedProviders, mcpSurface, actualAgentManifest) are ignored for a world the simulation gateway serves; the agent receives the provider mirrors in context.world.",
        );
      mcp = legacyMcpCapability(world);
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
      ...(world ? { world } : {}),
      ...(mcp ? { mcp } : {}),
      ...(connectionBundle ? { connectionBundle } : {}),
      files: structuredClone(context.files),
      outputDirectory: context.outputDirectory,
      signal: options.signal,
    });
    await seal(options.environmentClient, run.id, context.executionId, "completed", timing);
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
        await seal(options.environmentClient, run.id, context.executionId, "completed", timing);
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
      await seal(options.environmentClient, run.id, context.executionId, "abandoned", timing);
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
