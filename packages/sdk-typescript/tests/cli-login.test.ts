import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import {
  LOGIN_USAGE,
  invalidKeyReason,
  mcpUrlForOrigin,
  mergeEnvText,
  parseHueOrigin,
  readEnvValue,
  runLoginCommand,
} from "../src/cli/login.js";

const roots: string[] = [];
async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hue-cli-login-")));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const ORIGIN = "https://hue.example";
const EVAL_KEY = `hue_live_evaluations_${"e".repeat(40)}`;
const MCP_KEY = `hue_live_agent_${"m".repeat(40)}`;
/** One "Read and write" key: the default login stores it for evaluations and the coding agent. */
const KEY = `hue_live_read_write_${"k".repeat(40)}`;
/** A "Read" key: it reaches the project and the MCP server but cannot use evaluations. */
const READ_KEY = `hue_live_read_${"r".repeat(40)}`;
const SETTINGS_URL = `${ORIGIN}/settings/integrations`;

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

function pipedInput(lines: string[]): PassThrough {
  const stream = new PassThrough();
  stream.end(lines.map((line) => `${line}\n`).join(""));
  return stream;
}

interface RecordedCall {
  url: string;
  method: string;
  authorization: string | null;
  headers: Headers;
  body: string | undefined;
}

/** Stands in for Hue's project check and the MCP `tools/list` route; no network is used. */
function syntheticHue(
  options: { evalKeys?: string[]; mcpKeys?: string[]; readKeys?: string[]; sse?: boolean } = {},
) {
  const evalKeys = options.evalKeys ?? [EVAL_KEY, KEY];
  const readKeys = options.readKeys ?? [READ_KEY];
  const mcpKeys = options.mcpKeys ?? [MCP_KEY, KEY, READ_KEY];
  const bearer = (authorization: string | null, keys: string[]) =>
    keys.some((key) => authorization === `Bearer ${key}`);
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    calls.push({
      url,
      method: init?.method ?? "GET",
      authorization,
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (url === `${ORIGIN}/api/v1/projects/current`) {
      if (!bearer(authorization, [...evalKeys, ...readKeys]))
        return Response.json(
          { error: "A valid project service key is required." },
          { status: 401 },
        );
      return Response.json({
        id: "22222222-2222-4222-8222-222222222222",
        name: "Synthetic",
        slug: "synthetic",
        organizationId: "33333333-3333-4333-8333-333333333333",
      });
    }
    if (url === `${ORIGIN}/api/v1/datasets`) {
      if (!bearer(authorization, evalKeys))
        return Response.json({ error: "This key cannot use evaluations." }, { status: 403 });
      return Response.json({ items: [], nextCursor: null });
    }
    if (url === `${ORIGIN}/api/mcp`) {
      if (!bearer(authorization, mcpKeys))
        return Response.json({ error: "This key cannot read project data." }, { status: 403 });
      const message = {
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [{ name: "get_project_context" }, { name: "search_traces" }] },
      };
      return options.sse
        ? new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        : Response.json(message);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

interface LoginOptions {
  cwd: string;
  lines?: string[];
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  openBrowser?: (url: string) => Promise<boolean>;
  ttyStdout?: boolean;
}

async function login(argv: string[], options: LoginOptions) {
  const stdout = collector();
  const stderr = collector();
  if (options.ttyStdout) (stdout.stream as { isTTY?: boolean }).isTTY = true;
  const code = await runLoginCommand(argv, {
    stdin: pipedInput(options.lines ?? []),
    stdout: stdout.stream,
    stderr: stderr.stream,
    cwd: options.cwd,
    env: options.env ?? { PATH: "" },
    fetch: options.fetch ?? syntheticHue().fetchImpl,
    openBrowser:
      options.openBrowser ??
      (() => Promise.reject(new Error("the browser must not open without a terminal"))),
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

async function mode(path: string): Promise<number> {
  return (await lstat(path)).mode & 0o777;
}

describe("hue login", () => {
  test("--help prints the usage and exits 0", async () => {
    const result = await login(["--help"], { cwd: await temporaryRoot() });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${LOGIN_USAGE}\n`);
    expect(result.stdout).toContain("Usage: hue login");
    expect(result.stderr).toBe("");
  });

  test("usage errors exit 2 with the usage text and touch nothing", async () => {
    const root = await temporaryRoot();
    for (const [argv, message] of [
      [["--unknown"], "Usage: hue login"],
      [["--keys", "nope"], "--keys must be evaluations, coding-agent or both."],
      [["extra"], "Unexpected argument: extra"],
      [["--origin", "http://hue.example"], "--origin must be an HTTPS origin"],
      [["--origin", "https://hue.example/app"], "--origin must be an HTTPS origin"],
    ] as const) {
      const result = await login([...argv], { cwd: root });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(message);
      expect(result.stdout).toBe("");
    }
    await expect(lstat(join(root, ".env.hue"))).rejects.toThrow();
  });

  test("validates one key for both uses, stores it with mode 0600 and never echoes it", async () => {
    const root = await temporaryRoot();
    const hue = syntheticHue();
    const result = await login(["login", "--origin", ORIGIN], {
      cwd: root,
      lines: [`  ${KEY}  `],
      fetch: hue.fetchImpl,
    });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Create a "Read and write" key at: ${SETTINGS_URL}`);
    expect(result.stdout).toContain("It is stored as HUE_API_KEY and HUE_MCP_KEY.");
    expect(result.stdout).toContain(
      'Paste the "Read and write" key (HUE_API_KEY and HUE_MCP_KEY): ',
    );
    expect(result.stdout).toContain('Evaluations access accepted for project "Synthetic".');
    expect(result.stdout).toContain("the Hue MCP server lists 2 tools");
    expect(result.stdout).toContain(
      `Stored the key (${KEY.length} chars) as HUE_API_KEY and HUE_MCP_KEY, with HUE_BASE_URL and HUE_MCP_URL, in .env.hue.`,
    );
    // A non-default origin stores its own MCP endpoint, so the printed next step carries it.
    expect(result.stdout).toContain(`hue mcp install --client claude-code --url ${ORIGIN}/api/mcp`);
    expect(result.stdout).toContain('hue eval --case "<name>" ./hue-agent.ts --env-file .env.hue');
    expect(result.stdout).not.toContain(KEY);
    expect(result.stdout).not.toContain("Opened");
    const envPath = join(root, ".env.hue");
    expect(await readFile(envPath, "utf8")).toBe(
      `HUE_API_KEY=${KEY}\nHUE_BASE_URL=${ORIGIN}\nHUE_MCP_KEY=${KEY}\nHUE_MCP_URL=${ORIGIN}/api/mcp\n`,
    );
    expect(await mode(envPath)).toBe(0o600);

    expect(hue.calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", `${ORIGIN}/api/v1/projects/current`],
      ["GET", `${ORIGIN}/api/v1/datasets`],
      ["POST", `${ORIGIN}/api/mcp`],
    ]);
    for (const call of hue.calls) expect(call.authorization).toBe(`Bearer ${KEY}`);
    const mcp = hue.calls[2]!;
    expect(mcp.headers.get("content-type")).toBe("application/json");
    expect(mcp.headers.get("accept")).toBe("application/json, text/event-stream");
    expect(JSON.parse(mcp.body ?? "null")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
  });

  test("maps origins to the MCP endpoint and refuses non-origin values", () => {
    expect(mcpUrlForOrigin("https://app.hue.run")).toBe("https://mcp.hue.run/mcp");
    expect(mcpUrlForOrigin("https://staging.hue.run")).toBe("https://mcp.staging.hue.run/mcp");
    expect(mcpUrlForOrigin("https://hue.example")).toBe("https://hue.example/api/mcp");
    expect(parseHueOrigin("https://app.hue.run/")).toBe("https://app.hue.run");
    expect(parseHueOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(parseHueOrigin("http://hue.example")).toBeNull();
    expect(parseHueOrigin("https://user:pw@hue.example")).toBeNull();
    expect(parseHueOrigin("https://hue.example/?x=1")).toBeNull();
    expect(parseHueOrigin("not a url")).toBeNull();
  });

  test("a rejected evaluations key exits 1 with a clear error and stores nothing", async () => {
    const root = await temporaryRoot();
    const hue = syntheticHue({ evalKeys: [], readKeys: [] });
    const result = await login(["--origin", ORIGIN], {
      cwd: root,
      lines: [KEY],
      fetch: hue.fetchImpl,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Hue rejected the evaluations key (HTTP 401).");
    expect(result.stderr).toContain(`Create a "Read and write" key at ${SETTINGS_URL}`);
    expect(result.stderr).toContain("Nothing was stored.");
    expect(result.stderr).not.toContain(KEY);
    expect(hue.calls).toHaveLength(1);
    await expect(lstat(join(root, ".env.hue"))).rejects.toThrow();
  });

  test("a key the MCP server rejects exits 1 and stores nothing for either use", async () => {
    const root = await temporaryRoot();
    const hue = syntheticHue({ mcpKeys: [MCP_KEY] });
    const result = await login(["--origin", ORIGIN], {
      cwd: root,
      lines: [KEY],
      fetch: hue.fetchImpl,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("The Hue MCP server rejected the coding-agent key (HTTP 403).");
    expect(result.stderr).toContain(`Create a "Read and write" key at ${SETTINGS_URL}`);
    expect(result.stderr).not.toContain(KEY);
    await expect(lstat(join(root, ".env.hue"))).rejects.toThrow();

    const only = await login(["--keys", "coding-agent", "--origin", ORIGIN], {
      cwd: root,
      lines: [MCP_KEY],
      fetch: syntheticHue().fetchImpl,
    });
    expect(only.code).toBe(0);
    expect(only.stdout).toContain('Paste the "Read and write" key (HUE_MCP_KEY): ');
    expect(only.stdout).not.toContain("Evaluations access accepted");
    expect(await readFile(join(root, ".env.hue"), "utf8")).toBe(
      `HUE_MCP_KEY=${MCP_KEY}\nHUE_MCP_URL=${ORIGIN}/api/mcp\n`,
    );
  });

  test("a Read key is refused for evaluations before anything is stored", async () => {
    const root = await temporaryRoot();
    const hue = syntheticHue();
    const result = await login(["--origin", ORIGIN], {
      cwd: root,
      lines: [READ_KEY],
      fetch: hue.fetchImpl,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "This key cannot use evaluations (HTTP 403); it is a Read or Tracing only key.",
    );
    expect(result.stderr).toContain(`Create a "Read and write" key at ${SETTINGS_URL}`);
    expect(result.stderr).not.toContain(READ_KEY);
    expect(hue.calls.map((call) => call.url)).toEqual([
      `${ORIGIN}/api/v1/projects/current`,
      `${ORIGIN}/api/v1/datasets`,
    ]);
    await expect(lstat(join(root, ".env.hue"))).rejects.toThrow();

    // A coding agent may be read-only, so a Read key is accepted when only HUE_MCP_KEY is asked for.
    const agentOnly = await login(["--keys", "coding-agent", "--origin", ORIGIN], {
      cwd: root,
      lines: [READ_KEY],
      fetch: syntheticHue().fetchImpl,
    });
    expect(agentOnly.code).toBe(0);
    expect(await readFile(join(root, ".env.hue"), "utf8")).toBe(
      `HUE_MCP_KEY=${READ_KEY}\nHUE_MCP_URL=${ORIGIN}/api/mcp\n`,
    );
  });

  test("refuses empty, URL-like and whitespace values before any request", async () => {
    const root = await temporaryRoot();
    for (const [line, reason] of [
      ["", "No key was entered."],
      ["https://app.hue.run/settings/integrations", "That looks like a URL, not a key."],
      ["hue live key", "A key cannot contain whitespace."],
    ]) {
      const hue = syntheticHue();
      const result = await login(["--keys", "evaluations", "--origin", ORIGIN], {
        cwd: root,
        lines: [line],
        fetch: hue.fetchImpl,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(reason);
      expect(hue.calls).toHaveLength(0);
    }
    expect(invalidKeyReason(`bad${"\u0000"}key`)).toBe("That does not look like a Hue key.");
    expect(invalidKeyReason("x".repeat(4097))).toBe("That does not look like a Hue key.");
    expect(invalidKeyReason(EVAL_KEY)).toBeNull();
    const ended = await login(["--keys", "evaluations", "--origin", ORIGIN], { cwd: root });
    expect(ended.code).toBe(1);
    expect(ended.stderr).toContain("No key was entered; input ended.");
    await expect(lstat(join(root, ".env.hue"))).rejects.toThrow();
  });

  test("merges into an existing env file and replaces a different value only with --force", async () => {
    const root = await temporaryRoot();
    const envPath = join(root, "config", ".env.local");
    await rm(envPath, { force: true });
    await writeFile(join(root, "placeholder"), "");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "config"));
    const original = `# local settings\nOTHER=1\nexport HUE_API_KEY="hue_live_previous"\nHUE_BASE_URL=${ORIGIN}\nTRAILING=yes\n`;
    await writeFile(envPath, original, { mode: 0o644 });

    const refused = await login(["--origin", ORIGIN, "--env-file", "config/.env.local"], {
      cwd: root,
      lines: [KEY],
    });
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain(
      "HUE_API_KEY is already stored in config/.env.local; a different value requires --force.",
    );
    expect(refused.stderr).toContain(
      "HUE_API_KEY in config/.env.local already has a different value; rerun with --force to replace it.",
    );
    expect(await readFile(envPath, "utf8")).toBe(original);

    const same = await login(
      ["--origin", ORIGIN, "--env-file", "config/.env.local", "--keys", "evaluations"],
      {
        cwd: root,
        lines: ["hue_live_previous"],
        fetch: syntheticHue({ evalKeys: ["hue_live_previous"] }).fetchImpl,
      },
    );
    expect(same.code).toBe(0);
    expect(await readFile(envPath, "utf8")).toBe(
      `# local settings\nOTHER=1\nexport HUE_API_KEY=hue_live_previous\nHUE_BASE_URL=${ORIGIN}\nTRAILING=yes\n`,
    );

    const forced = await login(["--origin", ORIGIN, "--env-file", "config/.env.local", "--force"], {
      cwd: root,
      lines: [KEY],
    });
    expect(forced.code).toBe(0);
    expect(await readFile(envPath, "utf8")).toBe(
      `# local settings\nOTHER=1\nexport HUE_API_KEY=${KEY}\nHUE_BASE_URL=${ORIGIN}\nTRAILING=yes\nHUE_MCP_KEY=${KEY}\nHUE_MCP_URL=${ORIGIN}/api/mcp\n`,
    );
    expect(await mode(envPath)).toBe(0o600);
    expect(forced.stdout).toContain("--env-file config/.env.local");
  });

  test("env text helpers keep unrelated lines and drop duplicate managed assignments", () => {
    expect(
      readEnvValue("A=1\nHUE_API_KEY='first'\nHUE_API_KEY=second # note\n", "HUE_API_KEY"),
    ).toBe("second");
    expect(readEnvValue('HUE_API_KEY="same" # keep this note\n', "HUE_API_KEY")).toBe("same");
    expect(readEnvValue("A=1\n", "HUE_API_KEY")).toBeUndefined();
    expect(mergeEnvText("", { HUE_API_KEY: "k" })).toBe("HUE_API_KEY=k\n");
    expect(mergeEnvText("A=1", { HUE_API_KEY: "k" })).toBe("A=1\nHUE_API_KEY=k\n");
    expect(
      mergeEnvText("HUE_API_KEY=old\n\n# keep\nHUE_API_KEY=older\nB=2\n", { HUE_API_KEY: "new" }),
    ).toBe("HUE_API_KEY=new\n\n# keep\nB=2\n");
  });

  test("refuses a symlinked env file and leaves its target untouched", async () => {
    const root = await temporaryRoot();
    const target = join(root, "target.env");
    await writeFile(target, "KEEP=1\n");
    await symlink(target, join(root, ".env.hue"));
    const hue = syntheticHue();
    const result = await login(["--origin", ORIGIN], {
      cwd: root,
      lines: [KEY],
      fetch: hue.fetchImpl,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("it is a symbolic link");
    expect(hue.calls).toHaveLength(0);
    expect(await readFile(target, "utf8")).toBe("KEEP=1\n");
    expect((await lstat(join(root, ".env.hue"))).isSymbolicLink()).toBe(true);
  });

  test("warns when git does not ignore the env file and --gitignore adds the rule once", async () => {
    const root = await temporaryRoot();
    const init = spawnSync("git", ["init", "-q"], { cwd: root });
    expect(init.status).toBe(0);
    const first = await login(["--origin", ORIGIN, "--keys", "evaluations"], {
      cwd: root,
      lines: [EVAL_KEY],
      env: process.env,
    });
    expect(first.code).toBe(0);
    expect(first.stderr).toContain("Warning: .env.hue is not ignored by git.");

    const fixed = await login(["--origin", ORIGIN, "--keys", "evaluations", "--gitignore"], {
      cwd: root,
      lines: [EVAL_KEY],
      env: process.env,
    });
    expect(fixed.code).toBe(0);
    expect(fixed.stderr).toBe("");
    expect(fixed.stdout).toContain("Added .env.hue to .gitignore.");
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(".env.hue\n");

    const again = await login(["--origin", ORIGIN, "--keys", "evaluations", "--gitignore"], {
      cwd: root,
      lines: [EVAL_KEY],
      env: process.env,
    });
    expect(again.code).toBe(0);
    expect(again.stderr).toBe("");
    expect(again.stdout).not.toContain("Added .env.hue");
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(".env.hue\n");
    const check = spawnSync("git", ["check-ignore", "-q", ".env.hue"], { cwd: root });
    expect(check.status).toBe(0);
  });

  test("a login protects the env file it wrote and adds no rule when nothing was stored", async () => {
    const root = await temporaryRoot();
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    const result = await login(["--origin", ORIGIN, "--gitignore"], {
      cwd: root,
      lines: [KEY],
      env: process.env,
    });
    expect(result.code).toBe(0);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(".env.hue\n");
    expect(spawnSync("git", ["check-ignore", "-q", ".env.hue"], { cwd: root }).status).toBe(0);

    // A run that stores nothing writes no rule and does not warn about a file it never wrote.
    const empty = await temporaryRoot();
    expect(spawnSync("git", ["init", "-q"], { cwd: empty }).status).toBe(0);
    const nothing = await login(["--origin", ORIGIN, "--keys", "evaluations", "--gitignore"], {
      cwd: empty,
      lines: ["hue_live_other_key"],
      fetch: syntheticHue().fetchImpl,
      env: process.env,
    });
    expect(nothing.code).toBe(1);
    expect(nothing.stdout).not.toContain("Added .env.hue");
    await expect(lstat(join(empty, ".gitignore"))).rejects.toThrow();
    await expect(lstat(join(empty, ".env.hue"))).rejects.toThrow();
  });

  test("opens the settings page only for a terminal and not with --no-browser", async () => {
    const root = await temporaryRoot();
    const opened: string[] = [];
    const openBrowser = (url: string) => {
      opened.push(url);
      return Promise.resolve(true);
    };
    const tty = await login(["--origin", ORIGIN, "--keys", "evaluations"], {
      cwd: root,
      lines: [EVAL_KEY],
      openBrowser,
      ttyStdout: true,
    });
    expect(tty.code).toBe(0);
    expect(opened).toEqual([SETTINGS_URL]);
    expect(tty.stdout).toContain("Opened the key settings page in your browser.");

    const quiet = await login(["--origin", ORIGIN, "--keys", "evaluations", "--no-browser"], {
      cwd: root,
      lines: [EVAL_KEY],
      openBrowser,
      ttyStdout: true,
    });
    expect(quiet.code).toBe(0);
    expect(opened).toHaveLength(1);

    const failing = await login(["--origin", ORIGIN, "--keys", "evaluations"], {
      cwd: root,
      lines: [EVAL_KEY],
      openBrowser: () => Promise.reject(new Error("no browser")),
      ttyStdout: true,
    });
    expect(failing.code).toBe(0);
    expect(failing.stdout).not.toContain("Opened");
  });

  test("uses the real fetch against a loopback Hue and reads an SSE tools/list answer", async () => {
    const root = await temporaryRoot();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const authorization = request.headers.get("authorization");
        if (url.pathname === "/api/v1/datasets") {
          if (authorization !== `Bearer ${KEY}`) return new Response(null, { status: 403 });
          return Response.json({ items: [], nextCursor: null });
        }
        if (url.pathname === "/api/v1/projects/current") {
          if (authorization !== `Bearer ${KEY}`) return new Response(null, { status: 401 });
          return Response.json({
            id: "22222222-2222-4222-8222-222222222222",
            name: "Loopback",
            slug: "loopback",
            organizationId: "33333333-3333-4333-8333-333333333333",
          });
        }
        if (url.pathname === "/api/mcp" && request.method === "POST") {
          if (authorization !== `Bearer ${KEY}`) return new Response(null, { status: 401 });
          const body = (await request.json()) as { method?: string; id?: number };
          const message = {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: body.method === "tools/list" ? [{ name: "get_project_context" }] : [],
            },
          };
          return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const stdout = collector();
      const stderr = collector();
      const code = await runLoginCommand(["--origin", origin], {
        stdin: pipedInput([KEY]),
        stdout: stdout.stream,
        stderr: stderr.stream,
        cwd: root,
        env: { PATH: "" },
      });
      expect(stderr.text()).toBe("");
      expect(code).toBe(0);
      expect(stdout.text()).toContain('Evaluations access accepted for project "Loopback".');
      expect(stdout.text()).toContain("lists 1 tools");
      expect(await readFile(join(root, ".env.hue"), "utf8")).toBe(
        `HUE_API_KEY=${KEY}\nHUE_BASE_URL=${origin}\nHUE_MCP_KEY=${KEY}\nHUE_MCP_URL=${origin}/api/mcp\n`,
      );
    } finally {
      server.stop(true);
    }
  });

  test("a terminal prompt mutes the echo behind raw mode and ^C exits 130", async () => {
    const root = await temporaryRoot();
    const hue = syntheticHue();
    const rawModes: boolean[] = [];
    const terminal = () => {
      const stdin = new PassThrough() as PassThrough & {
        isTTY?: boolean;
        setRawMode?: (mode: boolean) => PassThrough;
      };
      stdin.isTTY = true;
      stdin.setRawMode = (mode) => {
        rawModes.push(mode);
        return stdin;
      };
      return stdin;
    };
    const stdin = terminal();
    const stdout = collector();
    const run = runLoginCommand(["--origin", ORIGIN, "--keys", "evaluations", "--no-browser"], {
      stdin,
      stdout: stdout.stream,
      stderr: stdout.stream,
      cwd: root,
      env: { PATH: "" },
      fetch: hue.fetchImpl,
    });
    setTimeout(() => stdin.write(`${EVAL_KEY}\r`), 10);
    expect(await run).toBe(0);
    expect(rawModes).toEqual([true, false]);
    expect(stdout.text()).toContain('Paste the "Read and write" key (HUE_API_KEY): \n');
    expect(stdout.text()).not.toContain(EVAL_KEY);
    expect(await readFile(join(root, ".env.hue"), "utf8")).toBe(
      `HUE_API_KEY=${EVAL_KEY}\nHUE_BASE_URL=${ORIGIN}\n`,
    );

    const interruptedStdin = terminal();
    const interrupted = collector();
    const second = runLoginCommand(["--origin", ORIGIN, "--keys", "coding-agent", "--no-browser"], {
      stdin: interruptedStdin,
      stdout: interrupted.stream,
      stderr: interrupted.stream,
      cwd: root,
      env: { PATH: "" },
      fetch: hue.fetchImpl,
    });
    setTimeout(() => interruptedStdin.write(`partial${String.fromCharCode(3)}`), 10);
    expect(await second).toBe(130);
    // Nothing had been stored before the interrupt, so the message says exactly that.
    expect(interrupted.text()).toContain("Interrupted; nothing was stored.");
    expect(interrupted.text()).not.toContain("partial");
    expect(hue.calls).toHaveLength(2);
    expect(await readFile(join(root, ".env.hue"), "utf8")).toBe(
      `HUE_API_KEY=${EVAL_KEY}\nHUE_BASE_URL=${ORIGIN}\n`,
    );
  });
});
