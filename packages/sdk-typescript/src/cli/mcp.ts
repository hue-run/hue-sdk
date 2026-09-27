import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, lstat, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { isLoopbackHost } from "../config.js";
import { isCredentialKey, scrubCredentialText } from "../tool-definitions.js";

/**
 * `hue mcp install`: writes or prints the coding-agent configuration for Hue's MCP server. The
 * shapes are those of Hue's published connection guide (https://docs.hue.run/agents/mcp-server),
 * kept as a separate copy here. Key configurations reference the `HUE_MCP_KEY` environment
 * variable (or a VS Code password input); sign-in configurations hold no credential. A key value
 * is never written.
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
  "Use the Hue MCP: call list_projects and confirm which project to inspect. Then call get_project_context and show that project's traces from the last 24 hours that need attention or have errors, with links; if there are none, show its 5 most recent traces. For an organization connection, pass the project's id or slug as project_id on each call after list_projects.";

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
/** Toolset names Hue's MCP server accepts: `all`, its catalog groups and its curated profiles. */
export const MCP_TOOLSETS = [
  "all",
  "observe",
  "author",
  "evaluate",
  "project",
  "traces",
  "eval_sets",
  "runs",
  "judges",
  "cases",
  "runners",
  "environments",
  "intents",
  "docs",
] as const;
/**
 * The header form of `?toolsets=`. Only the sign-in Codex TOML uses it, as Hue's guide does, to
 * keep that URL bare; every other configuration carries the selection in its URL.
 */
export const TOOLSETS_HEADER = "X-Hue-MCP-Toolsets";
/** The header form of `?project=`, used by the sign-in Codex TOML to keep its URL bare. */
export const PROJECT_HEADER = "X-Hue-MCP-Project";
/**
 * Toolsets a client's configuration selects unless `--toolsets` says otherwise. Claude Code,
 * Codex and Conductor's agents defer MCP tools behind their own tool search, so listing every tool
 * costs them little. Cursor caps the tools it loads, so it names the production reads. The other
 * clients list Hue's default: the production reads, and `search_hue_tools` with its executors,
 * which reach every other tool.
 */
const DEFAULT_TOOLSETS: Partial<Record<ClientId, string>> = {
  "claude-code": "all",
  codex: "all",
  conductor: "all",
  cursor: "observe",
};
/** Codex runs a server's tool calls one at a time without it; each Hue call is independent. */
const CODEX_PARALLEL = "supports_parallel_tool_calls = true";

