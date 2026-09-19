import type { SetupPlan, SetupProjectDetection } from "./types.js";

/** @inline */
interface SetupStateBase {
  /** Checkpoint format version. */
  format: 1;
  /** Current state-machine phase. */
  phase: "created" | "detecting" | "awaiting-account";
  /** Stable installer-session identifier, unrelated to Hue Runs. */
  runId: string;
  /** Canonical project root. */
  projectRoot: string;
}

/** @inline */
interface CreatedSetupState extends SetupStateBase {
  /** Initial phase before any adapter work. */
  phase: "created";
}

/** @inline */
interface DetectingSetupState extends SetupStateBase {
  /** Safely resumable static-detection phase. */
  phase: "detecting";
}

/** @inline */
interface AwaitingAccountSetupState extends SetupStateBase {
  /** Local inspection is complete and account attachment is still required. */
  phase: "awaiting-account";
  /** Saved bounded project facts. */
  project: SetupProjectDetection;
  /** Saved deterministic plan. */
  plan: SetupPlan;
}

/** Persisted phase of the pure setup state machine. */
export type SetupMachineState = CreatedSetupState | DetectingSetupState | AwaitingAccountSetupState;

/** @inline */
interface StartSetupInput {
  /** Requests the next safe local effect. */
  type: "start";
}

/** @inline */
interface ProjectDetectedSetupInput {
  /** Supplies a completed project detection. */
  type: "project.detected";
  /** Static detection supplied by the project adapter. */
  project: SetupProjectDetection;
}

/** Input returned by an injected setup adapter. */
export type SetupMachineInput = StartSetupInput | ProjectDetectedSetupInput;

/** Side effect requested by the pure state machine. */
export interface SetupEffect {
  /** Adapter operation requested by the machine. */
  type: "detect-project";
  /** Canonical root to inspect. */
  root: string;
}

/** @inline */
interface StartStepTransitionEvent {
  /** Transition-event discriminator. */
  event: "step.started";
  /** Static detection step. */
  step: "detect-project";
}

/** @inline */
interface ProjectDetectedTransitionEvent {
  /** Transition-event discriminator. */
  event: "project.detected";
  /** Completed detection. */
  project: SetupProjectDetection;
}

/** @inline */
interface CompleteStepTransitionEvent {
  /** Transition-event discriminator. */
  event: "step.completed";
  /** Static detection step. */
  step: "detect-project";
  /** Detection never changes project files. */
  outcome: "unchanged";
}

/** @inline */
interface PlanReadyTransitionEvent {
  /** Transition-event discriminator. */
  event: "plan.ready";
  /** Deterministic plan. */
  plan: SetupPlan;
}

/** @inline */
interface ConnectAccountRequiredTransitionEvent {
  /** Transition-event discriminator. */
  event: "action.required";
  /** Backend action needed next. */
  action: "connect-account";
  /** Secret-free explanation. */
  message: string;
  /** Stable follow-up command. */
  command: "hue connect";
}

/** @inline */
type SetupTransitionEvent =
  | StartStepTransitionEvent
  | ProjectDetectedTransitionEvent
  | CompleteStepTransitionEvent
  | PlanReadyTransitionEvent
  | ConnectAccountRequiredTransitionEvent;

/** Pure transition result. Events are templates completed by the runner. */
export interface SetupTransition {
  /** State to checkpoint before executing another effect. */
  state: SetupMachineState;
  /** Event templates for the runner to sequence and timestamp. */
  events: SetupTransitionEvent[];
  /** Optional side effect to execute after saving the state. */
  effect?: SetupEffect;
}

/** Creates deterministic initial setup state without reading the filesystem. */
export function createInitialSetupState(runId: string, projectRoot: string): SetupMachineState {
  return { format: 1, phase: "created", runId, projectRoot };
}

/** Advances the setup state without I/O, clocks, randomness, or environment access. */
export function transitionSetup(
  state: SetupMachineState,
  input: SetupMachineInput,
): SetupTransition {
  if ((state.phase === "created" || state.phase === "detecting") && input.type === "start") {
    const next: SetupMachineState = { ...state, phase: "detecting" };
    return {
      state: next,
      events: [{ event: "step.started", step: "detect-project" }],
      effect: { type: "detect-project", root: state.projectRoot },
    };
  }
  if (state.phase === "detecting" && input.type === "project.detected") {
    const plan: SetupPlan = {
      steps: [
        "detect-project",
        "connect-account",
        "configure-telemetry",
        "verify-receipt",
        "attach-account",
      ],
      mutatesProject: false,
      backendRequired: true,
    };
    return {
      state: {
        format: 1,
        phase: "awaiting-account",
        runId: state.runId,
        projectRoot: state.projectRoot,
        project: input.project,
        plan,
      },
      events: [
        { event: "project.detected", project: input.project },
        { event: "step.completed", step: "detect-project", outcome: "unchanged" },
        { event: "plan.ready", plan },
        {
          event: "action.required",
          action: "connect-account",
          message:
            "Local inspection is complete. Account attachment is not available in this build.",
          command: "hue connect",
        },
      ],
    };
  }
  throw new Error(`Invalid setup transition from ${state.phase} using ${input.type}`);
}
