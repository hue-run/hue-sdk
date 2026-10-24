import { expect } from "bun:test";
import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs/light.js";
import schema from "./fixtures/otlp-schema.json" with { type: "json" };

export type Value = {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  kvlistValue?: { values: Attribute[] };
  arrayValue?: { values: Value[] };
};

export type Attribute = { key: string; value: Value };

export type WireRecord = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name?: string;
  attributes?: Attribute[];
  body?: Value;
  status?: { code?: number; message?: string };
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  events?: { name: string; timeUnixNano?: string; attributes?: Attribute[] }[];
  droppedEventsCount?: number;
  droppedLinksCount?: number;
};

export const root = protobuf.Root.fromJSON(schema);

export const apiKey = "synthetic-hue-test-key";

export const project = {
  id: "synthetic-project",
  name: "SDK test",
  organizationId: "synthetic-org",
  slug: "sdk-test",
};

export function receiver(
  mode:
    | "success"
    | "partial"
    | "unauthorized"
    | "retry"
    | "malformed"
    | "redirect"
    | "warning" = "success",
  redirect?: string,
  beforeReply?: (signal: "traces" | "logs") => Promise<void>,
  /** The status and headers of the `index`th telemetry request's reply (1-based); a status other
   * than 200 refuses the request, which is still recorded. */
  reply?: (
    index: number,
    signal: "traces" | "logs",
  ) => { status?: number; headers?: Record<string, string> } | undefined,
) {
  const requests: {
    signal: "traces" | "logs";
    records: WireRecord[];
    raw: string;
    /** The request's size after decompression. */
    bytes: number;
    /** The request's size on the wire. */
    wire: number;
    headers: Record<string, string>;
    /** The reply's status. */
    status: number;
    /** When the request arrived. */
    at: number;
  }[] = [];
  let hits = 0;
  let blobRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      // A receiver without the large-value upload route answers its framework's not-found; the
      // upload tests use their own receiver.
      if (new URL(request.url).pathname.startsWith("/api/v1/otlp/blobs")) {
        blobRequests++;
        return new Response("Not Found", { status: 404 });
      }
      hits++;
      expect(request.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
      if (mode === "redirect")
        return new Response(null, { status: 307, headers: { Location: redirect! } });
      if (mode === "unauthorized") {
        // This fixture tests received 401 acknowledgements, so finish reading the
        // compressed request instead of racing its upload with an early response.
        await request.arrayBuffer();
        return new Response(`reflected ${apiKey}`, { status: 401 });
      }
      if (new URL(request.url).pathname === "/api/v1/projects/current")
        return Response.json(project);
      if (mode === "retry" && hits === 1) {
        await request.arrayBuffer();
        return new Response("retry", { status: 503, headers: { "Retry-After": "1" } });
      }
      const signal = new URL(request.url).pathname.endsWith("/logs") ? "logs" : "traces";
      const namespace = `opentelemetry.proto.collector.${signal === "traces" ? "trace" : "logs"}.v1.Export${signal === "traces" ? "Trace" : "Logs"}Service`;
      let bytes = Buffer.from(await request.arrayBuffer());
      const wire = bytes.byteLength;
      if (request.headers.get("content-encoding") === "gzip") bytes = gunzipSync(bytes);
      const type = root.lookupType(`${namespace}Request`);
      const data = type.toObject(type.decode(bytes), { longs: String, bytes: String });
      const records: WireRecord[] =
        signal === "traces"
          ? data.resourceSpans.flatMap((group: { scopeSpans: { spans: WireRecord[] }[] }) =>
              group.scopeSpans.flatMap((scope) => scope.spans),
            )
          : data.resourceLogs.flatMap((group: { scopeLogs: { logRecords: WireRecord[] }[] }) =>
              group.scopeLogs.flatMap((scope) => scope.logRecords),
            );
      requests.push({
        signal,
        records,
        raw: JSON.stringify(data),
        bytes: bytes.byteLength,
        wire,
        headers: (() => {
          const headers: Record<string, string> = {};
          request.headers.forEach((value, name) => {
            headers[name] = value;
          });
          return headers;
        })(),
        status: 200,
        at: Date.now(),
      });
      const custom = reply?.(requests.length, signal);
      if (custom?.status !== undefined && custom.status !== 200) {
        requests.at(-1)!.status = custom.status;
        return new Response("synthetic refusal", {
          status: custom.status,
          headers: custom.headers,
        });
      }
      await beforeReply?.(signal);
      if (mode === "malformed")
        return new Response(new Uint8Array([0x0a, 0xff]), {
          headers: { "content-type": "application/x-protobuf" },
        });
      const responseType = root.lookupType(`${namespace}Response`);
      const response =
        mode === "partial" || mode === "warning"
          ? {
              partialSuccess: {
                [signal === "traces" ? "rejectedSpans" : "rejectedLogRecords"]:
                  mode === "warning" ? "0" : "1",
                errorMessage: `reflected ${apiKey}`,
              },
            }
          : {};
      return new Response(
        new Uint8Array(responseType.encode(responseType.fromObject(response)).finish()),
        {
          headers: {
            "content-type": "application/x-protobuf",
            // A current Hue marks every trace acknowledgement as accepting placeholders.
            ...(signal === "traces" ? { "hue-pending-spans": "1" } : {}),
            ...custom?.headers,
          },
        },
      );
    },
  });
  return {
    server,
    requests,
    /** The records of the requests the receiver accepted. */
    accepted: () =>
      requests.filter((request) => request.status === 200).flatMap((request) => request.records),
    url: `http://127.0.0.1:${server.port}`,
    hits: () => hits,
    /** Requests to the upload route, which this receiver lacks. */
    blobRequests: () => blobRequests,
  };
}

export function attr(record: WireRecord, key: string): Value | undefined {
  return record.attributes?.find((item) => item.key === key)?.value;
}

export const usage = {
  inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};
