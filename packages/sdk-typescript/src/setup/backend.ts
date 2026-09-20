import { createHue } from "../client.js";
import { isLoopbackHost } from "../config.js";
import { verifySetupTrace } from "../receipt.js";
import { validSetupCredentialIdentity } from "./credential.js";
import type { TraceReceipt } from "../types.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  configureSetupProject,
  validateSetupConfiguration,
  type SetupFileChange,
} from "./configure.js";
import {
  exerciseSetupApplication,
  installSetupRuntime,
  planSetupApplication,
  wireSetupApplication,
  type SetupApplicationPlan,
  type SetupCommandRunner,
} from "./application.js";
import type { SetupProjectDetection } from "./types.js";
import {
  FileSetupInstallationStore,
  type SetupInstallationRecord,
  type SetupStoredCredential,
} from "./installation.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_ORIGIN = "https://app.hue.run";
const SETUP_ERROR_STATUSES = new Map<string, number>([
  ["SETUP_INVALID_REQUEST", 400],
  ["SETUP_UNAUTHORIZED", 401],
  ["SETUP_ACCOUNT_REQUIRED", 401],
  ["SETUP_FORBIDDEN", 403],
  ["SETUP_CHANGED", 409],
  ["SETUP_DESTINATION_REQUIRED", 409],
  ["SETUP_HANDOFF_LIMIT", 409],
  ["SETUP_REVOKED", 409],
  ["SETUP_EXPIRED", 410],
  ["SETUP_BODY_TOO_LARGE", 413],
  ["SETUP_RATE_LIMITED", 429],
  ["SETUP_CAPACITY", 429],
  ["SETUP_QUOTA", 429],
  ["SETUP_DISABLED", 503],
  ["SETUP_BUSY", 503],
  ["SETUP_UNAVAILABLE", 503],
]);

/** Read-only public setup availability and fixed anonymous bounds. */
export interface SetupPreflightStatus {
  /** Frozen HTTP protocol version, independent of public event version. */
  protocolVersion: 1;
  /** Whether anonymous provisioning is currently enabled. */
  state: "available" | "inactive";
  /** Server-enforced metadata projection for all setup keys. */
  capturePolicy: "metadata-only-v1";
  /** Lifetime anonymous storage bounds. */
  limits: {
    /** Maximum stored traces. */
    traces: 100;
    /** Maximum stored spans. */
    spans: 1000;
    /** Maximum sanitized stored bytes. */
    bytes: 2097152;
  };
  /** Fixed anonymous write and retention windows. */
  lifetime: {
    /** Ingestion expires one day after provisioning. */
    expiresAfterSeconds: 86400;
    /** Unclaimed data is purged eight days after provisioning. */
    purgeAfterSeconds: 691200;
  };
  /** Published disclosure, not an executable acceptance gate. */
  privacyNotice: {
    /** Canonical public privacy page. */
    url: "https://hue.run/privacy";
    /** Published notice effective date. */
    effectiveDate: "2026-08-24";
  };
  /** Canonical public security information. */
  securityUrl: "https://trust.hue.run/";
}

/** Non-secret descriptor for the current one-time browser handoff. */
export interface SetupClaimHandoff {
  /** Persisted lowercase UUIDv4; not the bearer capability. */
  id: string;
  /** One-time handoff lifecycle state. */
  state: "pending" | "consumed" | "expired" | "revoked";
  /** Original fixed handoff deadline. */
  expiresAt: string;
  /** Distinct browser session deadline after successful exchange. */
  sessionExpiresAt: string | null;
}

/** Strictly validated Setup HTTP protocol v1 installation status. */
export interface SetupInstallationStatus {
  /** Setup protocol version. */
  protocolVersion: 1;
  /** Project/origin-scoped lowercase UUIDv4. */
  installationId: string;
  /** Server lifecycle state; expired and purged are terminal. */
  state: "active" | "claimed" | "expired" | "purged";
  /** Isolated trial project, or null only when the protocol permits no project. */
  project: {
    /** Project identifier retained across account claim. */
    id: string;
    /** Organization currently owning the project. */
    organizationId: string;
  } | null;
  /** Current anonymous or post-claim credential generation. */
  credentialVersion: 0 | 1;
  /** Server-enforced setup telemetry policy. */
  capturePolicy: "metadata-only-v1";
  /** Trial expiry timestamp, or null after claim. */
  expiresAt: string | null;
  /** Fixed anonymous lifetime limits. */
  limits: {
    /** Maximum anonymous traces. */
    traces: 100;
    /** Maximum anonymous spans. */
    spans: 1000;
    /** Maximum anonymous canonical stored bytes. */
    bytes: 2097152;
  };
  /** Anonymous lifetime usage counters. */
  usage: {
    /** Accepted trace count. */
    traces: number;
    /** Accepted span count. */
    spans: number;
    /** Accepted canonical stored bytes. */
    bytes: number;
  };
  /** Non-secret current one-time browser handoff descriptor. */
  claimHandoff: SetupClaimHandoff | null;
  /** Same-origin telemetry and receipt routes fixed by protocol v1. */
  endpoints: {
    /** Relative OTLP/HTTP traces route. */
    otlp: "/api/v1/otlp/v1/traces";
    /** Relative exact-receipt route template. */
    receipt: "/api/v1/setup/traces/{traceId}/receipt";
  };
}

