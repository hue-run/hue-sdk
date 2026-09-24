import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { isLoopbackHost } from "../config.js";
import { envFileArgument, envFileOptions } from "./env-file.js";

/**
 * `hue login`: guided storage of keys that a person creates in Hue. The command never mints a key.
 * Hue's setup credentials are deliberately isolated from ordinary project keys, so this flow
 * points at the settings page, reads the pasted keys without echo, validates each one against
 * the configured origin and stores them in a private env file. Key values are never printed.
 */

/** Streams, environment and network seams for {@link runLoginCommand}; tests inject these. */
export interface LoginCommandIo {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fetch?: typeof fetch;
  openBrowser?: (url: string) => Promise<boolean>;
}

const DEFAULT_ORIGIN = "https://app.hue.run";
const DEFAULT_ENV_FILE = ".env.hue";
/** Settings section that lists and creates project service keys. */
const KEY_SETTINGS_PATH = "/settings/integrations";
const REQUEST_TIMEOUT_MILLIS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ENV_FILE_BYTES = 1024 * 1024;
const MAX_KEY_LENGTH = 4096;

type KeyKind = "evaluations" | "coding-agent";
const KEY_KINDS: Record<
  KeyKind,
  {
    variable: "HUE_API_KEY" | "HUE_MCP_KEY";
    urlVariable: "HUE_BASE_URL" | "HUE_MCP_URL";
  }
> = {
  evaluations: {
    variable: "HUE_API_KEY",
    urlVariable: "HUE_BASE_URL",
  },
  "coding-agent": {
    variable: "HUE_MCP_KEY",
    urlVariable: "HUE_MCP_URL",
  },
};
/** Settings preset that authorizes both evaluations and the coding agent's MCP reads and writes. */
const KEY_PRESET = "Read and write";

export const LOGIN_USAGE = `Usage: hue login [--origin URL] [--env-path PATH] [--keys evaluations|coding-agent|both]
                 [--no-browser] [--force] [--gitignore]

Store the key you created in Hue in a private env file. By default one "Read and write" key serves
both evaluations (HUE_API_KEY) and your coding agent (HUE_MCP_KEY); it is validated against Hue
before it is stored, and key values are never printed.

Options:
  --origin URL     Hue origin (default ${DEFAULT_ORIGIN})
  --env-path PATH  Env file to write (default ${DEFAULT_ENV_FILE} in the current directory); it is
                   created when missing. --env-file also works, but Node itself exits
                   before this command runs when that file does not exist yet
  --keys KIND      evaluations (HUE_API_KEY), coding-agent (HUE_MCP_KEY) or both from one key
                   (default both)
  --no-browser     Do not open the key settings page in a browser
  --force          Replace an existing different value in the env file
  --gitignore      Add the env file to .gitignore when a git repository does not ignore it
  -h, --help       Show this help`;

/** Hue MCP endpoint that pairs with an application origin. */
export function mcpUrlForOrigin(origin: string): string {
  if (origin === "https://app.hue.run") return "https://mcp.hue.run/mcp";
  if (origin === "https://staging.hue.run") return "https://mcp.staging.hue.run/mcp";
  return `${origin}/api/mcp`;
}

/** Normalizes a Hue origin: HTTPS, or HTTP for loopback only; no credentials, path, query or hash. */
export function parseHueOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname)))
    return null;
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  return url.origin;
}

/** Explains why a pasted value cannot be a Hue key, or returns null when it is acceptable. */
export function invalidKeyReason(value: string): string | null {
  if (!value) return "No key was entered.";
  if (/\s/u.test(value)) return "A key cannot contain whitespace.";
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return "That looks like a URL, not a key.";
  if (value.length > MAX_KEY_LENGTH || value.includes("\u0000"))
    return "That does not look like a Hue key.";
  return null;
}

class PromptInterrupted extends Error {
  constructor() {
    super("Interrupted");
    this.name = "PromptInterrupted";
  }
}

