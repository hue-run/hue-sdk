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
    case "action.required":
      return `${event.message}${event.command ? ` Next: ${event.command}.` : ""}`;
    case "trial.created":
      return `Anonymous trial ${event.trialId} created; expires ${event.expiresAt}.`;
    case "receipt.verified":
      return `Instrumentation receipt ${event.receiptId} verified for trace ${event.traceId}.`;
    case "claim.required":
      return `Claim ${event.claimId} is ready: ${event.url}`;
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
  return JSON.stringify(event);
}

/** Renders one ANSI-free append-only transcript entry. */
export function renderPlainEvent(event: SetupEvent, width = 80): string {
  const text = summary(event);
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
  const text = summary(event);
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
