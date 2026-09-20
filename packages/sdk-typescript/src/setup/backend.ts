import { createHue } from "../client.js";
import { isLoopbackHost } from "../config.js";
import type { TraceReceipt } from "../types.js";
import {
  configureSetupProject,
  validateSetupConfiguration,
  type SetupFileChange,
} from "./configure.js";
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

export interface SetupInstallationStatus {
  protocolVersion: 1;
  installationId: string;
  state: "active" | "claimed" | "expired" | "purged";
  project: { id: string; organizationId: string } | null;
  credentialVersion: 0 | 1;
  capturePolicy: "metadata-only-v1";
  expiresAt: string | null;
  limits: { traces: 100; spans: 1000; bytes: 2097152 };
  usage: { traces: number; spans: number; bytes: number };
  claimUrl: string | null;
  endpoints: {
    otlp: "/api/v1/otlp/v1/traces";
    receipt: "/api/v1/traces/{traceId}/receipt";
  };
}

export interface SetupCredentialResult extends SetupInstallationStatus {
  credential: SetupStoredCredential & { capabilities: ["telemetry_write"] };
}

export interface SetupProbeEvidence {
  traceId: string;
  spanId: string;
  receipt: TraceReceipt;
}

/** @deprecated Use SetupInstallationStatus. Retained as an exported compatibility name. */
export type SetupBackendTrial = SetupInstallationStatus;
/** @deprecated Use SetupProbeEvidence. Retained as an exported compatibility name. */
export type SetupBackendReceipt = SetupProbeEvidence;
/** Account-claim state is represented by the installation status and its private claim URL. */
export type SetupBackendClaim =
  | { status: "required"; claimId: string; url: string }
  | { status: "completed"; claimId: string };

export class SetupBackendError extends Error {
  constructor(
    readonly code:
      | "invalid_origin"
      | "transport"
      | "invalid_response"
      | "unverified"
      | `SETUP_${string}`,
    message: string,
    readonly status?: number,
    readonly retryAfterMillis?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SetupBackendError";
  }
}

export interface SetupBackendAdapterOptions {
  projectRoot: string;
  origin?: string;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMillis?: number;
  receiptTimeoutMillis?: number;
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

function parseStatus(
  value: unknown,
  installationId: string,
  origin: string,
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
    "claimUrl",
    "endpoints",
  ];
  if (!exactKeys(value, credentialResponse ? [...keys, "credential"] : keys))
    throw new SetupBackendError("invalid_response", "Hue returned an invalid setup response.");
  const project = value.project;
  const limits = value.limits;
  const usage = value.usage;
  const endpoints = value.endpoints;
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
    endpoints.receipt !== "/api/v1/traces/{traceId}/receipt"
  )
    throw new SetupBackendError("invalid_response", "Hue returned an invalid setup response.");
  if (value.state === "active") {
    if (
      typeof value.claimUrl !== "string" ||
      value.expiresAt === null ||
      project === null ||
      value.credentialVersion !== 0
    )
      throw new SetupBackendError("invalid_response", "Hue returned an invalid setup response.");
    let claim: URL;
    try {
      claim = new URL(value.claimUrl);
    } catch {
      throw new SetupBackendError("invalid_response", "Hue returned an invalid setup response.");
    }
    if (
      claim.origin !== origin ||
      claim.username ||
      claim.password ||
      claim.pathname !== "/setup/claim" ||
      claim.search ||
      !/^#[A-Za-z0-9_-]{43}$/u.test(claim.hash)
    )
      throw new SetupBackendError("invalid_response", "Hue returned an invalid setup response.");
  } else if (value.claimUrl !== null) {
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
    claimUrl: value.claimUrl as string | null,
    endpoints: {
      otlp: "/api/v1/otlp/v1/traces",
      receipt: "/api/v1/traces/{traceId}/receipt",
    },
  };
}

function parseCredential(
  value: unknown,
  installationId: string,
  origin: string,
): SetupCredentialResult {
  const status = parseStatus(value, installationId, origin, true);
  if (!record(value) || !record(value.credential))
    throw new SetupBackendError(
      "invalid_response",
      "Hue returned an invalid setup credential response.",
    );
  const credential = value.credential;
  if (
    !exactKeys(credential, ["apiKey", "keyId", "capabilities", "version"]) ||
    typeof credential.apiKey !== "string" ||
    credential.apiKey.length === 0 ||
    credential.apiKey.length > 4096 ||
    /[\s\0]/u.test(credential.apiKey) ||
    !boundedId(credential.keyId) ||
    !Array.isArray(credential.capabilities) ||
    credential.capabilities.length !== 1 ||
    credential.capabilities[0] !== "telemetry_write" ||
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
      apiKey: credential.apiKey,
      keyId: credential.keyId as string,
      capabilities: ["telemetry_write"],
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

async function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("Setup interrupted"));
      },
      { once: true },
    );
  });
}

