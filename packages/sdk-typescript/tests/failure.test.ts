import { describe, expect, test } from "bun:test";
import { APICallError, RetryError } from "ai";
import { HueConnectionError } from "../src/client.js";
import { HueEnvironmentError } from "../src/environment/client.js";
import { HueApiError } from "../src/evals/client.js";
import { serviceFailureCause, serviceFailureType } from "../src/evals/failure.js";
import { OutputFileError } from "../src/evals/files.js";

// The shapes of the OpenAI and Anthropic SDK errors: classes that never set `name`, with the
// HTTP status on `status`, the response's `headers`, and connection failures as
// `APIConnectionError`.
class APIError extends Error {
  readonly headers: Record<string, string> = {};
  constructor(readonly status?: number) {
    super(status ? `${status} status code` : "Connection error.");
  }
}
class APIConnectionError extends APIError {}
class APIConnectionTimeoutError extends APIConnectionError {}
class OverloadedError extends APIError {
  constructor() {
    super(529);
  }
}

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });
// The shape of the MCP TypeScript SDK's transport errors: the HTTP status as `code`, the body
// the server answered quoted in the message, and no response.
class StreamableHTTPError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(`Streamable HTTP error: ${message}`);
  }
}
class SseError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(`SSE error: ${message}`);
  }
}
/** What Hue's gateway answers a refused call: the diagnostic in the body and the header. */
const gatewayBody = (diagnostic: string, error = "Simulation gateway request failed") =>
  JSON.stringify({ error, diagnostic });
const gatewayPost = (status: number, diagnostic: string) =>
  new StreamableHTTPError(status, `Error POSTing to endpoint: ${gatewayBody(diagnostic)}`);
const refused = () => withCode("connect ECONNREFUSED 127.0.0.1:443", "ECONNREFUSED");
const callError = (statusCode?: number) =>
  new APICallError({
    message: statusCode ? `HTTP ${statusCode}` : "Cannot connect to API",
    url: "https://api.provider.test/v1/responses",
    requestBodyValues: {},
    statusCode,
    ...(statusCode ? {} : { cause: new TypeError("fetch failed", { cause: refused() }) }),
  });
/** `error` wrapped in `links` ordinary errors, each the `cause` of the next. */
const wrapped = (error: unknown, links: number) => {
  let outer = error;
  for (let index = 0; index < links; index++)
    outer = new Error(`wrapper ${index}`, { cause: outer });
  return outer;
};