/** Installation status plus one idempotently recovered telemetry credential. */
export interface SetupCredentialResult extends SetupInstallationStatus {
  /** Telemetry-only credential for the requested generation. */
  credential: SetupStoredCredential & {
    /** Closed capability set enforced for setup-issued keys. */
    capabilities: ["setup_telemetry_write"];
  };
}

/** Exact receipt evidence for one real metadata-only setup probe. */
export interface SetupProbeEvidence {
  /** External trace identifier sent by the probe. */
  traceId: string;
  /** External span identifier required in the receipt. */
  spanId: string;
  /** Validated positive receipt containing the exact identifiers. */
  receipt: TraceReceipt;
}

/** Exact receipt evidence from a request through the repository's existing application. */
export interface SetupApplicationEvidence extends SetupProbeEvidence {
  /** Closed evidence source; synthetic setup probes can never satisfy application verification. */
  source: "existing-application-request";
}

/** @deprecated Use SetupInstallationStatus. Retained as an exported compatibility name. */
export type SetupBackendTrial = SetupInstallationStatus;
/** @deprecated Use SetupProbeEvidence. Retained as an exported compatibility name. */
export type SetupBackendReceipt = SetupProbeEvidence;
/** Non-secret account-claim state; bearer handoffs are never part of public adapter results. */
export type SetupBackendClaim =
  | {
      /** Browser owner action is still required. */
      status: "required";
      /** Installation identity associated with the claim. */
      claimId: string;
      /** Capability-free indication that the browser handoff is stored owner-only. */
      handoff: "owner-local";
    }
  | {
      /** Browser claim and local reconciliation completed. */
      status: "completed";
      /** Installation identity associated with the claim. */
      claimId: string;
    };

/** Sanitized setup failure with a stable local or protocol code. */
export class SetupBackendError extends Error {
  constructor(
    /** Stable local code or exact `SETUP_*` server code. */
    readonly code:
      | "invalid_origin"
      | "transport"
      | "invalid_response"
      | "unverified"
      | `SETUP_${string}`,
    message: string,
    /** Validated HTTP status when the failure came from the server. */
    readonly status?: number,
    /** Bounded server-requested retry delay, when provided. */
    readonly retryAfterMillis?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SetupBackendError";
  }
}

/** Construction options for the real Setup HTTP protocol v1 adapter. */
export interface SetupBackendAdapterOptions {
  /** Project directory that owns the installation identity and managed configuration. */
  projectRoot: string;
  /** HTTPS Hue origin, or an explicit loopback HTTP origin for isolated tests. */
  origin?: string;
  /** Injectable Fetch implementation used by synthetic loopback tests. */
  fetch?: typeof globalThis.fetch;
  /** Per-request deadline in milliseconds. */
  requestTimeoutMillis?: number;
  /** Total receipt polling deadline in milliseconds. */
  receiptTimeoutMillis?: number;
  /** Injectable owner-browser opener used only by isolated tests. */
  openBrowser?: (localHandoffUrl: string) => Promise<void>;
  /** Injectable fixed-argv package-manager runner used only by isolated tests. */
  commandRunner?: SetupCommandRunner;
}

async function openLocalHandoff(localHandoffUrl: string): Promise<void> {
  const executable =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [localHandoffUrl], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function boundedId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\0]/u.test(value)
  );
}

function parseOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SetupBackendError("invalid_origin", "Hue setup requires a valid origin.");
  }
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new SetupBackendError(
      "invalid_origin",
      "Hue setup requires an HTTPS origin, except for an explicit loopback HTTP test origin.",
    );
  return url.origin;
}

function isoDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function uuidV4(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)
  );
}

function parseClaimHandoff(value: unknown): SetupClaimHandoff | null {
  if (value === null) return null;
  if (
    !record(value) ||
    !exactKeys(value, ["id", "state", "expiresAt", "sessionExpiresAt"]) ||
    !uuidV4(value.id) ||
    !["pending", "consumed", "expired", "revoked"].includes(value.state as string) ||
    !isoDate(value.expiresAt) ||
    !(value.sessionExpiresAt === null || isoDate(value.sessionExpiresAt)) ||
    (value.state === "pending" && value.sessionExpiresAt !== null)
  )
    throw new SetupBackendError("invalid_response", "Hue returned an invalid setup response.");
  return {
    id: value.id,
    state: value.state as SetupClaimHandoff["state"],
    expiresAt: value.expiresAt,
    sessionExpiresAt: value.sessionExpiresAt as string | null,
  };
}

