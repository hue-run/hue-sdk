import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { readFile } from "node:fs/promises";
import { request as httpRequest, type ClientRequest, type OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { scrubCredentialText } from "../tool-definitions.js";
import { sdkVersion } from "../version.js";
import { envFileArgument, envFileOptions } from "./env-file.js";
import { parseHueOrigin } from "./login.js";

/**
 * `hue listen`: delivers a simulated world's events to a receiver on this machine, the way a
 * provider would post them to a public request URL. The client pulls leased deliveries from Hue
 * with the subscription's own credential (a world token or a connection key, never a project
 * key), forwards each stored request unchanged to the local URL, and acknowledges it with the
 * local answer. Every pull is one bounded request; nothing holds a connection open. A delivery is
 * acknowledged only after the receiver answered or its window closed, so stopping never marks an
 * event delivered that was not: an unacknowledged lease lapses and Hue retries it on the
 * provider's schedule.
 */

/** Streams, environment, network and signal seams for {@link runListenCommand}; tests inject these. */
export interface ListenCommandIo {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fetch?: typeof fetch;
  /** Registers the stop request (SIGINT and SIGTERM by default) and returns its removal. */
  onInterrupt?: (listener: () => void) => () => void;
  /** The acknowledgement window a forward waits for; the provider's three seconds by default. */
  forwardTimeoutMs?: number;
  /** Delays between retries of a failed pull. */
  retryDelaysMs?: readonly number[];
}

const DEFAULT_ORIGIN = "https://app.hue.run";
/** The longest a pull waits for a due delivery; the server answers empty at this bound. */
const PULL_WAIT_MS = 20_000;
/** Time allowed beyond the wait for Hue to answer a pull. */
const PULL_GRACE_MS = 15_000;
/** The most deliveries one pull leases; they are forwarded concurrently. */
const MAX_BATCH = 10;
/** How long a pulled delivery stays leased; after it Hue records a timeout. */
const LEASE_MS = 30_000;
/** Slack's acknowledgement window: a receiver that has not answered by then timed out. */
const FORWARD_TIMEOUT_MS = 3_000;
/** The most answer body an acknowledgement carries; only the URL verification reads it. */
const MAX_ACK_BODY_BYTES = 4_096;
const MAX_PULL_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ACK_RESPONSE_BYTES = 64 * 1024;
const MAX_DELIVERY_BODY_BYTES = 1024 * 1024;
const MAX_DELIVERY_HEADERS = 64;
const ACK_REQUEST_TIMEOUT_MS = 10_000;
const PULL_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const ACK_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000];
const MAX_RETRY_AFTER_MS = 60_000;
/** Deliveries whose answer is remembered, so a delivery Hue hands out again is not re-sent. */
const REMEMBERED_DELIVERIES = 1_024;

/** Connection-level headers the local request sets for itself. */
const HOP_BY_HOP = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u;
const HEADER_VALUE = /^[\t\x20-\x7e]{0,8192}$/u;
const WORLD_TOKEN = /^hue_world_[A-Za-z0-9_-]{1,1024}\.[A-Za-z0-9_-]{43}$/u;
const CONNECTION_KEY = /^hue_sk_[A-Za-z0-9_-]{1,512}$/u;
const EVENT_STATES = new Set(["pending", "acknowledged", "failed", "dropped"]);

export const LISTEN_USAGE = `Usage: hue listen --subscription ID --forward-to URL [--origin URL] [--env-path PATH]
                  [--credential world-token|connection-key] [--max N] [--allow-remote-forward]

Deliver a simulated world's events to a receiver on this machine. Hue's signed requests (Slack
Events API requests today) are pulled with the subscription's own credential, forwarded unchanged
to --forward-to, and acknowledged with the receiver's answer. Press Ctrl+C to stop: pulls stop,
deliveries in flight are finished and acknowledged, and nothing unanswered is acknowledged.

The credential is read from the environment, never from the command line:
  HUE_WORLD_TOKEN     the world token, for a subscription on one world
  HUE_CONNECTION_KEY  the connection key, for a subscription on a connection key
A project key (HUE_API_KEY, HUE_MCP_KEY) is refused.

Options:
  --subscription ID       The listen subscription to deliver (its id from Hue)
  --forward-to URL        The local receiver, for example http://localhost:3000/slack/events
  --origin URL            Hue origin (default HUE_BASE_URL, then ${DEFAULT_ORIGIN})
  --env-path PATH         Load a dotenv file first (--env-file also works when it exists)
  --credential KIND       world-token or connection-key, when both variables are set
  --max N                 Deliveries leased per pull and forwarded at once, 1 to ${MAX_BATCH} (default ${MAX_BATCH})
  --allow-remote-forward  Allow a --forward-to host other than this machine
  -h, --help              Show this help`;