interface Prompter {
  /** Resolves with the entered line, or null when input ends before a line arrives. */
  ask(prompt: string): Promise<string | null>;
  close(): void;
}

function isTTY(stream: unknown): boolean {
  return (stream as { isTTY?: boolean }).isTTY === true;
}

/** Interactive terminal input: readline handles editing, and its echo is muted while typing. */
function createTerminalPrompter(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
): Prompter {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      if (!muted) stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: stdin, output, terminal: true, historySize: 0 });
  let interrupted = false;
  rl.on("SIGINT", () => {
    interrupted = true;
    rl.close();
  });
  return {
    ask(prompt) {
      return new Promise<string | null>((resolvePrompt, rejectPrompt) => {
        if (interrupted) {
          rejectPrompt(new PromptInterrupted());
          return;
        }
        stdout.write(prompt);
        muted = true;
        let settled = false;
        const finish = (answer: string | null) => {
          if (settled) return;
          settled = true;
          muted = false;
          rl.removeListener("close", onClose);
          stdout.write("\n");
          if (interrupted) rejectPrompt(new PromptInterrupted());
          else resolvePrompt(answer);
        };
        const onClose = () => finish(null);
        rl.once("close", onClose);
        rl.question("", (answer) => finish(answer));
      });
    },
    close() {
      rl.close();
    },
  };
}

/** Piped input: one line per key, without echo, so scripts and tests can supply keys. */
function createLinePrompter(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream): Prompter {
  const rl = createInterface({ input: stdin, terminal: false, crlfDelay: Infinity });
  const lines: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let closed = false;
  rl.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else lines.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const next of waiting.splice(0)) next(null);
  });
  return {
    ask(prompt) {
      stdout.write(prompt);
      const queued = lines.shift();
      if (queued !== undefined || closed) {
        stdout.write("\n");
        return Promise.resolve(queued ?? null);
      }
      return new Promise<string | null>((resolveLine) => {
        waiting.push((line) => {
          stdout.write("\n");
          resolveLine(line);
        });
      });
    },
    close() {
      rl.close();
    },
  };
}

function defaultOpenBrowser(url: string): Promise<boolean> {
  const command: { executable: string; args: string[] } =
    process.platform === "darwin"
      ? { executable: "open", args: [url] }
      : process.platform === "win32"
        ? { executable: "cmd", args: ["/c", "start", "", url] }
        : { executable: "xdg-open", args: [url] };
  return new Promise<boolean>((resolveOpen) => {
    try {
      const child = spawn(command.executable, command.args, { stdio: "ignore", detached: true });
      child.once("error", () => resolveOpen(false));
      child.once("spawn", () => {
        child.unref();
        resolveOpen(true);
      });
    } catch {
      resolveOpen(false);
    }
  });
}

async function readBoundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("Oversized response");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type KeyCheck = { ok: true; detail: string } | { ok: false; rejected: boolean; detail: string };

/**
 * Mirrors `checkConnection()` with `GET /api/v1/projects/current`, then confirms evaluation access
 * with `GET /api/v1/datasets`. No redirects are followed.
 */
