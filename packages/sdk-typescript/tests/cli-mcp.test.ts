import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  chown,
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
import { chownSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  DEFAULT_MCP_URL,
  MCP_USAGE,
  MCP_VERIFY_PROMPT,
  parseMcpUrl,
  parseProject,
  parseToolsets,
  projectMcpUrl,
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
const CODEX_TOML = `[mcp_servers.hue]\nurl = "https://mcp.hue.run/mcp"\nbearer_token_env_var = "HUE_MCP_KEY"\nsupports_parallel_tool_calls = true\n`;
/** Claude Code, Codex and Conductor list every tool unless --toolsets says otherwise. */
const ALL_URL = "https://mcp.hue.run/mcp?toolsets=all";
const CLAUDE_CODE_ALL_JSON = CLAUDE_CODE_JSON.replace("https://mcp.hue.run/mcp", ALL_URL);
const CODEX_ALL_TOML = CODEX_TOML.replace("https://mcp.hue.run/mcp", ALL_URL);

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
    expect(signIn.codexToml).toBe(
      '[mcp_servers.hue]\nurl = "https://mcp.hue.run/mcp"\nsupports_parallel_tool_calls = true\n',
    );
    expect(JSON.stringify(signIn)).not.toContain("HUE_MCP_KEY");
    // A sign-in URL carries the selection; the TOML keeps its URL bare and sends the header.
    const signInAll = renderMcpSignInSnippets(ALL_URL);
    expect(signInAll.claudeCodeCli.display).toBe(
      "claude mcp add --transport http --scope user hue 'https://mcp.hue.run/mcp?toolsets=all'",
    );
    expect(signInAll.codexCli.args).toEqual(["mcp", "add", "hue", "--url", ALL_URL]);
    expect(signInAll.codexToml).toBe(
      '[mcp_servers.hue]\nurl = "https://mcp.hue.run/mcp"\nhttp_headers = { "X-Hue-MCP-Toolsets" = "all" }\nsupports_parallel_tool_calls = true\n',
    );
    expect(readOnlyMcpUrl(DEFAULT_MCP_URL)).toBe("https://mcp.hue.run/mcp?read_only=true");
    expect(parseMcpUrl("https://mcp.staging.hue.run/mcp")).toBe("https://mcp.staging.hue.run/mcp");
    expect(parseMcpUrl("http://127.0.0.1:4000/api/mcp")).toBe("http://127.0.0.1:4000/api/mcp");
    expect(parseMcpUrl("http://mcp.hue.run/mcp")).toBeNull();
    expect(parseMcpUrl("https://u:p@mcp.hue.run/mcp")).toBeNull();
  });

  test("claude-code writes a new .mcp.json with the canonical content, owner-only", async () => {
    const root = await temporaryRoot();
    const result = await mcp(["mcp", "install", "--client", "claude-code"], { cwd: root });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(CLAUDE_CODE_ALL_JSON);
    // People and clients add other servers' literal tokens to this file later.
    expect(await mode(join(root, ".mcp.json"))).toBe(0o600);
    expect(await readdir(root)).toEqual([".mcp.json"]);
    expect(result.stdout).toContain(`Wrote .mcp.json with the "hue" MCP server (${ALL_URL}).`);
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
    expect(await mode(join(root, ".cursor", "mcp.json"))).toBe(0o600);
    expect(cursor.stdout).toContain("Wrote .cursor/mcp.json");

    // VS Code keeps Hue's default list: the production reads and the catalog tools.
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
      CLAUDE_CODE_JSON.replace(
        "https://mcp.hue.run/mcp",
        "https://mcp.staging.hue.run/mcp?toolsets=all",
      ),
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
          url: ALL_URL,
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

  test("a replaced file keeps its mode, so one kept at 0600 for its tokens is not widened", async () => {
    const root = await temporaryRoot();
    const token = "ghp_kept_owner_only_0000000000";
    const existing = {
      mcpServers: { github: { type: "http", headers: { Authorization: `Bearer ${token}` } } },
    };
    await writeFile(join(root, ".mcp.json"), JSON.stringify(existing), { mode: 0o600 });
    await chmod(join(root, ".mcp.json"), 0o600);
    const result = await mcp(["install", "--client", "claude-code"], { cwd: root });
    expect(result.code).toBe(0);
    expect(await mode(join(root, ".mcp.json"))).toBe(0o600);
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toContain(token);

    // Other modes are kept as they are, neither widened nor narrowed.
    await mkdir(join(root, ".cursor"));
    await writeFile(join(root, ".cursor", "mcp.json"), "{}\n");
    await chmod(join(root, ".cursor", "mcp.json"), 0o640);
    expect((await mcp(["install", "--client", "cursor"], { cwd: root })).code).toBe(0);
    expect(await mode(join(root, ".cursor", "mcp.json"))).toBe(0o640);
    await chmod(join(root, ".cursor", "mcp.json"), 0o644);
    expect((await mcp(["install", "--client", "cursor"], { cwd: root })).code).toBe(0);
    expect(await mode(join(root, ".cursor", "mcp.json"))).toBe(0o644);
    // Except that other accounts lose write access, which would let them add a command to run.
    await chmod(join(root, ".cursor", "mcp.json"), 0o666);
    expect((await mcp(["install", "--client", "cursor"], { cwd: root })).code).toBe(0);
    expect(await mode(join(root, ".cursor", "mcp.json"))).toBe(0o664);
    expect((await readdir(join(root, ".cursor"))).sort()).toEqual(["mcp.json"]);
  });

  // A group this account can give a file, other than the one a new file gets: the process's
  // (Linux) or the directory's (macOS). A container may list a group it cannot map.
  const otherGroup = (() => {
    const directory = mkdtempSync(join(tmpdir(), "hue-cli-mcp-group-"));
    const probe = join(directory, "probe");
    writeFileSync(probe, "");
    const temporaryGroup = statSync(realpathSync(directory)).gid;
    try {
      return process
        .getgroups?.()
        .filter((gid) => gid !== process.getegid?.() && gid !== temporaryGroup)
        .find((gid) => {
          try {
            chownSync(probe, process.getuid!(), gid);
            return true;
          } catch {
            return false;
          }
        });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  })();
  test.skipIf(otherGroup === undefined)(
    "a replaced file keeps its group, so no other group can read it",
    async () => {
      const root = await temporaryRoot();
      const file = join(root, ".mcp.json");
      await writeFile(file, "{}\n");
      await chown(file, process.getuid!(), otherGroup!);
      await chmod(file, 0o640);
      const defaultGroup = (await lstat(root)).gid;
      expect(defaultGroup).not.toBe(otherGroup);
      expect((await mcp(["install", "--client", "claude-code"], { cwd: root })).code).toBe(0);
      expect((await lstat(file)).gid).toBe(otherGroup!);
      expect(await mode(file)).toBe(0o640);
      // A mode that denies the group only protects the file while it keeps that group.
      await chmod(file, 0o604);
      expect((await mcp(["install", "--client", "claude-code"], { cwd: root })).code).toBe(0);
      expect((await lstat(file)).gid).toBe(otherGroup!);
      expect(await mode(file)).toBe(0o604);
    },
  );

  test("refuses a symbolic link to the config's directory, but not to the working directory", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const token = "ghp_outside_the_project_000000";
    const elsewhere = JSON.stringify({
      mcpServers: { other: { headers: { Authorization: `Bearer ${token}` } } },
    });
    await writeFile(join(outside, "mcp.json"), elsewhere);
    await symlink(outside, join(root, ".cursor"));
    for (const argv of [
      ["install", "--client", "cursor"],
      ["install", "--client", "cursor", "--dry-run"],
    ]) {
      const linked = await mcp(argv, { cwd: root });
      expect(linked.code).toBe(1);
      expect(linked.stdout).toBe("");
      expect(linked.stderr).toContain(
        "Refusing to use .cursor/mcp.json: .cursor is a symbolic link.",
      );
      expect(linked.stderr).not.toContain(token);
    }
    expect(await readFile(join(outside, "mcp.json"), "utf8")).toBe(elsewhere);
    expect(await readdir(outside)).toEqual(["mcp.json"]);

    // The working directory itself may be reached through a link, as /tmp, /var and some home
    // directories are on macOS; only the directories the command names below it are checked.
    await symlink(root, join(outside, "project"));
    const viaLink = await mcp(["install", "--client", "vscode"], { cwd: join(outside, "project") });
    expect(viaLink.code).toBe(0);
    expect(await readFile(join(root, ".vscode", "mcp.json"), "utf8")).toBe(VSCODE_JSON);
  });

  test("--dry-run redacts literal credentials and keeps references and Hue's entry", async () => {
    const root = await temporaryRoot();
    const secrets = [
      "ghp_header0000000000000000000",
      "plain-custom-header-value",
      "sk-literal-argument-0000000",
      "tok_inline_option_123456",
      "literal-env-value",
      "query-credential-value",
      "hue_sk_literal0000000000000",
      "top-level-client-secret",
      "short-key-option-value",
      "auth-inline-value",
      "plain-key-field-value",
      "NjM4ZTk5path0token7",
      "987654321",
      "short-header-option-value",
      "inline-header-option-value",
      "ghp_defaultliteral123456789",
      "access-key-option-value",
      "secret-key-field-value",
      "auth-header-field-value",
      "root-servers-token-value",
      "stray-server-token-value",
      "Abc123Def456Ghi789Jkl",
      "docker-env-option-value",
      "bare-assignment-value",
    ];
    const existing = JSON.stringify({
      mcpServers: {
        github: {
          type: "http",
          url: "https://api.example.com/mcp/",
          headers: {
            Authorization: `Bearer ${secrets[0]}`,
            "X-Custom": secrets[1],
            "X-Default": `\${env:-${secrets[15]}}`,
          },
        },
        local: {
          command: "npx",
          args: [
            "-y",
            "some-server",
            "--api-key",
            secrets[2],
            `--token=${secrets[3]}`,
            "--key",
            secrets[8],
            `--auth=${secrets[9]}`,
            "-H",
            `X-Custom: ${secrets[13]}`,
            `--header=X-Other: ${secrets[14]}`,
            "--access-key",
            secrets[16],
            `--url=https://mcp.example.com/s/${secrets[21]}/sse`,
            "-e",
            `DEBUG=${secrets[22]}`,
            "-e",
            "GITHUB_PERSONAL_ACCESS_TOKEN",
            `STRIPE_KEY=${secrets[23]}`,
            "LOG_LEVEL=debug",
            "/work",
          ],
          env: { SERVICE_TOKEN: secrets[4], OTHER: "${OTHER_KEY}", PIN: Number(secrets[12]) },
        },
        // Server names are not field names: this one's entry is shown like any other.
        "release-token": {
          key: secrets[10],
          secretKey: secrets[17],
          authHeader: secrets[18],
          url: `https://mcp.example.com/s/${secrets[11]}/mcp`,
        },
        // Only an entry is exempt as a server name, not a stray value named like a credential.
        "stray-token": secrets[20],
        linked: {
          url: `https://example.com/mcp?api_key=${secrets[5]}`,
          headers: { Authorization: "Bearer ${env:LINKED_KEY}" },
        },
        "hue-other": {
          type: "http",
          url: "https://mcp.hue.run/mcp",
          headers: { Authorization: `Bearer ${secrets[6]}` },
        },
      },
      custom: { clientSecret: secrets[7], enabled: true },
      servers: { token: secrets[19] },
    });
    await writeFile(join(root, ".mcp.json"), existing);
    const dry = await mcp(["install", "--client", "claude-code", "--dry-run"], {
      cwd: root,
      env: { PATH: join(root, "empty-bin"), HUE_MCP_KEY: "hue_live_must_not_leak" },
    });
    expect(dry.code).toBe(0);
    expect(dry.stderr).toBe("");
    for (const secret of [...secrets, "hue_live_must_not_leak"])
      expect(dry.stdout).not.toContain(secret);
    expect(
      dry.stdout.startsWith("Would write .mcp.json (credential values shown as [redacted]):\n{\n"),
    ).toBe(true);
    const shown = JSON.parse(dry.stdout.slice(dry.stdout.indexOf("\n") + 1)) as {
      mcpServers: Record<string, Record<string, unknown>>;
      custom: Record<string, unknown>;
      servers: unknown;
    };
    expect(shown.mcpServers.github!.headers).toEqual({
      Authorization: "[redacted]",
      "X-Custom": "[redacted]",
      "X-Default": "[redacted]",
    });
    expect(shown.mcpServers.local).toEqual({
      command: "npx",
      args: [
        "-y",
        "some-server",
        "--api-key",
        "[redacted]",
        "--token=[redacted]",
        "--key",
        "[redacted]",
        "--auth=[redacted]",
        "-H",
        "[redacted]",
        "--header=[redacted]",
        "--access-key",
        "[redacted]",
        "--url=https://mcp.example.com/s/[redacted]/sse",
        "-e",
        "DEBUG=[redacted]",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "STRIPE_KEY=[redacted]",
        "LOG_LEVEL=debug",
        "/work",
      ],
      env: { SERVICE_TOKEN: "[redacted]", OTHER: "${OTHER_KEY}", PIN: "[redacted]" },
    });
    expect(shown.mcpServers["release-token"]).toEqual({
      key: "[redacted]",
      secretKey: "[redacted]",
      authHeader: "[redacted]",
      url: "https://mcp.example.com/s/[redacted]/mcp",
    });
    expect(shown.mcpServers["stray-token"] as unknown).toBe("[redacted]");
    expect(shown.servers).toEqual({ token: "[redacted]" });
    expect(shown.mcpServers.linked).toEqual({
      url: "https://example.com/mcp?api_key=%5Bredacted%5D",
      headers: { Authorization: "Bearer ${env:LINKED_KEY}" },
    });
    expect(shown.mcpServers["hue-other"]!.headers).toEqual({ Authorization: "[redacted]" });
    expect(shown.mcpServers.hue).toEqual({
      type: "http",
      url: ALL_URL,
      headers: { Authorization: "Bearer ${HUE_MCP_KEY}" },
    });
    expect(shown.custom).toEqual({ clientSecret: "[redacted]", enabled: true });
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(existing);

    // The file itself keeps every value; only the printed view is redacted.
    expect((await mcp(["install", "--client", "claude-code"], { cwd: root })).code).toBe(0);
    const written = await readFile(join(root, ".mcp.json"), "utf8");
    for (const secret of secrets) expect(written).toContain(secret);

    // A credential in --url is left out; the selections this command validated are shown.
    const keyName = "a1b2c3d4e5f6a7b8c9d0e1f2";
    const keyUrl = `https://mcp.hue.run/mcp?api_key=${secrets[6]}&sk-proj-${secrets[6]}&${keyName}&toolsets=traces,docs`;
    const keyInUrl = await mcp(
      ["install", "--client", "claude-code", "--dry-run", "--read-only", "--url", keyUrl],
      { cwd: root },
    );
    expect(keyInUrl.code).toBe(0);
    for (const secret of [secrets[6]!, keyName]) expect(keyInUrl.stdout).not.toContain(secret);
    expect(keyInUrl.stdout).toContain(
      '"url": "https://mcp.hue.run/mcp?api_key=[redacted]&[redacted]&[redacted]&read_only=true&toolsets=traces,docs"',
    );
    // So is every line that reports what the command does; the file keeps the URL as given.
    const codexDry = await mcp(["install", "--client", "codex", "--dry-run", "--url", keyUrl], {
      cwd: root,
    });
    expect(codexDry.stdout).toBe(
      "Would run: codex mcp add hue --url 'https://mcp.hue.run/mcp?api_key=[redacted]&[redacted]&[redacted]&toolsets=traces,docs' --bearer-token-env-var HUE_MCP_KEY\n",
    );
    // A replacement pattern in the URL stays literal.
    const patternDry = await mcp(
      [
        "install",
        "--client",
        "codex",
        "--dry-run",
        "--url",
        `https://mcp.hue.run/$&/mcp?api_key=${secrets[6]}`,
      ],
      { cwd: root },
    );
    expect(patternDry.stdout).not.toContain(secrets[6]);
    expect(patternDry.stdout).toContain("/$&/mcp?api_key=[redacted]");
    // A known token in the path, or a read_only value other than true or false, is left out too.
    const pathDry = await mcp(
      [
        "install",
        "--client",
        "codex",
        "--dry-run",
        "--url",
        `https://mcp.hue.run/mcp/hue_sk_abcdefghijklmnop?read_only=${secrets[7]}`,
      ],
      { cwd: root },
    );
    expect(pathDry.stdout).toContain("https://mcp.hue.run/mcp/[redacted]?read_only=[redacted]&");
    expect(pathDry.stdout).not.toContain("hue_sk_");
    expect(pathDry.stdout).not.toContain(secrets[7]);
    const keyWrite = await mcp(["install", "--client", "claude-code", "--url", keyUrl], {
      cwd: root,
    });
    expect(keyWrite.code).toBe(0);
    expect(keyWrite.stdout).not.toContain(secrets[6]);
    expect(keyWrite.stdout).toContain("(https://mcp.hue.run/mcp?api_key=[redacted]&");
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toContain(`api_key=${secrets[6]}`);
    const codex = await fakeCli(root, "codex");
    const ran = await mcp(["install", "--client", "codex", "--url", keyUrl], {
      cwd: root,
      env: codex.env,
    });
    expect(ran.code).toBe(0);
    for (const secret of [secrets[6]!, keyName]) expect(ran.stdout).not.toContain(secret);
    expect(ran.stdout).toContain(
      "Running: codex mcp add hue --url 'https://mcp.hue.run/mcp?api_key=[redacted]&",
    );
    expect(ran.stdout).toContain(
      'Registered the "hue" MCP server (https://mcp.hue.run/mcp?api_key=[redacted]&',
    );
    // The client itself receives the URL as given, key included.
    expect((await codex.args())[4]).toStartWith(`https://mcp.hue.run/mcp?api_key=${secrets[6]}&`);

    // A pinned server named like a credential still shows Hue's entry whole.
    const pinned = await mcp(
      ["install", "--client", "cursor", "--project", "release-token", "--dry-run"],
      { cwd: root },
    );
    expect(pinned.code).toBe(0);
    expect(pinned.stdout).toBe(
      `Would write .cursor/mcp.json:\n${CURSOR_OBSERVE_JSON.replace('"hue"', '"hue-release-token"').replace("?toolsets=observe", "?project=release-token&toolsets=observe")}`,
    );
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
    expect(toml.stdout).toBe(CODEX_ALL_TOML);
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
    expect(absent.stdout).toContain(CODEX_ALL_TOML.trimEnd());
    expect(absent.stdout).toContain(
      `codex mcp add hue --url '${ALL_URL}' --bearer-token-env-var HUE_MCP_KEY`,
    );

    const fake = await fakeCli(root, "codex");
    const present = await mcp(["install", "--client", "codex"], { cwd: root, env: fake.env });
    expect(present.code).toBe(0);
    expect(await fake.args()).toEqual([
      "mcp",
      "add",
      "hue",
      "--url",
      ALL_URL,
      "--bearer-token-env-var",
      "HUE_MCP_KEY",
    ]);
    expect(present.stdout).toContain(`Registered the "hue" MCP server (${ALL_URL}) with Codex.`);
    // `codex mcp add` cannot set it, so the next steps name the line to add.
    expect(present.stdout).toContain("  supports_parallel_tool_calls = true\n");
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
      `claude mcp add --transport http --scope user hue '${ALL_URL}' --header 'Authorization: Bearer \${HUE_MCP_KEY}'`,
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
      ALL_URL,
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
    expect(MCP_VERIFY_PROMPT).toContain("pass the project's id or slug as project_id");
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
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(
      CLAUDE_CODE_SIGN_IN_JSON.replace("https://mcp.hue.run/mcp", ALL_URL),
    );
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
      ALL_URL,
    ]);

    const codex = await fakeCli(root, "codex");
    const registered = await mcp(["install", "--client", "codex", "--auth", "oauth"], {
      cwd: root,
      env: codex.env,
    });
    expect(registered.code).toBe(0);
    expect(await codex.args()).toEqual(["mcp", "add", "hue", "--url", ALL_URL]);
    expect(registered.stdout).toContain("codex mcp login hue");
    expect(registered.stdout).not.toContain("hue_live_must_not_leak");

    const printed = await mcp(["install", "--client", "codex", "--auth", "oauth", "--print"], {
      cwd: root,
    });
    expect(printed.stdout).toBe(
      '[mcp_servers.hue]\nurl = "https://mcp.hue.run/mcp"\nhttp_headers = { "X-Hue-MCP-Toolsets" = "all" }\nsupports_parallel_tool_calls = true\n',
    );
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
      "https://mcp.hue.run/mcp?read_only=true&toolsets=all",
      "--bearer-token-env-var",
      "HUE_MCP_KEY",
    ]);
    // A printed command quotes the URL: `?` is a zsh glob and `&` would end the command.
    expect(codex.stdout).toContain(
      "Running: codex mcp add hue --url 'https://mcp.hue.run/mcp?read_only=true&toolsets=all' --bearer-token-env-var HUE_MCP_KEY",
    );
    const claude = await mcp(
      ["install", "--client", "claude-code", "--scope", "user", "--read-only", "--print"],
      { cwd: root },
    );
    expect(claude.stdout).toBe(
      "claude mcp add --transport http --scope user hue 'https://mcp.hue.run/mcp?read_only=true&toolsets=all' --header 'Authorization: Bearer ${HUE_MCP_KEY}'\n",
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
      `claude mcp add --transport http --scope user hue '${ALL_URL}'`,
    );
    expect(absent.stdout).toContain("codex is not on PATH");
    expect(absent.stdout).toContain(`codex mcp add hue --url '${ALL_URL}'`);
    expect(absent.stdout).toContain("/mcp-status");
    expect(absent.stdout).toContain(MCP_VERIFY_PROMPT);
    expect(await readdir(root)).toEqual([]);

    const dry = await mcp(["install", "--client", "conductor", "--dry-run"], { cwd: root });
    expect(dry.stdout).toBe(
      `Would run: claude mcp add --transport http --scope user hue '${ALL_URL}'\n` +
        `Would run: codex mcp add hue --url '${ALL_URL}'\n`,
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
      ALL_URL,
    ]);
    expect(await codex.args()).toEqual(["mcp", "add", "hue", "--url", ALL_URL]);
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
    expect(await codex.args()).toEqual(["mcp", "add", "hue", "--url", ALL_URL]);
    expect(result.stdout).toContain("with Codex.");
    expect(result.stdout).not.toContain(MCP_VERIFY_PROMPT);
  });

  test("--toolsets adds ?toolsets= to the URL and refuses unknown names", async () => {
    expect(parseToolsets("observe")).toEqual({ toolsets: "observe" });
    expect(parseToolsets("author,evaluate")).toEqual({ toolsets: "author,evaluate" });
    expect(parseToolsets("eval_sets,runs,judges,cases,runners")).toEqual({
      toolsets: "eval_sets,runs,judges,cases,runners",
    });
    expect(parseToolsets("traces, docs,traces")).toEqual({ toolsets: "traces,docs" });
    expect(parseToolsets("obsrve")).toEqual({
      error:
        "Unknown toolset: obsrve. Choose from all, observe, author, evaluate, project, traces, eval_sets, runs, judges, cases, runners, environments, intents, docs.",
    });
    expect(parseToolsets("evals")).toEqual({
      error:
        "Unknown toolset: evals. Choose from all, observe, author, evaluate, project, traces, eval_sets, runs, judges, cases, runners, environments, intents, docs.",
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

    // `all` is written out: a URL without a selection lists Hue's default.
    const everything = await mcp(
      ["install", "--client", "cursor", "--toolsets", "all", "--print"],
      {
        cwd: root,
      },
    );
    expect(everything.stdout).toBe(CURSOR_JSON.replace("https://mcp.hue.run/mcp", ALL_URL));
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
      CURSOR_JSON.replace(
        "https://mcp.hue.run/mcp",
        "https://mcp.hue.run/mcp?read_only=true&toolsets=all",
      ),
    );
    expect((await mcp(withUrl("traces"), { cwd: root })).stdout).toBe(
      CURSOR_JSON.replace(
        "https://mcp.hue.run/mcp",
        "https://mcp.hue.run/mcp?read_only=true&toolsets=traces",
      ),
    );
    const typo = await mcp(withUrl("obsrve"), { cwd: root });
    expect(typo.code).toBe(2);
    expect(typo.stderr).toContain("In --url: Unknown toolset: obsrve.");
    expect(toolsetsMcpUrl("https://mcp.hue.run/mcp?toolsets=observe", undefined)).toBe(
      "https://mcp.hue.run/mcp",
    );
    const unknown = await mcp(["install", "--client", "cursor", "--toolsets", "obsrve"], {
      cwd: root,
    });
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("Unknown toolset: obsrve.");
  });

  test("a sign-in selection travels in the URL; the Codex TOML sends it as a header", async () => {
    const observeUrl = "https://mcp.hue.run/mcp?toolsets=observe";
    const root = await temporaryRoot();
    const project = await mcp(
      ["install", "--client", "claude-code", "--auth", "oauth", "--toolsets", "observe"],
      { cwd: root },
    );
    expect(project.code).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: { hue: { type: "http", url: observeUrl } },
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
      observeUrl,
    ]);
    expect(await codex.args()).toEqual(["mcp", "add", "hue", "--url", observeUrl]);
    expect(conductor.stdout).not.toContain("X-Hue-MCP-Toolsets");

    const toml = await mcp(
      ["install", "--client", "codex", "--auth", "oauth", "--toolsets", "observe", "--print"],
      { cwd: root },
    );
    expect(toml.stdout).toBe(
      '[mcp_servers.hue]\nurl = "https://mcp.hue.run/mcp"\nhttp_headers = { "X-Hue-MCP-Toolsets" = "observe" }\nsupports_parallel_tool_calls = true\n',
    );
    // A selection already in a sign-in --url is kept.
    const inUrl = await mcp(
      ["install", "--client", "codex", "--auth", "oauth", "--dry-run", "--url", observeUrl],
      { cwd: root },
    );
    expect(inUrl.code).toBe(0);
    expect(inUrl.stdout).toBe(`Would run: codex mcp add hue --url '${observeUrl}'\n`);
  });

  test("--project pins one project under a coexisting server name", async () => {
    expect(parseProject(" support-agent ")).toEqual({
      project: "support-agent",
      serverName: "hue-support-agent",
    });
    expect("error" in parseProject(" ")).toBe(true);
    expect("error" in parseProject("support agent")).toBe(true);
    expect(projectMcpUrl("https://mcp.hue.run/mcp?toolsets=all", "support-agent")).toBe(
      "https://mcp.hue.run/mcp?toolsets=all&project=support-agent",
    );
    expect(
      projectMcpUrl("https://mcp.hue.run/mcp?project=old&toolsets=observe", "support-agent"),
    ).toBe("https://mcp.hue.run/mcp?toolsets=observe&project=support-agent");

    const root = await temporaryRoot();
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { hue: { type: "http", url: DEFAULT_MCP_URL } } }),
    );
    const pinned = await mcp(["install", "--client", "claude-code", "--project", "support-agent"], {
      cwd: root,
    });
    expect(pinned.code).toBe(0);
    expect(pinned.stderr).toBe("");
    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: {
        hue: { type: "http", url: DEFAULT_MCP_URL },
        "hue-support-agent": {
          type: "http",
          url: "https://mcp.hue.run/mcp?project=support-agent&toolsets=all",
          headers: { Authorization: "Bearer ${HUE_MCP_KEY}" },
        },
      },
    });
    expect(pinned.stdout).toContain('Wrote .mcp.json with the "hue-support-agent" MCP server');
    expect(pinned.stdout).toContain("connection.pinned true");
    expect(pinned.stdout).toContain("Do not pass project_id");
    expect(pinned.stdout).toContain("signing in again will not fix it");
  });

  test("a pinned Codex sign-in TOML sends project and toolsets as headers", async () => {
    const root = await temporaryRoot();
    const result = await mcp(
      [
        "install",
        "--client",
        "codex",
        "--auth",
        "oauth",
        "--project",
        "support-agent",
        "--toolsets",
        "observe",
        "--print",
      ],
      { cwd: root },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      '[mcp_servers.hue-support-agent]\nurl = "https://mcp.hue.run/mcp"\nhttp_headers = { "X-Hue-MCP-Toolsets" = "observe", "X-Hue-MCP-Project" = "support-agent" }\nsupports_parallel_tool_calls = true\n',
    );

    // --project replaces a URL pin and keeps the URL's toolset selection.
    const replaced = await mcp(
      [
        "install",
        "--client",
        "codex",
        "--auth",
        "oauth",
        "--project",
        "support-agent",
        "--dry-run",
        "--url",
        "https://mcp.hue.run/mcp?project=old&toolsets=traces",
      ],
      { cwd: root },
    );
    expect(replaced.stdout).toBe(
      "Would run: codex mcp add hue-support-agent --url 'https://mcp.hue.run/mcp?project=support-agent&toolsets=traces'\n",
    );

    for (const argv of [
      ["install", "--client", "codex", "--project", ""],
      ["install", "--client", "codex", "--url", "https://mcp.hue.run/mcp?project="],
      ["install", "--client", "codex", "--url", "https://mcp.hue.run/mcp?project=one&project=two"],
    ]) {
      const refused = await mcp(argv, { cwd: root });
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain("project");
    }
  });
});
