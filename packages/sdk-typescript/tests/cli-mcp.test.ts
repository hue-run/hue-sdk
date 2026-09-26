import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  DEFAULT_MCP_URL,
  MCP_USAGE,
  MCP_VERIFY_PROMPT,
  parseMcpUrl,
  parseToolsets,
  readOnlyMcpUrl,
  renderMcpSignInSnippets,
  renderMcpSnippets,
  runMcpCommand,
  shellWord,
  toolsetsMcpUrl,
} from "../src/cli/mcp.js";

const roots: string[] = [];
async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hue-cli-mcp-")));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

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

async function mcp(argv: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  const stdout = collector();
  const stderr = collector();
  const code = await runMcpCommand(argv, {
    stdout: stdout.stream,
    stderr: stderr.stream,
    cwd: options.cwd,
    env: options.env ?? { PATH: join(options.cwd, "empty-bin") },
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/** A fake client CLI on PATH that records its arguments, one per line, and exits as told. */
async function fakeCli(root: string, name: string, exitCode = 0) {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const record = join(root, `${name}.args`);
  await writeFile(
    join(bin, name),
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(record)}\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  return {
    env: { PATH: bin, HUE_MCP_KEY: "hue_live_must_not_leak" },
    args: async () => (await readFile(record, "utf8")).replace(/\n$/u, "").split("\n"),
  };
}

async function mode(path: string): Promise<number> {
  return (await lstat(path)).mode & 0o777;
}

const CLAUDE_CODE_JSON = `{
  "mcpServers": {
    "hue": {
      "type": "http",
      "url": "https://mcp.hue.run/mcp",
      "headers": {
        "Authorization": "Bearer \${HUE_MCP_KEY}"
      }
    }
  }
}
`;
const CURSOR_JSON = `{
  "mcpServers": {
    "hue": {
      "url": "https://mcp.hue.run/mcp",
      "headers": {
        "Authorization": "Bearer \${env:HUE_MCP_KEY}"
      }
    }
  }
}
`;
const VSCODE_JSON = `{
  "servers": {
    "hue": {
      "type": "http",
      "url": "https://mcp.hue.run/mcp",
      "headers": {
        "Authorization": "Bearer \${input:hue-mcp-key}"
      }
    }
  },
  "inputs": [
    {
      "type": "promptString",
      "id": "hue-mcp-key",
      "description": "Hue Read or Read and write API key",
      "password": true
    }
  ]
}
`;
const WINDSURF_JSON = `{
  "mcpServers": {
    "hue": {
      "serverUrl": "https://mcp.hue.run/mcp",
      "headers": {
        "Authorization": "Bearer \${env:HUE_MCP_KEY}"
      }
    }
  }
}
`;
const CLAUDE_CODE_SIGN_IN_JSON = `{
  "mcpServers": {
    "hue": {
      "type": "http",
      "url": "https://mcp.hue.run/mcp"
    }
  }
}
`;
const CURSOR_OBSERVE_JSON = CURSOR_JSON.replace(
  "https://mcp.hue.run/mcp",
  "https://mcp.hue.run/mcp?toolsets=observe",
);
const CODEX_TOML = `[mcp_servers.hue]\nurl = "https://mcp.hue.run/mcp"\nbearer_token_env_var = "HUE_MCP_KEY"\n`;

describe("hue mcp install", () => {
  test("--help prints the usage and exits 0", async () => {
    const result = await mcp(["--help"], { cwd: await temporaryRoot() });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${MCP_USAGE}\n`);
    expect(result.stdout).toContain("Usage: hue mcp install --client");
    expect(result.stderr).toBe("");
  });

  test("usage errors exit 2 and write nothing", async () => {
    const root = await temporaryRoot();
    for (const argv of [
      [],
      ["mcp"],
      ["remove", "--client", "cursor"],
      ["install"],
      ["install", "--client", "emacs"],
      ["install", "--client", "cursor", "--scope", "user"],
      ["install", "--client", "cursor", "--scope", "global"],
      ["install", "--client", "cursor", "--url", "http://mcp.hue.run/mcp"],
      ["install", "--client", "cursor", "--bogus"],
    ]) {
      const result = await mcp(argv, { cwd: root });
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr.length).toBeGreaterThan(0);
    }
    expect(await readdir(root)).toEqual([]);
  });

  test("snippets match Hue's canonical shapes", () => {
    const snippets = renderMcpSnippets(DEFAULT_MCP_URL);
    expect(snippets.claudeCodeProjectJson).toBe(CLAUDE_CODE_JSON);
    expect(snippets.cursorJson).toBe(CURSOR_JSON);
    expect(snippets.vscodeJson).toBe(VSCODE_JSON);
    expect(snippets.windsurfJson).toBe(WINDSURF_JSON);
    expect(snippets.codexToml).toBe(CODEX_TOML);
    expect(snippets.codexCli.display).toBe(
      "codex mcp add hue --url https://mcp.hue.run/mcp --bearer-token-env-var HUE_MCP_KEY",
    );
    expect(snippets.claudeCodeCli.display).toBe(
      "claude mcp add --transport http --scope user hue https://mcp.hue.run/mcp --header 'Authorization: Bearer ${HUE_MCP_KEY}'",
    );
    expect(snippets.geminiCli.display).toBe(
      "gemini mcp add --scope user --transport http hue https://mcp.hue.run/mcp --header 'Authorization: Bearer ${HUE_MCP_KEY}'",
    );
    const signIn = renderMcpSignInSnippets(DEFAULT_MCP_URL);
    expect(signIn.claudeCodeProjectJson).toBe(CLAUDE_CODE_SIGN_IN_JSON);
    expect(signIn.claudeCodeCli.display).toBe(
      "claude mcp add --transport http --scope user hue https://mcp.hue.run/mcp",
    );
    expect(signIn.codexCli.display).toBe("codex mcp add hue --url https://mcp.hue.run/mcp");
    expect(JSON.stringify(signIn)).not.toContain("HUE_MCP_KEY");
    expect(readOnlyMcpUrl(DEFAULT_MCP_URL)).toBe("https://mcp.hue.run/mcp?read_only=true");
    expect(parseMcpUrl("https://mcp.staging.hue.run/mcp")).toBe("https://mcp.staging.hue.run/mcp");
    expect(parseMcpUrl("http://127.0.0.1:4000/api/mcp")).toBe("http://127.0.0.1:4000/api/mcp");
    expect(parseMcpUrl("http://mcp.hue.run/mcp")).toBeNull();
    expect(parseMcpUrl("https://u:p@mcp.hue.run/mcp")).toBeNull();
  });

  test("claude-code writes .mcp.json with the canonical content and mode 0644", async () => {
    const root = await temporaryRoot();
    const result = await mcp(["mcp", "install", "--client", "claude-code"], { cwd: root });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(CLAUDE_CODE_JSON);
    expect(await mode(join(root, ".mcp.json"))).toBe(0o644);
    expect(result.stdout).toContain(
      'Wrote .mcp.json with the "hue" MCP server (https://mcp.hue.run/mcp).',
    );
    expect(result.stdout).toContain("Export HUE_MCP_KEY in the shell that starts Claude Code");
    expect(result.stdout).toContain(".env.hue");
    expect(result.stdout).toContain(MCP_VERIFY_PROMPT);
  });

  test("cursor and vscode write their project files; --url selects staging", async () => {
    const root = await temporaryRoot();
    const cursor = await mcp(["install", "--client", "cursor"], { cwd: root });
    expect(cursor.code).toBe(0);
    // Cursor lists the observe profile unless --toolsets says otherwise.
    expect(await readFile(join(root, ".cursor", "mcp.json"), "utf8")).toBe(CURSOR_OBSERVE_JSON);
    expect(await mode(join(root, ".cursor", "mcp.json"))).toBe(0o644);
    expect(cursor.stdout).toContain("Wrote .cursor/mcp.json");

    const vscode = await mcp(["install", "--client", "vscode"], { cwd: root });
    expect(vscode.code).toBe(0);
    expect(await readFile(join(root, ".vscode", "mcp.json"), "utf8")).toBe(VSCODE_JSON);
    expect(vscode.stdout).toContain("VS Code prompts for the key (input hue-mcp-key)");
    expect(vscode.stdout).toContain(MCP_VERIFY_PROMPT);

    const staging = await mcp(
      ["install", "--client", "claude-code", "--url", "https://mcp.staging.hue.run/mcp"],
      { cwd: root },
    );
    expect(staging.code).toBe(0);
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(
      CLAUDE_CODE_JSON.replace("https://mcp.hue.run/mcp", "https://mcp.staging.hue.run/mcp"),
    );
  });

  test("merges with existing servers, replacing only the hue entry", async () => {
    const root = await temporaryRoot();
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            other: { command: "npx", args: ["other-server"] },
            hue: { type: "stdio", command: "stale" },
          },
          custom: true,
        },
        null,
        4,
      ),
    );
    const result = await mcp(["install", "--client", "claude-code"], { cwd: root });
    expect(result.code).toBe(0);
    const merged = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(merged).toEqual({
      mcpServers: {
        other: { command: "npx", args: ["other-server"] },
        hue: {
          type: "http",
          url: "https://mcp.hue.run/mcp",
          headers: { Authorization: "Bearer ${HUE_MCP_KEY}" },
        },
      },
      custom: true,
    });
    expect(Object.keys(merged)).toEqual(["mcpServers", "custom"]);

    await mkdir(join(root, ".vscode"));
    await writeFile(
      join(root, ".vscode", "mcp.json"),
      JSON.stringify({
        servers: { other: { type: "stdio", command: "x" } },
        inputs: [
          { type: "promptString", id: "other" },
          { type: "promptString", id: "hue-mcp-key" },
        ],
      }),
    );
    const vscode = await mcp(["install", "--client", "vscode"], { cwd: root });
    expect(vscode.code).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".vscode", "mcp.json"), "utf8"))).toEqual({
      servers: {
        other: { type: "stdio", command: "x" },
        hue: {
          type: "http",
          url: "https://mcp.hue.run/mcp",
          headers: { Authorization: "Bearer ${input:hue-mcp-key}" },
        },
      },
      inputs: [
        { type: "promptString", id: "other" },
        {
          type: "promptString",
          id: "hue-mcp-key",
          description: "Hue Read or Read and write API key",
          password: true,
        },
      ],
    });
  });

  test("refuses invalid JSON, a non-object file and a symlinked config", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, ".mcp.json"), '{ "mcpServers": { /* comment */ } }');
    const invalid = await mcp(["install", "--client", "claude-code"], { cwd: root });
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain(".mcp.json is not valid JSON");
    expect(invalid.stderr).toContain('"Authorization": "Bearer ${HUE_MCP_KEY}"');
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(
      '{ "mcpServers": { /* comment */ } }',
    );

    await writeFile(join(root, ".mcp.json"), '{ "mcpServers": [] }');
    const shape = await mcp(["install", "--client", "claude-code"], { cwd: root });
    expect(shape.code).toBe(1);
    expect(shape.stderr).toContain('"mcpServers" must be a JSON object');

    await mkdir(join(root, ".cursor"));
    await writeFile(join(root, "elsewhere.json"), "{}\n");
    await symlink(join(root, "elsewhere.json"), join(root, ".cursor", "mcp.json"));
    const linked = await mcp(["install", "--client", "cursor"], { cwd: root });
    expect(linked.code).toBe(1);
    expect(linked.stderr).toContain("symbolic link");
    expect(await readFile(join(root, "elsewhere.json"), "utf8")).toBe("{}\n");
  });

  test("--dry-run prints the resulting content and --print prints only the snippet", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { other: {} } }));
    const dry = await mcp(["install", "--client", "claude-code", "--dry-run"], { cwd: root });
    expect(dry.code).toBe(0);
    expect(dry.stdout.startsWith("Would write .mcp.json:\n{\n")).toBe(true);
    expect(dry.stdout).toContain('"other": {}');
    expect(dry.stdout).toContain('"Authorization": "Bearer ${HUE_MCP_KEY}"');
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(
      JSON.stringify({ mcpServers: { other: {} } }),
    );

    const printed = await mcp(["install", "--client", "cursor", "--print"], { cwd: root });
    expect(printed.code).toBe(0);
    expect(printed.stdout).toBe(CURSOR_OBSERVE_JSON);
    await expect(lstat(join(root, ".cursor"))).rejects.toThrow();

    const toml = await mcp(["install", "--client", "codex", "--print"], { cwd: root });
    expect(toml.stdout).toBe(CODEX_TOML);
    const cliDry = await mcp(["install", "--client", "gemini", "--dry-run"], { cwd: root });
    expect(cliDry.code).toBe(0);
    expect(cliDry.stdout).toBe(
      "Would run: gemini mcp add --scope user --transport http hue https://mcp.hue.run/mcp --header 'Authorization: Bearer ${HUE_MCP_KEY}'\n",
    );
  });

  test("windsurf prints the snippet with its path hint and writes nothing", async () => {
    const root = await temporaryRoot();
    const result = await mcp(["install", "--client", "windsurf"], { cwd: root });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("~/.codeium/windsurf/mcp_config.json");
    expect(result.stdout).toContain(WINDSURF_JSON);
    expect(result.stdout).toContain(MCP_VERIFY_PROMPT);
    expect(await readdir(root)).toEqual([]);
  });

  test("codex prints the TOML block when its CLI is absent and runs it when present", async () => {
    const root = await temporaryRoot();
    const absent = await mcp(["install", "--client", "codex"], { cwd: root });
    expect(absent.code).toBe(0);
    expect(absent.stdout).toContain("codex is not on PATH");
    expect(absent.stdout).toContain("~/.codex/config.toml");
    expect(absent.stdout).toContain(CODEX_TOML.trimEnd());
    expect(absent.stdout).toContain(
      "codex mcp add hue --url https://mcp.hue.run/mcp --bearer-token-env-var HUE_MCP_KEY",
    );

    const fake = await fakeCli(root, "codex");
    const present = await mcp(["install", "--client", "codex"], { cwd: root, env: fake.env });
    expect(present.code).toBe(0);
    expect(await fake.args()).toEqual([
      "mcp",
      "add",
      "hue",
      "--url",
      "https://mcp.hue.run/mcp",
      "--bearer-token-env-var",
      "HUE_MCP_KEY",
    ]);
    expect(present.stdout).toContain(
      'Registered the "hue" MCP server (https://mcp.hue.run/mcp) with Codex.',
    );
    expect(present.stdout).toContain(MCP_VERIFY_PROMPT);
    expect(present.stdout).not.toContain("hue_live_must_not_leak");
  });

  test("claude-code --scope user runs claude mcp add or prints the command", async () => {
    const root = await temporaryRoot();
    const absent = await mcp(["install", "--client", "claude-code", "--scope", "user"], {
      cwd: root,
    });
    expect(absent.code).toBe(0);
    expect(absent.stdout).toContain("claude is not on PATH");
    expect(absent.stdout).toContain(
      "claude mcp add --transport http --scope user hue https://mcp.hue.run/mcp --header 'Authorization: Bearer ${HUE_MCP_KEY}'",
    );
    expect(await readdir(root)).toEqual([]);

    const fake = await fakeCli(root, "claude");
    const present = await mcp(["install", "--client", "claude-code", "--scope", "user"], {
      cwd: root,
      env: fake.env,
    });
    expect(present.code).toBe(0);
    expect(await fake.args()).toEqual([
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "user",
      "hue",
      "https://mcp.hue.run/mcp",
      "--header",
      "Authorization: Bearer ${HUE_MCP_KEY}",
    ]);
    await expect(lstat(join(root, ".mcp.json"))).rejects.toThrow();
  });

  test("gemini passes the literal ${HUE_MCP_KEY} reference and reports a failing CLI", async () => {
    const root = await temporaryRoot();
    const fake = await fakeCli(root, "gemini");
    const present = await mcp(["install", "--client", "gemini"], { cwd: root, env: fake.env });
    expect(present.code).toBe(0);
    expect(await fake.args()).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "--transport",
      "http",
      "hue",
      "https://mcp.hue.run/mcp",
      "--header",
      "Authorization: Bearer ${HUE_MCP_KEY}",
    ]);

    const failing = await fakeCli(root, "gemini", 3);
    const failed = await mcp(["install", "--client", "gemini"], { cwd: root, env: failing.env });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("gemini exited with code 3.");
    expect(failed.stderr).toContain("--header 'Authorization: Bearer ${HUE_MCP_KEY}'");
    expect(failed.stdout).not.toContain(MCP_VERIFY_PROMPT);
  });

  test("the verification prompt asks what needs attention and falls back to recent traces", () => {
    // list_projects answers for every credential, so the prompt starts there.
    expect(MCP_VERIFY_PROMPT.startsWith("Use the Hue MCP: call list_projects")).toBe(true);
    expect(MCP_VERIFY_PROMPT).toContain("pass the project's id as project_id");
    expect(MCP_VERIFY_PROMPT).toContain("get_project_context");
    expect(MCP_VERIFY_PROMPT).toContain("need attention or have errors");
    expect(MCP_VERIFY_PROMPT).toContain("5 most recent traces");
  });

  test("--auth oauth writes and registers the URL only, with sign-in next steps", async () => {
    const root = await temporaryRoot();
    const project = await mcp(["install", "--client", "claude-code", "--auth", "oauth"], {
      cwd: root,
      env: { PATH: join(root, "empty-bin"), HUE_MCP_KEY: "hue_live_must_not_leak" },
    });
    expect(project.stderr).toBe("");
    expect(project.code).toBe(0);
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(CLAUDE_CODE_SIGN_IN_JSON);
    expect(project.stdout).toContain("run /mcp, select hue and choose Authenticate");
    expect(project.stdout).toContain("approve the connection");
    expect(project.stdout).toContain("use a Read project key with --auth key");
    expect(project.stdout).not.toContain("Export HUE_MCP_KEY");
    expect(project.stdout).toContain(MCP_VERIFY_PROMPT);

    const claude = await fakeCli(root, "claude");
    const user = await mcp(
      ["install", "--client", "claude-code", "--auth", "oauth", "--scope", "user"],
      { cwd: root, env: claude.env },
    );
    expect(user.code).toBe(0);
    expect(await claude.args()).toEqual([
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "user",
      "hue",
      "https://mcp.hue.run/mcp",
    ]);

    const codex = await fakeCli(root, "codex");
    const registered = await mcp(["install", "--client", "codex", "--auth", "oauth"], {
      cwd: root,
      env: codex.env,
    });
    expect(registered.code).toBe(0);
    expect(await codex.args()).toEqual(["mcp", "add", "hue", "--url", "https://mcp.hue.run/mcp"]);
    expect(registered.stdout).toContain("codex mcp login hue");
    expect(registered.stdout).not.toContain("hue_live_must_not_leak");

    const printed = await mcp(["install", "--client", "codex", "--auth", "oauth", "--print"], {
      cwd: root,
    });
    expect(printed.stdout).toBe('[mcp_servers.hue]\nurl = "https://mcp.hue.run/mcp"\n');
  });

  test("--auth oauth is refused where sign-in does not work, and with read-only", async () => {
    const root = await temporaryRoot();
    for (const client of ["cursor", "vscode", "windsurf", "gemini"]) {
      const result = await mcp(["install", "--client", client, "--auth", "oauth"], { cwd: root });
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("--auth oauth is");
    }
    const cursor = await mcp(["install", "--client", "cursor", "--auth", "oauth"], { cwd: root });
    expect(cursor.stderr).toContain("Cursor's sign-in callback");
    for (const argv of [
      ["install", "--client", "claude-code", "--auth", "oauth", "--read-only"],
      ["install", "--client", "conductor", "--read-only"],
      [
        "install",
        "--client",
        "codex",
        "--auth",
        "oauth",
        "--url",
        "https://mcp.hue.run/mcp?read_only=true",
      ],
      ["install", "--client", "codex", "--auth", "password"],
    ]) {
      const result = await mcp(argv, { cwd: root });
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
    }
    expect(await readdir(root)).toEqual([]);
  });

  test("--read-only adds read_only=true to a key configuration's URL", async () => {
    const root = await temporaryRoot();
    const result = await mcp(["install", "--client", "cursor", "--read-only"], { cwd: root });
    expect(result.code).toBe(0);
    expect(await readFile(join(root, ".cursor", "mcp.json"), "utf8")).toBe(
      CURSOR_JSON.replace(
        "https://mcp.hue.run/mcp",
        "https://mcp.hue.run/mcp?read_only=true&toolsets=observe",
      ),
    );
    expect(result.stdout).toContain("(https://mcp.hue.run/mcp?read_only=true&toolsets=observe)");

    const fake = await fakeCli(root, "codex");
    const codex = await mcp(["install", "--client", "codex", "--read-only"], {
      cwd: root,
      env: fake.env,
    });
    expect(codex.code).toBe(0);
    expect(await fake.args()).toEqual([
      "mcp",
      "add",
      "hue",
      "--url",
      "https://mcp.hue.run/mcp?read_only=true",
      "--bearer-token-env-var",
      "HUE_MCP_KEY",
    ]);
    // A printed command quotes the URL: `?` is a zsh glob and `&` would end the command.
    expect(codex.stdout).toContain(
      "Running: codex mcp add hue --url 'https://mcp.hue.run/mcp?read_only=true' --bearer-token-env-var HUE_MCP_KEY",
    );
    const claude = await mcp(
      ["install", "--client", "claude-code", "--scope", "user", "--read-only", "--print"],
      { cwd: root },
    );
    expect(claude.stdout).toBe(
      "claude mcp add --transport http --scope user hue 'https://mcp.hue.run/mcp?read_only=true' --header 'Authorization: Bearer ${HUE_MCP_KEY}'\n",
    );
    expect(shellWord("https://mcp.hue.run/mcp")).toBe("https://mcp.hue.run/mcp");
    expect(shellWord("https://h.example/mcp?a=1&b='2'")).toBe(
      String.raw`'https://h.example/mcp?a=1&b='\''2'\'''`,
    );
  });

  test("conductor signs in by default and registers with Claude Code and Codex", async () => {
    const root = await temporaryRoot();
    const absent = await mcp(["install", "--client", "conductor"], { cwd: root });
    expect(absent.code).toBe(0);
    expect(absent.stdout).toContain("claude is not on PATH");
    expect(absent.stdout).toContain(
      "claude mcp add --transport http --scope user hue https://mcp.hue.run/mcp",
    );
    expect(absent.stdout).toContain("codex is not on PATH");
    expect(absent.stdout).toContain("codex mcp add hue --url https://mcp.hue.run/mcp");
    expect(absent.stdout).toContain("/mcp-status");
    expect(absent.stdout).toContain(MCP_VERIFY_PROMPT);
    expect(await readdir(root)).toEqual([]);

    const dry = await mcp(["install", "--client", "conductor", "--dry-run"], { cwd: root });
    expect(dry.stdout).toBe(
      "Would run: claude mcp add --transport http --scope user hue https://mcp.hue.run/mcp\n" +
        "Would run: codex mcp add hue --url https://mcp.hue.run/mcp\n",
    );

    const claude = await fakeCli(root, "claude");
    const codex = await fakeCli(root, "codex");
    const both = await mcp(["install", "--client", "conductor"], { cwd: root, env: codex.env });
    expect(both.code).toBe(0);
    expect(await claude.args()).toEqual([
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "user",
      "hue",
      "https://mcp.hue.run/mcp",
    ]);
    expect(await codex.args()).toEqual(["mcp", "add", "hue", "--url", "https://mcp.hue.run/mcp"]);
    expect(both.stdout).toContain("with Claude Code.");
    expect(both.stdout).toContain("with Codex.");

    const key = await mcp(["install", "--client", "conductor", "--auth", "key"], {
      cwd: root,
      env: codex.env,
    });
    expect(key.code).toBe(0);
    expect((await claude.args()).at(-1)).toBe("Authorization: Bearer ${HUE_MCP_KEY}");
    expect(await codex.args()).toContain("--bearer-token-env-var");
    expect(key.stdout).toContain("login-shell environment Conductor captures");
    expect(key.stdout).not.toContain("hue_live_must_not_leak");
  });

  test("conductor still registers with Codex when Claude Code fails, then exits 1", async () => {
    const root = await temporaryRoot();
    await fakeCli(root, "claude", 4);
    const codex = await fakeCli(root, "codex");
    const result = await mcp(["install", "--client", "conductor"], { cwd: root, env: codex.env });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("claude exited with code 4.");
    expect(await codex.args()).toEqual(["mcp", "add", "hue", "--url", "https://mcp.hue.run/mcp"]);
    expect(result.stdout).toContain("with Codex.");
    expect(result.stdout).not.toContain(MCP_VERIFY_PROMPT);
  });

  test("--toolsets adds ?toolsets= to a key URL and refuses unknown names", async () => {
    expect(parseToolsets("observe")).toEqual({ toolsets: "observe" });
    expect(parseToolsets("traces, docs,traces")).toEqual({ toolsets: "traces,docs" });
    expect(parseToolsets("obsrve")).toEqual({
      error:
        "Unknown toolset: obsrve. Choose from all, observe, project, traces, evals, environments, intents, docs.",
    });
    expect("error" in parseToolsets("observe,")).toBe(true);
    expect(toolsetsMcpUrl("https://mcp.hue.run/mcp?read_only=true", "traces,docs")).toBe(
      "https://mcp.hue.run/mcp?read_only=true&toolsets=traces,docs",
    );
    expect(toolsetsMcpUrl("https://mcp.hue.run/mcp?toolsets=all", "observe")).toBe(
      "https://mcp.hue.run/mcp?toolsets=observe",
    );

    const root = await temporaryRoot();
    const claude = await mcp(["install", "--client", "claude-code", "--toolsets", "observe"], {
      cwd: root,
    });
    expect(claude.code).toBe(0);
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(
      CLAUDE_CODE_JSON.replace(
        "https://mcp.hue.run/mcp",
        "https://mcp.hue.run/mcp?toolsets=observe",
      ),
    );
    const fake = await fakeCli(root, "codex");
    const codex = await mcp(["install", "--client", "codex", "--toolsets", "traces,docs"], {
      cwd: root,
      env: fake.env,
    });
    expect(codex.code).toBe(0);
    expect((await fake.args())[4]).toBe("https://mcp.hue.run/mcp?toolsets=traces,docs");
    expect(codex.stdout).toContain("--url 'https://mcp.hue.run/mcp?toolsets=traces,docs'");

    const everything = await mcp(
      ["install", "--client", "cursor", "--toolsets", "all", "--print"],
      {
        cwd: root,
      },
    );
    expect(everything.stdout).toBe(CURSOR_JSON);
    // --toolsets replaces a selection in --url; without the flag, the URL's selection is kept.
    const withUrl = (selection: string) => [
      "install",
      "--client",
      "cursor",
      "--print",
      "--url",
      `https://mcp.hue.run/mcp?read_only=true&toolsets=${selection}`,
    ];
    expect((await mcp([...withUrl("observe"), "--toolsets", "all"], { cwd: root })).stdout).toBe(
      CURSOR_JSON.replace("https://mcp.hue.run/mcp", "https://mcp.hue.run/mcp?read_only=true"),
    );
    expect((await mcp(withUrl("traces"), { cwd: root })).stdout).toBe(
      CURSOR_JSON.replace(
        "https://mcp.hue.run/mcp",
        "https://mcp.hue.run/mcp?read_only=true&toolsets=traces",
      ),
    );
    expect(toolsetsMcpUrl("https://mcp.hue.run/mcp?toolsets=observe", undefined)).toBe(
      "https://mcp.hue.run/mcp",
    );
    const unknown = await mcp(["install", "--client", "cursor", "--toolsets", "obsrve"], {
      cwd: root,
    });
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("Unknown toolset: obsrve.");
  });

  test("a sign-in toolset selection travels in a header, never in the URL", async () => {
    const root = await temporaryRoot();
    const project = await mcp(
      ["install", "--client", "claude-code", "--auth", "oauth", "--toolsets", "observe"],
      { cwd: root },
    );
    expect(project.code).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: {
        hue: {
          type: "http",
          url: "https://mcp.hue.run/mcp",
          headers: { "X-Hue-MCP-Toolsets": "observe" },
        },
      },
    });

    const claude = await fakeCli(root, "claude");
    const codex = await fakeCli(root, "codex");
    const conductor = await mcp(["install", "--client", "conductor", "--toolsets", "observe"], {
      cwd: root,
      env: codex.env,
    });
    expect(conductor.code).toBe(0);
    expect(await claude.args()).toEqual([
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "user",
      "hue",
      "https://mcp.hue.run/mcp",
      "--header",
      "X-Hue-MCP-Toolsets: observe",
    ]);
    expect(await codex.args()).toEqual(["mcp", "add", "hue", "--url", "https://mcp.hue.run/mcp"]);
    expect(conductor.stdout).toContain('http_headers = { "X-Hue-MCP-Toolsets" = "observe" }');

    const toml = await mcp(
      ["install", "--client", "codex", "--auth", "oauth", "--toolsets", "observe", "--print"],
      { cwd: root },
    );
    expect(toml.stdout).toBe(
      '[mcp_servers.hue]\nurl = "https://mcp.hue.run/mcp"\nhttp_headers = { "X-Hue-MCP-Toolsets" = "observe" }\n',
    );
    const inUrl = await mcp(
      [
        "install",
        "--client",
        "codex",
        "--auth",
        "oauth",
        "--url",
        "https://mcp.hue.run/mcp?toolsets=observe",
      ],
      { cwd: root },
    );
    expect(inUrl.code).toBe(2);
    expect(inUrl.stderr).toContain("Leave toolsets off a sign-in URL");
  });
});
