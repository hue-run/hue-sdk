import { HueConnectionError } from "../client.js";
import { HueEnvironmentError } from "../environment/client.js";
import { HueApiError } from "./client.js";

/**
 * What a target's throw shows about a service the agent called, when a service rather than the
 * agent's own code stopped it: `ServiceRefused` for a retryable HTTP status (408, 429 or 5xx) a
 * model provider, Hue or another service answered with, such as a rate limit or an outage;
 * `ConnectionFailed` for a connection that failed; `TimedOut` for a call that timed out; and
 * `ConfigurationRejected` for any other status Hue's own clients answered with (a 4xx: a key, a
 * project, an environment version or a world Hue refused), which is the caller's configuration;
 * the clients fetch with `redirect: "error"`, so a redirect surfaces without a status, as a
 * failed connection.
 * The runner records the type on the execution in place of `TargetError`; Hue classes the first
 * three as infrastructure and the last as configuration, so an error from Hue's own clients is
 * never filed as the agent's. Anything else is the agent's own error.
 *
 * A simulated world the agent reaches through its own client (an MCP client, a REST client, a
 * fetch) answers Hue's gateway refusals with a status and a diagnostic: `503
 * authorization_unavailable` when Hue could not authorize the world token because its database
 * could not answer, `503 gateway_failure` when the gateway failed. The MCP SDK's transport throws
 * these as `StreamableHTTPError` or `SseError` with the status as `code` and no response, so the
 * status is read from there too; the diagnostic is the error's cause (`serviceFailureCause`),
 * recorded beside the type so a run's reader sees what refused it.
 */
export type ServiceFailureType =
  | "ServiceRefused"
  | "ConnectionFailed"
  | "TimedOut"
  | "ConfigurationRejected";

const TIMEOUT_NAMES = new Set(["TimeoutError", "APIConnectionTimeoutError", "APITimeoutError"]);
/** Node's and Undici's codes for a call that timed out, connecting or waiting on the answer. */
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
]);
/** Links followed from the thrown error, and errors read at most. */
const MAX_DEPTH = 6;
const MAX_ERRORS = 64;

/** The errors an error links to: its `cause`, and the `errors` and `lastError` of an
 * `AggregateError` or a retry error. A property that throws when read links nothing. */
function links(error: object): unknown[] {
  try {
    const { cause, lastError, errors } = error as Record<string, unknown>;
    return [cause, lastError, ...(Array.isArray(errors) ? errors.slice(0, MAX_ERRORS) : [])];
  } catch {
    return [];
  }
}

/** The thrown error and every error within `MAX_DEPTH` links of it, each once, so a cycle ends
 * the walk. */
function linked(error: unknown): object[] {
  const found: object[] = [];
  const seen = new Set<object>();
  let level: unknown[] = [error];
  for (let depth = 0; depth <= MAX_DEPTH && level.length; depth++) {
    const next: unknown[] = [];
    for (const item of level) {
      if (typeof item !== "object" || item === null || seen.has(item)) continue;
      if (found.length === MAX_ERRORS) return found;
      seen.add(item);
      found.push(item);
      next.push(...links(item));
    }
    level = next;
  }
  return found;
}

/** The error's `name` and its class names, since some SDKs never set `name`. */
function names(error: object): string[] {
  const found: string[] = [];
  const name = (error as { name?: unknown }).name;
  if (typeof name === "string") found.push(name);
  let prototype: unknown = Object.getPrototypeOf(error);
  for (let depth = 0; depth < MAX_DEPTH && prototype; depth++) {
    const constructor = (prototype as { constructor?: { name?: unknown } }).constructor;
    if (typeof constructor?.name === "string") found.push(constructor.name);
    prototype = Object.getPrototypeOf(prototype);
  }
  return found;
}

/** The MCP TypeScript SDK's transport errors, which carry the HTTP status as `code` and no
 * response: a POST the server answered with a failing status (`StreamableHTTPError`) or an SSE
 * stream it refused (`SseError`). Recognized by class name, never imported. */
