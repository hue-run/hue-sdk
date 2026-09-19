import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    archive: { type: "string" },
    "registry-version": { type: "string" },
    "artifacts-dir": { type: "string" },
  },
});
if (values.archive && values["registry-version"])
  throw new Error("Choose an archive or registry version");
if (values["registry-version"] && values["artifacts-dir"])
  throw new Error("Registry verification does not produce a release archive");

// Work entirely outside the monorepo: no workspace symlinks or private Hue imports.
const source = fileURLToPath(new URL("../", import.meta.url));
const destination = await mkdtemp(join(tmpdir(), "hue-sdk-package-"));
const staging = join(destination, "package");
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}
const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
if (values["registry-version"] && values["registry-version"] !== pkg.version)
  throw new Error("Registry version must match this checkout's package version");
const tarball = values.archive
  ? resolve(values.archive)
  : join(destination, `hue-run-sdk-${pkg.version}.tgz`);
if (!values.archive && !values["registry-version"]) {
  await cp(source, staging, {
    recursive: true,
    filter: (path) =>
      !/(?:^|\/)(?:node_modules|dist)(?:\/|$)/u.test(path) && !/(?:^|\/)\.env(?:\.|$)/u.test(path),
  });
  run("bun", ["--no-env-file", "install", "--frozen-lockfile"], staging);
  // The committed version literal must already match package.json; the build regenerates it.
  run("node", ["scripts/write-version.mjs", "--check"], staging);
  run("bun", ["--no-env-file", "run", "typecheck"], staging);
  run("bun", ["--no-env-file", "run", "build"], staging);
  // stripInternal must keep the transport's @internal mutators out of the published declarations.
  const transportTypes = readFileSync(join(staging, "dist", "transport.d.ts"), "utf8");
  for (const member of ["finish", "acceptedRecords", "issue", "instrumentationFailure"]) {
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
  console.log(`pack inventory: ${npmFiles.size} files agree between npm pack and bun pm pack`);
}
const packageSpec = values["registry-version"] ?? `file:${tarball}`;
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
  const environment = await import("@hue-run/sdk/environment");
  assert.equal(typeof environment.createEnvironmentClient, "function");
`,
  ],
  minimal,
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
  assert.equal(typeof sdk.createHue, "function");
  assert.equal(typeof sdk.createHueSafe, "function");
  assert.equal(typeof environment.createEnvironmentClient, "function");
  assert.equal(typeof managed.createManagedTargetHandler, "function");
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
  "evals.test.ts",
  "attempt.test.ts",
  "environment.test.ts",
  "simulation.test.ts",
  "local-worker.test.ts",
  "coverage-gap.test.ts",
  "receipt.test.ts",
  "managed.test.ts",
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
        .replaceAll('"../src/managed.js"', '"@hue-run/sdk/managed"'),
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
