import type {
  HueOptions,
  TraceReceipt,
  TraceReceiptField,
  TraceVerification,
  VerifyTraceOptions,
} from "./types.js";

const fields: TraceReceiptField[] = ["input", "output", "model", "usage", "session"];
const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Thrown by {@link HueClient.verifyTrace} when verification cannot proceed: denied key, unsupported
 * or refusing server, unreachable network or an invalid receipt. A timeout is not an error; it
 * returns `verified: false`.
 */
export class HueTraceVerificationError extends Error {
  constructor(
    /** Safe failure class for branching without parsing the message. */
    readonly code: "authentication" | "http" | "invalid_response" | "transport",
    message: string,
    /** HTTP status when Hue answered. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "HueTraceVerificationError";
  }
}

function invalidResponse(): never {
  throw new HueTraceVerificationError(
    "invalid_response",
    "Hue returned an invalid trace receipt. Check the server and SDK versions.",
  );
}

function validId(value: unknown, length: number): value is string {
  return (
    typeof value === "string" &&
    value.length === length &&
    new RegExp(`^[0-9a-f]{${length}}$`).test(value) &&
    !/^0+$/.test(value)
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseReceipt(
  value: unknown,
  traceId: string,
  expected: string[],
  origin: string,
): TraceReceipt {
  if (
    !record(value) ||
    value.traceId !== traceId ||
    !Number.isSafeInteger(value.spanCount) ||
    (value.spanCount as number) < 0 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !record(value.fields) ||
    fields.some((field) => typeof (value.fields as Record<string, unknown>)[field] !== "boolean") ||
    typeof value.traceUrl !== "string" ||
    value.traceUrl.length > 2048
  )
    invalidResponse();
  let traceUrl: URL;
  try {
    traceUrl = new URL(value.traceUrl as string);
  } catch {
    invalidResponse();
  }
  if (traceUrl!.origin !== origin || traceUrl!.username || traceUrl!.password) invalidResponse();
  const matched = value.matchedSpanIds,
    missing = value.missingSpanIds;
  if (
    !Array.isArray(matched) ||
    !Array.isArray(missing) ||
    matched.length + missing.length !== expected.length ||
    [...matched, ...missing].some((id) => !validId(id, 16) || !expected.includes(id)) ||
    new Set([...matched, ...missing]).size !== expected.length ||
    matched.length > (value.spanCount as number)
  )
    invalidResponse();
  // Return only the documented fields, never arbitrary response content.
  return {
    traceId,
    spanCount: value.spanCount as number,
    revision: value.revision as number,
    fields: Object.fromEntries(
      fields.map((field) => [field, (value.fields as Record<string, boolean>)[field]]),
    ) as TraceReceipt["fields"],
    matchedSpanIds: expected.filter((id) => matched.includes(id)),
    missingSpanIds: expected.filter((id) => missing.includes(id)),
    traceUrl: traceUrl!.href,
  };
}

async function readJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    invalidResponse();
  }
  const reader = response.body?.getReader();
  if (!reader) invalidResponse();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader!.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader!.cancel();
        invalidResponse();
      }
      chunks.push(next.value);
    }
  } finally {
    reader!.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    invalidResponse();
  }
}

function retryDelay(value: string | null): number {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

async function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Observe persisted evidence after the application and its exporter have finished. */
export async function verifyTrace(
  connection: Pick<HueOptions, "apiKey"> & { baseUrl: string },
  traceId: string,
  options: VerifyTraceOptions = {},
): Promise<TraceVerification> {
  if (!validId(traceId, 32))
    throw new TypeError("traceId must be a nonzero lowercase 32-character OpenTelemetry trace ID");
  if (options === null || typeof options !== "object" || Array.isArray(options))
    throw new TypeError("Trace verification options must be an object");
  const expected = options.expectedSpanIds === undefined ? [] : options.expectedSpanIds;
  if (
    !Array.isArray(expected) ||
    expected.length > 100 ||
    expected.some((id) => !validId(id, 16)) ||
    new Set(expected).size !== expected.length
  )
    throw new TypeError(
      "expectedSpanIds must contain at most 100 unique nonzero lowercase 16-character span IDs",
    );
  const required = options.requiredFields === undefined ? [] : options.requiredFields;
  if (
    !Array.isArray(required) ||
    required.some((field) => !fields.includes(field)) ||
    new Set(required).size !== required.length
  )
    throw new TypeError(
      "requiredFields must contain unique receipt field names: input, output, model, usage, session",
    );
  const timeout = options.timeoutMillis === undefined ? 10_000 : options.timeoutMillis;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60_000)
    throw new TypeError("timeoutMillis must be greater than zero and at most 60000");
  // Snapshot caller arrays so concurrent mutation cannot alter the verification criteria.
  const expectedIds = [...expected],
    requiredFields = [...required];
  const url = new URL(`/api/v1/traces/${traceId}/receipt`, connection.baseUrl);
  for (const id of expectedIds) url.searchParams.append("expectedSpanId", id);
  const controller = new AbortController();
  const deadline = performance.now() + timeout;
  const timer = setTimeout(() => controller.abort(), timeout);
  let receipt: TraceReceipt | null = null;
  let delay = 250;
  try {
    while (!controller.signal.aborted && performance.now() < deadline) {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${connection.apiKey}`, Accept: "application/json" },
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
      });
      let retryAfter = 0;
      if (response.status === 200) {
        receipt = parseReceipt(await readJson(response), traceId, expectedIds, url.origin);
        if (
          !controller.signal.aborted &&
          performance.now() < deadline &&
          receipt.missingSpanIds.length === 0 &&
          requiredFields.every((field) => receipt!.fields[field])
        )
          return { verified: true, receipt };
      } else if (response.status === 404) {
        const body = await readJson(response);
        if (!record(body) || body.code !== "TRACE_NOT_FOUND")
          throw new HueTraceVerificationError(
            "http",
            "This Hue server does not support trace receipts. Check the server version and baseUrl.",
            404,
          );
      } else {
        await response.body?.cancel();
        if (response.status === 429 || response.status === 503) {
          retryAfter = retryDelay(response.headers.get("retry-after"));
        } else if (response.status === 401 || response.status === 403) {
          throw new HueTraceVerificationError(
            "authentication",
            "Hue denied trace verification. Check the project key, its access, and expiration.",
            response.status,
          );
        } else {
          throw new HueTraceVerificationError(
            "http",
            "Hue refused trace verification. Check the server version and configured origin; redirects are not followed.",
            response.status,
          );
        }
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      const wait = Math.max(delay, retryAfter);
      await pause(Math.min(wait, remaining), controller.signal);
      // A truncated backoff exhausts this call even if a timer wakes just early.
      if (wait >= remaining) break;
      delay = Math.min(delay * 2, 1000);
    }
  } catch (error) {
    if (!controller.signal.aborted && performance.now() < deadline) {
      if (error instanceof HueTraceVerificationError) throw error;
      throw new HueTraceVerificationError(
        "transport",
        "Hue trace verification could not reach the server. Check the network and configured origin.",
      );
    }
  } finally {
    clearTimeout(timer);
  }
  return { verified: false, receipt };
}