const MCP_TRANSPORT_NAMES = new Set(["StreamableHTTPError", "SseError"]);
/** The status an MCP transport error carries, or undefined for any other error. */
function transportStatus(error: object): number | undefined {
  const { code } = error as { code?: unknown };
  return typeof code === "number" && names(error).some((name) => MCP_TRANSPORT_NAMES.has(name))
    ? code
    : undefined;
}

const retryable = (status: unknown) =>
  typeof status === "number" &&
  (status === 408 || status === 429 || (status >= 500 && status < 600));
function timedOut(error: object) {
  const { code } = error as { code?: unknown };
  return (
    (typeof code === "string" && TIMEOUT_CODES.has(code)) ||
    names(error).some((name) => TIMEOUT_NAMES.has(name))
  );
}
/** An error one of Hue's own clients threw, which carries the status Hue answered or none. */
function hueClientError(
  error: object,
): error is HueConnectionError | HueEnvironmentError | HueApiError {
  return (
    error instanceof HueConnectionError ||
    error instanceof HueEnvironmentError ||
    error instanceof HueApiError
  );
}
function disconnected(error: object) {
  // Hue's clients report a request that got no usable response without a status.
  if (hueClientError(error) && error.status === undefined) return true;
  const { code, message } = error as { code?: unknown; message?: unknown };
  const classes = names(error);
  return (
    (typeof code === "string" && NETWORK_CODES.has(code)) ||
    classes.includes("APIConnectionError") ||
    (classes.includes("TypeError") && message === "fetch failed")
  );
}
/** A retryable status a service answered with: on Hue's own clients, or on an error that also
 * carries the exchange it came from (the OpenAI and Anthropic SDKs' `headers`, the AI SDK's
 * `url` or `responseHeaders`, a fetch `response`), so an agent's own error that only names a
 * status stays the agent's. */
function refused(error: object) {
  if (hueClientError(error)) return retryable(error.status);
  // An MCP transport error is the exchange itself: the server answered the status it carries.
  if (retryable(transportStatus(error))) return true;
  const { status, statusCode, headers, response, url, responseHeaders } = error as {
    status?: unknown;
    statusCode?: unknown;
    headers?: unknown;
    response?: unknown;
    url?: unknown;
    responseHeaders?: unknown;
  };
  const exchanged = [headers, response, url, responseHeaders].some(
    (item) => item !== undefined && item !== null,
  );
  // A fetch `Response` carries the status itself.
  const answered =
    response !== null && typeof response === "object"
      ? (response as { status?: unknown; statusCode?: unknown })
      : {};
  return (
    exchanged &&
    (retryable(status) ||
      retryable(statusCode) ||
      retryable(answered.status) ||
      retryable(answered.statusCode))
  );
}
/** A status Hue's own client answered with that is neither a success nor retryable, a 3xx or a
 * 4xx: Hue refused the caller's key, project, environment version or world, so the case could
 * not run as configured. The clients fetch with `redirect: "error"`, so a redirect reaches here
 * only as a status some caller constructed; a real one surfaces without a status, as a failed
 * connection. Only Hue's clients show it; another service's 4xx stays the agent's. */
function rejected(error: object) {
  const { status } = error as { status?: unknown };
  return (
    hueClientError(error) &&
    typeof status === "number" &&
    status >= 300 &&
    status < 500 &&
    !retryable(status)
  );
}
/** Whether any error shows the signal; one whose properties throw when read shows none. */
const any = (errors: object[], signal: (error: object) => boolean) =>
  errors.some((error) => {
    try {
      return signal(error);
    } catch {
      return false;
    }
  });

/** The service failure a target's throw shows, by the errors linked from it, in precedence
 * order: a timeout, a failed connection, a retryable refusal, a status Hue's own client was
 * refused with; null for the agent's own error. */
