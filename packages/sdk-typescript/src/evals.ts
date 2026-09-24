export { createEvaluationClient, EvaluationClient, HueApiError } from "./evals/client.js";
export type { EvaluationClientOptions } from "./evals/client.js";
export {
  runExperiment,
  rescore,
  UncertainExecutionError,
  OutcomeSerializationError,
  TargetCancelledError,
  TargetOutcomeUncertainError,
} from "./evals/runner.js";
export type {
  RunExperimentOptions,
  RunExperimentTargetContext,
  RescoreOptions,
  RunnerReport,
  TelemetryIssueCount,
  TelemetryNotAccepted,
} from "./evals/runner.js";
export { TargetResult, withFiles } from "./evals/types.js";
export {
  CaseFileError,
  outputContentTypes,
  outputFileLimits,
  OutputFileError,
  safeFilename,
  targetFileRoles,
} from "./evals/files.js";
export type { CaseFileErrorCode } from "./evals/files.js";
export { runSimulation } from "./evals/simulation.js";
export type {
  RepositorySimulationCase,
  RepositorySimulationScorer,
  RunSimulationOptions,
  SimulationDefinition,
  SimulationProgress,
  SimulationReport,
  SimulationScenario,
  SimulationTargetContext,
} from "./evals/simulation.js";
export {
  actualAgentManifestV2,
  agentManifestDigestV2,
  attemptBaselineV2,
  attemptBindingRead,
  attemptConnectionBundleV2,
  attemptIdentityV2,
  dependencyManifestV2,
  dependencyProviderV2,
  expectedAgentManifestV2,
  executionManifestDigestV2,
  parityEvidenceV2,
  preflightFindingV2,
  preflightReportV2,
  prepareAttemptInputV2,
  projectMcpConnectionV2,
  secretFreeBindingV2,
  surfaceBindingV2,
} from "./evals/attempt.js";
export type {
  ActualAgentManifestInputV2,
  ActualAgentManifestV2,
  AttemptBaselineV2,
  AttemptBindingRead,
  AttemptConnectionBundleV2,
  AttemptIdentityV2,
  DependencyManifestV2,
  DependencyProviderV2,
  ExpectedAgentManifestV2,
  ParityEvidenceV2,
  PreflightFindingV2,
  PreflightReportV2,
  PrepareAttemptIncompleteV2,
  PrepareAttemptInputV2,
  PrepareAttemptReadyV2,
  PrepareAttemptRequestV2,
  PrepareAttemptResultV2,
  RefreshAttemptResultV2,
  RequestedAttemptProviderV2,
  RevokeAttemptResult,
  SurfaceBindingV2,
} from "./evals/attempt.js";
export { builtins, defineLocalScorer, scoreLocally } from "./evals/scorers.js";
export { sourceDigest } from "./evals/json.js";
export type * from "./evals/types.js";

export {
  localAgentCapabilities,
  registeredCapabilities,
  runLocalAgent,
} from "./evals/local-worker.js";
export type {
  LocalAgentDirectContext,
  LocalAgentTargetContext,
  RunLocalAgentOptions,
} from "./evals/local-worker.js";

export {
  getScenario,
  listScenarios,
  matchByName,
  parseScenarioSelector,
  resolveEvalSetPins,
  resolveScenarioPins,
} from "./evals/scenarios.js";
export type {
  NamedCandidate,
  NameMatch,
  ScenarioClient,
  ScenarioPins,
  ScenarioSelector,
} from "./evals/scenarios.js";
export {
  collectExperimentVerdicts,
  compareVerdicts,
  metricPassed,
  summarizeVerdicts,
  waitForResults,
} from "./evals/verdicts.js";
export type {
  CaseVerdict,
  CollectExperimentVerdictsOptions,
  ExperimentVerdicts,
  VerdictClient,
  VerdictComparison,
  VerdictResult,
  VerdictResults,
  VerdictSummary,
  WaitForResultsOptions,
} from "./evals/verdicts.js";