async function checkEvaluationsKey(
  fetchImpl: typeof fetch,
  origin: string,
  apiKey: string,
): Promise<KeyCheck> {
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/api/v1/projects/current`, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLIS),
    });
  } catch {
    return { ok: false, rejected: false, detail: `Could not reach ${origin}.` };
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    return {
      ok: false,
      rejected: true,
      detail: `Hue rejected the evaluations key (HTTP ${response.status}).`,
    };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return {
      ok: false,
      rejected: false,
      detail: `Hue answered HTTP ${response.status} while checking the evaluations key.`,
    };
  }
  let projectName: string;
  try {
    const project: unknown = JSON.parse(await readBoundedText(response));
    if (!isRecord(project) || typeof project.name !== "string") throw new Error("Invalid project");
    projectName = project.name;
  } catch {
    return { ok: false, rejected: false, detail: "Hue returned an unexpected project response." };
  }
  // Every valid key reaches the project check; only a key with write access can list eval sets,
  // so a Read or Tracing only key is refused here instead of failing later in `hue eval`.
  let evaluations: Response;
  try {
    evaluations = await fetchImpl(`${origin}/api/v1/datasets`, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLIS),
    });
  } catch {
    return { ok: false, rejected: false, detail: `Could not reach ${origin}.` };
  }
  await evaluations.body?.cancel();
  if (evaluations.status === 401 || evaluations.status === 403)
    return {
      ok: false,
      rejected: true,
      detail: `This key cannot use evaluations (HTTP ${evaluations.status}); it is a Read or Tracing only key.`,
    };
  if (!evaluations.ok)
    return {
      ok: false,
      rejected: false,
      detail: `Hue answered HTTP ${evaluations.status} while checking evaluation access.`,
    };
  return { ok: true, detail: projectName };
}

/** Reads JSON-RPC messages from a JSON body or a `text/event-stream` body. */
function parseJsonRpcMessages(text: string, contentType: string | null): unknown[] {
  const essence = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (essence !== "text/event-stream") return [JSON.parse(text) as unknown];
  const messages: unknown[] = [];
  for (const event of text.split(/\r?\n\r?\n/u)) {
    const data = event
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (data) messages.push(JSON.parse(data) as unknown);
  }
  return messages;
}

/** Lists MCP tools with the key: a `tools/list` result proves the key reaches the MCP server. */
async function checkCodingAgentKey(
  fetchImpl: typeof fetch,
  mcpUrl: string,
  apiKey: string,
): Promise<KeyCheck> {
  let response: Response;
  try {
    response = await fetchImpl(mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLIS),
    });
  } catch {
    return { ok: false, rejected: false, detail: `Could not reach ${mcpUrl}.` };
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    return {
      ok: false,
      rejected: true,
      detail: `The Hue MCP server rejected the coding-agent key (HTTP ${response.status}).`,
    };
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return {
      ok: false,
      rejected: false,
      detail: `The Hue MCP server answered HTTP ${response.status} while listing tools.`,
    };
  }
  try {
    const messages = parseJsonRpcMessages(
      await readBoundedText(response),
      response.headers.get("content-type"),
    );
    for (const message of messages) {
      if (!isRecord(message) || message.id !== 1) continue;
      if (isRecord(message.error))
        return {
          ok: false,
          rejected: false,
          detail: `The Hue MCP server returned a JSON-RPC error (code ${String(message.error.code)}).`,
        };
      if (isRecord(message.result) && Array.isArray(message.result.tools))
        return { ok: true, detail: String(message.result.tools.length) };
    }
    throw new Error("No tools/list result");
  } catch {
    return {
      ok: false,
      rejected: false,
      detail: "The Hue MCP server returned an unexpected tools/list response.",
    };
  }
}

class EnvFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvFileError";
  }
}

async function rejectSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new EnvFileError(`Refusing to write ${path}: it is a symbolic link.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function readEnvFile(path: string): Promise<{ text: string; exists: boolean }> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", exists: false };
    throw new EnvFileError(`Cannot read ${path}: ${(error as Error).message}`);
  }
  if (info.isSymbolicLink())
    throw new EnvFileError(`Refusing to use ${path}: it is a symbolic link.`);
  if (!info.isFile()) throw new EnvFileError(`Refusing to use ${path}: it is not a regular file.`);
  if (info.size > MAX_ENV_FILE_BYTES)
    throw new EnvFileError(`Refusing to use ${path}: it is larger than 1 MiB.`);
  return { text: await readFile(path, "utf8"), exists: true };
}

const ASSIGNMENT = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u;