describe("service failures a target's throw shows", () => {
  test("Hue's own clients: no response is a failed connection, a retryable status a refusal", () => {
    for (const error of [
      new HueEnvironmentError(),
      new HueApiError(),
      new HueConnectionError("Unable to connect to Hue; check the endpoint and network"),
    ])
      expect(serviceFailureType(error)).toBe("ConnectionFailed");
    for (const error of [
      new HueEnvironmentError(503),
      new HueEnvironmentError(429, 1000),
      new HueApiError(502),
      new HueApiError(408),
      new HueConnectionError("Hue rejected the project connection", 504),
    ])
      expect(serviceFailureType(error)).toBe("ServiceRefused");
    // Any other status Hue answered (a missing gateway, a bad key, a world or version it refused)
    // is the caller's configuration: Hue's own clients never show the agent's error.
    for (const error of [
      new HueEnvironmentError(409, undefined, "simulation_gateway_required"),
      new HueEnvironmentError(400),
      new HueApiError(404),
      new HueApiError(422),
      new HueConnectionError("Hue rejected the project connection", 401),
      new HueConnectionError("Hue rejected the project connection", 403),
    ])
      expect(serviceFailureType(error)).toBe("ConfigurationRejected");
    // A redirect the configured endpoint answered is the endpoint's configuration too; the
    // TypeScript clients fetch with `redirect: "error"`, so one surfaces without a status, as a
    // failed connection, but the rule holds for a status that does arrive.
    expect(serviceFailureType(new HueApiError(302))).toBe("ConfigurationRejected");
    // Through a chain, and only from Hue's clients: another service's 4xx stays the agent's.
    expect(serviceFailureType(wrapped(new HueApiError(404), 3))).toBe("ConfigurationRejected");
    expect(serviceFailureType(new APIError(404))).toBeNull();
    expect(serviceFailureType(callError(401))).toBeNull();
  });

  test("timeouts are TimedOut, including a connection timeout", async () => {
    const signal = AbortSignal.timeout(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signal.reason).toBeInstanceOf(DOMException);
    for (const error of [
      signal.reason,
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      new APIConnectionTimeoutError(),
      Object.assign(new Error("Request timed out."), { name: "APITimeoutError" }),
    ])
      expect(serviceFailureType(error)).toBe("TimedOut");
  });

  test("connection-level failures are ConnectionFailed", () => {
    for (const code of [
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EPIPE",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "UND_ERR_SOCKET",
    ])
      expect(serviceFailureType(withCode(`request failed: ${code}`, code))).toBe(
        "ConnectionFailed",
      );
    // Node's fetch, with and without the socket error it carries.
    expect(serviceFailureType(new TypeError("fetch failed", { cause: refused() }))).toBe(
      "ConnectionFailed",
    );
    expect(serviceFailureType(new TypeError("fetch failed"))).toBe("ConnectionFailed");
    expect(serviceFailureType(new APIConnectionError())).toBe("ConnectionFailed");
    // The AI SDK wraps a failed fetch in an APICallError without a status.
    expect(serviceFailureType(callError())).toBe("ConnectionFailed");
    expect(serviceFailureType(new TypeError("Cannot read properties of undefined"))).toBeNull();
    expect(serviceFailureType(withCode("ENOENT: no such file", "ENOENT"))).toBeNull();
  });

  test("retryable refusals are ServiceRefused, through the AI SDK's retries too", () => {
    for (const status of [408, 429, 500, 502, 503, 504, 529, 599])
      expect(serviceFailureType(new APIError(status))).toBe("ServiceRefused");
    expect(serviceFailureType(new OverloadedError())).toBe("ServiceRefused");
    expect(serviceFailureType(callError(503))).toBe("ServiceRefused");
    // A RetryError carries its attempts in `errors` and the last one in `lastError`.
    const retried = new RetryError({
      message: "Failed after 3 attempts. Last error: HTTP 529",
      reason: "maxRetriesExceeded",
      errors: [callError(500), callError(429), callError(529)],
    });
    expect(serviceFailureType(retried)).toBe("ServiceRefused");
    expect(
      serviceFailureType(
        Object.assign(new Error("Failed after 2 attempts"), { lastError: callError(502) }),
      ),
    ).toBe("ServiceRefused");
    expect(
      serviceFailureType(
        Object.assign(new Error("Failed"), { errors: [new Error("a"), callError(500)] }),
      ),
    ).toBe("ServiceRefused");
    for (const status of [400, 401, 403, 404, 409, 422, 600])
      expect(serviceFailureType(new APIError(status))).toBeNull();
    expect(serviceFailureType(callError(400))).toBeNull();
    expect(serviceFailureType(Object.assign(new Error("HTTP 503"), { status: "503" }))).toBeNull();
    // A status alone, with no exchange it came from, is the agent's own error.
    expect(
      serviceFailureType(Object.assign(new Error("The agent's 503"), { status: 503 })),
    ).toBeNull();
    expect(
      serviceFailureType(Object.assign(new Error("The agent's 429"), { statusCode: 429 })),
    ).toBeNull();
  });

  test("an MCP transport error carries the status the simulated server answered: a 5xx is ServiceRefused, a 4xx the agent's", () => {
    // The MCP SDK throws the status as `code` with no response; the transport is the exchange.
    expect(serviceFailureType(gatewayPost(503, "authorization_unavailable"))).toBe(
      "ServiceRefused",
    );
    expect(serviceFailureType(gatewayPost(503, "gateway_failure"))).toBe("ServiceRefused");
    expect(serviceFailureType(new SseError(503, "Failed to open SSE stream"))).toBe(
      "ServiceRefused",
    );
    expect(serviceFailureType(wrapped(gatewayPost(429, "rate_limited"), 2))).toBe("ServiceRefused");
    // A bad world token, an unknown route or a refused operation is the agent's own error.
    for (const status of [400, 401, 403, 404, 409])
      expect(serviceFailureType(gatewayPost(status, "invalid_token"))).toBeNull();
    // A `code` that is no status, or on an error that is no transport's, names nothing.
    expect(serviceFailureType(new StreamableHTTPError(NaN, "no status"))).toBeNull();
    expect(serviceFailureType(Object.assign(new Error("HTTP 503"), { code: 503 }))).toBeNull();
  });

  test("everything else is the agent's own error", () => {
    for (const error of [
      new Error("The agent could not draft a reply"),
      new OutputFileError("Generated file missing.docx could not be read"),
      new RangeError("Invalid array length"),
      new DOMException("The operation was aborted.", "AbortError"),
      "a thrown string",
      undefined,
      null,
      { status: 400 },
    ])
      expect(serviceFailureType(error)).toBeNull();
  });
});