class UsageError extends Error {}

/** A leased delivery: the exact request the provider would send. */
interface Delivery {
  deliveryId: string;
  eventId: string | null;
  kind: "url_verification" | "event_callback";
  retryNum: number;
  /** The lease's end as the server stated it, or null when absent. */
  leaseExpiresAt: number | null;
  request: { headers: Record<string, string>; body: string };
}

/** The local answer, in the acknowledgement's own shape. */
interface LocalAnswer {
  outcome: "response" | "timeout" | "connection_failed" | "tls_error";
  status?: number;
  durationMs: number;
  noRetry?: boolean;
  body?: string;
}

type AckResult =
  | { kind: "recorded"; state: string | null }
  | { kind: "lease_expired" }
  | { kind: "revoked" }
  | { kind: "refused"; status: number; code: string | null }
  | { kind: "unanswered" };

type PullResult =
  | {
      kind: "deliveries";
      deliveries: Delivery[];
      skipped: number;
      excess: number;
      /** When the answer arrived, and how long its leases have left by the server's clock. */
      receivedAt: number;
      leaseLeftMs: (delivery: Delivery) => number;
    }
  | { kind: "retry"; reason: string; retryAfterMs: number | null }
  | { kind: "fatal"; message: string }
  | { kind: "stopped" };

/** A loopback address: 127.0.0.0/8, ::1, or 127.0.0.0/8 carried in IPv4-mapped IPv6. */
export function isLoopbackAddress(address: string): boolean {
  const unbracketed = address.replace(/^\[|\]$/gu, "").toLowerCase();
  const version = isIP(unbracketed);
  if (version === 4) return unbracketed.startsWith("127.");
  if (version !== 6) return false;
  if (unbracketed === "::1" || unbracketed === "0:0:0:0:0:0:0:1") return true;
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(unbracketed);
  if (mapped) return mapped[1]!.startsWith("127.");
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/u.exec(unbracketed);
  return hex !== null && Number.parseInt(hex[1]!, 16) >> 8 === 127;
}

/**
 * The receiver URL, or why it is refused: HTTP or HTTPS without credentials or fragment, on this
 * machine (`localhost`, a `.localhost` name or a loopback address) unless `allowRemote`.
 */
export function parseForwardTarget(value: string, allowRemote: boolean): URL | string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "--forward-to must be an absolute URL such as http://localhost:3000/slack/events";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return "--forward-to must be an http or https URL";
  if (url.username || url.password) return "--forward-to must not carry credentials";
  if (url.hash) return "--forward-to must not carry a fragment";
  if (!allowRemote && !isLocalHostname(url.hostname))
    return `--forward-to must name this machine (localhost or a loopback address); pass --allow-remote-forward to deliver to ${scrubCredentialText(url.hostname)}`;
  return url;
}

function isLocalHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/u, "");
  return name === "localhost" || name.endsWith(".localhost") || isLoopbackAddress(name);
}

/**
 * A resolver that admits a name only when every address it resolves to is a loopback address, so
 * a `localhost` name that resolves elsewhere reaches nothing. Address literals do not resolve;
 * `parseForwardTarget` checked them.
 */