function parsePreflight(value: unknown): SetupPreflightStatus {
  if (
    !record(value) ||
    !exactKeys(value, [
      "protocolVersion",
      "state",
      "capturePolicy",
      "limits",
      "lifetime",
      "privacyNotice",
      "securityUrl",
    ])
  )
    throw new SetupBackendError(
      "invalid_response",
      "Hue returned an invalid setup preflight response.",
    );
  const limits = value.limits;
  const lifetime = value.lifetime;
  const privacyNotice = value.privacyNotice;
  if (
    value.protocolVersion !== 1 ||
    (value.state !== "available" && value.state !== "inactive") ||
    value.capturePolicy !== "metadata-only-v1" ||
    !record(limits) ||
    !exactKeys(limits, ["traces", "spans", "bytes"]) ||
    limits.traces !== 100 ||
    limits.spans !== 1000 ||
    limits.bytes !== 2097152 ||
    !record(lifetime) ||
    !exactKeys(lifetime, ["expiresAfterSeconds", "purgeAfterSeconds"]) ||
    lifetime.expiresAfterSeconds !== 86400 ||
    lifetime.purgeAfterSeconds !== 691200 ||
    !record(privacyNotice) ||
    !exactKeys(privacyNotice, ["url", "effectiveDate"]) ||
    privacyNotice.url !== "https://hue.run/privacy" ||
    privacyNotice.effectiveDate !== "2026-08-24" ||
    value.securityUrl !== "https://trust.hue.run/"
  )
    throw new SetupBackendError(
      "invalid_response",
      "Hue returned an invalid setup preflight response.",
    );
  return {
    protocolVersion: 1,
    state: value.state,
    capturePolicy: "metadata-only-v1",
    limits: { traces: 100, spans: 1000, bytes: 2097152 },
    lifetime: { expiresAfterSeconds: 86400, purgeAfterSeconds: 691200 },
    privacyNotice: { url: "https://hue.run/privacy", effectiveDate: "2026-08-24" },
    securityUrl: "https://trust.hue.run/",
  };
}

function parseStatus(
  value: unknown,
  installationId: string,
  credentialResponse = false,
): SetupInstallationStatus {
  if (!record(value))
    throw new SetupBackendError("invalid_response", "Hue returned an invalid setup response.");
  const keys = [
    "protocolVersion",
    "installationId",
    "state",
    "project",
    "credentialVersion",
    "capturePolicy",
    "expiresAt",
    "limits",
    "usage",
    "claimHandoff",
    "endpoints",
  ];
  if (!exactKeys(value, credentialResponse ? [...keys, "credential"] : keys))
    throw new SetupBackendError("invalid_response", "Hue returned an invalid setup response.");
  const project = value.project;
  const limits = value.limits;
  const usage = value.usage;
  const endpoints = value.endpoints;
  const claimHandoff = parseClaimHandoff(value.claimHandoff);
  if (
    value.protocolVersion !== 1 ||
    value.installationId !== installationId ||
    !["active", "claimed", "expired", "purged"].includes(value.state as string) ||
    !(
      project === null ||
      (record(project) &&
        exactKeys(project, ["id", "organizationId"]) &&
        boundedId(project.id) &&
        boundedId(project.organizationId))
    ) ||
    (value.credentialVersion !== 0 && value.credentialVersion !== 1) ||
    value.capturePolicy !== "metadata-only-v1" ||
    !(value.expiresAt === null || isoDate(value.expiresAt)) ||
    !record(limits) ||
    !exactKeys(limits, ["traces", "spans", "bytes"]) ||
    limits.traces !== 100 ||
    limits.spans !== 1000 ||
    limits.bytes !== 2097152 ||
    !record(usage) ||
    !exactKeys(usage, ["traces", "spans", "bytes"]) ||
    ![usage.traces, usage.spans, usage.bytes].every(
      (item) => Number.isSafeInteger(item) && (item as number) >= 0,
    ) ||
    !record(endpoints) ||
    !exactKeys(endpoints, ["otlp", "receipt"]) ||
    endpoints.otlp !== "/api/v1/otlp/v1/traces" ||
    endpoints.receipt !== "/api/v1/setup/traces/{traceId}/receipt"
  )
    throw new SetupBackendError("invalid_response", "Hue returned an invalid setup response.");
  if (
    value.state === "active" &&
    (value.expiresAt === null || project === null || value.credentialVersion !== 0)
  ) {
    throw new SetupBackendError("invalid_response", "Hue returned an invalid setup response.");
  }
  if (
    value.state === "claimed" &&
    (value.expiresAt !== null || value.credentialVersion !== 1 || project === null)
  )
    throw new SetupBackendError("invalid_response", "Hue returned an invalid setup response.");
  return {
    protocolVersion: 1,
    installationId,
    state: value.state as SetupInstallationStatus["state"],
    project: project as SetupInstallationStatus["project"],
    credentialVersion: value.credentialVersion as 0 | 1,
    capturePolicy: "metadata-only-v1",
    expiresAt: value.expiresAt as string | null,
    limits: { traces: 100, spans: 1000, bytes: 2097152 },
    usage: usage as SetupInstallationStatus["usage"],
    claimHandoff,
    endpoints: {
      otlp: "/api/v1/otlp/v1/traces",
      receipt: "/api/v1/setup/traces/{traceId}/receipt",
    },
  };
}

