import {
  readWorldRefusal,
  TERMINAL_WORLD_DIAGNOSTICS,
  type WorldPreparationProgress,
} from "./readiness.js";
import { validateOptions } from "../config.js";
import { aggregateBounds, json, uuid, valueBounds, type JsonBounds } from "../evals/json.js";
import type {
  ActionInput,
  ActionResult,
  CoverageGapInput,
  CoverageGapResult,
  CreateRunInput,
  Environment,
  PublishableEnvironmentDefinition,
  EnvironmentIdentity,
  EnvironmentPage,
  EnvironmentPageOptions,
  EnvironmentRun,
  EnvironmentSummary,
  EnvironmentVersion,
  EnvironmentVersionSummary,
  FinishRunInput,
  RunState,
  SealedRun,
  StepPage,
  StepPageOptions,
  WorldEvidence,
  WorldEvidenceOptions,
} from "./types.js";

import type { PublishableWorldDefinition, WorldVersion } from "./definitions.js";

/** Connection and retry options for {@link createEnvironmentClient}. */
export interface EnvironmentClientOptions {
  /** Project service key sent as a bearer token; server-side only. */
  apiKey: string;
  /** Hue origin; defaults to `https://app.hue.run`. */
  baseUrl?: string;
  /** Select a project explicitly instead of using the key's default project. */
  projectId?: string;
  /** Per-request deadline in milliseconds. */
  timeoutMillis?: number;
  /** Attempts for idempotent run mutations, 1–10; defaults to 4. */
  maxAttempts?: number;
}
/** Sanitized environment API failure that never includes response text or credentials. */
export class HueEnvironmentError extends Error {
  constructor(
    /** HTTP status when Hue answered; absent for transport, timeout or parse failure. */
    readonly status?: number,
    /** Hue's `Retry-After` in milliseconds, bounded, when a 429 or 503 carried one. */
    readonly retryAfterMs?: number,
    /** The server's `X-Hue-Diagnostic` code, when it is a short snake-case value. */
    readonly diagnostic?: string,
    /** Bounded, sanitized progress for a World preparation refusal. */
    readonly preparation?: WorldPreparationProgress,
    /** The gateway's own message for a World refusal, bounded and without control characters. */
    readonly hint?: string,
  ) {
    super(
      status
        ? `Hue environment request failed (HTTP ${status}${diagnostic ? `, ${diagnostic}` : ""})${hint ? `: ${hint}` : ""}`
        : "Hue environment connection or response failed",
    );
    this.name = "HueEnvironmentError";
  }
}

/** Starts one isolated instance from an immutable World version. */
export interface CreateInstanceInput extends Omit<CreateRunInput, "environmentVersionId"> {
  /** Immutable World version to instantiate. */
  worldVersionId: string;
}

const DIAGNOSTIC = /^[a-z_]{1,64}$/;
/** The response's diagnostic code, or undefined when absent or invalid. */
function diagnosticOf(response: Response): string | undefined {
  const value = response.headers.get("x-hue-diagnostic");
  return value !== null && DIAGNOSTIC.test(value) ? value : undefined;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
/** A connection failure or a status the client retries; seal polling continues through these. */
export function isTransientEnvironmentError(error: unknown): boolean {
  return (
    error instanceof HueEnvironmentError &&
    (error.status === undefined || RETRYABLE.has(error.status)) &&
    !(error.status === 503 && TERMINAL_WORLD_DIAGNOSTICS.has(error.diagnostic ?? ""))
  );
}
/** A `Retry-After` longer than this waits this long: Hue asks for a second, never minutes. */
const MAX_RETRY_AFTER_MS = 10_000;
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
/** Version 00 with real identifiers: an all-zero trace or span ID is invalid, and Hue refuses it. */
function validTraceparent(value: string) {
  if (!TRACEPARENT.test(value)) return false;
  const [, traceId, spanId] = value.split("-");
  return !/^0+$/.test(traceId!) && !/^0+$/.test(spanId!);
}

/** Whole seconds only, as Hue sends them; a date or garbage is ignored. */
function retryAfterMillis(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null || !/^\d{1,6}$/.test(header.trim())) return undefined;
  return Math.min(Number(header.trim()) * 1000, MAX_RETRY_AFTER_MS);
}
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_BOUNDS: JsonBounds = { ...valueBounds, bytes: 1024 * 1024 };
/** The server bounds JSON inside each entity independently, then permits the parsed
 * definition to contain up to 240 KB. The publication wrapper adds one node/depth
 * level and a small fixed byte prefix. Aggregate bounds cover every server-valid
 * definition without relaxing action/run request envelopes.
 */
