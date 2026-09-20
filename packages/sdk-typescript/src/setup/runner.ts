import type {
  SetupBackendAdapter,
  SetupInstallationStatus,
  SetupProbeEvidence,
} from "./backend.js";
import { SetupBackendError } from "./backend.js";
import type { SetupMachineState } from "./machine.js";
import { createInitialSetupState, transitionSetup } from "./machine.js";
import {
  SETUP_EVENT_CONTRACT_VERSION,
  type SetupEvent,
  type SetupProjectDetection,
} from "./types.js";

export interface SetupProjectAdapter {
  detect(root: string, signal?: AbortSignal): Promise<SetupProjectDetection>;
}

export interface SetupCheckpointAdapter {
  load(runId: string, projectRoot: string): Promise<SetupMachineState | undefined>;
  save(state: SetupMachineState): Promise<void>;
}

export type SetupBackendOperations = Pick<
  SetupBackendAdapter,
  | "prepare"
  | "preflight"
  | "localInstallation"
  | "provision"
  | "status"
  | "credentials"
  | "configure"
  | "verifyProbe"
  | "verifyRevokedCredential"
>;

export interface SetupRunOptions {
  command: "setup" | "resume" | "status" | "claim";
  mode: "human" | "plain" | "jsonl";
  runId: string;
  projectRoot: string;
  project: SetupProjectAdapter;
  checkpoints: SetupCheckpointAdapter;
  backend?: SetupBackendOperations;
  emit(event: SetupEvent): void | Promise<void>;
  now?: () => Date;
  signal?: AbortSignal;
}

export interface SetupRunResult {
  outcome: "ready" | "action_required" | "unchanged";
  state?: SetupMachineState;
}

type SetupEventBody = SetupEvent extends infer Event
  ? Event extends SetupEvent
    ? Omit<Event, "contractVersion" | "runId" | "sequence" | "timestamp">
    : never
  : never;

function rejectTerminal(status: SetupInstallationStatus): void {
  if (status.state === "expired" || status.state === "purged")
    throw new SetupBackendError(
      "SETUP_EXPIRED",
      "This setup installation is terminal and will not be replaced automatically.",
      410,
    );
}

