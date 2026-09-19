import type { SetupMachineState } from "./machine.js";
import { createInitialSetupState, transitionSetup } from "./machine.js";
import {
  SETUP_EVENT_CONTRACT_VERSION,
  type SetupEvent,
  type SetupProjectDetection,
} from "./types.js";

/** Non-secret setup-trial identity returned by a future account-attachment adapter. */
export interface SetupBackendTrial {
  /** Non-secret trial identifier. */
  trialId: string;
  /** ISO-8601 trial expiration. */
  expiresAt: string;
}
/** Receipt evidence returned by a future backend adapter. */
export interface SetupBackendReceipt {
  /** Non-secret receipt identifier. */
  receiptId: string;
  /** Verified lowercase OpenTelemetry trace identifier. */
  traceId: string;
}
/** @inline */
interface SetupBackendClaimRequired {
  /** Claim is ready for a person. */
  status: "required";
  /** Non-secret claim identifier. */
  claimId: string;
  /** User-facing URL, which must never be checkpointed. */
  url: string;
}
/** @inline */
interface SetupBackendClaimCompleted {
  /** Claim has been confirmed by the backend. */
  status: "completed";
  /** Non-secret claim identifier. */
  claimId: string;
}
/** Claim state returned by a future backend adapter. Claim URLs are never checkpointed. */
export type SetupBackendClaim = SetupBackendClaimRequired | SetupBackendClaimCompleted;

