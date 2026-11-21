import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { parseHueOrigin, runLoginCommand } from "../src/cli/login.js";
import { runMcpCommand } from "../src/cli/mcp.js";

/**
 * `hue login` writes the pasted key into an env file, and `hue mcp install` tells the
 * operator to load that file with `.`. The key must not run as shell: a refusal leaves
 * the file untouched, and a stored key assigns that text when the file is sourced.
 */

const ATTACKER_ORIGIN = "https://attacker.example";
/** Clients whose `hue mcp install --auth key` steps include `set -a; . ./.env.hue; set +a`. */
const SOURCE_CLIENTS = ["claude-code", "codex", "cursor", "windsurf", "gemini"] as const;
const SHELL_ENV = { PATH: "/usr/bin:/bin" };

const roots: string[] = [];
let loopback: { origin: string; server: Server } | undefined;

function collector() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

function piped(line: string): PassThrough {
  const stream = new PassThrough();
  stream.end(`${line}\n`);
  return stream;
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hue-cli-login-shell-")));
  roots.push(root);
  return root;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

function listen(): Promise<{ origin: string; server: Server }> {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const url = request.url ?? "";
      if (url.startsWith("/api/v1/projects/current")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ name: "Synthetic" }));
        return;
      }
      if (url.startsWith("/api/v1/datasets")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      if (url.startsWith("/api/mcp")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("login test server has no port"));
        return;
      }
      resolve({ origin: `http://127.0.0.1:${address.port}`, server });
    });
  });
}

/** Sends the attacker's origin to the loopback server. The key is on stdin, not in the response. */
function forwardAttacker(loopbackOrigin: string): typeof fetch {
  const target = new URL(loopbackOrigin);
  return (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    if (url.origin !== ATTACKER_ORIGIN)
      return Promise.resolve(new Response("not the attacker origin", { status: 404 }));
    url.protocol = target.protocol;
    url.host = target.host;
    return fetch(url, init);
  };
}

function shell(cwd: string, script: string, args: string[] = []): string {
  const result = spawnSync("bash", ["-c", script, "bash", ...args], {
    cwd,
    env: SHELL_ENV,
    encoding: "utf8",
  });
  return result.stdout;
}

function assigned(cwd: string, file: string, names: string[]): string[] {
  const script = [
    "set -a",
    '. "$1"',
    "set +a",
    ...names.map((name) => `printf '%s\\n' "$${name}"`),
  ].join("\n");
  return shell(cwd, script, [file]).split("\n").slice(0, names.length);
}

async function sourceInstructions(cwd: string, clients: readonly string[]): Promise<string[]> {
  const lines: string[] = [];
  for (const client of clients) {
    const stdout = collector();
    const stderr = collector();
    const code = await runMcpCommand(
      ["install", "--client", client, "--auth", "key", "--url", `${ATTACKER_ORIGIN}/api/mcp`],
      { stdout: stdout.stream, stderr: stderr.stream, cwd, env: SHELL_ENV },
    );
    expect(code).toBe(0);
    for (const line of stdout.text().split("\n")) {
      const trimmed = line.trim();
      if (trimmed.includes("set -a") && trimmed.includes(".env.hue")) lines.push(trimmed);
    }
  }
  return lines;
}

type Keys = "evaluations" | "coding-agent" | "both";

function variables(keys: Keys): string[] {
  if (keys === "evaluations") return ["HUE_API_KEY"];
  if (keys === "coding-agent") return ["HUE_MCP_KEY"];
  return ["HUE_API_KEY", "HUE_MCP_KEY"];
}

function transportFailure(stderr: string): boolean {
  return [
    "Could not reach",
    "Hue rejected",
    "Hue answered",
    "unexpected",
    "hue login failed",
    "This key cannot",
    "The Hue MCP server",
  ].some((phrase) => stderr.includes(phrase));
}