export const MCP_USAGE = `Usage: hue mcp install --client <claude-code|codex|conductor|cursor|vscode|windsurf|gemini>
                       [--auth key|oauth] [--read-only] [--project ID-OR-SLUG]
                       [--toolsets NAMES] [--url URL]
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
  --project VALUE Pin the connection to one project by id or slug. Its tools omit project_id,
                  and the server is named hue-<value> so it can coexist with an unpinned hue
  --toolsets NAMES
                  Tools to list, comma-separated: all; the observe, author or evaluate
                  profiles; or project, traces, eval_sets, runs, judges, cases, runners,
                  environments, intents or docs. Added to the URL as ?toolsets=.
                  Defaults: all for claude-code, codex and conductor,
                  which search their own tools; observe for cursor. Without a selection
                  Hue lists the production reads and search_hue_tools, which reaches
                  every other tool
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
export function renderMcpSnippets(url: string, serverName = SERVER_NAME) {
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
    claudeCodeProjectJson: json({ mcpServers: { [serverName]: claudeCodeServer } }),
    claudeCodeCli: {
      args: [
        "mcp",
        "add",
        "--transport",
        "http",
        "--scope",
        "user",
        serverName,
        url,
        "--header",
        `Authorization: Bearer \${${ENV_VAR}}`,
      ],
      display: `claude mcp add --transport http --scope user ${serverName} ${shellWord(url)} --header 'Authorization: Bearer \${${ENV_VAR}}'`,
    },
    cursorServer,
    cursorJson: json({ mcpServers: { [serverName]: cursorServer } }),
    codexCli: {
      args: ["mcp", "add", serverName, "--url", url, "--bearer-token-env-var", ENV_VAR],
      display: `codex mcp add ${serverName} --url ${shellWord(url)} --bearer-token-env-var ${ENV_VAR}`,
    },
    codexToml: `[mcp_servers.${serverName}]\nurl = "${url}"\nbearer_token_env_var = "${ENV_VAR}"\n${CODEX_PARALLEL}\n`,
    vscodeServer,
    vscodeInput,
    vscodeJson: json({ servers: { [serverName]: vscodeServer }, inputs: [vscodeInput] }),
    windsurfServer,
    windsurfJson: json({ mcpServers: { [serverName]: windsurfServer } }),
    geminiCli: {
      args: [
        "mcp",
        "add",
        "--scope",
        "user",
        "--transport",
        "http",
        serverName,
        url,
        "--header",
        `Authorization: Bearer \${${ENV_VAR}}`,
      ],
      // Single quotes keep the reference literal when a person runs this in a shell where the
      // key is exported; Gemini CLI expands ${HUE_MCP_KEY} from its settings at connection time.
      display: `gemini mcp add --scope user --transport http ${serverName} ${shellWord(url)} --header 'Authorization: Bearer \${${ENV_VAR}}'`,
    },
  };
}

/**
 * Sign-in snippets: the server URL and nothing secret. The client discovers Hue's OAuth metadata
 * from it and sends it, query included, on every request; the token's resource ignores the query,
 * so `?toolsets=` and `?project=` select tools and a project here as they do for a key.
 */
export function renderMcpSignInSnippets(url: string, serverName = SERVER_NAME) {
  const parsed = new URL(url);
  const toolsets = parsed.searchParams.get("toolsets");
  const project = parsed.searchParams.get("project");
  const headers = [
    toolsets ? `"${TOOLSETS_HEADER}" = "${toolsets}"` : null,
    project ? `"${PROJECT_HEADER}" = "${project}"` : null,
  ].filter((value): value is string => value !== null);
  const claudeCodeServer = { type: "http", url };
  return {
    claudeCodeServer,
    claudeCodeProjectJson: json({ mcpServers: { [serverName]: claudeCodeServer } }),
    claudeCodeCli: {
      args: ["mcp", "add", "--transport", "http", "--scope", "user", serverName, url],
      display: `claude mcp add --transport http --scope user ${serverName} ${shellWord(url)}`,
    },
    codexCli: {
      args: ["mcp", "add", serverName, "--url", url],
      display: `codex mcp add ${serverName} --url ${shellWord(url)}`,
    },
    // Header forms of the selections, for a TOML entry that keeps its URL bare.
    codexToml: `[mcp_servers.${serverName}]\nurl = "${projectMcpUrl(toolsetsMcpUrl(url, undefined), undefined)}"\n${headers.length ? `http_headers = { ${headers.join(", ")} }\n` : ""}${CODEX_PARALLEL}\n`,
  };
}

/**
 * Parses a comma-separated `--toolsets` value into Hue's canonical form, or returns an error.
 * Unknown names are refused: Hue ignores them and would list its default, hiding a typo.
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
 * `?toolsets=` lists only the selected tools; commas stay readable. Without a selection the
 * parameter is removed, so the connection lists Hue's default.
 */
export function toolsetsMcpUrl(url: string, toolsets: string | undefined): string {
  const parsed = new URL(url);
  parsed.searchParams.delete("toolsets");
  if (!toolsets) return parsed.href;
  const query = parsed.search.slice(1);
  parsed.search = `${query ? `${query}&` : ""}toolsets=${toolsets}`;
  return parsed.href;
}

/** Parses the id or slug used to pin a connection and derives its coexisting server name. */
export function parseProject(
  value: string,
): { project: string; serverName: string } | { error: string } {
  const project = value.trim();
  if (!project)
    return { error: "--project is empty. Name a project id or slug, or remove the option." };
  if (project.length > 256 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/iu.test(project))
    return {
      error: "--project takes a project id or slug, using letters, numbers and hyphens.",
    };
  return { project, serverName: `${SERVER_NAME}-${project.toLowerCase()}` };
}

/** Replaces `?project=` while preserving the URL's other selections. */
export function projectMcpUrl(url: string, project: string | undefined): string {
  const parsed = new URL(url);
  parsed.searchParams.delete("project");
  if (project) parsed.searchParams.append("project", project);
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

/** Replaces only the selected server entry under `key`, keeping every other server and field. */
function mergeServerEntry(
  existing: unknown,
  key: "mcpServers" | "servers",
  entry: Record<string, unknown>,
  display: string,
  serverName = SERVER_NAME,
): Record<string, unknown> {
  if (existing !== undefined && !isRecord(existing))
    throw new ConfigError(`${display} must contain a JSON object.`);
  const root = existing ?? {};
  const servers = root[key];
  if (servers !== undefined && !isRecord(servers))
    throw new ConfigError(`${display}: "${key}" must be a JSON object.`);
  return { ...root, [key]: { ...(servers ?? {}), [serverName]: entry } };
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

/**
 * Refuses a symbolic link, or anything but a directory, between the working directory and the file
 * (`.cursor` or `.vscode`), as the file itself is refused. The working directory and its ancestors
 * are not checked: on macOS `/tmp` and `/var` are links, and a home directory can be one. This runs
 * before the file is read and again before the rename. Node has no `openat`, so it cannot pin the
 * directory against an account that can write the project and swaps a link in after the last check.
 */
async function rejectLinkedParents(cwd: string, path: string, display: string): Promise<void> {
  let current = cwd;
  for (const part of relative(cwd, dirname(path)).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const shown = displayPath(cwd, current);
    if (info.isSymbolicLink())
      throw new ConfigError(`Refusing to use ${display}: ${shown} is a symbolic link.`);
    if (!info.isDirectory())
      throw new ConfigError(`Refusing to use ${display}: ${shown} is not a directory.`);
  }
}

/** The file's status, or undefined when there is none; a symbolic link is refused. */
async function rejectSymlink(path: string, display: string): Promise<Stats | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (info.isSymbolicLink())
    throw new ConfigError(`Refusing to write ${display}: it is a symbolic link.`);
  return info;
}

/**
 * Atomic write: temporary file, fsync, rename. A file it replaces keeps its permission bits, so one
 * kept at 0600 because it holds other servers' tokens is never widened, except that other accounts
 * lose write access; it keeps its group (or, when the group cannot be kept, its group and other
 * accounts get only the access both had), and its owner when root runs the command. A new file is
 * created owner-only, 0600 narrowed by the umask: people and clients add literal tokens to these
 * files.
 */
async function writeConfigFile(
  cwd: string,
  path: string,
  text: string,
  display: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const existing = await rejectSymlink(path, display);
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(text, "utf8");
      if (existing) {
        // Other accounts never keep write access: they could add a server command to run.
        let mode = existing.mode & 0o775;
        // The new file has the process's group (the directory's on macOS), which may differ. When
        // the group cannot be kept, its members and everyone else get only what both had.
        const created = await handle.stat();
        if (created.gid !== existing.gid) {
          try {
            await handle.chown(-1, existing.gid);
          } catch {
            const shared = (mode >> 3) & mode & 0o007;
            mode = (mode & 0o700) | (shared << 3) | shared;
          }
        }
        await handle.chmod(mode);
        // Root also gives the file back to its owner, last: changing the mode of another account's
        // file would need CAP_FOWNER. If it cannot, the write fails and the old file stays in place,
        // rather than leaving one its owner cannot read.
        if (process.geteuid?.() === 0 && created.uid !== existing.uid)
          await handle.chown(existing.uid, -1);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rejectLinkedParents(cwd, path, display);
    await rejectSymlink(path, display);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

const REDACTED = "[redacted]";
/**
 * Only references a client resolves (`${NAME}`, `${env:NAME}`, `${input:id}`), after an optional
 * `Bearer`, `Basic` or `Token` scheme: no credential. A reference with a default does not match.
 */
const REFERENCE_ONLY =
  /^(?:(?:bearer|basic|token)[ \t]+)?(?:\$\{(?:input:[\w.-]+|(?:env:)?[A-Za-z_]\w*)\})+$/iu;

/** Names `isCredentialKey` leaves out that configurations use for a credential field or option. */
const CREDENTIAL_NAMES = new Set(["auth", "pat", "bearer", "env"]);

/** `isCredentialKey`, `CREDENTIAL_NAMES`, or a name ending in `key`, `keys`, `header` or `headers`. */
function isCredentialName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[-_]/g, "");
  return (
    isCredentialKey(name) ||
    CREDENTIAL_NAMES.has(normalized) ||
    /(?:keys?|headers?)$/u.test(normalized)
  );
}

/**
 * An `args` option whose next item is its value and names a credential: `--api-key`, `--header`,
 * or `-H`, the header option of curl and `mcp-remote`.
 */
function isCredentialOption(item: unknown): boolean {
  if (item === "-H") return true;
  const name = typeof item === "string" ? /^--?([A-Za-z][\w-]*)$/u.exec(item)?.[1] : undefined;
  return name !== undefined && isCredentialName(name);
}

/** `--name=value`, or `NAME=value` as `env` takes it, as an `args` item. */
const OPTION_VALUE = /^(-{0,2}([A-Za-z][\w-]*)=)(.*)$/su;
/**
 * The item after Docker's `-e` or `--env`, as an environment value is shown: a variable name alone
 * (passed through from the environment) as is, `NAME=VALUE` with its value redacted. Anything else,
 * such as the script after `node -e`, can hold a literal credential in any shape and is redacted.
 */
function redactEnvironmentItem(item: string): string {
  if (/^[A-Za-z_]\w*$/u.test(item)) return item;
  const assignment = /^([A-Za-z_]\w*)=(.*)$/su.exec(item);
  if (!assignment) return REDACTED;
  return REFERENCE_ONLY.test(assignment[2]!) ? item : `${assignment[1]}=${REDACTED}`;
}

/** A URL path segment long and mixed enough to be a token, as some servers put their key there. */
const TOKEN_SEGMENT = /^(?=[^/]*[A-Za-z])(?=[^/]*\d)[^/]{16,}$/u;

/** Whether a URL path segment is token-like, or a credential `scrubCredentialText` knows. */
function isTokenSegment(segment: string): boolean {
  return TOKEN_SEGMENT.test(segment) || scrubCredentialText(segment) !== segment;
}

/** A URL with each token-like path segment replaced; any other string is returned as is. */
function redactUrlPath(value: string): string {
  if (!/^(?:https?|wss?):\/\//iu.test(value)) return value;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }
  const segments = parsed.pathname.split("/");
  if (!segments.some(isTokenSegment)) return value;
  parsed.pathname = segments
    .map((segment) => (isTokenSegment(segment) ? REDACTED : segment))
    .join("/");
  return parsed.href;
}

/** A query parameter name shown before its redacted value; any other becomes `[redacted]` whole. */
const PARAMETER_NAME = /^[A-Za-z_][\w.-]{0,31}$/u;

/**
 * The URL this command writes, as its output shows it: the selections it validated (`toolsets`,
 * `project`, and `read_only` when true or false) are kept; any other query value, and a token-like
 * path segment, becomes `[redacted]`. `parseMcpUrl` has already refused userinfo and a fragment.
 * Commands printed for a person to run keep the URL as given.
 */
function displayMcpUrl(url: string): string {
  const parsed = new URL(url);
  const query = parsed.search
    .slice(1)
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const [name = "", value = ""] = pair.split("=", 2);
      const selection =
        name === "toolsets" ||
        name === "project" ||
        (name === "read_only" && /^(?:true|false)$/u.test(value));
      if (selection) return pair;
      return PARAMETER_NAME.test(name) &&
        !TOKEN_SEGMENT.test(name) &&
        scrubCredentialText(name) === name
        ? `${name}=${REDACTED}`
        : REDACTED;
    });
  return redactUrlPath(
    `${parsed.origin}${parsed.pathname}${query.length ? `?${query.join("&")}` : ""}`,
  );
}

/**
 * A merged configuration as `--dry-run` prints it. Header and `env` values, strings and numbers
 * under a key naming a credential, the value of a credential option in `args` (`--api-key VALUE`,
 * `--key=VALUE`) and token-like URL path segments become `[redacted]` unless they only reference a
 * variable or input; other strings lose what `scrubCredentialText` finds (a known token prefix, a
 * `token=` pair, a URL's userinfo and query values). The server names under `serversKey` are not
 * read as field names. `url`, the address this command writes, is shown as `shownUrl`.
 */
function redactConfig(
  root: Record<string, unknown>,
  serversKey: "mcpServers" | "servers",
  url: string,
  shownUrl: string,
): unknown {
  const redact = (value: unknown, secret: boolean, depth: number, names: boolean): unknown => {
    if (depth > 256) return REDACTED;
    if (typeof value === "number") return secret ? REDACTED : value;
    if (typeof value === "string") {
      if (value === url) return shownUrl;
      if (REFERENCE_ONLY.test(value)) return value;
      if (secret) return REDACTED;
      const option = OPTION_VALUE.exec(value);
      if (!option) return scrubCredentialText(redactUrlPath(value));
      if (REFERENCE_ONLY.test(option[3]!)) return value;
      const shown = isCredentialName(option[2]!)
        ? REDACTED
        : scrubCredentialText(redactUrlPath(option[3]!));
      return `${option[1]}${shown}`;
    }
    if (Array.isArray(value))
      return value.map((item: unknown, index) => {
        const previous = value[index - 1];
        if (!secret && typeof item === "string" && (previous === "-e" || previous === "--env"))
          return redactEnvironmentItem(item);
        return redact(item, secret || isCredentialOption(previous), depth + 1, false);
      });
    if (!isRecord(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redact(
          item,
          secret || (!(names && isRecord(item)) && isCredentialName(key)),
          depth + 1,
          depth === 0 && key === serversKey,
        ),
      ]),
    );
  };
  return redact(root, false, 0, false);
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
      project: { type: "string" },
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
  serverName: string,
): Plan {
  const snippets = renderMcpSnippets(url, serverName);
  // Claude Code and Codex take the same plan shape with or without a key.
  const shared = auth === "oauth" ? renderMcpSignInSnippets(url, serverName) : snippets;
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

function nextSteps(
  client: ClientId,
  auth: AuthMode,
  serverName: string,
  project: string | undefined,
): string[] {
  const label = CLIENT_LABELS[client];
  const approve = project
    ? `Sign in to Hue and approve the connection. It acts only on the pinned project ${project}, within your role; for read-only access, use a Read project key with --auth key.`
    : "Sign in to Hue and approve the connection. It can read and write every active project in the organization you choose, within your role; for read-only access, use a Read project key with --auth key.";
  let lines: string[];
  if (auth === "oauth")
    lines =
      client === "claude-code"
        ? [`In Claude Code, run /mcp, select ${serverName} and choose Authenticate. ${approve}`]
        : client === "codex"
          ? [
              `If Codex did not open Hue in your browser, run: codex mcp login ${serverName}`,
              approve,
            ]
          : [
              `In Conductor, open MCP status from the plug icon or /mcp-status, refresh, and use ${serverName}'s authentication action. ${approve}`,
              "Start a new agent session if the Hue tools do not appear. Hue has not yet verified signed-in Conductor end to end; if the tools still do not load, rerun with --auth key.",
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
  // `codex mcp add` has no option for it, so a registered server gets the line by hand.
  if (client === "codex" || client === "conductor")
    lines.push(
      `If codex mcp add registered ${serverName}, add this line under [mcp_servers.${serverName}] in ~/.codex/config.toml so Codex runs Hue's tool calls in parallel:`,
      `  ${CODEX_PARALLEL}`,
    );
  if (project)
    lines.push(
      `If this connection returns HTTP 404, ${project} is not an active project this credential can reach. Change or remove --project; signing in again will not fix it.`,
    );
  const verify = project
    ? `Use the Hue MCP: call list_projects and confirm it returns only the pinned project ${project} with connection.pinned true. Then call get_project_context and show that project's traces from the last 24 hours that need attention or have errors, with links; if there are none, show its 5 most recent traces. Do not pass project_id: this connection is pinned.`
    : MCP_VERIFY_PROMPT;
  return [...lines, "Then ask your agent:", `  ${verify}`];
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
  // --project replaces a pin already in --url. Without it, validate and keep the URL's pin.
  const urlProjects = new URL(url).searchParams.getAll("project");
  let projectValue = parsed.values.project;
  if (projectValue === undefined && urlProjects.length) {
    const trimmed = urlProjects.map((value) => value.trim());
    if (trimmed.some((value) => !value) || new Set(trimmed).size !== 1)
      return fail(
        "In --url: ?project= must name one project id or slug. Remove empty or conflicting values.",
        2,
      );
    projectValue = trimmed[0];
  }
  let project: string | undefined;
  let serverName = SERVER_NAME;
  if (projectValue !== undefined) {
    const selected = parseProject(projectValue);
    if ("error" in selected)
      return fail(
        `${parsed.values.project === undefined ? "In --url: " : ""}${selected.error}\n\n${MCP_USAGE}`,
        2,
      );
    project = selected.project;
    serverName = selected.serverName;
  }
  url = projectMcpUrl(url, project);
  // --toolsets wins over a selection already in --url, which wins over the client's default.
  // Both sources are validated: Hue ignores an unknown name and would list its default.
  const requested = parsed.values.toolsets ?? new URL(url).searchParams.get("toolsets");
  let toolsets: string | undefined = DEFAULT_TOOLSETS[clientId];
  if (requested !== null) {
    const selected = parseToolsets(requested);
    if ("error" in selected)
      return fail(
        `${parsed.values.toolsets === undefined ? "In --url: " : ""}${selected.error}\n\n${MCP_USAGE}`,
        2,
      );
    toolsets = selected.toolsets;
  }
  url = toolsetsMcpUrl(url, toolsets);
  const shownUrl = displayMcpUrl(url);
  // What the command reports doing; a command a person is to run is printed as given.
  const shownCommand = (command: CliCommand) =>
    command.display.replaceAll(shellWord(url), () => shellWord(shownUrl));
  const plan = planFor(clientId, auth, scope, url, serverName);
  if (parsed.values.print) {
    stdout.write(plan.snippet);
    return 0;
  }
  const steps = nextSteps(clientId, auth, serverName, project);

  if (plan.kind === "manual") {
    out(plan.hint);
    stdout.write(plan.snippet);
    for (const line of steps) out(line);
    return 0;
  }

  if (plan.kind === "cli") {
    if (parsed.values["dry-run"]) {
      for (const command of plan.commands) out(`Would run: ${shownCommand(command)}`);
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
      out(`Running: ${shownCommand(command)}`);
      const code = await runClientCli(executable, command.args, { cwd, env, stdout, stderr });
      if (code === 0) {
        out(`Registered the "${serverName}" MCP server (${shownUrl}) with ${command.label}.`);
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
  let merged: Record<string, unknown>;
  let content: string;
  try {
    await rejectLinkedParents(cwd, path, display);
    const existing = await readJsonConfig(path, display);
    merged = mergeServerEntry(existing, plan.key, plan.entry, display, serverName);
    if (plan.input) merged = mergeVscodeInput(merged, plan.input, display);
    content = json(merged);
  } catch (error) {
    if (error instanceof ConfigError)
      return fail(`${error.message}\nSnippet for ${display}:\n${plan.snippet.trimEnd()}`);
    return fail(`Could not read ${display}: ${(error as Error).message}`);
  }
  if (parsed.values["dry-run"]) {
    // Other servers' entries can hold literal tokens; the file keeps them, the output does not.
    const shown = json(redactConfig(merged, plan.key, url, shownUrl));
    out(
      shown === content
        ? `Would write ${display}:`
        : `Would write ${display} (credential values shown as ${REDACTED}):`,
    );
    stdout.write(shown);
    return 0;
  }
  try {
    await writeConfigFile(cwd, path, content, display);
  } catch (error) {
    return fail(`Could not write ${display}: ${(error as Error).message}`);
  }
  out(`Wrote ${display} with the "${serverName}" MCP server (${shownUrl}).`);
  for (const line of steps) out(line);
  return 0;
}