export function serviceFailureType(error: unknown): ServiceFailureType | null {
  const errors = linked(error);
  if (any(errors, timedOut)) return "TimedOut";
  if (any(errors, disconnected)) return "ConnectionFailed";
  if (any(errors, refused)) return "ServiceRefused";
  if (any(errors, rejected)) return "ConfigurationRejected";
  return null;
}

/** The header Hue's gateway names its diagnostic in, beside the JSON body's `diagnostic`. */
const DIAGNOSTIC_HEADER = "x-hue-diagnostic";
/** A diagnostic's spelling: a short lower-case token (`authorization_unavailable`). */
const DIAGNOSTIC = /^[a-z][a-z0-9_]{0,63}$/;
/** The most of a body or message read for a diagnostic. */
const MAX_BODY = 8192;

/** A header's value from a `Headers`, a record of names to values (case-insensitive), or a
 * record of names to arrays, as the HTTP clients spell them; undefined otherwise. */
function headerValue(headers: unknown, name: string): string | undefined {
  if (headers === null || typeof headers !== "object") return undefined;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === "function") {
    const value: unknown = get.call(headers, name);
    return typeof value === "string" ? value : undefined;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== name) continue;
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

/** The `diagnostic` a JSON body names: an object's, or the object a string carries from its
 * first brace (an MCP transport error's message quotes the body it was answered). */
function bodyDiagnostic(body: unknown): string | undefined {
  if (typeof body === "string") {
    const start = body.indexOf("{");
    if (start < 0 || body.length - start > MAX_BODY) return undefined;
    try {
      return bodyDiagnostic(JSON.parse(body.slice(start)));
    } catch {
      return undefined;
    }
  }
  if (body === null || typeof body !== "object") return undefined;
  const { diagnostic } = body as { diagnostic?: unknown };
  return typeof diagnostic === "string" ? diagnostic : undefined;
}

/** The diagnostic one error carries: the one it names itself (Hue's own clients read the header
 * into `diagnostic`), else the header on its `headers`, `responseHeaders` or `response.headers`,
 * else the body on its `responseBody`, `body` or, for an MCP transport error, its message. */
function diagnosticOf(error: object): string | undefined {
  const { diagnostic, headers, responseHeaders, response, responseBody, body, message } = error as {
    diagnostic?: unknown;
    headers?: unknown;
    responseHeaders?: unknown;
    response?: unknown;
    responseBody?: unknown;
    body?: unknown;
    message?: unknown;
  };
  const answered =
    response !== null && typeof response === "object"
      ? (response as { headers?: unknown }).headers
      : undefined;
  return (
    (typeof diagnostic === "string" ? diagnostic : undefined) ??
    headerValue(headers, DIAGNOSTIC_HEADER) ??
    headerValue(responseHeaders, DIAGNOSTIC_HEADER) ??
    headerValue(answered, DIAGNOSTIC_HEADER) ??
    bodyDiagnostic(responseBody) ??
    bodyDiagnostic(body) ??
    (transportStatus(error) !== undefined ? bodyDiagnostic(message) : undefined)
  );
}

/**
 * The service's own word for what failed, when the answer a target's throw carries names one:
 * Hue's gateway diagnostic (`authorization_unavailable`, `gateway_failure`), read from the
 * `x-hue-diagnostic` header or the JSON body's `diagnostic` of any error linked from the throw,
 * nearest first. Undefined when no answer names one, or the name is not a diagnostic's token.
 * Read for a service failure (`serviceFailureType`), where the runner records it as the error's
 * `cause`.
 */
export function serviceFailureCause(error: unknown): string | undefined {
  for (const item of linked(error)) {
    try {
      const diagnostic = diagnosticOf(item);
      if (diagnostic !== undefined && DIAGNOSTIC.test(diagnostic)) return diagnostic;
    } catch {
      // A property that throws when read names nothing.
    }
  }
  return undefined;
}