/** Real implementation of the frozen Setup HTTP protocol v1. */
export class SetupBackendAdapter {
  readonly origin: string;
  readonly store: FileSetupInstallationStore;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly requestTimeoutMillis: number;
  private readonly receiptTimeoutMillis: number;
  private installation?: SetupInstallationRecord;

  constructor(options: SetupBackendAdapterOptions) {
    this.origin = parseOrigin(options.origin ?? DEFAULT_ORIGIN);
    this.store = new FileSetupInstallationStore(options.projectRoot, this.origin);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMillis = options.requestTimeoutMillis ?? 10_000;
    this.receiptTimeoutMillis = options.receiptTimeoutMillis ?? 10_000;
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
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal?.aborted) throw signal.reason;
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
        if (signal?.aborted) throw signal.reason;
        lastError = error;
        if (attempt + 1 < attempts) {
          await pause(250 * 2 ** attempt, signal);
          continue;
        }
      }
    }
    throw new SetupBackendError(
      "transport",
      "Hue setup could not reach the configured origin.",
      undefined,
      undefined,
      { cause: lastError },
    );
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
    return parseStatus(value, installation.installationId, this.origin);
  }

  async status(signal?: AbortSignal): Promise<SetupInstallationStatus> {
    const installation = await this.prepare();
    const value = await this.request(
      "GET",
      `/api/v1/setup/installations/${installation.installationId}`,
      undefined,
      3,
      signal,
    );
    return parseStatus(value, installation.installationId, this.origin);
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
    const result = parseCredential(value, installation.installationId, this.origin);
    if (result.credential.version !== credentialVersion)
      throw new SetupBackendError(
        "invalid_response",
        "Hue returned a credential generation different from the requested generation.",
      );
    installation.credential = {
      apiKey: result.credential.apiKey,
      keyId: result.credential.keyId,
      version: result.credential.version,
    };
    if (installation.probe?.credentialVersion !== credentialVersion) delete installation.probe;
    await this.store.save(installation);
    return result;
  }

  async configure(project: SetupProjectDetection): Promise<SetupFileChange[]> {
    const installation = await this.prepare();
    if (!installation.credential) throw new Error("Setup credential is not available");
    return configureSetupProject(this.store, installation, project);
  }

  async preflight(project: SetupProjectDetection): Promise<void> {
    const installation = await this.prepare();
    await validateSetupConfiguration(this.store, installation, project);
  }

  private async verifyStoredProbe(signal?: AbortSignal): Promise<SetupProbeEvidence | undefined> {
    if (signal?.aborted) throw signal.reason;
    const installation = await this.prepare();
    const credential = installation.credential;
    const probe = installation.probe;
    if (!credential || !probe || probe.credentialVersion !== credential.version) return undefined;
    const hue = createHue({
      apiKey: credential.apiKey,
      baseUrl: this.origin,
      serviceName: "hue-setup-probe",
      captureContent: false,
      timeoutMillis: this.requestTimeoutMillis,
    });
    try {
      const verification = await hue.verifyTrace(probe.traceId, {
        expectedSpanIds: [probe.spanId],
        timeoutMillis: this.receiptTimeoutMillis,
      });
      if (signal?.aborted) throw signal.reason;
      if (!verification.verified || !verification.receipt) return undefined;
      const receipt = verification.receipt;
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
    } finally {
      await hue.shutdownSafe({ timeoutMillis: this.requestTimeoutMillis });
    }
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
    if (signal?.aborted) throw signal.reason;
    return this.verifyStoredProbe(signal);
  }

  /** Confirms a superseded telemetry key cannot read the newly verified receipt. */
  async verifyRevokedCredential(
    oldApiKey: string,
    evidence: SetupProbeEvidence,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = new URL(`/api/v1/traces/${evidence.traceId}/receipt`, this.origin);
    url.searchParams.set("expectedSpanId", evidence.spanId);
    const response = await this.fetcher(url, {
      headers: { Authorization: `Bearer ${oldApiKey}`, Accept: "application/json" },
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMillis)])
        : AbortSignal.timeout(this.requestTimeoutMillis),
    });
    await response.body?.cancel();
    if (response.status !== 401)
      throw new SetupBackendError(
        "unverified",
        "The superseded anonymous key was not confirmed revoked.",
      );
  }
}
