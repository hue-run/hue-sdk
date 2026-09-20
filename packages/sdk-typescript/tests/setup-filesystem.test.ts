import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, renameSync, watch, writeFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureSetupProject, validateSetupConfiguration } from "../src/setup/configure.js";
import { FileSetupCheckpointAdapter, setupRunId } from "../src/setup/checkpoint.js";
import {
  FileSetupInstallationStore,
  setupManagedDigest,
  type SetupInstallationRecord,
} from "../src/setup/installation.js";
import type { SetupProjectDetection } from "../src/setup/types.js";

const roots: string[] = [];
async function temporaryRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hue-safe-path-test-")));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function project(root: string): SetupProjectDetection {
  return {
    root,
    fingerprint: "a".repeat(64),
    languages: ["typescript"],
    packageManagers: ["npm"],
    frameworks: ["express"],
    hue: "absent",
    openTelemetry: "absent",
  };
}
function configuration(root: string) {
  const store = new FileSetupInstallationStore(root, "https://example.invalid");
  // This suite exercises real managed-file boundaries without creating installation secrets.
  store.save = async () => {};
  const record = { managedFiles: {} } as SetupInstallationRecord;
  return { store, record };
}

describe("setup configuration filesystem boundaries", () => {
  test("refuses a symlink ancestor before reading or writing a managed configuration", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "actual"));
    await mkdir(join(root, "actual", "project"));
    await symlink(join(root, "actual"), join(root, "alias"));
    const unsafe = join(root, "alias", "project");
    const { store, record } = configuration(unsafe);
    await expect(validateSetupConfiguration(store, record, project(unsafe))).rejects.toThrow(
      "symlink ancestor",
    );
    expect(
      await lstat(join(root, "actual", "project", "hue.setup.mjs")).catch(() => undefined),
    ).toBeUndefined();
  });

  test("refuses managed-file symlinks without changing their target", async () => {
    const root = await temporaryRoot();
    const target = join(root, "user-config");
    await writeFile(target, "keep my config");
    await symlink(target, join(root, "hue.setup.mjs"));
    const { store, record } = configuration(root);
    await expect(configureSetupProject(store, record, project(root))).rejects.toThrow("Refusing");
    expect(await readFile(target, "utf8")).toBe("keep my config");
  });

  test("preserves an existing managed file's owner and executable mode bits", async () => {
    const root = await temporaryRoot();
    const path = join(root, "hue.setup.mjs");
    const previous = "// earlier managed configuration\n";
    await writeFile(path, previous);
    await chmod(path, 0o750);
    const { store, record } = configuration(root);
    record.managedFiles["hue.setup.mjs"] = setupManagedDigest(previous);
    const changes = await configureSetupProject(store, record, project(root));
    expect(changes).toEqual([{ path: "hue.setup.mjs", change: "updated" }]);
    expect((await lstat(path)).mode & 0o777).toBe(0o750);
  });

  for (const change of ["contents", "mode", "inode", "created"] as const) {
    test(`refuses a concurrent ${change} change without overwriting it`, async () => {
      const root = await temporaryRoot();
      const path = join(root, "hue.setup.mjs");
      const previous = "// earlier managed configuration\n";
      const { store, record } = configuration(root);
      if (change !== "created") {
        await writeFile(path, previous);
        record.managedFiles["hue.setup.mjs"] = setupManagedDigest(previous);
      }
      let changed = false;
      const watcher = watch(root, (_event, name) => {
        if (!changed && name?.toString().startsWith(".hue.setup.mjs.")) {
          changed = true;
          if (change === "mode") chmodSync(path, 0o600);
          else if (change === "inode") {
            const replacement = join(root, "concurrent-replacement");
            writeFileSync(replacement, previous);
            renameSync(replacement, path);
          } else writeFileSync(path, "// concurrent user content\n");
        }
      });
      try {
        await expect(configureSetupProject(store, record, project(root))).rejects.toThrow();
      } finally {
        watcher.close();
      }
      expect(changed).toBe(true);
      expect(await readFile(path, "utf8")).toBe(
        change === "mode" || change === "inode" ? previous : "// concurrent user content\n",
      );
      if (change === "mode") expect((await lstat(path)).mode & 0o777).toBe(0o600);
    });
  }
});

describe("setup checkpoint filesystem boundaries", () => {
  test("an outside lexical path cannot hide its checkpoint inside the repository", async () => {
    const root = await temporaryRoot();
    const repository = join(root, "repository");
    await mkdir(repository);
    await symlink(repository, join(root, "outside-alias"));
    const adapter = new FileSetupCheckpointAdapter(join(root, "outside-alias", "state"));
    await expect(adapter.load(setupRunId(repository), repository)).rejects.toThrow("symlinks");
    expect(await lstat(join(repository, "state")).catch(() => undefined)).toBeUndefined();
  });

  test("creates a real private external directory and saves a strict secret-free checkpoint", async () => {
    const root = await temporaryRoot();
    const repository = join(root, "repository");
    await mkdir(repository);
    const directory = join(root, "external", "state");
    const adapter = new FileSetupCheckpointAdapter(directory);
    const state = {
      format: 1 as const,
      phase: "created" as const,
      runId: setupRunId(repository),
      projectRoot: repository,
    };
    await adapter.save(state);
    expect(await adapter.load(state.runId, repository)).toEqual(state);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(directory, `${state.runId}.json`))).mode & 0o777).toBe(0o600);
    await expect(
      adapter.save({ ...state, unexpected: "private-extra" } as typeof state),
    ).rejects.toThrow("Invalid setup checkpoint state");
    expect(
      (await readFile(join(directory, `${state.runId}.json`), "utf8")).includes("private-extra"),
    ).toBe(false);
  });
});
