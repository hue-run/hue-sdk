import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { constants } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { isLoopbackHost } from "../config.js";
import { sdkVersion } from "../version.js";
import { createWorldClient, HueWorldError, type WorldClient } from "../world/client.js";
import { agentEnvironment, worldHandoff, writeMcpConfig } from "../world/world.js";
import { DEFAULT_ENV_FILE, envFileArgument, envFileOptions } from "./env-file.js";
import {
  isObject,
  RequestError,
  send,
  slowDown,
  type JsonObject,
  type Transport,
} from "./world-http.js";
import { parseHueOrigin } from "./login.js";

/**
 * `hue world create` and `hue world run`. Create asks Hue for a World of its simulated apps
 * (`POST /api/v1/world-creations`), uploads each file to the signed URL Hue answers, marks the
 * uploads done and waits for the World. Run starts an instance of a World version
 * (`POST /api/v1/instances`), runs a command with the instance's environment, finishes the
 * instance and prints the calls, writes and coverage gaps its evidence holds.
 */

/** Streams, environment and timing seams for {@link runWorldCommand}; tests inject these. */
export interface WorldCommandIo {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** The fetch for Hue's World creation routes and the uploads. */
  fetch?: typeof fetch;
  /** Waits `ms`, resolving early when the command is stopped. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Registers the stop request (SIGINT, SIGTERM and SIGHUP by default) and returns its removal. */
  onInterrupt?: (listener: (signal: NodeJS.Signals) => void) => () => void;
}

const DEFAULT_ORIGIN = "https://app.hue.run";
const APP = /^[a-z][a-z0-9._-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The default wait for a World to be ready. */
const DEFAULT_WAIT_SECONDS = 900;
const POLL_MS = 2_000;
/** An upload of up to 25 MiB over a slow link. */
const UPLOAD_TIMEOUT_MS = 300_000;
/** A stop request this soon after the first is the same one: `npx` forwards the terminal's
 * SIGINT to a process group that already received it. */
const REPEATED_STOP_MS = 1_000;
/** How long a finished instance's evidence is waited for while Hue seals it. */
const SEAL_WAIT_MS = 30_000;
/** Lines listed per section of a run's summary. */
const LISTED = 50;
/** Ledger classifications of a call the World does not simulate. */
const GAP_CLASSIFICATIONS = new Set([
  "unknown_operation",
  "unimplemented",
  "unsupported_argument",
  "unmirrored_provider",
  "provider_not_in_world",
]);

export const WORLD_USAGE = `Usage: hue world create --apps <app,...> [options]
       hue world run <world version id> [options] -- <command> [args...]

hue world create makes a World of Hue's simulated apps, filled from your files, from a
description, or both, and prints its URL and World version once it is ready.

  --apps LIST            The World's apps, comma-separated, such as linear,slack (required)
  --name NAME            The World's name (default: the apps)
  --files DIR            Upload the files under DIR as the apps' data; Hue keeps them exactly.
                         With one app every file is that app's; with several, each app's files
                         go in DIR/<app>/. Hidden files are skipped
  --describe TEXT        Describe the data Hue generates for the apps
  --dry-run              Show what Hue would make, with a description's outline and estimate;
                         create and upload nothing
  --wait SECONDS         How long to wait for the World to be ready (default ${DEFAULT_WAIT_SECONDS}); 0 returns
                         once Hue has started on it

hue world run starts an instance of the World version, runs the command with the instance's
environment (HUE_SIM_<SURFACE>_URL, HUE_WORLD_TOKEN, HUE_WORLD_NOW, HUE_MCP_CONFIG and the rest
of the instance's variables), finishes the instance when the command exits and prints the calls
the command made, what it changed and the coverage gaps it met. The command does not receive
HUE_API_KEY or any other Hue project credential. Ctrl+C reaches the command; a second one at
least a second later kills it.

Hue:
  HUE_API_KEY            A Read and write project key (environment, --env-path or ./.env.hue)
  --origin URL           Hue origin (default HUE_BASE_URL, then ${DEFAULT_ORIGIN})
  --env-path PATH        Load a dotenv file first (--env-file also works when it exists);
                         ./.env.hue loads when HUE_API_KEY is not set. Variables already set win
  -h, --help             Show this help

Exit codes: create exits 0 when the World is ready (or started with --wait 0, or previewed with
--dry-run) and 1 when it failed or is not ready in time. run exits with the command's code, or
1 when the command succeeded but Hue could not finish or report the instance. Both exit 2 for a
usage error and 130 when stopped before the command ran.`;

class UsageError extends Error {}
/** A failure that ends the command with exit code 1; its message names no credential. */
class WorldCommandError extends Error {}

/** One file to upload: its app, its path in the app's export, a name for messages, its size and
 * digest, and its exact bytes. */
interface Upload {
  app: string;
  name: string;
  label: string;
  byteSize: number;
  sha256: string;
  bytes: () => Promise<Buffer>;
}

/** What every subcommand shares: the seams, the output and the values never printed. */
interface Context {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
  cwd: string;
  sleep: (ms: number) => Promise<void>;
  stopping: AbortController;
  /** Hue's routes, the uploads and the apps' APIs. */
  transport: Transport;
  secrets: string[];
  out: (line: string) => void;
  note: (line: string) => void;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      done();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function defaultOnInterrupt(listener: (signal: NodeJS.Signals) => void): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, listener);
  return () => {
    for (const signal of signals) process.removeListener(signal, listener);
  };
}

