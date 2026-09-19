/** Version carried by every setup JSONL event. */
export const SETUP_EVENT_CONTRACT_VERSION = 1 as const;

/** Names in the version 1 setup event contract. */
export type SetupEventName =
  | "run.started"
  | "project.detected"
  | "plan.ready"
  | "step.started"
  | "step.completed"
  | "file.changed"
  | "diagnostic"
  | "action.required"
  | "trial.created"
  | "receipt.verified"
  | "claim.required"
  | "claim.completed"
  | "run.completed"
  | "run.failed";

interface EventBase<Name extends SetupEventName> {
  /** JSONL contract version, independent of the package version. */
  contractVersion: typeof SETUP_EVENT_CONTRACT_VERSION;
  /** Event discriminator. */
  event: Name;
  /** Deterministic installer-session identifier; it is not a Hue Run identifier. */
  runId: string;
  /** One-based sequence within this command invocation. */
  sequence: number;
  /** ISO-8601 time supplied by the runner clock. */
  timestamp: string;
}

/** An installer setup-session command invocation began; this is not a Hue Run. */
export interface RunStartedEvent extends EventBase<"run.started"> {
  /** Command being executed. */
  command: "setup" | "resume" | "status" | "connect";
  /** Renderer selected for this invocation. */
  mode: "human" | "plain" | "jsonl";
  /** Whether a checkpoint existed when the invocation began. */
  resumed: boolean;
}

/** Static project facts read without executing repository code. */
export interface SetupProjectDetection {
  /** Canonical project root. */
  root: string;
  /** Stable hash of the root and detected, non-secret facts. */
  fingerprint: string;
  /** Supported language ecosystems found at the root. */
  languages: Array<"typescript" | "python">;
  /** Package managers identified from declarations or lockfiles. */
  packageManagers: Array<"bun" | "npm" | "pnpm" | "yarn" | "uv" | "poetry" | "pip">;
  /** Known frameworks identified from manifest dependency names. */
  frameworks: Array<
    "nextjs" | "nestjs" | "express" | "fastapi" | "django" | "flask" | "vercel-ai-sdk"
  >;
  /** Language ecosystems with an existing Hue dependency. */
  hue: "absent" | "typescript" | "python" | "multiple";
  /** Language ecosystems with an existing OpenTelemetry dependency. */
  openTelemetry: "absent" | "typescript" | "python" | "multiple";
}

/** Project detection completed. */
export interface ProjectDetectedEvent extends EventBase<"project.detected"> {
  /** Bounded static detection result. */
  project: SetupProjectDetection;
}

/** A bounded local setup plan. */
export interface SetupPlan {
  /** Ordered setup step names. */
  steps: Array<
    | "detect-project"
    | "connect-account"
    | "configure-telemetry"
    | "verify-receipt"
    | "attach-account"
  >;
  /** Whether this plan is permitted to change project files. */
  mutatesProject: boolean;
  /** Whether completion ultimately requires a backend adapter. */
  backendRequired: boolean;
}

/** The deterministic setup plan is ready. */
export interface PlanReadyEvent extends EventBase<"plan.ready"> {
  /** Deterministic plan for this project. */
  plan: SetupPlan;
}

/** A named setup step began. */
export interface StepStartedEvent extends EventBase<"step.started"> {
  /** Step that began. */
  step: SetupPlan["steps"][number];
}

/** A named setup step completed. */
export interface StepCompletedEvent extends EventBase<"step.completed"> {
  /** Step that completed. */
  step: SetupPlan["steps"][number];
  /** Observable result of the step. */
  outcome: "unchanged" | "changed" | "verified" | "skipped";
}

/** A future mutating adapter changed a project file. */
export interface FileChangedEvent extends EventBase<"file.changed"> {
  /** Project-relative changed path. */
  path: string;
  /** Whether the adapter created or updated the path. */
  change: "created" | "updated";
}

/** A secret-free diagnostic safe for terminals and transcripts. */
export interface DiagnosticEvent extends EventBase<"diagnostic"> {
  /** Diagnostic severity. */
  level: "info" | "warning" | "error";
  /** Stable machine-readable diagnostic code. */
  code: string;
  /** Secret-free human-readable explanation. */
  message: string;
}

/** Progress needs an explicit local or human action. */
export interface ActionRequiredEvent extends EventBase<"action.required"> {
  /** Kind of action needed to continue. */
  action:
    | "connect-account"
    | "configure"
    | "run-instrumented-request"
    | "open-claim-url"
    | "review-captured-trace";
  /** Secret-free explanation of the action. */
  message: string;
  /** Optional command the caller may run. */
  command?: string;
  /** Optional HTTPS destination for a user action. */
  url?: string;
}

/** A backend adapter created an anonymous trial. */
export interface TrialCreatedEvent extends EventBase<"trial.created"> {
  /** Non-secret backend trial identifier. */
  trialId: string;
  /** ISO-8601 trial expiration. */
  expiresAt: string;
}

/** A backend adapter verified a stored trace receipt. */
export interface ReceiptVerifiedEvent extends EventBase<"receipt.verified"> {
  /** Non-secret receipt identifier. */
  receiptId: string;
  /** Verified lowercase OpenTelemetry trace identifier. */
  traceId: string;
}

/** The anonymous project can be claimed by a person. */
export interface ClaimRequiredEvent extends EventBase<"claim.required"> {
  /** Non-secret claim identifier. */
  claimId: string;
  /** User-facing claim destination; never persisted in setup checkpoints. */
  url: string;
}

/** A backend adapter confirmed that the project was claimed. */
export interface ClaimCompletedEvent extends EventBase<"claim.completed"> {
  /** Non-secret completed claim identifier. */
  claimId: string;
}

/** Exactly one successful terminal installer event ends a JSONL setup-session invocation. */
export interface RunCompletedEvent extends EventBase<"run.completed"> {
  /** Terminal invocation result. */
  outcome: "ready" | "action_required" | "unchanged";
  /** Whether resumable state exists after the invocation. */
  checkpointed: boolean;
}

/** Exactly one failed terminal installer event ends a JSONL setup-session invocation. */
export interface RunFailedEvent extends EventBase<"run.failed"> {
  /** Stable machine-readable failure code. */
  code: string;
  /** Sanitized failure explanation. */
  message: string;
  /** Whether a later `resume` can safely continue. */
  resumable: boolean;
}

/** Version 1 setup JSONL event union. */
export type SetupEvent =
  | RunStartedEvent
  | ProjectDetectedEvent
  | PlanReadyEvent
  | StepStartedEvent
  | StepCompletedEvent
  | FileChangedEvent
  | DiagnosticEvent
  | ActionRequiredEvent
  | TrialCreatedEvent
  | ReceiptVerifiedEvent
  | ClaimRequiredEvent
  | ClaimCompletedEvent
  | RunCompletedEvent
  | RunFailedEvent;
