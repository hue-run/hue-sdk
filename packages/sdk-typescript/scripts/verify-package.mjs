import { readFileSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
// A namespace import: Node.js 22.12 to 22.14 have no zstd, and a missing named export fails loading.
import * as zlib from "node:zlib";

const { values } = parseArgs({
  options: {
    archive: { type: "string" },
    "registry-version": { type: "string" },
    "artifacts-dir": { type: "string" },
    "landing-latest": { type: "boolean", default: false },
  },
});
if (values.archive && values["registry-version"])
  throw new Error("Choose an archive or registry version");
if (values["registry-version"] && values["artifacts-dir"])
  throw new Error("Registry verification does not produce a release archive");
if (values["landing-latest"])
  throw new Error(
    "--landing-latest is not a loopback package check. Run Fern's hosted acceptance for the literal public @latest commands and preserve its separate evidence.",
  );

// Work entirely outside the monorepo: no workspace symlinks or private Hue imports.
const source = fileURLToPath(new URL("../", import.meta.url));
const destination = await mkdtemp(join(tmpdir(), "hue-sdk-package-"));
const staging = join(destination, "package");
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}
function runAsync(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("close", (status) => {
      if (status === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed`));
    });
  });
}
const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
const aliasSource = resolve(source, "../aliases/npm-hue-run");
const aliasPkg = JSON.parse(await readFile(join(aliasSource, "package.json"), "utf8"));
if (aliasPkg.version !== pkg.version || aliasPkg.dependencies?.[pkg.name] !== pkg.version)
  throw new Error("The hue-run alias version and dependency must match @hue-run/sdk");
if (pkg.bin?.hue !== "./dist/setup/cli.js" || aliasPkg.bin?.hue !== "./bin/hue.mjs")
  throw new Error("The canonical and alias packages must both expose the hue executable");
if (
  (await readFile(join(aliasSource, "setup-events.schema.json"), "utf8")) !==
  (await readFile(join(source, "setup-events.schema.json"), "utf8"))
)
  throw new Error("The hue-run alias must publish the same setup event schema");
if (values["registry-version"] && values["registry-version"] !== pkg.version)
  throw new Error("Registry version must match this checkout's package version");
const tarball = values.archive
  ? resolve(values.archive)
  : join(destination, `hue-run-sdk-${pkg.version}.tgz`);
if (values["registry-version"]) {
  // Fetch the already published immutable tarball; never rebuild registry acceptance bytes.
  run(
    "npm",
    [
      "pack",
      `@hue-run/sdk@${values["registry-version"]}`,
      "--ignore-scripts",
      "--registry=https://registry.npmjs.org",
      "--pack-destination",
      destination,
    ],
    destination,
  );
}
// Test harness dependencies belong to this isolated, frozen tooling checkout in
// every mode. Archive/registry acceptance still never builds or repacks the SDK.
await cp(source, staging, {
  recursive: true,
  filter: (path) =>
    !/(?:^|\/)(?:node_modules|dist)(?:\/|$)/u.test(path) && !/(?:^|\/)\.env(?:\.|$)/u.test(path),
});
run("bun", ["--no-env-file", "install", "--frozen-lockfile"], staging);
if (!values.archive && !values["registry-version"]) {
  // The committed version literal must already match package.json; the build regenerates it.
  run("node", ["scripts/write-version.mjs", "--check"], staging);
  run("bun", ["--no-env-file", "run", "typecheck"], staging);
  run("bun", ["--no-env-file", "run", "build"], staging);
  // stripInternal must keep the transport's @internal mutators out of the published declarations.
  const transportTypes = readFileSync(join(staging, "dist", "transport.d.ts"), "utf8");
  for (const member of [
    "exporting",
    "reportUploads",
    "finish",
    "acceptedRecords",
    "issue",
    "instrumentationFailure",
    "placeholderMarkers",
    "placeholderSettled",
    "sendsPlaceholders",
    "rejectPlaceholders",
    "withDroppedRecords",
    "omitDroppedRecords",
    "consumeDroppedRecords",
    "countUndelivered",
    "holdForRateLimit",
    "releaseRateLimitHolds",
    "receiverLimits",
    "adoptLimits",
    "offloadsValues",
    "holdsValues",
    "offloadSpan",
    "reportOffload",
    "awaitUploads",
    "flushRecords",
  ]) {
    if (new RegExp(`^\\s+${member}\\(`, "m").test(transportTypes))
      throw new Error(`dist/transport.d.ts exposes internal member ${member}()`);
  }
  // Serving frameworks bundle the SDK (Next.js Turbopack and webpack): a dynamic import whose
  // specifier is an expression is replaced with a throw there, so every export would fail.
  const bundled = new Set();
  const pendingModules = ["dist/index.js", "dist/ai-sdk.js"];
  while (pendingModules.length) {
    const file = pendingModules.pop();
    if (bundled.has(file)) continue;
    bundled.add(file);
    const code = readFileSync(join(staging, file), "utf8");
    for (const match of code.matchAll(/\bimport\s*\(\s*([^)]*)\)/gu)) {
      if (!/^["'][^"']+["']$/u.test(match[1].trim()))
        throw new Error(`${file} imports a computed specifier: import(${match[1]})`);
    }
    for (const match of code.matchAll(/(?:from|import)\s*\(?\s*["'](\.\.?\/[^"']+)["']/gu))
      pendingModules.push(join(file, "..", match[1]));
  }
  console.log(`bundle safety: ${bundled.size} runtime modules import literal specifiers only`);
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", destination], staging);
  // Bun's packer must agree with npm's file inventory; the release artifact stays npm pack.
  const bunPack = spawnSync("bun", ["--no-env-file", "pm", "pack", "--dry-run"], {
    cwd: staging,
    encoding: "utf8",
    env: process.env,
  });
  if (bunPack.status !== 0) throw new Error("bun pm pack --dry-run failed");
  const bunFiles = new Set(
    bunPack.stdout
      .split("\n")
      .map((line) => /^packed\s+\S+\s+(.+)$/u.exec(line)?.[1])
      .filter(Boolean),
  );
  const tarList = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  if (tarList.status !== 0) throw new Error("Unable to list the packed tarball");
  const npmFiles = new Set(
    tarList.stdout
      .split("\n")
      .filter(Boolean)
      .map((entry) => entry.replace(/^package\//u, "")),
  );
  const onlyNpm = [...npmFiles].filter((file) => !bunFiles.has(file));
  const onlyBun = [...bunFiles].filter((file) => !npmFiles.has(file));
  if (onlyNpm.length || onlyBun.length)
    throw new Error(
      `npm pack and bun pm pack disagree on package contents: npm-only ${JSON.stringify(onlyNpm)}, bun-only ${JSON.stringify(onlyBun)}`,
    );
  const forbiddenCaptureFiles = [...npmFiles].filter(
    (file) =>
      file === "CAPTURE.md" ||
      file === "dist/capture.js" ||
      file.startsWith("dist/capture/") ||
      file === "dist/uploads.js" ||
      file.startsWith("dist/uploads/"),
  );
  if (Object.hasOwn(pkg.exports, "./capture") || forbiddenCaptureFiles.length)
    throw new Error(
      `Portable capture assets are outside this release: ${JSON.stringify(forbiddenCaptureFiles)}`,
    );
  if (
    Object.hasOwn(pkg.exports, "./evals/conversion-outcome-core.mjs") ||
    [...npmFiles].some((file) => /conversion-outcome/u.test(file))
  )
    throw new Error("Outcome evaluator implementation assets are outside this release");
  console.log(`pack inventory: ${npmFiles.size} files agree between npm pack and bun pm pack`);
}
const packageSpec = values["registry-version"] ?? `file:${tarball}`;
if (!values.archive && !values["registry-version"]) {
  const aliasTarball = join(destination, `hue-run-${aliasPkg.version}.tgz`);
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", destination], aliasSource);
  const aliasConsumer = join(destination, "alias-consumer");
  await mkdir(aliasConsumer);
  await writeFile(
    join(aliasConsumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { "@hue-run/sdk": packageSpec, "hue-run": `file:${aliasTarball}` },
    }),
  );
  run(
    "npm",
    ["install", "--registry=https://registry.npmjs.org", "--no-audit", "--no-fund"],
    aliasConsumer,
  );
  run(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      `
  const assert = require("node:assert/strict");
  assert.equal(typeof require("hue-run/setup").transitionSetup, "function");
  assert.equal(
    require("hue-run/setup-events.schema.json").$id,
    "https://hue.run/schemas/setup-events-v2.json",
  );
`,
    ],
    aliasConsumer,
  );
  const aliasCli = spawnSync(
    process.execPath,
    [join(aliasConsumer, "node_modules", "hue-run", "bin", "hue.mjs"), "status", "--agent"],
    {
      cwd: aliasConsumer,
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, XDG_STATE_HOME: join(destination, "alias-setup-state") },
    },
  );
  const aliasEvents = aliasCli.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  if (
    aliasCli.status !== 0 ||
    aliasCli.stderr ||
    aliasEvents.at(-1)?.event !== "run.completed" ||
    aliasEvents.filter((event) => event.event === "run.completed" || event.event === "run.failed")
      .length !== 1
  )
    throw new Error("Installed hue-run alias executable did not dispatch to its pinned SDK");
}
// Check the advertised install before adding any test or optional AI dependencies.
// Development dependencies must not conceal missing runtime package metadata.
const minimal = join(destination, "minimal-consumer");
await mkdir(minimal);
await writeFile(
  join(minimal, "package.json"),
  JSON.stringify({ private: true, type: "module", dependencies: { "@hue-run/sdk": packageSpec } }),
);
run(
  "npm",
  ["install", "--registry=https://registry.npmjs.org", "--no-audit", "--no-fund"],
  minimal,
);
run(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `
  import { strict as assert } from "node:assert";
  await import("@hue-run/sdk");
  await import("@hue-run/sdk/managed");
  const setup = await import("@hue-run/sdk/setup");
  const environment = await import("@hue-run/sdk/environment");
  assert.equal(typeof environment.createEnvironmentClient, "function");
  assert.equal(typeof setup.transitionSetup, "function");
`,
  ],
  minimal,
);
// zod is a dependency, so `npx @hue-run/sdk eval` needs no second package.
const evalHelp = spawnSync(
  process.execPath,
  [join(minimal, "node_modules/@hue-run/sdk/dist/setup/cli.js"), "eval", "--help"],
  { cwd: minimal, encoding: "utf8" },
);
if (evalHelp.status !== 0 || !evalHelp.stdout.includes("Usage: hue eval"))
  throw new Error(
    `hue eval --help failed in a consumer with only @hue-run/sdk (status ${evalHelp.status}): ${evalHelp.stderr.slice(0, 500)}`,
  );
// CommonJS applications on the Node floor (22.12+) load the ESM build through require(esm):
// every entry point resolves through its "default" condition, and the build must stay free of
// top-level await, which require() rejects with ERR_REQUIRE_ASYNC_MODULE.
run(
  process.execPath,
  [
    "--input-type=commonjs",
    "-e",
    `
  const assert = require("node:assert/strict");
  const sdk = require("@hue-run/sdk");
  const environment = require("@hue-run/sdk/environment");
  const managed = require("@hue-run/sdk/managed");
  const setup = require("@hue-run/sdk/setup");
  const setupSchema = require("@hue-run/sdk/setup-events.schema.json");
  assert.equal(typeof sdk.createHue, "function");
  assert.equal(typeof sdk.createHueSafe, "function");
  assert.equal(typeof environment.createEnvironmentClient, "function");
  assert.equal(typeof managed.createManagedTargetHandler, "function");
  assert.equal(typeof setup.transitionSetup, "function");
  assert.equal(setupSchema.$id, "https://hue.run/schemas/setup-events-v2.json");
  const hue = sdk.createHue({ enabled: false });
  hue
    .withSpan("require", () => 42)
    .then(async (value) => {
      assert.equal(value, 42);
      await hue.shutdownSafe();
      console.log("require(esm) consumer ok");
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
`,
  ],
  minimal,
);
// The installed CLI matrix uses only loopback synthetic contracts. Hosted browser claims and
// literal public @latest acceptance belong to Fern's separately recorded hosted acceptance gate.
run(
  process.execPath,
  [
    join(staging, "scripts/verify-installed-setup.mjs"),
    "--archive",
    tarball,
    "--installed-package",
    join(minimal, "node_modules", "@hue-run", "sdk"),
  ],
  destination,
);
const removedConnect = spawnSync(
  join(minimal, "node_modules", ".bin", "hue"),
  ["connect", "--agent"],
  {
    cwd: minimal,
    encoding: "utf8",
    timeout: 5000,
    env: process.env,
  },
);
const removedConnectEvents = removedConnect.stdout
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
if (
  removedConnect.status !== 2 ||
  removedConnect.stderr ||
  removedConnectEvents.length !== 1 ||
  removedConnectEvents[0]?.event !== "run.failed"
)
  throw new Error("Installed hue CLI still accepts the removed connect command");
// The installed CLI, not the source import, must preserve a project pin while rendering the
// Codex sign-in form that carries transport selections as headers on a bare URL.
const installedPinnedMcp = spawnSync(
  join(minimal, "node_modules", ".bin", "hue"),
  [
    "mcp",
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
  {
    cwd: minimal,
    encoding: "utf8",
    timeout: 5000,
    env: process.env,
  },
);
const expectedPinnedMcp = `[mcp_servers.hue-support-agent]\nurl = "https://mcp.hue.run/mcp"\nhttp_headers = { "X-Hue-MCP-Toolsets" = "observe", "X-Hue-MCP-Project" = "support-agent" }\nsupports_parallel_tool_calls = true\n`;
if (
  installedPinnedMcp.status !== 0 ||
  installedPinnedMcp.stderr ||
  installedPinnedMcp.stdout !== expectedPinnedMcp
)
  throw new Error("Installed hue mcp install did not preserve the project pin");
// The installed CLI under Node.js reads every frame of a zstd file: Node's zlib decompresses only
// a file's first frame on its own, which Bun's tests cannot show. zstd is in node:zlib from 22.15.
if (typeof zlib.zstdCompressSync === "function") {
  const exports = await mkdtemp(join(destination, "traces-import-"));
  const spans = (from, count) =>
    Array.from({ length: count }, (_, index) =>
      JSON.stringify({
        traceId: (from + index).toString(16).padStart(32, "0"),
        id: "0000000000000001",
        name: "turn",
        timestamp: 1760000000000000,
        duration: 1000,
      }),
    ).join("\n") + "\n";
  const input = join(exports, "spans.jsonl.zst");
  await writeFile(
    input,
    Buffer.concat([zlib.zstdCompressSync(spans(1, 3)), zlib.zstdCompressSync(spans(4, 7))]),
  );
  const prepared = spawnSync(
    join(minimal, "node_modules", ".bin", "hue"),
    ["traces", "import", "prepare", input, "--out", join(exports, "bundle"), "--json"],
    { cwd: exports, encoding: "utf8", timeout: 10000, env: process.env },
  );
  const report = prepared.status === 0 ? JSON.parse(prepared.stdout) : undefined;
  if (
    !report ||
    report.totals.traces !== 10 ||
    report.files.unsupported.length ||
    report.files.skipped.length ||
    report.files.notes.length
  )
    throw new Error("Installed hue traces import prepare did not read every frame of a zstd file");
  console.log("traces import: every frame of a two-frame zstd file read under Node.js");
  // So does each zstd message of a length-prefixed binary OTLP file (the Collector's file
  // exporter): one ExportTraceServiceRequest of four spans, compressed as two frames.
  const varint = (value) => {
    const bytes = [];
    for (; value > 0x7f; value >>>= 7) bytes.push((value & 0x7f) | 0x80);
    return Buffer.from([...bytes, value]);
  };
  const field = (number, payload) =>
    Buffer.concat([varint(number * 8 + 2), varint(payload.byteLength), payload]);
  const fixed64 = (number, value) => {
    const bytes = Buffer.alloc(9);
    bytes[0] = number * 8 + 1;
    bytes.writeBigUInt64LE(value, 1);
    return bytes;
  };
  const span = (index) =>
    field(
      2,
      Buffer.concat([
        field(1, Buffer.from(index.toString(16).padStart(32, "0"), "hex")),
        field(2, Buffer.from("0000000000000001", "hex")),
        field(5, Buffer.from("turn")),
        fixed64(7, 1760000000000000000n),
        fixed64(8, 1760000000001000000n),
      ]),
    );
  const request = field(1, field(2, Buffer.concat([1, 2, 3, 4].map(span))));
  const message = Buffer.concat([
    zlib.zstdCompressSync(request.subarray(0, 40)),
    zlib.zstdCompressSync(request.subarray(40)),
  ]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.byteLength);
  const collector = join(exports, "collector.binpb");
  await writeFile(collector, Buffer.concat([length, message]));
  const preparedMessages = spawnSync(
    join(minimal, "node_modules", ".bin", "hue"),
    ["traces", "import", "prepare", collector, "--out", join(exports, "messages"), "--json"],
    { cwd: exports, encoding: "utf8", timeout: 10000, env: process.env },
  );
  const messages = preparedMessages.status === 0 ? JSON.parse(preparedMessages.stdout) : undefined;
  if (
    !messages ||
    messages.totals.traces !== 4 ||
    messages.files.unsupported.length ||
    messages.files.skipped.length ||
    messages.files.notes.length
  )
    throw new Error(
      "Installed hue traces import prepare did not read every frame of a zstd OTLP message",
    );
  console.log("traces import: every frame of a two-frame zstd OTLP message read under Node.js");
} else console.log("traces import: zstd frame check skipped (this Node.js has no zstd)");
// Without --auth, the installed CLI signs Claude Code in unless HUE_MCP_KEY is set, and names its
// choice on stderr so --print stays a snippet; it checks the variable's presence, never prints it.
{
  const printed = (value) =>
    spawnSync(
      join(minimal, "node_modules", ".bin", "hue"),
      ["mcp", "install", "--client", "claude-code", "--print"],
      {
        cwd: minimal,
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, HUE_MCP_KEY: value },
      },
    );
  const signIn = printed("");
  const key = printed("hue_package_check_value");
  if (
    signIn.status !== 0 ||
    signIn.stdout.includes("Authorization") ||
    !signIn.stderr.startsWith("Using sign-in with Hue") ||
    key.status !== 0 ||
    !key.stdout.includes("Bearer ${HUE_MCP_KEY}") ||
    !key.stderr.startsWith("Using a key") ||
    `${key.stdout}${key.stderr}`.includes("hue_package_check_value")
  )
    throw new Error("Installed hue mcp install did not choose sign-in or a key by HUE_MCP_KEY");
}
// The installed CLI keeps a client configuration held at 0600 for another server's token at 0600,
// leaves that token out of --dry-run and refuses a symlinked config directory.
{
  const project = await mkdtemp(join(destination, "mcp-files-"));
  const config = join(project, ".mcp.json");
  const token = `ghp_package_check_${"t".repeat(24)}`;
  const other = { type: "http", headers: { Authorization: `Bearer ${token}` } };
  await writeFile(config, JSON.stringify({ mcpServers: { other } }), { mode: 0o600 });
  await chmod(config, 0o600);
  const install = (...args) =>
    spawnSync(join(minimal, "node_modules", ".bin", "hue"), ["mcp", "install", ...args], {
      cwd: project,
      encoding: "utf8",
      timeout: 5000,
      env: process.env,
    });
  const dry = install("--client", "claude-code", "--dry-run");
  if (dry.status !== 0 || dry.stdout.includes(token) || !dry.stdout.includes("[redacted]"))
    throw new Error("Installed hue mcp install --dry-run printed another server's token");
  const written = install("--client", "claude-code");
  if (
    written.status !== 0 ||
    ((await stat(config)).mode & 0o777) !== 0o600 ||
    !(await readFile(config, "utf8")).includes(token)
  )
    throw new Error("Installed hue mcp install widened an owner-only client configuration");
  await symlink(await mkdtemp(join(destination, "mcp-elsewhere-")), join(project, ".cursor"));
  const linked = install("--client", "cursor");
  if (linked.status !== 1 || !linked.stderr.includes(".cursor is a symbolic link"))
    throw new Error("Installed hue mcp install followed a symlinked .cursor directory");
}
// Node 22 and 24 read --env-file from the whole command line and exit before the CLI runs when that
// file is missing, so the installed `hue login` must create a new env file through --env-path.
{
  const loginKey = `hue_live_package_check_${"k".repeat(24)}`;
  const standIn = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.headers.authorization !== `Bearer ${loginKey}`) {
      response.statusCode = 401;
      response.end("{}");
    } else if (request.url === "/api/v1/projects/current") {
      response.end(
        JSON.stringify({ id: "p", name: "Package check", slug: "p", organizationId: "o" }),
      );
    } else if (request.url === "/api/v1/datasets") {
      response.end(JSON.stringify({ items: [], nextCursor: null }));
    } else if (request.url === "/api/mcp") {
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { tools: [{ name: "get_project_context" }] },
        }),
      );
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  await new Promise((listening) => standIn.listen(0, "127.0.0.1", listening));
  const loginDirectory = await mkdtemp(join(destination, "login-"));
  const login = await new Promise((finished, failed) => {
    const child = spawn(
      join(minimal, "node_modules", ".bin", "hue"),
      [
        "login",
        "--origin",
        `http://127.0.0.1:${standIn.address().port}`,
        "--env-path",
        ".env.local",
        "--no-browser",
      ],
      { cwd: loginDirectory, env: process.env, stdio: ["pipe", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", failed);
    child.on("close", (status) => finished({ status, stderr }));
    child.stdin.end(`${loginKey}\n`);
  });
  standIn.close();
  const stored = await readFile(join(loginDirectory, ".env.local"), "utf8").catch(() => "");
  if (
    login.status !== 0 ||
    !stored.includes(`HUE_API_KEY=${loginKey}\n`) ||
    !stored.includes(`HUE_MCP_KEY=${loginKey}\n`)
  )
    throw new Error(
      `Installed hue login --env-path did not create a new env file: ${login.stderr}`,
    );
}
// The installed `hue listen` under Node: one leased delivery reaches a loopback receiver unchanged,
// is acknowledged with the receiver's answer, and SIGINT then stops the client cleanly.
{
  const token = `hue_world_eyJwYWNrYWdlIjoiY2hlY2sifQ.${"t".repeat(43)}`;
  const subscription = "0f8e3c2a-5b7d-4e1f-9a6c-2d4b8e0f1a3c";
  const deliveryId = "6a1c9e4f-2b3d-4c5e-8f7a-9b0c1d2e3f4a";
  const body = JSON.stringify({ type: "event_callback", event_id: "Ev0PACKAGE01", event: {} });
  const received = [];
  const receiver = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      received.push({ signature: request.headers["x-slack-signature"], raw });
      response.end("");
    });
  });
  await new Promise((listening) => receiver.listen(0, "127.0.0.1", listening));
  const acks = [];
  let pulled = false;
  const standIn = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.statusCode = 401;
        return response.end("{}");
      }
      const base = `/api/v1/event-subscriptions/${subscription}/deliveries`;
      if (request.url === `${base}/pull`) {
        const deliveries = pulled
          ? []
          : [
              {
                deliveryId,
                subscriptionId: subscription,
                worldId: null,
                eventId: "Ev0PACKAGE01",
                kind: "event_callback",
                retryNum: 0,
                leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
                request: {
                  method: "POST",
                  headers: { "content-type": "application/json", "x-slack-signature": "v0=abc" },
                  body,
                },
              },
            ];
        pulled = true;
        // An empty pull waits briefly, as a long poll would, rather than spinning.
        return setTimeout(
          () => response.end(JSON.stringify({ deliveries })),
          deliveries.length ? 0 : 200,
        );
      }
      if (request.url === `${base}/${deliveryId}/ack`) {
        acks.push(JSON.parse(raw));
        return response.end(JSON.stringify({ state: "acknowledged" }));
      }
      response.statusCode = 404;
      response.end("{}");
    });
  });
  await new Promise((listening) => standIn.listen(0, "127.0.0.1", listening));
  const listen = await new Promise((finished, failed) => {
    const child = spawn(
      process.execPath,
      [
        join(minimal, "node_modules/@hue-run/sdk/dist/setup/cli.js"),
        "listen",
        "--subscription",
        subscription,
        "--forward-to",
        `http://localhost:${receiver.address().port}/slack/events`,
        "--origin",
        `http://127.0.0.1:${standIn.address().port}`,
      ],
      {
        env: { PATH: process.env.PATH, HUE_WORLD_TOKEN: token },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    // A client that ignored SIGINT would otherwise hang this check until the CI job's timeout.
    const killer = setTimeout(() => child.kill("SIGKILL"), 40_000);
    child.on("error", failed);
    child.on("close", (status) => {
      clearTimeout(killer);
      finished({ status, output });
    });
    const deadline = Date.now() + 20_000;
    const poll = setInterval(() => {
      if (acks.length > 0 || Date.now() > deadline) {
        clearInterval(poll);
        child.kill("SIGINT");
      }
    }, 50);
  });
  receiver.close();
  standIn.close();
  if (
    listen.status !== 0 ||
    acks.length !== 1 ||
    acks[0].outcome !== "response" ||
    acks[0].status !== 200 ||
    received.length !== 1 ||
    received[0].raw !== body ||
    received[0].signature !== "v0=abc" ||
    listen.output.includes(token)
  )
    throw new Error(
      `Installed hue listen did not forward and acknowledge under Node: ${listen.output}`,
    );
}
// The installed `hue listen` under Node, stopped as `npx` stops it: the terminal's SIGINT while a
// delivery is in flight, and npm's copy of it a few milliseconds later, which may come as the
// client exits. The copy's delay varies, so one is sent every 2 ms for 600 ms. Each is the first
// stop request again: the delivery is acknowledged and the client exits 0, not ended by SIGINT.
{
  const token = `hue_world_eyJwYWNrYWdlIjoiY2hlY2sifQ.${"t".repeat(43)}`;
  const subscription = "0f8e3c2a-5b7d-4e1f-9a6c-2d4b8e0f1a3c";
  const deliveryId = "7b2d0f5a-3c4e-4d6f-9a8b-0c1d2e3f4a5b";
  const body = JSON.stringify({ type: "event_callback", event_id: "Ev0PACKAGE02", event: {} });
  let received = 0;
  const receiver = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      received++;
      setTimeout(() => response.end(""), 300);
    });
  });
  await new Promise((listening) => receiver.listen(0, "127.0.0.1", listening));
  const acks = [];
  let pulled = false;
  const standIn = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.statusCode = 401;
        return response.end("{}");
      }
      const base = `/api/v1/event-subscriptions/${subscription}/deliveries`;
      if (request.url === `${base}/pull`) {
        const deliveries = pulled
          ? []
          : [
              {
                deliveryId,
                subscriptionId: subscription,
                worldId: null,
                eventId: "Ev0PACKAGE02",
                kind: "event_callback",
                retryNum: 0,
                leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
                request: { method: "POST", headers: { "content-type": "application/json" }, body },
              },
            ];
        pulled = true;
        // A later pull waits, as a long poll does, until the client ends it.
        const timer = setTimeout(
          () => response.end(JSON.stringify({ deliveries })),
          deliveries.length ? 0 : 20_000,
        );
        return response.on("close", () => clearTimeout(timer));
      }
      if (request.url === `${base}/${deliveryId}/ack`) {
        acks.push(JSON.parse(raw));
        return response.end(JSON.stringify({ state: "acknowledged" }));
      }
      response.statusCode = 404;
      response.end("{}");
    });
  });
  await new Promise((listening) => standIn.listen(0, "127.0.0.1", listening));
  const listen = await new Promise((finished, failed) => {
    const child = spawn(
      process.execPath,
      [
        join(minimal, "node_modules/@hue-run/sdk/dist/setup/cli.js"),
        "listen",
        "--subscription",
        subscription,
        "--forward-to",
        `http://localhost:${receiver.address().port}/slack/events`,
        "--origin",
        `http://127.0.0.1:${standIn.address().port}`,
      ],
      {
        env: { PATH: process.env.PATH, HUE_WORLD_TOKEN: token },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const killer = setTimeout(() => child.kill("SIGKILL"), 40_000);
    child.on("error", failed);
    child.on("close", (status, signal) => {
      clearTimeout(killer);
      finished({ status, signal, output });
    });
    const deadline = Date.now() + 20_000;
    const poll = setInterval(() => {
      if (received === 0 && Date.now() <= deadline) return;
      clearInterval(poll);
      const stoppedAt = Date.now();
      child.kill("SIGINT");
      const copies = setInterval(() => {
        if (Date.now() - stoppedAt > 600 || child.exitCode !== null || child.signalCode !== null)
          return clearInterval(copies);
        child.kill("SIGINT");
      }, 2);
    }, 5);
  });
  receiver.close();
  standIn.close();
  if (
    listen.status !== 0 ||
    listen.signal !== null ||
    acks.length !== 1 ||
    acks[0].outcome !== "response" ||
    acks[0].status !== 200 ||
    !listen.output.includes("Stopped.") ||
    listen.output.includes(token)
  )
    throw new Error(
      `Installed hue listen did not treat npm's copy of SIGINT as the same stop under Node (status ${listen.status}, signal ${listen.signal}): ${listen.output}`,
    );
}
// Evaluation/simulation users install the optional validation peer. Ajv remains separately
// optional: without it the JSON Schema scorer reports a typed error instead of crashing.
const evaluation = join(destination, "evaluation-consumer");
await mkdir(evaluation);
await writeFile(
  join(evaluation, "package.json"),
  JSON.stringify({
    private: true,
    type: "module",
    dependencies: { "@hue-run/sdk": packageSpec },
  }),
);
run(
  "npm",
  ["install", "--registry=https://registry.npmjs.org", "--no-audit", "--no-fund"],
  evaluation,
);
run(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `
  import { strict as assert } from "node:assert";
  import { createRequire } from "node:module";
  const { builtins, scoreLocally } = await import("@hue-run/sdk/evals");
  const score = await scoreLocally(
    { definition: builtins.jsonSchema({ type: "string" }) },
    { inputs: {}, output: "text", hasOutput: true, hasExpected: false },
  );
  assert.equal(score.state, "error");
  assert.equal(score.error.type, "SchemaValidatorUnavailable");
  assert.equal(createRequire(import.meta.url)("@hue-run/sdk/evals").scoreLocally, scoreLocally);
`,
  ],
  evaluation,
);
// AI SDK 6 accepts zod 3, so the packed SDK must install and import its evaluation entry beside it.
const ai6Zod3Evaluation = join(destination, "ai6-zod3-evaluation-consumer");
await mkdir(ai6Zod3Evaluation);
await writeFile(
  join(ai6Zod3Evaluation, "package.json"),
  JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@hue-run/sdk": packageSpec,
      "@types/bun": pkg.devDependencies["@types/bun"],
      "@types/node": pkg.devDependencies["@types/node"],
      ai: "6.0.116",
      typescript: pkg.devDependencies.typescript,
      zod: "3.25.76",
    },
  }),
);
run(
  "npm",
  ["install", "--registry=https://registry.npmjs.org", "--no-audit", "--no-fund"],
  ai6Zod3Evaluation,
);
run(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `
  import { strict as assert } from "node:assert";
  const sdk = await import("@hue-run/sdk");
  assert.equal(typeof sdk.createHue, "function");
  const { builtins, scoreLocally } = await import("@hue-run/sdk/evals");
  const score = await scoreLocally(
    { definition: builtins.jsonSchema({ type: "string" }) },
    { inputs: {}, output: "text", hasOutput: true, hasExpected: false },
  );
  assert.equal(score.state, "error");
  assert.equal(score.error.type, "SchemaValidatorUnavailable");
`,
  ],
  ai6Zod3Evaluation,
);
await mkdir(join(ai6Zod3Evaluation, "tests"));
const ai6Zod3Tsconfig = JSON.parse(await readFile(join(source, "tsconfig.json"), "utf8"));
ai6Zod3Tsconfig.compilerOptions.lib = ["esnext"];
await writeFile(join(ai6Zod3Evaluation, "tsconfig.json"), JSON.stringify(ai6Zod3Tsconfig, null, 2));
await writeFile(
  join(ai6Zod3Evaluation, "tests", "evals-types.ts"),
  `
import { createHue } from "@hue-run/sdk";
import { attemptBaselineV2 } from "@hue-run/sdk/evals";
import { z } from "zod/v4";

type AttemptBaseline = z.infer<typeof attemptBaselineV2>;

const parsed = attemptBaselineV2.safeParse({});
if (parsed.success) {
  const baseline: AttemptBaseline = parsed.data;
  void baseline;
}
const hue = createHue({ enabled: false, captureContent: false });
void hue;
`,
);
run("npm", ["exec", "--", "tsc", "--project", "tsconfig.json", "--noEmit"], ai6Zod3Evaluation);
// Core imports must coexist with an existing AI SDK 6 application without
// forcing an upgrade. Its AI SDK telemetry adapter remains explicitly v7-only.
const ai6 = join(destination, "ai6-core-consumer");
await mkdir(ai6);
await writeFile(
  join(ai6, "package.json"),
  JSON.stringify({
    private: true,
    type: "module",
    dependencies: { ai: "6.0.116", "@hue-run/sdk": packageSpec },
  }),
);
run("npm", ["install", "--registry=https://registry.npmjs.org", "--no-audit", "--no-fund"], ai6);
run(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `
  import { strict as assert } from "node:assert";
  import { createRequire } from "node:module";
  import { createHue, createHueTransport, hueExperimentalTelemetry } from "@hue-run/sdk";
  import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
  import { LoggerProvider } from "@opentelemetry/sdk-logs";
  import { generateText } from "ai";
  import { MockLanguageModelV3 } from "ai/test";
  const require = createRequire(import.meta.url);
  assert.equal(require("ai/package.json").version, "6.0.116");
  const hue = createHue({ enabled: false, captureContent: false });
  assert.equal(await hue.withSpan("core", () => 42), 42);
  await hue.shutdownSafe();
  // AI SDK 6 per-call telemetry: spans come from Hue's tracer, parent under withSpan, and
  // metadata-only capture keeps the prompt out of the recorded attributes.
  const exporter = new InMemorySpanExporter();
  const transport = createHueTransport({
    apiKey: "synthetic-key", serviceName: "ai6", captureContent: false, baseUrl: "http://127.0.0.1:9",
  });
  const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const traced = createHue({ transport, tracerProvider, loggerProvider: new LoggerProvider({ processors: [] }) });
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: "Hello" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
  let rootSpanId = "";
  await traced.withSpan("request", async (span) => {
    rootSpanId = span.spanId;
    const result = await generateText({
      model, prompt: "private prompt", experimental_telemetry: hueExperimentalTelemetry(traced),
    });
    assert.equal(result.text, "Hello");
  });
  await tracerProvider.forceFlush();
  const aiSpans = exporter.getFinishedSpans().filter((span) => span.name.startsWith("ai."));
  assert.ok(aiSpans.length >= 2, "AI SDK 6 created spans through Hue's tracer");
  const outer = aiSpans.find((span) => span.name === "ai.generateText");
  assert.equal(outer.parentSpanContext?.spanId, rootSpanId, "AI SDK spans parent under withSpan");
  assert.equal(outer.attributes["ai.prompt"], undefined, "metadata-only capture omits prompts");
  await traced.shutdownSafe();
  await tracerProvider.shutdown();
  await transport.shutdown();
`,
  ],
  ai6,
);
// With the optional adapter installed, reject unsupported AI SDK configuration
// explicitly instead of silently providing v7 options to an AI SDK 6 caller.
run(
  "npm",
  [
    "install",
    "@ai-sdk/otel@1.0.99",
    "--registry=https://registry.npmjs.org",
    "--no-audit",
    "--no-fund",
  ],
  ai6,
);
run(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `
  import { strict as assert } from "node:assert";
  import { createRequire } from "node:module";
  import { createHue } from "@hue-run/sdk";
  import { hueTelemetry } from "@hue-run/sdk/ai-sdk";
  const hue = createHue({ apiKey: "synthetic-key", serviceName: "compatibility", captureContent: false });
  assert.throws(() => hueTelemetry(hue), /requires ai@/);
  // The adapter entry point is also reachable from CommonJS once its peer is installed.
  assert.equal(createRequire(import.meta.url)("@hue-run/sdk/ai-sdk").hueTelemetry, hueTelemetry);
  await hue.shutdownSafe();
`,
  ],
  ai6,
);
const installedPackageTests = [
  "sdk.test.ts",
  "tool-endpoint.test.ts",
  "live-spans.test.ts",
  "lifetime.test.ts",
  "evals.test.ts",
  "scorer-publication.test.ts",
  "attempt.test.ts",
  "environment.test.ts",
  "world-client.test.ts",
  "world-preparation.test.ts",
  "simulation.test.ts",
  "local-worker.test.ts",
  "coverage-gap.test.ts",
  "receipt.test.ts",
  "managed.test.ts",
  "files.test.ts",
  "world.test.ts",
  // File handoff and output collection: the library through its entry points, the installed
  // `hue` binary for `hue eval`, and internal modules from the packed dist.
  "environment-files.test.ts",
  "cli-output-safety.test.ts",
  "cli-eval-direct.test.ts",
  "cli-eval-judges.test.ts",
  // `hue listen` against a stand-in for the listen routes, through the installed binary and dist.
  "cli-listen.test.ts",
  // `hue import langfuse` against stand-ins for Langfuse's API and Hue's receiver and upload routes.
  "cli-import-langfuse.test.ts",
  // Output bounds, provider tool spans and their error-text scrubbing, and inline file digests,
  // against the packed dist.
  "evals-json.test.ts",
  "provider-tools.test.ts",
  "provider-tool-spans.test.ts",
  "inline-files.test.ts",
  // Values over the inline limit uploaded to a loopback Hue implementing the upload routes, and
  // media past the inspection bounds read in place exactly as parsed media are placed.
  "blobs.test.ts",
  "large-media.test.ts",
  // Recorded media read back by digest and files pinned on case writes, against loopback routes.
  "media.test.ts",
  "case-files.test.ts",
];
async function verifyConsumer(patch) {
  const consumer = join(destination, `consumer-${patch}`);
  const chatbot = join(destination, `chatbot-${patch}`);
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          ...pkg.devDependencies,
          ai: `7.0.${patch}`,
          "@ai-sdk/otel": `1.0.${patch}`,
          "@hue-run/sdk": packageSpec,
        },
      },
      null,
      2,
    ),
  );
  await mkdir(join(consumer, "tests"));
  await cp(join(source, "tests", "fixtures"), join(consumer, "tests", "fixtures"), {
    recursive: true,
  });
  await Promise.all(
    installedPackageTests.map((name) =>
      cp(join(source, "tests", name), join(consumer, "tests", name)),
    ),
  );
  // Consumers compile against the packed declarations without the DOM lib so a
  // browser-only type leaking into dist/*.d.ts fails here instead of at an adopter.
  const consumerTsconfig = JSON.parse(await readFile(join(source, "tsconfig.json"), "utf8"));
  consumerTsconfig.compilerOptions.lib = ["esnext"];
  await writeFile(join(consumer, "tsconfig.json"), JSON.stringify(consumerTsconfig, null, 2));
  await writeFile(
    join(consumer, "setup-contract.ts"),
    `
import {
  SETUP_EVENT_CONTRACT_VERSION,
  SetupBackendAdapter,
  createInitialSetupState,
  transitionSetup,
  type SetupEvent,
  type SetupRunOptions,
} from "@hue-run/sdk/setup";

const state = createInitialSetupState("setup_typecheck", "/project");
const transition = transitionSetup(state, { type: "start" });
const event: SetupEvent = {
  contractVersion: SETUP_EVENT_CONTRACT_VERSION,
  event: "run.started",
  runId: state.runId,
  sequence: 1,
  timestamp: new Date().toISOString(),
  command: "claim",
  mode: "jsonl",
  resumed: false,
};
declare const options: SetupRunOptions;
const backend = new SetupBackendAdapter({
  projectRoot: "/project",
  origin: "http://127.0.0.1:4318",
});
void [transition, event, options, backend];
`,
  );
  for (const name of installedPackageTests) {
    const testPath = join(consumer, "tests", name);
    await writeFile(
      testPath,
      (await readFile(testPath, "utf8"))
        .replaceAll('"../src/index.js"', '"@hue-run/sdk"')
        .replaceAll('"../src/ai-sdk.js"', '"@hue-run/sdk/ai-sdk"')
        .replaceAll('"../src/evals.js"', '"@hue-run/sdk/evals"')
        .replaceAll('"../src/environment.js"', '"@hue-run/sdk/environment"')
        .replaceAll('"../src/world.js"', '"@hue-run/sdk/world"')
        .replaceAll('"../src/client.js"', '"@hue-run/sdk"')
        .replaceAll('"../src/managed.js"', '"@hue-run/sdk/managed"')
        .replaceAll(
          '"../src/evals/checkpoint.js"',
          '"../node_modules/@hue-run/sdk/dist/evals/checkpoint.js"',
        )
        .replaceAll(
          '"../src/evals/scorer-publication.js"',
          '"../node_modules/@hue-run/sdk/dist/evals/scorer-publication.js"',
        )
        .replaceAll(
          '"../src/evals/environment-target.js"',
          '"../node_modules/@hue-run/sdk/dist/evals/environment-target.js"',
        )
        .replaceAll('"../src/evals/files.js"', '"../node_modules/@hue-run/sdk/dist/evals/files.js"')
        .replaceAll('"../src/evals/media.js"', '"../node_modules/@hue-run/sdk/dist/evals/media.js"')
        .replaceAll('"../src/evals/json.js"', '"../node_modules/@hue-run/sdk/dist/evals/json.js"')
        .replaceAll(
          '"../src/provider-tools.js"',
          '"../node_modules/@hue-run/sdk/dist/provider-tools.js"',
        )
        .replaceAll(
          '"../src/tool-definitions.js"',
          '"../node_modules/@hue-run/sdk/dist/tool-definitions.js"',
        )
        .replaceAll(
          '"../src/inline-files.js"',
          '"../node_modules/@hue-run/sdk/dist/inline-files.js"',
        )
        .replaceAll('"../src/blobs.js"', '"../node_modules/@hue-run/sdk/dist/blobs.js"')
        .replaceAll('"../src/large-media.js"', '"../node_modules/@hue-run/sdk/dist/large-media.js"')
        .replaceAll('"../src/attachment.js"', '"../node_modules/@hue-run/sdk/dist/attachment.js"')
        .replaceAll('"../src/json-edits.js"', '"../node_modules/@hue-run/sdk/dist/json-edits.js"')
        .replaceAll('"../src/snapshot.js"', '"../node_modules/@hue-run/sdk/dist/snapshot.js"')
        .replaceAll(
          '"../src/evals/exit-cleanup.js"',
          '"../node_modules/@hue-run/sdk/dist/evals/exit-cleanup.js"',
        )
        .replaceAll(
          '"../src/cli/eval-direct.js"',
          '"../node_modules/@hue-run/sdk/dist/cli/eval-direct.js"',
        )
        .replaceAll('"../src/cli/eval.js"', '"../node_modules/@hue-run/sdk/dist/cli/eval.js"')
        .replaceAll('"../src/cli/listen.js"', '"../node_modules/@hue-run/sdk/dist/cli/listen.js"')
        .replaceAll('"../src/cli/import.js"', '"../node_modules/@hue-run/sdk/dist/cli/import.js"')
        .replaceAll(
          '"../src/cli/langfuse.js"',
          '"../node_modules/@hue-run/sdk/dist/cli/langfuse.js"',
        )
        // The CLI is the installed binary, and an adapter imports the installed evals entry.
        .replaceAll('"../src/setup/cli.ts"', '"../node_modules/@hue-run/sdk/dist/setup/cli.js"')
        .replaceAll('"../src/evals.ts"', '"../node_modules/@hue-run/sdk/dist/evals.js"'),
    );
  }
  // npm enforces peer compatibility; no --force or legacy peer resolution.
  await runAsync(
    "npm",
    ["install", "--registry=https://registry.npmjs.org", "--no-audit", "--no-fund"],
    consumer,
  );
  const installed = JSON.parse(
    await readFile(join(consumer, "node_modules/@hue-run/sdk/package.json"), "utf8"),
  );
  if (installed.name !== pkg.name || installed.version !== pkg.version)
    throw new Error("Installed package does not match this checkout");
  for (const runtime of [process.execPath, "bun"]) {
    await runAsync(
      runtime,
      [join(source, "scripts/verify-scorer-deferral.mjs"), consumer],
      destination,
    );
    await runAsync(runtime, [join(source, "scripts/verify-file-cases.mjs"), consumer], destination);
  }
  // Check consumers against the packed declarations, not only source types.
  await runAsync("npm", ["exec", "--", "tsc", "--project", "tsconfig.json", "--noEmit"], consumer);
  // HUE_JUNIT_DIR (set by CI) collects a JUnit report per AI SDK pair for the workflow summary.
  const junit = process.env.HUE_JUNIT_DIR
    ? [
        "--reporter=junit",
        `--reporter-outfile=${join(process.env.HUE_JUNIT_DIR, `bun-test-ai7.0.${patch}.xml`)}`,
      ]
    : [];
  if (process.env.HUE_JUNIT_DIR) await mkdir(process.env.HUE_JUNIT_DIR, { recursive: true });
  await runAsync(
    "bun",
    ["--no-env-file", "test", ...junit, ...installedPackageTests.map((name) => `./tests/${name}`)],
    consumer,
  );
  const exampleSource = resolve(source, "../../examples/reference-chatbot");
  await cp(exampleSource, chatbot, {
    recursive: true,
    filter: (path) =>
      !/(?:^|\/)(?:node_modules|dist)(?:\/|$)/u.test(path) && !/(?:^|\/)\.env(?:\.|$)/u.test(path),
  });
  const example = JSON.parse(await readFile(join(chatbot, "package.json"), "utf8"));
  example.dependencies["@hue-run/sdk"] = packageSpec;
  example.dependencies.ai = `7.0.${patch}`;
  example.dependencies["@ai-sdk/otel"] = `1.0.${patch}`;
  await writeFile(join(chatbot, "package.json"), JSON.stringify(example, null, 2));
  // The chatbot pins the tested AI SDK pair exactly, so the install cooldown adds nothing here.
  await runAsync("bun", ["--no-env-file", "install", "--minimum-release-age=0"], chatbot);
  await runAsync("bun", ["--no-env-file", "run", "build"], chatbot);
  await runAsync(
    process.execPath,
    [join(source, "scripts/verify-node.mjs"), consumer, chatbot],
    destination,
  );
  // The same acceptance under Bun: verify-node.mjs starts the chatbot with process.execPath,
  // so this exercises the installed package and the reference chatbot on the Bun runtime.
  await runAsync(
    "bun",
    ["--no-env-file", join(source, "scripts/verify-node.mjs"), consumer, chatbot],
    destination,
  );
  await runAsync(
    process.execPath,
    ["--unhandled-rejections=strict", join(source, "scripts/verify-safety.mjs"), consumer],
    destination,
  );
  console.log(
    JSON.stringify({
      tarball: values["registry-version"] ? undefined : tarball,
      registryVersion: values["registry-version"],
      consumer,
      chatbot,
    }),
  );
}
const consumers = await Promise.allSettled([99, 100, 137, 138, 139].map(verifyConsumer));
const failures = consumers
  .filter((result) => result.status === "rejected")
  .map((result) => result.reason);
if (failures.length) throw new AggregateError(failures, "Installed consumer verification failed");
// Copy only after all installed-package and Node chatbot checks pass. Publishers
// consume these exact bytes; they must never rebuild a package after verification.
if (values["artifacts-dir"]) {
  const output = resolve(values["artifacts-dir"]);
  await mkdir(output, { recursive: true });
  await cp(tarball, join(output, basename(tarball)), { force: false, errorOnExist: true });
}
