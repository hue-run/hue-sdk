import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isLoopbackHost } from "../config.js";

/**
 * `hue mcp install`: writes or prints the coding-agent configuration for Hue's MCP server. The
 * shapes are those of Hue's published connection guide (https://docs.hue.run/agents/mcp-server),
 * kept as a separate copy here. Key configurations reference the `HUE_MCP_KEY` environment
 * variable (or a VS Code password input); sign-in configurations hold only the URL. A key value is
 * never written.
 */

/** Streams, environment and working directory for {@link runMcpCommand}; tests inject these. */
export interface McpCommandIo {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export const DEFAULT_MCP_URL = "https://mcp.hue.run/mcp";
const SERVER_NAME = "hue";
const ENV_VAR = "HUE_MCP_KEY";
const INPUT_ID = `${SERVER_NAME}-mcp-key`;
const MAX_CONFIG_BYTES = 1024 * 1024;
/**
 * Prompt to paste into the agent after installation. `list_projects` answers for every credential:
 * a project key or earlier connection returns its one project, and an organization connection
 * lists them, after which each call takes `project_id`. It reads what needs attention and falls
 * back to recent traces, so a project without errors still proves the read path.
 */
export const MCP_VERIFY_PROMPT =
  "Use the Hue MCP: call list_projects and confirm which project to inspect. Then call get_project_context and show that project's traces from the last 24 hours that need attention or have errors, with links; if there are none, show its 5 most recent traces. For an organization connection, pass the project's id as project_id on each call after list_projects.";

const CLIENT_IDS = [
  "claude-code",
  "codex",
  "conductor",
  "cursor",
  "vscode",
  "windsurf",
  "gemini",
] as const;
type ClientId = (typeof CLIENT_IDS)[number];
const CLIENT_LABELS: Record<ClientId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  conductor: "Conductor",
  cursor: "Cursor",
  vscode: "VS Code",
  windsurf: "Windsurf",
  gemini: "Gemini CLI",
};
type AuthMode = "key" | "oauth";
/** Clients whose browser sign-in with Hue works against the deployed server. */
const OAUTH_CLIENTS: readonly ClientId[] = ["claude-code", "codex", "conductor"];
/** Toolset names Hue's MCP server accepts: `all`, its catalog groups and the `observe` profile. */
export const MCP_TOOLSETS = [
  "all",
  "observe",
  "project",
  "traces",
  "evals",
  "environments",
  "intents",
  "docs",
] as const;
/** The header that selects toolsets for a sign-in connection, whose URL must stay bare. */
export const TOOLSETS_HEADER = "X-Hue-MCP-Toolsets";
/** Clients whose configuration selects a toolset unless `--toolsets` says otherwise. */
const DEFAULT_TOOLSETS: Partial<Record<ClientId, string>> = { cursor: "observe" };

export const MCP_USAGE = `Usage: hue mcp install --client <claude-code|codex|conductor|cursor|vscode|windsurf|gemini>
                       [--auth key|oauth] [--read-only] [--toolsets NAMES] [--url URL]
                       [--scope project|user] [--dry-run] [--print]

Configure a coding agent to use the Hue MCP server. A key configuration references the
${ENV_VAR} environment variable; a key value is never written. A sign-in configuration holds
only the URL: the client opens Hue in a browser, where you approve access to the projects of
one organization.

Options:
  --client NAME   Coding agent to configure (required)
  --auth MODE     key: reference ${ENV_VAR} (the default, except for conductor)
                  oauth: URL only, sign in with Hue in the client (claude-code, codex and
                  conductor; the default for conductor)
  --read-only     key only: add ?read_only=true to the URL so write tools are hidden. A
                  sign-in connection has Read and write access; use a Read key for read-only
  --toolsets NAMES
                  List only these tools, comma-separated: observe (production reads),
                  all, project, traces, evals, environments, intents or docs. A key
                  configuration adds ?toolsets= to the URL; a sign-in one sends the
                  ${TOOLSETS_HEADER} header. cursor defaults to observe; others to all
  --url URL       Hue MCP endpoint (default ${DEFAULT_MCP_URL})
  --scope SCOPE   claude-code only: project writes .mcp.json (default); user runs
                  \`claude mcp add --scope user\`
  --dry-run       Print the resulting file content or commands without writing or running
  --print         Print the configuration snippet only
  -h, --help      Show this help

Files: claude-code .mcp.json, cursor .cursor/mcp.json, vscode .vscode/mcp.json (relative to the
current directory). codex and gemini use their own CLI when it is on PATH; windsurf prints the
snippet for its user configuration file. conductor registers the server for its Claude Code
(user scope) and Codex agents with their CLIs, printing the command for a CLI not on PATH.`;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * A URL as a POSIX shell word for printed commands: `?` is a zsh glob and `&` ends a command, so a
 * URL with a query (such as `?read_only=true`) is single-quoted. Executed commands pass argv.
 */
