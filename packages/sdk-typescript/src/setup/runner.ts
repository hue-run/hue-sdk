import type {
  SetupBackendAdapter,
  SetupApplicationEvidence,
  SetupInstallationStatus,
} from "./backend.js";
import { SetupBackendError } from "./backend.js";
import { SetupApplicationActionRequired } from "./application.js";
import { acquireSetupCommandLock } from "./lock.js";
import type { SetupMachineState } from "./machine.js";
import { createInitialSetupState, transitionSetup } from "./machine.js";
import { redactSetupTranscriptText } from "./render.js";
import {
  SETUP_EVENT_CONTRACT_VERSION,
  type SetupEvent,
  type SetupProjectDetection,
} from "./types.js";

/** Detects the supported language and safe setup plan for a project root. */
export interface SetupProjectAdapter {
  /** Inspects a project without executing its code. */
  detect(root: string, signal?: AbortSignal): Promise<SetupProjectDetection>;
}

/** Persists secret-free setup progress across interruptions. */
export interface SetupCheckpointAdapter {
  /** Reads the checkpoint for one setup run and project. */
  load(runId: string, projectRoot: string): Promise<SetupMachineState | undefined>;
  /** Atomically saves the latest setup state. */
  save(state: SetupMachineState): Promise<void>;
}

/** Backend operations consumed by the resumable setup runner. */
export type SetupBackendOperations = Pick<
  SetupBackendAdapter,
  | "prepare"
  | "resetLocalCache"
  | "preflight"
  | "localInstallation"
  | "provision"
  | "status"
  | "credentials"
  | "installRuntime"
  | "configure"
  | "exerciseApplication"
  | "prepareClaimHandoff"
  | "verifyApplication"
  | "verifyRevokedCredential"
>;

/** Inputs for one invocation of the resumable setup runner. */
export interface SetupRunOptions {
  /** Operation requested by the caller. */
  command: "setup" | "resume" | "status" | "claim";
  /** Output contract selected by the CLI. */
  mode: "human" | "plain" | "jsonl";
  /** Stable identifier for this resumable invocation. */
  runId: string;
  /** Absolute project directory being configured. */
  projectRoot: string;
  /** Safe project detector. */
  project: SetupProjectAdapter;
  /** Secret-free checkpoint persistence. */
  checkpoints: SetupCheckpointAdapter;
  /** Real protocol adapter; omitting it can only report that action is required. */
  backend?: SetupBackendOperations;
  /** Receives each ordered setup event. */
  emit(event: SetupEvent): void | Promise<void>;
  /** Injectable clock used by deterministic tests. */
  now?: () => Date;
  /** Cancels bounded local and network work. */
  signal?: AbortSignal;
  /** Explicit owner request to replace the current browser handoff. Human claim commands only. */
  claimRestart?: boolean;
}

/** Terminal outcome and latest resumable state from one setup invocation. */
export interface SetupRunResult {
  /** Whether setup is verified, needs owner action, or made no change. */
  outcome: "ready" | "action_required" | "unchanged";
  /** Latest checkpoint state when project detection has begun. */
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
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    if (options.backend) {
      releaseLock = await acquireSetupCommandLock(options.projectRoot);
      options.backend.resetLocalCache();
    }
    if (options.claimRestart && (options.command !== "claim" || options.mode !== "human"))
      throw new Error("Refusing non-human browser handoff restart");
    state = await options.checkpoints.load(options.runId, options.projectRoot);
    await emit({
      event: "run.started",
      command: options.command,
      mode: options.mode,
      resumed: state !== undefined,
    });
    if (options.signal?.aborted) throw new Error("Setup interrupted");

    if (options.command === "status") {
      if (!options.backend) {
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
        const local = await options.backend.localInstallation();
        if (!local) {
          await emit({
            event: "diagnostic",
            level: "info",
            code: "installation.absent",
            message: "No Hue setup installation exists for this project and origin.",
          });
          await emit({ event: "run.completed", outcome: "unchanged", checkpointed: false });
          return { outcome: "unchanged" };
        }
      }
    }