/** Installer-only network boundary for account attachment. It never creates a Scenario, worker, evaluation, or Hue Run. */
export interface SetupBackendAdapter {
  /** Creates or idempotently recovers an anonymous trial. */
  createTrial(
    input: { runId: string; projectFingerprint: string; idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<SetupBackendTrial>;
  /** Returns verified receipt evidence, or `undefined` while evidence is pending. */
  verifyReceipt(
    input: { trialId: string; idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<SetupBackendReceipt | undefined>;
  /** Reads the current claim state without opening its URL. */
  getClaim(
    input: { trialId: string; idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<SetupBackendClaim>;
}

/** Static project-inspection boundary. */
export interface SetupProjectAdapter {
  /** Inspects bounded metadata without executing project code. */
  detect(root: string, signal?: AbortSignal): Promise<SetupProjectDetection>;
}
/** Secret-free durable state boundary. */
export interface SetupCheckpointAdapter {
  /** Loads and validates state for this exact project identity. */
  load(runId: string, projectRoot: string): Promise<SetupMachineState | undefined>;
  /** Durably saves secret-free state before the next effect. */
  save(state: SetupMachineState): Promise<void>;
}

/** Options for one deterministic setup invocation. */
export interface SetupRunOptions {
  /** CLI operation being orchestrated. */
  command: "setup" | "resume" | "status" | "connect";
  /** Renderer mode recorded in `run.started`. */
  mode: "human" | "plain" | "jsonl";
  /** Stable installer-session identifier, unrelated to Hue Runs. */
  runId: string;
  /** Canonical project root. */
  projectRoot: string;
  /** Injected static-inspection adapter. */
  project: SetupProjectAdapter;
  /** Injected secret-free checkpoint adapter. */
  checkpoints: SetupCheckpointAdapter;
  /** Reserved injection point for the follow-up integration; intentionally unused by this slice. */
  backend?: SetupBackendAdapter;
  /** Receives each ordered event exactly once. */
  emit(event: SetupEvent): void | Promise<void>;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Optional cancellation signal. */
  signal?: AbortSignal;
}

/** Result of one setup invocation. */
export interface SetupRunResult {
  /** Non-fabricated local outcome. */
  outcome: "ready" | "action_required" | "unchanged";
  /** Last validated state, when one exists. */
  state?: SetupMachineState;
}

type SetupEventBody = SetupEvent extends infer Event
  ? Event extends SetupEvent
    ? Omit<Event, "contractVersion" | "runId" | "sequence" | "timestamp">
    : never
  : never;

/** Runs one installer setup-session command and emits one terminal event; it never launches a Hue Run. */
export async function runSetup(options: SetupRunOptions): Promise<SetupRunResult> {
  const now = options.now ?? (() => new Date());
  let sequence = 0;
  let terminal = false;
  const emit = async (body: SetupEventBody) => {
    const event = {
      contractVersion: SETUP_EVENT_CONTRACT_VERSION,
      runId: options.runId,
      sequence: ++sequence,
      timestamp: now().toISOString(),
      ...body,
    } as SetupEvent;
    if (event.event === "run.completed" || event.event === "run.failed") {
      if (terminal) throw new Error("Setup runner attempted to emit more than one terminal event");
      terminal = true;
    } else if (terminal) throw new Error("Setup runner emitted an event after its terminal event");
    await options.emit(event);
  };
  let state: SetupMachineState | undefined;
  try {
    state = await options.checkpoints.load(options.runId, options.projectRoot);
    await emit({
      event: "run.started",
      command: options.command,
      mode: options.mode,
      resumed: state !== undefined,
    });
    if (options.signal?.aborted) throw new Error("Setup interrupted");
    if (options.command === "status") {
      await emit({
        event: "diagnostic",
        level: "info",
        code: state ? `checkpoint.${state.phase}` : "checkpoint.absent",
        message: state
          ? `Checkpoint phase: ${state.phase}.`
          : "No setup checkpoint exists for this project.",
      });
      await emit({
        event: "run.completed",
        outcome: "unchanged",
        checkpointed: state !== undefined,
      });
      return { outcome: "unchanged", state };
    }
    if (options.command === "connect") {
      await emit({
        event: "action.required",
        action: "connect-account",
        message: "Account attachment is not available in this build; no backend request was made.",
      });
      await emit({
        event: "run.completed",
        outcome: "action_required",
        checkpointed: state !== undefined,
      });
      return { outcome: "action_required", state };
    }
    if (!state) {
      if (options.command === "resume")
        throw new Error("No setup checkpoint exists for this project");
      state = createInitialSetupState(options.runId, options.projectRoot);
      await options.checkpoints.save(state);
    }
    if (state.phase === "awaiting-account") {
      await emit({ event: "project.detected", project: state.project });
      await emit({ event: "plan.ready", plan: state.plan });
      await emit({
        event: "action.required",
        action: "connect-account",
        message: "Local inspection is complete. Account attachment is not available in this build.",
        command: "hue connect",
      });
      await emit({ event: "run.completed", outcome: "action_required", checkpointed: true });
      return { outcome: "action_required", state };
    }
    const first = transitionSetup(state, { type: "start" });
    state = first.state;
    await options.checkpoints.save(state);
    for (const event of first.events) await emit(event);
    if (options.signal?.aborted) throw new Error("Setup interrupted");
    const project = await options.project.detect(first.effect!.root, options.signal);
    if (options.signal?.aborted) throw new Error("Setup interrupted");
    const second = transitionSetup(state, { type: "project.detected", project });
    state = second.state;
    await options.checkpoints.save(state);
    for (const event of second.events) await emit(event);
    await emit({ event: "run.completed", outcome: "action_required", checkpointed: true });
    return { outcome: "action_required", state };
  } catch (error) {
    if (!terminal) {
      const interrupted =
        options.signal?.aborted ||
        (error instanceof Error && error.message === "Setup interrupted");
      await emit({
        event: "run.failed",
        code: interrupted ? "interrupted" : "setup_failed",
        message: interrupted
          ? "Setup session was interrupted and can be resumed."
          : error instanceof Error && error.message.startsWith("No setup checkpoint")
            ? error.message
            : "Setup session could not complete. No credentials were stored.",
        resumable: state !== undefined,
      });
    }
    throw error;
  }
}