function loopbackLookup(resolver: typeof dnsLookup = dnsLookup): LookupFunction {
  return ((
    hostname: string,
    options: { all?: boolean; family?: number },
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    resolver(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, options.all ? [] : "", 0);
      if (addresses.length === 0 || !addresses.every((entry) => isLoopbackAddress(entry.address))) {
        const refused: NodeJS.ErrnoException = new Error(`${hostname} is not a loopback address`);
        refused.code = "ENOTLOOPBACK";
        return callback(refused, options.all ? [] : "", 0);
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  }) as unknown as LookupFunction;
}

function isTlsError(error: NodeJS.ErrnoException): boolean {
  const code = error.code ?? "";
  return (
    code.startsWith("ERR_TLS_") ||
    code.startsWith("ERR_SSL_") ||
    code.includes("CERT") ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "EPROTO"
  );
}

/** Cuts text to at most `limit` UTF-8 bytes without splitting a character. */
function clampUtf8(text: string, limit: number): string {
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  let out = text.slice(0, limit);
  while (Buffer.byteLength(out, "utf8") > limit) out = out.slice(0, -1);
  return out;
}

/**
 * Sends one delivery to the receiver and reports its answer, or null when `signal` abandoned it.
 * The body bytes and every header go out unchanged (the provider's signature covers them), no
 * redirect is followed, and the answer counts only inside `timeoutMs`. Only a URL verification's
 * successful answer body is read.
 */
export function forwardDelivery(
  target: URL,
  delivery: Delivery,
  options: {
    timeoutMs?: number;
    allowRemote?: boolean;
    signal?: AbortSignal;
    /** Resolves `--forward-to` names; tests stand in for DNS. */
    resolver?: typeof dnsLookup;
  } = {},
): Promise<LocalAnswer | null> {
  const timeoutMs = options.timeoutMs ?? FORWARD_TIMEOUT_MS;
  const body = Buffer.from(delivery.request.body, "utf8");
  const headers: OutgoingHttpHeaders = Object.create(null) as OutgoingHttpHeaders;
  for (const [name, value] of Object.entries(delivery.request.headers))
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
  headers["content-length"] = String(body.byteLength);
  const started = performance.now();
  const elapsed = () => Math.min(LEASE_MS, Math.max(0, Math.round(performance.now() - started)));
  return new Promise((settle) => {
    let request: ClientRequest | undefined;
    let settled = false;
    const timer = setTimeout(
      () => finish({ outcome: "timeout", durationMs: elapsed() }),
      timeoutMs,
    );
    const abandon = () => finish(null);
    const finish = (answer: LocalAnswer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abandon);
      request?.destroy();
      settle(answer);
    };
    if (options.signal?.aborted) return abandon();
    options.signal?.addEventListener("abort", abandon, { once: true });
    try {
      request = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
        method: "POST",
        headers,
        agent: false,
        ...(options.allowRemote ? {} : { lookup: loopbackLookup(options.resolver) }),
      });
    } catch {
      // A header Node refuses to send: nothing left this machine.
      finish({ outcome: "connection_failed", durationMs: elapsed() });
      return;
    }
    request.on("error", (error: NodeJS.ErrnoException) =>
      finish({
        outcome: isTlsError(error) ? "tls_error" : "connection_failed",
        durationMs: elapsed(),
      }),
    );
    request.on("response", (response) => {
      const status = response.statusCode ?? 0;
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        finish({ outcome: "connection_failed", durationMs: elapsed() });
        return;
      }
      const noRetry = String(response.headers["x-slack-no-retry"] ?? "").trim() === "1";
      const answered = (text?: string) =>
        finish({
          outcome: "response",
          status,
          durationMs: elapsed(),
          ...(noRetry ? { noRetry } : {}),
          ...(text !== undefined ? { body: text } : {}),
        });
      // Only a successful handshake answer can verify, so only its body is read; a failing
      // answer's page stays on this machine.
      if (delivery.kind !== "url_verification" || status < 200 || status > 299) {
        response.on("error", () => undefined);
        answered();
        return;
      }
      // The handshake's answer carries the challenge; read at most what an acknowledgement holds.
      const chunks: Buffer[] = [];
      let size = 0;
      const done = () =>
        answered(clampUtf8(Buffer.concat(chunks).toString("utf8"), MAX_ACK_BODY_BYTES));
      response.on("data", (chunk: Buffer) => {
        if (size >= MAX_ACK_BODY_BYTES) return;
        chunks.push(chunk.subarray(0, MAX_ACK_BODY_BYTES - size));
        size += Math.min(chunk.byteLength, MAX_ACK_BODY_BYTES - size);
        if (size >= MAX_ACK_BODY_BYTES) done();
      });
      response.on("end", done);
      response.on("error", done);
    });
    request.end(body);
  });
}

