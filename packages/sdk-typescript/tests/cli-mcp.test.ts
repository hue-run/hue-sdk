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
  renderMcpSnippets,
  runMcpCommand,
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
      "description": "Hue coding-agent key",
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
      "gemini mcp add --transport http hue https://mcp.hue.run/mcp -H 'Authorization: Bearer $HUE_MCP_KEY'",
    );
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
    expect(await readFile(join(root, ".cursor", "mcp.json"), "utf8")).toBe(CURSOR_JSON);
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
          description: "Hue coding-agent key",
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
    expect(printed.stdout).toBe(CURSOR_JSON);
    await expect(lstat(join(root, ".cursor"))).rejects.toThrow();

    const toml = await mcp(["install", "--client", "codex", "--print"], { cwd: root });
    expect(toml.stdout).toBe(CODEX_TOML);
    const cliDry = await mcp(["install", "--client", "gemini", "--dry-run"], { cwd: root });
    expect(cliDry.code).toBe(0);
    expect(cliDry.stdout).toBe(
      "Would run: gemini mcp add --transport http hue https://mcp.hue.run/mcp -H 'Authorization: Bearer $HUE_MCP_KEY'\n",
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

  test("gemini passes the literal $HUE_MCP_KEY reference and reports a failing CLI", async () => {
    const root = await temporaryRoot();
    const fake = await fakeCli(root, "gemini");
    const present = await mcp(["install", "--client", "gemini"], { cwd: root, env: fake.env });
    expect(present.code).toBe(0);
    expect(await fake.args()).toEqual([
      "mcp",
      "add",
      "--transport",
      "http",
      "hue",
      "https://mcp.hue.run/mcp",
      "-H",
      "Authorization: Bearer $HUE_MCP_KEY",
    ]);

    const failing = await fakeCli(root, "gemini", 3);
    const failed = await mcp(["install", "--client", "gemini"], { cwd: root, env: failing.env });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("gemini exited with code 3.");
    expect(failed.stderr).toContain("-H 'Authorization: Bearer $HUE_MCP_KEY'");
  });
});