async function assertKeyDoesNotRun(options: {
  key: string;
  keys?: Keys;
  args?: string[];
  existing?: string;
  file?: string;
  https?: boolean;
  clients?: readonly string[];
}): Promise<void> {
  if (!loopback) throw new Error("login test server is not listening");
  const keys = options.keys ?? "both";
  const fileName = options.file ?? ".env.hue";
  const root = await temporaryRoot();
  const marker = join(root, "marker");
  const key = options.key.replaceAll("{marker}", marker);
  expect(key).not.toMatch(/\s/u);
  const envPath = join(root, fileName);
  if (options.existing !== undefined) await writeFile(envPath, options.existing);
  const origin = options.https ? ATTACKER_ORIGIN : loopback.origin;
  const stdout = collector();
  const stderr = collector();
  const code = await runLoginCommand(
    ["--origin", origin, `--keys`, keys, ...(options.args ?? [])],
    {
      stdin: piped(key),
      stdout: stdout.stream,
      stderr: stderr.stream,
      cwd: root,
      env: SHELL_ENV,
      fetch: options.https ? forwardAttacker(loopback.origin) : globalThis.fetch,
    },
  );
  const stored = await readText(envPath);
  expect(await readText(marker)).toBeNull();
  if (code !== 0) {
    expect(code).toBe(1);
    expect(transportFailure(stderr.text())).toBe(false);
    expect(stdout.text()).not.toContain("Stored the key");
    expect(stored).toBe(options.existing ?? null);
    return;
  }
  expect(stored).not.toBeNull();
  const clients = options.clients ?? ["windsurf"];
  if (fileName === ".env.hue") {
    const lines = await sourceInstructions(root, clients);
    expect(lines).toEqual(clients.map(() => "set -a; . ./.env.hue; set +a"));
    for (const line of lines) shell(root, line);
  }
  const values = assigned(root, envPath, variables(keys));
  expect(await readText(marker)).toBeNull();
  expect(values).toEqual(variables(keys).map(() => key));
}

beforeAll(async () => {
  loopback = await listen();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

afterAll(async () => {
  await new Promise<void>((resolve) => loopback?.server.close(() => resolve()));
});

describe("hue login env file shell", () => {
  test("a key of letters is stored and sourced as that text", async () => {
    expect(parseHueOrigin(ATTACKER_ORIGIN)).toBe(ATTACKER_ORIGIN);
    await assertKeyDoesNotRun({ key: "placeholder", https: true, clients: SOURCE_CLIENTS });
  });

  const payloads: Array<[string, string]> = [
    ["a semicolon", "placeholder;>{marker}"],
    ["a command substitution", "placeholder$(>{marker})"],
    ["a backtick", "placeholder`>{marker}`"],
    ["a redirection", "placeholder>{marker}"],
    ["a logical and", "placeholder&&>{marker}"],
    ["a pipe", "placeholder|>{marker}"],
    ["an embedded single quote", "placeholder';>{marker};'"],
  ];

  for (const [name, key] of payloads) {
    test(`sourcing the env file does not run a pasted key that contains ${name}`, async () => {
      await assertKeyDoesNotRun({
        key,
        https: true,
        clients: name === "a semicolon" ? SOURCE_CLIENTS : ["windsurf"],
      });
    });
  }

  test("an evaluations-only key is held to the same shell rule", async () => {
    await assertKeyDoesNotRun({ key: "placeholder;>{marker}", keys: "evaluations" });
  });

  test("a coding-agent key is held to the same shell rule", async () => {
    await assertKeyDoesNotRun({ key: "placeholder;>{marker}", keys: "coding-agent" });
  });

  test("replacing a stored key in place does not run the new text", async () => {
    await assertKeyDoesNotRun({
      key: "placeholder;>{marker}",
      keys: "evaluations",
      args: ["--force"],
      existing: "# kept\nOTHER=1\nHUE_API_KEY=placeholder\n",
    });
  });

  test("replacing an exported assignment in place does not run a command substitution", async () => {
    await assertKeyDoesNotRun({
      key: "placeholder$(>{marker})",
      keys: "evaluations",
      args: ["--force"],
      existing: "export HUE_API_KEY=placeholder\n",
    });
  });

  test("a key written to --env-path does not run when that file is sourced", async () => {
    await assertKeyDoesNotRun({
      key: "placeholder;>{marker}",
      args: ["--env-path", ".env.alt"],
      file: ".env.alt",
    });
  });
});