function parseCredential(value: unknown, installationId: string): SetupCredentialResult {
  const status = parseStatus(value, installationId, true);
  if (!record(value) || !record(value.credential))
    throw new SetupBackendError(
      "invalid_response",
      "Hue returned an invalid setup credential response.",
    );
  const credential = value.credential;
  if (
    !exactKeys(credential, ["apiKey", "keyId", "capabilities", "version", "kind"]) ||
    credential.kind !== "anonymous_trial" ||
    !validSetupCredentialIdentity(credential.apiKey, credential.keyId) ||
    !Array.isArray(credential.capabilities) ||
    credential.capabilities.length !== 1 ||
    credential.capabilities[0] !== "setup_telemetry_write" ||
    (credential.version !== 0 && credential.version !== 1) ||
    credential.version !== status.credentialVersion
  )
    throw new SetupBackendError(
      "invalid_response",
      "Hue returned an invalid setup credential response.",
    );
  return {
    ...status,
    credential: {
      kind: "anonymous_trial",
      apiKey: credential.apiKey,
      keyId: credential.keyId as string,
      capabilities: ["setup_telemetry_write"],
      version: credential.version,
    },
  };
}

function retryAfter(header: string | null): number {
  if (!header) return 0;
  if (/^\d+$/u.test(header)) return Math.min(Number(header) * 1000, 24 * 60 * 60 * 1000);
  const parsed = Date.parse(header);
  return Number.isFinite(parsed)
    ? Math.min(Math.max(0, parsed - Date.now()), 24 * 60 * 60 * 1000)
    : 0;
}

function validateClaimUrl(value: unknown, origin: string): string {
  if (typeof value !== "string")
    throw new SetupBackendError("invalid_response", "Hue returned an invalid private handoff.");
  let claim: URL;
  try {
    claim = new URL(value);
  } catch {
    throw new SetupBackendError("invalid_response", "Hue returned an invalid private handoff.");
  }
  if (
    claim.href !== value ||
    claim.origin !== origin ||
    claim.username ||
    claim.password ||
    claim.pathname !== "/setup/claim" ||
    claim.search ||
    !/^#[A-Za-z0-9_-]{43}$/u.test(claim.hash)
  )
    throw new SetupBackendError("invalid_response", "Hue returned an invalid private handoff.");
  return value;
}

function parseClaimHandoffResponse(
  value: unknown,
  installationId: string,
  handoffId: string,
  origin: string,
): { handoff: SetupClaimHandoff; claimUrl: string | null } {
  if (
    !record(value) ||
    !exactKeys(value, ["protocolVersion", "installationId", "handoff", "claimUrl"]) ||
    value.protocolVersion !== 1 ||
    value.installationId !== installationId
  )
    throw new SetupBackendError("invalid_response", "Hue returned an invalid private handoff.");
  const handoff = parseClaimHandoff(value.handoff);
  if (!handoff || handoff.id !== handoffId)
    throw new SetupBackendError("invalid_response", "Hue returned an invalid private handoff.");
  if (handoff.state === "pending")
    return { handoff, claimUrl: validateClaimUrl(value.claimUrl, origin) };
  if (value.claimUrl !== null)
    throw new SetupBackendError("invalid_response", "Hue returned an invalid private handoff.");
  return { handoff, claimUrl: null };
}

async function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Setup interrupted");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Setup interrupted"));
      },
      { once: true },
    );
  });
}

/** Real implementation of the frozen Setup HTTP protocol v1. */
export class SetupBackendAdapter {
  /** Exact normalized Hue origin used by every request. */
  readonly origin: string;
  /** Project/origin-scoped owner-only installation store. */
  readonly store: FileSetupInstallationStore;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly requestTimeoutMillis: number;
  private readonly receiptTimeoutMillis: number;
  private readonly browserOpener: (localHandoffUrl: string) => Promise<void>;
  private readonly commandRunner?: SetupCommandRunner;
  private installation?: SetupInstallationRecord;
  private applicationPlan?: SetupApplicationPlan;
  private installationStatus?: SetupInstallationStatus;

  /** Discards cached facts after the command-wide lock has been acquired. */
  resetLocalCache(): void {
    this.installation = undefined;
    this.applicationPlan = undefined;
    this.installationStatus = undefined;
  }

  constructor(options: SetupBackendAdapterOptions) {
    this.origin = parseOrigin(options.origin ?? DEFAULT_ORIGIN);
    this.store = new FileSetupInstallationStore(options.projectRoot, this.origin);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMillis = options.requestTimeoutMillis ?? 10_000;
    this.receiptTimeoutMillis = options.receiptTimeoutMillis ?? 10_000;
    this.browserOpener = options.openBrowser ?? openLocalHandoff;
    this.commandRunner = options.commandRunner;
    if (
      !Number.isInteger(this.requestTimeoutMillis) ||
      this.requestTimeoutMillis < 100 ||
      this.requestTimeoutMillis > 60_000 ||
      !Number.isInteger(this.receiptTimeoutMillis) ||
      this.receiptTimeoutMillis < 100 ||
      this.receiptTimeoutMillis > 60_000
    )
      throw new TypeError("Setup request and receipt timeouts must be 100–60000 milliseconds");
  }

  /** Persists installation UUID and proof before returning control to any network operation. */
  async prepare(): Promise<SetupInstallationRecord> {
    this.installation ??= await this.store.loadOrCreate();
    await this.store.ensureIgnored();
    return this.installation;
  }