export function shellWord(value: string): string {
  return /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Canonical Hue client snippets for a key configuration; the JSON values are also the merge
 * entries for config files.
 */
export function renderMcpSnippets(url: string) {
  const bearer = (reference: string) => `Bearer ${reference}`;
  const claudeCodeServer = {
    type: "http",
    url,
    headers: { Authorization: bearer(`\${${ENV_VAR}}`) },
  };
  const cursorServer = { url, headers: { Authorization: bearer(`\${env:${ENV_VAR}}`) } };
  const vscodeServer = {
    type: "http",
    url,
    headers: { Authorization: bearer(`\${input:${INPUT_ID}}`) },
  };
  const vscodeInput = {
    type: "promptString",
    id: INPUT_ID,
    description: "Hue Read or Read and write API key",
    password: true,
  };
  const windsurfServer = {
    serverUrl: url,
    headers: { Authorization: bearer(`\${env:${ENV_VAR}}`) },
  };
  return {
    claudeCodeServer,
    claudeCodeProjectJson: json({ mcpServers: { [SERVER_NAME]: claudeCodeServer } }),
    claudeCodeCli: {
      args: [
        "mcp",
        "add",
        "--transport",
        "http",
        "--scope",
        "user",
        SERVER_NAME,
        url,
        "--header",
        `Authorization: Bearer \${${ENV_VAR}}`,
      ],
      display: `claude mcp add --transport http --scope user ${SERVER_NAME} ${shellWord(url)} --header 'Authorization: Bearer \${${ENV_VAR}}'`,
    },
    cursorServer,
    cursorJson: json({ mcpServers: { [SERVER_NAME]: cursorServer } }),
    codexCli: {
      args: ["mcp", "add", SERVER_NAME, "--url", url, "--bearer-token-env-var", ENV_VAR],
      display: `codex mcp add ${SERVER_NAME} --url ${shellWord(url)} --bearer-token-env-var ${ENV_VAR}`,
    },
    codexToml: `[mcp_servers.${SERVER_NAME}]\nurl = "${url}"\nbearer_token_env_var = "${ENV_VAR}"\n`,
    vscodeServer,
    vscodeInput,
    vscodeJson: json({ servers: { [SERVER_NAME]: vscodeServer }, inputs: [vscodeInput] }),
    windsurfServer,
    windsurfJson: json({ mcpServers: { [SERVER_NAME]: windsurfServer } }),
    geminiCli: {
      args: [
        "mcp",
        "add",
        "--scope",
        "user",
        "--transport",
        "http",
        SERVER_NAME,
        url,
        "--header",
        `Authorization: Bearer \${${ENV_VAR}}`,
      ],
      // Single quotes keep the reference literal when a person runs this in a shell where the
      // key is exported; Gemini CLI expands ${HUE_MCP_KEY} from its settings at connection time.
      display: `gemini mcp add --scope user --transport http ${SERVER_NAME} ${shellWord(url)} --header 'Authorization: Bearer \${${ENV_VAR}}'`,
    },
  };
}

/**
 * Sign-in snippets: the bare server URL, which the client uses to discover Hue's OAuth metadata,
 * and, when toolsets are selected, the header that carries them.
 */
export function renderMcpSignInSnippets(url: string, toolsets?: string) {
  const headers = toolsets ? { [TOOLSETS_HEADER]: toolsets } : undefined;
  const claudeCodeServer = { type: "http", url, ...(headers ? { headers } : {}) };
  const headerArgs = toolsets ? ["--header", `${TOOLSETS_HEADER}: ${toolsets}`] : [];
  return {
    claudeCodeServer,
    claudeCodeProjectJson: json({ mcpServers: { [SERVER_NAME]: claudeCodeServer } }),
    claudeCodeCli: {
      args: [
        "mcp",
        "add",
        "--transport",
        "http",
        "--scope",
        "user",
        SERVER_NAME,
        url,
        ...headerArgs,
      ],
      display: `claude mcp add --transport http --scope user ${SERVER_NAME} ${shellWord(url)}${toolsets ? ` --header '${TOOLSETS_HEADER}: ${toolsets}'` : ""}`,
    },
    // `codex mcp add` cannot store a header; the TOML carries it and the next steps say so.
    codexCli: {
      args: ["mcp", "add", SERVER_NAME, "--url", url],
      display: `codex mcp add ${SERVER_NAME} --url ${shellWord(url)}`,
    },
    codexToml: `[mcp_servers.${SERVER_NAME}]\nurl = "${url}"\n${toolsets ? `http_headers = { "${TOOLSETS_HEADER}" = "${toolsets}" }\n` : ""}`,
  };
}

/**
 * Parses a comma-separated `--toolsets` value into Hue's canonical form, or returns an error.
 * Unknown names are refused: Hue ignores them and would list the whole catalog, hiding a typo.
 */
export function parseToolsets(value: string): { toolsets: string } | { error: string } {
  const names = [...new Set(value.split(",").map((name) => name.trim()))];
  if (names.some((name) => !name))
    return { error: "--toolsets takes comma-separated names, such as observe or traces,docs." };
  const unknown = names.filter((name) => !(MCP_TOOLSETS as readonly string[]).includes(name));
  if (unknown.length)
    return {
      error: `Unknown toolset${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Choose from ${MCP_TOOLSETS.join(", ")}.`,
    };
  return { toolsets: names.join(",") };
}

/**
 * `?toolsets=` lists only the selected tools for a key configuration; commas stay readable.
 * Without a selection the parameter is removed, so the URL lists every tool.
 */
export function toolsetsMcpUrl(url: string, toolsets: string | undefined): string {
  const parsed = new URL(url);
  parsed.searchParams.delete("toolsets");
  if (!toolsets) return parsed.href;
  const query = parsed.search.slice(1);
  parsed.search = `${query ? `${query}&` : ""}toolsets=${toolsets}`;
  return parsed.href;
}

/** `?read_only=true` hides and rejects Hue's write tools for any key. */
export function readOnlyMcpUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("read_only", "true");
  return parsed.href;
}

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Replaces only the `hue` entry under `key`, keeping every other server and top-level field. */
function mergeServerEntry(
  existing: unknown,
  key: "mcpServers" | "servers",
  entry: Record<string, unknown>,
  display: string,
): Record<string, unknown> {
  if (existing !== undefined && !isRecord(existing))
    throw new ConfigError(`${display} must contain a JSON object.`);
  const root = existing ?? {};
  const servers = root[key];
  if (servers !== undefined && !isRecord(servers))
    throw new ConfigError(`${display}: "${key}" must be a JSON object.`);
  return { ...root, [key]: { ...(servers ?? {}), [SERVER_NAME]: entry } };
}

