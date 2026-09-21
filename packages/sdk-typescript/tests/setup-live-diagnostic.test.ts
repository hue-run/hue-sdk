import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const runner = fileURLToPath(new URL("../scripts/verify-setup-live.mjs", import.meta.url));
const envelope = {
  contractVersion: 2,
  runId: "setup_diagnostic_test",
  sequence: 1,
  timestamp: "2026-09-20T12:00:00.000Z",
};
const ready = { ...envelope, event: "run.completed", outcome: "ready", checkpointed: true };
const unrelatedReceipt = {
  ...envelope,
  event: "receipt.verified",
  receiptId: "11111111-1111-4111-8111-111111111111",
  traceId: "b".repeat(32),
  source: "repository-http-boundary",
};

/** Execute the actual runner, substituting only npm/CLI child I/O. No network is used. */
async function runDiagnostic(events: readonly unknown[], mode = "agent") {
  const root = await mkdtemp(join(tmpdir(), "hue-manual-diagnostic-"));
  roots.push(root);
  const bin = join(root, "bin");
  const project = join(root, "application");
  await mkdir(bin);
  await mkdir(project);
  const output = join(root, "cli-output.json");
  const handler = join(project, "original-handler.json");
  const archive = join(root, "synthetic-test-archive.tgz");
  const evidence = join(root, "diagnostic.json");
  await writeFile(output, JSON.stringify(events));
  await writeFile(archive, "synthetic test fixture, not a release archive\n");
  const childSource = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
// Deliberately independent IDs: a handler count of one cannot bind a separate probe.
writeFileSync(process.env.HUE_DIAGNOSTIC_TEST_HANDLER, JSON.stringify({
  count: 1, traceId: "a".repeat(32), spanId: "c".repeat(16), kind: "SERVER"
}));
for (const event of JSON.parse(readFileSync(process.env.HUE_DIAGNOSTIC_TEST_OUTPUT, "utf8")))
  process.stdout.write(JSON.stringify(event) + "\\n");
`;
  const npm = join(bin, "npm");
  await writeFile(
    npm,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.mkdirSync("node_modules/.bin", { recursive: true });
fs.writeFileSync("node_modules/.bin/hue", ${JSON.stringify(childSource)}, { mode: 0o700 });
`,
  );
  await chmod(npm, 0o700);
  const result = spawnSync(
    "node",
    [
      runner,
      "--archive",
      archive,
      "--origin",
      "http://127.0.0.1:1",
      "--project",
      project,
      "--mode",
      mode,
      "--evidence",
      evidence,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        TMPDIR: root,
        HUE_DIAGNOSTIC_TEST_OUTPUT: output,
        HUE_DIAGNOSTIC_TEST_HANDLER: handler,
      },
    },
  );
  expect(result.error).toBeUndefined();
  return { result, evidence, handler };
}

test.each([
  {
    name: "v1 probe receipt plus ready",
    events: [
      { ...unrelatedReceipt, contractVersion: 1, source: undefined },
      { ...ready, contractVersion: 1 },
    ],
    exitCode: 1,
  },
  {
    name: "v2 explicitly probe-only receipt plus ready",
    events: [{ ...unrelatedReceipt, source: "setup-probe" }, ready],
    exitCode: 1,
  },
  { name: "ready without any receipt", events: [ready], exitCode: 2 },
  {
    name: "successful action-required pause",
    events: [{ ...ready, outcome: "action_required" }],
    exitCode: 2,
  },
  {
    name: "separate valid-looking receipt while original handler ran once",
    events: [unrelatedReceipt, ready],
    exitCode: 2,
  },
])("actual manual runner cannot accept $name", async ({ events, exitCode }) => {
  const { result, evidence, handler } = await runDiagnostic(events);
  expect(result.status).toBe(exitCode);
  const observed = JSON.parse(await readFile(handler, "utf8"));
  expect(observed.count).toBe(1);
  expect(observed.traceId === unrelatedReceipt.traceId).toBe(false);
  if (exitCode === 2) {
    const diagnostic = JSON.parse(await readFile(evidence, "utf8"));
    expect(diagnostic.purpose).toBe("diagnostic-only");
    expect(diagnostic.independentlyVerifiedApplication).toBe(false);
    expect(diagnostic.accepted).toBe(false);
    expect(result.stderr).toContain("acceptance remains unverified");
  }
});

test("Terminal diagnostic cannot report acceptance even when its child exits zero", async () => {
  const { result } = await runDiagnostic([unrelatedReceipt, ready], "human");
  expect(result.status).toBe(2);
  expect(result.stdout).toContain("Installed Terminal CLI exited with status 0");
  expect(result.stderr).toContain("acceptance remains unverified");
});
