import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs, parseEnv } from "node:util";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BlobUploader, uploadBudgetMillis, type UploadContext } from "../blobs.js";
import { createHue, HueConnectionError, type HueClient } from "../client.js";
import { isLoopbackHost } from "../config.js";
import { HueExportError } from "../transport.js";
import { sdkVersion } from "../version.js";
import { DEFAULT_ENV_FILE, envFileArgument, envFileOptions } from "./env-file.js";
import {
  hueTraceId,
  ImportStopped,
  LangfuseApi,
  LangfuseError,
  observationSpan,
  placeMedia,
  readableSpan,
  spanMedia,
  storeSpanContent,
  traceContext,
  TraceMedia,
  traceSpan,
  uploadableUses,
  widen,
  type ImportSpan,
  type ImportWindow,
  type LangfuseApiVersion,
  type LangfuseObservation,
  type LangfuseTrace,
  type MediaUse,
  type TimeBounds,
  type TraceContext,
  type UploadedMedia,
} from "./langfuse.js";
import { parseHueOrigin } from "./login.js";

/**
 * `hue import langfuse`: copies a Langfuse project's traces into Hue from this machine. Langfuse
 * is read with the project's own keys through its public API; each observation becomes the span
 * the Langfuse OpenTelemetry SDKs would have recorded and is exported through the SDK's own
 * transport, so batching, retries, limits, content capture and large-value uploads are the SDK's.
 * Ids are kept or derived from Langfuse's, so a second run sends the same spans again and Hue
 * keeps one copy of each: an interrupted or partly failed import is resumed by running it again.
 */

/** Streams, environment and timing seams for {@link runImportCommand}; tests inject these. */
export interface ImportCommandIo {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fetch?: typeof fetch;
  /** Waits `ms`, resolving early when the import is stopped. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Registers the stop request (SIGINT and SIGTERM by default) and returns its removal. */
  onInterrupt?: (listener: () => void) => () => void;
  /** The current time, for the default end of the window. */
  now?: () => Date;
  /** Ends the process after a second stop request (`process.exit` by default), so exports still
   * in flight do not hold it until their requests time out. */
  exit?: (code: number) => void;
}

const DEFAULT_ORIGIN = "https://app.hue.run";
const DEFAULT_LANGFUSE = "https://cloud.langfuse.com";
const DEFAULT_SERVICE_NAME = "langfuse";
/** The instrumentation scope of every imported span. */
const SCOPE = { name: "@hue-run/sdk/import/langfuse" };
/** Spans queued for export before the import waits for them to be sent. */
const DRAIN_SPANS = 1024;
/** Bytes queued for export before the import waits for them to be sent. */
const DRAIN_BYTES = 32 * 1024 * 1024;
/** The SDK queue's byte budget for an import: its largest. */
const QUEUE_BYTES = 64 * 1024 * 1024;
/** Traces whose Langfuse id is remembered to name them in Hue's export issues. */
const REMEMBERED_TRACES = 10_000;
/** Failed traces listed in the summary. */
const LISTED_FAILURES = 20;
const MAX_TRACE_IDS = 1000;
const PROGRESS_EVERY_TRACES = 100;
const PROGRESS_EVERY_MS = 10_000;
/** A stop request this soon after the first is the same one: `npx` forwards the terminal's
 * SIGINT to a process group that already received it. */
const REPEATED_STOP_MS = 1_000;
/** How long before the command starts the default window ends: a trace still running, or still
 * arriving in Langfuse, is left for a later run rather than sent half recorded (Hue would then
 * refuse its finished spans). */
const SETTLE_MS = 60 * 60_000;
/** How long one value's upload may take: up to 25 MiB over a slow link. */
const UPLOAD_DEADLINE_MS = 300_000;

