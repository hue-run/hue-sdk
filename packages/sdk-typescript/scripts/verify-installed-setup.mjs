#!/usr/bin/env node
// Installed-package contract acceptance only. This loopback double is not hosted Fern evidence.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs/light.js";

const { values } = parseArgs({
  options: {
    archive: { type: "string" },
    "installed-package": { type: "string" },
  },
});
if (!values.archive) throw new Error("Required: --archive FILE [--installed-package DIRECTORY]");
const archive = resolve(values.archive);
const archiveBytes = await readFile(archive);
const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
const archiveIntegrity = `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`;
const destination = await mkdtemp(join(tmpdir(), "hue-installed-setup-"));
const installedPackage = values["installed-package"]
  ? resolve(values["installed-package"])
  : join(destination, "cli", "node_modules", "@hue-run", "sdk");
const stateHome = join(destination, "state");
const wrappers = join(destination, "manager-wrappers");
const tokenPattern = /^hue_setup_(live|test)_setup-([a-f0-9]{24})_([A-Za-z0-9_-]{43})$/u;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const traceType = protobuf.Root.fromJSON(
  JSON.parse(
    await readFile(new URL("../tests/fixtures/otlp-schema.json", import.meta.url), "utf8"),
  ),
).lookupType("opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest");
const secrets = new Set();
const installations = new Map();
const counters = { provisions: 0, exports: 0, receipts: 0, revoked: 0, rewrittenRefused: 0 };
const rejectedRoots = [];
let serverFailure;
let origin;
let pythonWheelEvidence;

function requireThat(condition, label) {
  // Do not include assertion actual/expected values: these may contain a test credential.
  if (!condition) throw new Error(`Installed setup assertion failed: ${label}`);
}

function noSecrets(output, label) {
  requireThat(
    !/\bhue_(?:setup|sk|install)_[A-Za-z0-9_-]+/u.test(output) &&
      !/\/setup\/claim#[A-Za-z0-9_-]+/u.test(output) &&
      !/#[A-Za-z0-9_-]{43}/u.test(output) &&
      ![...secrets].some((secret) => output.includes(secret)),
    `${label} does not disclose credentials or claim capabilities`,
  );
}

function terminalSummary(results) {
  return JSON.stringify(
    results.map((result) => ({
      exitCode: result.code,
      terminal: result.stdout.split("\n").flatMap((line) => {
        try {
          const event = JSON.parse(line);
          return event.event === "run.failed"
            ? [{ event: event.event, code: event.code }]
            : event.event === "action.required"
              ? [{ event: event.event, action: event.action }]
              : [];
        } catch {
          return [];
        }
      }),
    })),
  );
}

async function run(command, args, cwd, environment = process.env, timeoutMillis = 180_000) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      overflow = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMillis);
    const capture = (which, chunk) => {
      if (stdout.length + stderr.length + chunk.length > 2 * 1024 * 1024) {
        overflow = true;
        child.kill("SIGKILL");
      } else if (which === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Unable to start installed setup child"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      try {
        noSecrets(stdout, "child stdout");
        noSecrets(stderr, "child stderr");
        requireThat(!overflow, "bounded child output");
        resolveResult({ code, stdout, stderr });
      } catch (failure) {
        reject(failure);
      }
    });
  });
}

async function executable(name) {
  const result = await run("which", [name], destination);
  requireThat(result.code === 0 && result.stdout.trim(), `${name} is available`);
  return result.stdout.trim();
}

function credential(environment, generation) {
  const id = randomBytes(12).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const apiKey = `hue_setup_${environment}_setup-${id}_${secret}`;
  secrets.add(apiKey);
  secrets.add(secret);
  return {
    apiKey,
    keyId: `setup-${id}`,
    kind: "anonymous_trial",
    capabilities: ["setup_telemetry_write"],
    version: generation,
  };
}

function status(installation) {
  return {
    protocolVersion: 1,
    installationId: installation.id,
    state: installation.claimed ? "claimed" : "active",
    project: installation.project,
    credentialVersion: installation.claimed ? 1 : 0,
    capturePolicy: "metadata-only-v1",
    expiresAt: installation.claimed ? null : installation.expiresAt,
    limits: { traces: 100, spans: 1000, bytes: 2097152 },
    usage: {
      traces: installation.traces.size,
      spans: installation.traces.size,
      bytes: installation.bytes,
    },
    claimHandoff: installation.handoff,
    endpoints: {
      otlp: "/api/v1/otlp/v1/traces",
      receipt: "/api/v1/setup/traces/{traceId}/receipt",
    },
  };
}

function telemetryAuthentication(request) {
  const authorization = request.headers.authorization;
  for (const installation of installations.values()) {
    for (const key of installation.credentials) {
      if (authorization !== `Bearer ${key.apiKey}`) continue;
      requireThat(tokenPattern.test(key.apiKey), "exact setup token grammar");
      requireThat(
        key.keyId === `setup-${tokenPattern.exec(key.apiKey)[2]}`,
        "credential identifier binding",
      );
      if (installation.claimed && key.version === 0) {
        counters.revoked++;
        return undefined;
      }
      return installation;
    }
  }
  return undefined;
}

function receiptFor(installation, traceId, expectedSpanIds) {
  const spans = installation.traces.get(traceId);
  if (!spans) return undefined;
  return {
    traceId,
    spanCount: spans.size,
    revision: 1,
    fields: { input: false, output: false, model: false, usage: false, session: false },
    matchedSpanIds: expectedSpanIds.filter((id) => spans.has(id)),
    missingSpanIds: expectedSpanIds.filter((id) => !spans.has(id)),
    traceUrl: `${origin}/traces/${installation.internalTraceIds.get(traceId)}?projectId=${installation.project.id}&organizationId=${installation.project.organizationId}`,
  };
}