/** A dotenv file's variables under `env`'s: as Node's --env-file does, a variable already set
 * keeps its value. */
async function withEnvFile(
  env: NodeJS.ProcessEnv,
  cwd: string,
  file: string,
): Promise<NodeJS.ProcessEnv> {
  let content: string;
  try {
    content = await readFile(resolve(cwd, file), "utf8");
  } catch (error) {
    throw new UsageError(
      `Unable to load ${file}: ${(error as NodeJS.ErrnoException).code ?? "unreadable"}`,
    );
  }
  return { ...parseEnv(content), ...env };
}

/** The environment with the named env file loaded, then `./.env.hue` (where `hue login` stores
 * the key) when neither set `HUE_API_KEY`. */
async function loadEnv(
  env: NodeJS.ProcessEnv,
  cwd: string,
  file: string | undefined,
): Promise<NodeJS.ProcessEnv> {
  const named = file ? await withEnvFile(env, cwd, file) : env;
  if (named.HUE_API_KEY?.trim() || !existsSync(resolve(cwd, DEFAULT_ENV_FILE))) return named;
  return withEnvFile(named, cwd, DEFAULT_ENV_FILE);
}

/** The Hue origin and project key every subcommand needs. */
async function connect(
  ctx: Context,
  values: { origin?: string | undefined; "env-file"?: string | undefined; "env-path"?: string },
): Promise<{ origin: string; apiKey: string; env: NodeJS.ProcessEnv }> {
  let file: string | undefined;
  try {
    file = envFileArgument(values, ctx.cwd);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const env = await loadEnv(ctx.env, ctx.cwd, file);
  const origin = parseHueOrigin(values.origin ?? (env.HUE_BASE_URL?.trim() || DEFAULT_ORIGIN));
  if (!origin)
    throw new UsageError(
      "--origin must be an HTTPS origin such as https://app.hue.run (plain HTTP is accepted for loopback test servers only)",
    );
  const apiKey = env.HUE_API_KEY?.trim() ?? "";
  ctx.secrets.push(apiKey);
  if (!apiKey)
    throw new UsageError(
      'HUE_API_KEY is required: a "Read and write" project key, set in the environment, an --env-path file or ./.env.hue',
    );
  return { origin, apiKey, env };
}

/** Runs `hue world create` or `hue world run`; resolves to the exit code. */
export async function runWorldCommand(argv: string[], io: WorldCommandIo = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const stopping = new AbortController();
  const secrets: string[] = [];
  // Every line loses the credentials and control characters; Hue's and the apps' text is printed
  // as text.
  const clean = (text: string) => {
    let out = text;
    for (const secret of secrets) if (secret) out = out.replaceAll(secret, "[redacted]");
    return out.replace(/[^\P{Cc}\n]|\p{Cf}/gu, " ");
  };
  const sleep = (ms: number) => (io.sleep ?? defaultSleep)(ms, stopping.signal);
  const note = (line: string) => void stderr.write(`${clean(line)}\n`);
  const ctx: Context = {
    stdout,
    stderr,
    env: io.env ?? process.env,
    cwd: io.cwd ?? process.cwd(),
    sleep,
    stopping,
    transport: { fetch: io.fetch ?? fetch, sleep, signal: stopping.signal, warn: note },
    secrets,
    out: (line) => void stdout.write(`${clean(line)}\n`),
    note,
  };
  const [subcommand, ...rest] = argv[0] === "world" ? argv.slice(1) : argv;
  try {
    if (subcommand === "create") return await createWorld(rest, ctx, io);
    if (subcommand === "run") return await runInWorld(rest, ctx, io);
    if (subcommand === "-h" || subcommand === "--help") {
      stdout.write(`${WORLD_USAGE}\n`);
      return 0;
    }
    throw new UsageError(
      subcommand === undefined
        ? "Name the subcommand: hue world create or hue world run"
        : `Unknown command: hue world ${subcommand}`,
    );
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    ctx.note(error.message);
    stderr.write(`\n${WORLD_USAGE}\n`);
    return 2;
  }
}

// ---------------------------------------------------------------------------------------------
// hue world create
// ---------------------------------------------------------------------------------------------

function parseCreateArguments(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        apps: { type: "string" },
        name: { type: "string" },
        files: { type: "string" },
        describe: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        wait: { type: "string" },
        origin: { type: "string" },
        ...envFileOptions,
        help: { type: "boolean", short: "h", default: false },
      },
    }).values;
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

