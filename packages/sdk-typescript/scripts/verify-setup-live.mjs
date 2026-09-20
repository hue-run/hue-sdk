#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

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

const archive = resolve(values.archive);
const project = resolve(values.project);
await mkdir(project, { recursive: true, mode: 0o700 });
if (values.language) {
  const entries = await readdir(project);
  if (entries.length !== 0)
    throw new Error("--language prepares only an empty project directory; omit it when resuming");
  if (values.language === "typescript")
    await writeFile(
      `${project}/package.json`,
      `${JSON.stringify({ private: true, devDependencies: { typescript: "7.0.2" } }, null, 2)}\n`,
    );
  else await writeFile(`${project}/pyproject.toml`, '[project]\nname = "hue-setup-acceptance"\n');
}

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
  { cwd: harness, stdio: "inherit", timeout: 120_000 },
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
const containsClaimCapability = (value) =>
  /\/setup\/claim#[A-Za-z0-9_-]+/u.test(value) || /#[A-Za-z0-9_-]{43}(?:\b|$)/u.test(value);
if (containsClaimCapability(result.stdout ?? "") || containsClaimCapability(result.stderr ?? ""))
  throw new Error("The installed CLI emitted a private claim capability; output was suppressed.");
if (result.stderr) process.stderr.write(result.stderr);

let evidence;
if (values.mode === "agent" && result.stdout) {
  const events = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  for (const event of events) {
    const safe = structuredClone(event);
    if (safe.project) delete safe.project.root;
    if (safe.event === "receipt.verified") {
      delete safe.receiptId;
      delete safe.traceId;
    }
    process.stdout.write(`${JSON.stringify(safe)}\n`);
  }
  evidence = {
    format: 1,
    recordedAt: new Date().toISOString(),
    archiveSha256: createHash("sha256")
      .update(await readFile(archive))
      .digest("hex"),
    origin: new URL(values.origin).origin,
    command: values.command,
    language: values.language ?? null,
    exitCode: result.status,
    events: events.map((event) => event.event),
    receiptVerified: events.some((event) => event.event === "receipt.verified"),
    terminalOutcome: events.at(-1)?.outcome ?? null,
  };
} else {
  process.stdout.write(result.stdout);
}
if (values.evidence && evidence) {
  const evidencePath = resolve(values.evidence);
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