describe("the service's own word for what failed", () => {
  test("Hue's gateway diagnostic is read from the header, the body, an MCP transport error's message or Hue's own client", () => {
    // A fetch `Response`, with the header Hue's gateway sets.
    const response = new Response(gatewayBody("authorization_unavailable"), {
      status: 503,
      headers: { "x-hue-diagnostic": "authorization_unavailable" },
    });
    expect(serviceFailureCause(Object.assign(new Error("503"), { response }))).toBe(
      "authorization_unavailable",
    );
    // The OpenAI and Anthropic SDKs' `headers`, a record; the AI SDK's `responseHeaders` and
    // `responseBody`.
    expect(
      serviceFailureCause(
        Object.assign(new APIError(503), { headers: { "X-Hue-Diagnostic": "gateway_failure" } }),
      ),
    ).toBe("gateway_failure");
    expect(
      serviceFailureCause(
        new APICallError({
          message: "HTTP 503",
          url: "https://sim.hue.test/api/sim/slack.com/api/chat.postMessage",
          requestBodyValues: {},
          statusCode: 503,
          responseHeaders: { "x-hue-diagnostic": "authorization_unavailable" },
        }),
      ),
    ).toBe("authorization_unavailable");
    expect(
      serviceFailureCause(
        new APICallError({
          message: "HTTP 503",
          url: "https://sim.hue.test/api/sim/slack.com/api/chat.postMessage",
          requestBodyValues: {},
          statusCode: 503,
          responseBody: gatewayBody("authorization_unavailable"),
        }),
      ),
    ).toBe("authorization_unavailable");
    // The MCP SDK's transport quotes the body in its message: Hue's REST refusal names the
    // diagnostic at the top, its MCP refusal (a JSON-RPC error) in `error.data`.
    expect(serviceFailureCause(gatewayPost(503, "authorization_unavailable"))).toBe(
      "authorization_unavailable",
    );
    expect(
      serviceFailureCause(
        new StreamableHTTPError(
          503,
          'Error POSTing to endpoint: {"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Internal error","data":{"diagnostic":"authorization_unavailable"}}}',
        ),
      ),
    ).toBe("authorization_unavailable");
    // Hue's own clients read the header into `diagnostic`.
    expect(
      serviceFailureCause(new HueEnvironmentError(409, undefined, "simulation_gateway_required")),
    ).toBe("simulation_gateway_required");
    expect(serviceFailureCause(new HueApiError(503, 2, "store_unavailable"))).toBe(
      "store_unavailable",
    );
    // Through a chain, nearest first.
    expect(serviceFailureCause(wrapped(gatewayPost(503, "authorization_unavailable"), 3))).toBe(
      "authorization_unavailable",
    );
  });

  test("an answer that names no diagnostic, or names one that is no token, has no cause", () => {
    expect(serviceFailureCause(new APIError(503))).toBeUndefined();
    expect(serviceFailureCause(callError(503))).toBeUndefined();
    expect(serviceFailureCause(new HueApiError(502))).toBeUndefined();
    expect(
      serviceFailureCause(
        new StreamableHTTPError(503, "Error POSTing to endpoint: Service Unavailable"),
      ),
    ).toBeUndefined();
    expect(
      serviceFailureCause(new StreamableHTTPError(503, "Error POSTing to endpoint: {not json")),
    ).toBeUndefined();
    // Only an MCP transport error's message is read as a body: an agent's own error quoting one
    // names nothing.
    expect(
      serviceFailureCause(new Error(`refused: ${gatewayBody("authorization_unavailable")}`)),
    ).toBeUndefined();
    for (const diagnostic of ["Not A Token", "a".repeat(65), "", "x-y", "gateway_failure\n"])
      expect(
        serviceFailureCause(
          Object.assign(new Error("503"), { headers: { "x-hue-diagnostic": diagnostic } }),
        ),
      ).toBeUndefined();
    expect(serviceFailureCause(withCode("connect ECONNREFUSED", "ECONNREFUSED"))).toBeUndefined();
    expect(serviceFailureCause(undefined)).toBeUndefined();
    // A property that throws when read names nothing.
    const hostile = new Error("hostile");
    Object.defineProperty(hostile, "headers", {
      get() {
        throw new Error("no");
      },
    });
    expect(serviceFailureCause(hostile)).toBeUndefined();
  });
});