/** One delivery from a pull answer, or null when it is not one this client can forward safely. */
export function parseDelivery(value: unknown, subscriptionId: string): Delivery | null {
  if (!isObject(value)) return null;
  const {
    deliveryId,
    subscriptionId: owner,
    eventId,
    kind,
    retryNum,
    leaseExpiresAt,
    request,
  } = value;
  if (typeof deliveryId !== "string" || !UUID.test(deliveryId)) return null;
  if (typeof owner !== "string" || owner.toLowerCase() !== subscriptionId.toLowerCase())
    return null;
  if (kind !== "url_verification" && kind !== "event_callback") return null;
  if (eventId !== null && (typeof eventId !== "string" || !EVENT_ID.test(eventId))) return null;
  if (!Number.isInteger(retryNum) || (retryNum as number) < 0 || (retryNum as number) > 100)
    return null;
  if (!isObject(request) || request.method !== "POST") return null;
  const { headers, body } = request;
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > MAX_DELIVERY_BODY_BYTES)
    return null;
  if (!isObject(headers)) return null;
  const entries = Object.entries(headers);
  if (entries.length > MAX_DELIVERY_HEADERS) return null;
  const copied = Object.create(null) as Record<string, string>;
  const names = new Set<string>();
  for (const [name, header] of entries) {
    if (!HEADER_NAME.test(name) || typeof header !== "string" || !HEADER_VALUE.test(header))
      return null;
    // Two spellings of one header would leave the receiver to guess which is meant.
    if (names.has(name.toLowerCase())) return null;
    names.add(name.toLowerCase());
    copied[name] = header;
  }
  const leaseEnd = typeof leaseExpiresAt === "string" ? Date.parse(leaseExpiresAt) : Number.NaN;
  return {
    deliveryId: deliveryId.toLowerCase(),
    eventId: eventId as string | null,
    kind,
    retryNum: retryNum as number,
    leaseExpiresAt: Number.isFinite(leaseEnd) ? leaseEnd : null,
    request: { headers: copied, body },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reads at most `limit` bytes of a response body; a larger one is cancelled and refused. */
async function readBounded(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Hue answered more than ${limit} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Hue's refusal code: the `x-hue-diagnostic` header, or the body's `diagnostic` or `code`. */
async function refusalCode(response: Response): Promise<string | null> {
  const header = response.headers.get("x-hue-diagnostic");
  if (header && /^[a-z][a-z0-9_]{0,63}$/u.test(header)) return header;
  try {
    const parsed: unknown = JSON.parse(await readBounded(response, MAX_ACK_RESPONSE_BYTES));
    if (!isObject(parsed)) return null;
    const nested = isObject(parsed.error) ? parsed.error.code : undefined;
    for (const candidate of [parsed.diagnostic, parsed.code, nested, parsed.error])
      if (typeof candidate === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(candidate))
        return candidate;
  } catch {
    // An unreadable refusal is named by its status alone.
  }
  return null;
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value || !/^\d{1,6}$/u.test(value.trim())) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Number(value.trim()) * 1000);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal?.aborted) return done();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      done();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function defaultOnInterrupt(listener: () => void): () => void {
  process.on("SIGINT", listener);
  process.on("SIGTERM", listener);
  return () => {
    process.removeListener("SIGINT", listener);
    process.removeListener("SIGTERM", listener);
  };
}

function parseListenArguments(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      subscription: { type: "string" },
      "forward-to": { type: "string" },
      origin: { type: "string" },
      ...envFileOptions,
      credential: { type: "string" },
      max: { type: "string" },
      "allow-remote-forward": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}

/**
 * The credential that pulls: the subscription's world token or connection key from the
 * environment. A project key is refused before any request; Hue refuses one too.
 */
