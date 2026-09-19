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
} from "./types.js";

/** Connection and retry options for {@link createEnvironmentClient}. */
export interface EnvironmentClientOptions {
  /** Project service key sent as a bearer token; server-side only. */
  apiKey: string;
  /** Hue origin; defaults to `https://app.hue.run`. */
  baseUrl?: string;
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
  ) {
    super(
      status
        ? `Hue environment request failed (HTTP ${status})`
        : "Hue environment connection or response failed",
    );
    this.name = "HueEnvironmentError";
  }
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_BOUNDS: JsonBounds = { ...valueBounds, bytes: 1024 * 1024 };
/** The server bounds JSON inside each entity independently, then permits the parsed
 * definition to contain up to 240 KB. The publication wrapper adds one node/depth
 * level and a small fixed byte prefix. Aggregate bounds cover every server-valid
 * definition without relaxing action/run request envelopes.
 */
const ENVIRONMENT_PUBLICATION_BOUNDS = aggregateBounds(240_000 + 32);

/** Typed client for authored environments, isolated runs and immutable journals. */
export class EnvironmentClient {
  /** Validated Hue origin. */
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMillis: number;
  private readonly maxAttempts: number;
  constructor(options: EnvironmentClientOptions) {
    const validated = validateOptions({
      ...options,
      serviceName: "hue-environments",
      captureContent: false,
    });
    this.baseUrl = validated.baseUrl;
    this.apiKey = validated.apiKey;
    this.timeoutMillis = validated.timeoutMillis;
    const attempts = options.maxAttempts ?? 4;
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10)
      throw new RangeError("maxAttempts must be 1–10");
    this.maxAttempts = attempts;
  }

  private async send<T>(method: string, path: string, payload?: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
        body: payload,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMillis),
      });
    } catch {
      throw new HueEnvironmentError();
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HueEnvironmentError(response.status);
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.send<T>(method, path, payload);
      } catch (error) {
        if (!(error instanceof HueEnvironmentError)) throw error;
        const recoverable = error.status === undefined || RETRYABLE.has(error.status);
        if (!recoverable || attempt >= this.maxAttempts) throw error;
        const backoff = Math.min(100 * 2 ** (attempt - 1), 2000);
        await new Promise((resolve) => setTimeout(resolve, backoff + Math.random() * backoff));
      }
    }
  }

  private requestOnce<T>(
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
  publishVersion(environmentId: string, definition: PublishableEnvironmentDefinition) {
    return this.requestOnce<EnvironmentVersionSummary>(
      "POST",
      `/environments/${uuid(environmentId)}/versions`,
      { definition },
      ENVIRONMENT_PUBLICATION_BOUNDS,
    );
  }
  /** Reads a full immutable environment version and generated action catalog. */
  getVersion(id: string) {
    return this.request<EnvironmentVersion>("GET", `/environment-versions/${uuid(id)}`);
  }
  /** Creates or recovers one fresh isolated world using a stable idempotency key. */
  createRun(input: CreateRunInput) {
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
    return this.request<EnvironmentRun>("POST", "/environment-runs", {
      ...input,
      environmentVersionId: uuid(input.environmentVersionId),
      ...(input.executionId === undefined ? {} : { executionId: uuid(input.executionId) }),
    });
  }
  /** Reads authoritative current or sealed world state. */
  async getRun(runId: string) {
    const run = await this.request<RunState>("GET", `/environment-runs/${uuid(runId)}`);
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
}
/** Creates a typed simulated-environment client. */
export function createEnvironmentClient(options: EnvironmentClientOptions): EnvironmentClient {
  return new EnvironmentClient(options);
}