let sdkManifest;
const server = createServer((request, response) => {
  const json = (code, value) => {
    response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  };
  const error = (code, name) => json(code, { protocolVersion: 1, code: name });
  void (async () => {
    const url = new URL(request.url, origin);
    if (decodeURIComponent(url.pathname) === "/@hue-run/sdk" && request.method === "GET") {
      return json(200, {
        name: sdkManifest.name,
        "dist-tags": { latest: sdkManifest.version },
        versions: {
          [sdkManifest.version]: {
            ...sdkManifest,
            dist: {
              tarball: `${origin}/sdk.tgz`,
              integrity: archiveIntegrity,
              shasum: createHash("sha1").update(archiveBytes).digest("hex"),
            },
          },
        },
      });
    }
    if (url.pathname === "/sdk.tgz" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      return response.end(archiveBytes);
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body = Buffer.concat(chunks);
    if (url.pathname === "/api/v1/setup/preflight" && request.method === "GET") {
      requireThat(
        request.headers.authorization === undefined,
        "public preflight has no credential",
      );
      return json(200, {
        protocolVersion: 1,
        state: "available",
        capturePolicy: "metadata-only-v1",
        limits: { traces: 100, spans: 1000, bytes: 2097152 },
        lifetime: { expiresAfterSeconds: 86400, purgeAfterSeconds: 691200 },
        privacyNotice: { url: "https://hue.run/privacy", effectiveDate: "2026-08-24" },
        securityUrl: "https://trust.hue.run/",
      });
    }
    if (url.pathname === "/api/v1/setup/installations" && request.method === "POST") {
      counters.provisions++;
      const value = JSON.parse(body.toString("utf8"));
      requireThat(
        JSON.stringify(Object.keys(value).sort()) ===
          JSON.stringify(["installationId", "protocolVersion"]),
        "closed provision request",
      );
      requireThat(
        value.protocolVersion === 1 && uuidPattern.test(value.installationId),
        "provision identity",
      );
      requireThat(
        /^Bearer hue_install_[A-Za-z0-9_-]{43}$/u.test(request.headers.authorization ?? ""),
        "installation proof shape",
      );
      let installation = installations.get(value.installationId);
      if (!installation) {
        const number = installations.size;
        installation = {
          id: value.installationId,
          proof: request.headers.authorization,
          project: {
            id: `11111111-1111-4111-8111-${String(number + 1).padStart(12, "0")}`,
            organizationId: `22222222-2222-4222-8222-${String(number + 1).padStart(12, "0")}`,
          },
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          claimed: false,
          handoff: null,
          claimSecret: null,
          bytes: 0,
          traces: new Map(),
          internalTraceIds: new Map(),
          credentials: [
            credential(number % 2 ? "test" : "live", 0),
            credential(number % 2 ? "test" : "live", 1),
          ],
        };
        secrets.add(installation.proof.slice("Bearer ".length));
        installations.set(installation.id, installation);
      }
      requireThat(request.headers.authorization === installation.proof, "proof remains stable");
      return json(200, status(installation));
    }
    const setup =
      /^\/api\/v1\/setup\/installations\/([^/]+)(?:\/(credentials|claim-handoff))?$/u.exec(
        url.pathname,
      );
    if (setup) {
      const installation = installations.get(setup[1]);
      if (!installation || request.headers.authorization !== installation.proof)
        return error(401, "SETUP_UNAUTHORIZED");
      if (setup[2] === "credentials") {
        const value = JSON.parse(body.toString("utf8"));
        const generation = installation.claimed ? 1 : 0;
        requireThat(
          value.protocolVersion === 1 && value.credentialVersion === generation,
          "requested current credential generation",
        );
        return json(200, {
          ...status(installation),
          credential: installation.credentials[generation],
        });
      }
      if (setup[2] === "claim-handoff") {
        const value = JSON.parse(body.toString("utf8"));
        requireThat(
          value.protocolVersion === 1 && uuidPattern.test(value.handoffId),
          "handoff identity",
        );
        if (!installation.handoff) {
          requireThat(value.previousHandoffId === null, "first handoff predecessor");
          installation.handoff = {
            id: value.handoffId,
            state: "pending",
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            sessionExpiresAt: null,
          };
          installation.claimSecret = randomBytes(32).toString("base64url");
          secrets.add(installation.claimSecret);
        }
        requireThat(value.handoffId === installation.handoff.id, "no silent handoff replacement");
        return json(200, {
          protocolVersion: 1,
          installationId: installation.id,
          handoff: installation.handoff,
          claimUrl: `${origin}/setup/claim#${installation.claimSecret}`,
        });
      }
      return json(200, status(installation));
    }
    if (url.pathname === "/api/v1/otlp/v1/traces") {
      const installation = telemetryAuthentication(request);
      if (!installation) return error(401, "SETUP_UNAUTHORIZED");
      if (request.headers["content-encoding"] === "gzip") body = gunzipSync(body);
      const decoded = traceType.toObject(traceType.decode(body), { bytes: String });
      const spans = (decoded.resourceSpans ?? []).flatMap((resource) =>
        (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
      );
      requireThat(spans.length === 1, "one real application boundary span per export");
      for (const span of spans) {
        const traceId = Buffer.from(span.traceId, "base64").toString("hex");
        const spanId = Buffer.from(span.spanId, "base64").toString("hex");
        requireThat(
          /^[a-f0-9]{32}$/u.test(traceId) && /^[a-f0-9]{16}$/u.test(spanId),
          "decoded OTLP identity",
        );
        requireThat(
          !(span.attributes ?? []).some((item) =>
            /(?:input|output|prompt|completion|message)/iu.test(item.key),
          ),
          "metadata-only application span",
        );
        const stored = installation.traces.get(traceId) ?? new Map();
        stored.set(spanId, { kind: span.kind });
        installation.traces.set(traceId, stored);
        if (!installation.internalTraceIds.has(traceId))
          installation.internalTraceIds.set(traceId, randomUUID());
      }
      installation.bytes += body.byteLength;
      counters.exports++;
      response.writeHead(200, { "content-type": "application/x-protobuf" });
      return response.end(Buffer.alloc(0));
    }
    const receipt = /^\/api\/v1\/setup\/traces\/([a-f0-9]{32})\/receipt$/u.exec(url.pathname);
    if (receipt) {
      const installation = telemetryAuthentication(request);
      if (!installation) return error(401, "SETUP_UNAUTHORIZED");
      const evidence = receiptFor(
        installation,
        receipt[1],
        url.searchParams.getAll("expectedSpanId"),
      );
      if (!evidence) return json(404, { code: "TRACE_NOT_FOUND" });
      counters.receipts++;
      return json(200, evidence);
    }
    if (url.pathname.startsWith("/api/")) return error(401, "SETUP_UNAUTHORIZED");
    if (request.method === "GET") {
      // Registry proxy only, with no credential forwarding. Hue bytes are always the supplied archive.
      const upstream = await fetch(`https://registry.npmjs.org${url.pathname}${url.search}`, {
        headers: { accept: request.headers.accept ?? "application/json" },
        redirect: "manual",
      });
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
        ...(upstream.headers.get("location") ? { location: upstream.headers.get("location") } : {}),
      });
      return response.end(Buffer.from(await upstream.arrayBuffer()));
    }
    response.writeHead(404);
    response.end();
  })().catch((failure) => {
    serverFailure ??= failure instanceof Error ? failure.message : "Loopback contract failure";
    if (!response.headersSent) error(500, "TEST_CONTRACT_FAILURE");
    else response.end();
  });
});

const fixtureKinds = ["express-npm", "express-bun", "flask-uv"];
const fixtures = fixtureKinds.map((kind) => ({ kind, root: join(destination, kind) }));
const shellQuote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;