async function createWorld(argv: string[], ctx: Context, io: WorldCommandIo): Promise<number> {
  const values = parseCreateArguments(argv);
  if (values.help) {
    ctx.stdout.write(`${WORLD_USAGE}\n`);
    return 0;
  }
  const apps = list(values.apps);
  if (!apps.length) throw new UsageError("--apps is required, such as --apps linear,slack");
  for (const app of apps)
    if (!APP.test(app))
      throw new UsageError(`--apps names ${app}, which is not an app id such as linear or slack`);
  const name = values.name ?? apps.join(", ");
  if (!name.trim() || name.length > 100) throw new UsageError("--name must be 1 to 100 characters");
  const description = values.describe?.trim();
  if (values.describe !== undefined && !description)
    throw new UsageError("--describe needs the text that describes the data");
  const wait = values.wait === undefined ? DEFAULT_WAIT_SECONDS : Number(values.wait);
  if (!/^\d{1,6}$/u.test(values.wait ?? "0"))
    throw new UsageError("--wait must be a whole number of seconds");
  const { origin, apiKey } = await connect(ctx, values);

  const removeInterrupt = (io.onInterrupt ?? defaultOnInterrupt)(() => ctx.stopping.abort());
  let url: string | undefined;
  try {
    const uploads = values.files ? await filesFrom(ctx, values.files, apps) : [];
    const groups = new Map<string, Upload[]>();
    for (const upload of uploads)
      groups.set(upload.app, [...(groups.get(upload.app) ?? []), upload]);
    const sources = {
      ...(groups.size
        ? {
            files: [...groups].map(([app, files]) => ({
              app,
              files: files.map(({ name, byteSize, sha256 }) => ({ name, byteSize, sha256 })),
            })),
          }
        : {}),
      ...(description ? { description: { text: description } } : {}),
    };
    const hue = { origin, apiKey };
    const answer = await hueJson(ctx, hue, "POST", "/api/v1/world-creations", {
      idempotencyKey: randomUUID(),
      name,
      apps: apps.map((app) => ({ app })),
      ...(Object.keys(sources).length ? { sources } : {}),
      ...(values["dry-run"] ? { dryRun: true } : {}),
    });
    if (values["dry-run"]) {
      ctx.out("Dry run: Hue created nothing.");
      if (answer.estimate !== undefined) ctx.out(`Estimate: ${describe(answer.estimate)}`);
      if (answer.outline !== undefined)
        ctx.out(`Outline:\n${JSON.stringify(answer.outline, null, 2)}`);
      return 0;
    }
    let creation = creationOf(answer);
    url = creation.url;
    ctx.note(`World creation ${creation.id} started${url ? `: ${url}` : ""}`);
    if (groups.size) {
      await upload(ctx, answer, groups);
      creation = creationOf(
        await hueJson(ctx, hue, "POST", `/api/v1/world-creations/${creation.id}/uploaded`),
      );
    }
    const deadline = performance.now() + wait * 1000;
    let reported = "";
    while (creation.status !== "ready" && creation.status !== "failed") {
      if (creation.status !== reported) ctx.note(`Status: ${creation.status}`);
      reported = creation.status;
      if (performance.now() >= deadline) {
        const where = creation.url ?? url;
        ctx.note(
          `The World is not ready yet (${creation.status})${where ? `; follow it at ${where}` : ""}.`,
        );
        return wait === 0 ? 0 : 1;
      }
      await ctx.sleep(POLL_MS);
      creation = creationOf(
        await hueJson(ctx, hue, "GET", `/api/v1/world-creations/${creation.id}`),
      );
    }
    const where = creation.url ?? url;
    if (creation.status === "failed") {
      ctx.note(
        `World creation failed${creation.errorCode ? `: ${creation.errorCode}` : ""}.${where ? ` See ${where}` : ""}`,
      );
      if (creation.report) printReport(ctx.note, creation.report);
      return 1;
    }
    if (where) ctx.out(`World: ${where}`);
    if (creation.worldVersionId) ctx.out(`World version: ${creation.worldVersionId}`);
    if (creation.report) printReport(ctx.out, creation.report);
    if (creation.worldVersionId)
      ctx.out(`Run your agent in it: hue world run ${creation.worldVersionId} -- <command>`);
    return 0;
  } catch (error) {
    if (ctx.stopping.signal.aborted) {
      ctx.note(`Stopped.${url ? ` Hue keeps what it received: ${url}` : ""}`);
      return 130;
    }
    if (error instanceof WorldCommandError || error instanceof RequestError) {
      ctx.note(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    removeInterrupt();
  }
}

/** A comma-separated option's distinct values. */
function list(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

/** A World creation as Hue answers it, from `worldCreation` or the answer itself. */
function creationOf(answer: JsonObject) {
  const creation = isObject(answer.worldCreation) ? answer.worldCreation : answer;
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const id = text(creation.id);
  const status = text(creation.status);
  if (!id || !UUID.test(id) || !status)
    throw new WorldCommandError("Hue answered without a World creation id and status");
  return {
    id,
    status,
    url: text(creation.url),
    worldVersionId: text(creation.worldVersionId) ?? text(answer.worldVersionId),
    errorCode: text(creation.errorCode) ?? text(answer.errorCode),
    report: isObject(creation.report)
      ? creation.report
      : isObject(answer.report)
        ? answer.report
        : undefined,
  };
}

/** Every regular file under `directory`, hidden ones skipped, each assigned to an app. */
async function filesFrom(ctx: Context, directory: string, apps: string[]): Promise<Upload[]> {
  const root = resolve(ctx.cwd, directory);
  let entries;
  try {
    if (!(await stat(root)).isDirectory())
      throw new UsageError(`--files ${directory} is not a directory`);
    entries = await readdir(root, { withFileTypes: true, recursive: true });
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(
      `Unable to read --files ${directory}: ${(error as NodeJS.ErrnoException).code ?? "unreadable"}`,
    );
  }
  const uploads: Upload[] = [];
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    const label = relative(root, path);
    const parts = label.split(sep);
    if (parts.some((part) => part.startsWith("."))) continue;
    if (
      !entry.isFile() &&
      !(entry.isSymbolicLink() && (await stat(path).catch(() => null))?.isFile())
    )
      continue;
    const inApp = parts.length > 1 && apps.includes(parts[0]!);
    const app = inApp ? parts[0]! : apps.length === 1 ? apps[0]! : undefined;
    if (!app)
      throw new UsageError(
        `${join(directory, label)} is not in an app's directory: with several apps, put each app's files in ${join(directory, "<app>")}/`,
      );
    const { byteSize, sha256 } = await digest(path);
    if (!byteSize) {
      ctx.note(`Skipped ${label}: the file is empty.`);
      continue;
    }
    uploads.push({
      app,
      // The path under the app's directory, as the export laid it out.
      name: (inApp ? parts.slice(1) : parts).join("/"),
      label,
      byteSize,
      sha256,
      bytes: async () => {
        const bytes = await readFile(path);
        if (
          bytes.byteLength !== byteSize ||
          createHash("sha256").update(bytes).digest("hex") !== sha256
        )
          throw new WorldCommandError(`${label} changed after it was read; run the command again`);
        return bytes;
      },
    });
  }
  if (!uploads.length) throw new UsageError(`--files ${directory} holds no files`);
  return uploads.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

async function digest(path: string): Promise<{ byteSize: number; sha256: string }> {
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    byteSize += chunk.byteLength;
  }
  return { byteSize, sha256: hash.digest("hex") };
}

/** Sends each file Hue asks for to its signed URL. The URLs are capabilities: never printed. */
async function upload(ctx: Context, answer: JsonObject, groups: Map<string, Upload[]>) {
  const asked = Array.isArray(answer.uploads) ? answer.uploads : [];
  for (const entry of asked) {
    if (!isObject(entry) || typeof entry.app !== "string" || typeof entry.file !== "number")
      throw new WorldCommandError("Hue answered an upload without its app and file");
    // `file` numbers the app's files from 1, in the order the request listed them.
    const source = groups.get(entry.app)?.[entry.file - 1];
    if (!source)
      throw new WorldCommandError(
        `Hue asked for ${entry.app} file ${entry.file}, which the command did not send`,
      );
    const location =
      typeof entry.url === "string"
        ? entry.url
        : typeof entry.urlKey === "string"
          ? answer[entry.urlKey]
          : undefined;
    let target: URL;
    try {
      target = new URL(String(location));
    } catch {
      throw new WorldCommandError(`Hue answered no upload URL for ${source.label}`);
    }
    if (
      target.protocol !== "https:" &&
      !(target.protocol === "http:" && isLoopbackHost(target.hostname))
    )
      throw new WorldCommandError(`Hue answered an insecure upload URL for ${source.label}`);
    ctx.secrets.push(target.href, target.search);
    const headers: Record<string, string> = {};
    if (isObject(entry.uploadHeaders))
      for (const [name, value] of Object.entries(entry.uploadHeaders))
        if (typeof value === "string" && name.toLowerCase() !== "content-length")
          headers[name] = value;
    const { status } = await send(
      "The upload store",
      {
        method: typeof entry.method === "string" ? entry.method : "PUT",
        url: target.href,
        headers,
        body: new Uint8Array(await source.bytes()),
        timeoutMs: UPLOAD_TIMEOUT_MS,
      },
      ctx.transport,
      slowDown,
    );
    if (status < 200 || status >= 300)
      throw new WorldCommandError(`The upload of ${source.label} failed (HTTP ${status})`);
    ctx.note(`Uploaded ${source.app}: ${source.label} (${source.byteSize} bytes)`);
  }
}

/** One request to a Hue JSON route with retries of transient failures; the same body and
 * idempotency key are sent each time. Resolves to the answer's JSON object. */
async function hueJson(
  ctx: Context,
  hue: { origin: string; apiKey: string },
  method: "GET" | "POST",
  path: string,
  body?: JsonObject,
): Promise<JsonObject> {
  const answer = await send(
    "Hue",
    {
      method,
      url: `${hue.origin}${path}`,
      headers: {
        authorization: `Bearer ${hue.apiKey}`,
        "user-agent": `hue-sdk-typescript/${sdkVersion} hue-world`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    ctx.transport,
    slowDown,
  );
  if (answer.status < 200 || answer.status >= 300)
    throw new WorldCommandError(refusal(answer.status, answer.body));
  if (!isObject(answer.body)) throw new WorldCommandError(`Hue answered ${path} without JSON`);
  return answer.body;
}

/** What Hue's refusal says: its status, `error` and, for an invalid request, each issue. */
function refusal(status: number, json: unknown): string {
  const hint =
    status === 401
      ? " HUE_API_KEY was not accepted."
      : status === 403
        ? " HUE_API_KEY needs Read and write access."
        : status === 404
          ? " This Hue does not serve World creation yet, or the World was not found."
          : "";
  if (!isObject(json)) return `Hue refused the request (HTTP ${status}).${hint}`;
  const issues = Array.isArray(json.issues)
    ? json.issues
        .filter(isObject)
        .slice(0, 10)
        .map(
          (issue) =>
            `${Array.isArray(issue.path) ? issue.path.join(".") : ""}: ${typeof issue.message === "string" ? issue.message : ""}`,
        )
    : [];
  const error = typeof json.error === "string" ? json.error : undefined;
  return `Hue refused the request (HTTP ${status}${error ? `, ${error}` : ""}).${hint}${issues.map((issue) => `\n  ${issue}`).join("")}`;
}

/** A value of Hue's answer on one line: text as is, a number, a list's items or an object's
 * entries. */
function describe(value: unknown, depth = 0): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return String(value);
  const text =
    depth > 2
      ? JSON.stringify(value)
      : Array.isArray(value)
        ? value.map((item) => describe(item, depth + 1)).join("; ")
        : isObject(value)
          ? Object.entries(value)
              .map(([key, item]) => `${key} ${describe(item, depth + 1)}`)
              .join(", ")
          : "";
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

const REPORT_LABELS: Record<string, string> = {
  stored: "Stored",
  normalized: "Normalized",
  standIns: "Stand-ins",
  notSimulated: "Not simulated",
  assumptions: "Assumptions",
};

/** The World's report: what Hue stored, normalized, stood in for, does not simulate and
 * assumed. A list prints one item per line. */
function printReport(print: (line: string) => void, report: JsonObject) {
  for (const [key, value] of Object.entries(report)) {
    const label = REPORT_LABELS[key] ?? key;
    if (!Array.isArray(value)) {
      print(`${label}: ${describe(value)}`);
      continue;
    }
    print(`${label}: ${value.length === 0 ? "none" : value.length}`);
    for (const item of value.slice(0, LISTED)) print(`  ${describe(item, 1)}`);
    if (value.length > LISTED) print(`  ... and ${value.length - LISTED} more`);
  }
}

// ---------------------------------------------------------------------------------------------
// hue world run
// ---------------------------------------------------------------------------------------------

function parseRunArguments(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        origin: { type: "string" },
        ...envFileOptions,
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

async function runInWorld(argv: string[], ctx: Context, io: WorldCommandIo): Promise<number> {
  // Everything after `--` is the command, options included.
  const split = argv.indexOf("--");
  const { values, positionals } = parseRunArguments(split < 0 ? argv : argv.slice(0, split));
  if (values.help) {
    ctx.stdout.write(`${WORLD_USAGE}\n`);
    return 0;
  }
  const command = split < 0 ? [] : argv.slice(split + 1);
  const [version, ...extra] = positionals;
  if (!version)
    throw new UsageError("Name the World version: hue world run <world version id> -- <command>");
  if (!UUID.test(version)) throw new UsageError(`${version} is not a World version id`);
  if (extra.length)
    throw new UsageError(`Unexpected argument: ${extra[0]}; put the command after --`);
  if (!command.length) throw new UsageError("Name the command to run after --");
  const { origin, apiKey, env } = await connect(ctx, values);
  const client = createWorldClient({ apiKey, baseUrl: origin });

  // While the command runs, a stop request is the command's: the first is passed on (a terminal's
  // Ctrl+C reached it too, and a second SIGINT is harmless to a command that exits on it) and
  // another a second later kills it. Before it starts or after it ends, a stop ends the wait for
  // Hue.
  let running: ChildProcess | undefined;
  let stoppedAt: number | undefined;
  const removeInterrupt = (io.onInterrupt ?? defaultOnInterrupt)((signal) => {
    const now = performance.now();
    if (!running) ctx.stopping.abort();
    else if (stoppedAt === undefined) {
      stoppedAt = now;
      running.kill(signal);
    } else if (now - stoppedAt >= REPEATED_STOP_MS) running.kill("SIGKILL");
  });
  try {
    let instance;
    try {
      instance = await client.createInstance({
        idempotencyKey: randomUUID(),
        worldVersionId: version,
      });
    } catch (error) {
      throw new WorldCommandError(instanceRefusal(error, version));
    }
    const finish = (status: "completed" | "abandoned") =>
      client.finishInstance(instance.id, { idempotencyKey: randomUUID(), status });
    const handoff = worldHandoff(instance);
    if (!handoff || ctx.stopping.signal.aborted) {
      await finish("abandoned").catch(() => undefined);
      if (!handoff)
        throw new WorldCommandError(
          "This Hue started the instance without simulated app URLs; it cannot run a command",
        );
      ctx.note(`Stopped. Instance ${instance.id} was abandoned.`);
      return 130;
    }
    ctx.secrets.push(handoff.token);
    for (const server of Object.values(handoff.mcpConfig.mcpServers))
      for (const value of Object.values(server.headers ?? {})) ctx.secrets.push(value);
    const mcp = await writeMcpConfig(handoff);
    let code: number;
    try {
      ctx.note(
        `World instance ${instance.id} of version ${version} is live until ${handoff.expiresAt}.`,
      );
      // The parent's variables minus Hue's project credentials and any other World's variables.
      const childEnv = { ...agentEnvironment(handoff, { parent: env }), HUE_MCP_CONFIG: mcp.path };
      code = await new Promise<number>((settle) => {
        let settled = false;
        const done = (value: number) => {
          if (!settled) settle(value);
          settled = true;
        };
        const child = spawn(command[0]!, command.slice(1), { env: childEnv, stdio: "inherit" });
        running = child;
        child.on("error", (error: NodeJS.ErrnoException) => {
          running = undefined;
          ctx.note(`Unable to start ${command[0]}: ${error.code ?? error.message}`);
          done(127);
        });
        child.on("exit", (exitCode, signal) => {
          running = undefined;
          done(exitCode ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0));
        });
      });
    } finally {
      await mcp.dispose();
    }
    const status = code === 0 ? "completed" : "abandoned";
    try {
      const sealed = await finish(status);
      ctx.note(`The command exited with code ${code}; instance ${instance.id} ${status}.`);
      const evidence = await sealedEvidence(
        ctx,
        client,
        instance.id,
        sealed.completingUntil ?? null,
      );
      if (!evidence) return code || 130;
      printSummary(ctx.note, evidence);
    } catch (error) {
      if (!(error instanceof HueWorldError)) throw error;
      ctx.note(`Error: Hue could not finish or report instance ${instance.id}: ${error.message}`);
      return code || 1;
    }
    return code;
  } catch (error) {
    if (error instanceof WorldCommandError) {
      ctx.note(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    removeInterrupt();
  }
}

function instanceRefusal(error: unknown, version: string): string {
  if (!(error instanceof HueWorldError)) return "Hue could not start the instance";
  if (error.status === 401) return "Hue did not accept HUE_API_KEY (HTTP 401)";
  if (error.status === 403) return "HUE_API_KEY needs Read and write access (HTTP 403)";
  if (error.status === 404) return `This project has no World version ${version} (HTTP 404)`;
  if (error.diagnostic === "world_preparing")
    return "The World version is still being prepared; run the command again shortly";
  return `Hue could not start the instance: ${error.message}`;
}

/** The instance's ledger and diff once Hue has sealed it: a finished gateway instance seals
 * after its completion grace, and its evidence answers 409 until then. Undefined when stopped. */
async function sealedEvidence(
  ctx: Context,
  client: WorldClient,
  id: string,
  completingUntil: string | null,
): Promise<{ ledger: JsonObject; diff: JsonObject } | undefined> {
  const grace = completingUntil ? Date.parse(completingUntil) - Date.now() : 0;
  if (grace > 0) await ctx.sleep(Math.min(grace + 250, SEAL_WAIT_MS));
  const deadline = performance.now() + SEAL_WAIT_MS;
  for (;;) {
    if (ctx.stopping.signal.aborted) return undefined;
    try {
      const ledger = await client.getEvidence(id, { section: "ledger", bodies: false });
      const diff = await client.getEvidence(id, { section: "diff" });
      return { ledger, diff };
    } catch (error) {
      if (
        !(error instanceof HueWorldError) ||
        error.status !== 409 ||
        performance.now() >= deadline
      )
        throw error;
      await ctx.sleep(1_000);
    }
  }
}

const text = (value: unknown, fallback: string) =>
  typeof value === "string" && value ? value : fallback;

/** Counts of each distinct line, in first-seen order: `3 × linear/graphql issues (ok)`. */
function counted(lines: string[]): string[] {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return [...counts].map(([line, count]) => `${count} × ${line}`);
}

function section(print: (line: string) => void, title: string, total: number, lines: string[]) {
  print(`${title}: ${total || "none"}`);
  for (const line of lines.slice(0, LISTED)) print(`  ${line}`);
  if (lines.length > LISTED) print(`  ... and ${lines.length - LISTED} more`);
}

/** The calls the command made, what it changed and the calls the World does not simulate. */
function printSummary(
  print: (line: string) => void,
  evidence: { ledger: JsonObject; diff: JsonObject },
) {
  const listOf = (part: unknown) =>
    isObject(part) && Array.isArray(part.items) ? part.items.filter(isObject) : [];
  const calls = listOf(evidence.ledger.ledger).map((call) => {
    const classification = text(call.classification, "unclassified");
    return {
      line: `${text(call.surface, "unrouted")} ${text(call.operation, "unknown")} (${classification})`,
      gap: (call.gap !== null && call.gap !== undefined) || GAP_CLASSIFICATIONS.has(classification),
    };
  });
  section(print, "Calls", calls.length, counted(calls.map((call) => call.line)));
  const writes = listOf(evidence.diff.diff).map((change) => {
    if (!isObject(change.ref)) return describe(change);
    const fields = Array.isArray(change.changedFields)
      ? change.changedFields.filter((field) => typeof field === "string")
      : [];
    const where = [change.ref.instance, change.ref.collection, change.ref.id]
      .filter((part) => typeof part === "string")
      .join(" ");
    return `${text(change.change, "changed")} ${where}${
      fields.length
        ? ` (${fields.slice(0, 5).join(", ")}${fields.length > 5 ? `, ${fields.length - 5} more` : ""})`
        : ""
    }`;
  });
  section(print, "Writes", writes.length, writes);
  const gaps = calls.filter((call) => call.gap);
  const coverage = isObject(evidence.ledger.coverage) ? evidence.ledger.coverage : {};
  const reported = isObject(coverage.firstGap)
    ? [
        `reported: ${text(coverage.firstGap.provider, "unknown")} ${text(coverage.firstGap.operation, "unknown")} (${text(coverage.firstGap.code, "gap")})`,
      ]
    : [];
  section(print, "Coverage gaps", gaps.length + reported.length, [
    ...counted(gaps.map((call) => call.line)),
    ...reported,
  ]);
}
