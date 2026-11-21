import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileSetupInstallationStore } from "../src/setup/installation.js";

const origin = "https://example.test";
const here = dirname(fileURLToPath(import.meta.url));
const storeModule = new URL("../src/setup/installation.ts", import.meta.url).href;
const swapSource = join(here, "fixtures/swap-hue-directory.c");

const placeholderCredential = {
  apiKey: `hue_setup_test_setup-${"1".repeat(24)}_${"s".repeat(43)}`,
  keyId: `setup-${"1".repeat(24)}`,
  version: 0 as const,
  kind: "anonymous_trial" as const,
  capabilities: ["setup_telemetry_write"] as ["setup_telemetry_write"],
};

function gitInit(root: string): void {
  const result = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error("Synthetic Git fixture command failed");
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hue-install-race-"));
  gitInit(root);
  return root;
}

function compileSwap(directory: string): string {
  const library = join(directory, "swap-hue-directory.so");
  const result = spawnSync("gcc", ["-shared", "-fPIC", "-o", library, swapSource, "-ldl"], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error("Could not compile the directory-swap helper");
  return library;
}

async function hookDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hue-install-hook-"));
  await writeFile(
    join(directory, "hook.mjs"),
    `export async function resolve(specifier, context, next) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
    try {
      return await next(specifier.slice(0, -3) + ".ts", context);
    } catch {
      return next(specifier, context);
    }
  }
  return next(specifier, context);
}
`,
  );
  await writeFile(
    join(directory, "register.mjs"),
    `import { register } from "node:module";
import { pathToFileURL } from "node:url";
register("./hook.mjs", pathToFileURL(${JSON.stringify(directory + "/")}));
`,
  );
  await writeFile(
    join(directory, "child.ts"),
    `const { FileSetupInstallationStore } = await import(process.env.HUE_STORE_MODULE);
const store = new FileSetupInstallationStore(process.env.HUE_PROJECT, ${JSON.stringify(origin)});
const credential = ${JSON.stringify(placeholderCredential)};
const handoff = ${JSON.stringify(`${origin}/setup/claim#${"a".repeat(43)}`)};
try {
  if (process.env.HUE_RACE_OP === "create") await store.loadOrCreate();
  if (process.env.HUE_RACE_OP === "save") {
    const record = await store.load();
    if (!record) throw new Error("missing installation record");
    await store.save({ ...record, credential });
  }
  if (process.env.HUE_RACE_OP === "handoff") await store.saveClaimHandoff(handoff);
} catch {
  // The store may reject the swapped directory after the write. The parent checks the files.
}
`,
  );
  return directory;
}

function runChild(
  op: "create" | "save" | "handoff",
  root: string,
  attacker: string,
  marker: string,
  library: string,
  hooks: string,
): void {
  const result = spawnSync(
    "node",
    [
      "--experimental-strip-types",
      "--import",
      join(hooks, "register.mjs"),
      join(hooks, "child.ts"),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        LD_PRELOAD: library,
        HUE_ATTACKER_DIR: attacker,
        HUE_LEAK_MARKER: marker,
        HUE_PROJECT: root,
        HUE_RACE_OP: op,
        HUE_STORE_MODULE: storeModule,
      },
    },
  );
  if (result.status !== 0) throw new Error("Installation race child exited nonzero");
}

async function attackerDir(): Promise<{
  attacker: string;
  marker: string;
  library: string;
  hooks: string;
}> {
  const attacker = await mkdtemp(join(tmpdir(), "hue-install-attacker-"));
  const build = await mkdtemp(join(tmpdir(), "hue-install-swap-"));
  const library = compileSwap(build);
  const hooks = await hookDir();
  return {
    attacker,
    marker: join(build, "leak-marker"),
    library,
    hooks,
  };
}

test("refuses an installation directory that is already a link before writing a record", async () => {
  const root = await project();
  const attacker = await mkdtemp(join(tmpdir(), "hue-install-attacker-"));
  await symlink(attacker, join(root, ".hue"));
  const store = new FileSetupInstallationStore(root, origin);
  await expect(store.loadOrCreate()).rejects.toThrow("symlink");
  expect(await readdir(attacker)).toEqual([]);
});

test("does not write a new installation record through a directory replaced at create", async () => {
  const root = await project();
  const { attacker, marker, library, hooks } = await attackerDir();
  runChild("create", root, attacker, marker, library, hooks);
  expect(await readdir(attacker)).toEqual([]);
  expect(existsSync(marker)).toBe(false);
});

test("does not write a saved installation record through a directory replaced at the write", async () => {
  const root = await project();
  const { attacker, marker, library, hooks } = await attackerDir();
  const prepared = new FileSetupInstallationStore(root, origin);
  await prepared.loadOrCreate();
  runChild("save", root, attacker, marker, library, hooks);
  expect(await readdir(attacker)).toEqual([]);
  expect(existsSync(marker)).toBe(false);
});

test("does not write a claim handoff through a directory replaced at the write", async () => {
  const root = await project();
  const { attacker, marker, library, hooks } = await attackerDir();
  const prepared = new FileSetupInstallationStore(root, origin);
  await prepared.loadOrCreate();
  runChild("handoff", root, attacker, marker, library, hooks);
  expect(await readdir(attacker)).toEqual([]);
  expect(existsSync(marker)).toBe(false);
});