function unquote(raw: string): string {
  const value = raw.trim();
  const quoted = /^(["'`])(.*?)\1(?:\s*(?:#.*)?)$/su.exec(value);
  if (quoted) return quoted[2] ?? "";
  const comment = value.indexOf(" #");
  return (comment >= 0 ? value.slice(0, comment) : value).trim();
}

/** Reads the effective value of a variable from env-file text; the last assignment wins. */
export function readEnvValue(text: string, variable: string): string | undefined {
  let found: string | undefined;
  for (const line of text.split("\n")) {
    const match = ASSIGNMENT.exec(line);
    if (match && match[2] === variable) found = unquote(match[3] ?? "");
  }
  return found;
}

/** Replaces or appends the given assignments while preserving every other line. */
export function mergeEnvText(text: string, entries: Record<string, string>): string {
  const pending = new Map(Object.entries(entries));
  const lines = text === "" ? [] : text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  const output: string[] = [];
  for (const line of lines) {
    const match = ASSIGNMENT.exec(line);
    const variable = match?.[2];
    if (variable !== undefined && Object.hasOwn(entries, variable)) {
      // The first assignment is rewritten in place; later duplicates of a managed variable are dropped.
      if (pending.has(variable)) {
        output.push(`${match?.[1] ?? ""}${variable}=${entries[variable]}`);
        pending.delete(variable);
      }
      continue;
    }
    output.push(line);
  }
  for (const [variable, value] of pending) output.push(`${variable}=${value}`);
  return output.length ? `${output.join("\n")}\n` : "";
}

/** Writes owner-only content through a private temporary file and an atomic rename. */
async function writePrivateFile(path: string, text: string, mode: number): Promise<void> {
  await rejectSymlink(path);
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, mode);
    await rejectSymlink(path);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function findExecutable(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const searchPath = env.PATH ?? env.Path ?? "";
  const extensions =
    process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const directory of searchPath.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension.toLowerCase()}`);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        if (process.platform !== "win32") await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function runQuiet(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number | null> {
  return new Promise<number | null>((resolveRun) => {
    try {
      const child = spawn(executable, args, { cwd, env, stdio: "ignore" });
      child.once("error", () => resolveRun(null));
      child.once("close", (code) => resolveRun(code));
    } catch {
      resolveRun(null);
    }
  });
}

async function insideGitRepository(directory: string): Promise<boolean> {
  let current = directory;
  for (;;) {
    try {
      await lstat(join(current, ".git"));
      return true;
    } catch {
      // Not at the repository root yet.
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

type IgnoreStatus = "ignored" | "not-ignored" | "outside-repository" | "unknown";

async function gitIgnoreStatus(envPath: string, env: NodeJS.ProcessEnv): Promise<IgnoreStatus> {
  const directory = dirname(envPath);
  if (!(await insideGitRepository(directory))) return "outside-repository";
  const git = await findExecutable("git", env);
  if (!git) return "unknown";
  const code = await runQuiet(git, ["check-ignore", "-q", "--", basename(envPath)], directory, env);
  if (code === 0) return "ignored";
  if (code === 1) return "not-ignored";
  return "unknown";
}

async function appendIgnoreRule(ignorePath: string, rule: string): Promise<void> {
  let text = "";
  let mode = 0o644;
  try {
    const info = await lstat(ignorePath);
    if (info.isSymbolicLink() || !info.isFile())
      throw new EnvFileError(`Refusing to edit ${ignorePath}: it is not a regular file.`);
    if (info.size > MAX_ENV_FILE_BYTES)
      throw new EnvFileError(`Refusing to edit ${ignorePath}: it is larger than 1 MiB.`);
    mode = info.mode & 0o777;
    text = await readFile(ignorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text.split(/\r?\n/u).includes(rule)) return;
  const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  await writePrivateFile(ignorePath, `${text}${separator}${rule}\n`, mode);
}

function parseLoginArguments(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      origin: { type: "string" },
      ...envFileOptions,
      keys: { type: "string" },
      "no-browser": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      gitignore: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}

function displayPath(cwd: string, path: string): string {
  const shown = relative(cwd, path);
  return shown && !shown.startsWith("..") && !isAbsolute(shown) ? shown : path;
}

/**
 * Runs `hue login` and returns the process exit code: 0 stored, 1 failed, 2 usage error, 130
 * interrupted. `argv` may start with the `login` command word.
 */
export async function runLoginCommand(argv: string[], io: LoginCommandIo = {}): Promise<number> {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const fetchImpl = io.fetch ?? globalThis.fetch;
  const openBrowser = io.openBrowser ?? defaultOpenBrowser;
  const out = (line: string) => {
    stdout.write(`${line}\n`);
  };
  const fail = (message: string, code = 1): number => {
    stderr.write(`${message}\n`);
    return code;
  };

  let parsed: ReturnType<typeof parseLoginArguments>;
  let envFileOption: string | undefined;
  try {
    parsed = parseLoginArguments(argv);
    envFileOption = envFileArgument(parsed.values);
  } catch (error) {
    return fail(`${(error as Error).message}\n\n${LOGIN_USAGE}`, 2);
  }
  if (parsed.values.help) {
    out(LOGIN_USAGE);
    return 0;
  }
  const positionals =
    parsed.positionals[0] === "login" ? parsed.positionals.slice(1) : parsed.positionals;
  if (positionals.length > 0)
    return fail(`Unexpected argument: ${positionals[0]}\n\n${LOGIN_USAGE}`, 2);
  const keysOption = parsed.values.keys ?? "both";
  if (keysOption !== "evaluations" && keysOption !== "coding-agent" && keysOption !== "both")
    return fail(`--keys must be evaluations, coding-agent or both.\n\n${LOGIN_USAGE}`, 2);
  const kinds: KeyKind[] = keysOption === "both" ? ["evaluations", "coding-agent"] : [keysOption];
  // Every requested variable comes from one pasted key: the same "Read and write" preset serves
  // evaluations and the coding agent, so asking twice would only add a step.
  const variables = kinds.map((kind) => KEY_KINDS[kind].variable).join(" and ");
  const origin = parseHueOrigin(parsed.values.origin ?? DEFAULT_ORIGIN);
  if (!origin)
    return fail(
      "--origin must be an HTTPS origin such as https://app.hue.run (plain HTTP is accepted for loopback test servers only).",
      2,
    );
  const mcpUrl = mcpUrlForOrigin(origin);
  const envPath = resolve(cwd, envFileOption ?? DEFAULT_ENV_FILE);
  const envDisplay = displayPath(cwd, envPath);

  let envFile: { text: string; exists: boolean };
  try {
    envFile = await readEnvFile(envPath);
  } catch (error) {
    return fail((error as Error).message);
  }

  const settingsUrl = `${origin}${KEY_SETTINGS_PATH}`;
  out("Hue keys are created in the app; this command validates and stores one locally.");
  out(`Create a "${KEY_PRESET}" key at: ${settingsUrl}`);
  out(`  It is stored as ${variables}.`);
  if (!parsed.values["no-browser"] && isTTY(stdout)) {
    const opened = await openBrowser(settingsUrl).catch(() => false);
    if (opened) out("Opened the key settings page in your browser.");
  }
  for (const kind of kinds) {
    const { variable } = KEY_KINDS[kind];
    if (readEnvValue(envFile.text, variable) !== undefined)
      out(`${variable} is already stored in ${envDisplay}; a different value requires --force.`);
  }

  const stored: KeyKind[] = [];
  // Validation and the write record why they stopped instead of returning, so a key that did land
  // in the file still reaches the ignore protection below.
  let failure: { message: string; code?: number } | undefined;
  const prompter = isTTY(stdin)
    ? createTerminalPrompter(stdin, stdout)
    : createLinePrompter(stdin, stdout);
  try {
    const answer = await prompter.ask(`Paste the "${KEY_PRESET}" key (${variables}): `);
    const value = answer?.trim() ?? "";
    const reason = answer === null ? null : invalidKeyReason(value);
    const updates: Record<string, string> = {};
    for (const kind of kinds) {
      const { variable, urlVariable } = KEY_KINDS[kind];
      updates[variable] = value;
      updates[urlVariable] = kind === "evaluations" ? origin : mcpUrl;
    }
    if (answer === null) failure = { message: `No key was entered; input ended.` };
    else if (reason)
      failure = {
        message: `${reason} Create a "${KEY_PRESET}" key at ${settingsUrl} and paste it.`,
      };
    else if (!parsed.values.force) {
      for (const [name, next] of Object.entries(updates)) {
        const current = readEnvValue(envFile.text, name);
        if (current !== undefined && current !== next)
          failure ??= {
            message: `${name} in ${envDisplay} already has a different value; rerun with --force to replace it.`,
          };
      }
    }
    for (const kind of failure ? [] : kinds) {
      const check =
        kind === "evaluations"
          ? await checkEvaluationsKey(fetchImpl, origin, value)
          : await checkCodingAgentKey(fetchImpl, mcpUrl, value);
      if (!check.ok) {
        failure = {
          message: check.rejected
            ? `${check.detail} Create a "${KEY_PRESET}" key at ${settingsUrl} and try again. Nothing was stored.`
            : `${check.detail} Nothing was stored.`,
        };
        break;
      }
      out(
        kind === "evaluations"
          ? `Evaluations access accepted for project "${check.detail}".`
          : `Coding-agent access accepted; the Hue MCP server lists ${check.detail} tools.`,
      );
    }
    if (!failure) {
      const text = mergeEnvText(envFile.text, updates);
      try {
        await writePrivateFile(envPath, text, 0o600);
        envFile = { text, exists: true };
        stored.push(...kinds);
        const urls = kinds.map((kind) => KEY_KINDS[kind].urlVariable).join(" and ");
        out(
          `Stored the key (${value.length} chars) as ${variables}, with ${urls}, in ${envDisplay}.`,
        );
      } catch (error) {
        failure = { message: `Could not write ${envDisplay}: ${(error as Error).message}` };
      }
    }
  } catch (error) {
    failure =
      error instanceof PromptInterrupted
        ? { message: "Interrupted; nothing was stored.", code: 130 }
        : { message: `hue login failed: ${(error as Error).message}` };
  } finally {
    prompter.close();
  }

  // Only reached when a key actually landed in the file: a run that stored nothing has no new
  // secret to protect and should not warn about a file it did not write.
  if (stored.length) {
    const ignorePath = join(dirname(envPath), ".gitignore");
    const status = await gitIgnoreStatus(envPath, env);
    if (status === "not-ignored") {
      if (parsed.values.gitignore) {
        try {
          await appendIgnoreRule(ignorePath, basename(envPath));
          out(`Added ${basename(envPath)} to ${displayPath(cwd, ignorePath)}.`);
        } catch (error) {
          stderr.write(
            `Warning: could not update ${displayPath(cwd, ignorePath)}: ${(error as Error).message}\n`,
          );
        }
      } else {
        stderr.write(
          `Warning: ${envDisplay} is not ignored by git. Rerun with --gitignore or add it to .gitignore before committing.\n`,
        );
      }
    } else if (status === "unknown") {
      stderr.write(
        `Warning: could not confirm that git ignores ${envDisplay}; make sure it is never committed.\n`,
      );
    }
  }
  if (failure) return fail(failure.message, failure.code);

  out("Next steps:");
  if (stored.includes("coding-agent"))
    // `hue mcp install` defaults to production; a non-default origin needs its own endpoint.
    out(
      `  hue mcp install --client claude-code${mcpUrl === mcpUrlForOrigin(DEFAULT_ORIGIN) ? "" : ` --url ${mcpUrl}`}`,
    );
  if (stored.includes("evaluations"))
    out(`  hue eval --case "<name>" ./hue-agent.ts --env-file ${envDisplay}`);
  return 0;
}
