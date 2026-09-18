import { validateOptions } from "../config.js";
import { json, uuid, valueBounds } from "../evals/json.js";
import type {
  ActionInput,
  ActionResult,
  CreateRunInput,
  Environment,
  EnvironmentDefinition,
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

export interface EnvironmentClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMillis?: number;
  maxAttempts?: number;
}
export class HueEnvironmentError extends Error {
  constructor(readonly status?: number) {
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

export class EnvironmentClient {
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

  private encode(body: unknown): string {
    return JSON.stringify(
      json(
        Object.fromEntries(
          Object.entries(body as object).filter(([, value]) => value !== undefined),
        ),
        { ...valueBounds, bytes: 1024 * 1024 },
      ),
    );
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : this.encode(body);
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

  private requestOnce<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.send<T>(method, path, body === undefined ? undefined : this.encode(body));
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

  createEnvironment(input: EnvironmentIdentity) {
    return this.requestOnce<EnvironmentSummary>("POST", "/environments", input);
  }
  listEnvironments(page?: EnvironmentPageOptions) {
    return this.request<EnvironmentPage>("GET", `/environments${this.page(page)}`);
  }
  getEnvironment(id: string) {
    return this.request<Environment>("GET", `/environments/${uuid(id)}`);
  }
  publishVersion(environmentId: string, definition: EnvironmentDefinition) {
    return this.requestOnce<EnvironmentVersionSummary>(
      "POST",
      `/environments/${uuid(environmentId)}/versions`,
      { definition },
    );
  }
  getVersion(id: string) {
    return this.request<EnvironmentVersion>("GET", `/environment-versions/${uuid(id)}`);
  }
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
  getRun(runId: string) {
    return this.request<RunState>("GET", `/environment-runs/${uuid(runId)}`);
  }
  act(runId: string, input: ActionInput) {
    return this.request<ActionResult>("POST", `/environment-runs/${uuid(runId)}/actions`, {
      ...input,
      args: input.args ?? {},
    });
  }
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
  finishRun(runId: string, input: FinishRunInput) {
    return this.request<SealedRun>("POST", `/environment-runs/${uuid(runId)}/finish`, input);
  }
}
export function createEnvironmentClient(options: EnvironmentClientOptions): EnvironmentClient {
  return new EnvironmentClient(options);
}
