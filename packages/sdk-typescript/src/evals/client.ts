import { isLoopbackHost, validateOptions } from "../config.js";
import type { ProjectConnection } from "../types.js";
import { json, uuid, valueBounds } from "./json.js";
import {
  attemptBindingRead,
  parsePrepareAttemptResultV2,
  parseRefreshedAttemptResultV2,
  parseRevocationResult,
  prepareAttemptInputV2,
  validateAttemptConnectionBundleV2,
  type AttemptConnectionBundleV2,
  type PrepareAttemptRequestV2,
} from "./attempt.js";
import type {
  ArtifactReservation,
  ArtifactUpload,
  CaseConversion,
  CaseConversionSummary,
  CaseWrite,
  CompleteExecution,
  Completion,
  Dataset,
  DatasetCase,
  DatasetVersion,
  EvalSet,
  EvalSetCase,
  EvalSetVersion,
  EvaluationItem,
  EvaluationRun,
  EvaluationRunSummary,
  EnvironmentEvidenceSnapshot,
  Execution,
  Experiment,
  ExperimentCase,
  ExperimentItem,
  Evaluator,
  EvaluatorVersion,
  JsonValue,
  LocalAgentClaim,
  LocalAgentRegistration,
  RegisteredLocalAgent,
  JudgeBudget,
  JudgeJob,
  Page,
  PageOptions,
  RegistryPageOptions,
  Result,
  ResultSummary,
  Run,
  RunCase,
  Scorer,
  ScorerDefinition,
  ScorerVersion,
  Scoring,
  ScoringResultInput,
  ScoringResultSummary,
  ScoringSubject,
  ScoringSummary,
  SimulationMcpCapability,
  StartExecution,
  Subject,
  StoredResult,
  StoredScoringResult,
  IdentityUpdate,
  Tag,
  TaggedIdentity,
  UpdatedRun,
} from "./types.js";

/** Connection options for {@link createEvaluationClient}. */
export interface EvaluationClientOptions {
  /** Project service key sent as a Bearer token; server side only. */
  apiKey: string;
  /** Hue origin, `https://app.hue.run` by default; HTTPS except for loopback. */
  baseUrl?: string;
  /** Per-request budget in milliseconds, 100–60000. Default 10000. */
  timeoutMillis?: number;
  /** Bounded attempts for a read or a mutation the server deduplicates by its key, after a
   * connection failure, a timeout or a 408 or 5xx Hue did not time with `Retry-After`. Default 4,
   * maximum 10; 1 sends every such request once. */
  maxAttempts?: number;
}
/** Thrown for a failed evaluation API request; the message is fixed and never includes response text. */
export class HueApiError extends Error {
  constructor(
    /** HTTP status when Hue answered; absent for network, timeout and parsing failures. */
    readonly status?: number,
    /** Seconds Hue asked the caller to wait (`Retry-After` on a 429 or 503), when it said. */
    readonly retryAfterSeconds?: number,
    /** Hue's `X-Hue-Diagnostic` code, which tells refusals of one status apart, when it sent one. */
    readonly diagnostic?: string,
  ) {
    super(
      status
        ? `Hue API request failed (HTTP ${status}${diagnostic ? `, ${diagnostic}` : ""})`
        : "Hue API connection or response failed",
    );
    this.name = "HueApiError";
  }
}
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
/**
 * Whether the same request, sent again, can succeed: a connection failure, a timeout, or a status
 * Hue answers while it cannot act yet (408, 429, 500, 502, 503, 504). A refusal Hue decided on,
 * any other 4xx, is not, and no number of attempts changes it.
 */
export function isTransientApiError(error: unknown): boolean {
  return (
    error instanceof HueApiError && (error.status === undefined || TRANSIENT.has(error.status))
  );
}
const DIAGNOSTIC = /^[a-z_]{1,64}$/;
function diagnosticOf(response: Response): string | undefined {
  const value = response.headers.get("x-hue-diagnostic");
  return value !== null && DIAGNOSTIC.test(value) ? value : undefined;
}
/** Whether a request may be sent again after a transient failure: every read, and a mutation the
 * server deduplicates, either by the `idempotencyKey` in its body or because its route is
 * idempotent by design (the local worker's register, claim, heartbeat, completion and capability
 * routes). A mutation without a key is sent once; its caller resolves the outcome before asking
 * again. */
function retryable(method: string, body: unknown, idempotent?: boolean): boolean {
  if (idempotent !== undefined) return idempotent;
  if (method === "GET") return true;
  return (
    body !== null &&
    typeof body === "object" &&
    typeof (body as { idempotencyKey?: unknown }).idempotencyKey === "string"
  );
}

/** An artifact download that ran past the size its caller expected; the rest is not read. */
export class ArtifactSizeError extends Error {
  constructor(
    /** The size the caller expected, in bytes. */
    readonly maxBytes: number,
  ) {
    super(`Artifact download exceeded the expected ${maxBytes} bytes`);
    this.name = "ArtifactSizeError";
  }
}

const registryFieldAliases = [
  ["datasetId", "evalSetId"],
  ["datasetVersionId", "evalSetVersionId"],
  ["scorerId", "evaluatorId"],
  ["scorerVersionId", "evaluatorVersionId"],
] as const;
const registryEnvelopes = new Set(["items", "item", "versions", "version"]);

