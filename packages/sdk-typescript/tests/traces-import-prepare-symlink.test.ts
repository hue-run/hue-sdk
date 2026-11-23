import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { runTracesCommand } from "../src/cli/traces-import.js";
import { MAX_INLINE_VALUE_BYTES } from "../src/cli/traces-import-convert.js";
import { PrepareError, prepareTraceBundle } from "../src/cli/traces-import-prepare.js";
import { Progress } from "../src/cli/traces-import-upload.js";

// Symlinked import output. The race child is the same prepare and progress
// writers, loaded by Node from the TypeScript sources. The preload swaps the
// path inside open64, which is the call writeFile makes, so a lookup of that
// path before the open does not make the write safe.

const MARKER = "hue-prepare-symlink-marker";
const SENTINEL = Buffer.from("hue-prepare-symlink-sentinel\n");
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hue-prepare-symlink-"));
  directories.push(directory);
  return directory;
}

function traceExport(prompt: string): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "chatbot" } }],
        },
        scopeSpans: [
          {
            scope: { name: "synthetic", version: "1" },
            spans: [
              {
                traceId: "0af7651916cd43dd8448eb211c80319c",
                spanId: "b7ad6b7169203331",
                name: "chat",
                kind: 1,
                startTimeUnixNano: "1760000000000000000",
                endTimeUnixNano: "1760000002000000000",
                attributes: [{ key: "gen_ai.prompt", value: { stringValue: prompt } }],
                status: { code: 0 },
              },
            ],
          },
        ],
      },
    ],
  });
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  const names = (await readdir(directory)).sort();
  const out: Record<string, string> = {};
  for (const name of names) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) out[name] = `symlink:${await readlink(path)}`;
    else out[name] = (await readFile(path)).toString("base64");
  }
  return out;
}

function containsMarker(files: Record<string, string>): boolean {
  for (const [name, encoded] of Object.entries(files)) {
    if (encoded.startsWith("symlink:")) continue;
    const bytes = Buffer.from(encoded, "base64");
    const text = name.endsWith(".gz") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
    if (text.includes(MARKER) || bytes.includes(Buffer.from(MARKER))) return true;
  }
  return false;
}

async function refuseSymlink(prepare: () => Promise<unknown>, output: string, target: string) {
  const before = await snapshot(target);
  let thrown: unknown;
  try {
    await prepare();
  } catch (error) {
    thrown = error;
  }
  const after = await snapshot(target);
  expect(after).toEqual(before);
  expect(containsMarker(after)).toBe(false);
  expect((await lstat(output)).isSymbolicLink()).toBe(true);
  expect(thrown).toBeInstanceOf(PrepareError);
}

