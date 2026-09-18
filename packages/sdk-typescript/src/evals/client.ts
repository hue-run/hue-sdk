import { validateOptions } from "../config.js";
import type { ProjectConnection } from "../types.js";
import { json, uuid } from "./json.js";
import type {
  CaseWrite,
  CompleteExecution,
  Completion,
  Dataset,
  DatasetCase,
  DatasetVersion,
  EvaluationItem,
  EvaluationRun,
  Execution,
  Experiment,
  ExperimentCase,
  ExperimentItem,
  Identity,
  JsonValue,
  JudgeBudget,
  JudgeJob,
  Page,
  PageOptions,
  Result,
  ResultSummary,
  Scorer,
  ScorerDefinition,
  ScorerVersion,
  StartExecution,
  Subject,
  StoredResult,
} from "./types.js";

/** Connection options for {@link createEvaluationClient}. */
export interface EvaluationClientOptions {
  /** Project service key sent as a Bearer token; server side only. */
  apiKey: string;
  /** Hue origin, `https://app.hue.run` by default; HTTPS except for loopback. */
  baseUrl?: string;
  /** Per-request budget in milliseconds, 100–60000. Default 10000. */
  timeoutMillis?: number;
}
/** Thrown for a failed evaluation API request; the message is fixed and never includes response text. */
export class HueApiError extends Error {
  constructor(
    /** HTTP status when Hue answered; absent for network, timeout and parsing failures. */
    readonly status?: number,
  ) {
    super(
      status ? `Hue API request failed (HTTP ${status})` : "Hue API connection or response failed",
    );
    this.name = "HueApiError";
  }
}
/**
 * Typed client for Hue's evaluation REST API: datasets, scorers, experiments, executions, runs,
 * results and hosted judge jobs. No implicit mutation retry: callers retain stable idempotency keys
 * for experiments and results. Responses are bounded to 4 MiB.
 */
export class EvaluationClient {
  /** Validated Hue origin. */
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMillis: number;
  constructor(options: EvaluationClientOptions) {
    const validated = validateOptions({
      ...options,
      serviceName: "hue-evaluations",
      captureContent: false,
    });
    this.baseUrl = validated.baseUrl;
    this.apiKey = validated.apiKey;
    this.timeoutMillis = validated.timeoutMillis;
  }
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // Optional top-level fields are omitted intentionally; nested undefined remains invalid.
    const payload =
      body === undefined
        ? undefined
        : JSON.stringify(
            json(
              Object.fromEntries(
                Object.entries(body as object).filter(([, value]) => value !== undefined),
              ),
              1024 * 1024,
            ),
          );
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
      throw new HueApiError();
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HueApiError(response.status);
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
  /** Reads the current project to confirm the key and origin. */
  checkConnection() {
    return this.request<ProjectConnection>("GET", "/projects/current");
  }
  /** Creates a dataset with an initial draft version. */
  createDataset(input: Identity) {
    return this.request<Dataset>("POST", "/datasets", input);
  }
  /** Reads a dataset and its versions. */
  getDataset(id: string) {
    return this.request<Dataset>("GET", `/datasets/${uuid(id)}`);
  }
  /** Lists datasets without their versions. */
  listDatasets(page?: PageOptions) {
    return this.request<Page<Omit<Dataset, "versions">>>("GET", `/datasets${this.page(page)}`);
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
  createScorer(input: Identity) {
    return this.request<Scorer>("POST", "/scorers", input);
  }
  /** Reads a scorer and its published versions. */
  getScorer(id: string) {
    return this.request<Scorer>("GET", `/scorers/${uuid(id)}`);
  }
  /** Lists scorers. */
  listScorers(page?: PageOptions) {
    return this.request<Page<Scorer>>("GET", `/scorers${this.page(page)}`);
  }
  /** Publishes an immutable scorer version; the server validates the pinned definition. */
  publishScorerVersion(id: string, definition: ScorerDefinition) {
    return this.request<ScorerVersion>("POST", `/scorers/${uuid(id)}/versions`, { definition });
  }
  /** Reads a published scorer version. */
  getScorerVersion(id: string) {
    return this.request<ScorerVersion>("GET", `/scorer-versions/${uuid(id)}`);
  }
  /** Creates an experiment over a frozen dataset version with pinned scorer versions and a configuration. */
  createExperiment(input: {
    idempotencyKey: string;
    name: string;
    datasetVersionId: string;
    scorerVersionIds: string[];
    config: JsonValue;
  }) {
    return this.request<{
      /** Experiment ID. */
      id: string;
      /** ID of the experiment's evaluation run. */
      evaluationRunId: string;
    }>("POST", "/experiments", input);
  }
  /** Reads an experiment with its evaluation run and execution counts. */
  getExperiment(id: string) {
    return this.request<Experiment>("GET", `/experiments/${uuid(id)}`);
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
}
/**
 * Creates an {@link EvaluationClient}.
 *
 * @throws TypeError for an invalid key, origin or budget.
 */
export function createEvaluationClient(options: EvaluationClientOptions): EvaluationClient {
  return new EvaluationClient(options);
}