export const IMPORT_USAGE = `Usage: hue import langfuse [options]

Copy traces from a Langfuse project into Hue. The import runs on this machine with your own
Langfuse keys, which are sent only to Langfuse. Each observation becomes a span with the
langfuse.* attributes Hue reads; ids are kept, so running the same command again resumes an
import without duplicating what was already sent. Langfuse's environment is also sent, as
recorded, as hue.import.source_environment. Ended traces with a resolved user can contribute to
that user's World regardless of deployment environment. Traces linked to Hue runs, World instances,
or run executions never contribute. Hue's evaluation and simulation evidence and deliberately
excluded traces also stay excluded.

Langfuse (keys from the environment or --env-path; the secret key never from the command line):
  LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY  The Langfuse project's API keys
  LANGFUSE_BASE_URL or LANGFUSE_HOST        Langfuse host (default ${DEFAULT_LANGFUSE})
  --langfuse-host URL                       Langfuse host, instead of the variables
  --langfuse-public-key KEY                 Public key, instead of LANGFUSE_PUBLIC_KEY

Hue:
  HUE_API_KEY            The Hue project key the traces are sent with (environment, --env-path
                         or ./.env.hue); not needed with --dry-run
  --origin URL           Hue origin (default HUE_BASE_URL, then ${DEFAULT_ORIGIN})
  --service-name NAME    service.name of the imported spans (default ${DEFAULT_SERVICE_NAME})

Selection (newest first):
  --from TIME            Traces that started at or after TIME: an ISO 8601 date (midnight UTC)
                         or a date and time with a zone, such as 2026-01-01T09:00:00Z
  --to TIME              Traces that started before TIME (default: an hour before the command
                         starts, so traces still running are left for a later run)
  --limit N              At most N traces
  --trace-id ID          This Langfuse trace (repeatable); not with --from, --to or --limit

Content:
  --media                Download the files Langfuse media references (@@@langfuseMedia:…@@@)
                         point to and upload them to Hue; without it, references stay as text
  --no-content           Send metadata only: no inputs, outputs, status messages or model
                         parameters (content is sent by default, as the SDK records it)

Run:
  --dry-run              Read Langfuse and count what would be imported; send nothing to Hue
  --yes                  Import without asking for confirmation (required without a terminal)
  --env-path PATH        Load a dotenv file first (--env-file also works when it exists);
                         ./.env.hue loads when HUE_API_KEY is not set. Variables already set win
  -h, --help             Show this help

Exit codes: 0 every trace was imported, 1 a trace, span or file was not, 2 usage error,
130 stopped (run the same command again to resume).`;

class UsageError extends Error {}

/** Why the import ended early, when it did: a stop request, or a failure that ends it. */
type Ending = { kind: "stopped" } | { kind: "failed"; message: string };

function parseImportArguments(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      limit: { type: "string" },
      "trace-id": { type: "string", multiple: true },
      "dry-run": { type: "boolean", default: false },
      media: { type: "boolean", default: false },
      "no-content": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      origin: { type: "string" },
      "service-name": { type: "string" },
      "langfuse-host": { type: "string" },
      "langfuse-public-key": { type: "string" },
      ...envFileOptions,
      help: { type: "boolean", short: "h", default: false },
    },
  });
}

/** An instant of the window: an ISO 8601 date (midnight UTC) or a date and time with a zone. */
export function parseInstant(option: string, value: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2})))?$/iu.exec(
      value,
    );
  const [year, month, day, hour, minute, second, zoneHour, zoneMinute] = (match ?? [])
    .slice(1)
    .map((part) => Number(part ?? 0));
  // A calendar date and a time of day as written: JavaScript would roll 2026-02-30 into March.
  const valid =
    match !== null &&
    month! >= 1 &&
    month! <= 12 &&
    day! >= 1 &&
    day! <= new Date(Date.UTC(year!, month!, 0)).getUTCDate() &&
    hour! <= 23 &&
    minute! <= 59 &&
    second! <= 59 &&
    zoneHour! <= 23 &&
    zoneMinute! <= 59;
  const millis = valid ? Date.parse(match[4] === undefined ? `${value}T00:00:00Z` : value) : NaN;
  if (!Number.isFinite(millis))
    throw new UsageError(
      `${option} must be an ISO 8601 date or a date and time with a time zone, for example 2026-01-01 or 2026-01-01T09:00:00Z`,
    );
  return new Date(millis).toISOString();
}

/** The Langfuse host as a base URL without a trailing slash, or why it is refused. */
export function parseLangfuseHost(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError("The Langfuse host must be a URL such as https://cloud.langfuse.com");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname)))
    throw new UsageError(
      "The Langfuse host must use https (plain http is accepted for this machine only), because the keys travel with every request",
    );
  if (url.username || url.password || url.search || url.hash)
    throw new UsageError("The Langfuse host must not carry credentials, a query or a fragment");
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
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

