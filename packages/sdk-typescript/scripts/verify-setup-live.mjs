#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

/** Independent fail-closed guard for captured child output, including partial secrets. */
export function containsSetupSecretText(value) {
  let text = String(value ?? "");
  for (let pass = 0; pass < 3; pass++)
    text = text
      .replace(/%([a-f0-9]{2})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\u([a-f0-9]{4})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replaceAll("\\/", "/");
  text = text.replace(/[\p{Cc}\p{Cf}]/gu, "");
  return (
    /hue_(?:sk|setup|install|claim)_[A-Za-z0-9_-]*/iu.test(text) ||
    /\/setup\/claim(?:#|%23)/iu.test(text) ||
    /#[A-Za-z0-9_-]+/u.test(text) ||
    /\bclaim[_-]?(?:secret|token)["']?\s*[:=]/iu.test(text) ||
    /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/u.test(text)
  );
}

const eventNames = new Set([
  "run.started",
  "project.detected",
  "plan.ready",
  "step.started",
  "step.completed",
  "file.changed",
  "diagnostic",
  "privacy.notice",
  "action.required",
  "trial.created",
  "receipt.verified",
  "claim.required",
  "claim.completed",
  "run.completed",
  "run.failed",
]);

/** Diagnostic projection only: even valid v2 events are not independent receipt evidence. */
export function publicSetupEvidenceEvents(events) {
  return events.map((event) => {
    if (!event || typeof event !== "object" || Array.isArray(event) || !eventNames.has(event.event))
      throw new Error("The installed CLI returned an invalid event.");
    if (containsSetupSecretText(JSON.stringify(event)))
      throw new Error("The installed CLI emitted private material; output was suppressed.");
    if (event.contractVersion !== 2)
      throw new Error("The installed CLI returned an unsupported event version.");
    if (
      event.event === "receipt.verified" &&
      (event.source !== "repository-http-boundary" ||
        typeof event.traceId !== "string" ||
        !/^(?!0{32}$)[a-f0-9]{32}$/u.test(event.traceId))
    )
      throw new Error("The installed CLI did not report an application-bound receipt.");
    return { event: event.event };
  });
}

async function main() {
  const { values } = parseArgs({
    strict: true,
    options: {
      archive: { type: "string" },
      origin: { type: "string" },
      project: { type: "string" },
      command: { type: "string", default: "setup" },
      language: { type: "string" },
      mode: { type: "string", default: "agent" },
      evidence: { type: "string" },
    },
  });
  if (!values.archive || !values.origin || !values.project)
    throw new Error("Required: --archive FILE --origin URL --project PATH");
  if (!["setup", "resume", "status", "claim"].includes(values.command))
    throw new Error("--command must be setup, resume, status or claim");
  if (!["agent", "human"].includes(values.mode)) throw new Error("--mode must be agent or human");
  if (values.language !== undefined && !["typescript", "python"].includes(values.language))
    throw new Error("--language must be typescript or python");
  if (values.language) {
    process.stderr.write(
      "Prepare a supported Express/npm, Express/Bun or Flask/uv application fixture first; this runner does not generate application evidence.\n",
    );
    process.exitCode = 2;
    return;
  }

  const archive = resolve(values.archive);
  const project = await realpath(resolve(values.project));

  const harness = await mkdtemp(`${tmpdir()}/hue-setup-live-`);
  await writeFile(
    `${harness}/package.json`,
    `${JSON.stringify({ private: true, dependencies: { "@hue-run/sdk": `file:${archive}` } })}\n`,
  );
  const install = spawnSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
    ],
    { cwd: harness, encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 },
  );
  if (install.status !== 0) throw new Error("Unable to install the exact setup archive");

  const cli = `${harness}/node_modules/.bin/hue`;
  const args = [
    values.command,
    ...(values.mode === "agent" ? ["--agent"] : ["--format", "human"]),
    "--project",
    project,
    "--origin",
    values.origin,
  ];
  const result = spawnSync(cli, args, {
    cwd: project,
    encoding: "utf8",
    timeout: 90_000,
    env: { ...process.env, NO_COLOR: values.mode === "agent" ? "1" : "" },
  });
  if (containsSetupSecretText(result.stdout) || containsSetupSecretText(result.stderr))
    throw new Error("The installed CLI emitted private material; output was suppressed.");
  // Child diagnostics may contain arbitrary application data. Never copy them to logs.

  let evidence;
  if (values.mode === "agent" && result.stdout) {
    const events = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const publicEvents = publicSetupEvidenceEvents(events);
    for (const event of publicEvents) process.stdout.write(`${JSON.stringify(event)}\n`);
    const terminalOutcome = events.at(-1)?.outcome;
    evidence = {
      format: 2,
      purpose: "diagnostic-only",
      independentlyVerifiedApplication: false,
      accepted: false,
      recordedAt: new Date().toISOString(),
      archiveSha256: createHash("sha256")
        .update(await readFile(archive))
        .digest("hex"),
      origin: new URL(values.origin).origin,
      command: values.command,
      language: values.language ?? null,
      exitCode: result.status,
      events: publicEvents.map((event) => event.event),
      cliReportedReceiptVerified: events.some(
        (event) =>
          event.event === "receipt.verified" &&
          event.contractVersion === 2 &&
          event.source === "repository-http-boundary",
      ),
      terminalOutcome: ["ready", "action_required", "unchanged"].includes(terminalOutcome)
        ? terminalOutcome
        : null,
    };
  } else {
    process.stdout.write(`Installed Terminal CLI exited with status ${result.status ?? 1}.\n`);
  }
  if (values.evidence && evidence) {
    if (containsSetupSecretText(JSON.stringify(evidence)))
      throw new Error("Private material was refused in runner evidence.");
    const evidencePath = resolve(values.evidence);
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  }
  if (result.error) throw new Error("The installed CLI did not finish within the runner deadline.");
  // This diagnostic has no independent original-handler span observation or
  // server-side receipt check. A v2 application claim, ready outcome, or even a
  // real but unrelated probe receipt must never authorize acceptance. Fern's
  // hosted harness owns that gate; do not add an event-based success shortcut.
  process.stderr.write(
    "Diagnostic only: original-handler span binding and stored application evidence were not independently verified; acceptance remains unverified.\n",
  );
  process.exitCode = result.status || 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main().catch(() => {
    // Do not expose a child exception, parser payload, filesystem path or capability.
    process.stderr.write("Setup diagnostic runner failed; private child output was suppressed.\n");
    process.exitCode = 1;
  });
