/** Local, resumable installer setup-session contracts used by the `hue` command. */
export {
  SETUP_EVENT_CONTRACT_VERSION,
  type ActionRequiredEvent,
  type ClaimCompletedEvent,
  type ClaimRequiredEvent,
  type DiagnosticEvent,
  type FileChangedEvent,
  type PlanReadyEvent,
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
  type SetupBackendAdapter,
  type SetupBackendClaim,
  type SetupBackendReceipt,
  type SetupBackendTrial,
  type SetupCheckpointAdapter,
  type SetupProjectAdapter,
  type SetupRunOptions,
  type SetupRunResult,
} from "./setup/runner.js";
export { detectSetupProject } from "./setup/detect.js";
export {
  renderHumanEvent,
  renderJsonlEvent,
  renderPlainEvent,
  selectSetupOutputMode,
  type SetupOutputMode,
} from "./setup/render.js";