const ENVIRONMENT_PUBLICATION_BOUNDS = aggregateBounds(240_000 + 32);

type RunRequestOptions = {
  signal?: AbortSignal;
  onPreparing?: (error: HueEnvironmentError) => void;
  nativeConnections?: boolean;
};

function verifiedPostgresUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      ["postgres:", "postgresql:"].includes(url.protocol) &&
      Boolean(url.hostname && url.username && url.password && url.pathname.length > 1) &&
      url.searchParams.get("sslmode") === "verify-full"
    );
  } catch {
    return false;
  }
}

/** Typed client for authored Worlds, isolated World instances and immutable journals. */
export class WorldClient {
  /** Validated Hue origin. */
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #projectId?: string;
  private readonly timeoutMillis: number;
  private readonly maxAttempts: number;
  constructor(options: EnvironmentClientOptions) {
    const validated = validateOptions({
      ...options,
      serviceName: "hue-environments",
      captureContent: false,
    });
    this.baseUrl = validated.baseUrl;
    this.#apiKey = validated.apiKey;
    if (options.projectId !== undefined) this.#projectId = uuid(options.projectId);
    this.timeoutMillis = validated.timeoutMillis;
    const attempts = options.maxAttempts ?? 4;
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10)
      throw new RangeError("maxAttempts must be 1–10");
    this.maxAttempts = attempts;
  }

  /** Compatibility clients override only resource routing. */
  protected resourcePath(path: string): string {
    return path
      .replace(/^\/environments(?=\/|$|\?)/, "/worlds")
      .replace(/^\/environment-versions(?=\/|$|\?)/, "/world-versions")
      .replace(/^\/environment-runs(?=\/|$|\?)/, "/instances");
  }

  private async send<T>(
    method: string,
    path: string,
    payload?: string,
    options: RunRequestOptions = {},
  ): Promise<T> {
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(this.timeoutMillis);
      response = await fetch(`${this.baseUrl}/api/v1${this.resourcePath(path)}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          ...(this.#projectId ? { "X-Hue-Project": this.#projectId } : {}),
          ...(options.nativeConnections ? { "X-Hue-Native-Connections": "1" } : {}),
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
        body: payload,
        redirect: "error",
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      });
    } catch {
      throw new HueEnvironmentError();
    }
    if (!response.ok) {
      const diagnostic = diagnosticOf(response);
      const refusal = await readWorldRefusal(response, diagnostic);
      throw new HueEnvironmentError(
        response.status,
        response.status === 429 || response.status === 503 ? retryAfterMillis(response) : undefined,
        diagnostic,
        refusal.preparation,
        refusal.message,
      );
    }
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) throw new Error("Oversized response");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } catch {
      throw new HueEnvironmentError();
    }
  }

  /** @internal Shared bounded transport for World clients. */
  protected async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RunRequestOptions = {},
    waitForWorld = false,
  ): Promise<T> {
    // Serialize once: a body this client cannot encode is a caller error that no retry fixes.
    const payload =
      body === undefined
        ? undefined
        : JSON.stringify(
            json(
              Object.fromEntries(
                Object.entries(body as object).filter(([, value]) => value !== undefined),
              ),
              REQUEST_BOUNDS,
            ),
          );
    const { signal } = options;
    let ordinaryFailures = 0;
    // A World that is still preparing is waited for as long as the gateway says to retry and the
    // caller's signal stands; the last refusal, with the gateway's own words, is what a caller that
    // stops waiting sees, not a connection failure.
    let preparing: HueEnvironmentError | undefined;
    for (;;) {
      if (signal?.aborted) throw preparing ?? new HueEnvironmentError();
      try {
        return await this.send<T>(method, path, payload, options);
      } catch (error) {
        if (!(error instanceof HueEnvironmentError)) throw error;
        if (signal?.aborted) throw preparing ?? error;
        let wait: number;
        if (waitForWorld && error.status === 503 && error.diagnostic === "world_preparing") {
          preparing = error;
          options.onPreparing?.(error);
          // A zero Retry-After must not turn preparation into an unbounded busy loop.
          wait = Math.max(100, error.retryAfterMs ?? 1000);
        } else {
          ordinaryFailures++;
          if (!isTransientEnvironmentError(error) || ordinaryFailures >= this.maxAttempts)
            throw error;
          const backoff = Math.min(100 * 2 ** (ordinaryFailures - 1), 2000);
          wait = error.retryAfterMs ?? backoff + Math.random() * backoff;
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
          }, wait);
          const abort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            reject(preparing ?? new HueEnvironmentError());
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      }
    }
  }

  /** @internal Single-attempt transport for non-idempotent compatibility operations. */
  protected requestOnce<T>(
    method: string,
    path: string,
    body?: unknown,
    bounds: JsonBounds = REQUEST_BOUNDS,
  ): Promise<T> {
    const payload =
      body === undefined
        ? undefined
        : JSON.stringify(
            json(
              Object.fromEntries(
                Object.entries(body as object).filter(([, value]) => value !== undefined),
              ),
              bounds,
            ),
          );
    return this.send<T>(method, path, payload);
  }

  private page(options: EnvironmentPageOptions = {}): string {
    const query = new URLSearchParams();
    if (options.after) query.set("after", uuid(options.after));
    if (options.limit !== undefined) {
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
        throw new RangeError("Page limit must be 1–100");
      query.set("limit", String(options.limit));
    }
    return query.size ? `?${query}` : "";
  }

  /** Creates an isolated instance from an immutable World version. */
  createInstance(
    input: CreateInstanceInput,
    options: { signal?: AbortSignal; nativeConnections?: boolean } = {},
  ) {
    const { worldVersionId, ...runInput } = input;
    return this.createRun({ ...runInput, environmentVersionId: worldVersionId }, options);
  }
  /** Starts an instance and hands its verified Postgres URL only to the callback. */
  async withPostgres<Result>(
    input: CreateInstanceInput,
    use: (url: string, instance: EnvironmentRun) => Promise<Result>,
    options: { signal?: AbortSignal } = {},
  ): Promise<Result> {
    if (options.signal?.aborted) throw new HueEnvironmentError();
    const instance = await this.createInstance(input, {
      signal: AbortSignal.timeout(60_000),
      nativeConnections: true,
    });
    const deadline = AbortSignal.timeout(60_000);
    const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
    const idempotencyKey = crypto.randomUUID();
    let result: Result;
    try {
      const url = await this.waitForPostgres(instance, signal);
      if (signal.aborted) throw new HueEnvironmentError();
      result = await use(url, instance);
      if (options.signal?.aborted) throw new HueEnvironmentError();
    } catch (error) {
      try {
        await this.finishInstance(instance.id, { idempotencyKey, status: "abandoned" });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Postgres handoff and finish failed");
      }
      throw error;
    }
    await this.finishInstance(instance.id, { idempotencyKey, status: "completed" });
    return result;
  }

  private async waitForPostgres(instance: EnvironmentRun, signal: AbortSignal): Promise<string> {
    const app = Array.isArray(instance.nativeApps)
      ? instance.nativeApps.find((entry) => entry?.providerId === "postgres")
      : undefined;
    if (typeof app?.appKey !== "string" || !app.appKey || app.appKey.length > 128)
      throw new Error("World instance has no Postgres app");
    const path = `/environment-runs/${uuid(instance.id)}/native-connection`;
    for (;;) {
      const connection = await this.request<{ state?: string; url?: unknown } | null>(
        "POST",
        path,
        { appKey: app.appKey },
        { signal },
      );
      if (connection?.state === "ready" && verifiedPostgresUrl(connection.url))
        return connection.url;
      if (connection?.state !== "preparing") throw new Error("Postgres connection is unavailable");
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
  }
  /** Reads current or sealed instance state. */
  getInstance(instanceId: string, options: { signal?: AbortSignal } = {}) {
    return this.getRun(instanceId, options);
  }
  /** Completes or abandons one instance and freezes its evidence. */
  finishInstance(instanceId: string, input: FinishRunInput) {
    return this.finishRun(instanceId, input);
  }

  /** Creates a World identity using the client's resource routes. */
  createWorld(input: EnvironmentIdentity) {
    return this.createEnvironment(input);
  }
  /** Lists active Worlds. */
  listWorlds(page?: EnvironmentPageOptions) {
    return this.listEnvironments(page);
  }
  /** Reads a World and its immutable version summaries. */
  getWorld(id: string) {
    return this.getEnvironment(id);
  }

  /** Creates an environment identity; this non-idempotent registry write is not retried. */
  createEnvironment(input: EnvironmentIdentity) {
    return this.requestOnce<EnvironmentSummary>("POST", "/environments", input);
  }
  /** Lists active environment identities. */
  listEnvironments(page?: EnvironmentPageOptions) {
    return this.request<EnvironmentPage>("GET", `/environments${this.page(page)}`);
  }
  /** Reads one environment and its immutable version summaries. */
  getEnvironment(id: string) {
    return this.request<Environment>("GET", `/environments/${uuid(id)}`);
  }
  /** Publishes an immutable definition; this non-idempotent registry write is not retried. */
  publishVersion(environmentId: string, definition: PublishableWorldDefinition) {
    return this.requestOnce<EnvironmentVersionSummary>(
      "POST",
      `/environments/${uuid(environmentId)}/versions`,
      { definition },
      ENVIRONMENT_PUBLICATION_BOUNDS,
    );
  }
  /** Reads a full immutable environment version and generated action catalog. */
  getVersion(id: string) {
    return this.request<WorldVersion>("GET", `/environment-versions/${uuid(id)}`);
  }
  /** Creates or recovers one fresh isolated world using a stable idempotency key. */
  createRun(
    input: CreateRunInput,
    options: {
      signal?: AbortSignal;
      onPreparing?: (error: HueEnvironmentError) => void;
      nativeConnections?: boolean;
    } = {},
  ) {
    if (
      input.maxSteps !== undefined &&
      (!Number.isInteger(input.maxSteps) || input.maxSteps < 1 || input.maxSteps > 500)
    )
      throw new RangeError("maxSteps must be 1–500");
    if (
      input.ttlSeconds !== undefined &&
      (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 86_400)
    )
      throw new RangeError("ttlSeconds must be 1–86400");
    if (input.seed !== undefined && !/^[a-f0-9]{32}$/.test(input.seed))
      throw new TypeError("Seed must be 32 lowercase hexadecimal characters");
    if (input.traceparent !== undefined && !validTraceparent(input.traceparent))
      throw new TypeError("traceparent must be a version-00 W3C trace context");
    if (
      input.agentRevision !== undefined &&
      (typeof input.agentRevision !== "string" ||
        input.agentRevision.length < 1 ||
        input.agentRevision.length > 256)
    )
      throw new RangeError("agentRevision must be 1–256 characters");
    return this.request<EnvironmentRun>(
      "POST",
      "/environment-runs",
      {
        ...input,
        ...(input.environmentVersionId === undefined
          ? {}
          : { environmentVersionId: uuid(input.environmentVersionId) }),
        ...(input.executionId === undefined ? {} : { executionId: uuid(input.executionId) }),
      },
      options,
      true,
    );
  }
  /** Reads authoritative current or sealed world state. */
  async getRun(runId: string, options: { signal?: AbortSignal } = {}) {
    const run = await this.request<RunState>(
      "GET",
      `/environment-runs/${uuid(runId)}`,
      undefined,
      options,
    );
    return { validity: "not_assessed" as const, coverageGap: null, ...run };
  }
  /** Record a known coverage gap with durable identity; retries reuse the exact request. */
  recordCoverageGap(runId: string, input: CoverageGapInput) {
    uuid(input.idempotencyKey);
    if (!input.args || typeof input.args !== "object" || Array.isArray(input.args))
      throw new TypeError("Coverage gap arguments must be a JSON object");
    json(input.args, { ...valueBounds, bytes: 16_000 });
    return this.request<CoverageGapResult>(
      "POST",
      `/environment-runs/${uuid(runId)}/coverage-gap`,
      input,
    );
  }
  /** Invokes an action; repeating an invocation identity replays its recorded result. */
  act(runId: string, input: ActionInput) {
    return this.request<ActionResult>("POST", `/environment-runs/${uuid(runId)}/actions`, {
      ...input,
      args: input.args ?? {},
    });
  }
  /** Pages the immutable journal by step ordinal. */
  listSteps(runId: string, page: StepPageOptions = {}) {
    const query = new URLSearchParams();
    if (page.after !== undefined) {
      if (!Number.isInteger(page.after) || page.after < -1)
        throw new RangeError("Step cursor must be an ordinal");
      query.set("after", String(page.after));
    }
    if (page.limit !== undefined) {
      if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100)
        throw new RangeError("Page limit must be 1–100");
      query.set("limit", String(page.limit));
    }
    return this.request<StepPage>(
      "GET",
      `/environment-runs/${uuid(runId)}/steps${query.size ? `?${query}` : ""}`,
    );
  }
  /** Seals a world as completed or abandoned and freezes its evidence. */
  finishRun(runId: string, input: FinishRunInput) {
    return this.request<SealedRun>("POST", `/environment-runs/${uuid(runId)}/finish`, input);
  }
  /** Reads a sealed world's evaluator-only evidence with the project key; a world token never
   * can. An open world answers 409 until it is sealed. */
  getEvidence(runId: string, options: WorldEvidenceOptions = {}) {
    const query = new URLSearchParams();
    if (options.section !== undefined) {
      if (!["all", "start", "end", "diff", "ledger"].includes(options.section))
        throw new TypeError("Evidence section must be all, start, end, diff or ledger");
      query.set("section", options.section);
    }
    if (options.bodies !== undefined) query.set("bodies", options.bodies ? "true" : "false");
    return this.request<WorldEvidence>(
      "GET",
      `/environment-runs/${uuid(runId)}/evidence${query.size ? `?${query}` : ""}`,
    );
  }
}
/** Creates a typed simulated-environment client. */
/** Compatibility client using the original REST resource names. */
export class EnvironmentClient extends WorldClient {
  /** Publishes the definition shapes supported by the compatibility client. */
  override publishVersion(environmentId: string, definition: PublishableEnvironmentDefinition) {
    return super.publishVersion(environmentId, definition);
  }
  /** Reads the definition using the compatibility client's original return type. */
  override getVersion(id: string): Promise<EnvironmentVersion> {
    return super.getVersion(id) as Promise<EnvironmentVersion>;
  }
  protected override resourcePath(path: string): string {
    return path;
  }
}

/** Creates the compatibility client using the original REST resource names. */
export function createEnvironmentClient(options: EnvironmentClientOptions): EnvironmentClient {
  return new EnvironmentClient(options);
}

/** Connection options for the World API client. */
export type WorldClientOptions = EnvironmentClientOptions;

/** Creates a World API client using canonical World and instance routes. */
export function createWorldClient(options: WorldClientOptions): WorldClient {
  return new WorldClient(options);
}

export {
  HueEnvironmentError as HueWorldError,
  isTransientEnvironmentError as isTransientWorldError,
};