describe("hue traces import prepare output symlinks", () => {
  test("does not follow a symlink planted at the default output path", async () => {
    const root = await scratch();
    const input = join(root, "traces.json");
    const output = `${input}.hue-import`;
    const target = join(root, "attacker");
    await writeFile(input, traceExport(MARKER));
    await mkdir(target, { mode: 0o700 });
    await symlink(target, output);
    const stderr: string[] = [];
    const sink = () =>
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
    const stderrStream = new Writable({
      write(chunk, _encoding, callback) {
        stderr.push(String(chunk));
        callback();
      },
    });
    let code = 0;
    try {
      code = await runTracesCommand(["import", "prepare", input], {
        cwd: root,
        stdout: sink(),
        stderr: stderrStream,
      });
    } finally {
      expect(await snapshot(target)).toEqual({});
      expect((await lstat(output)).isSymbolicLink()).toBe(true);
      expect(stderr.join("")).not.toContain(MARKER);
      expect(code).toBe(1);
    }
  });

  test("does not write batches, large values, or the manifest through an output symlink", async () => {
    const root = await scratch();
    const input = join(root, "traces.json");
    const output = join(root, "out");
    const target = join(root, "attacker");
    const prompt = MARKER + "x".repeat(MAX_INLINE_VALUE_BYTES);
    await writeFile(input, traceExport(prompt));
    await mkdir(target, { mode: 0o700 });
    await symlink(target, output);
    await refuseSymlink(() => prepareTraceBundle(input, { out: output }), output, target);
  });

  test("does not replace or write through a symlink whose target holds only bundle names", async () => {
    const root = await scratch();
    const input = join(root, "traces.json");
    const output = join(root, "out");
    const target = join(root, "attacker");
    const victim = join(root, "victim");
    await writeFile(input, traceExport(MARKER));
    await mkdir(target, { mode: 0o700 });
    await writeFile(victim, SENTINEL);
    await writeFile(join(target, "manifest.json"), "keep-manifest");
    await writeFile(
      join(
        target,
        "0af7651916cd43dd8448eb211c80319c.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json.gz",
      ),
      "keep-batch",
    );
    await writeFile(
      join(target, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.blob"),
      "keep-blob",
    );
    await symlink(victim, join(target, "manifest.json.tmp"));
    await symlink(target, output);
    const before = await snapshot(target);
    await refuseSymlink(() => prepareTraceBundle(input, { out: output }), output, target);
    expect(await snapshot(target)).toEqual(before);
    expect(await readFile(victim)).toEqual(SENTINEL);
  });

  test("does not follow an output directory swapped for a symlink after the directory check", async () => {
    const root = await scratch();
    const output = join(root, "out");
    const target = join(root, "attacker");
    await mkdir(target, { mode: 0o700 });
    await runRace("directory", root, output, target);
    expect(await snapshot(target)).toEqual({});
    expect(containsMarker(await snapshot(target))).toBe(false);
  });

  test("does not truncate a file when the temporary name is a symlink at the open", async () => {
    const root = await scratch();
    const output = join(root, "out");
    const victim = join(root, "victim");
    await writeFile(victim, SENTINEL);
    await runRace("tmp", root, output, victim);
    expect(await readFile(victim)).toEqual(SENTINEL);
  });

  test("does not write upload progress through a symlinked bundle directory", async () => {
    const root = await scratch();
    const output = join(root, "out");
    const target = join(root, "attacker");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, output);
    const before = await snapshot(target);
    const progress = new Progress(
      join(output, "progress.json"),
      {
        version: 1,
        manifest_digest: MARKER,
        import_url: "http://127.0.0.1/api/v1/trace-imports/00000000-0000-4000-8000-000000000001",
        traces: {},
      },
      0,
    );
    await progress.changed();
    expect(await snapshot(target)).toEqual(before);
    expect(containsMarker(await snapshot(target))).toBe(false);
    expect((await lstat(output)).isSymbolicLink()).toBe(true);
  });

  test("does not truncate a file when progress.json.tmp is a symlink at the open", async () => {
    const root = await scratch();
    const output = join(root, "out");
    const victim = join(root, "victim");
    await writeFile(victim, SENTINEL);
    await runRace("progress-tmp", root, output, victim);
    expect(await readFile(victim)).toEqual(SENTINEL);
  });
});

const raceLibrary = join(import.meta.dir, "fixtures/prepare-output-race.c");
const raceRegister = join(import.meta.dir, "fixtures/register-ts.mjs");
const raceChild = join(import.meta.dir, "traces-import-prepare-symlink.child.ts");

function runCommand(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return new Promise((done, reject) => {
    child.on("close", (code) => {
      if (code === 0) done();
      else reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

async function runRace(mode: string, root: string, output: string, attack: string): Promise<void> {
  const library = join(root, "race.so");
  const loaded = join(root, "loaded");
  const result = join(root, "result.json");
  await runCommand("gcc", [
    "-shared",
    "-fPIC",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-o",
    library,
    raceLibrary,
    "-ldl",
  ]);
  const child = spawn(
    "node",
    ["--experimental-transform-types", "--import", raceRegister, raceChild],
    {
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        LD_PRELOAD: library,
        HUE_RACE_MODE: mode === "directory" ? "directory" : "tmp",
        HUE_RACE_ACTION: mode === "progress-tmp" ? "progress" : "prepare",
        HUE_RACE_ROOT: root,
        HUE_RACE_OUTPUT: output,
        HUE_RACE_ATTACK: attack,
        HUE_RACE_MARKER: MARKER,
        HUE_RACE_LOADED: loaded,
        HUE_RACE_RESULT: result,
      },
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise<number | null>((done) => child.on("close", done));
  expect({ code, stderr, result: await readFile(result, "utf8").catch(() => "") }).toMatchObject({
    code: 0,
  });
  await readFile(loaded);
}
