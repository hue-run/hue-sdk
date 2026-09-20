import type { SetupEvent } from "./types.js";

/** Supported setup transcript formats. */
export type SetupOutputMode = "human" | "plain" | "jsonl";

const ansi = {
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  dim: "\u001b[2m",
  reset: "\u001b[0m",
};

/** Removes capability-shaped fragments and bounds text before it reaches a public transcript. */
export function redactSetupTranscriptText(value: string): string {
  const withoutUrls = value.replace(/https?:\/\/[^\s"'<>]+/giu, (candidate) => {
    try {
      const url = new URL(candidate);
      return url.hash || url.pathname.includes("/setup/claim")
        ? "[private claim handoff]"
        : candidate;
    } catch {
      return "[redacted URL]";
    }
  });
  const redacted = withoutUrls
    .replace(/#[A-Za-z0-9_-]{20,}/gu, "#[redacted]")
    .replace(
      /\b(claim[_-]?(?:secret|token)|hue_claim_)(\s*[:=]\s*)[A-Za-z0-9_-]{16,}/giu,
      "$1$2[redacted]",
    );
  let printable = "";
  for (const character of redacted) {
    const code = character.codePointAt(0)!;
    if ((code >= 32 && code !== 127) || character === "\n" || character === "\t")
      printable += character;
  }
  return printable.slice(0, 1000);
}

function publicEvent(event: SetupEvent): SetupEvent {
  const base = {
    contractVersion: event.contractVersion,
    runId: redactSetupTranscriptText(event.runId),
    sequence: event.sequence,
    timestamp: event.timestamp,
  };
  switch (event.event) {
    case "run.started":
      return {
        ...base,
        event: "run.started",
        command: event.command,
        mode: event.mode,
        resumed: event.resumed,
      };
    case "project.detected":
      return { ...base, event: "project.detected", project: event.project };
    case "plan.ready":
      return { ...base, event: "plan.ready", plan: event.plan };
    case "step.started":
      return { ...base, event: "step.started", step: event.step };
    case "step.completed":
      return { ...base, event: "step.completed", step: event.step, outcome: event.outcome };
    case "file.changed":
      return {
        ...base,
        event: "file.changed",
        path: redactSetupTranscriptText(event.path),
        change: event.change,
      };
    case "diagnostic":
      return {
        ...base,
        event: "diagnostic",
        level: event.level,
        code: event.code,
        message: redactSetupTranscriptText(event.message),
      };
    case "privacy.notice":
      return {
        ...base,
        event: "privacy.notice",
        privacyUrl: event.privacyUrl,
        effectiveDate: event.effectiveDate,
        securityUrl: event.securityUrl,
      };
    case "action.required":
      return {
        ...base,
        event: "action.required",
        action: event.action,
        message: redactSetupTranscriptText(event.message),
        ...(event.command ? { command: redactSetupTranscriptText(event.command) } : {}),
      };
    case "trial.created":
      return {
        ...base,
        event: "trial.created",
        trialId: event.trialId,
        expiresAt: event.expiresAt,
      };
    case "receipt.verified":
      return {
        ...base,
        event: "receipt.verified",
        receiptId: event.receiptId,
        traceId: event.traceId,
        source: event.source,
      };
    case "claim.required":
      return { ...base, event: "claim.required", claimId: event.claimId };
    case "claim.completed":
      return { ...base, event: "claim.completed", claimId: event.claimId };
    case "run.completed":
      return {
        ...base,
        event: "run.completed",
        outcome: event.outcome,
        checkpointed: event.checkpointed,
      };
    case "run.failed":
      return {
        ...base,
        event: "run.failed",
        code: event.code,
        message: redactSetupTranscriptText(event.message),
        resumable: event.resumable,
      };
  }
}

function wrap(text: string, width: number, prefix: string): string {
  const available = Math.max(20, width - prefix.length);
  const words = text.split(/\s+/u);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + word.length + 1 > available) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.map((value) => `${prefix}${value}`).join("\n");
}

