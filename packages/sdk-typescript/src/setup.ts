/** Local, resumable installer setup-session contracts used by the `hue` command. */
export {
  SETUP_EVENT_CONTRACT_VERSION,
  type ActionRequiredEvent,
  type ClaimCompletedEvent,
  type ClaimRequiredEvent,
  type DiagnosticEvent,
  type FileChangedEvent,
  type PlanReadyEvent,
  type PrivacyNoticeEvent,
  type ProjectDetectedEvent,
  type ReceiptVerifiedEvent,
  type RunCompletedEvent,
  type RunFailedEvent,
  type RunStartedEvent,
  type SetupEvent,
  type SetupEventName,
  type SetupPlan,
  type SetupProjectDetection,
  type StepCompletedEvent,
  type StepStartedEvent,
  type TrialCreatedEvent,
} from "./setup/types.js";
export {
  createInitialSetupState,
  transitionSetup,
  type SetupEffect,
  type SetupMachineInput,
  type SetupMachineState,
  type SetupTransition,
} from "./setup/machine.js";
export {
  runSetup,
  type SetupBackendOperations,
  type SetupCheckpointAdapter,
  type SetupProjectAdapter,
  type SetupRunOptions,
  type SetupRunResult,
} from "./setup/runner.js";
export {
  SetupBackendAdapter,
  SetupBackendError,
  type SetupBackendAdapterOptions,
  type SetupBackendClaim,
  type SetupApplicationEvidence,
  type SetupBackendReceipt,
  type SetupBackendTrial,
  type SetupCredentialResult,
  type SetupInstallationStatus,
  type SetupPreflightStatus,
  type SetupClaimHandoff,
  type SetupProbeEvidence,
} from "./setup/backend.js";
export {
  SetupApplicationActionRequired,
  installSetupRuntime,
  planSetupApplication,
  runSetupCommand,
  wireSetupApplication,
  type SetupApplicationPlan,
  type SetupCommand,
  type SetupCommandRunner,
} from "./setup/application.js";
export { type SetupFileChange } from "./setup/configure.js";
export {
  FileSetupInstallationStore,
  type SetupInstallationRecord,
  type SetupStoredCredential,
  type SetupStoredApplicationEvidence,
  type SetupStoredApplicationAttempt,
  type SetupStoredClaimHandoff,
  type SetupStoredProbe,
} from "./setup/installation.js";
export { detectSetupProject } from "./setup/detect.js";
export {
  renderHumanEvent,
  renderJsonlEvent,
  renderPlainEvent,
  selectSetupOutputMode,
  type SetupOutputMode,
} from "./setup/render.js";