function mergeVscodeInput(
  root: Record<string, unknown>,
  input: Record<string, unknown>,
  display: string,
): Record<string, unknown> {
  const inputs = root.inputs;
  if (inputs !== undefined && !Array.isArray(inputs))
    throw new ConfigError(`${display}: "inputs" must be a JSON array.`);
  const others = (inputs ?? []).filter((item) => !(isRecord(item) && item.id === INPUT_ID));
  return { ...root, inputs: [...others, input] };
}

async function readJsonConfig(path: string, display: string): Promise<unknown> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError(`Cannot read ${display}: ${(error as Error).message}`);
  }
  if (info.isSymbolicLink())
    throw new ConfigError(`Refusing to use ${display}: it is a symbolic link.`);
  if (!info.isFile())
    throw new ConfigError(`Refusing to use ${display}: it is not a regular file.`);
  if (info.size > MAX_CONFIG_BYTES)
    throw new ConfigError(`Refusing to use ${display}: it is larger than 1 MiB.`);
  const text = await readFile(path, "utf8");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConfigError(
      `${display} is not valid JSON (comments are not supported); fix it or add the snippet by hand.`,
    );
  }
}

async function rejectSymlink(path: string, display: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new ConfigError(`Refusing to write ${display}: it is a symbolic link.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

/** Atomic write for a secret-free config file: temporary file, fsync, rename; mode 0644. */
async function writeConfigFile(path: string, text: string, display: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await rejectSymlink(path, display);
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    );
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o644);
    await rejectSymlink(path, display);
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

/** Runs a client CLI without a shell, forwarding its output; null when it could not start. */
function runClientCli(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
  },
): Promise<number | null> {
  return new Promise<number | null>((resolveRun) => {
    try {
      const child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk: Buffer) => {
        options.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        options.stderr.write(chunk);
      });
      child.once("error", () => resolveRun(null));
      child.once("close", (code) => resolveRun(code));
    } catch {
      resolveRun(null);
    }
  });
}

/** Validates the MCP endpoint: HTTPS, or HTTP for loopback test servers; no credentials or hash. */
export function parseMcpUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname)))
    return null;
  if (url.username || url.password || url.hash) return null;
  return url.href;
}

function parseMcpArguments(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      client: { type: "string" },
      auth: { type: "string" },
      "read-only": { type: "boolean", default: false },
      toolsets: { type: "string" },
      url: { type: "string" },
      scope: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      print: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}

function displayPath(cwd: string, path: string): string {
  const shown = relative(cwd, path);
  return shown && !shown.startsWith("..") && !isAbsolute(shown) ? shown : path;
}

interface CliCommand {
  executable: string;
  /** The coding agent the command registers the server with. */
  label: string;
  args: string[];
  display: string;
  /** Printed before `display` when the executable is not on PATH. */
  fallback: string[];
}

type Plan =
  | {
      kind: "file";
      file: string;
      key: "mcpServers" | "servers";
      entry: Record<string, unknown>;
      input?: Record<string, unknown>;
      snippet: string;
    }
  | { kind: "cli"; commands: CliCommand[]; snippet: string }
  | { kind: "manual"; snippet: string; hint: string };

const notOnPath = (executable: string, label: string) =>
  `${executable} is not on PATH. Run this where ${label} is installed:`;

/** `auth: "oauth"` is only planned for {@link OAUTH_CLIENTS}; the caller refuses the others. */
function planFor(
  client: ClientId,
  auth: AuthMode,
  scope: "project" | "user",
  url: string,
  toolsets: string | undefined,
): Plan {
  const snippets = renderMcpSnippets(url);
  // Claude Code and Codex take the same plan shape with or without a key.
  const shared = auth === "oauth" ? renderMcpSignInSnippets(url, toolsets) : snippets;
  const claudeUser: CliCommand = {
    executable: "claude",
    label: "Claude Code",
    ...shared.claudeCodeCli,
    fallback: [notOnPath("claude", "Claude Code")],
  };
  const codex: CliCommand = {
    executable: "codex",
    label: "Codex",
    ...shared.codexCli,
    fallback: [
      "codex is not on PATH. Add this to ~/.codex/config.toml (or run the command where Codex is installed):",
      shared.codexToml.trimEnd(),
    ],
  };
  switch (client) {
    case "claude-code":
      return scope === "user"
        ? { kind: "cli", commands: [claudeUser], snippet: `${claudeUser.display}\n` }
        : {
            kind: "file",
            file: ".mcp.json",
            key: "mcpServers",
            entry: shared.claudeCodeServer,
            snippet: shared.claudeCodeProjectJson,
          };
    case "codex":
      return { kind: "cli", commands: [codex], snippet: shared.codexToml };
    case "conductor":
      // Conductor has no MCP configuration of its own: its Claude Code and Codex agents read their
      // user configuration in every workspace.
      return {
        kind: "cli",
        commands: [claudeUser, codex],
        snippet: `${claudeUser.display}\n${codex.display}\n`,
      };
    case "cursor":
      return {
        kind: "file",
        file: join(".cursor", "mcp.json"),
        key: "mcpServers",
        entry: snippets.cursorServer,
        snippet: snippets.cursorJson,
      };
    case "vscode":
      return {
        kind: "file",
        file: join(".vscode", "mcp.json"),
        key: "servers",
        entry: snippets.vscodeServer,
        input: snippets.vscodeInput,
        snippet: snippets.vscodeJson,
      };
    case "windsurf":
      return {
        kind: "manual",
        snippet: snippets.windsurfJson,
        hint: "Merge this into ~/.codeium/windsurf/mcp_config.json (Windsurf > Settings > MCP); the command does not write to your home directory.",
      };
    case "gemini": {
      const gemini: CliCommand = {
        executable: "gemini",
        label: "Gemini CLI",
        ...snippets.geminiCli,
        fallback: [notOnPath("gemini", "Gemini CLI")],
      };
      return { kind: "cli", commands: [gemini], snippet: `${gemini.display}\n` };
    }
  }
}

function nextSteps(client: ClientId, auth: AuthMode, toolsets: string | undefined): string[] {
  const label = CLIENT_LABELS[client];
  const approve =
    "Sign in to Hue and approve the connection. It can read and write every active project in the organization you choose, within your role; for read-only access, use a Read project key with --auth key.";
  let lines: string[];
  if (auth === "oauth")
    lines =
      client === "claude-code"
        ? [`In Claude Code, run /mcp, select ${SERVER_NAME} and choose Authenticate. ${approve}`]
        : client === "codex"
          ? [
              `If Codex did not open Hue in your browser, run: codex mcp login ${SERVER_NAME}`,
              approve,
            ]
          : [
              `In Conductor, open MCP status from the plug icon or /mcp-status, refresh, and use ${SERVER_NAME}'s authentication action. ${approve}`,
              "Start a new agent session if the Hue tools do not appear.",
            ];
  else if (client === "vscode")
    lines = [
      `${label} prompts for the key (input ${INPUT_ID}) when the server starts; paste the ${ENV_VAR} value that hue login stored in .env.hue.`,
    ];
  else if (client === "conductor")
    lines = [
      `Conductor agents read ${ENV_VAR} from the login-shell environment Conductor captures, so export it there, not only in a terminal; hue login stores it in .env.hue. Sign-in (--auth oauth) needs no variable.`,
    ];
  else
    lines = [
      `Export ${ENV_VAR} in the shell that starts ${label}; hue login stores it in .env.hue:`,
      "  set -a; . ./.env.hue; set +a",
      `An app started from the Dock or a launcher does not see that shell's variables; start ${label} from the shell${OAUTH_CLIENTS.includes(client) ? ", or sign in instead with --auth oauth" : ""}.`,
    ];
  // `codex mcp add` stores no headers, so a sign-in toolset selection is added by hand.
  if (auth === "oauth" && toolsets && (client === "codex" || client === "conductor"))
    lines.push(
      `To list only the ${toolsets} tools in Codex, add this line under [mcp_servers.${SERVER_NAME}] in ~/.codex/config.toml:`,
      `  http_headers = { "${TOOLSETS_HEADER}" = "${toolsets}" }`,
    );
  return [...lines, "Then ask your agent:", `  ${MCP_VERIFY_PROMPT}`];
}

