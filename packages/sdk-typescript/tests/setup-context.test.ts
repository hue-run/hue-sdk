import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configureSetupProject } from "../src/setup/configure.js";
import { detectSetupProject } from "../src/setup/detect.js";
import { FileSetupInstallationStore } from "../src/setup/installation.js";
import {
  setupContextScenarios,
  setupContextCheckSource,
} from "../scripts/setup-context-checks.mjs";

const fixtures: string[] = [];
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function generateHelper() {
  const root = await mkdtemp(join(tmpdir(), "hue-generated-context-"));
  fixtures.push(root);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ type: "module", dependencies: { express: "5.1.0" } }),
  );
  const store = new FileSetupInstallationStore(root, "http://127.0.0.1:1");
  const record = await store.loadOrCreate();
  record.credential = {
    apiKey: `hue_setup_test_setup-${"a".repeat(24)}_${"s".repeat(43)}`,
    keyId: `setup-${"a".repeat(24)}`,
    version: 0,
    kind: "anonymous_trial",
    capabilities: ["setup_telemetry_write"],
  };
  await store.save(record);
  await configureSetupProject(store, record, await detectSetupProject(root));
  await mkdir(join(root, "node_modules", "@hue-run"), { recursive: true });
  await symlink(packageRoot, join(root, "node_modules", "@hue-run", "sdk"), "dir");
  await symlink(
    join(packageRoot, "node_modules", "@opentelemetry"),
    join(root, "node_modules", "@opentelemetry"),
    "dir",
  );
  return root;
}

// Shared subprocess checks also run against generated helpers from the installed archive.

for (const runtime of ["node", process.execPath]) {
  for (const scenario of setupContextScenarios) {
    test(`generated setup context ${scenario} under ${runtime === "node" ? "Node" : "Bun"}`, async () => {
      const root = await generateHelper();
      const script = setupContextCheckSource(scenario);
      await writeFile(join(root, "check.mjs"), script);
      const result = spawnSync(runtime, ["check.mjs"], {
        cwd: root,
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 8192,
        env: { ...process.env, NODE_OPTIONS: "", BUN_OPTIONS: "" },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("passed\n");
      expect(result.stderr).toBe("");
    }, 15000);
  }
}