/** Runs one resumable setup command and emits exactly one terminal event. */
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

    if (options.command === "status" && !options.backend) {
      await emit({
        event: "diagnostic",
        level: "info",
        code: state ? `checkpoint.${state.phase}` : "checkpoint.absent",
        message: state
          ? `Checkpoint phase: ${state.phase}.`
          : "No setup checkpoint exists for this project.",
      });
      await emit({ event: "run.completed", outcome: "unchanged", checkpointed: !!state });
      return { outcome: "unchanged", state };
    }

    if (!state) {
      if (options.command === "resume" || options.command === "claim")
        throw new Error("No setup checkpoint exists for this project");
      state = createInitialSetupState(options.runId, options.projectRoot);
      await options.checkpoints.save(state);
    }
    if (state.phase !== "local-ready") {
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
    } else {
      await emit({ event: "project.detected", project: state.project });
      await emit({ event: "plan.ready", plan: state.plan });
    }
    if (state.phase !== "local-ready") throw new Error("Setup project detection did not complete");

    if (!options.backend) {
      await emit({
        event: "action.required",
        action: "configure",
        message: "A SetupBackendAdapter is required to continue; no success was fabricated.",
      });
      await emit({ event: "run.completed", outcome: "action_required", checkpointed: true });
      return { outcome: "action_required", state };
    }

    const project = state.project;
    let status: SetupInstallationStatus;
    const local = await options.backend.localInstallation();
    if (options.command === "status" && !local) {
      await emit({
        event: "diagnostic",
        level: "info",
        code: "installation.absent",
        message: "No Hue setup installation exists for this project and origin.",
      });
      await emit({ event: "run.completed", outcome: "unchanged", checkpointed: true });
      return { outcome: "unchanged", state };
    }
    if (options.command === "setup" || options.command === "resume") {
      await options.backend.prepare();
      await options.backend.preflight(project);
      status = await options.backend.provision(options.signal);
      rejectTerminal(status);
      if (status.state === "active")
        await emit({
          event: "trial.created",
          trialId: status.installationId,
          expiresAt: status.expiresAt!,
        });
    } else {
      status = await options.backend.status(options.signal);
      rejectTerminal(status);
    }

    if (options.command === "status" && status.state === "active") {
      await emit({
        event: "diagnostic",
        level: "info",
        code: "installation.active",
        message: "The metadata-only setup installation is active and awaiting account claim.",
      });
      await emit({ event: "run.completed", outcome: "unchanged", checkpointed: true });
      return { outcome: "unchanged", state };
    }

    if (
      options.command === "claim" &&
      status.state === "active" &&
      local?.probe?.verified &&
      local.probe.credentialVersion === 0
    ) {
      await emit({
        event: "claim.required",
        claimId: status.installationId,
        url: status.claimUrl!,
      });
      await emit({
        event: "action.required",
        action: "open-claim-url",
        message:
          "Open this private claim link in a browser. The fragment is a bearer capability; do not log or share it.",
        url: status.claimUrl!,
        command: "hue claim",
      });
      await emit({ event: "run.completed", outcome: "action_required", checkpointed: true });
      return { outcome: "action_required", state };
    }

    await options.backend.preflight(project);

    const before = await options.backend.prepare();
    let oldCredential =
      status.state === "claimed" && before.credential?.version === 0
        ? before.credential.apiKey
        : undefined;
    let refreshed = false;
    for (;;) {
      try {
        await options.backend.credentials(status.credentialVersion, options.signal);
        break;
      } catch (error) {
        if (error instanceof SetupBackendError && error.code === "SETUP_CHANGED" && !refreshed) {
          refreshed = true;
          status = await options.backend.status(options.signal);
          rejectTerminal(status);
          if (status.state === "claimed" && before.credential?.version === 0)
            oldCredential = before.credential.apiKey;
          continue;
        }
        if (error instanceof SetupBackendError && error.code === "SETUP_REVOKED") {
          await emit({
            event: "action.required",
            action: "configure",
            message:
              "The managed setup key was revoked. An account owner must explicitly rotate an account-managed telemetry key; setup will not resurrect it.",
          });
          await emit({ event: "run.completed", outcome: "action_required", checkpointed: true });
          return { outcome: "action_required", state };
        }
        throw error;
      }
    }

    await emit({ event: "step.started", step: "configure-telemetry" });
    const changes = await options.backend.configure(project);
    for (const change of changes) await emit({ event: "file.changed", ...change });
    await emit({
      event: "step.completed",
      step: "configure-telemetry",
      outcome: changes.length ? "changed" : "unchanged",
    });

    await emit({ event: "step.started", step: "verify-receipt" });
    const evidence: SetupProbeEvidence | undefined = await options.backend.verifyProbe(
      options.signal,
    );
    if (!evidence) {
      await emit({
        event: "diagnostic",
        level: "warning",
        code: "probe.unverified",
        message:
          "The metadata probe was exported, but exact stored receipt evidence did not arrive within the bounded deadline.",
      });
      await emit({
        event: "action.required",
        action: "run-instrumented-request",
        message:
          "Run hue resume to retry receipt verification. Probe delivery is not proof that application instrumentation ran.",
        command: "hue resume",
      });
      await emit({ event: "run.completed", outcome: "action_required", checkpointed: true });
      return { outcome: "action_required", state };
    }
    await emit({
      event: "receipt.verified",
      receiptId: evidence.traceId,
      traceId: evidence.traceId,
    });
    await emit({ event: "step.completed", step: "verify-receipt", outcome: "verified" });

    if (status.state === "active") {
      await emit({
        event: "claim.required",
        claimId: status.installationId,
        url: status.claimUrl!,
      });
      await emit({
        event: "action.required",
        action: "claim-project",
        message:
          "The setup probe is stored. This proves only the probe, not that customer application instrumentation ran. Claim the project, then run hue claim again to reconcile credentials.",
        command: "hue claim",
        url: status.claimUrl!,
      });
      await emit({ event: "run.completed", outcome: "action_required", checkpointed: true });
      return { outcome: "action_required", state };
    }

    if (oldCredential)
      await options.backend.verifyRevokedCredential(oldCredential, evidence, options.signal);
    await emit({ event: "claim.completed", claimId: status.installationId });
    await emit({
      event: "diagnostic",
      level: "info",
      code: "probe.verified",
      message:
        "The post-claim metadata probe and replacement credential are verified. Application instrumentation still requires a real application run.",
    });
    await emit({ event: "run.completed", outcome: "ready", checkpointed: true });
    return { outcome: "ready", state };
  } catch (error) {
    if (!terminal) {
      const interrupted =
        options.signal?.aborted ||
        (error instanceof Error && error.message === "Setup interrupted");
      const backendCode = error instanceof SetupBackendError ? error.code.toLowerCase() : undefined;
      const missing = error instanceof Error && error.message.startsWith("No setup checkpoint");
      const conflict = error instanceof Error && error.message.startsWith("Refusing");
      await emit({
        event: "run.failed",
        code: interrupted
          ? "interrupted"
          : conflict
            ? "configuration_conflict"
            : (backendCode ?? "setup_failed"),
        message: interrupted
          ? "Setup session was interrupted and can be resumed."
          : missing
            ? (error as Error).message
            : conflict
              ? (error as Error).message
              : error instanceof SetupBackendError
                ? error.message
                : "Setup session could not complete. Local resumable state was preserved.",
        resumable: state !== undefined && !missing,
      });
    }
    throw error;
  }
}