function selectCredential(
  env: NodeJS.ProcessEnv,
  choice: string | undefined,
): { credential: string; label: "world token" | "connection key" } {
  const worldToken = env.HUE_WORLD_TOKEN?.trim() || undefined;
  const connectionKey = env.HUE_CONNECTION_KEY?.trim() || undefined;
  if (choice !== undefined && choice !== "world-token" && choice !== "connection-key")
    throw new UsageError("--credential must be world-token or connection-key");
  let kind: "world-token" | "connection-key";
  if (choice) kind = choice;
  else if (worldToken && connectionKey)
    throw new UsageError(
      "Both HUE_WORLD_TOKEN and HUE_CONNECTION_KEY are set; pass --credential world-token or --credential connection-key",
    );
  else if (worldToken) kind = "world-token";
  else if (connectionKey) kind = "connection-key";
  else
    throw new UsageError(
      "Set HUE_WORLD_TOKEN (a world's subscription) or HUE_CONNECTION_KEY (a connection key's subscription); hue listen never uses a project key",
    );
  const variable = kind === "world-token" ? "HUE_WORLD_TOKEN" : "HUE_CONNECTION_KEY";
  const credential = kind === "world-token" ? worldToken : connectionKey;
  if (!credential) throw new UsageError(`${variable} is not set`);
  for (const projectVariable of ["HUE_API_KEY", "HUE_MCP_KEY"])
    if (env[projectVariable]?.trim() === credential)
      throw new UsageError(
        `${variable} holds the project key in ${projectVariable}; hue listen pulls only with the subscription's world token or connection key`,
      );
  if (kind === "world-token" && !WORLD_TOKEN.test(credential))
    throw new UsageError(
      credential.startsWith("hue_sk_")
        ? "HUE_WORLD_TOKEN holds a key, not a world token; a connection key goes in HUE_CONNECTION_KEY"
        : "HUE_WORLD_TOKEN is not a world token (hue_world_...)",
    );
  if (kind === "connection-key" && !CONNECTION_KEY.test(credential))
    throw new UsageError(
      credential.startsWith("hue_world_")
        ? "HUE_CONNECTION_KEY holds a world token; a world token goes in HUE_WORLD_TOKEN"
        : "HUE_CONNECTION_KEY is not a connection key (hue_sk_...)",
    );
  return { credential, label: kind === "world-token" ? "world token" : "connection key" };
}

async function loadEnv(
  env: NodeJS.ProcessEnv,
  cwd: string,
  file: string | undefined,
): Promise<NodeJS.ProcessEnv> {
  if (!file) return env;
  let text: string;
  try {
    text = await readFile(resolve(cwd, file), "utf8");
  } catch (error) {
    throw new UsageError(
      `Unable to load ${scrubCredentialText(file)}: ${(error as NodeJS.ErrnoException).code ?? "unreadable"}`,
    );
  }
  // As Node's --env-file does, a variable already in the environment keeps its value.
  return { ...parseEnv(text), ...env };
}

function describeAnswer(answer: LocalAnswer): string {
  switch (answer.outcome) {
    case "response":
      return `${answer.status} in ${answer.durationMs} ms${answer.noRetry ? " (no retry)" : ""}`;
    case "timeout":
      return `no answer within ${answer.durationMs} ms`;
    case "tls_error":
      return "TLS error";
    default:
      return "connection failed";
  }
}

function describeAck(result: AckResult): string {
  switch (result.kind) {
    case "recorded":
      return result.state ? `Hue: ${result.state}` : "Hue: recorded";
    case "lease_expired":
      return "Hue: lease expired, recorded as a timeout";
    case "revoked":
      return "Hue: subscription revoked";
    case "refused":
      return `Hue refused the acknowledgement (HTTP ${result.status}${result.code ? ` ${result.code}` : ""})`;
    default:
      return "Hue did not answer the acknowledgement; unless it was recorded, the lease lapses into a timeout";
  }
}

/**
 * Runs `hue listen` and returns the process exit code: 0 stopped, 1 failed, 2 usage error, 130
 * interrupted twice (acknowledgements abandoned). `argv` may start with the `listen` command word.
 */
