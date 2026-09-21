import { SETUP_EVENT_CONTRACT_VERSION, type SetupEvent } from "./types.js";

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
  if (typeof value !== "string") return "[invalid text]";
  // Normalize encoded/separated spellings before matching, and redact before truncating.
  let normalized = value;
  for (let pass = 0; pass < 3; pass++)
    normalized = normalized
      .replace(/%([a-f0-9]{2})/giu, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replace(/\\u([a-f0-9]{4})/giu, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replaceAll("\\/", "/");
  normalized = normalized.replace(/[\p{Cc}\p{Cf}]/gu, "");
  const withoutUrls = normalized.replace(/https?:\/\/[^\s"'<>]+/giu, (candidate) => {
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
    // Deliberately recognize incomplete and unknown namespace suffixes too. A
    // transport exception may contain only a truncated credential.
    .replace(/hue_(?:sk|setup|install|claim)_[A-Za-z0-9_-]*/giu, "[private credential]")
    .replace(/#[A-Za-z0-9_-]+/gu, "#[redacted]")
    .replace(
      /\b(claim[_-]?(?:secret|token))(["']?\s*[:=]\s*["']?)[A-Za-z0-9_-]+/giu,
      "$1$2[redacted]",
    )
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gu, "[private capability]");
  return redacted.slice(0, 1000);
}

function choice<T extends string>(value: T, allowed: readonly T[]): T {
  return allowed.includes(value) ? value : allowed[0]!;
}

function choices<T extends string>(values: T[], allowed: readonly T[]): T[] {
  return Array.isArray(values)
    ? [...new Set(values.filter((value) => allowed.includes(value)))]
    : [];
}

const steps = [
  "detect-project",
  "install-runtime",
  "configure-telemetry",
  "verify-application-receipt",
  "claim-project",
] as const;

function publicEvent(event: SetupEvent): SetupEvent {
  const base = {
    contractVersion: SETUP_EVENT_CONTRACT_VERSION,
    runId: redactSetupTranscriptText(event.runId),
    sequence: Number.isSafeInteger(event.sequence) ? event.sequence : 1,
    timestamp: redactSetupTranscriptText(event.timestamp),
  };
  switch (event.event) {
    case "run.started":
      return {
        ...base,
        event: "run.started",
        command: choice(event.command, ["setup", "resume", "status", "claim"]),
        mode: choice(event.mode, ["human", "plain", "jsonl"]),
        resumed: event.resumed === true,
      };
    case "project.detected":
      return {
        ...base,
        event: "project.detected",
        project: {
          root: redactSetupTranscriptText(event.project.root),
          fingerprint: redactSetupTranscriptText(event.project.fingerprint),
          languages: choices(event.project.languages, ["typescript", "python"]),
          packageManagers: choices(event.project.packageManagers, [
            "bun",
            "npm",
            "pnpm",
            "yarn",
            "uv",
            "poetry",
            "pip",
          ]),
          frameworks: choices(event.project.frameworks, [
            "nextjs",
            "nestjs",
            "express",
            "fastapi",
            "django",
            "flask",
            "vercel-ai-sdk",
          ]),
          hue: choice(event.project.hue, ["absent", "typescript", "python", "multiple"]),
          openTelemetry: choice(event.project.openTelemetry, [
            "absent",
            "typescript",
            "python",
            "multiple",
          ]),
        },
      };
    case "plan.ready":
      return {
        ...base,
        event: "plan.ready",
        plan: {
          steps: choices(event.plan.steps, steps),
          mutatesProject: event.plan.mutatesProject === true,
          backendRequired: event.plan.backendRequired === true,
        },
      };
    case "step.started":
      return { ...base, event: "step.started", step: choice(event.step, steps) };
    case "step.completed":
      return {
        ...base,
        event: "step.completed",
        step: choice(event.step, steps),
        outcome: choice(event.outcome, ["unchanged", "changed", "verified", "skipped"]),
      };
    case "file.changed":
      return {
        ...base,
        event: "file.changed",
        path: redactSetupTranscriptText(event.path),
        change: choice(event.change, ["created", "updated"]),
      };
    case "diagnostic":
      return {
        ...base,
        event: "diagnostic",
        level: choice(event.level, ["info", "warning", "error"]),
        code: redactSetupTranscriptText(event.code),
        message: redactSetupTranscriptText(event.message),
      };
    case "privacy.notice":
      return {
        ...base,
        event: "privacy.notice",
        privacyUrl: "https://hue.run/privacy",
        effectiveDate: "2026-08-24",
        securityUrl: "https://trust.hue.run/",
      };
    case "action.required":
      return {
        ...base,
        event: "action.required",
        action: choice(event.action, [
          "claim-project",
          "configure",
          "select-project",
          "integrate-application",
          "run-instrumented-request",
          "open-claim-handoff",
          "restart-claim-handoff",
        ]),
        message: redactSetupTranscriptText(event.message),
        ...(event.command ? { command: redactSetupTranscriptText(event.command) } : {}),
      };
    case "trial.created":
      return {
        ...base,
        event: "trial.created",
        trialId: redactSetupTranscriptText(event.trialId),
        expiresAt: redactSetupTranscriptText(event.expiresAt),
      };
    case "receipt.verified":
      return {
        ...base,
        event: "receipt.verified",
        receiptId: redactSetupTranscriptText(event.receiptId),
        traceId: redactSetupTranscriptText(event.traceId),
        source: "repository-http-boundary",
      };
    case "claim.required":
      return {
        ...base,
        event: "claim.required",
        claimId: redactSetupTranscriptText(event.claimId),
      };
    case "claim.completed":
      return {
        ...base,
        event: "claim.completed",
        claimId: redactSetupTranscriptText(event.claimId),
      };
    case "run.completed":
      return {
        ...base,
        event: "run.completed",
        outcome: choice(event.outcome, ["ready", "action_required", "unchanged"]),
        checkpointed: event.checkpointed === true,
      };
    case "run.failed":
      return {
        ...base,
        event: "run.failed",
        code: redactSetupTranscriptText(event.code),
        message: redactSetupTranscriptText(event.message),
        resumable: event.resumable === true,
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