describe("service failure chains", () => {
  test("causes, aggregate errors and retry attempts are walked, six links deep", () => {
    expect(serviceFailureType(wrapped(new HueApiError(503), 6))).toBe("ServiceRefused");
    expect(serviceFailureType(wrapped(new HueApiError(503), 7))).toBeNull();
    expect(serviceFailureType(new AggregateError([new Error("a"), refused()], "both failed"))).toBe(
      "ConnectionFailed",
    );
    expect(
      serviceFailureType(
        wrapped(
          new RetryError({
            message: "Failed after 2 attempts",
            reason: "maxRetriesExceeded",
            errors: [new Error("a"), new DOMException("timed out", "TimeoutError")],
          }),
          2,
        ),
      ),
    ).toBe("TimedOut");
  });

  test("the most specific signal wins: a timeout, then a failed connection, then a refusal, then Hue's rejection", () => {
    const signals = {
      TimedOut: () => new DOMException("timed out", "TimeoutError"),
      ConnectionFailed: refused,
      ServiceRefused: () => new APIError(503),
      ConfigurationRejected: () => new HueEnvironmentError(409, undefined, "world_not_live"),
    };
    const order = Object.keys(signals) as (keyof typeof signals)[];
    order.forEach((expected, index) => {
      const present = order.slice(index).map((name) => signals[name]());
      expect(serviceFailureType(new AggregateError(present, "several"))).toBe(expected);
      expect(
        serviceFailureType(new Error("agent", { cause: new AggregateError(present.toReversed()) })),
      ).toBe(expected);
    });
  });

  test("cycles end, and an error that throws when read shows nothing but hides nothing", () => {
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    Object.assign(first, { cause: second });
    expect(serviceFailureType(first)).toBeNull();
    Object.assign(first, { errors: [first, second, refused()] });
    expect(serviceFailureType(second)).toBe("ConnectionFailed");
    const hostile = new Proxy(new Error("hostile"), {
      get() {
        throw new Error("no reads");
      },
    });
    expect(serviceFailureType(hostile)).toBeNull();
    expect(serviceFailureType(new Error("wraps", { cause: hostile }))).toBeNull();
    expect(serviceFailureType(Object.assign(new HueApiError(503), { cause: hostile }))).toBe(
      "ServiceRefused",
    );
    expect(serviceFailureType(new AggregateError([hostile, new APIError(429)]))).toBe(
      "ServiceRefused",
    );
  });
});

describe("timeouts by code and refusals by the response's own status", () => {
  test("a Node or Undici timeout code is a timeout, not a failed connection", () => {
    for (const code of [
      "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
    ])
      expect(
        serviceFailureType(new TypeError("fetch failed", { cause: withCode(code, code) })),
      ).toBe("TimedOut");
    expect(serviceFailureType(withCode("socket hang up", "ECONNRESET"))).toBe("ConnectionFailed");
  });
  test("a retryable status on the error's response alone is a refusal", () => {
    const answered = (status: number) =>
      Object.assign(new Error(`HTTP ${status}`), { response: new Response(null, { status }) });
    expect(serviceFailureType(answered(429))).toBe("ServiceRefused");
    expect(serviceFailureType(answered(503))).toBe("ServiceRefused");
    expect(serviceFailureType(answered(400))).toBeNull();
    expect(
      serviceFailureType(Object.assign(new Error("HTTP 502"), { response: { statusCode: 502 } })),
    ).toBe("ServiceRefused");
  });
});