export async function runListenCommand(argv: string[], io: ListenCommandIo = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();
  const fetchImpl = io.fetch ?? globalThis.fetch;
  const forwardTimeoutMs = io.forwardTimeoutMs ?? FORWARD_TIMEOUT_MS;
  const pullRetryDelays = io.retryDelaysMs ?? PULL_RETRY_DELAYS_MS;
  const secrets: string[] = [];
  // Every line loses the credential and control characters; text from elsewhere (error messages,
  // the receiver URL) also loses anything shaped like a credential.
  const clean = (text: string) => {
    let out = text;
    for (const secret of secrets) out = out.replaceAll(secret, "[redacted]");
    return out.replace(/[^\P{Cc}\n\t]|\p{Cf}/gu, " ");
  };
  const foreign = (text: string) => scrubCredentialText(text);
  const out = (line: string) => void stdout.write(`${clean(line)}\n`);
  const warn = (line: string) => void stderr.write(`${clean(line)}\n`);

  let subscription: string;
  let target: URL;
  let origin: string;
  let credential: string;
  let label: string;
  let max: number;
  let allowRemote: boolean;
  try {
    let parsed: ReturnType<typeof parseListenArguments>;
    try {
      parsed = parseListenArguments(argv);
    } catch (error) {
      // Node's message repeats the option as typed, which may carry a pasted token.
      throw new UsageError(foreign((error as Error).message));
    }
    if (parsed.values.help) {
      stdout.write(`${LISTEN_USAGE}\n`);
      return 0;
    }
    const positionals =
      parsed.positionals[0] === "listen" ? parsed.positionals.slice(1) : parsed.positionals;
    if (positionals.length > 0)
      throw new UsageError(`Unexpected argument: ${foreign(positionals[0]!)}`);
    const values = parsed.values;
    const env = await loadEnv(io.env ?? process.env, cwd, envFileArgument(values, cwd));
    ({ credential, label } = selectCredential(env, values.credential));
    secrets.push(credential);
    if (!values.subscription || !UUID.test(values.subscription))
      throw new UsageError("--subscription must be the subscription's id (a UUID)");
    subscription = values.subscription.toLowerCase();
    if (!values["forward-to"]) throw new UsageError("--forward-to is required");
    allowRemote = values["allow-remote-forward"];
    const forward = parseForwardTarget(values["forward-to"], allowRemote);
    if (typeof forward === "string") throw new UsageError(forward);
    target = forward;
    const parsedOrigin = parseHueOrigin(
      values.origin ?? (env.HUE_BASE_URL?.trim() || DEFAULT_ORIGIN),
    );
    if (!parsedOrigin)
      throw new UsageError(
        "--origin must be an HTTPS origin such as https://app.hue.run (plain HTTP is accepted for loopback test servers only)",
      );
    origin = parsedOrigin;
    max = Number(values.max ?? MAX_BATCH);
    if (!/^\d{1,2}$/u.test(values.max ?? String(MAX_BATCH)) || max < 1 || max > MAX_BATCH)
      throw new UsageError(`--max must be an integer from 1 to ${MAX_BATCH}`);
  } catch (error) {
    // The credential may not be known yet, so each value the user typed was scrubbed by its shape
    // where the message was built; the guidance around it is left as written.
    warn((error as Error).message);
    stderr.write(`\n${LISTEN_USAGE}\n`);
    return 2;
  }

  const base = `${origin}/api/v1/event-subscriptions/${subscription}/deliveries`;
  const headers = {
    authorization: `Bearer ${credential}`,
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": `hue-sdk-typescript/${sdkVersion} hue-listen`,
  };
  // The first stop request stops pulling and lets deliveries in flight finish; a second one
  // abandons their acknowledgements, whose leases then lapse into timeouts.
  const stopping = new AbortController();
  const forced = new AbortController();
  const removeInterrupt = (io.onInterrupt ?? defaultOnInterrupt)(() => {
    if (!stopping.signal.aborted) {
      stopping.abort();
      warn("Stopping: finishing deliveries in flight (press Ctrl+C again to abandon them).");
    } else forced.abort();
  });
  const remembered = new Map<string, LocalAnswer>();
  let fatal: string | null = null;

  const pull = async (waitMs: number): Promise<PullResult> => {
    const request = new AbortController();
    const abort = () => request.abort();
    stopping.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, waitMs + PULL_GRACE_MS);
    let response: Response;
    try {
      response = await fetchImpl(`${base}/pull`, {
        method: "POST",
        headers,
        body: JSON.stringify({ waitMs, max }),
        redirect: "manual",
        signal: request.signal,
      });
    } catch (error) {
      if (stopping.signal.aborted) return { kind: "stopped" };
      const cause = (error as { cause?: { code?: unknown } }).cause?.code;
      return {
        kind: "retry",
        reason: request.signal.aborted
          ? "no answer in time"
          : `${foreign((error as Error).message)}${typeof cause === "string" && /^[A-Z_]{1,32}$/u.test(cause) ? ` (${cause})` : ""}`,
        retryAfterMs: null,
      };
    } finally {
      clearTimeout(timer);
      // Once Hue answered, its deliveries are leased to this client: a stop request no longer
      // cancels reading them, so they are forwarded and acknowledged rather than left to lapse.
      stopping.signal.removeEventListener("abort", abort);
    }
    const receivedAt = performance.now();
    const bodyTimer = setTimeout(abort, PULL_GRACE_MS);
    try {
      return await readPull(response, receivedAt);
    } finally {
      clearTimeout(bodyTimer);
    }
  };

  const readPull = async (response: Response, receivedAt: number): Promise<PullResult> => {
    const status = response.status;
    if (status === 200) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBounded(response, MAX_PULL_RESPONSE_BYTES));
      } catch (error) {
        return { kind: "retry", reason: (error as Error).message, retryAfterMs: null };
      }
      const list = isObject(parsed) ? parsed.deliveries : undefined;
      if (!Array.isArray(list))
        return { kind: "fatal", message: "Hue answered a pull without deliveries" };
      const deliveries: Delivery[] = [];
      const seen = new Set<string>();
      let skipped = 0;
      let excess = 0;
      for (const item of list) {
        const delivery = parseDelivery(item, subscription);
        if (!delivery) skipped++;
        else if (seen.has(delivery.deliveryId)) continue;
        // Concurrency stays bounded by --max whatever the answer holds.
        else if (deliveries.length >= max) excess++;
        else {
          seen.add(delivery.deliveryId);
          deliveries.push(delivery);
        }
      }
      // A lease is measured on the server's clock: its stated end less the answer's `Date`, which
      // is truncated to the second and so may be up to a second early.
      const serverNow = Date.parse(response.headers.get("date") ?? "");
      const leaseLeftMs = (delivery: Delivery) =>
        delivery.leaseExpiresAt === null || !Number.isFinite(serverNow)
          ? LEASE_MS
          : Math.min(LEASE_MS, Math.max(0, delivery.leaseExpiresAt - serverNow - 1_000));
      return { kind: "deliveries", deliveries, skipped, excess, receivedAt, leaseLeftMs };
    }
    const code = await refusalCode(response);
    const named = `HTTP ${status}${code ? ` ${code}` : ""}`;
    if (status >= 300 && status <= 399)
      return {
        kind: "fatal",
        message: `Hue answered the pull with a redirect (${named}); hue listen follows none. Check --origin.`,
      };
    if (status === 401)
      return {
        kind: "fatal",
        message: `Hue refused the ${label} (${named}): it is not subscription ${subscription}'s credential, or it ended (a world token ends when its world seals). A project key never pulls.`,
      };
    if (status === 404)
      return {
        kind: "fatal",
        message: `Hue has no subscription ${subscription} for this ${label} (${named}).`,
      };
    if (status === 409 && code === "pull_in_progress")
      return {
        kind: "retry",
        reason: "another pull is open for this subscription (is another hue listen running?)",
        retryAfterMs: retryAfterMs(response),
      };
    if (status === 409 && code === "not_listen")
      return {
        kind: "fatal",
        message: `Subscription ${subscription} delivers to a request URL; hue listen needs a listen subscription.`,
      };
    if (status === 409 && code === "subscription_revoked")
      return { kind: "fatal", message: `Subscription ${subscription} is revoked.` };
    if (status === 429 || status >= 500)
      return { kind: "retry", reason: named, retryAfterMs: retryAfterMs(response) };
    return { kind: "fatal", message: `Hue refused the pull (${named}).` };
  };

  const acknowledge = async (
    delivery: Delivery,
    answer: LocalAnswer,
    deadline: number,
  ): Promise<AckResult> => {
    for (let attempt = 0; ; attempt++) {
      // The first acknowledgement is always sent (Hue decides whether the lease still holds);
      // repeats stop when the lease has ended.
      const remaining = deadline - performance.now();
      if (forced.signal.aborted || (attempt > 0 && remaining <= 0)) return { kind: "unanswered" };
      const step = ACK_RETRY_DELAYS_MS[Math.min(attempt, ACK_RETRY_DELAYS_MS.length - 1)]!;
      const request = new AbortController();
      const abort = () => request.abort();
      forced.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, Math.min(ACK_REQUEST_TIMEOUT_MS, Math.max(1_000, remaining)));
      try {
        const response = await fetchImpl(`${base}/${delivery.deliveryId}/ack`, {
          method: "POST",
          headers,
          body: JSON.stringify(answer),
          redirect: "manual",
          signal: request.signal,
        });
        if (response.status >= 200 && response.status <= 299) {
          let state: string | null = null;
          try {
            const parsed: unknown = JSON.parse(await readBounded(response, MAX_ACK_RESPONSE_BYTES));
            const candidate = isObject(parsed)
              ? (parsed.state ?? (isObject(parsed.event) ? parsed.event.state : undefined))
              : undefined;
            if (typeof candidate === "string" && EVENT_STATES.has(candidate)) state = candidate;
          } catch {
            // The acknowledgement is recorded whatever the answer's body holds.
          }
          return { kind: "recorded", state };
        }
        const code = await refusalCode(response);
        if (response.status === 409 && code === "lease_expired") return { kind: "lease_expired" };
        if (response.status === 409 && code === "subscription_revoked") return { kind: "revoked" };
        if (response.status !== 429 && response.status < 500)
          return { kind: "refused", status: response.status, code };
        // A `Retry-After` of 0 never turns the backoff into a busy loop.
        await sleep(
          Math.min(Math.max(step, retryAfterMs(response) ?? 0), Math.max(0, remaining)),
          forced.signal,
        );
      } catch {
        // No answer: the same acknowledgement is safe to repeat until the lease ends.
        await sleep(Math.min(step, Math.max(0, remaining)), forced.signal);
      } finally {
        clearTimeout(timer);
        forced.signal.removeEventListener("abort", abort);
      }
    }
  };

  const deliver = async (delivery: Delivery, deadline: number): Promise<void> => {
    // Hue may hand out a delivery again (a pull whose answer was retried); its request already
    // reached the receiver, so the recorded answer is repeated and nothing is sent twice.
    const previous = remembered.get(delivery.deliveryId);
    const answer =
      previous ??
      (await forwardDelivery(target, delivery, {
        timeoutMs: forwardTimeoutMs,
        allowRemote,
        signal: forced.signal,
      }));
    const name =
      delivery.kind === "url_verification"
        ? "url_verification"
        : `${delivery.eventId ?? "event"}${delivery.retryNum ? ` retry ${delivery.retryNum}` : ""}`;
    if (answer === null) {
      out(
        `${new Date().toISOString()}  ${name} -> abandoned; not acknowledged, the lease lapses into a timeout`,
      );
      return;
    }
    if (!previous) {
      remembered.set(delivery.deliveryId, answer);
      if (remembered.size > REMEMBERED_DELIVERIES)
        remembered.delete(remembered.keys().next().value!);
    }
    const result = await acknowledge(delivery, answer, deadline);
    if (result.kind === "revoked") fatal ??= `Subscription ${subscription} is revoked.`;
    out(
      `${new Date().toISOString()}  ${name}${previous ? " (repeated)" : ""} -> ${describeAnswer(answer)}; ${describeAck(result)}`,
    );
  };

  out(
    `Forwarding subscription ${subscription} from ${foreign(origin)} to ${foreign(target.href)} using the ${label}. Press Ctrl+C to stop.`,
  );
  let failures = 0;
  let ready = false;
  try {
    while (!stopping.signal.aborted && fatal === null) {
      // The first pull answers at once, so a refused credential or subscription shows immediately.
      const pulledAt = performance.now();
      const result = await pull(ready ? PULL_WAIT_MS : 0);
      if (result.kind === "stopped") break;
      if (result.kind === "fatal") {
        fatal = result.message;
        break;
      }
      if (result.kind === "retry") {
        // `Retry-After` can lengthen the backoff, never shorten it.
        const delay = Math.max(
          pullRetryDelays[Math.min(failures, pullRetryDelays.length - 1)]!,
          result.retryAfterMs ?? 0,
        );
        failures++;
        warn(`Pull failed: ${result.reason}; retrying in ${Math.ceil(delay / 1000)} s.`);
        await sleep(delay, stopping.signal);
        continue;
      }
      failures = 0;
      // A pull that answers empty at once, though it could wait, is not repeated at once.
      if (ready && result.deliveries.length === 0 && performance.now() - pulledAt < 1_000)
        await sleep(1_000, stopping.signal);
      if (!ready) {
        ready = true;
        out("Ready: waiting for events.");
      }
      if (result.skipped)
        warn(
          `Skipped ${result.skipped} delivery(ies) this version of @hue-run/sdk cannot forward; their leases lapse and Hue retries them.`,
        );
      if (result.excess)
        warn(
          `Hue leased ${result.excess} more delivery(ies) than --max ${max}; they are not forwarded, their leases lapse and Hue retries them.`,
        );
      await Promise.all(
        result.deliveries.map((delivery) =>
          deliver(delivery, result.receivedAt + result.leaseLeftMs(delivery)),
        ),
      );
    }
  } finally {
    removeInterrupt();
  }
  if (fatal !== null) {
    warn(`Error: ${fatal}`);
    return 1;
  }
  if (forced.signal.aborted) {
    warn("Interrupted.");
    return 130;
  }
  out("Stopped.");
  return 0;
}
