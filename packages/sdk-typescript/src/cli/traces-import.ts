import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseKeyPath, type IdentityKeys } from "./import-formats/identity.js";
import { importAdapters } from "./import-formats/registry.js";
import { parseHueOrigin } from "./login.js";
import { PrepareError, prepareTraceBundle, type PrepareReport } from "./traces-import-prepare.js";
import {
  parseAuthorizationFile,
  parseImportUrl,
  UploadStop,
  uploadTraceBundle,
  type UploadIo,
  type UploadReport,
} from "./traces-import-upload.js";

/**
 * `hue traces import`: imports a bundle of existing traces into Hue in two steps that keep the
 * payloads on this machine until the agent has authorized their delivery. `prepare` converts a
 * file, directory or ZIP archive of trace exports (`import-formats/registry.ts`) into a bundle
 * and prints its manifest digest and totals; `prepare_trace_import` (Hue MCP) takes those and
 * answers an import authorization; `upload` delivers the bundle with it.
 */

/** Streams and seams for {@link runTracesCommand}; tests inject these. */
export interface TracesCommandIo extends UploadIo {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** The format ids, wrapped to the usage text's width under its indent. */
function formatList(indent: string, width = 98): string {
  const lines: string[] = [];
  let line = "";
  for (const id of importAdapters.map((adapter) => adapter.id)) {
    const next = line ? `${line}, ${id}` : id;
    if (line && indent.length + next.length + 1 > width) {
      lines.push(`${line},`);
      line = id;
    } else line = next;
  }
  lines.push(line);
  return lines.map((text) => indent + text).join("\n");
}

export const TRACES_USAGE = `Usage: hue traces import prepare <path> [--out <directory>] [--user-key <key>] [--session-key <key>] [--json]
       hue traces import upload <directory> --authorization-file <file> [--import-url <url>] [--json]

Import a bundle of existing traces into Hue. Nothing leaves this machine until the upload step,
and no project key is involved: a Hue MCP connection authorizes the delivery.

prepare  Reads a file, a directory or a ZIP archive and recognizes each file by its content,
         never its name: one JSON document, a JSON array of records, JSON Lines or binary OTLP,
         gzip or zstd compressed or not, in these formats:
${formatList("           ")}
         Every trace becomes gzip OTLP/JSON batches written to --out (default <path>.hue-import)
         with manifest.json. The report names the manifest_digest and totals that
         prepare_trace_import takes, the files, lines and records it could not read, invalid
         vendor ids it mapped to OpenTelemetry ids, traces without a declared history owner and
         the origin each source recorded.
  --out <directory>    Where the bundle is written (created with mode 0700)
  --user-key <key>     Where the export records each trace's end user under a key of its own: an
                       attribute or metadata key (app.customer_id), or a JSON path into each
                       source record ($.metadata.customer.id or /metadata/customer/id)
  --session-key <key>  Where the export records each trace's conversation, the same way
  --json               Print the report as one JSON object

upload   Registers the manifest, then sends each trace's values and batches in order, two
         requests at a time, checks every span's receipt, reconciles and completes. Progress is
         kept in <directory>/progress.json, so running the same command again resumes.
  --authorization-file <file>  A private file holding what prepare_trace_import answered: its
                               JSON (authorization and upload_url), or the authorization
                               (hue_it_…) alone on the first line, the upload_url on the second.
                               The authorization is never taken from the command line or the
                               environment, and never printed.
  --import-url <url>  The upload_url prepare_trace_import returned (https://…/api/v1/trace-imports/<id>),
                      when the authorization file does not hold it
  --origin <url>      Accept only an import URL on this Hue origin
  --json              Print one JSON progress object per line on stderr and the report on stdout

Exit codes: 0 prepared or completed, 1 not completed (the report says what to do next),
2 usage error, 130 stopped (run the same command again to resume).`;

class UsageError extends Error {}

const IMPORT_TOKEN = /hue_it_[A-Za-z0-9_-]{43}/g;

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Runs `hue traces import …`; resolves to the exit code. */
export async function runTracesCommand(argv: string[], io: TracesCommandIo = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();
  // Every line loses import authorizations and control characters.
  const clean = (line: string) =>
    line.replace(IMPORT_TOKEN, "[redacted]").replace(/[^\P{Cc}\n\t]|\p{Cf}/gu, " ");
  const out = (line: string) => void stdout.write(`${clean(line)}\n`);
  const warn = (line: string) => void stderr.write(`${clean(line)}\n`);
  try {
    if (argv.includes("--help") || argv.includes("-h")) {
      stdout.write(`${TRACES_USAGE}\n`);
      return 0;
    }
    const [group, action, ...rest] = argv;
    if (group !== "import")
      throw new UsageError(`Unknown command: hue traces ${group ?? ""}`.trim());
    if (action === "prepare") return await prepare(rest, cwd, out, warn);
    if (action === "upload") return await upload(rest, cwd, io, out, warn);
    throw new UsageError(
      action ? `Unknown command: hue traces import ${action}` : "Name the step: prepare or upload",
    );
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    warn(error.message);
    stderr.write(`\n${TRACES_USAGE}\n`);
    return 2;
  }
}

function parsePrepareArguments(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        out: { type: "string" },
        "user-key": { type: "string" },
        "session-key": { type: "string" },
        json: { type: "boolean", default: false },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

async function prepare(
  argv: string[],
  cwd: string,
  out: (line: string) => void,
  warn: (line: string) => void,
): Promise<number> {
  const { values, positionals } = parsePrepareArguments(argv);
  if (positionals.length !== 1)
    throw new UsageError(
      positionals.length
        ? `Unexpected argument: ${positionals[1]}`
        : "Name the file, directory or archive to prepare",
    );
  const input = resolve(cwd, positionals[0]!);
  const keys: IdentityKeys = {};
  for (const [flag, kind] of [
    ["user-key", "user"],
    ["session-key", "session"],
  ] as const) {
    const text = values[flag];
    if (text === undefined) continue;
    const path = parseKeyPath(text);
    if (!path)
      throw new UsageError(
        `--${flag} must be an attribute or metadata key, or a JSON path such as $.metadata.user_id or /metadata/user_id`,
      );
    keys[kind] = path;
  }
  let report: PrepareReport;
  try {
    report = await prepareTraceBundle(input, {
      ...(values.out !== undefined ? { out: resolve(cwd, values.out) } : {}),
      ...(keys.user || keys.session ? { keys } : {}),
    });
  } catch (error) {
    if (error instanceof PrepareError) {
      warn(error.message);
      return 1;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      warn(`${input} does not exist`);
      return 1;
    }
    throw error;
  }
  if (values.json) {
    out(JSON.stringify(report));
    return 0;
  }
  out(
    `Prepared ${plural(report.totals.traces, "trace")} (${plural(report.totals.spans, "span")}, ${plural(report.totals.batches, "batch", "batches")}, ${plural(report.totals.blobs, "large value")}) in ${report.output_directory}.`,
  );
  out(
    `Formats: ${Object.entries(report.formats)
      .filter(([, count]) => count)
      .map(([format, count]) => `${format} ${count}`)
      .join(", ")}.`,
  );
  out(`Manifest digest: ${report.manifest_digest}`);
  out(`Totals: ${JSON.stringify(report.totals)}`);
  out(`Source: ${JSON.stringify(report.source)}`);
  if (report.traces.without_identity)
    out(
      `${plural(report.traces.without_identity, "trace declares", "traces declare")} no history owner.`,
    );
  const origins = Object.entries(report.traces.by_origin).filter(([, count]) => count);
  out(`Origin: ${origins.map(([origin, count]) => `${origin} ${count}`).join(", ")}.`);
  if (report.traces.remapped.traces)
    out(
      `Mapped invalid vendor ids to OpenTelemetry ids in ${plural(report.traces.remapped.traces, "trace")} (${plural(report.traces.remapped.spans, "span")}).`,
    );
  for (const [rule, count] of Object.entries(report.traces.timing))
    out(`Instants the source did not record (${rule}): ${plural(count, "trace")}.`);
  const where = (item: { file?: string; line?: number; record?: number }) =>
    [
      item.file,
      item.line !== undefined ? `line ${item.line}` : undefined,
      item.record !== undefined ? `record ${item.record}` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
  for (const file of report.files.unsupported) warn(`Not read: ${file.file}: ${file.reason}.`);
  for (const record of report.files.skipped) warn(`Not read: ${where(record)}: ${record.reason}.`);
  for (const note of report.files.notes) warn(`Note: ${where(note)}: ${note.reason}.`);
  for (const refusal of report.traces.refused)
    warn(
      `Not converted: ${[where(refusal), refusal.trace_id ? `trace ${refusal.trace_id}` : undefined].filter(Boolean).join(" ")}: ${refusal.reason}.`,
    );
  out(
    "Next: call prepare_trace_import with manifest_digest, totals and source, write the authorization to a private file and run hue traces import upload.",
  );
  return 0;
}

function parseUploadArguments(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        "authorization-file": { type: "string" },
        "import-url": { type: "string" },
        origin: { type: "string" },
        json: { type: "boolean", default: false },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

async function upload(
  argv: string[],
  cwd: string,
  io: TracesCommandIo,
  out: (line: string) => void,
  warn: (line: string) => void,
): Promise<number> {
  const { values, positionals } = parseUploadArguments(argv);
  if (positionals.length !== 1)
    throw new UsageError(
      positionals.length
        ? `Unexpected argument: ${positionals[1]}`
        : "Name the prepared directory to upload",
    );
  if (!values["authorization-file"])
    throw new UsageError(
      "--authorization-file is required: the file holding the import authorization",
    );
  let origin: string | undefined;
  if (values.origin !== undefined) {
    const parsed = parseHueOrigin(values.origin);
    if (!parsed)
      throw new UsageError(
        "--origin must be an HTTPS origin such as https://app.hue.run (plain HTTP is accepted for loopback test servers only)",
      );
    origin = parsed;
  }
  const directory = resolve(cwd, positionals[0]!);
  let token: string;
  let importUrl: string | undefined = values["import-url"];
  try {
    const content = await readFile(resolve(cwd, values["authorization-file"]), "utf8").catch(() => {
      throw new UploadStop(
        `${values["authorization-file"]} could not be read`,
        "authorization_invalid",
      );
    });
    const parsed = parseAuthorizationFile(content);
    token = parsed.token;
    importUrl ??= parsed.importUrl;
    if (!importUrl)
      throw new UploadStop(
        "Pass --import-url, or put the upload_url prepare_trace_import returned on the authorization file's second line",
        "url_invalid",
      );
    importUrl = parseImportUrl(importUrl, origin).href;
  } catch (error) {
    if (!(error instanceof UploadStop)) throw error;
    throw new UsageError(error.message);
  }
  const json = values.json;
  const progress = (event: Record<string, unknown>) => {
    if (json) warn(JSON.stringify(event));
    else if (event.event === "manifest.registered")
      out(`Registered the manifest with import ${String(event.import_id)}.`);
    else if (event.event === "trace.conflicted")
      warn(`Trace ${String(event.trace_id)} conflicts with evidence Hue already holds.`);
    else if (event.event === "trace.unverified")
      warn(
        `Trace ${String(event.trace_id)}: ${String(event.missing_spans)} span(s) not yet confirmed.`,
      );
    else if (event.event === "trace.verified" && Number(event.index) % 100 === 0)
      out(`Verified ${String(event.index)} of ${String(event.of)} traces.`);
  };
  let report: UploadReport;
  try {
    report = await uploadTraceBundle({ directory, token, importUrl }, { ...io, progress });
  } catch (error) {
    if (!(error instanceof UploadStop)) throw error;
    warn(error.message);
    return 1;
  }
  if (json) out(JSON.stringify(report));
  else {
    out(
      `${report.state === "completed" ? "Completed" : report.state === "stopped" ? "Stopped" : report.state === "failed" ? "Failed" : "Not completed"}: ${report.traces.verified} of ${plural(report.traces.declared, "trace")} verified, ${report.traces.conflicted} conflicted, ${report.batches.landed} of ${plural(report.batches.declared, "batch", "batches")} landed, ${report.blobs.stored} of ${plural(report.blobs.declared, "large value")} stored.`,
    );
    for (const conflict of report.conflicts.slice(0, 20))
      warn(`  ${conflict.trace_id} ${conflict.sha256}: ${conflict.message}`);
    if (report.conflicts.length > 20) warn(`  … and ${report.conflicts.length - 20} more`);
    if (report.error) warn(`${report.error.message}`);
    if (report.note) out(report.note);
    out(report.next_action);
  }
  return report.state === "completed" ? 0 : report.state === "stopped" ? 130 : 1;
}
