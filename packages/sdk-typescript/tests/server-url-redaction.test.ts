import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { SpanKind, type SpanKind as SpanKindValue } from "@opentelemetry/api";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { describe, expect, test } from "bun:test";
import { createHueTransport, type HueOptions } from "../src/index.js";
import { apiKey, attr, receiver, type WireRecord } from "./sdk-receiver.js";

/**
 * Query keys `@opentelemetry/instrumentation-http@0.223.0` replaces before it records
 * `url.query` (`build/src/internal-types.js` `DEFAULT_QUERY_STRINGS_TO_REDACT`, applied by
 * `redactQueryString` in `build/src/utils.js`). `code` is not one of them.
 */
const INSTRUMENTATION_REDACTED_QUERY_KEYS = [
  "sig",
  "Signature",
  "AWSAccessKeyId",
  "X-Goog-Signature",
  "X-Amz-Signature",
  "X-Amz-Credential",
  "X-Amz-Security-Token",
] as const;

/** Placeholder for an OAuth code an incoming request carries in its query string. */
const QUERY_SECRET = "synthetic-oauth-code";

const URL_KEYS = ["url.full", "http.url", "http.target", "url.path", "url.query", "resource.name"];

function redactQueryString(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of INSTRUMENTATION_REDACTED_QUERY_KEYS)
    if (params.has(key)) params.set(key, "REDACTED");
  return params.toString();
}

/**
 * URL attributes an incoming server span carries into Hue.
 * `@opentelemetry/instrumentation-http@0.223.0` `getIncomingRequestAttributes` sets `url.path`
 * and `url.query` from the request URL (`build/src/utils.js`). `getAbsoluteUrl` in that file
 * builds the absolute URL used as `url.full` on client spans; `http.url`, `http.target` and an
 * HTTP `resource.name` are the other aliases `redactSpan` leaves untouched for every other kind.
 */
function incomingUrlAttributes(request: IncomingMessage): Record<string, string> {
  const host = request.headers.host ?? "127.0.0.1";
  const parsed = new URL(request.url ?? "/", `http://${host}`);
  const query = parsed.search ? redactQueryString(parsed.search.slice(1)) : "";
  const target = `${parsed.pathname}${query ? `?${query}` : ""}`;
  const full = `http://${host}${target}`;
  return {
    "http.request.method": "GET",
    "url.scheme": "http",
    "url.path": parsed.pathname,
    ...(query ? { "url.query": query } : {}),
    "url.full": full,
    "http.url": full,
    "http.target": target,
    "resource.name": full,
  };
}

function assertQuerySecretAbsent(spans: WireRecord[], raw: string): void {
  expect(raw).not.toContain(QUERY_SECRET);
  for (const span of spans) {
    for (const key of URL_KEYS) {
      const value = attr(span, key)?.stringValue;
      if (value !== undefined) expect(value).not.toContain(QUERY_SECRET);
    }
    if (span.name === "unparsable") {
      for (const key of ["url.full", "http.url", "resource.name"])
        expect(attr(span, key)).toBeUndefined();
    }
  }
}

describe("incoming URL attributes on export", () => {
  test.each([
    ["server", SpanKind.SERVER, {}],
    ["server metadata-only", SpanKind.SERVER, { captureContent: false }],
    ["server passthrough redactor", SpanKind.SERVER, { redact: (value: string) => value }],
    ["internal", SpanKind.INTERNAL, {}],
    ["producer", SpanKind.PRODUCER, {}],
    ["consumer", SpanKind.CONSUMER, {}],
    ["client", SpanKind.CLIENT, {}],
  ] satisfies [string, SpanKindValue, Partial<HueOptions>][])(
    "drops query secrets from a %s span before export",
    async (_label, kind, options) => {
      const endpoint = receiver();
      const transport = createHueTransport({
        apiKey,
        baseUrl: endpoint.url,
        serviceName: "incoming-url",
        liveSpans: false,
        captureHttp: false,
        ...options,
      });
      const provider = new TracerProvider({ spanProcessors: [transport.spanProcessor] });
      const tracer = provider.getTracer("incoming-http");
      const server = createServer((request, response) => {
        tracer.startSpan("GET", { kind, attributes: incomingUrlAttributes(request) }).end();
        response.end("ok");
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected a TCP port");
      const unparsable = `http://[?code=${QUERY_SECRET}`;
      tracer
        .startSpan("unparsable", {
          kind,
          attributes: {
            "http.request.method": "GET",
            "url.full": unparsable,
            "http.url": unparsable,
            "http.target": `/?code=${QUERY_SECRET}`,
            "url.path": `/?code=${QUERY_SECRET}`,
            "url.query": `code=${QUERY_SECRET}`,
            "resource.name": unparsable,
          },
        })
        .end();
      try {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/callback?code=${QUERY_SECRET}&sig=synthetic-listed-signature&page=2`,
        );
        expect(response.status).toBe(200);
        await response.arrayBuffer();
        await provider.forceFlush();
        await transport.flush();
        assertQuerySecretAbsent(
          endpoint.accepted(),
          endpoint.requests.map((item) => item.raw).join("\n"),
        );
        expect(endpoint.accepted().length).toBeGreaterThan(0);
      } finally {
        server.close();
        await provider.shutdown();
        await transport.shutdown();
        await endpoint.server.stop(true);
      }
    },
  );
});