function summary(event: SetupEvent): string | undefined {
  switch (event.event) {
    case "run.started":
      return `Hue setup session: ${event.command}${event.resumed ? " (resuming)" : ""}`;
    case "project.detected": {
      const languages = event.project.languages.length
        ? event.project.languages.join(" + ")
        : "unknown language";
      const managers = event.project.packageManagers.length
        ? ` via ${event.project.packageManagers.join(" + ")}`
        : "";
      return `Detected ${languages}${managers}; Hue ${event.project.hue}, OpenTelemetry ${event.project.openTelemetry}.`;
    }
    case "plan.ready":
      return `Plan ready: ${event.plan.steps.length} bounded steps; project mutation is ${event.plan.mutatesProject ? "enabled" : "disabled"}.`;
    case "step.started":
      return `Starting ${event.step}.`;
    case "step.completed":
      return `Completed ${event.step} (${event.outcome}).`;
    case "file.changed":
      return `${event.change === "created" ? "Created" : "Updated"} ${event.path}.`;
    case "diagnostic":
      return `${event.code}: ${event.message}`;
    case "privacy.notice":
      return `Privacy notice effective ${event.effectiveDate}: ${event.privacyUrl}. Security: ${event.securityUrl}`;
    case "action.required":
      return `${event.message}${event.command ? ` Next: ${event.command}.` : ""}`;
    case "trial.created":
      return `Anonymous trial ${event.trialId} created; expires ${event.expiresAt}.`;
    case "receipt.verified":
      return `Repository HTTP boundary receipt ${event.receiptId} verified for trace ${event.traceId}.`;
    case "claim.required":
      return `Account linkage is ready for project owner action (${event.claimId}).`;
    case "claim.completed":
      return `Claim ${event.claimId} completed.`;
    case "run.completed":
      return `Setup session ${event.outcome.replace("_", " ")}; checkpoint ${event.checkpointed ? "saved" : "not created"}.`;
    case "run.failed":
      return `${event.code}: ${event.message}`;
  }
}

/** Renders one newline-free JSON object for JSONL output. */
export function renderJsonlEvent(event: SetupEvent): string {
  return JSON.stringify(publicEvent(event));
}

/** Renders one ANSI-free append-only transcript entry. */
export function renderPlainEvent(event: SetupEvent, width = 80): string {
  const text = summary(publicEvent(event));
  if (!text) return "";
  const marker =
    event.event === "run.failed"
      ? "error"
      : event.event === "action.required"
        ? "action"
        : event.event;
  return wrap(text, width, `[${marker}] `);
}

/** Renders one lightweight append-only terminal entry; it never moves the cursor or clears the screen. */
export function renderHumanEvent(event: SetupEvent, width = 80, color = true): string {
  const text = summary(publicEvent(event));
  if (!text) return "";
  const [symbol, tone] =
    event.event === "run.failed"
      ? ["×", ansi.red]
      : event.event === "action.required"
        ? ["◆", ansi.yellow]
        : event.event === "run.completed"
          ? ["└", ansi.green]
          : event.event === "step.started"
            ? ["◇", ansi.cyan]
            : event.event === "diagnostic"
              ? ["│", ansi.dim]
              : ["│", ansi.green];
  const prefix = `${symbol} `;
  const rendered = wrap(text, width, prefix);
  return color ? `${tone}${rendered}${ansi.reset}` : rendered;
}

/** Chooses a safe default: ANSI only on an ordinary interactive terminal. */
export function selectSetupOutputMode(input: {
  agent?: boolean;
  explicit?: SetupOutputMode;
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
}): SetupOutputMode {
  if (input.agent) return "jsonl";
  if (input.explicit) return input.explicit;
  const env = input.env ?? process.env;
  if (!input.isTTY || env.NO_COLOR !== undefined || env.TERM === "dumb" || env.CI !== undefined)
    return "plain";
  return "human";
}