// Only Hue response envelopes are traversed. Case inputs, metadata, and evaluator
// definitions are customer JSON and must retain their original field names.
function productRegistryFields<T>(value: unknown): T {
  if (Array.isArray(value)) return value.map((item) => productRegistryFields(item)) as T;
  if (value === null || typeof value !== "object") return value as T;
  const result: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of registryEnvelopes) {
    if (Object.hasOwn(result, key)) result[key] = productRegistryFields(result[key]);
  }
  for (const [legacy, product] of registryFieldAliases) {
    if (Object.hasOwn(result, legacy)) {
      if (Object.hasOwn(result, product) && result[legacy] !== result[product])
        throw new HueApiError();
      result[product] = result[legacy];
    }
  }
  return result as T;
}

/** Tag names travel as given; anything but a list of strings is a caller error. */
function tagNames(tags: unknown): string[] {
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string"))
    throw new TypeError("tags must be a list of tag names");
  return tags;
}
function withTagNames<T extends { tags?: string[] }>(input: T): T {
  return input.tags === undefined ? input : { ...input, tags: tagNames(input.tags) };
}

const runResponseAliases = [
  ["datasetId", "evalSetId"],
  ["datasetName", "evalSetName"],
  ["datasetDisplayName", "evalSetDisplayName"],
  ["datasetVersion", "evalSetVersion"],
  ["datasetVersionId", "evalSetVersionId"],
  ["datasetVersionIds", "evalSetVersionIds"],
  ["scorerId", "evaluatorId"],
  ["scorerName", "evaluatorName"],
  ["scorerVersion", "evaluatorVersion"],
  ["scorerVersionId", "evaluatorVersionId"],
  ["scorerVersionIds", "evaluatorVersionIds"],
  ["scorerVersions", "evaluatorVersions"],
  ["evaluationRunId", "scoringId"],
] as const;
const runResponseEnvelopes = new Set([
  "items",
  "item",
  "versions",
  "version",
  "scorerVersions",
  "evaluatorVersions",
]);

function productRunFields<T>(value: unknown, kind: "run" | "scoring" | "result"): T {
  if (Array.isArray(value)) return value.map((item) => productRunFields(item, kind)) as T;
  if (value === null || typeof value !== "object") return value as T;
  const result: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of runResponseEnvelopes) {
    if (Object.hasOwn(result, key)) result[key] = productRunFields(result[key], kind);
  }
  for (const key of ["evaluation", "scoring"] as const) {
    if (Object.hasOwn(result, key)) result[key] = productRunFields(result[key], "scoring");
  }
  const identityAlias: readonly [string, string] =
    kind === "result" ? ["runId", "scoringId"] : ["experimentId", "runId"];
  const aliases: readonly (readonly [string, string])[] = [...runResponseAliases, identityAlias];
  for (const [legacy, product] of aliases) {
    if (Object.hasOwn(result, legacy)) {
      if (
        Object.hasOwn(result, product) &&
        JSON.stringify(result[legacy]) !== JSON.stringify(result[product])
      )
        throw new HueApiError();
      result[product] = result[legacy];
    }
  }
  if (Object.hasOwn(result, "evaluation") && !Object.hasOwn(result, "scoring"))
    result.scoring = result.evaluation;
  return result as T;
}
/** Times a refused request is sent again before its refusal is the caller's error. */
const REFUSAL_RETRIES = 4;
/** A refusal asking for a longer wait fails at once rather than holding the caller. */
const MAX_REFUSAL_RETRY_AFTER_SECONDS = 5;
/** The whole seconds a 429 or 503 asks the caller to wait, up to a day, when it says. */
function askedRetryAfter(response: Response): number | undefined {
  if (response.status !== 429 && response.status !== 503) return undefined;
  const header = response.headers.get("retry-after")?.trim() ?? "";
  return /^\d{1,6}$/.test(header) ? Math.min(Number(header), 86_400) : undefined;
}
/**
 * The whole-second `Retry-After` of a 429 or 503 asking for at most 5 seconds. Hue sends one only
 * when it refused the request before acting on it, such as a busy key check, so sending any method
 * again is safe. A date, a longer wait or any other failure, a timeout included, is not retried.
 */
function refusalRetryAfter(response: Response): number | undefined {
  const seconds = askedRetryAfter(response);
  return seconds !== undefined && seconds <= MAX_REFUSAL_RETRY_AFTER_SECONDS ? seconds : undefined;
}
/**
 * Typed client for Hue's evaluation REST API: datasets, scorers, experiments, executions, runs,
 * results and hosted judge jobs. A request Hue refused before acting on it with a short
 * `Retry-After` (HTTP 429 or 503, at most 5 seconds) is sent again after that wait whatever its
 * method, up to four times; a longer wait is the caller's error, carried as `retryAfterSeconds`.
 * A read, or a mutation the server deduplicates by its idempotency key, is also sent again after
 * a failure Hue did not time, a connection failure, a timeout or a 408 or 5xx without the header,
 * up to `maxAttempts` times with a jittered backoff. A mutation without a key is never retried
 * implicitly: callers retain stable idempotency keys for experiments and results. Responses are
 * bounded to 4 MiB.
 */
