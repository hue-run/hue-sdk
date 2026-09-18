import { validateOptions } from "../config.js";
import type { ProjectConnection } from "../types.js";
import { json, uuid, valueBounds } from "./json.js";
import type {
  CaseWrite,
  CompleteExecution,
  Completion,
  Dataset,
  DatasetCase,
  DatasetVersion,
  EvaluationItem,
  EvaluationRun,
  EnvironmentEvidenceSnapshot,
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
  SimulationMcpCapability,
  StartExecution,
  Subject,
  StoredResult,
} from "./types.js";

export interface EvaluationClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMillis?: number;
}
export class HueApiError extends Error {
  constructor(readonly status?: number) {
    super(
      status ? `Hue API request failed (HTTP ${status})` : "Hue API connection or response failed",
    );
    this.name = "HueApiError";
  }
}
/** No implicit mutation retry: callers retain stable idempotency keys for experiments/results. */
export class EvaluationClient {
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
              { ...valueBounds, bytes: 1024 * 1024 },
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
  checkConnection() {
    return this.request<ProjectConnection>("GET", "/projects/current");
  }
  createDataset(input: Identity) {
    return this.request<Dataset>("POST", "/datasets", input);
  }
  getDataset(id: string) {
    return this.request<Dataset>("GET", `/datasets/${uuid(id)}`);
  }
  listDatasets(page?: PageOptions) {
    return this.request<Page<Omit<Dataset, "versions">>>("GET", `/datasets${this.page(page)}`);
  }
  createDatasetVersion(id: string, input: { fromVersionId?: string } = {}) {
    return this.request<DatasetVersion>("POST", `/datasets/${uuid(id)}/versions`, input);
  }
  getDatasetVersion(id: string) {
    return this.request<DatasetVersion>("GET", `/dataset-versions/${uuid(id)}`);
  }
  listCases(id: string, page?: PageOptions) {
    return this.request<Page<DatasetCase>>(
      "GET",
      `/dataset-versions/${uuid(id)}/cases${this.page(page)}`,
    );
  }
  addCase(id: string, input: CaseWrite) {
    return this.request<{ item: DatasetCase; version: DatasetVersion }>(
      "POST",
      `/dataset-versions/${uuid(id)}/cases`,
      input,
    );
  }
  freezeDatasetVersion(id: string, expectedRevision: number) {
    return this.request<DatasetVersion>("POST", `/dataset-versions/${uuid(id)}/freeze`, {
      expectedRevision,
    });
  }
  createScorer(input: Identity) {
    return this.request<Scorer>("POST", "/scorers", input);
  }
  getScorer(id: string) {
    return this.request<Scorer>("GET", `/scorers/${uuid(id)}`);
  }
  listScorers(page?: PageOptions) {
    return this.request<Page<Scorer>>("GET", `/scorers${this.page(page)}`);
  }
  publishScorerVersion(id: string, definition: ScorerDefinition) {
    return this.request<ScorerVersion>("POST", `/scorers/${uuid(id)}/versions`, { definition });
  }
  getScorerVersion(id: string) {
    return this.request<ScorerVersion>("GET", `/scorer-versions/${uuid(id)}`);
  }
  createExperiment(input: {
    idempotencyKey: string;
    name: string;
    datasetVersionId: string;
    scorerVersionIds: string[];
    config: JsonValue;
  }) {
    return this.request<{ id: string; evaluationRunId: string }>("POST", "/experiments", input);
  }
  getExperiment(id: string) {
    return this.request<Experiment>("GET", `/experiments/${uuid(id)}`);
  }
  listExperimentItems(id: string, page?: PageOptions) {
    return this.request<Page<ExperimentItem>>(
      "GET",
      `/experiments/${uuid(id)}/items${this.page(page)}`,
    );
  }
  getExperimentCase(id: string, caseId: string) {
    return this.request<ExperimentCase>("GET", `/experiments/${uuid(id)}/items/${uuid(caseId)}`);
  }
  startExecution(id: string, caseId: string, input: StartExecution) {
    return this.request<Execution>(
      "POST",
      `/experiments/${uuid(id)}/items/${uuid(caseId)}/start`,
      input,
    );
  }
  getExecution(id: string) {
    return this.request<Execution>("GET", `/experiment-executions/${uuid(id)}`);
  }
  getEnvironmentEvidence(executionId: string) {
    return this.request<EnvironmentEvidenceSnapshot>(
      "GET",
      `/experiment-executions/${uuid(executionId)}/environment`,
    );
  }
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
  completeExecution(id: string, input: CompleteExecution) {
    return this.request<Completion>("POST", `/experiment-executions/${uuid(id)}/complete`, input);
  }
  finishExperiment(id: string, idempotencyKey: string) {
    return this.request<{ id: string; finishedAt: string }>(
      "POST",
      `/experiments/${uuid(id)}/finish`,
      { idempotencyKey },
    );
  }
  createEvaluationRun(input: {
    idempotencyKey: string;
    name: string;
    subjectIds: string[];
    scorerVersionIds: string[];
  }) {
    return this.request<{ id: string }>("POST", "/evaluation-runs", input);
  }
  getEvaluationRun(id: string) {
    return this.request<EvaluationRun>("GET", `/evaluation-runs/${uuid(id)}`);
  }
  listEvaluationItems(id: string, page?: PageOptions) {
    return this.request<Page<EvaluationItem>>(
      "GET",
      `/evaluation-runs/${uuid(id)}/items${this.page(page)}`,
    );
  }
  getSubject(id: string) {
    return this.request<Subject>("GET", `/evaluation-subjects/${uuid(id)}`);
  }
  submitResults(id: string, input: { idempotencyKey: string; results: Result[] }) {
    return this.request<{ ids: string[] }>("POST", `/evaluation-runs/${uuid(id)}/results`, input);
  }
  listResults(id: string, page?: PageOptions) {
    return this.request<Page<ResultSummary>>(
      "GET",
      `/evaluation-runs/${uuid(id)}/results${this.page(page)}`,
    );
  }
  getResult(id: string) {
    return this.request<StoredResult>("GET", `/evaluation-results/${uuid(id)}`);
  }
  createJudgeJobs(
    id: string,
    input: {
      idempotencyKey: string;
      jobs: { evaluationItemId: string; scorerVersionId: string }[];
    },
  ) {
    return this.request<{ ids: string[] }>(
      "POST",
      `/evaluation-runs/${uuid(id)}/judge-jobs`,
      input,
    );
  }
  listJudgeJobs(id: string, page?: PageOptions) {
    return this.request<Page<JudgeJob>>(
      "GET",
      `/evaluation-runs/${uuid(id)}/judge-jobs${this.page(page)}`,
    );
  }
  getJudgeJob(id: string) {
    return this.request<JudgeJob>("GET", `/judge-jobs/${uuid(id)}`);
  }
  cancelJudgeJob(id: string, reason: string) {
    return this.request<{ id: string; state: JudgeJob["state"]; cancellationRequested?: boolean }>(
      "POST",
      `/judge-jobs/${uuid(id)}/cancel`,
      { reason },
    );
  }
  getJudgeBudget() {
    return this.request<JudgeBudget>("GET", "/judge-budget");
  }
  createSimulationMcpCapability(input: { runId: string; executionId: string }) {
    return this.request<SimulationMcpCapability>(
      "POST",
      "/local-agent-worker/mcp-capability",
      input,
    );
  }
}
export function createEvaluationClient(options: EvaluationClientOptions): EvaluationClient {
  return new EvaluationClient(options);
}