  /** Reads local state without creating files or contacting Hue. */
  async localInstallation(): Promise<SetupInstallationRecord | undefined> {
    if (this.installation) return this.installation;
    this.installation = await this.store.load();
    return this.installation;
  }

  private async readJson(response: Response): Promise<unknown> {
    if (!/(?:^|,)\s*no-store\s*(?:,|$)/iu.test(response.headers.get("cache-control") ?? ""))
      throw new SetupBackendError(
        "invalid_response",
        "Hue returned an unsafe cacheable setup response.",
      );
    if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? ""))
      throw new SetupBackendError(
        "invalid_response",
        "Hue returned an invalid setup response content type.",
      );
    const length = response.headers.get("content-length");
    if (length && /^\d+$/u.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new SetupBackendError("invalid_response", "Hue returned an oversized setup response.");
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw new SetupBackendError("invalid_response", "Hue returned an empty setup response.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new SetupBackendError(
            "invalid_response",
            "Hue returned an oversized setup response.",
          );
        }
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new SetupBackendError("invalid_response", "Hue returned invalid setup JSON.");
    }
  }

  private async publicPreflightRequest(signal?: AbortSignal): Promise<SetupPreflightStatus> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal?.aborted) throw new Error("Setup interrupted");
      try {
        const timeout = AbortSignal.timeout(this.requestTimeoutMillis);
        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const response = await this.fetcher(new URL("/api/v1/setup/preflight", this.origin), {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "manual",
          credentials: "omit",
          cache: "no-store",
          signal: requestSignal,
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new SetupBackendError(
            "invalid_response",
            "Hue setup preflight refused a redirect.",
            response.status,
          );
        }
        const value = await this.readJson(response);
        if (response.status === 200) return parsePreflight(value);
        const code = record(value) && typeof value.code === "string" ? value.code : undefined;
        if (
          !code ||
          !record(value) ||
          !exactKeys(value, ["protocolVersion", "code"]) ||
          value.protocolVersion !== 1 ||
          SETUP_ERROR_STATUSES.get(code) !== response.status
        )
          throw new SetupBackendError(
            "invalid_response",
            "Hue returned an invalid setup preflight error.",
            response.status,
          );
        const wait = retryAfter(response.headers.get("retry-after"));
        const delay = Math.max(wait, 250 * 2 ** attempt);
        if ((response.status === 429 || response.status === 503) && attempt < 2 && delay <= 5000) {
          await pause(delay, signal);
          continue;
        }
        throw new SetupBackendError(
          code as `SETUP_${string}`,
          `Hue setup stopped with ${code}.`,
          response.status,
          wait,
        );
      } catch (error) {
        if (error instanceof SetupBackendError) throw error;
        if (signal?.aborted) throw new Error("Setup interrupted");
        if (attempt < 2) {
          await pause(250 * 2 ** attempt, signal);
          continue;
        }
      }
    }
    throw new SetupBackendError("transport", "Hue setup could not reach the configured origin.");
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown> | undefined,
    attempts: number,
    signal?: AbortSignal,
    onAttempt?: () => Promise<void>,
  ): Promise<unknown> {
    const installation = await this.prepare();
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && Buffer.byteLength(encoded) > 2048)
      throw new Error("Setup request body is too large");
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal?.aborted) throw new Error("Setup interrupted");
      await onAttempt?.();
      try {
        const timeout = AbortSignal.timeout(this.requestTimeoutMillis);
        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const response = await this.fetcher(new URL(path, this.origin), {
          method,
          headers: {
            Authorization: `Bearer hue_install_${installation.installationSecret}`,
            Accept: "application/json",
            ...(encoded ? { "Content-Type": "application/json" } : {}),
          },
          ...(encoded ? { body: encoded } : {}),
          redirect: "manual",
          credentials: "omit",
          cache: "no-store",
          signal: requestSignal,
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new SetupBackendError(
            "invalid_response",
            "Hue setup refused a redirect.",
            response.status,
          );
        }
        const value = await this.readJson(response);
        if (response.status === 200) return value;
        const code = record(value) && typeof value.code === "string" ? value.code : undefined;
        if (
          !code ||
          !record(value) ||
          !exactKeys(value, ["protocolVersion", "code"]) ||
          value.protocolVersion !== 1 ||
          SETUP_ERROR_STATUSES.get(code) !== response.status
        )
          throw new SetupBackendError(
            "invalid_response",
            "Hue returned an invalid setup error.",
            response.status,
          );
        const wait = retryAfter(response.headers.get("retry-after"));
        const retriable = response.status === 429 || response.status === 503;
        const delay = Math.max(wait, 250 * 2 ** attempt);
        if (retriable && attempt + 1 < attempts && delay <= 5000) {
          await pause(delay, signal);
          continue;
        }
        throw new SetupBackendError(
          code as `SETUP_${string}`,
          `Hue setup stopped with ${code}.`,
          response.status,
          wait,
        );
      } catch (error) {
        if (error instanceof SetupBackendError) throw error;
        if (signal?.aborted) throw new Error("Setup interrupted");
        if (attempt + 1 < attempts) {
          await pause(250 * 2 ** attempt, signal);
          continue;
        }
      }
    }
    throw new SetupBackendError("transport", "Hue setup could not reach the configured origin.");
  }

  /** Creates once or recovers the same installation. At most two provision writes occur per invocation. */
  async provision(signal?: AbortSignal): Promise<SetupInstallationStatus> {
    const installation = await this.prepare();
    const cutoff = Date.now() - 60 * 60 * 1000;
    installation.provisionAttempts = installation.provisionAttempts.filter(
      (value) => Date.parse(value) >= cutoff,
    );
    if (installation.provisionAttempts.length >= 5)
      throw new SetupBackendError(
        "SETUP_RATE_LIMITED",
        "This installation has used its bounded provisioning budget; retry after one hour.",
        429,
      );
    const attempts = Math.min(2, 5 - installation.provisionAttempts.length);
    const value = await this.request(
      "POST",
      "/api/v1/setup/installations",
      { protocolVersion: 1, installationId: installation.installationId },
      attempts,
      signal,
      async () => {
        installation.provisionAttempts.push(new Date().toISOString());
        await this.store.save(installation);
      },
    );
    this.installationStatus = parseStatus(value, installation.installationId);
    return this.installationStatus;
  }

  /** Reads and validates the current installation status without provisioning. */
  async status(signal?: AbortSignal): Promise<SetupInstallationStatus> {
    const installation = await this.prepare();
    const value = await this.request(
      "GET",
      `/api/v1/setup/installations/${installation.installationId}`,
      undefined,
      3,
      signal,
    );
    const status = parseStatus(value, installation.installationId);
    this.installationStatus = status;
    if (status.state !== "active") await this.store.removeClaimHandoff();
    return status;
  }

  /** Requests or recovers one proof-bound handoff and opens only its owner-local file URL. */
  async prepareClaimHandoff(
    status: SetupInstallationStatus,
    openBrowser: boolean,
    restart = false,
    signal?: AbortSignal,
  ): Promise<{
    /** Whether the owner-local handoff file was opened without echoing its URL. */
    opened: boolean;
    /** Last observed non-secret handoff state. */
    state: SetupClaimHandoff["state"];
    /** Whether explicit owner restart is necessary rather than browser-session resume. */
    restartRequired: boolean;
  }> {
    if (status.state !== "active")
      throw new SetupBackendError(
        "invalid_response",
        "Hue does not permit a browser handoff for this installation state.",
      );
    const installation = await this.prepare();
    let stored = installation.claimHandoff;
    if (!restart && status.claimHandoff?.state === "consumed") {
      // Never rotate or replay an exchanged browser capability while its session is live.
      await this.store.removeClaimHandoff();
      return {
        opened: false,
        state: "consumed",
        restartRequired:
          !status.claimHandoff.sessionExpiresAt ||
          Date.parse(status.claimHandoff.sessionExpiresAt) <= Date.now(),
      };
    }
    // A persisted request without a response is retried with exactly the same ID, even
    // when the owner repeats --restart after interruption. Never extend that handoff TTL.
    if (restart && !(stored && stored.state === undefined)) {
      stored = {
        id: randomUUID().toLowerCase(),
        previousHandoffId: status.claimHandoff?.id ?? null,
      };
      installation.claimHandoff = stored;
      await this.store.save(installation);
    } else if (stored) {
      if (
        status.claimHandoff &&
        status.claimHandoff.id !== stored.id &&
        !(stored.state === undefined && stored.previousHandoffId === status.claimHandoff.id)
      ) {
        await this.status(signal);
        throw new SetupBackendError(
          "SETUP_CHANGED",
          "The browser handoff changed. Refresh status and choose explicitly whether to restart it.",
          409,
        );
      }
    } else if (status.claimHandoff) {
      if (status.claimHandoff.state !== "pending")
        return {
          opened: false,
          state: status.claimHandoff.state,
          restartRequired: true,
        };
      stored = { id: status.claimHandoff.id, previousHandoffId: null };
      installation.claimHandoff = stored;
      await this.store.save(installation);
    } else {
      stored = { id: randomUUID().toLowerCase(), previousHandoffId: null };
      installation.claimHandoff = stored;
      await this.store.save(installation);
    }
    let value: unknown;
    try {
      value = await this.request(
        "POST",
        `/api/v1/setup/installations/${installation.installationId}/claim-handoff`,
        {
          protocolVersion: 1,
          handoffId: stored.id,
          previousHandoffId: stored.previousHandoffId,
        },
        3,
        signal,
      );
    } catch (error) {
      if (error instanceof SetupBackendError && error.code === "SETUP_CHANGED") {
        await this.status(signal);
      }
      throw error;
    }
    const result = parseClaimHandoffResponse(
      value,
      installation.installationId,
      stored.id,
      this.origin,
    );
    installation.claimHandoff = {
      id: result.handoff.id,
      previousHandoffId: stored.previousHandoffId,
      state: result.handoff.state,
      expiresAt: result.handoff.expiresAt,
      sessionExpiresAt: result.handoff.sessionExpiresAt,
    };
    await this.store.save(installation);
    if (!result.claimUrl) {
      await this.store.removeClaimHandoff();
      return {
        opened: false,
        state: result.handoff.state,
        restartRequired:
          result.handoff.state !== "consumed" ||
          !result.handoff.sessionExpiresAt ||
          Date.parse(result.handoff.sessionExpiresAt) <= Date.now(),
      };
    }
    const path = await this.store.saveClaimHandoff(result.claimUrl);
    if (!openBrowser) return { opened: false, state: result.handoff.state, restartRequired: false };
    try {
      await this.browserOpener(pathToFileURL(path).href);
      return { opened: true, state: result.handoff.state, restartRequired: false };
    } catch {
      return { opened: false, state: result.handoff.state, restartRequired: false };
    }
  }

  /** Retrieves an idempotent generation and persists it before it can be used by project config. */
  async credentials(
    credentialVersion: 0 | 1,
    signal?: AbortSignal,
  ): Promise<SetupCredentialResult> {
    const installation = await this.prepare();
    const value = await this.request(
      "POST",
      `/api/v1/setup/installations/${installation.installationId}/credentials`,
      { protocolVersion: 1, credentialVersion },
      3,
      signal,
    );
    const result = parseCredential(value, installation.installationId);
    this.installationStatus = result;
    if (result.credential.version !== credentialVersion)
      throw new SetupBackendError(
        "invalid_response",
        "Hue returned a credential generation different from the requested generation.",
      );
    if (
      credentialVersion === 1 &&
      installation.credential?.version === 0 &&
      !installation.revocationCredential
    )
      installation.revocationCredential = installation.credential;
    if (credentialVersion === 0) delete installation.revocationCredential;
    installation.credential = {
      kind: "anonymous_trial",
      capabilities: ["setup_telemetry_write"],
      apiKey: result.credential.apiKey,
      keyId: result.credential.keyId,
      version: result.credential.version,
    };
    if (installation.probe?.credentialVersion !== credentialVersion) delete installation.probe;
    if (
      installation.applicationEvidence?.credentialVersion !== credentialVersion &&
      credentialVersion === 0
    )
      delete installation.applicationEvidence;
    if (
      installation.applicationAttempt?.credentialVersion !== credentialVersion &&
      credentialVersion === 0
    )
      delete installation.applicationAttempt;
    await this.store.save(installation);
    if (credentialVersion === 1) {
      delete installation.claimHandoff;
      await this.store.save(installation);
      await this.store.removeClaimHandoff();
    }
    return result;
  }

  /** Installs the exact Hue runtime through the one unambiguous project package manager. */
  async installRuntime(project: SetupProjectDetection): Promise<boolean> {
    this.applicationPlan ??= await planSetupApplication(project);
    return installSetupRuntime(project, this.applicationPlan, this.commandRunner);
  }

  /** Writes secret-free config and an owned middleware block into the recognized application. */
  async configure(project: SetupProjectDetection): Promise<SetupFileChange[]> {
    const installation = await this.prepare();
    if (!installation.credential) throw new Error("Setup credential is not available");
    this.applicationPlan ??= await planSetupApplication(project);
    const changes = await configureSetupProject(this.store, installation, project);
    const wiring = await wireSetupApplication(this.store, installation, this.applicationPlan);
    if (wiring) changes.push(wiring);
    return changes;
  }

  /** Fails before mutation on unsafe project state, then reads public technical availability. */
  async preflight(
    project: SetupProjectDetection,
    signal?: AbortSignal,
    checkAvailability = true,
  ): Promise<SetupPreflightStatus | undefined> {
    this.applicationPlan = await planSetupApplication(project);
    const installation = await this.localInstallation();
    await validateSetupConfiguration(this.store, installation, project);
    return checkAvailability ? this.publicPreflightRequest(signal) : undefined;
  }

  /** Runs one request through the recognized existing app and privately checkpoints its IDs. */
  async exerciseApplication(project: SetupProjectDetection, signal?: AbortSignal): Promise<void> {
    const installation = await this.prepare();
    this.applicationPlan ??= await planSetupApplication(project);
    await exerciseSetupApplication(this.store, installation, this.applicationPlan, signal);
  }

  private async verifyStoredApplication(
    signal?: AbortSignal,
  ): Promise<SetupApplicationEvidence | undefined> {
    if (signal?.aborted) throw new Error("Setup interrupted");
    const installation = await this.prepare();
    const credential = installation.credential;
    const evidence = installation.applicationEvidence;
    if (
      !credential ||
      !evidence ||
      !(
        evidence.credentialVersion === credential.version ||
        (evidence.credentialVersion === 0 && credential.version === 1)
      )
    )
      return undefined;
    const verification = await verifySetupTrace(
      {
        apiKey: credential.apiKey,
        baseUrl: this.origin,
      },
      evidence.traceId,
      {
        expectedSpanIds: [evidence.spanId],
        timeoutMillis: this.receiptTimeoutMillis,
      },
      this.fetcher,
      signal,
    );
    if (signal?.aborted) throw new Error("Setup interrupted");
    if (!verification.verified || !verification.receipt) return undefined;
    const receipt = verification.receipt;
    await this.validateReceiptProject(receipt, signal);
    if (
      receipt.traceId !== evidence.traceId ||
      receipt.spanCount <= 0 ||
      receipt.missingSpanIds.length !== 0 ||
      receipt.matchedSpanIds.length !== 1 ||
      receipt.matchedSpanIds[0] !== evidence.spanId ||
      receipt.fields.input ||
      receipt.fields.output
    )
      throw new SetupBackendError(
        "invalid_response",
        "Hue returned invalid metadata-only application evidence.",
      );
    evidence.verified = true;
    await this.store.save(installation);
    return { ...evidence, receipt };
  }

  /** Verifies only IDs emitted by the existing application request; it never creates a probe. */
  async verifyApplication(signal?: AbortSignal): Promise<SetupApplicationEvidence | undefined> {
    return this.verifyStoredApplication(signal);
  }

  private async validateReceiptProject(receipt: TraceReceipt, signal?: AbortSignal): Promise<void> {
    const status = this.installationStatus ?? (await this.status(signal));
    const url = new URL(receipt.traceUrl);
    if (
      !status.project ||
      url.searchParams.get("projectId") !== status.project.id ||
      url.searchParams.get("organizationId") !== status.project.organizationId
    )
      throw new SetupBackendError(
        "invalid_response",
        "Hue returned receipt evidence for a different project or organization.",
      );
  }

  private async verifyStoredProbe(signal?: AbortSignal): Promise<SetupProbeEvidence | undefined> {
    if (signal?.aborted) throw new Error("Setup interrupted");
    const installation = await this.prepare();
    const credential = installation.credential;
    const probe = installation.probe;
    if (!credential || !probe || probe.credentialVersion !== credential.version) return undefined;
    const verification = await verifySetupTrace(
      {
        apiKey: credential.apiKey,
        baseUrl: this.origin,
      },
      probe.traceId,
      {
        expectedSpanIds: [probe.spanId],
        timeoutMillis: this.receiptTimeoutMillis,
      },
      this.fetcher,
      signal,
    );
    if (signal?.aborted) throw new Error("Setup interrupted");
    if (!verification.verified || !verification.receipt) return undefined;
    const receipt = verification.receipt;
    await this.validateReceiptProject(receipt, signal);
    if (
      receipt.traceId !== probe.traceId ||
      receipt.spanCount <= 0 ||
      receipt.missingSpanIds.length !== 0 ||
      receipt.matchedSpanIds.length !== 1 ||
      receipt.matchedSpanIds[0] !== probe.spanId ||
      receipt.fields.input ||
      receipt.fields.output
    )
      throw new SetupBackendError(
        "invalid_response",
        "Hue returned invalid metadata-only probe evidence.",
      );
    probe.verified = true;
    await this.store.save(installation);
    return { traceId: probe.traceId, spanId: probe.spanId, receipt };
  }

  /** Exports one real metadata-only span, awaits flush, and verifies its exact stored IDs. */
  async verifyProbe(signal?: AbortSignal): Promise<SetupProbeEvidence | undefined> {
    const installation = await this.prepare();
    if (!installation.credential) throw new Error("Setup credential is not available");
    if (installation.probe?.credentialVersion === installation.credential.version)
      return this.verifyStoredProbe(signal);
    const hue = createHue({
      apiKey: installation.credential.apiKey,
      baseUrl: this.origin,
      serviceName: "hue-setup-probe",
      captureContent: false,
      timeoutMillis: this.requestTimeoutMillis,
    });
    try {
      await hue.withSpan("hue.metadata", async (span) => {
        installation.probe = {
          traceId: span.traceId,
          spanId: span.spanId,
          credentialVersion: installation.credential!.version,
          verified: false,
        };
        await this.store.save(installation);
      });
      await hue.flush();
    } catch (error) {
      delete installation.probe;
      await this.store.save(installation);
      throw error;
    } finally {
      await hue.shutdownSafe({ timeoutMillis: this.requestTimeoutMillis });
    }
    if (signal?.aborted) throw new Error("Setup interrupted");
    return this.verifyStoredProbe(signal);
  }

  /** Confirms a superseded telemetry key cannot read the newly verified receipt. */
  async verifyRevokedCredential(
    oldApiKey: string,
    evidence: SetupProbeEvidence,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw new Error("Setup interrupted");
    // A generic receipt rejects even an active setup key. Only the dedicated route,
    // positively verified with the replacement key first, can prove revocation.
    const url = new URL(`/api/v1/setup/traces/${evidence.traceId}/receipt`, this.origin);
    url.searchParams.set("expectedSpanId", evidence.spanId);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: { Authorization: `Bearer ${oldApiKey}`, Accept: "application/json" },
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMillis)])
          : AbortSignal.timeout(this.requestTimeoutMillis),
      });
      await response.body?.cancel();
    } catch {
      if (signal?.aborted) throw new Error("Setup interrupted");
      throw new SetupBackendError(
        "transport",
        "Hue setup could not verify anonymous credential revocation.",
      );
    }
    if (signal?.aborted) throw new Error("Setup interrupted");
    if (response.status !== 401)
      throw new SetupBackendError(
        "unverified",
        "The superseded anonymous key was not confirmed revoked.",
      );
    const installation = await this.prepare();
    if (installation.revocationCredential?.apiKey === oldApiKey) {
      delete installation.revocationCredential;
      installation.anonymousKeyRevoked = true;
      await this.store.save(installation);
    }
  }
}
