import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { FileSetupInstallationStore } from "../src/setup/installation.js";

const origin = "https://example.test";
function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) throw new Error("Synthetic Git fixture command failed");
  return result.stdout;
}
async function fixture(inGit = true) {
  const root = await mkdtemp(join(tmpdir(), "hue-private-git-"));
  if (inGit) git(root, ["init", "--quiet"]);
  return { root, store: new FileSetupInstallationStore(root, origin) };
}

test("actual Git ignores every private file and atomic/application temporary pattern", async () => {
  const { root, store } = await fixture();
  const record = await store.loadOrCreate();
  await store.save(record);
  const privateNames = [store.path, store.claimHandoffPath, store.applicationEvidencePath].map(
    (path) => basename(path),
  );
  for (const name of [
    ...privateNames,
    ...privateNames.map((name) => `.${name}.unique.tmp`),
    `${basename(store.applicationEvidencePath)}.123.tmp`,
  ]) {
    git(root, ["check-ignore", "--quiet", "--", `.hue/${name}`]);
  }
  expect(git(root, ["ls-files", "--cached", "--", ".hue"])).toBe("");
});

test("deeper and selective ignore negations fail before creating any installation proof", async () => {
  for (const inGit of [true, false]) {
    for (const negation of ["!installation-*.json", "!application-evidence-*.json.123.tmp"]) {
      const { root, store } = await fixture(inGit);
      await mkdir(store.directory, { mode: 0o700 });
      const source = `installation-*.json\n${negation}\n`;
      await writeFile(join(store.directory, ".gitignore"), source);
      await expect(store.loadOrCreate()).rejects.toThrow("conflicting Git ignore rules");
      expect(await readdir(store.directory)).toEqual([".gitignore"]);
      expect(await readFile(join(store.directory, ".gitignore"), "utf8")).toBe(source);
      expect((await readdir(root)).includes(".gitignore")).toBe(false);
    }
  }
});

test("tracked private placeholders are refused without overwriting or reading their contents", async () => {
  for (const name of [
    "installation-test.json",
    "claim-handoff-test.html",
    "application-evidence-test.json",
  ]) {
    const { root, store } = await fixture();
    await mkdir(store.directory, { mode: 0o700 });
    await writeFile(join(store.directory, name), "non-secret placeholder", { mode: 0o600 });
    git(root, ["add", "--", `.hue/${name}`]);
    await expect(store.loadOrCreate()).rejects.toThrow("tracked setup private files");
    expect(await readdir(store.directory)).toEqual([name]);
    expect(await readFile(join(store.directory, name), "utf8")).toBe("non-secret placeholder");
  }
});

test("later ignore edits refuse load, save and handoff without changing persisted state", async () => {
  const { store } = await fixture();
  const record = await store.loadOrCreate();
  const original = await readFile(store.path, "utf8");
  const ignorePath = join(store.directory, ".gitignore");
  const ignore = (await readFile(ignorePath, "utf8")) + "!installation-*.json\n";
  await writeFile(ignorePath, ignore);
  await expect(store.load()).rejects.toThrow("conflicting Git ignore rules");
  await expect(store.save(record)).rejects.toThrow("conflicting Git ignore rules");
  await expect(store.saveClaimHandoff(`${origin}/setup/claim#${"a".repeat(43)}`)).rejects.toThrow(
    "conflicting Git ignore rules",
  );
  expect((await readFile(store.path, "utf8")) === original).toBe(true);
  expect(await readFile(ignorePath, "utf8")).toBe(ignore);
});

test("inherited Git directory and index overrides cannot hide tracked private paths", async () => {
  const { root, store } = await fixture();
  const other = await fixture();
  await mkdir(store.directory, { mode: 0o700 });
  await writeFile(join(store.directory, "installation-test.json"), "non-secret placeholder");
  git(root, ["add", "--", ".hue/installation-test.json"]);
  const names = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] as const;
  const previous = names.map((name) => process.env[name]);
  try {
    process.env.GIT_DIR = join(other.root, ".git");
    process.env.GIT_WORK_TREE = other.root;
    process.env.GIT_INDEX_FILE = join(other.root, ".git", "index");
    await expect(store.loadOrCreate()).rejects.toThrow("tracked setup private files");
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});

test("standalone projects retain ignore protection and malformed records expose no parser excerpt", async () => {
  const { store } = await fixture(false);
  await store.loadOrCreate();
  const canary = `hue_install_${"s".repeat(43)}`;
  await writeFile(store.path, `${canary}{invalid`, { mode: 0o600 });
  let failure: unknown;
  try {
    await store.load();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toBe("Error: Invalid setup installation record");
  expect((failure as Error).cause).toBeUndefined();
  expect(String(failure).includes(canary)).toBe(false);
});