export class EvaluationClient {
  /** Validated Hue origin. */
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMillis: number;
  private readonly maxAttempts: number;
  constructor(options: EvaluationClientOptions) {
    const validated = validateOptions({
      ...options,
      serviceName: "hue-evaluations",
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
  /** Sends one request to Hue, again after the wait while Hue refuses it with a short
   * `Retry-After`. `init` runs for every attempt, so each has its own timeout; `signal` also ends
   * each attempt, and a wait to send one again, whose refusal is then the caller's error. */
  private async send(
    url: string,
    init: () => RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        const attemptInit = init();
        const signals = [attemptInit.signal, signal].filter((item): item is AbortSignal => !!item);
        response = await fetch(url, { ...attemptInit, signal: AbortSignal.any(signals) });
      } catch {
        throw new HueApiError();
      }
      const seconds = attempt < REFUSAL_RETRIES ? refusalRetryAfter(response) : undefined;
      if (seconds === undefined) return response;
      await response.body?.cancel().catch(() => undefined);
      // Never sooner than asked; the jitter spreads out parallel requests refused together.
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, seconds * 1000 * (1 + Math.random() * 0.5));
        signal?.addEventListener("abort", done, { once: true });
        // The signal may have ended while the refusal's body was cancelled.
        if (signal?.aborted) done();
      });
      if (signal?.aborted) throw new HueApiError(response.status, askedRetryAfter(response));
    }
  }
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    bounds = { ...valueBounds, bytes: 1024 * 1024 },
    signal?: AbortSignal,
    /** Overrides the retry decision `retryable` takes from the method and body. */
    idempotent?: boolean,
  ): Promise<T> {
    // Serialized once, outside the attempts: a body this client cannot encode is a caller error
    // no attempt fixes. Optional top-level fields are omitted intentionally; nested undefined
    // remains invalid.
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
    const attempts = retryable(method, body, idempotent) ? this.maxAttempts : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.requestOnce<T>(method, path, payload, signal);
      } catch (error) {
        // A refusal that carried `Retry-After` was already decided by `send`: sent again while
        // the wait was short, the caller's error when it was long. This loop covers the failures
        // Hue did not time: a lost connection, a timeout, a 5xx or 408 without the header.
        if (
          !isTransientApiError(error) ||
          (error as HueApiError).retryAfterSeconds !== undefined ||
          attempt >= attempts ||
          signal?.aborted
        )
          throw error;
        const backoff = Math.min(100 * 2 ** (attempt - 1), 2000);
        const wait = backoff + Math.random() * backoff;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, wait);
          signal?.addEventListener("abort", done, { once: true });
        });
      }
    }
  }
  private async requestOnce<T>(
    method: string,
    path: string,
    payload: string | undefined,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.send(
      `${this.baseUrl}/api/v1${path}`,
      () => ({
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
        body: payload,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMillis),
      }),
      signal,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new HueApiError(response.status, askedRetryAfter(response), diagnosticOf(response));
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
          if (size > 4 * 1024 * 1024) throw new Error("Oversized response");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } catch {
      throw new HueApiError();
    }
  }
  /** Verified bytes of one ready artifact in this project, bounded to the 25 MiB pilot file size.
   * With `maxBytes`, the download stops one byte past it and throws `ArtifactSizeError`. */
  async downloadArtifact(id: string, options: { maxBytes?: number } = {}): Promise<Uint8Array> {
    const expected = options.maxBytes;
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0))
      throw new RangeError("maxBytes must be a non-negative integer");
    const response = await this.send(
      `${this.baseUrl}/api/v1/artifacts/${uuid(id)}/download`,
      () => ({
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(this.timeoutMillis, 120_000)),
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new HueApiError(response.status, askedRetryAfter(response));
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
          if (expected !== undefined && size > expected) throw new ArtifactSizeError(expected);
          if (size > 25 * 1024 * 1024) throw new Error("Oversized artifact");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return new Uint8Array(Buffer.concat(chunks));
    } catch (error) {
      if (error instanceof ArtifactSizeError) throw error;
      throw new HueApiError();
    }
  }
  /** Stage bytes at the storage capability Hue issued. The Hue key is never sent to storage. */
  async uploadArtifactBytes(
    upload: ArtifactUpload,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    const uploadUrl = signedUploadUrl(upload.uploadUrl);
    if (upload.method !== "PUT") throw new HueApiError();
    const headers = signedUploadHeaders(upload.headers, contentType);
    let response: Response;
    try {
      response = await fetch(uploadUrl, {
        method: "PUT",
        headers,
        body: bytes as Uint8Array<ArrayBuffer>,
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(this.timeoutMillis, 120_000)),
      });
    } catch {
      throw new HueApiError();
    }
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw new HueApiError(response.status, askedRetryAfter(response));
  }
  private page(options: PageOptions = {}): string {
    const query = new URLSearchParams();
    if (options.after) query.set("after", uuid(options.after));
    if (options.limit !== undefined) {
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
        throw new RangeError("Page limit must be 1–100");
      query.set("limit", String(options.limit));
    }
    return query.size ? `?${query}` : "";
  }
  private registryPage(options: RegistryPageOptions = {}): string {
    const query = new URLSearchParams(this.page(options).slice(1));
    if (options.includeArchived !== undefined)
      query.set("includeArchived", String(options.includeArchived));
    for (const tag of tagNames(options.tags ?? [])) query.append("tag", tag);
    return query.size ? `?${query}` : "";
  }
  /** Reads the current project to confirm the key and origin. */
  checkConnection() {
    return this.request<ProjectConnection>("GET", "/projects/current");
  }
  /** Creates a dataset with an initial draft version; `tags` names the tags it starts with. */
  createDataset(input: TaggedIdentity) {
    return this.request<Dataset>("POST", "/datasets", withTagNames(input));
  }
  /** Renames a dataset or replaces its tags by name; the same values again change nothing. */
  updateDataset(id: string, input: IdentityUpdate & { slug?: string }) {
    return this.request<Omit<Dataset, "versions">>(
      "PATCH",
      `/datasets/${uuid(id)}`,
      withTagNames(input),
      undefined,
      undefined,
      true,
    );
  }
  /** Reads a dataset and its versions. */
  getDataset(id: string) {
    return this.request<Dataset>("GET", `/datasets/${uuid(id)}`);
  }
  /** Lists datasets without their versions. */
  listDatasets(page?: RegistryPageOptions) {
    return this.request<Page<Omit<Dataset, "versions">>>(
      "GET",
      `/datasets${this.registryPage(page)}`,
    );
  }
  /** Creates a new draft version, optionally copying cases from an existing version. */
  createDatasetVersion(id: string, input: { fromVersionId?: string } = {}) {
    return this.request<DatasetVersion>("POST", `/datasets/${uuid(id)}/versions`, input);
  }
  /** Reads a dataset version. */
  getDatasetVersion(id: string) {
    return this.request<DatasetVersion>("GET", `/dataset-versions/${uuid(id)}`);
  }
  /** Lists the full cases of a dataset version; use small page limits for large values. */
  listCases(id: string, page?: PageOptions) {
    return this.request<Page<DatasetCase>>(
      "GET",
      `/dataset-versions/${uuid(id)}/cases${this.page(page)}`,
    );
  }
  /** Adds a case to a draft version using optimistic concurrency on `expectedRevision`. */
  addCase(id: string, input: CaseWrite) {
    return this.request<{
      /** The stored case. */
      item: DatasetCase;
      /** The version with its new revision. */
      version: DatasetVersion;
    }>("POST", `/dataset-versions/${uuid(id)}/cases`, input);
  }
  /** Freezes a draft version at the given revision; frozen versions are immutable. */
  freezeDatasetVersion(id: string, expectedRevision: number) {
    return this.request<DatasetVersion>("POST", `/dataset-versions/${uuid(id)}/freeze`, {
      expectedRevision,
    });
  }
  /** Creates a scorer identity; publish definitions with {@link publishScorerVersion}. */
  createScorer(input: TaggedIdentity) {
    return this.request<Scorer>("POST", "/scorers", withTagNames(input));
  }
  /** Renames a scorer or replaces its tags by name; the same values again change nothing. */
  updateScorer(id: string, input: IdentityUpdate) {
    return this.request<Scorer>(
      "PATCH",
      `/scorers/${uuid(id)}`,
      withTagNames(input),
      undefined,
      undefined,
      true,
    );
  }
  /** Lists the project's tags in the order they were created. */
  listTags() {
    return this.request<{
      /** The project's tags. */
      items: Tag[];
    }>("GET", "/tags");
  }
  /** Reads a scorer and its published versions. */
  getScorer(id: string) {
    return this.request<Scorer>("GET", `/scorers/${uuid(id)}`);
  }
  /** Lists scorers. */
  listScorers(page?: RegistryPageOptions) {
    return this.request<Page<Scorer>>("GET", `/scorers${this.registryPage(page)}`);
  }
  /** Publishes an immutable scorer version; the server validates the pinned definition. */
  publishScorerVersion(id: string, definition: ScorerDefinition) {
    return this.request<ScorerVersion>("POST", `/scorers/${uuid(id)}/versions`, { definition });
  }
  /** Reads a published scorer version. */
  getScorerVersion(id: string) {
    return this.request<ScorerVersion>("GET", `/scorer-versions/${uuid(id)}`);
  }
  /** Creates an eval set using the existing v1 registry path. */
  async createEvalSet(input: TaggedIdentity): Promise<EvalSet> {
    return productRegistryFields(await this.createDataset(input));
  }
  /** Renames an eval set or replaces its tags by name. */
  async updateEvalSet(
    id: string,
    input: IdentityUpdate & { slug?: string },
  ): Promise<Omit<EvalSet, "versions">> {
    return productRegistryFields(await this.updateDataset(id, input));
  }
  /** Reads an eval set and its versions. */
  async getEvalSet(id: string): Promise<EvalSet> {
    return productRegistryFields(await this.getDataset(id));
  }
  /** Lists eval sets. */
  async listEvalSets(page?: RegistryPageOptions): Promise<Page<Omit<EvalSet, "versions">>> {
    return productRegistryFields(await this.listDatasets(page));
  }
  /** Creates a draft eval set version, optionally copying cases from another version. */
  async createEvalSetVersion(
    id: string,
    input: { fromVersionId?: string } = {},
  ): Promise<EvalSetVersion> {
    return productRegistryFields(await this.createDatasetVersion(id, input));
  }
  /** Reads an eval set version. */
  async getEvalSetVersion(id: string): Promise<EvalSetVersion> {
    return productRegistryFields(await this.getDatasetVersion(id));
  }
  /** Lists cases in an eval set version. */
  async listEvalSetCases(id: string, page?: PageOptions): Promise<Page<EvalSetCase>> {
    return productRegistryFields(await this.listCases(id, page));
  }
  /** Adds a case to a draft eval set version at its expected revision. */
  async addEvalSetCase(
    id: string,
    input: CaseWrite,
  ): Promise<{
    /** The stored case. */
    item: EvalSetCase;
    /** The version with its new revision. */
    version: EvalSetVersion;
  }> {
    return productRegistryFields(await this.addCase(id, input));
  }
  /** Freezes a draft eval set version at its expected revision. */
  async freezeEvalSetVersion(id: string, expectedRevision: number): Promise<EvalSetVersion> {
    return productRegistryFields(await this.freezeDatasetVersion(id, expectedRevision));
  }
  /** Creates an evaluator identity. */
  async createEvaluator(input: TaggedIdentity): Promise<Evaluator> {
    return productRegistryFields(await this.createScorer(input));
  }
  /** Renames an evaluator or replaces its tags by name. */
  async updateEvaluator(id: string, input: IdentityUpdate): Promise<Evaluator> {
    return productRegistryFields(await this.updateScorer(id, input));
  }
  /** Reads an evaluator and its published versions. */
  async getEvaluator(id: string): Promise<Evaluator> {
    return productRegistryFields(await this.getScorer(id));
  }
  /** Lists evaluators. */
  async listEvaluators(page?: RegistryPageOptions): Promise<Page<Evaluator>> {
    return productRegistryFields(await this.listScorers(page));
  }
  /** Publishes an immutable evaluator version. */
  async publishEvaluatorVersion(
    id: string,
    definition: ScorerDefinition,
  ): Promise<EvaluatorVersion> {
    return productRegistryFields(await this.publishScorerVersion(id, definition));
  }
  /** Reads a published evaluator version. */
  async getEvaluatorVersion(id: string): Promise<EvaluatorVersion> {
    return productRegistryFields(await this.getScorerVersion(id));
  }
  /** Creates an experiment over a frozen dataset version with pinned scorer versions and a configuration. */
  createExperiment(input: {
    idempotencyKey: string;
    name: string;
    datasetVersionId: string;
    scorerVersionIds: string[];
    config: JsonValue;
    /** The experiment's own tag names; it also shows its dataset's tags. */
    tags?: string[];
  }) {
    return this.request<{
      /** Experiment ID. */
      id: string;
      /** ID of the experiment's evaluation run. */
      evaluationRunId: string;
    }>("POST", "/experiments", withTagNames(input));
  }
  /** Reads an experiment with its evaluation run and execution counts. */
  getExperiment(id: string) {
    return this.request<Experiment>("GET", `/experiments/${uuid(id)}`);
  }
  /** Renames an experiment or replaces its own tags by name. */
  updateExperiment(id: string, input: { name?: string; tags?: string[] }) {
    return this.request<UpdatedRun>(
      "PATCH",
      `/experiments/${uuid(id)}`,
      withTagNames(input),
      undefined,
      undefined,
      true,
    );
  }
  /** Lists an experiment's cases with their latest executions. */
  listExperimentItems(id: string, page?: PageOptions) {
    return this.request<Page<ExperimentItem>>(
      "GET",
      `/experiments/${uuid(id)}/items${this.page(page)}`,
    );
  }
  /** Reads one frozen case of an experiment. */
  getExperimentCase(id: string, caseId: string) {
    return this.request<ExperimentCase>("GET", `/experiments/${uuid(id)}/items/${uuid(caseId)}`);
  }
  /** Starts (or, with the same key, replays) a target execution for a case. */
  startExecution(id: string, caseId: string, input: StartExecution) {
    return this.request<Execution>(
      "POST",
      `/experiments/${uuid(id)}/items/${uuid(caseId)}/start`,
      input,
    );
  }
  /** Reads an execution. */
  getExecution(id: string) {
    return this.request<Execution>("GET", `/experiment-executions/${uuid(id)}`);
  }
  /** Reads the sealed environment evidence linked to an execution. */
  getEnvironmentEvidence(executionId: string) {
    return this.request<EnvironmentEvidenceSnapshot>(
      "GET",
      `/experiment-executions/${uuid(executionId)}/environment`,
    );
  }
  /** Pages the sealed environment journal linked to an execution. */
  getEnvironmentSteps(executionId: string, page: { after?: number; limit?: number } = {}) {
    if (page.after !== undefined && (!Number.isInteger(page.after) || page.after < -1))
      throw new RangeError("Step cursor must be an integer at least -1");
    if (
      page.limit !== undefined &&
      (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100)
    )
      throw new RangeError("Step page size must be 1–100");
    const query = new URLSearchParams();
    if (page.after !== undefined) query.set("after", String(page.after));
    if (page.limit !== undefined) query.set("limit", String(page.limit));
    return this.request<import("../environment/types.js").StepPage>(
      "GET",
      `/experiment-executions/${uuid(executionId)}/environment/steps${query.size ? `?${query}` : ""}`,
    );
  }
  /**
   * Prepares the immutable provider-profile binding for one execution. The route identity is
   * removed from the JSON body, and credential-bearing responses are validated against the
   * request before being returned.
   */
  async prepareAttempt(input: PrepareAttemptRequestV2) {
    const request = prepareAttemptInputV2.parse(input);
    const { executionId, ...body } = request;
    // Sent once although keyed: a lost acknowledgement of a credential-bearing decision stays
    // uncertain, and the worker never reacquires credentials.
    const response = await this.request<unknown>(
      "POST",
      `/experiment-executions/${executionId}/prepare-attempt`,
      body,
      { ...valueBounds, bytes: 128_000 },
      undefined,
      false,
    );
    try {
      return parsePrepareAttemptResultV2(response, request);
    } catch {
      // A malformed success response may follow a committed decision. Never expose
      // credential-bearing response details or imply that replay is automatically safe.
      throw new HueApiError();
    }
  }
  /** Reads coupled, secret-free V1 or V2 binding evidence; it never reacquires credentials. */
  async getAttemptBinding(bindingId: string) {
    const response = await this.request<unknown>("GET", `/attempt-bindings/${uuid(bindingId)}`);
    try {
      return attemptBindingRead.parse(response);
    } catch {
      throw new HueApiError();
    }
  }
  /** Rotates an unexpired V2 connection while preserving its immutable binding evidence. */
  async refreshAttemptConnection(
    previous: AttemptConnectionBundleV2,
    input: { idempotencyKey: string },
  ) {
    const source = validateAttemptConnectionBundleV2(previous);
    const response = await this.request<unknown>(
      "POST",
      `/attempt-bindings/${source.bindingId}/refresh`,
      {
        idempotencyKey: uuid(input.idempotencyKey),
        expectedGeneration: source.credentialGeneration,
      },
      { ...valueBounds, bytes: 128_000 },
    );
    try {
      return parseRefreshedAttemptResultV2(response, source);
    } catch {
      throw new HueApiError();
    }
  }
  /** Revokes an attempt binding. A revoked connection must not be reused or refreshed. */
  async revokeAttemptConnection(input: { bindingId: string }) {
    const bindingId = uuid(input.bindingId);
    const response = await this.request<unknown>(
      "POST",
      `/attempt-bindings/${bindingId}/revoke`,
      {},
      { ...valueBounds, bytes: 128_000 },
    );
    try {
      return parseRevocationResult(response, bindingId);
    } catch {
      throw new HueApiError();
    }
  }
  /** Reads one artifact reservation and its verification state. `signal` ends the request. */
  getArtifact(id: string, options: { signal?: AbortSignal } = {}) {
    return this.request<ArtifactReservation>(
      "GET",
      `/artifacts/${uuid(id)}`,
      undefined,
      undefined,
      options.signal,
    );
  }
  /** Reserves an artifact by declared identity; replaying the key returns the same reservation. */
  reserveArtifact(input: {
    /** Stable key; replaying it returns the same reservation. */
    idempotencyKey: string;
    /** Declared file name. */
    filename: string;
    /** Declared content type. */
    contentType: string;
    /** Declared size in bytes. */
    byteSize: number;
    /** Declared SHA-256, hex encoded. */
    sha256: string;
  }) {
    return this.request<ArtifactReservation>("POST", "/artifacts", input);
  }
  /** Issues a short-lived storage capability for staging the reserved artifact's bytes. */
  requestArtifactUpload(id: string) {
    return this.request<ArtifactUpload>("POST", `/artifacts/${uuid(id)}/upload`, {});
  }
  /** Asks Hue to verify the staged bytes against the declared identity. `signal` ends the
   * request, and a wait to send it again. */
  completeArtifact(id: string, options: { signal?: AbortSignal } = {}) {
    return this.request<ArtifactReservation>(
      "POST",
      `/artifacts/${uuid(id)}/complete`,
      {},
      undefined,
      options.signal,
    );
  }
  /** Saves an execution's outcome and creates its immutable subject. */
  completeExecution(id: string, input: CompleteExecution) {
    return this.request<Completion>("POST", `/experiment-executions/${uuid(id)}/complete`, input);
  }
  /** Marks an experiment finished. */
  finishExperiment(id: string, idempotencyKey: string) {
    return this.request<{
      /** Experiment ID. */
      id: string;
      /** When it was finished. */
      finishedAt: string;
    }>("POST", `/experiments/${uuid(id)}/finish`, { idempotencyKey });
  }
  /** Creates a historical evaluation run that rescores existing subjects with pinned scorer versions. */
  createEvaluationRun(input: {
    idempotencyKey: string;
    name: string;
    subjectIds: string[];
    scorerVersionIds: string[];
  }) {
    return this.request<{
      /** Evaluation run ID. */
      id: string;
    }>("POST", "/evaluation-runs", input);
  }
  /** Reads an evaluation run and its scoring progress. */
  getEvaluationRun(id: string) {
    return this.request<EvaluationRun>("GET", `/evaluation-runs/${uuid(id)}`);
  }
  /** Every evaluation run of the project, oldest first; a grading worker polls this for pending pins. */
  listEvaluationRuns(page?: PageOptions) {
    return this.request<Page<EvaluationRunSummary>>("GET", `/evaluation-runs${this.page(page)}`);
  }
  /** Lists the subjects of an evaluation run. */
  listEvaluationItems(id: string, page?: PageOptions) {
    return this.request<Page<EvaluationItem>>(
      "GET",
      `/evaluation-runs/${uuid(id)}/items${this.page(page)}`,
    );
  }
  /** Reads an immutable subject, including output and reference when available. */
  getSubject(id: string) {
    return this.request<Subject>("GET", `/evaluation-subjects/${uuid(id)}`);
  }
  /** Uploads scorer results for an evaluation run; a replayed key returns the same IDs. */
  submitResults(id: string, input: { idempotencyKey: string; results: Result[] }) {
    return this.request<{
      /** Stored result IDs, in input order. */
      ids: string[];
    }>("POST", `/evaluation-runs/${uuid(id)}/results`, input);
  }
  /** Lists result summaries of an evaluation run. */
  listResults(id: string, page?: PageOptions) {
    return this.request<Page<ResultSummary>>(
      "GET",
      `/evaluation-runs/${uuid(id)}/results${this.page(page)}`,
    );
  }
  /** Reads a full stored result. */
  getResult(id: string) {
    return this.request<StoredResult>("GET", `/evaluation-results/${uuid(id)}`);
  }
  /** Creates a run using product request fields on the existing v1 path. */
  async createRun(input: {
    idempotencyKey: string;
    name: string;
    evalSetVersionId: string;
    evaluatorVersionIds: string[];
    config: JsonValue;
    /** The run's own tag names; it also shows its eval set's tags. */
    tags?: string[];
  }): Promise<{
    /** Run ID. */
    id: string;
    /** ID of the run's scoring pass. */
    scoringId: string;
    /** Existing v1 field for the scoring pass ID. */
    evaluationRunId: string;
  }> {
    return productRunFields(await this.request("POST", "/experiments", withTagNames(input)), "run");
  }
  /** Reads a run with its scoring progress. */
  async getRun(id: string): Promise<Run> {
    return productRunFields(await this.getExperiment(id), "run");
  }
  /** Renames a run or replaces its own tags by name; its eval set's tags are not its own. */
  async updateRun(id: string, input: { name?: string; tags?: string[] }): Promise<UpdatedRun> {
    return this.updateExperiment(id, input);
  }
  /** Lists a run's cases with their latest executions. */
  async listRunItems(id: string, page?: PageOptions): Promise<Page<ExperimentItem>> {
    return productRunFields(await this.listExperimentItems(id, page), "run");
  }
  /** Reads one frozen case of a run. */
  async getRunCase(id: string, caseId: string): Promise<RunCase> {
    return productRunFields(await this.getExperimentCase(id, caseId), "run");
  }
  /** Starts or replays a target execution for a run case. */
  async startRunExecution(id: string, caseId: string, input: StartExecution): Promise<Execution> {
    return productRunFields(await this.startExecution(id, caseId, input), "run");
  }
  /** Reads one run execution. */
  async getRunExecution(id: string): Promise<Execution> {
    return productRunFields(await this.getExecution(id), "run");
  }
  /** Saves a run execution's outcome. */
  async completeRunExecution(id: string, input: CompleteExecution): Promise<Completion> {
    return productRunFields(await this.completeExecution(id, input), "run");
  }
  /** Marks a run finished. */
  async finishRun(
    id: string,
    idempotencyKey: string,
  ): Promise<{
    /** Run ID. */
    id: string;
    /** When the run finished. */
    finishedAt: string;
  }> {
    return productRunFields(await this.finishExperiment(id, idempotencyKey), "run");
  }
  /** Creates a standalone scoring pass over saved subjects. */
  async createScoring(input: {
    idempotencyKey: string;
    name: string;
    subjectIds: string[];
    evaluatorVersionIds: string[];
  }): Promise<{
    /** Scoring pass ID. */
    id: string;
  }> {
    return productRunFields(await this.request("POST", "/evaluation-runs", input), "scoring");
  }
  /** Reads a scoring pass and its pinned evaluators. */
  async getScoring(id: string): Promise<Scoring> {
    return productRunFields(await this.getEvaluationRun(id), "scoring");
  }
  /** Lists scoring passes in the project. */
  async listScorings(page?: PageOptions): Promise<Page<ScoringSummary>> {
    return productRunFields(await this.listEvaluationRuns(page), "scoring");
  }
  /** Lists the subjects of a scoring pass. */
  async listScoringItems(id: string, page?: PageOptions): Promise<Page<EvaluationItem>> {
    return productRunFields(await this.listEvaluationItems(id, page), "scoring");
  }
  /** Reads a saved subject with product-named source fields. */
  async getScoringSubject(id: string): Promise<ScoringSubject> {
    return productRunFields(await this.getSubject(id), "run");
  }
  /** Uploads evaluator results for a scoring pass using product request fields. */
  async submitScoringResults(
    id: string,
    input: { idempotencyKey: string; results: ScoringResultInput[] },
  ): Promise<{
    /** Stored result IDs, in input order. */
    ids: string[];
  }> {
    return productRunFields(
      await this.request("POST", `/evaluation-runs/${uuid(id)}/results`, input),
      "result",
    );
  }
  /** Lists result summaries for a scoring pass. */
  async listScoringResults(id: string, page?: PageOptions): Promise<Page<ScoringResultSummary>> {
    return productRunFields(await this.listResults(id, page), "result");
  }
  /** Reads a stored evaluator result. */
  async getScoringResult(id: string): Promise<StoredScoringResult> {
    return productRunFields(await this.getResult(id), "result");
  }
  /** Dispatches hosted judge jobs for `llm_judge` pins; check {@link getJudgeBudget} first. */
  createJudgeJobs(
    id: string,
    input: {
      idempotencyKey: string;
      jobs: { evaluationItemId: string; scorerVersionId: string }[];
    },
  ) {
    return this.request<{
      /** Created job IDs, in input order. */
      ids: string[];
    }>("POST", `/evaluation-runs/${uuid(id)}/judge-jobs`, input);
  }
  /** Lists hosted judge jobs of an evaluation run. */
  listJudgeJobs(id: string, page?: PageOptions) {
    return this.request<Page<JudgeJob>>(
      "GET",
      `/evaluation-runs/${uuid(id)}/judge-jobs${this.page(page)}`,
    );
  }
  /** Reads a hosted judge job, including its charge accounting. */
  getJudgeJob(id: string) {
    return this.request<JudgeJob>("GET", `/judge-jobs/${uuid(id)}`);
  }
  /** Requests cancellation of a hosted judge job. */
  cancelJudgeJob(id: string, reason: string) {
    return this.request<{
      /** Job ID. */
      id: string;
      /** Job state after the request. */
      state: JudgeJob["state"];
      /** Whether a cancellation request was recorded. */
      cancellationRequested?: boolean;
    }>("POST", `/judge-jobs/${uuid(id)}/cancel`, { reason });
  }
  /** Reads the project's hosted judge budget and admission controls. */
  getJudgeBudget() {
    return this.request<JudgeBudget>("GET", "/judge-budget");
  }
  /** Register or refresh the fixed local agent key and revision. */
  async registerLocalAgent(input: LocalAgentRegistration): Promise<RegisteredLocalAgent> {
    const agent = await this.request<
      Omit<RegisteredLocalAgent, "key"> & {
        key?: string;
        agentKey?: string;
      }
    >("POST", "/local-agent-worker/register", input, undefined, undefined, true);
    // Hue's response names the key `agentKey`; read either name.
    return { ...agent, key: agent.key ?? agent.agentKey ?? input.key };
  }
  /** Claim a queued run for this agent and durable worker identity. */
  claimLocalAgentRun(input: { agentId: string; workerId: string }) {
    return this.request<LocalAgentClaim | null>(
      "POST",
      "/local-agent-worker/claim",
      input,
      undefined,
      undefined,
      true,
    );
  }
  /** Refresh the lease of a claimed local run. */
  heartbeatLocalAgentRun(input: { runId: string; workerId: string }) {
    return this.request<{
      /** Queue-run identity. */
      runId: string;
      /** The worker claim remains active. */
      active: true;
    }>("POST", "/local-agent-worker/runs/heartbeat", input, undefined, undefined, true);
  }
  /** Report acknowledged completion or an execution requiring attention. */
  completeLocalAgentRun(input: {
    runId: string;
    workerId: string;
    state: "completed" | "attention";
    failureType?: string;
  }) {
    return this.request<{
      /** Queue-run identity. */
      runId: string;
      /** Acknowledged terminal queue state. */
      state: "completed" | "attention";
    }>("POST", "/local-agent-worker/runs/complete", input, undefined, undefined, true);
  }
  /** Lists Scenarios (draft and published) of the project; requires a Read and write key. */
  listCaseConversions(page?: PageOptions) {
    return this.request<Page<CaseConversionSummary>>("GET", `/case-conversions${this.page(page)}`);
  }
  /** Reads one Scenario with its immutable publication pins. */
  getCaseConversion(id: string) {
    return this.request<CaseConversion>("GET", `/case-conversions/${uuid(id)}`);
  }
  /** Creates the legacy execution-scoped generic MCP capability for one world. */
  createSimulationMcpCapability(input: { runId: string; executionId: string }) {
    return this.request<SimulationMcpCapability>(
      "POST",
      "/local-agent-worker/mcp-capability",
      input,
      undefined,
      undefined,
      true,
    );
  }
}
/**
 * Creates an {@link EvaluationClient}.
 *
 * @throws TypeError for an invalid key, origin or budget.
 */
export function createEvaluationClient(options: EvaluationClientOptions): EvaluationClient {
  return new EvaluationClient(options);
}

function signedUploadUrl(value: unknown): string {
  // eslint-disable-next-line no-control-regex -- control characters are rejected deliberately
  if (typeof value !== "string" || value.length > 8192 || /[\x00-\x20\x7f]/u.test(value))
    throw new HueApiError();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HueApiError();
  }
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new HueApiError();
  // Validate without rewriting the provider's signed capability.
  return value;
}

function signedUploadHeaders(value: unknown, contentType: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": contentType };
  if (value === undefined || value === null) return headers;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HueApiError();
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof raw !== "string" ||
      !raw ||
      raw.length > 255 ||
      // eslint-disable-next-line no-control-regex -- control characters are rejected deliberately
      /[\x00-\x1f\x7f]/u.test(raw)
    )
      throw new HueApiError();
    const lower = name.toLowerCase();
    if (lower === "content-type" && raw === contentType) headers[lower] = raw;
    else if (lower === "x-vercel-blob-access" && raw === "private") headers[lower] = raw;
    else throw new HueApiError();
  }
  return headers;
}