    if (!state) {
      if (options.command === "resume" || options.command === "claim")
        throw new Error("No setup checkpoint exists for this project");
      state = createInitialSetupState(options.runId, options.projectRoot);
      await options.checkpoints.save(state);
    }
    // A checkpoint is progress, never authority for current manifests or ownership.
    {
      state = createInitialSetupState(options.runId, options.projectRoot);
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
    if (options.command === "claim" && !local)
      throw new Error("No Hue setup installation exists for this project and origin");
    try {
      const availability = await options.backend.preflight(
        project,
        options.signal,
        options.command === "setup" || options.command === "resume",
      );
      if (
        (options.command === "setup" || options.command === "resume") &&
        availability?.state === "inactive"
      ) {
        await emit({
          event: "diagnostic",
          level: "warning",
          code: "setup.inactive",
          message:
            "Hue anonymous setup is currently inactive; no project or installation files were changed.",
        });
        await emit({
          event: "action.required",
          action: "configure",
          message: "Rerun hue resume after Hue setup admissions are available.",
          command: "hue resume",
        });
        await emit({ event: "run.completed", outcome: "action_required", checkpointed: true });
        return { outcome: "action_required", state };
      }
      if (availability) {
        await emit({
          event: "privacy.notice",
          privacyUrl: availability.privacyNotice.url,
          effectiveDate: availability.privacyNotice.effectiveDate,
          securityUrl: availability.securityUrl,
        });
      }
    } catch (error) {
      if (!(error instanceof SetupApplicationActionRequired)) throw error;
      await emit({
        event: "action.required",
        action: error.code === "ambiguous-project" ? "select-project" : "integrate-application",
        message: error.message,
        command: "hue resume",
      });
      await emit({ event: "run.completed", outcome: "action_required", checkpointed: true });
      return { outcome: "action_required", state };
    }
    if (options.command === "setup" || options.command === "resume") {
      await emit({ event: "step.started", step: "install-runtime" });
      const installed = await options.backend.installRuntime(project);
      await emit({
        event: "step.completed",
        step: "install-runtime",
        outcome: installed ? "changed" : "unchanged",
      });
      await options.backend.prepare();
      // Once a credential exists, status is recovery and spends no provisioning admission.
      status = local?.credential
        ? await options.backend.status(options.signal)
        : await options.backend.provision(options.signal);
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
      local?.applicationEvidence?.verified &&
      local.applicationEvidence.credentialVersion === 0
    ) {
      const handoff = await options.backend.prepareClaimHandoff(
        status,
        options.mode === "human",
        options.claimRestart === true,
        options.signal,
      );
      await emit({
        event: "claim.required",
        claimId: status.installationId,
      });
      await emit({
        event: "action.required",
        action: handoff.restartRequired ? "restart-claim-handoff" : "open-claim-handoff",
        message: handoff.restartRequired
          ? "The one-time browser handoff is no longer usable. The project owner may explicitly replace it from an interactive local terminal."
          : handoff.opened
            ? "Finish account linkage in the browser opened from the owner-only local handoff, then rerun hue claim."
            : "Ask the project owner to run hue claim in an interactive local terminal, finish account linkage in the browser, then rerun hue claim.",
        command: handoff.restartRequired ? "hue claim --restart" : "hue claim",
      });
      await emit({ event: "run.completed", outcome: "action_required", checkpointed: true });
      return { outcome: "action_required", state };
    }

    const before = await options.backend.prepare();
    let oldCredential =
      status.state === "claimed" && before.credential?.version === 0
        ? before.credential.apiKey
        : status.state === "claimed"
          ? before.revocationCredential?.apiKey
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
          else if (status.state === "claimed" && before.revocationCredential)
            oldCredential = before.revocationCredential.apiKey;
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

    await emit({ event: "step.started", step: "verify-application-receipt" });
    const application = await options.backend.prepare();
    if (!application.applicationEvidence && status.state === "claimed") {
      await emit({
        event: "action.required",
        action: "run-instrumented-request",
        message:
          "The preserved initial application evidence is unavailable. Setup will not replay business work automatically; run one explicit instrumented request and rerun hue claim.",
        command: "hue claim",
      });
      await emit({ event: "run.completed", outcome: "action_required", checkpointed: true });
      return { outcome: "action_required", state };
    }
    if (!application.applicationEvidence) {
      try {
        await options.backend.exerciseApplication(project, options.signal);
      } catch (error) {
        if (!(error instanceof SetupApplicationActionRequired)) throw error;
        await emit({
          event: "action.required",
          action: "run-instrumented-request",
          message: error.message,
        });
        await emit({ event: "run.completed", outcome: "action_required", checkpointed: true });
        return { outcome: "action_required", state };
      }
    }
    const evidence: SetupApplicationEvidence | undefined = await options.backend.verifyApplication(
      options.signal,
    );
    if (!evidence) {
      await emit({
        event: "diagnostic",
        level: "warning",
        code: "application.unverified",
        message:
          "The existing application request was exported, but exact stored receipt evidence did not arrive within the bounded deadline.",
      });
      await emit({
        event: "action.required",
        action: "run-instrumented-request",
        message:
          "Run hue resume to retry only exact receipt verification; the business request will not be replayed.",
        command: "hue resume",
      });
      await emit({ event: "run.completed", outcome: "action_required", checkpointed: true });
      return { outcome: "action_required", state };
    }
    await emit({
      event: "receipt.verified",
      receiptId: evidence.traceId,
      traceId: evidence.traceId,
      source: "repository-http-boundary",
    });
    await emit({
      event: "step.completed",
      step: "verify-application-receipt",
      outcome: "verified",
    });

    if (status.state === "active") {
      const handoff =
        options.mode === "human"
          ? await options.backend.prepareClaimHandoff(status, true, false, options.signal)
          : { opened: false, state: "pending" as const, restartRequired: false };
      await emit({
        event: "claim.required",
        claimId: status.installationId,
      });
      await emit({
        event: "action.required",
        action: "open-claim-handoff",
        message: handoff.opened
          ? "An existing application request and its exact receipt are verified. Finish account linkage in the browser opened from the owner-only local handoff, then rerun hue claim."
          : "An existing application request and its exact receipt are verified. Ask the project owner to run hue claim in an interactive local terminal and finish account linkage, then rerun hue claim.",
        command: "hue claim",
      });
      await emit({ event: "run.completed", outcome: "action_required", checkpointed: true });
      return { outcome: "action_required", state };
    }

    if (oldCredential)
      await options.backend.verifyRevokedCredential(oldCredential, evidence, options.signal);
    if (!(await options.backend.prepare()).anonymousKeyRevoked)
      throw new SetupBackendError(
        "unverified",
        "The original anonymous credential is unavailable for revocation verification; claim reconciliation is unverified.",
      );
    await emit({ event: "claim.completed", claimId: status.installationId });
    await emit({
      event: "diagnostic",
      level: "info",
      code: "claim.reconciled",
      message:
        "The replacement credential can access the preserved application receipt, and the superseded anonymous key was refused.",
    });
    await emit({ event: "run.completed", outcome: "ready", checkpointed: true });
    return { outcome: "ready", state };
  } catch (error) {
    if (!terminal) {
      const interrupted =
        options.signal?.aborted ||
        (error instanceof Error && error.message === "Setup interrupted");
      const backendCode = error instanceof SetupBackendError ? error.code.toLowerCase() : undefined;
      const missing =
        error instanceof Error &&
        (error.message.startsWith("No setup checkpoint") ||
          error.message.startsWith("No Hue setup installation"));
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
                ? redactSetupTranscriptText(error.message)
                : "Setup session could not complete. Local resumable state was preserved.",
        resumable: state !== undefined && !missing,
      });
    }
    throw error;
  } finally {
    await releaseLock?.();
  }
}