try {
  const realNpm = await executable("npm");
  const realUv = await executable("uv");
  if (!values["installed-package"]) {
    const cliRoot = dirname(dirname(dirname(installedPackage)));
    await mkdir(cliRoot, { recursive: true });
    await writeFile(
      join(cliRoot, "package.json"),
      JSON.stringify({ private: true, dependencies: { "@hue-run/sdk": `file:${archive}` } }),
    );
    requireThat(
      (
        await run(
          realNpm,
          [
            "install",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--registry=https://registry.npmjs.org",
          ],
          cliRoot,
        )
      ).code === 0,
      "install exact CLI archive",
    );
  }
  sdkManifest = JSON.parse(await readFile(join(installedPackage, "package.json"), "utf8"));
  const inventory = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
  requireThat(inventory.status === 0, "read exact archive inventory");
  for (const filename of inventory.stdout.split("\n").filter(Boolean)) {
    requireThat(
      filename.startsWith("package/") && !filename.split("/").includes(".."),
      "archive paths stay in installed package",
    );
    if (filename.endsWith("/")) continue;
    const packed = spawnSync("tar", ["-xOf", archive, filename], { maxBuffer: 16 * 1024 * 1024 });
    requireThat(packed.status === 0, "read exact packed file");
    const installed = await readFile(join(installedPackage, filename.slice("package/".length)));
    requireThat(packed.stdout.equals(installed), "installed CLI bytes match supplied archive");
  }
  const cli = join(dirname(dirname(installedPackage)), ".bin", "hue");
  const setup = await import(pathToFileURL(join(installedPackage, "dist", "setup.js")).href);
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  origin = `http://127.0.0.1:${server.address().port}`;
  await mkdir(wrappers);
  const npmWrapper = join(wrappers, "npm");
  await writeFile(
    npmWrapper,
    `#!/usr/bin/env node\nconst { spawnSync } = require("node:child_process");\nrequire("node:fs").appendFileSync(${JSON.stringify(join(destination, "manager-calls"))}, "npm\\n");\nconst result = spawnSync(${JSON.stringify(realNpm)}, [...process.argv.slice(2), ${JSON.stringify(`--registry=${origin}`)}], { stdio: "inherit", env: process.env });\nprocess.exit(result.status ?? 1);\n`,
  );
  await chmod(npmWrapper, 0o755);
  const uvWrapper = join(wrappers, "uv");
  await writeFile(
    uvWrapper,
    `#!/bin/sh\nprintf 'uv\\n' >> ${shellQuote(join(destination, "manager-calls"))}\nfound=0\nfor arg in "$@"; do\n  if [ "$arg" = "--no-build" ]; then found=1; fi\ndone\nif [ "$found" != 1 ]; then exit 2; fi\nexec ${shellQuote(realUv)} "$@"\n`,
  );
  await chmod(uvWrapper, 0o755);
  const opener = join(wrappers, process.platform === "darwin" ? "open" : "xdg-open");
  await writeFile(
    opener,
    `#!/usr/bin/env node\nconst { appendFileSync } = require("node:fs");\nif (process.argv.length !== 3 || !process.argv[2].startsWith("file:") || process.argv[2].includes("#")) process.exit(2);\nappendFileSync(${JSON.stringify(join(destination, "browser-open-count"))}, "1");\n`,
  );
  await chmod(opener, 0o755);
  const environment = {
    ...process.env,
    PATH: `${wrappers}:${process.env.PATH}`,
    XDG_STATE_HOME: stateHome,
    TERM: "xterm-256color",
  };
  delete environment.CI;
  delete environment.NO_COLOR;

  for (const boundary of [
    "network-path",
    "backslash-path",
    "npm-workspace",
    "uv-workspace",
    "uv-build-hook",
    "comment-only-route",
    "string-only-constructor",
    "template-only-route",
    "regex-only-route",
    "late-context-owner",
    "reexport-context-owner",
    "aliased-route",
    "all-route",
    "flask-before-request",
    "flask-route",
    "flask-app-alias",
  ]) {
    const root = join(destination, `refuse-${boundary}`);
    rejectedRoots.push(root);
    await mkdir(root);
    if (boundary.startsWith("uv-") || boundary.startsWith("flask-")) {
      await writeFile(
        join(root, "pyproject.toml"),
        '[project]\nname = "setup-refusal"\nversion = "0.0.0"\ndependencies = ["flask==3.1.2"]\n' +
          (boundary === "uv-workspace"
            ? '[tool.uv.workspace]\nmembers = ["packages/*"]\n'
            : boundary === "uv-build-hook"
              ? '[build-system]\nrequires = []\nbuild-backend = "local_build_hook"\nbackend-path = ["."]\n'
              : ""),
      );
      await writeFile(
        join(root, "uv.lock"),
        'version = 1\nrevision = 3\nrequires-python = ">=3.10"\n',
      );
      await writeFile(
        join(root, "app.py"),
        'import os\nfrom flask import Flask\napp = Flask(__name__)\n@app.get("/")\ndef home():\n    return "ok"\nif __name__ == "__main__":\n    app.run(host="127.0.0.1", port=int(os.environ["PORT"]))\n',
      );
      await writeFile(
        join(root, "local_build_hook.py"),
        'from pathlib import Path\nPath("build-hook-ran").write_text("unsafe")\n',
      );
      if (boundary.startsWith("flask-")) {
        const source = await readFile(join(root, "app.py"), "utf8");
        const competing =
          boundary === "flask-before-request"
            ? '@app.before_request\ndef intercept(): return "other handler"\n'
            : boundary === "flask-route"
              ? '@app.route("/")\ndef intercept(): return "other handler"\n'
              : "alias = app\n";
        await writeFile(
          join(root, "app.py"),
          source.replace('@app.get("/")', competing + '@app.get("/")'),
        );
      }
    } else {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          private: true,
          type: "module",
          packageManager: "npm@11.4.2",
          scripts: { start: "node server.mjs" },
          dependencies: { express: "5.1.0" },
          ...(boundary === "npm-workspace" ? { workspaces: ["packages/*"] } : {}),
        }),
      );
      const route =
        boundary === "network-path"
          ? "//127.0.0.1:1/"
          : boundary === "backslash-path"
            ? "/\\127.0.0.1:1/"
            : "/";
      await writeFile(
        join(root, "server.mjs"),
        `import express from "express";\nconst app = express();\napp.get(${JSON.stringify(route)}, (_request, response) => response.end("ok"));\napp.listen(Number(process.env.PORT), "127.0.0.1");\n`,
      );
      const path = join(root, "server.mjs");
      let source = await readFile(path, "utf8");
      if (boundary === "comment-only-route") source = source.replace("app.get(", "// app.get(");
      if (boundary === "template-only-route")
        source = source.replace(/^app.get.*$/mu, 'const note = `app.get("/", handler);`;');
      if (boundary === "regex-only-route")
        source = source.replace(/^app.get.*$/mu, "const pattern = /app.get/;");
      if (boundary === "string-only-constructor")
        source = source.replace("const app = express();", 'const note = "const app = express();";');
      if (boundary === "late-context-owner") source += 'await import("./custom-context.mjs");\n';
      if (boundary === "reexport-context-owner")
        source += 'export * from "./custom-context.mjs";\n';
      if (boundary === "all-route")
        source = source.replace(
          "app.get(",
          'app.all("/", (_request,response)=>response.end("other"));\napp.get(',
        );
      if (boundary === "aliased-route")
        source = source.replace(
          "app.get(",
          'const alias = app; alias.get("/", (_request,response)=>response.end("other"));\napp.get(',
        );
      await writeFile(path, source);
    }
    const before = JSON.stringify(counters);
    const managerBefore = await readFile(join(destination, "manager-calls"), "utf8").catch(
      () => "",
    );
    const refused = await run(cli, ["setup", "--agent", "--origin", origin], root, environment);
    const refusedEvents = refused.stdout.trim().split("\n").map(JSON.parse);
    requireThat(
      refusedEvents.some((event) => event.event === "action.required"),
      `${boundary} gives explicit action`,
    );
    requireThat(JSON.stringify(counters) === before, `${boundary} causes no backend mutation`);
    requireThat(
      (await readFile(join(destination, "manager-calls"), "utf8").catch(() => "")) ===
        managerBefore,
      `${boundary} never invokes package manager`,
    );
    for (const name of [".hue", ".gitignore", "build-hook-ran", "node_modules", ".venv"])
      requireThat(
        !(await lstat(join(root, name)).catch(() => undefined)),
        `${boundary} leaves project state untouched`,
      );
  }

  for (const [index, table] of [
    '[tool.uv."workspace"]\nmembers=["app"]\n',
    'tool.uv.workspace={members=["app"]}\n',
  ].entries()) {
    const parent = join(destination, `quoted-workspace-${index}`);
    const root = join(parent, "app");
    rejectedRoots.push(parent);
    await mkdir(root, { recursive: true });
    await mkdir(join(parent, ".venv"));
    await writeFile(join(parent, "pyproject.toml"), table);
    await writeFile(join(parent, "uv.lock"), "unchanged parent lock");
    await writeFile(join(parent, ".venv", "sentinel"), "unchanged parent environment");
    await writeFile(
      join(root, "pyproject.toml"),
      '[project]\nname="member"\nversion="0.0.0"\ndependencies=["flask==3.1.2"]\n',
    );
    await writeFile(join(root, "uv.lock"), "version = 1\n");
    await writeFile(
      join(root, "app.py"),
      'import os\nfrom flask import Flask\napp=Flask(__name__)\n@app.get("/")\ndef home(): return "ok"\napp.run(port=int(os.environ["PORT"]))\n',
    );
    const before = JSON.stringify(counters);
    const refused = await run(cli, ["setup", "--agent", "--origin", origin], root, environment);
    requireThat(
      refused.stdout
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
        .some((event) => event.event === "action.required"),
      "quoted/inline ancestor uv workspace requires explicit project selection",
    );
    requireThat(
      JSON.stringify(counters) === before,
      "ancestor workspace refusal spends no admission",
    );
    requireThat(
      (await readFile(join(parent, "uv.lock"), "utf8")) === "unchanged parent lock" &&
        (await readFile(join(parent, ".venv", "sentinel"), "utf8")) ===
          "unchanged parent environment",
      "ancestor lock/environment bytes unchanged",
    );
    for (const name of [".hue", ".gitignore", ".venv"])
      requireThat(
        !(await lstat(join(root, name)).catch(() => undefined)),
        "unsafe member root remains untouched",
      );
  }

  for (const fixture of fixtures) {
    await mkdir(fixture.root);
    requireThat(
      (await run("git", ["init", "--quiet"], fixture.root)).code === 0,
      "prepare actual fixture Git worktree",
    );
    if (fixture.kind === "flask-uv") {
      await writeFile(
        join(fixture.root, "pyproject.toml"),
        '[project]\nname = "setup-acceptance"\nversion = "0.0.0"\ndependencies = ["flask==3.1.2", "hue-run==0.2.2"]\n',
      );
      await writeFile(
        join(fixture.root, "app.py"),
        `#!/usr/bin/env python3
# coding: utf-8
# This original application docstring must survive integration.
("Original fixture module")
from __future__ import annotations
import json
import os
import time
from flask import Flask, Response, stream_with_context
from opentelemetry.trace import get_current_span
app = Flask(__name__)
@app.get("/")
def home():
    with open("handler-count.txt", "a", encoding="utf-8") as count:
        count.write("1")
    observations = []
    def observe():
        span = get_current_span()
        ids = span.get_span_context()
        observations.append({"traceId": format(ids.trace_id, "032x"), "spanId": format(ids.span_id, "016x")})
    observe()
    def body():
        observe()
        yield "o"
        time.sleep(0.01)
        observe()
        with open("handler-evidence.json", "w", encoding="utf-8") as evidence:
            json.dump({"observations": observations, "moduleDoc": __doc__}, evidence)
        yield "k"
    return Response(stream_with_context(body()))
if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ["PORT"]))
`,
      );
      requireThat((await run(realUv, ["lock"], fixture.root)).code === 0, "prepare Flask lockfile");
    } else {
      await mkdir(join(fixture.root, "src"));
      await writeFile(
        join(fixture.root, "package.json"),
        JSON.stringify({
          private: true,
          type: "module",
          scripts: { start: `${fixture.kind === "express-bun" ? "bun" : "node"} src/server.mjs` },
          dependencies: {
            express: "5.1.0",
            ...(fixture.kind === "express-npm" ? { "@hue-run/sdk": sdkManifest.version } : {}),
          },
        }),
      );
      await writeFile(
        join(fixture.root, "src", "server.mjs"),
        `import { appendFileSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { trace } from "@opentelemetry/api";
import express from "express";
const note = "const app = express();";
const template = \`app.get("/fake", handler);\`;
const pattern = /const app = express\\(\\)/;
// app.get("/comment-only", handler);
const app = express();
app.get("/", async (_request, response) => {
  appendFileSync("handler-count.txt", "1");
  writeFileSync("runtime.txt", typeof Bun === "undefined" ? "node" : "bun");
  const observations = [];
  const observe = () => { const ids = trace.getActiveSpan()?.spanContext(); observations.push({ traceId: ids?.traceId, spanId: ids?.spanId }); };
  observe();
  await Promise.resolve();
  observe();
  response.write("o");
  await setTimeout(10);
  observe();
  writeFileSync("handler-evidence.json", JSON.stringify({ observations }));
  response.end("k");
});
app.listen(Number(process.env.PORT), "127.0.0.1");
`,
      );
      if (fixture.kind === "express-bun") {
        requireThat(
          (await run("bun", ["--no-env-file", "install", "--ignore-scripts"], fixture.root))
            .code === 0,
          "prepare Bun lockfile",
        );
        await writeFile(join(fixture.root, "bunfig.toml"), `[install]\nregistry = "${origin}"\n`);
      } else
        requireThat(
          (
            await run(
              realNpm,
              [
                "install",
                "--package-lock-only",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                `--registry=${origin}`,
              ],
              fixture.root,
            )
          ).code === 0,
          "prepare npm lockfile",
        );
    }
    fixture.entrypoint = join(
      fixture.root,
      fixture.kind === "flask-uv" ? "app.py" : "src/server.mjs",
    );
    fixture.originalSource = await readFile(fixture.entrypoint, "utf8");
    const initialArgs = [
      "setup",
      ...(fixture.kind === "flask-uv" ? [] : ["--agent"]),
      "--origin",
      origin,
    ];
    const competingTemp = join(destination, `alternate-temp-${fixture.kind}`);
    await mkdir(competingTemp);
    const competing =
      fixture.kind === "express-npm"
        ? run(cli, initialArgs, fixture.root, { ...environment, TMPDIR: competingTemp })
        : undefined;
    const attempt =
      fixture.kind === "flask-uv"
        ? await run(
            "script",
            ["-qec", [cli, ...initialArgs].map(shellQuote).join(" "), "/dev/null"],
            fixture.root,
            environment,
          )
        : await run(cli, initialArgs, fixture.root, environment);
    const attempts = [attempt, ...(competing ? [await competing] : [])];
    const initial =
      attempts.find(
        (item) => item.code === 0 && item.stdout.includes('"event":"receipt.verified"'),
      ) ?? attempt;
    requireThat(
      initial.code === 0 && !initial.stderr,
      `${fixture.kind} installed setup succeeds ${terminalSummary(attempts)}`,
    );
    if (competing)
      requireThat(
        attempts.filter((item) => item.stdout.includes('"event":"receipt.verified"')).length === 1,
        "competing CLIs execute at most one request",
      );
    if (competing)
      requireThat(
        (await readFile(join(destination, "manager-calls"), "utf8"))
          .split("\n")
          .filter((manager) => manager === "npm").length === 1,
        "competing CLIs acquire ownership before dependency installation",
      );
    if (fixture.kind === "flask-uv")
      requireThat(
        initial.stdout.includes("\u001b[") && initial.stdout.includes("receipt"),
        "default terminal renderer is selected through real PTY",
      );
    else {
      const events = initial.stdout.trim().split("\n").map(JSON.parse);
      requireThat(
        events.findIndex((event) => event.event === "privacy.notice") >= 0 &&
          events.findIndex((event) => event.event === "privacy.notice") <
            events.findIndex(
              (event) => event.event === "step.started" && event.step === "install-runtime",
            ),
        "privacy disclosure precedes export",
      );
      requireThat(
        events.some(
          (event) =>
            event.event === "receipt.verified" && event.source === "repository-http-boundary",
        ),
        "agent reports actual application evidence",
      );
      requireThat(events.at(-1)?.outcome === "action_required", "account linkage remains deferred");
    }
    const privateNames = (await readdir(join(fixture.root, ".hue"))).filter((name) =>
      /^installation-.*\.json$/u.test(name),
    );
    requireThat(privateNames.length === 1, "one persistent installation per project");
    fixture.installationPath = join(fixture.root, ".hue", privateNames[0]);
    const local = JSON.parse(await readFile(fixture.installationPath, "utf8"));
    fixture.installation = installations.get(local.installationId);
    requireThat(
      fixture.installation && local.credential?.version === 0,
      "anonymous credential persisted",
    );
    requireThat(tokenPattern.test(local.credential.apiKey), "managed anonymous token namespace");
    requireThat(
      (await lstat(fixture.installationPath)).mode % 512 === 0o600,
      "owner-only installation",
    );
    const originHash = createHash("sha256").update(origin).digest("hex").slice(0, 20);
    const protectedNames = [
      basename(fixture.installationPath),
      `claim-handoff-${originHash}.html`,
      `application-evidence-${originHash}.json`,
    ];
    for (const name of [
      ...protectedNames,
      ...protectedNames.map((name) => `.${name}.test.tmp`),
      `application-evidence-${originHash}.json.123.tmp`,
    ])
      requireThat(
        (await run("git", ["check-ignore", "--quiet", "--", `.hue/${name}`], fixture.root)).code ===
          0,
        "actual Git ignores private files and temporary writes",
      );
    requireThat(
      (await run("git", ["ls-files", "--cached", "--", ".hue"], fixture.root)).stdout === "",
      "no private fixture file is tracked",
    );
    requireThat(
      local.applicationEvidence?.verified === true,
      "verified application evidence persisted",
    );
    fixture.evidence = local.applicationEvidence;
    const handlerEvidence = JSON.parse(
      await readFile(join(fixture.root, "handler-evidence.json"), "utf8"),
    );
    noSecrets(JSON.stringify(handlerEvidence), "original handler evidence");
    const boundHandler = (candidate) =>
      handlerEvidence.observations?.length === 3 &&
      handlerEvidence.observations.every(
        (observed) =>
          observed.traceId === candidate.traceId && observed.spanId === candidate.spanId,
      );
    requireThat(
      boundHandler(fixture.evidence),
      `${fixture.kind} original handler standard span IDs match application evidence across async/streaming boundaries`,
    );
    if (fixture.kind === "flask-uv")
      requireThat(
        handlerEvidence.moduleDoc === "Original fixture module",
        "parenthesized module docstring survives installed integration",
      );
    requireThat(
      !boundHandler({ traceId: "f".repeat(32), spanId: "e".repeat(16) }),
      "unrelated probe IDs cannot replace original handler IDs even with one business request",
    );
    requireThat(
      fixture.installation.traces.get(fixture.evidence.traceId)?.has(fixture.evidence.spanId),
      "receipt IDs match independently decoded OTLP",
    );
    requireThat(
      fixture.installation.traces.get(fixture.evidence.traceId)?.get(fixture.evidence.spanId)
        ?.kind === 2,
      "decoded OTLP span is SERVER",
    );
    requireThat(
      (await readFile(join(fixture.root, "handler-count.txt"), "utf8")) === "1",
      "one business request initially",
    );
    if (fixture.kind !== "flask-uv")
      requireThat(
        (await readFile(join(fixture.root, "runtime.txt"), "utf8")) ===
          (fixture.kind === "express-bun" ? "bun" : "node"),
        "launch the repository's declared runtime",
      );
    const wiredSource = await readFile(fixture.entrypoint, "utf8");
    const withoutManagedBlocks = wiredSource.replace(
      /(?:\/\/|#) Hue setup instrumentation \(managed; do not edit\)\n[\s\S]*?(?:\/\/|#) End Hue setup instrumentation\n/gu,
      "",
    );
    requireThat(
      withoutManagedBlocks.replaceAll("\n\n", "\n") ===
        fixture.originalSource.replaceAll("\n\n", "\n"),
      "managed imports and calls preserve existing business source",
    );
    requireThat(
      !/(?:TODO|placeholder|simulation)/iu.test(wiredSource),
      "real application has no placeholder integration",
    );
    requireThat(
      (
        await lstat(
          join(fixture.root, fixture.kind === "flask-uv" ? "hue_setup.py" : "hue.setup.mjs"),
        )
      ).isFile(),
      "language-appropriate generated integration exists",
    );

    // This state change models a completed browser claim only; Fern owns real browser/adoption tests.
    fixture.installation.claimed = true;
    if (fixture.kind === "express-bun")
      fixture.installation.project.organizationId = "33333333-3333-4333-8333-000000000001";
    if (fixture.installation.handoff)
      fixture.installation.handoff = {
        ...fixture.installation.handoff,
        state: "consumed",
        sessionExpiresAt: new Date(Date.now() + 1_800_000).toISOString(),
      };
    const resumed = await run(
      cli,
      ["claim", "--agent", "--origin", origin],
      fixture.root,
      environment,
    );
    requireThat(resumed.code === 0 && !resumed.stderr, `${fixture.kind} reconciles replacement`);
    const events = resumed.stdout.trim().split("\n").map(JSON.parse);
    requireThat(
      events.at(-1)?.outcome === "ready" &&
        events.some((event) => event.event === "claim.completed"),
      "claim reconciliation confirmed",
    );
    const replacement = JSON.parse(await readFile(fixture.installationPath, "utf8"));
    requireThat(
      replacement.credential.version === 1 && tokenPattern.test(replacement.credential.apiKey),
      "replacement token namespace",
    );
    requireThat(
      replacement.applicationEvidence.traceId === fixture.evidence.traceId &&
        replacement.applicationEvidence.spanId === fixture.evidence.spanId,
      "original request evidence survives claim",
    );
    requireThat(
      (await readFile(join(fixture.root, "handler-count.txt"), "utf8")) === "1",
      "claim never repeats business request",
    );
    requireThat(!replacement.revocationCredential, "old key refusal was confirmed before cleanup");
    const receiptUrl = `${origin}/api/v1/setup/traces/${fixture.evidence.traceId}/receipt?expectedSpanId=${fixture.evidence.spanId}`;
    const oldKey = fixture.installation.credentials[0].apiKey;
    requireThat(
      (
        await fetch(receiptUrl, {
          headers: { Authorization: `Bearer ${oldKey}` },
          redirect: "manual",
        })
      ).status === 401,
      "anonymous key refused on setup receipt route",
    );
    const rewritten = [
      oldKey.replace("hue_setup_", "hue_sk_"),
      oldKey.replace("hue_setup_", "hue_sk_").replace("_setup-", "_"),
    ];
    for (const apiKey of rewritten) {
      secrets.add(apiKey);
      requireThat(
        (
          await fetch(receiptUrl, {
            headers: { Authorization: `Bearer ${apiKey}` },
            redirect: "manual",
          })
        ).status === 401,
        "rewritten namespace rejected by synthetic contract double",
      );
      counters.rewrittenRefused++;
    }
    const missing = await fetch(
      `${origin}/api/v1/setup/traces/${"f".repeat(32)}/receipt?expectedSpanId=${fixture.evidence.spanId}`,
      { headers: { Authorization: `Bearer ${replacement.credential.apiKey}` }, redirect: "manual" },
    );
    requireThat(
      missing.status === 404,
      "receiver cannot fabricate evidence for an unexported trace",
    );
    // A valid unrelated exported probe must not satisfy the original handler binding.
    // This is a separate synthetic test process, never a replay of the business route.
    const unrelated =
      fixture.kind === "flask-uv"
        ? await run(
            realUv,
            [
              "run",
              "--frozen",
              "--no-build",
              "--no-sync",
              "python",
              "-c",
              `
import json
from pathlib import Path
from hue_sdk import Hue
record = json.loads(Path(${JSON.stringify(fixture.installationPath)}).read_text())
hue = Hue(api_key=record["credential"]["apiKey"], base_url=record["origin"], service_name="unrelated-probe", capture_content=False)
with hue.span("hue.metadata") as span:
    ids = {"traceId": span.trace_id, "spanId": span.span_id}
if not hue.force_flush() or not hue.shutdown():
    raise RuntimeError("Synthetic unrelated probe did not flush")
print(json.dumps(ids))
`,
            ],
            fixture.root,
            environment,
          )
        : await run(
            fixture.kind === "express-bun" ? "bun" : "node",
            [
              "--input-type=module",
              "-e",
              `
import { readFileSync } from "node:fs";
import { createHue } from "@hue-run/sdk";
const record = JSON.parse(readFileSync(${JSON.stringify(fixture.installationPath)}, "utf8"));
const hue = createHue({ apiKey: record.credential.apiKey, baseUrl: record.origin, serviceName: "unrelated-probe", captureContent: false });
const ids = await hue.withSpan("hue.metadata", span => ({traceId:span.traceId,spanId:span.spanId}));
await hue.flush(); await hue.shutdown(); console.log(JSON.stringify(ids));
`,
            ],
            fixture.root,
            environment,
          );
    requireThat(unrelated.code === 0, "actual installed unrelated probe exported");
    const unrelatedIds = JSON.parse(unrelated.stdout);
    const unrelatedReceipt = await fetch(
      `${origin}/api/v1/setup/traces/${unrelatedIds.traceId}/receipt?expectedSpanId=${unrelatedIds.spanId}`,
      { headers: { Authorization: `Bearer ${replacement.credential.apiKey}` }, redirect: "manual" },
    );
    requireThat(
      unrelatedReceipt.status === 200,
      "unrelated probe has independently decoded stored receipt",
    );
    const unrelatedEvidence = await unrelatedReceipt.json();
    requireThat(
      unrelatedEvidence.traceId === unrelatedIds.traceId &&
        unrelatedEvidence.matchedSpanIds.includes(unrelatedIds.spanId) &&
        unrelatedEvidence.missingSpanIds.length === 0 &&
        unrelatedEvidence.spanCount > 0,
      "unrelated probe receipt is genuinely valid",
    );
    requireThat(
      !boundHandler(unrelatedIds) &&
        (await readFile(join(fixture.root, "handler-count.txt"), "utf8")) === "1",
      "valid probe plus one business invocation fails original handler evidence binding",
    );
    if (fixture.kind !== "flask-uv") {
      const invalidResponse = await run(
        fixture.kind === "express-bun" ? "bun" : "node",
        [
          "--input-type=module",
          "-e",
          `
import { existsSync } from "node:fs";
import express from "express";
import { hue, installHueExpress } from "./hue.setup.mjs";
for (const status of [404,503]) {
  let calls=0; const app=express(); installHueExpress(app,"/");
  app.get("/", (_request,response)=>{calls++;response.status(status).end("business-error");});
  const server=app.listen(0,"127.0.0.1"); await new Promise(resolve=>server.once("listening",resolve));
  const response=await fetch("http://127.0.0.1:"+server.address().port+"/"); await response.arrayBuffer();
  await new Promise(resolve=>setTimeout(resolve,100)); await hue.flush();
  await new Promise(resolve=>server.close(resolve));
  if (calls!==1 || response.status!==status || existsSync(process.env.HUE_SETUP_EVIDENCE_FILE)) throw new Error("Non-success handler produced setup evidence or replayed");
}
await hue.shutdown(); console.log(JSON.stringify({cases:2,noEvidence:true}));
`,
        ],
        fixture.root,
        {
          ...environment,
          HUE_SETUP_EVIDENCE_FILE: join(
            fixture.root,
            ".hue",
            `application-evidence-${originHash}.json`,
          ),
        },
      );
      requireThat(
        invalidResponse.code === 0 && JSON.parse(invalidResponse.stdout).noEvidence === true,
        "installed generated middleware never treats 404/5xx handler as successful application evidence",
      );
    }
    const rendererEvent = {
      contractVersion: setup.SETUP_EVENT_CONTRACT_VERSION,
      runId: "setup_synthetic",
      sequence: 1,
      timestamp: new Date().toISOString(),
      event: "diagnostic",
      level: "warning",
      code: "synthetic",
      message: [
        ...fixture.installation.credentials.map((key) => key.apiKey),
        fixture.installation.credentials[0].apiKey.slice(0, -12),
        ...rewritten,
        `${origin}/setup/claim#${"q".repeat(43)}`,
      ].join(" "),
    };
    secrets.add("q".repeat(43));
    for (const render of [setup.renderHumanEvent, setup.renderPlainEvent, setup.renderJsonlEvent])
      noSecrets(render(rendererEvent), "installed renderer");
    if (fixture.kind === "flask-uv") {
      const metadataResponse = await fetch("https://pypi.org/pypi/hue-run/0.2.2/json", {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      requireThat(metadataResponse.ok, "read immutable Python release metadata");
      const metadata = await metadataResponse.json();
      const publishedWheel = metadata.urls?.find(
        (file) =>
          file.packagetype === "bdist_wheel" && file.filename === "hue_run-0.2.2-py3-none-any.whl",
      );
      requireThat(
        metadata.info?.version === "0.2.2" &&
          publishedWheel &&
          /^[a-f0-9]{64}$/u.test(publishedWheel.digests?.sha256),
        "select exact published Python wheel",
      );
      const wheelUrl = new URL(publishedWheel.url);
      requireThat(
        wheelUrl.origin === "https://files.pythonhosted.org" &&
          !wheelUrl.username &&
          !wheelUrl.password &&
          !wheelUrl.search &&
          !wheelUrl.hash,
        "wheel comes from canonical public file host",
      );
      const wheelResponse = await fetch(wheelUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      requireThat(
        wheelResponse.ok &&
          Number(wheelResponse.headers.get("content-length") ?? 0) < 10 * 1024 * 1024,
        "bounded wheel download",
      );
      const wheelBytes = Buffer.from(await wheelResponse.arrayBuffer());
      const wheelSha256 = createHash("sha256").update(wheelBytes).digest("hex");
      requireThat(
        wheelBytes.length < 10 * 1024 * 1024 && wheelSha256 === publishedWheel.digests.sha256,
        "wheel bytes match published SHA256",
      );
      const wheelPath = join(destination, publishedWheel.filename);
      await writeFile(wheelPath, wheelBytes);
      const provenance = await run(
        realUv,
        [
          "run",
          "--frozen",
          "--no-build",
          "--no-sync",
          "python",
          "-c",
          `
import base64
import csv
import hashlib
import importlib.metadata
import io
import json
from pathlib import Path
import sys
import zipfile
import hue_sdk

distribution = importlib.metadata.distribution("hue-run")
if distribution.version != "0.2.2":
    raise RuntimeError("Wrong installed Python distribution")
if Path(hue_sdk.__file__).resolve() != Path(distribution.locate_file("hue_sdk/__init__.py")).resolve():
    raise RuntimeError("Python imported a different Hue package")
with zipfile.ZipFile(sys.argv[1]) as wheel:
    records = [name for name in wheel.namelist() if name.endswith(".dist-info/RECORD")]
    if len(records) != 1:
        raise RuntimeError("Invalid wheel RECORD inventory")
    record_name = records[0]
    packaged = {row[0]: row[1:] for row in csv.reader(io.StringIO(wheel.read(record_name).decode("utf-8")))}
    installed = {row[0]: row[1:] for row in csv.reader(io.StringIO(Path(distribution.locate_file(record_name)).read_text(encoding="utf-8")))}
    checked = 0
    for name, expected in packaged.items():
        if name == record_name:
            continue
        if ".." in Path(name).parts or Path(name).is_absolute():
            raise RuntimeError("Unsafe wheel path")
        raw = wheel.read(name)
        digest = "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(raw).digest()).decode("ascii").rstrip("=")
        if expected != [digest, str(len(raw))] or installed.get(name) != expected:
            raise RuntimeError("Installed distribution RECORD differs from wheel")
        if Path(distribution.locate_file(name)).read_bytes() != raw:
            raise RuntimeError("Installed Python file differs from wheel")
        checked += 1
    package_root = Path(distribution.locate_file("hue_sdk"))
    for path in package_root.rglob("*"):
        if not path.is_file() or (path.suffix == ".pyc" and "__pycache__" in path.parts):
            continue
        name = "hue_sdk/" + path.relative_to(package_root).as_posix()
        if name not in packaged:
            raise RuntimeError("Unexpected installed Hue package file")
print(json.dumps({"wheelFilesVerified": checked, "importedInstalledPackage": True, "recordVerified": True}))
`,
          wheelPath,
        ],
        fixture.root,
        environment,
      );
      requireThat(
        provenance.code === 0 && !provenance.stderr,
        "installed Python files/RECORD match exact published wheel",
      );
      const verifiedWheel = JSON.parse(provenance.stdout);
      requireThat(
        verifiedWheel.importedInstalledPackage === true &&
          verifiedWheel.recordVerified === true &&
          verifiedWheel.wheelFilesVerified > 0,
        "Python wheel provenance verified",
      );
      pythonWheelEvidence = {
        version: "0.2.2",
        sha256: wheelSha256,
        filesVerified: verifiedWheel.wheelFilesVerified,
      };
      // Separate dummy applications exercise failure isolation, never the acceptance business route.
      const before = counters.exports;
      const lifecycle = await run(
        realUv,
        [
          "run",
          "--frozen",
          "--no-build",
          "--no-sync",
          "python",
          "-c",
          `
import json
import os
from types import SimpleNamespace
from flask import Flask
import hue_setup

preserved = 0
for failure in ("span", "enter", "exit", "flush", "evidence"):
    os.environ["HUE_SETUP_EVIDENCE_FILE"] = str(hue_setup._evidence_path)
    counts = {name: 0 for name in ("business", "span", "enter", "exit", "flush", "evidence")}
    class Context:
        def __enter__(self):
            counts["enter"] += 1
            if failure == "enter":
                raise RuntimeError("synthetic span-entry failure")
            return SimpleNamespace(trace_id="a" * 32, span_id="b" * 16)
        def __exit__(self, *_args):
            counts["exit"] += 1
            if failure == "exit":
                raise RuntimeError("synthetic span-exit failure")
    def span(_name, **_kwargs):
        counts["span"] += 1
        if failure == "span":
            raise RuntimeError("synthetic span-construction failure")
        return SimpleNamespace(get_span_context=lambda: SimpleNamespace(trace_id=int("a" * 32, 16), span_id=int("b" * 16, 16)), end=lambda: None)
    def flush():
        counts["flush"] += 1
        if failure == "flush":
            raise RuntimeError("synthetic flush failure")
        return True
    def evidence(_value):
        counts["evidence"] += 1
        if failure == "evidence":
            raise RuntimeError("synthetic evidence failure")
    hue_setup.hue = SimpleNamespace(tracer=SimpleNamespace(start_span=span), force_flush=flush)
    hue_setup.use_span = lambda *_args, **_kwargs: Context()
    hue_setup._save_evidence = evidence
    app = Flask("lifecycle-" + failure)
    hue_setup.install_hue_flask(app, "/lifecycle")
    @app.get("/lifecycle")
    def business():
        counts["business"] += 1
        return "business-response", 207
    response = app.test_client().get("/lifecycle")
    if response.status_code != 207 or response.data != b"business-response" or counts["business"] != 1:
        raise RuntimeError("Telemetry changed the dummy application response")
    if counts[failure] != 1:
        raise RuntimeError("The selected telemetry failure hook was not exercised")
    preserved += 1
failure = "normal"
counts = {name: 0 for name in ("business", "span", "enter", "exit", "flush", "evidence")}
os.environ.pop("HUE_SETUP_EVIDENCE_FILE", None)
normal = Flask("normal-serving")
hue_setup.install_hue_flask(normal, "/normal")
@normal.get("/normal")
def normal_business():
    counts["business"] += 1
    return "normal-response", 203
response = normal.test_client().get("/normal")
if response.status_code != 203 or response.data != b"normal-response" or counts != {"business": 1, "span": 1, "enter": 1, "exit": 1, "flush": 0, "evidence": 0}:
    raise RuntimeError("Ordinary serving must not force a flush or save setup evidence")
for status in (404, 503):
    counts = {name: 0 for name in ("business", "span", "enter", "exit", "flush", "evidence")}
    os.environ["HUE_SETUP_EVIDENCE_FILE"] = str(hue_setup._evidence_path)
    app = Flask("invalid-response-" + str(status))
    hue_setup.install_hue_flask(app, "/")
    @app.get("/")
    def invalid_business():
        counts["business"] += 1
        return "business-error", status
    response = app.test_client().get("/")
    if response.status_code != status or counts["business"] != 1 or counts["flush"] or counts["evidence"]:
        raise RuntimeError("Non-success handler became setup evidence")
print(json.dumps({"cases": 5, "responsesPreserved": preserved, "normalServingWithoutFlush": True}))
`,
        ],
        fixture.root,
        environment,
      );
      requireThat(
        lifecycle.code === 0 && !lifecycle.stderr,
        "installed Flask telemetry failures preserve application behavior",
      );
      requireThat(
        JSON.parse(lifecycle.stdout).responsesPreserved === 5 &&
          JSON.parse(lifecycle.stdout).normalServingWithoutFlush === true,
        "all Flask lifecycle failure responses preserved",
      );
      requireThat(
        counters.exports === before &&
          (await readFile(join(fixture.root, "handler-count.txt"), "utf8")) === "1",
        "lifecycle cases do not replay/export acceptance business request",
      );
    }
    const beforeProtectionRefusal = JSON.stringify(counters);
    const privateBeforeRefusal = await readFile(fixture.installationPath, "utf8");
    const ignorePath = join(fixture.root, ".hue", ".gitignore");
    const safeIgnore = await readFile(ignorePath, "utf8");
    for (const conflict of ["ignore-negation", "tracked-placeholder"]) {
      if (conflict === "ignore-negation")
        await writeFile(ignorePath, `${safeIgnore}!installation-*.json\n`);
      else {
        // Stage only a synthetic placeholder, never the actual installation or handoff.
        await writeFile(join(fixture.root, ".hue", "installation-placeholder.json"), "placeholder");
        requireThat(
          (
            await run(
              "git",
              ["add", "--force", "--", ".hue/installation-placeholder.json"],
              fixture.root,
            )
          ).code === 0,
          "prepare tracked non-secret refusal fixture",
        );
      }
      const refused = await run(
        cli,
        ["resume", "--agent", "--origin", origin],
        fixture.root,
        environment,
      );
      requireThat(refused.code !== 0, "unsafe private Git protection refuses installed resume");
      requireThat(
        JSON.stringify(counters) === beforeProtectionRefusal,
        "unsafe Git state causes no backend request",
      );
      requireThat(
        (await readFile(join(fixture.root, "handler-count.txt"), "utf8")) === "1",
        "unsafe Git state never replays business work",
      );
      requireThat(
        (await readFile(fixture.installationPath, "utf8")) === privateBeforeRefusal,
        "unsafe Git state preserves private file",
      );
      if (conflict === "ignore-negation") {
        requireThat(
          (await readFile(ignorePath, "utf8")) === `${safeIgnore}!installation-*.json\n`,
          "user ignore conflict is not overwritten",
        );
        await writeFile(ignorePath, safeIgnore);
      }
    }
  }
  requireThat(!serverFailure, "loopback contract remained valid");
  requireThat(
    counters.provisions === 3 && installations.size === 3,
    "bounded synthetic matrix admissions",
  );
  requireThat(
    counters.exports === 10,
    "three application exports, three unrelated probes and four isolated failed-response middleware checks",
  );
  requireThat(
    counters.revoked === 6 && counters.rewrittenRefused === 6,
    "all installed fixtures check anonymous/reforged refusal",
  );
  process.stdout.write(
    `${JSON.stringify({ kind: "synthetic-loopback-installed-setup", archiveSha256, pythonWheelEvidence, fixtureKinds, ...counters, hostedAcceptance: false })}\n`,
  );
} finally {
  // Never retain credentials, claim capabilities or checkpoint contents as test artifacts.
  await Promise.all(
    [...fixtures.map((fixture) => fixture.root), ...rejectedRoots].map((root) =>
      rm(join(root, ".hue"), { recursive: true, force: true }),
    ),
  );
  await rm(stateHome, { recursive: true, force: true });
  if (server.listening) {
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}