/**
 * Runs `hue mcp install` and returns the process exit code: 0 done or printed, 1 failed, 2 usage
 * error. `argv` may start with the `mcp` command word.
 */
export async function runMcpCommand(argv: string[], io: McpCommandIo = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const out = (line: string) => {
    stdout.write(`${line}\n`);
  };
  const fail = (message: string, code = 1): number => {
    stderr.write(`${message}\n`);
    return code;
  };

  let parsed: ReturnType<typeof parseMcpArguments>;
  try {
    parsed = parseMcpArguments(argv);
  } catch (error) {
    return fail(`${(error as Error).message}\n\n${MCP_USAGE}`, 2);
  }
  if (parsed.values.help) {
    out(MCP_USAGE);
    return 0;
  }
  const positionals =
    parsed.positionals[0] === "mcp" ? parsed.positionals.slice(1) : parsed.positionals;
  if (positionals.length !== 1 || positionals[0] !== "install")
    return fail(
      `${positionals.length === 0 ? "Missing subcommand." : `Unknown subcommand: ${positionals.join(" ")}`}\n\n${MCP_USAGE}`,
      2,
    );
  const client = parsed.values.client;
  if (!client || !CLIENT_IDS.includes(client as ClientId))
    return fail(
      `${client ? `Unknown client: ${client}.` : "--client is required."} Choose one of ${CLIENT_IDS.join(", ")}.\n\n${MCP_USAGE}`,
      2,
    );
  const clientId = client as ClientId;
  const auth = parsed.values.auth ?? (clientId === "conductor" ? "oauth" : "key");
  if (auth !== "key" && auth !== "oauth")
    return fail(`--auth must be key or oauth.\n\n${MCP_USAGE}`, 2);
  if (auth === "oauth" && !OAUTH_CLIENTS.includes(clientId))
    return fail(
      clientId === "cursor"
        ? "--auth oauth is not available for cursor: Hue does not yet accept Cursor's sign-in callback. Use a key (the default), or sign in from claude-code or codex."
        : `--auth oauth is available for ${OAUTH_CLIENTS.join(", ")}. Use a key (the default) for ${clientId}.`,
      2,
    );
  const scope = parsed.values.scope ?? "project";
  if (scope !== "project" && scope !== "user")
    return fail(`--scope must be project or user.\n\n${MCP_USAGE}`, 2);
  if (scope === "user" && clientId !== "claude-code")
    return fail("--scope user is only available with --client claude-code.", 2);
  let url = parseMcpUrl(parsed.values.url ?? DEFAULT_MCP_URL);
  if (!url)
    return fail(
      "--url must be an HTTPS URL such as https://mcp.hue.run/mcp (plain HTTP is accepted for loopback test servers only).",
      2,
    );
  // A sign-in connection's access is chosen when it is approved; read_only is not part of it.
  if (
    auth === "oauth" &&
    (parsed.values["read-only"] || new URL(url).searchParams.has("read_only"))
  )
    return fail(
      "A sign-in connection has Read and write access and cannot be made read-only by its URL. For read-only access, use a Read project key (--auth key), or add --read-only to a key configuration.",
      2,
    );
  if (parsed.values["read-only"]) url = readOnlyMcpUrl(url);
  // Toolsets are not part of the protected resource either: a sign-in URL stays bare.
  if (auth === "oauth" && new URL(url).searchParams.has("toolsets"))
    return fail("Leave toolsets off a sign-in URL; --toolsets sends them in a header instead.", 2);
  // --toolsets wins over a selection already in --url, which wins over the client's default.
  let toolsets: string | undefined =
    new URL(url).searchParams.get("toolsets") ?? DEFAULT_TOOLSETS[clientId];
  if (parsed.values.toolsets !== undefined) {
    const selected = parseToolsets(parsed.values.toolsets);
    if ("error" in selected) return fail(`${selected.error}\n\n${MCP_USAGE}`, 2);
    toolsets = selected.toolsets;
  }
  // `all` is Hue's default, so it needs no selection.
  if (toolsets === "all") toolsets = undefined;
  if (auth === "key") url = toolsetsMcpUrl(url, toolsets);
  const plan = planFor(clientId, auth, scope, url, auth === "oauth" ? toolsets : undefined);
  if (parsed.values.print) {
    stdout.write(plan.snippet);
    return 0;
  }
  const steps = nextSteps(clientId, auth, toolsets);

  if (plan.kind === "manual") {
    out(plan.hint);
    stdout.write(plan.snippet);
    for (const line of steps) out(line);
    return 0;
  }

  if (plan.kind === "cli") {
    if (parsed.values["dry-run"]) {
      for (const command of plan.commands) out(`Would run: ${command.display}`);
      return 0;
    }
    let failed = false;
    for (const command of plan.commands) {
      const executable = await findExecutable(command.executable, env);
      if (!executable) {
        for (const line of command.fallback) out(line);
        out(command.display);
        continue;
      }
      out(`Running: ${command.display}`);
      const code = await runClientCli(executable, command.args, { cwd, env, stdout, stderr });
      if (code === 0) {
        out(`Registered the "${SERVER_NAME}" MCP server (${url}) with ${command.label}.`);
        continue;
      }
      failed = true;
      stderr.write(
        `${command.executable} ${code === null ? "could not be started" : `exited with code ${code}`}. Run this command yourself:\n${command.display}\n`,
      );
    }
    if (failed) return 1;
    for (const line of steps) out(line);
    return 0;
  }

  const path = resolve(cwd, plan.file);
  const display = displayPath(cwd, path);
  let content: string;
  try {
    const existing = await readJsonConfig(path, display);
    let merged = mergeServerEntry(existing, plan.key, plan.entry, display);
    if (plan.input) merged = mergeVscodeInput(merged, plan.input, display);
    content = json(merged);
  } catch (error) {
    if (error instanceof ConfigError)
      return fail(`${error.message}\nSnippet for ${display}:\n${plan.snippet.trimEnd()}`);
    return fail(`Could not read ${display}: ${(error as Error).message}`);
  }
  if (parsed.values["dry-run"]) {
    out(`Would write ${display}:`);
    stdout.write(content);
    return 0;
  }
  try {
    await writeConfigFile(path, content, display);
  } catch (error) {
    return fail(`Could not write ${display}: ${(error as Error).message}`);
  }
  out(`Wrote ${display} with the "${SERVER_NAME}" MCP server (${url}).`);
  for (const line of steps) out(line);
  return 0;
}