/** The environment with the named env file loaded, then, when the Hue key is needed and neither
 * set `HUE_API_KEY`, `./.env.hue` (where `hue login` stores it): the Langfuse keys can sit in a
 * file of their own. A dry run needs no Hue key and reads no `./.env.hue` beside a named file. */
async function loadEnv(
  env: NodeJS.ProcessEnv,
  cwd: string,
  file: string | undefined,
  needsHueKey: boolean,
): Promise<NodeJS.ProcessEnv> {
  const named = file ? await withEnvFile(env, cwd, file) : env;
  if (
    named.HUE_API_KEY?.trim() ||
    (file && !needsHueKey) ||
    !existsSync(resolve(cwd, DEFAULT_ENV_FILE))
  )
    return named;
  return withEnvFile(named, cwd, DEFAULT_ENV_FILE);
}

function defaultOnInterrupt(listener: () => void): () => void {
  process.on("SIGINT", listener);
  process.on("SIGTERM", listener);
  return () => {
    process.removeListener("SIGINT", listener);
    process.removeListener("SIGTERM", listener);
  };
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

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Runs `hue import langfuse`; resolves to the exit code. */
export async function runImportCommand(argv: string[], io: ImportCommandIo = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const stdin = io.stdin ?? process.stdin;
  const cwd = io.cwd ?? process.cwd();
  const secrets: string[] = [];
  // Every line loses the keys and control characters; Langfuse ids and hosts are printed as text.
  const clean = (line: string) => {
    let out = line;
    for (const secret of secrets) if (secret) out = out.replaceAll(secret, "[redacted]");
    return out.replace(/[^\P{Cc}\n\t]|\p{Cf}/gu, " ");
  };
  const out = (line: string) => void stdout.write(`${clean(line)}\n`);
  const warn = (line: string) => void stderr.write(`${clean(line)}\n`);

  let values: ReturnType<typeof parseImportArguments>["values"];
  let window: ImportWindow = {};
  let limit: number | undefined;
  let traceIds: string[] = [];
  let langfuseHost: string;
  let publicKey: string;
  let secretKey: string;
  let origin: string;
  let apiKey = "";
  let serviceName: string;
  try {
    let parsed: ReturnType<typeof parseImportArguments>;
    try {
      parsed = parseImportArguments(argv);
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
    values = parsed.values;
    if (values.help) {
      stdout.write(`${IMPORT_USAGE}\n`);
      return 0;
    }
    const positionals =
      parsed.positionals[0] === "import" ? parsed.positionals.slice(1) : parsed.positionals;
    if (positionals.length === 0) throw new UsageError("Name the source to import: langfuse");
    if (positionals[0] !== "langfuse")
      throw new UsageError(`Unknown source: ${positionals[0]}; hue import reads langfuse`);
    if (positionals.length > 1) throw new UsageError(`Unexpected argument: ${positionals[1]}`);
    traceIds = values["trace-id"] ?? [];
    if (traceIds.length && (values.from || values.to || values.limit))
      throw new UsageError(
        "--trace-id selects its traces: do not combine it with --from, --to or --limit",
      );
    if (traceIds.length > MAX_TRACE_IDS)
      throw new UsageError(`Pass at most ${MAX_TRACE_IDS} --trace-id values`);
    for (const id of traceIds)
      if (!id || id.length > 512 || /[\s/?#]/u.test(id))
        throw new UsageError("--trace-id must be a Langfuse trace id");
    traceIds = [...new Set(traceIds)];
    const to = values.to
      ? parseInstant("--to", values.to)
      : new Date((io.now?.() ?? new Date()).getTime() - SETTLE_MS).toISOString();
    window = { ...(values.from ? { from: parseInstant("--from", values.from) } : {}), to };
    if (window.from && window.from >= to) throw new UsageError("--from must be before --to");
    if (values.limit !== undefined) {
      if (!/^\d{1,9}$/u.test(values.limit) || Number(values.limit) < 1)
        throw new UsageError("--limit must be a positive integer");
      limit = Number(values.limit);
    }
    if (values.media && values["no-content"])
      throw new UsageError("--media uploads content; it cannot be combined with --no-content");
    serviceName = values["service-name"] ?? DEFAULT_SERVICE_NAME;
    if (!serviceName.trim() || serviceName.length > 256)
      throw new UsageError("--service-name must be 1 to 256 characters");
    let envFile: string | undefined;
    try {
      envFile = envFileArgument(values, cwd);
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
    const env = await loadEnv(io.env ?? process.env, cwd, envFile, !values["dry-run"]);
    langfuseHost = parseLangfuseHost(
      values["langfuse-host"] ??
        (env.LANGFUSE_BASE_URL?.trim() || env.LANGFUSE_HOST?.trim() || DEFAULT_LANGFUSE),
    );
    publicKey = values["langfuse-public-key"] ?? env.LANGFUSE_PUBLIC_KEY?.trim() ?? "";
    secretKey = env.LANGFUSE_SECRET_KEY?.trim() ?? "";
    secrets.push(secretKey);
    if (!publicKey || !secretKey)
      throw new UsageError(
        "Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY (the Langfuse project's API keys) in the environment or an --env-path file",
      );
    if (/\s/u.test(publicKey) || /\s/u.test(secretKey))
      throw new UsageError("The Langfuse keys must not contain whitespace");
    if (publicKey.startsWith("sk-lf-"))
      throw new UsageError(
        "The Langfuse public key is a secret key (sk-lf-…); the secret key goes in LANGFUSE_SECRET_KEY",
      );
    const parsedOrigin = parseHueOrigin(
      values.origin ?? (env.HUE_BASE_URL?.trim() || DEFAULT_ORIGIN),
    );
    if (!parsedOrigin)
      throw new UsageError(
        "--origin must be an HTTPS origin such as https://app.hue.run (plain HTTP is accepted for loopback test servers only)",
      );
    origin = parsedOrigin;
    if (!values["dry-run"]) {
      apiKey = env.HUE_API_KEY?.trim() ?? "";
      secrets.push(apiKey);
      if (!apiKey)
        throw new UsageError(
          "HUE_API_KEY is required: the Hue project key, set in the environment, an --env-path file or ./.env.hue",
        );
      if (!values.yes && stdin.isTTY !== true)
        throw new UsageError("Pass --yes to import without a terminal to confirm in");
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    warn(error.message);
    stderr.write(`\n${IMPORT_USAGE}\n`);
    return 2;
  }

  const dryRun = values["dry-run"];
  const stopping = new AbortController();
  const forced = new AbortController();
  let stoppedAt = 0;
  const removeInterrupt = (io.onInterrupt ?? defaultOnInterrupt)(() => {
    if (!stopping.signal.aborted) {
      stoppedAt = performance.now();
      stopping.abort();
      warn("Stopping: sending what was read (press Ctrl+C again to stop at once).");
    } else if (performance.now() - stoppedAt >= REPEATED_STOP_MS && !forced.signal.aborted) {
      warn("Stopping at once; run the same command again to resume.");
      forced.abort();
    }
  });
  const sleep = (ms: number) => (io.sleep ?? defaultSleep)(ms, stopping.signal);
  let hue: HueClient | undefined;
  let uploader: BlobUploader | undefined;
  // A second stop request ends every wait for Hue at once: uploads in flight are closed and the
  // queue is left unsent.
  const forcedStop = new Promise<void>((done) =>
    forced.signal.addEventListener(
      "abort",
      () => {
        uploader?.close();
        done();
      },
      { once: true },
    ),
  );
  try {
    const api = new LangfuseApi({
      baseUrl: langfuseHost,
      publicKey,
      secretKey,
      ...(io.fetch ? { fetch: io.fetch } : {}),
      sleep,
      signal: stopping.signal,
      onWait: (seconds, reason) => warn(`${reason}; waiting ${seconds} s.`),
    });
    let projectName = "";
    if (!dryRun) {
      hue = createHue({
        apiKey,
        serviceName,
        baseUrl: origin,
        captureContent: !values["no-content"],
        liveSpans: false,
        maxQueueBytes: QUEUE_BYTES,
      });
      try {
        projectName = (await hue.checkConnection()).name;
      } catch (error) {
        const status = error instanceof HueConnectionError ? error.status : undefined;
        warn(
          status === 401 || status === 403
            ? `Hue refused HUE_API_KEY (HTTP ${status}).`
            : `${error instanceof Error ? error.message : "Hue could not be reached"}${status ? ` (HTTP ${status})` : ""}.`,
        );
        return 1;
      }
    }
    let version: LangfuseApiVersion;
    try {
      version = await api.version();
    } catch (error) {
      if (error instanceof ImportStopped) return 130;
      if (!(error instanceof LangfuseError)) throw error;
      warn(`${error.message}.`);
      return 1;
    }
    if (!dryRun && !values.yes) {
      const confirmed = await confirm(
        stdin,
        stdout,
        clean(
          `Import traces from ${langfuseHost} into the Hue project "${projectName}" at ${origin}? [y/N] `,
        ),
      );
      if (!confirmed) {
        warn("Nothing was imported.");
        return 1;
      }
    }
    const scope = traceIds.length
      ? plural(traceIds.length, "trace")
      : `traces that started ${window.from ? `from ${window.from} ` : ""}before ${window.to}${limit ? `, at most ${limit}` : ""}`;
    out(`Reading ${scope} from ${langfuseHost} (Langfuse API ${version}).`);

    const transport = hue?.transport;
    // A replay sends the same spans on every run: no trace's root records this run's losses.
    transport?.omitDroppedRecords();
    const resource = resourceFromAttributes({ "service.name": serviceName });
    // Media and values over Hue's inline limit are stored before export, so a span is sent only
    // once its files are; with --no-content the transport sends metadata only and stores nothing.
    if (hue && !values["no-content"])
      uploader = new BlobUploader({
        baseUrl: origin,
        apiKey,
        timeoutMillis: hue.transport.options.timeoutMillis,
        allowInsecureHttp: false,
        userAgent: `hue-sdk-typescript/${sdkVersion} hue-import`,
      });
    const uploadContext = (): UploadContext => ({
      deadline:
        Date.now() +
        Math.max(UPLOAD_DEADLINE_MS, uploadBudgetMillis(hue!.transport.options.timeoutMillis)),
      wait: async (ms) => {
        await sleep(ms);
        return !stopping.signal.aborted;
      },
    });
    const stats = {
      traces: 0,
      spans: 0,
      references: 0,
      uploaded: 0,
      kept: 0,
      fileFailures: 0,
      stored: 0,
      overLimits: 0,
    };
    // Traces not fully imported: counted, the first few kept to list, the newest remembered so
    // Hue's export issues do not name one twice.
    const failed = {
      count: 0,
      listed: [] as { id: string; reason: string }[],
      ids: new Set<string>(),
    };
    /** Records a trace not fully imported; false when it already was. */
    const fail = (id: string, reason: string) => {
      if (failed.ids.has(id)) return false;
      failed.count++;
      if (failed.listed.length < LISTED_FAILURES) failed.listed.push({ id, reason });
      failed.ids.add(id);
      if (failed.ids.size > REMEMBERED_TRACES) failed.ids.delete(failed.ids.values().next().value!);
      return true;
    };
    // Hue's export issues name traces by their OpenTelemetry id; the newest are remembered.
    const langfuseIds = new Map<string, string>();
    let ending: Ending | undefined;
    let lastProgress = Date.now();
    let progressAt = 0;

    // Hue's refusals, read from the transport's issues after every drain: the traces they name
    // were not imported, and a refusal that names none (or rolled out of the history) is noted.
    let issueSequence = 0;
    let unnamedRefusals = false;
    const collectIssues = () => {
      if (!transport) return;
      const issues = transport.getIssues();
      if (issues.length && issues[0]!.sequence > issueSequence + 1) unnamedRefusals = true;
      for (const issue of issues) {
        if (issue.sequence <= issueSequence) continue;
        issueSequence = issue.sequence;
        if (issue.kind === "warning") continue;
        const ids = (issue.traceIds ?? []).flatMap((traceId) => langfuseIds.get(traceId) ?? []);
        if (!ids.length) unnamedRefusals = true;
        for (const id of ids) fail(id, "Hue did not accept all of its spans");
      }
    };
    const drain = async () => {
      if (!transport) return;
      const flushed = transport.flush().catch((error: unknown) => {
        // Counted in the transport's report and named in its issues; the import continues.
        if (!(error instanceof HueExportError)) throw error;
      });
      await Promise.race([flushed, forcedStop]);
      collectIssues();
    };
    const send = async (span: ImportSpan) => {
      stats.spans++;
      if (!transport) return;
      transport.spanProcessor.onEnd(readableSpan(span, resource, SCOPE));
      const report = transport.getReport();
      if (report.pendingSpans >= DRAIN_SPANS || report.pendingBytes >= DRAIN_BYTES) await drain();
      progress();
    };
    /** Places a span's Langfuse media files, then stores the rest of its content as the
     * exporter would; the reason when a file or value could not be read or stored now, so the
     * span is not sent. */
    const prepare = async (
      span: ImportSpan,
      files: TraceMedia | undefined,
    ): Promise<string | undefined> => {
      const found = spanMedia(span);
      const located = found.attributes.reduce((sum, item) => sum + item.uses.length, 0);
      stats.references += located + found.kept;
      if (files) {
        const { uses, kept } = uploadableUses(found);
        const placed = new Map<MediaUse, UploadedMedia>();
        let left = found.kept + kept;
        for (const use of uses) {
          const outcome = await files.file(use);
          if (outcome.kind === "uploaded") placed.set(use, outcome.file);
          else if (outcome.kind === "kept") left++;
          else {
            stats.fileFailures++;
            return `a media file could not be copied: ${outcome.reason}`;
          }
        }
        stats.uploaded += placeMedia(span, found, placed);
        stats.kept += left;
      } else stats.kept += located + found.kept;
      if (!uploader) return undefined;
      const content = await storeSpanContent(span, uploader, uploadContext());
      if (content.heldBack) return `a file or value could not be stored: ${content.heldBack}`;
      stats.stored += content.stored;
      stats.overLimits += content.overLimits;
      return undefined;
    };
    const importTrace = async (id: string, trace: LangfuseTrace | undefined) => {
      const context: TraceContext = trace ? traceContext(trace) : { langfuseTraceId: id };
      const traceId = hueTraceId(id);
      langfuseIds.set(traceId, id);
      if (langfuseIds.size > REMEMBERED_TRACES)
        langfuseIds.delete(langfuseIds.keys().next().value!);
      // Files are read and uploaded only with --media, and never in a dry run.
      const files =
        values.media && uploader
          ? new TraceMedia(api, uploader, traceId, uploadContext)
          : undefined;
      let reason: string | undefined;
      let observations = 0;
      let observed: TimeBounds | undefined;
      const pages: AsyncGenerator<LangfuseObservation[]> =
        version === "v2" ? api.v2Observations(id) : api.v1Observations(id);
      for await (const page of pages) {
        for (const observation of page) {
          observations++;
          let span: ImportSpan;
          try {
            span = observationSpan(observation, context);
          } catch (error) {
            reason ??= (error as Error).message;
            continue;
          }
          observed = widen(observed, span);
          const refused = await prepare(span, files);
          if (refused) {
            reason ??= refused;
            continue;
          }
          await send(span);
        }
      }
      if (trace) {
        const root = traceSpan(trace, observed);
        const refused = await prepare(root, files);
        if (refused) reason ??= refused;
        else await send(root);
      } else if (observations === 0) reason = "Langfuse holds no observations for it";
      return reason;
    };
    const progress = () => {
      if (
        stats.traces - progressAt >= PROGRESS_EVERY_TRACES ||
        Date.now() - lastProgress >= PROGRESS_EVERY_MS
      ) {
        progressAt = stats.traces;
        lastProgress = Date.now();
        out(`Read ${plural(stats.traces, "trace")} (${plural(stats.spans, "span")}).`);
      }
    };

    /** The selected traces: by id, or listed in the window. A v1 trace named by id is read
     * with its own trace. */
    async function* selected(): AsyncGenerator<{ id: string; trace?: LangfuseTrace }> {
      if (traceIds.length) for (const id of traceIds) yield { id };
      else if (version === "v2") for await (const id of api.rootTraceIds(window)) yield { id };
      else for await (const trace of api.v1Traces(window)) yield { id: trace.id, trace };
    }

    // The trace being read, when the import stops before it is read whole.
    let reading: string | undefined;
    try {
      for await (const { id, trace } of selected()) {
        stats.traces++;
        reading = id;
        let reason: string | undefined;
        try {
          const read = trace ?? (version === "v1" ? await api.v1Trace(id) : undefined);
          reason =
            version === "v1" && !read
              ? "Langfuse holds no trace with this id"
              : await importTrace(id, read);
        } catch (error) {
          if (!(error instanceof LangfuseError) || error.fatal) throw error;
          reason = error.message;
        }
        reading = undefined;
        if (reason) {
          fail(id, reason);
          warn(`Trace ${id} was not fully imported: ${reason}.`);
        }
        progress();
        if (stopping.signal.aborted) throw new ImportStopped();
        if (limit !== undefined && stats.traces >= limit) break;
      }
    } catch (error) {
      if (error instanceof ImportStopped) ending = { kind: "stopped" };
      else if (error instanceof LangfuseError) ending = { kind: "failed", message: error.message };
      else throw error;
      if (reading) fail(reading, "the import ended before it was read whole");
    }

    if (dryRun) {
      const line = `Dry run: ${plural(stats.traces, "trace")}, ${plural(stats.spans, "span")} and ${plural(stats.references, "media reference")} would be imported; nothing was sent to Hue.`;
      out(line);
      if (failed.count) warn(`${plural(failed.count, "trace")} could not be read.`);
      if (ending?.kind === "failed") warn(`${ending.message}.`);
      return ending?.kind === "stopped" ? 130 : ending || failed.count ? 1 : 0;
    }

    // Everything read is sent before the summary, unless a second stop request ends the wait.
    await drain();
    const report = transport!.getReport();
    const lost = report.rejectedSpans + report.failedSpans + report.droppedSpans;
    // Every trace read is imported unless it was recorded as not fully imported.
    const imported = Math.max(0, stats.traces - failed.count);
    out(
      `Imported ${plural(imported, "trace")} of ${stats.traces} (${plural(stats.spans, "span")} sent, ${report.acceptedSpans} accepted) into the Hue project "${projectName}".`,
    );
    if (stats.references)
      out(
        `Media: ${plural(stats.uploaded, "file")} uploaded, ${stats.kept} left in Langfuse${stats.fileFailures ? `, ${stats.fileFailures} not copied` : ""}.`,
      );
    if (lost)
      warn(
        `Hue did not accept ${plural(lost, "span")} (${report.rejectedSpans} rejected, ${report.failedSpans} not delivered, ${report.droppedSpans} dropped).`,
      );
    if (stats.stored || stats.overLimits)
      out(
        `Stored apart from their spans: ${plural(stats.stored, "inline file or large value", "inline files and large values")}${stats.overLimits ? `; ${stats.overLimits} over Hue's limits kept inline or cut` : ""}.`,
      );
    if (lost && unnamedRefusals)
      warn("Some spans Hue did not accept could not be tied to a trace.");
    if (report.uploadFallbacks)
      warn(
        `${plural(report.uploadFallbacks, "inline file or value", "inline files or values")} could not be uploaded and kept the SDK's inline fallback; Hue keeps the first copy of a span, so a later run does not change ${report.uploadFallbacks === 1 ? "it" : "them"}.`,
      );
    if (failed.count) {
      warn(`${plural(failed.count, "trace was", "traces were")} not fully imported:`);
      for (const item of failed.listed) warn(`  ${item.id}: ${item.reason}`);
      if (failed.count > failed.listed.length)
        warn(`  … and ${failed.count - failed.listed.length} more`);
    }
    if (ending?.kind === "failed") warn(`The import stopped: ${ending.message}.`);
    if (ending || failed.count || lost || stopping.signal.aborted)
      warn("Run the same command again to resume; spans Hue already holds are not duplicated.");
    if (ending?.kind === "stopped" || stopping.signal.aborted) return 130;
    return ending || failed.count || lost || report.uploadFallbacks ? 1 : 0;
  } catch (error) {
    warn(`The import failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    removeInterrupt();
    uploader?.close();
    if (hue) await hue.shutdownSafe({ timeoutMillis: forced.signal.aborted ? 100 : 5_000 });
    // Exports still in flight are abandoned: a later run sends them again.
    if (forced.signal.aborted) (io.exit ?? process.exit)(130);
  }
}

/** Asks for a yes on the terminal. */
async function confirm(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  question: string,
): Promise<boolean> {
  const prompt = createInterface({ input: stdin, output: stdout, terminal: true, historySize: 0 });
  try {
    const answer = await new Promise<string>((done) => {
      prompt.question(question, done);
      prompt.once("close", () => done(""));
    });
    return /^y(?:es)?$/iu.test(answer.trim());
  } finally {
    prompt.close();
  }
}
