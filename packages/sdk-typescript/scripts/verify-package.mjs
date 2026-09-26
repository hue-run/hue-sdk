import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

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
    "finish",
    "acceptedRecords",
    "issue",
    "instrumentationFailure",
    "placeholderMarkers",
    "placeholderSettled",
    "sendsPlaceholders",
    "rejectPlaceholders",
  ]) {
    if (new RegExp(`^\\s+${member}\\(`, "m").test(transportTypes))
      throw new Error(`dist/transport.d.ts exposes internal member ${member}()`);
  }
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
// Without the optional zod peer, hue eval names it and the install command instead of the
// runtime's resolution error, and exits with the configuration error code.
const missingPeer = spawnSync(
  process.execPath,
  [join(minimal, "node_modules/@hue-run/sdk/dist/setup/cli.js"), "eval", "--help"],
  { cwd: minimal, encoding: "utf8" },
);
if (
  missingPeer.status !== 2 ||
  !missingPeer.stderr.includes("hue eval needs zod, a peer dependency of @hue-run/sdk") ||
  !missingPeer.stderr.includes(`npm install "zod@${pkg.peerDependencies.zod}"`)
)
  throw new Error(
    `hue eval without zod did not name the missing peer (status ${missingPeer.status}): ${missingPeer.stderr.slice(0, 500)}`,
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
    child.on("error", failed);
    child.on("close", (status) => finished({ status, output }));
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
// Evaluation/simulation users install the optional validation peer. Ajv remains separately
// optional: without it the JSON Schema scorer reports a typed error instead of crashing.
const evaluation = join(destination, "evaluation-consumer");
await mkdir(evaluation);
await writeFile(
  join(evaluation, "package.json"),
  JSON.stringify({
    private: true,
    type: "module",
    dependencies: { "@hue-run/sdk": packageSpec, zod: pkg.devDependencies.zod },
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
  "live-spans.test.ts",
  "evals.test.ts",
  "scorer-publication.test.ts",
  "attempt.test.ts",
  "environment.test.ts",
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
  // `hue listen` against a stand-in for the listen routes, through the installed binary and dist.
  "cli-listen.test.ts",
  // Output bounds, provider tool spans and their error-text scrubbing, and inline file digests,
  // against the packed dist.
  "evals-json.test.ts",
  "provider-tools.test.ts",
  "provider-tool-spans.test.ts",
  "inline-files.test.ts",
];
for (const patch of [99, 100]) {
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
        // The CLI is the installed binary, and an adapter imports the installed evals entry.
        .replaceAll('"../src/setup/cli.ts"', '"../node_modules/@hue-run/sdk/dist/setup/cli.js"')
        .replaceAll('"../src/evals.ts"', '"../node_modules/@hue-run/sdk/dist/evals.js"'),
    );
  }
  // npm enforces peer compatibility; no --force or legacy peer resolution.
  run(
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
    run(runtime, [join(source, "scripts/verify-scorer-deferral.mjs"), consumer], destination);
    run(runtime, [join(source, "scripts/verify-file-cases.mjs"), consumer], destination);
  }
  // Check consumers against the packed declarations, not only source types.
  run("npm", ["exec", "--", "tsc", "--project", "tsconfig.json", "--noEmit"], consumer);
  // HUE_JUNIT_DIR (set by CI) collects a JUnit report per AI SDK pair for the workflow summary.
  const junit = process.env.HUE_JUNIT_DIR
    ? [
        "--reporter=junit",
        `--reporter-outfile=${join(process.env.HUE_JUNIT_DIR, `bun-test-ai7.0.${patch}.xml`)}`,
      ]
    : [];
  if (process.env.HUE_JUNIT_DIR) await mkdir(process.env.HUE_JUNIT_DIR, { recursive: true });
  run(
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
  run("bun", ["--no-env-file", "install", "--minimum-release-age=0"], chatbot);
  run("bun", ["--no-env-file", "run", "build"], chatbot);
  run(process.execPath, [join(source, "scripts/verify-node.mjs"), consumer, chatbot], destination);
  // The same acceptance under Bun: verify-node.mjs starts the chatbot with process.execPath,
  // so this exercises the installed package and the reference chatbot on the Bun runtime.
  run(
    "bun",
    ["--no-env-file", join(source, "scripts/verify-node.mjs"), consumer, chatbot],
    destination,
  );
  run(
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
// Copy only after all installed-package and Node chatbot checks pass. Publishers
// consume these exact bytes; they must never rebuild a package after verification.
if (values["artifacts-dir"]) {
  const output = resolve(values["artifacts-dir"]);
  await mkdir(output, { recursive: true });
  await cp(tarball, join(output, basename(tarball)), { force: false, errorOnExist: true });
}
