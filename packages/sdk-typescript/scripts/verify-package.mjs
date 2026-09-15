import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Work entirely outside the monorepo: no workspace symlinks or private Hue imports.
const source = fileURLToPath(new URL("../", import.meta.url));
const destination = await mkdtemp(join(tmpdir(), "hue-sdk-package-"));
const staging = join(destination, "package");
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}
await cp(source, staging, {
  recursive: true,
  filter: (path) =>
    !/(?:^|\/)(?:node_modules|dist)(?:\/|$)/u.test(path) && !/(?:^|\/)\.env(?:\.|$)/u.test(path),
});
run("bun", ["--no-env-file", "install", "--frozen-lockfile"], staging);
run("bun", ["--no-env-file", "run", "typecheck"], staging);
run("bun", ["--no-env-file", "run", "build"], staging);
run("bun", ["--no-env-file", "pm", "pack", "--destination", destination], staging);
const pkg = JSON.parse(await readFile(join(staging, "package.json"), "utf8"));
const tarball = join(destination, `hue-sdk-${pkg.version}.tgz`);
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
          "@hue/sdk": `file:${tarball}`,
        },
      },
      null,
      2,
    ),
  );
  await cp(join(source, "tests"), join(consumer, "tests"), { recursive: true });
  await cp(join(source, "tsconfig.json"), join(consumer, "tsconfig.json"));
  for (const name of ["sdk.test.ts", "evals.test.ts"]) {
    const testPath = join(consumer, "tests", name);
    await writeFile(
      testPath,
      (await readFile(testPath, "utf8"))
        .replaceAll('"../src/index.js"', '"@hue/sdk"')
        .replaceAll('"../src/ai-sdk.js"', '"@hue/sdk/ai-sdk"')
        .replaceAll('"../src/evals.js"', '"@hue/sdk/evals"'),
    );
  }
  // npm enforces peer compatibility; no --force or legacy peer resolution.
  run("npm", ["install", "--no-audit", "--no-fund"], consumer);
  // Check consumers against the packed declarations, not only source types.
  run("npm", ["exec", "--", "tsc", "--project", "tsconfig.json", "--noEmit"], consumer);
  run("bun", ["--no-env-file", "test", "./tests/sdk.test.ts", "./tests/evals.test.ts"], consumer);
  const exampleSource = resolve(source, "../../examples/reference-chatbot");
  await cp(exampleSource, chatbot, {
    recursive: true,
    filter: (path) =>
      !/(?:^|\/)(?:node_modules|dist)(?:\/|$)/u.test(path) && !/(?:^|\/)\.env(?:\.|$)/u.test(path),
  });
  const example = JSON.parse(await readFile(join(chatbot, "package.json"), "utf8"));
  example.dependencies["@hue/sdk"] = `file:${tarball}`;
  example.dependencies.ai = `7.0.${patch}`;
  example.dependencies["@ai-sdk/otel"] = `1.0.${patch}`;
  await writeFile(join(chatbot, "package.json"), JSON.stringify(example, null, 2));
  run("bun", ["--no-env-file", "install"], chatbot);
  run("bun", ["--no-env-file", "run", "build"], chatbot);
  run(process.execPath, [join(source, "scripts/verify-node.mjs"), consumer, chatbot], destination);
  console.log(JSON.stringify({ tarball, consumer, chatbot }));
}
