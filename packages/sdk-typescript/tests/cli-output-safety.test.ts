import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDirectOutputs, stageDirectCase } from "../src/cli/eval-direct.js";
import { spawnAgentCommand } from "../src/cli/eval.js";
import { ArtifactSizeError, CaseFileError, createEvaluationClient } from "../src/evals.js";
import { downloadCaseFiles, stageOutputFiles } from "../src/evals/files.js";

// The output collector is shared by direct cases and world cases (`hue eval --command`), so
// every vector here applies to both.

const secret = "host secret: never collected";
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** A case output directory next to a host directory holding a secret the agent must not reach. */
async function scene() {
  const root = await mkdtemp(join(tmpdir(), "hue-output-safety-"));
  const host = join(root, "host");
  await mkdir(host);
  await writeFile(join(host, "secret.txt"), secret);
  await writeFile(join(host, "summary.txt"), secret);
  await writeFile(join(host, "result.json"), JSON.stringify({ secret }));
  const output = join(root, "case", "output");
  await mkdir(output, { recursive: true, mode: 0o700 });
  return { root, host, output };
}

/** Whether the process can still run; a killed process nobody has reaped yet is a zombie. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const status = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = status.slice(status.lastIndexOf(")") + 2).charAt(0);
    return state !== "Z" && state !== "X";
  } catch {
    return !existsSync("/proc/self/stat");
  }
}

const mkfifo = (path: string) => {
  const result = spawnSync("mkfifo", [path]);
  if (result.status !== 0) throw new Error("mkfifo is required for this test");
};

describe("output collection never follows the agent's links", () => {
  test("a helper that is a symlink to a host file is refused, not read", async () => {
    for (const helper of ["summary.txt", "result.json", "manifest.json"]) {
      const { host, output } = await scene();
      await writeFile(join(output, "Letter.txt"), "letter");
      await symlink(
        join(host, helper === "manifest.json" ? "result.json" : helper),
        join(output, helper),
      );
      const outcome = collectDirectOutputs(output, "stdout answer");
      await expect(outcome).rejects.toThrow(`output/${helper} is not a regular file`);
    }
  });

  test("an output directory replaced by a symlink to a host directory is refused", async () => {
    const { host, output } = await scene();
    await rm(output, { recursive: true });
    await symlink(host, output);
    await expect(collectDirectOutputs(output)).rejects.toThrow(
      "The output directory is not a directory",
    );
  });

  test("an output directory replaced by a file is refused", async () => {
    const { output } = await scene();
    await rm(output, { recursive: true });
    await writeFile(output, "not a directory");
    await expect(collectDirectOutputs(output)).rejects.toThrow("is not a directory");
  });

  test("a symlink among the documents is skipped and its target never read", async () => {
    const { host, output } = await scene();
    await writeFile(join(output, "Letter.txt"), "letter");
    await symlink(join(host, "secret.txt"), join(output, "secret.txt"));
    const result = await collectDirectOutputs(output);
    expect(result.files.map((file) => file.filename)).toEqual(["Letter.txt"]);
    expect(Buffer.from(result.files[0]!.bytes!).toString()).toBe("letter");
  });

  test("a document swapped for a symlink after the listing is refused", async () => {
    const { host, output } = await scene();
    await writeFile(join(output, "a.txt"), "the agent's own text");
    const outcome = collectDirectOutputs(output, undefined, async () => {
      await rm(join(output, "a.txt"));
      await symlink(join(host, "secret.txt"), join(output, "a.txt"));
    });
    await expect(outcome).rejects.toThrow("Generated file a.txt is a symbolic link");
  });

  test("a document replaced by another file after the listing is refused", async () => {
    const { host, output } = await scene();
    await writeFile(join(output, "a.txt"), "the agent's own text");
    const outcome = collectDirectOutputs(output, undefined, async () => {
      // A hard link or rename puts different bytes under the listed name.
      await writeFile(join(output, "b.tmp"), readFileSync(join(host, "secret.txt")));
      await rename(join(output, "b.tmp"), join(output, "a.txt"));
    });
    await expect(outcome).rejects.toThrow("Generated file a.txt changed while it was collected");
  });

  test("a subdirectory swapped for a symlink after the listing is refused", async () => {
    const { host, output } = await scene();
    await mkdir(join(output, "anexos"));
    await writeFile(join(output, "anexos", "secret.txt"), "the agent's own text");
    const outcome = collectDirectOutputs(output, undefined, async () => {
      await rm(join(output, "anexos"), { recursive: true });
      await symlink(host, join(output, "anexos"));
    });
    await expect(outcome).rejects.toThrow(/changed while it was collected|is a symbolic link/);
  });

  test("a FIFO named like a helper is refused at once instead of hanging", async () => {
    const { output } = await scene();
    mkfifo(join(output, "summary.txt"));
    const started = performance.now();
    await expect(collectDirectOutputs(output, "stdout answer")).rejects.toThrow(
      "output/summary.txt is not a regular file",
    );
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("a FIFO swapped in for a document after the listing is refused at once", async () => {
    const { output } = await scene();
    await writeFile(join(output, "a.txt"), "text");
    const started = performance.now();
    const outcome = collectDirectOutputs(output, undefined, async () => {
      await rm(join(output, "a.txt"));
      mkfifo(join(output, "a.txt"));
    });
    await expect(outcome).rejects.toThrow(/Generated file a.txt (is not a regular file|changed)/);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("an oversized document is refused from its size, before any byte is read", async () => {
    const { output } = await scene();
    // Sparse: 1.5 GiB on paper, nothing on disk. Reading it would take the memory it claims.
    await writeFile(join(output, "huge.pdf"), "");
    await truncate(join(output, "huge.pdf"), 1.5 * 1024 * 1024 * 1024);
    const before = process.memoryUsage().rss;
    await expect(collectDirectOutputs(output)).rejects.toThrow(
      "Generated file huge.pdf exceeds 25 MiB",
    );
    expect(process.memoryUsage().rss - before).toBeLessThan(256 * 1024 * 1024);
  });

  test("the listing stops past 32 documents and past 1024 entries", async () => {
    const many = await scene();
    for (let index = 0; index < 33; index++)
      await writeFile(join(many.output, `doc-${index}.txt`), "text");
    await expect(collectDirectOutputs(many.output)).rejects.toThrow(
      "The agent wrote more than 32 files",
    );
    // Skipped entries (lock files here) still cost a visit; hidden directories are never walked.
    const hidden = await scene();
    for (let index = 0; index < 1100; index++)
      await writeFile(join(hidden.output, `~$lock-${index}`), "");
    await expect(collectDirectOutputs(hidden.output)).rejects.toThrow(
      "The output directory holds more than 1024 entries",
    );
  });
});

describe("staging files", () => {
  test("inputs whose names differ only in case or normalization never overwrite each other", async () => {
    const { root } = await scene();
    const source = join(root, "input.pdf");
    await writeFile(source, "%PDF");
    const file = (filename: string) => ({
      artifactId: randomUUID(),
      role: "source" as const,
      filename,
      contentType: "application/pdf",
      byteSize: 4,
      sha256: sha256("%PDF"),
      path: source,
    });
    const layout = await stageDirectCase(join(root, "scratch"), {
      inputs: {},
      config: {},
      item: { id: "case", externalKey: "case" },
      executionId: "execution",
      files: [
        file("Informe.pdf"),
        file("informe.PDF"),
        file("Café.pdf"),
        file("Café.pdf"),
        file(`${"é".repeat(150)}.pdf`),
      ],
    });
    const names = layout.files.map((entry) => entry.filename);
    expect(names.slice(0, 4)).toEqual([
      "Informe.pdf",
      "informe (2).PDF",
      "Café.pdf",
      "Café (2).pdf",
    ]);
    // A name too long for the filesystem is cut to 200 bytes, between characters, and keeps its
    // extension so an agent still recognizes the PDF.
    expect(Buffer.byteLength(names[4]!)).toBeLessThanOrEqual(200);
    expect(names[4]!).toMatch(/^é+~[0-9a-f]{8}\.pdf$/u);
    expect(await readdir(join(layout.caseDirectory, "files", "source"))).toHaveLength(5);
  });

  test("a declared output path is read as a regular file and staged owner-only from its bytes", async () => {
    const { root, host } = await scene();
    const agentFile = join(root, "Letter.txt");
    await writeFile(agentFile, "letter", { mode: 0o664 });
    await chmod(agentFile, 0o664);
    const staged = await stageOutputFiles(
      [{ path: agentFile, filename: "Letter.txt", contentType: "text/plain" }],
      join(root, "outputs"),
    );
    expect((await stat(staged[0]!.path)).mode & 0o777).toBe(0o600);
    expect(readFileSync(staged[0]!.path, "utf8")).toBe("letter");
    const link = join(root, "link.txt");
    await symlink(join(host, "secret.txt"), link);
    await expect(
      stageOutputFiles(
        [{ path: link, filename: "link.txt", contentType: "text/plain" }],
        join(root, "outputs-2"),
      ),
    ).rejects.toThrow("Generated file link.txt is a symbolic link");
    const fifo = join(root, "fifo.txt");
    mkfifo(fifo);
    await expect(
      stageOutputFiles(
        [{ path: fifo, filename: "fifo.txt", contentType: "text/plain" }],
        join(root, "outputs-3"),
      ),
    ).rejects.toThrow("Generated file fifo.txt is not a regular file");
  });

  test("two long generated names stay two documents", async () => {
    const { root } = await scene();
    const staged = await stageOutputFiles(
      [196, 197, 198].map((length) => ({
        bytes: Buffer.from(`document ${length}`),
        filename: `${"x".repeat(length)}.pdf`,
        contentType: "application/pdf",
      })),
      join(root, "outputs"),
    );
    expect(new Set(staged.map((file) => file.filename)).size).toBe(3);
    for (const file of staged) expect(file.filename.endsWith(".pdf")).toBe(true);
  });

  test("a files directory another user could open is refused", async () => {
    const { root } = await scene();
    const shared = join(root, "shared");
    await mkdir(shared, { mode: 0o777 });
    await chmod(shared, 0o777);
    await expect(
      stageOutputFiles(
        [{ bytes: Buffer.from("x"), filename: "a.txt", contentType: "text/plain" }],
        shared,
      ),
    ).rejects.toThrow("Use a private files directory");
  });
});

describe("pinned downloads stop at the pinned size", () => {
  test("a body longer than the manifest's byteSize is a case_file_mismatch, read no further", async () => {
    let sent = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        // An endless body: the client must stop on its own.
        const stream = new ReadableStream({
          pull(controller) {
            sent += 64 * 1024;
            controller.enqueue(new Uint8Array(64 * 1024));
          },
        });
        return new Response(stream, { headers: { "content-type": "application/octet-stream" } });
      },
    });
    try {
      const client = createEvaluationClient({
        apiKey: "synthetic",
        baseUrl: `http://127.0.0.1:${server.port}`,
      });
      await expect(client.downloadArtifact(randomUUID(), { maxBytes: 10 })).rejects.toBeInstanceOf(
        ArtifactSizeError,
      );
      const root = await mkdtemp(join(tmpdir(), "hue-download-bound-"));
      const outcome = downloadCaseFiles(
        client,
        [
          {
            artifactId: randomUUID(),
            role: "source",
            filename: "Informe.pdf",
            contentType: "application/pdf",
            byteSize: 100,
            sha256: sha256("x"),
          },
        ],
        join(root, "inputs"),
      );
      await expect(outcome).rejects.toBeInstanceOf(CaseFileError);
      await expect(outcome).rejects.toMatchObject({ code: "case_file_mismatch" });
      expect(sent).toBeLessThan(25 * 1024 * 1024);
      expect(await readdir(join(root, "inputs"))).toEqual([]);
    } finally {
      server.stop(true);
    }
  });
});

describe("the agent command", () => {
  test("processes it leaves behind are stopped before its outputs are read", async () => {
    const root = await mkdtemp(join(tmpdir(), "hue-leftover-"));
    const marker = join(root, "swapped");
    const pidFile = join(root, "pid");
    // The command exits at once, leaving a child in its group that would swap a file later. The
    // script is fixed text; the paths reach it through the environment.
    const script = join(root, "agent.mjs");
    await writeFile(
      script,
      `import { spawn } from "node:child_process";
const child = spawn(
  process.execPath,
  ["-e", 'const fs = require("fs"); fs.writeFileSync(process.env.PID_FILE, String(process.pid)); setTimeout(() => fs.writeFileSync(process.env.MARKER, "late"), 1500)'],
  { stdio: "ignore" },
);
child.unref();
setTimeout(() => process.stdout.write("done"), 300);
`,
    );
    const answer = await spawnAgentCommand(`${process.execPath} ${script}`, {
      env: { ...process.env, PID_FILE: pidFile, MARKER: marker } as Record<string, string>,
      timeoutSeconds: 30,
    });
    expect(answer).toBe("done");
    expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(existsSync(marker)).toBe(false);
  }, 20_000);
});
