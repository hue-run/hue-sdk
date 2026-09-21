import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { SetupProjectDetection } from "./types.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;

async function readManifest(root: string, name: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    if (info.size > MAX_MANIFEST_BYTES) return "";
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function hasAny(source: string, names: string[]): boolean {
  return names.some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(?:^|[^A-Za-z0-9_.-])${escaped}(?:$|[^A-Za-z0-9_.-])`, "iu").test(source);
  });
}

/** Reads bounded manifest and lockfile metadata without importing or executing project code. */
export async function detectSetupProject(projectRoot: string): Promise<SetupProjectDetection> {
  const root = await realpath(projectRoot);
  const names = [
    "package.json",
    "tsconfig.json",
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "pyproject.toml",
    "uv.lock",
    "poetry.lock",
    "requirements.txt",
  ] as const;
  const contents = new Map<string, string>();
  await Promise.all(
    names.map(async (name) => {
      const content = await readManifest(root, name);
      if (content !== undefined) contents.set(name, content);
    }),
  );
  const node = contents.get("package.json") ?? "";
  let nodeDependencies = new Set<string>();
  let declaredPackageManager: string | undefined;
  if (node) {
    try {
      const manifest = JSON.parse(node) as Record<string, unknown>;
      if (typeof manifest.packageManager === "string")
        declaredPackageManager = manifest.packageManager.split("@", 1)[0];
      for (const section of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        const dependencies = manifest[section];
        if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies))
          nodeDependencies = new Set([...nodeDependencies, ...Object.keys(dependencies)]);
      }
    } catch {
      // Malformed package metadata is reported only through absent detections; setup never executes it.
    }
  }
  const python = [
    contents.get("pyproject.toml"),
    contents.get("requirements.txt"),
    contents.get("uv.lock"),
    contents.get("poetry.lock"),
  ]
    .filter((value): value is string => value !== undefined)
    .join("\n");
  const languages: SetupProjectDetection["languages"] = [];
  // The existing public language discriminator covers JavaScript as well as TypeScript.
  if (
    contents.has("tsconfig.json") ||
    nodeDependencies.has("typescript") ||
    nodeDependencies.has("express")
  )
    languages.push("typescript");
  if (python || contents.has("pyproject.toml")) languages.push("python");
  const packageManagers: SetupProjectDetection["packageManagers"] = [];
  if (contents.has("bun.lock") || contents.has("bun.lockb") || declaredPackageManager === "bun")
    packageManagers.push("bun");
  if (
    contents.has("package-lock.json") ||
    contents.has("npm-shrinkwrap.json") ||
    declaredPackageManager === "npm"
  )
    packageManagers.push("npm");
  if (contents.has("pnpm-lock.yaml") || declaredPackageManager === "pnpm")
    packageManagers.push("pnpm");
  if (contents.has("yarn.lock") || declaredPackageManager === "yarn") packageManagers.push("yarn");
  if (contents.has("uv.lock") || /\[tool\.uv(?:\.|\])/u.test(python)) packageManagers.push("uv");
  if (contents.has("poetry.lock") || /\[tool\.poetry\]/u.test(python))
    packageManagers.push("poetry");
  if (contents.has("requirements.txt") && !packageManagers.includes("uv"))
    packageManagers.push("pip");
  const frameworks: SetupProjectDetection["frameworks"] = [];
  if (nodeDependencies.has("next")) frameworks.push("nextjs");
  if (nodeDependencies.has("@nestjs/core")) frameworks.push("nestjs");
  if (nodeDependencies.has("express")) frameworks.push("express");
  if (hasAny(python, ["fastapi"])) frameworks.push("fastapi");
  if (hasAny(python, ["django"])) frameworks.push("django");
  if (hasAny(python, ["flask"])) frameworks.push("flask");
  if (
    nodeDependencies.has("ai") ||
    [...nodeDependencies].some((name) => name.startsWith("@ai-sdk/"))
  )
    frameworks.push("vercel-ai-sdk");
  const hueTs = nodeDependencies.has("@hue-run/sdk") || nodeDependencies.has("hue-run");
  const huePy = hasAny(python, ["hue-run", "hue_sdk"]);
  const otelTs =
    nodeDependencies.has("@vercel/otel") ||
    [...nodeDependencies].some((name) => name.startsWith("@opentelemetry/"));
  const otelPy = /(?:^|[^A-Za-z0-9_.-])opentelemetry[-_]/iu.test(python);
  const presence = (ts: boolean, py: boolean): SetupProjectDetection["hue"] =>
    ts && py ? "multiple" : ts ? "typescript" : py ? "python" : "absent";
  const facts = {
    languages,
    packageManagers,
    frameworks,
    hue: presence(hueTs, huePy),
    openTelemetry: presence(otelTs, otelPy),
  };
  return {
    root,
    fingerprint: createHash("sha256")
      .update(`${root}\0${JSON.stringify(facts)}`)
      .digest("hex"),
    ...facts,
  };
}
